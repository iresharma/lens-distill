import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  books,
  claims,
  chunks,
  conceptEdges,
  concepts,
  paragraphs,
  stageRuns,
  PIPELINE_STAGES,
} from "@/db/schema";
import { MODELS } from "@/lib/llm/client";
import {
  addUsage,
  emptyUsage,
  mergeUsage,
  type UsageRollup,
} from "@/lib/llm/pricing";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await ctx.params;
  const [book] = await db
    .select()
    .from(books)
    .where(eq(books.bookId, bookId))
    .limit(1);
  if (!book) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const runs = await db
    .select()
    .from(stageRuns)
    .where(eq(stageRuns.bookId, bookId));

  const byStage = new Map(runs.map((r) => [r.stage, r]));
  const timeline = PIPELINE_STAGES.map((stage) => {
    const r = byStage.get(stage);
    return {
      stage,
      status: r?.status ?? "pending",
      startedAt: r?.startedAt ?? null,
      finishedAt: r?.finishedAt ?? null,
      metrics: r?.metrics ?? {},
      error: r?.error ?? null,
    };
  });

  const conceptRows = await db
    .select({
      conceptId: concepts.conceptId,
      label: concepts.label,
      oneLiner: concepts.oneLiner,
      favors: concepts.favors,
      primaryChapter: concepts.primaryChapter,
      claimCount: sql<number>`coalesce(array_length(${concepts.claimIds}, 1), 0)`,
    })
    .from(concepts)
    .where(eq(concepts.bookId, bookId));

  const [claimStats] = await db
    .select({
      liveClaims: sql<number>`count(*) filter (where superseded is null)::int`,
      allClaims: sql<number>`count(*)::int`,
      supersededClaims: sql<number>`count(*) filter (where superseded is not null)::int`,
    })
    .from(claims)
    .where(eq(claims.bookId, bookId));

  const [{ paragraphCount }] = await db
    .select({ paragraphCount: sql<number>`count(*)::int` })
    .from(paragraphs)
    .where(eq(paragraphs.bookId, bookId));

  const [{ chunkCount }] = await db
    .select({ chunkCount: sql<number>`count(*)::int` })
    .from(chunks)
    .where(eq(chunks.bookId, bookId));

  const [{ edgeCount }] = await db
    .select({ edgeCount: sql<number>`count(*)::int` })
    .from(conceptEdges)
    .where(eq(conceptEdges.bookId, bookId));

  const [{ chunkTokens }] = await db
    .select({
      chunkTokens: sql<number>`coalesce(sum(token_count), 0)::int`,
    })
    .from(chunks)
    .where(eq(chunks.bookId, bookId));

  let usage = emptyUsage();
  for (const r of runs) {
    const u = (r.metrics as Record<string, unknown> | null)?.usage as
      | UsageRollup
      | undefined;
    if (u?.byModel) usage = mergeUsage(usage, u);
  }

  // Backfill rough estimates for stages that finished before usage logging existed
  const embedRun = byStage.get("embed");
  if (
    embedRun &&
    (embedRun.status === "done" || embedRun.status === "running") &&
    !((embedRun.metrics as Record<string, unknown>)?.usage as UsageRollup | undefined)
      ?.calls
  ) {
    // One embed HTTP call per batch of 100 chunks
    usage = addUsage(
      usage,
      MODELS.embed,
      chunkTokens,
      0,
      Math.max(1, Math.ceil((chunkCount || 1) / 100)),
    );
    usage.includesEstimates = true;
  }

  const extractRun = byStage.get("extract");
  if (
    extractRun &&
    (extractRun.status === "done" || extractRun.status === "running") &&
    !((extractRun.metrics as Record<string, unknown>)?.usage as UsageRollup | undefined)
      ?.calls
  ) {
    // Rough: system+chunk ≈ 1.15× chunk tokens in, ~400 tokens out per chunk
    const estIn = Math.round(chunkTokens * 1.15);
    const estOut = (chunkCount || 0) * 400;
    usage = addUsage(usage, MODELS.extract, estIn, estOut, chunkCount || 1);
    usage.includesEstimates = true;
  }

  return Response.json({
    book: {
      bookId: book.bookId,
      title: book.title,
      authors: book.authors,
      status: book.status,
      statusError: book.statusError,
      extractPrompt: book.extractPrompt,
      createdAt: book.createdAt,
      readyAt: book.readyAt,
    },
    timeline,
    concepts: conceptRows,
    liveClaims: claimStats?.liveClaims ?? 0,
    counts: {
      paragraphs: paragraphCount,
      chunks: chunkCount,
      liveClaims: claimStats?.liveClaims ?? 0,
      allClaims: claimStats?.allClaims ?? 0,
      supersededClaims: claimStats?.supersededClaims ?? 0,
      concepts: conceptRows.length,
      edges: edgeCount,
    },
    usage,
  });
}
