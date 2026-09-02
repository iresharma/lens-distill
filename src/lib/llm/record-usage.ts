import { and, eq } from "drizzle-orm";
import { stageRuns, type PipelineStage } from "@/db/schema";
import type { WorkerDb } from "@/db";
import {
  addUsage,
  emptyUsage,
  estimateUsd,
  type UsageRollup,
} from "@/lib/llm/pricing";
import {
  pipelineTokensInput,
  pipelineTokensOutput,
  pipelineCostEstimatedUsd,
} from "@/lib/otel/meter";

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

  // No bookId here: it's an unbounded label that would grow the Prometheus
  // time-series set forever. Per-book usage is already on the stageRuns row
  // above; these metrics are for aggregate cost/token dashboards.
  const attrs = { stage, model };
  if (inputTokens) pipelineTokensInput.add(inputTokens, attrs);
  if (outputTokens) pipelineTokensOutput.add(outputTokens, attrs);
  const costUsd = estimateUsd(model, inputTokens, outputTokens);
  if (costUsd) pipelineCostEstimatedUsd.add(costUsd, attrs);
}
