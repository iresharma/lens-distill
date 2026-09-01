import { and, asc, between, eq, gte, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { books, claims, chunks, paragraphs, type NewJob } from "@/db/schema";
import { getClaudeClient, claudeMessages } from "@/lib/llm/client";
import { requireToolUse } from "@/lib/llm/require-tool";
import { emitClaims } from "@/lib/llm/tools";
import {
  buildExtractSystemPrompt,
  buildExtractUserContent,
} from "@/lib/persona/validate";
import { recordStageUsage } from "@/lib/llm/record-usage";
import { markStageDone, markStageRunning, patchStageMetrics } from "../stage-runs";
import type { JobPayload, StageHandler } from "../types";
import { context } from "@/lib/otel/tracer";

const STEP = 40;
const CONCURRENCY = 4;

type RawClaim = {
  statement: string;
  type: string;
  concepts: string[];
  support_paras: number[];
  favors?: string;
  anchor_quote?: string;
};

export const extractStage: StageHandler = async (job, wdb, deadline) => {
  const bookId = job.bookId;
  const payload = (job.payload || {}) as JobPayload;
  const cursor = payload.cursor ?? 0;
  await markStageRunning(wdb, bookId, "extract");

  const [book] = await wdb
    .select({ extractPrompt: books.extractPrompt })
    .from(books)
    .where(eq(books.bookId, bookId))
    .limit(1);
  if (!book) throw new Error(`Book not found: ${bookId}`);

  if (cursor === 0) {
    await wdb.delete(claims).where(eq(claims.bookId, bookId));
  }

  const batch = await wdb
    .select()
    .from(chunks)
    .where(and(eq(chunks.bookId, bookId), gte(chunks.chunkIndex, cursor)))
    .orderBy(asc(chunks.chunkIndex))
    .limit(STEP);

  if (!batch.length) {
    const [{ kept }] = await wdb
      .select({ kept: sql<number>`count(*)::int` })
      .from(claims)
      .where(eq(claims.bookId, bookId));
    const { models } = await getClaudeClient();
    await markStageDone(wdb, bookId, "extract", {
      claimsKept: kept,
      model: models.extract,
      concurrency: CONCURRENCY,
    });
    return { bookId, stage: "dedupe", payload: {} } satisfies NewJob;
  }

  const system = buildExtractSystemPrompt();
  const { models } = await getClaudeClient();
  let dropped = 0;
  let kept = 0;

  const queue = [...batch];
  const parentCtx = context.active();
  const workerStats = await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      let usageIn = 0;
      let usageOut = 0;
      let usageCalls = 0;
      while (queue.length) {
        const chunk = queue.shift();
        if (!chunk) break;

        const paras = await wdb
          .select()
          .from(paragraphs)
          .where(
            and(
              eq(paragraphs.bookId, bookId),
              between(paragraphs.paraIndex, chunk.paraStart, chunk.paraEnd),
            ),
          )
          .orderBy(asc(paragraphs.paraIndex));

        const marked = paras
          .map((p) => `[p${p.paraIndex}] ${p.text}`)
          .join("\n\n");

        const res = await context.with(parentCtx, () =>
          claudeMessages({
            model: models.extract,
            max_tokens: 4096,
            system,
            tools: [emitClaims],
            tool_choice: { type: "tool", name: "emit_claims" },
            messages: [
              {
                role: "user",
                content: buildExtractUserContent(
                  book.extractPrompt,
                  `${chunk.chapterIndex ?? "?"} / ${chunk.sectionTitle ?? ""}`,
                  marked,
                ),
              },
            ],
          }),
        );

        usageIn += res.usage?.input_tokens ?? 0;
        usageOut += res.usage?.output_tokens ?? 0;
        usageCalls += 1;

        const toolBlock = requireToolUse(res, "extract");
        const input = toolBlock.input as { claims?: RawClaim[] };
        const raw = input.claims || [];

        for (const c of raw) {
          const valid = (c.support_paras || []).every(
            (p) => p >= chunk.paraStart && p <= chunk.paraEnd,
          );
          if (!valid || !c.statement?.trim()) {
            dropped++;
            continue;
          }
          let anchor = c.anchor_quote?.trim() || null;
          if (anchor && anchor.split(/\s+/).length > 15) anchor = null;

          const claimId = `${bookId}:${randomUUID().slice(0, 8)}`;
          await wdb.insert(claims).values({
            claimId,
            bookId,
            statement: c.statement.trim().slice(0, 300),
            claimType: (c.type ||
              "mechanic") as typeof claims.$inferInsert.claimType,
            favors: (c.favors as typeof claims.$inferInsert.favors) ?? null,
            anchorQuote: anchor,
            supportParas: c.support_paras,
            concepts: c.concepts || [],
            sourceChunks: [chunk.chunkId],
          });
          kept++;
        }
      }
      return { usageIn, usageOut, usageCalls };
    }),
  );

  const usageIn = workerStats.reduce((n, s) => n + s.usageIn, 0);
  const usageOut = workerStats.reduce((n, s) => n + s.usageOut, 0);
  const usageCalls = workerStats.reduce((n, s) => n + s.usageCalls, 0);

  // Re-read models in case mid-batch fallback switched transport.
  const { models: activeModels } = await getClaudeClient();
  if (usageCalls) {
    await recordStageUsage(
      wdb,
      bookId,
      "extract",
      activeModels.extract,
      usageIn,
      usageOut,
      usageCalls,
    );
  }

  const nextCursor = batch[batch.length - 1]!.chunkIndex + 1;
  await patchStageMetrics(wdb, bookId, "extract", {
    chunksProcessedThrough: nextCursor,
    claimsKeptBatch: kept,
    claimsDroppedBatch: dropped,
    dropRateBatch:
      Math.round((dropped / Math.max(kept + dropped, 1)) * 1000) / 10,
    model: activeModels.extract,
    concurrency: CONCURRENCY,
  });

  const [more] = await wdb
    .select({ chunkId: chunks.chunkId })
    .from(chunks)
    .where(and(eq(chunks.bookId, bookId), gte(chunks.chunkIndex, nextCursor)))
    .limit(1);

  if (more || Date.now() > deadline - 60_000) {
    if (more) {
      return {
        bookId,
        stage: "extract",
        payload: { cursor: nextCursor },
      } satisfies NewJob;
    }
  }

  const [{ total }] = await wdb
    .select({ total: sql<number>`count(*)::int` })
    .from(claims)
    .where(eq(claims.bookId, bookId));

  await markStageDone(wdb, bookId, "extract", {
    claimsKept: total,
    claimsDroppedApprox: dropped,
    model: activeModels.extract,
    concurrency: CONCURRENCY,
  });

  return { bookId, stage: "dedupe", payload: {} } satisfies NewJob;
};
