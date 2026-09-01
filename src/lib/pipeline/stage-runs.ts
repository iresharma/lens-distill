import { and, eq } from "drizzle-orm";
import { stageRuns, type PipelineStage } from "@/db/schema";
import type { WorkerDb } from "@/db";
import { otelLog } from "@/lib/otel/logger";
import { stageDuration, stageFailed } from "@/lib/otel/meter";

export async function markStageRunning(
  wdb: WorkerDb,
  bookId: string,
  stage: PipelineStage,
) {
  const existing = await wdb
    .select()
    .from(stageRuns)
    .where(and(eq(stageRuns.bookId, bookId), eq(stageRuns.stage, stage)))
    .limit(1);

  if (existing[0]) {
    if (existing[0].status === "done") return; // cursor re-entry; keep running metrics merge
    await wdb
      .update(stageRuns)
      .set({
        status: "running",
        startedAt: existing[0].startedAt ?? new Date(),
        error: null,
      })
      .where(eq(stageRuns.id, existing[0].id));
  } else {
    await wdb.insert(stageRuns).values({
      bookId,
      stage,
      status: "running",
      startedAt: new Date(),
      metrics: {},
    });
  }
}

export async function markStageDone(
  wdb: WorkerDb,
  bookId: string,
  stage: PipelineStage,
  metrics: Record<string, unknown>,
) {
  const existing = await wdb
    .select()
    .from(stageRuns)
    .where(and(eq(stageRuns.bookId, bookId), eq(stageRuns.stage, stage)))
    .limit(1);

  const prev = (existing[0]?.metrics || {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...prev };
  for (const [k, v] of Object.entries(metrics)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }

  const finishedAt = new Date();
  const startedAt = existing[0]?.startedAt ?? finishedAt;

  if (existing[0]) {
    await wdb
      .update(stageRuns)
      .set({
        status: "done",
        finishedAt,
        metrics: merged,
        error: null,
      })
      .where(eq(stageRuns.id, existing[0].id));
  } else {
    await wdb.insert(stageRuns).values({
      bookId,
      stage,
      status: "done",
      startedAt: finishedAt,
      finishedAt,
      metrics: merged,
    });
  }

  stageDuration.record(finishedAt.getTime() - startedAt.getTime(), { stage });
}

export async function markStageFailed(
  wdb: WorkerDb,
  bookId: string,
  stage: PipelineStage,
  error: string,
) {
  const existing = await wdb
    .select()
    .from(stageRuns)
    .where(and(eq(stageRuns.bookId, bookId), eq(stageRuns.stage, stage)))
    .limit(1);

  if (existing[0]) {
    await wdb
      .update(stageRuns)
      .set({ status: "failed", finishedAt: new Date(), error })
      .where(eq(stageRuns.id, existing[0].id));
  } else {
    await wdb.insert(stageRuns).values({
      bookId,
      stage,
      status: "failed",
      startedAt: new Date(),
      finishedAt: new Date(),
      metrics: {},
      error,
    });
  }

  otelLog.error("stage failed", { scope: "pipeline", bookId, stage, error });
  stageFailed.add(1, { stage });
}

export async function patchStageMetrics(
  wdb: WorkerDb,
  bookId: string,
  stage: PipelineStage,
  metrics: Record<string, unknown>,
) {
  const existing = await wdb
    .select()
    .from(stageRuns)
    .where(and(eq(stageRuns.bookId, bookId), eq(stageRuns.stage, stage)))
    .limit(1);
  if (!existing[0]) return;
  const prev = (existing[0].metrics || {}) as Record<string, unknown>;
  await wdb
    .update(stageRuns)
    .set({ metrics: { ...prev, ...metrics } })
    .where(eq(stageRuns.id, existing[0].id));
}

export async function seedPendingStages(wdb: WorkerDb, bookId: string) {
  const stages: PipelineStage[] = [
    "chunk",
    "embed",
    "extract",
    "dedupe",
    "canonicalize",
    "concepts",
    "concept_graph",
  ];
  for (const stage of stages) {
    await wdb.insert(stageRuns).values({
      bookId,
      stage,
      status: "pending",
      metrics: {},
    });
  }
}
