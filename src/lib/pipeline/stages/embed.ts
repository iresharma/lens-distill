import { and, asc, eq, gte, isNull, sql } from "drizzle-orm";
import { chunks, type NewJob } from "@/db/schema";
import { embedTexts, MODELS } from "@/lib/llm/client";
import { recordStageUsage } from "@/lib/llm/record-usage";
import { markStageDone, markStageRunning, patchStageMetrics } from "../stage-runs";
import type { JobPayload, StageHandler } from "../types";

const BATCH = 100;

export const embedStage: StageHandler = async (job, wdb, deadline) => {
  const bookId = job.bookId;
  const payload = (job.payload || {}) as JobPayload;
  const cursor = payload.cursor ?? 0;
  await markStageRunning(wdb, bookId, "embed");

  const pending = await wdb
    .select()
    .from(chunks)
    .where(
      and(
        eq(chunks.bookId, bookId),
        gte(chunks.chunkIndex, cursor),
        isNull(chunks.embedding),
      ),
    )
    .orderBy(asc(chunks.chunkIndex))
    .limit(BATCH);

  if (!pending.length) {
    const [{ remaining }] = await wdb
      .select({ remaining: sql<number>`count(*)::int` })
      .from(chunks)
      .where(and(eq(chunks.bookId, bookId), isNull(chunks.embedding)));

    if (remaining > 0) {
      return {
        bookId,
        stage: "embed",
        payload: { cursor: 0, chapterOnly: payload.chapterOnly },
      } satisfies NewJob;
    }

    const [{ total }] = await wdb
      .select({ total: sql<number>`count(*)::int` })
      .from(chunks)
      .where(eq(chunks.bookId, bookId));

    await markStageDone(wdb, bookId, "embed", {
      chunksEmbedded: total,
      batchSize: BATCH,
      model: MODELS.embed,
    });

    return {
      bookId,
      stage: "extract",
      payload: { cursor: 0, chapterOnly: payload.chapterOnly },
    } satisfies NewJob;
  }

  const inputs = pending.map((c) => {
    const head = [c.sectionTitle].filter(Boolean).join(" — ");
    return head ? `${head}\n\n${c.text}` : c.text;
  });

  const { vectors, inputTokens } = await embedTexts(inputs);

  for (let i = 0; i < pending.length; i++) {
    const c = pending[i]!;
    await wdb
      .update(chunks)
      .set({ embedding: vectors[i]! })
      .where(eq(chunks.chunkId, c.chunkId));
  }

  // One HTTP call per batch. Embeddings have no output tokens.
  await recordStageUsage(
    wdb,
    bookId,
    "embed",
    MODELS.embed,
    inputTokens,
    0,
    1,
  );

  const nextCursor = pending[pending.length - 1]!.chunkIndex + 1;
  await patchStageMetrics(wdb, bookId, "embed", {
    lastBatch: pending.length,
    cursor: nextCursor,
    model: MODELS.embed,
  });

  if (Date.now() > deadline - 60_000) {
    return {
      bookId,
      stage: "embed",
      payload: { cursor: nextCursor, chapterOnly: payload.chapterOnly },
    } satisfies NewJob;
  }

  const [{ remaining }] = await wdb
    .select({ remaining: sql<number>`count(*)::int` })
    .from(chunks)
    .where(and(eq(chunks.bookId, bookId), isNull(chunks.embedding)));

  if (remaining > 0) {
    return {
      bookId,
      stage: "embed",
      payload: { cursor: nextCursor, chapterOnly: payload.chapterOnly },
    } satisfies NewJob;
  }

  const [{ total }] = await wdb
    .select({ total: sql<number>`count(*)::int` })
    .from(chunks)
    .where(eq(chunks.bookId, bookId));

  await markStageDone(wdb, bookId, "embed", {
    chunksEmbedded: total,
    batchSize: BATCH,
    model: MODELS.embed,
  });

  return {
    bookId,
    stage: "extract",
    payload: { cursor: 0, chapterOnly: payload.chapterOnly },
  } satisfies NewJob;
};
