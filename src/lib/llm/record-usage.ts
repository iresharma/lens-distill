import { and, eq } from "drizzle-orm";
import { stageRuns, type PipelineStage } from "@/db/schema";
import type { WorkerDb } from "@/db";
import {
  addUsage,
  emptyUsage,
  type UsageRollup,
} from "@/lib/llm/pricing";

export async function recordStageUsage(
  wdb: WorkerDb,
  bookId: string,
  stage: PipelineStage,
  model: string,
  inputTokens: number,
  outputTokens: number,
  calls = 1,
) {
  const [row] = await wdb
    .select()
    .from(stageRuns)
    .where(and(eq(stageRuns.bookId, bookId), eq(stageRuns.stage, stage)))
    .limit(1);
  if (!row) return;

  const metrics = (row.metrics || {}) as Record<string, unknown>;
  const prev = (metrics.usage as UsageRollup | undefined) ?? emptyUsage();
  const next = addUsage(prev, model, inputTokens, outputTokens, calls);

  await wdb
    .update(stageRuns)
    .set({ metrics: { ...metrics, usage: next } })
    .where(eq(stageRuns.id, row.id));
}
