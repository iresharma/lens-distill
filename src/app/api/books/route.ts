import { after } from "next/server";
import { desc, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db, makeWorkerDb } from "@/db";
import {
  books,
  claims,
  concepts,
  conceptEdges,
  paragraphs,
  PIPELINE_STAGES,
} from "@/db/schema";
import { parsePdf } from "@/lib/adapters/pdf";
import { drainPipeline } from "@/lib/pipeline/drain";
import { enqueueJob } from "@/lib/pipeline/queue";
import { seedPendingStages } from "@/lib/pipeline/stage-runs";
import {
  DEFAULT_PERSONA,
  validatePersona,
} from "@/lib/persona/validate";
import {
  assertAndRecordQuota,
  getSlotsRemaining,
  QuotaExceededError,
} from "@/lib/quota";
import { withSpan } from "@/lib/otel/tracer";
import { otelLog } from "@/lib/otel/logger";
import { withRouteMetrics } from "@/lib/otel/http-metrics";

export const maxDuration = 800;

/** 25 MB so portfolio demos like Nature of Code (~21 MB) can upload. */
const MAX_PDF_BYTES = 25 * 1024 * 1024;

export const GET = withRouteMetrics("/api/books", "GET", async () => {
  const slots = await getSlotsRemaining();

  const bookRows = await db
    .select()
    .from(books)
    .orderBy(desc(books.createdAt));

  const [{ claimCount }] = await db
    .select({ claimCount: sql<number>`count(*)::int` })
    .from(claims)
    .where(isNull(claims.superseded));
  const [{ conceptCount }] = await db
    .select({ conceptCount: sql<number>`count(*)::int` })
    .from(concepts);
  const [{ edgeCount }] = await db
    .select({ edgeCount: sql<number>`count(*)::int` })
    .from(conceptEdges);

  const gallery = await Promise.all(
    bookRows.map(async (b) => {
      const [{ c }] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(claims)
        .where(eq(claims.bookId, b.bookId));
      const [{ live }] = await db
        .select({ live: sql<number>`count(*)::int` })
        .from(claims)
        .where(
          sql`${claims.bookId} = ${b.bookId} AND ${claims.superseded} IS NULL`,
        );
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(concepts)
        .where(eq(concepts.bookId, b.bookId));
      return {
        bookId: b.bookId,
        title: b.title,
        authors: b.authors,
        status: b.status,
        createdAt: b.createdAt,
        readyAt: b.readyAt,
        claimCount: live,
        claimCountAll: c,
        conceptCount: n,
      };
    }),
  );

  return Response.json({
    books: gallery,
    stats: {
      books: bookRows.length,
      claims: claimCount,
      concepts: conceptCount,
      edges: edgeCount,
    },
    slots,
    defaultPersona: DEFAULT_PERSONA,
  });
});

export const POST = withRouteMetrics("/api/books", "POST", async (req: Request) => {
  const slots = await getSlotsRemaining();
  if (slots.remaining <= 0) {
    return Response.json(
      {
        error:
          "Global weekly limit reached (3 books / week site-wide). This demo uses paid LLM APIs — the cap protects personal billing.",
        slots,
      },
      { status: 429 },
    );
  }

  const form = await req.formData();
  const file = form.get("file");
  const titleOverride = String(form.get("title") || "").trim();
  const authorsOverride = String(form.get("authors") || "").trim();
  const personaRaw = String(form.get("persona") || "");
  const acknowledged = form.get("acknowledgeCost") === "true";

  if (!acknowledged) {
    return Response.json(
      { error: "You must acknowledge that each distill run costs real money." },
      { status: 400 },
    );
  }

  if (!(file instanceof File)) {
    return Response.json({ error: "PDF file is required." }, { status: 400 });
  }
  if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
    return Response.json({ error: "Only PDF uploads are supported." }, { status: 400 });
  }
  if (file.size > MAX_PDF_BYTES) {
    return Response.json(
      { error: `PDF must be ≤ ${MAX_PDF_BYTES / (1024 * 1024)} MB.` },
      { status: 400 },
    );
  }

  const personaCheck = validatePersona(personaRaw || DEFAULT_PERSONA);
  if (!personaCheck.ok) {
    return Response.json({ error: personaCheck.error }, { status: 400 });
  }

  let parsed;
  try {
    parsed = await withSpan(
      "pdf.parse",
      { "pdf.filename": file.name, "pdf.byte_size": file.size },
      async (span) => {
        const result = await parsePdf(file);
        span.setAttributes({
          "pdf.chapter_count": result.calibration?.chapters.length ?? -1,
          "pdf.page_offset_agreement": result.calibration?.pageOffsetAgreement ?? -1,
        });
        return result;
      },
    );
  } catch (e) {
    otelLog.error("pdf parse threw", {
      scope: "pdf",
      filename: file.name,
      byteSize: file.size,
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
      name: e instanceof Error ? e.name : undefined,
    });
    return Response.json(
      { error: e instanceof Error ? e.message : "PDF parse failed" },
      { status: 400 },
    );
  }

  const bookId = `book-${randomUUID().slice(0, 8)}`;
  const title = titleOverride || parsed.title || file.name.replace(/\.pdf$/i, "");
  const authors = authorsOverride
    ? authorsOverride.split(",").map((a) => a.trim()).filter(Boolean)
    : parsed.authors;

  const { pool, wdb } = makeWorkerDb();
  try {
    try {
      await wdb.transaction(async (tx) => {
        await tx.insert(books).values({
          bookId,
          title,
          authors,
          sourceFormat: "pdf",
          structureConf: parsed.structureConf,
          pageOffset: parsed.pageOffset,
          extractPrompt: personaCheck.persona,
          status: "queued",
        });
        // Book row must exist before quota_events FK insert
        await assertAndRecordQuota(tx, bookId);
      });
    } catch (e) {
      if (e instanceof QuotaExceededError) {
        return Response.json(
          { error: e.message, slots: await getSlotsRemaining() },
          { status: 429 },
        );
      }
      throw e;
    }

    const paraRows = parsed.paragraphs.map((p) => ({
      bookId,
      paraIndex: p.paraIndex,
      chapterIndex: p.chapterIndex,
      chapterTitle: p.chapterTitle,
      sectionTitle: p.sectionTitle,
      page: p.page,
      blockKind: p.blockKind,
      text: p.text,
    }));
    for (let i = 0; i < paraRows.length; i += 200) {
      await wdb.insert(paragraphs).values(paraRows.slice(i, i + 200));
    }

    await seedPendingStages(wdb, bookId);
    await enqueueJob(wdb, {
      bookId,
      stage: "chunk",
      payload: {},
    });
  } finally {
    await pool.end().catch(() => {});
  }

  otelLog.info("book queued", { scope: "pipeline", bookId, title });

  after(() => {
    void drainPipeline({ budgetMs: 720_000 });
  });

  return Response.json({
    bookId,
    title,
    status: "queued",
    stages: PIPELINE_STAGES,
    slots: await getSlotsRemaining(),
  });
});
