import { resolveAnthropicTransport } from "@/lib/llm/client";
import { eq } from "drizzle-orm";
import { books, jobs, type PipelineStage } from "@/db/schema";
import { makeWorkerDb } from "@/db";
import {
  claimJob,
  completeJob,
  failJob,
  recoverStale,
} from "@/lib/pipeline/queue";
import { markStageFailed } from "@/lib/pipeline/stage-runs";
import { STAGES } from "@/lib/pipeline/stages";
import { otelLog } from "@/lib/otel/logger";
import { withSpan } from "@/lib/otel/tracer";
import { jobsClaimed, pipelineBooksCompleted } from "@/lib/otel/meter";

let draining = false;

export function isPipelineDraining() {
  return draining;
}

/** Drain pending jobs. Call from upload after(); no public worker endpoint. */
export async function drainPipeline(opts?: {
  budgetMs?: number;
}): Promise<{ processed: unknown[]; skipped?: string }> {
  if (draining) {
    return { processed: [], skipped: "already_running" };
  }
  draining = true;

  const budgetMs = opts?.budgetMs ?? 720_000;
  const deadline = Date.now() + budgetMs;
  const processed: unknown[] = [];
  const { pool, wdb } = makeWorkerDb();
  let needsContinue = false;

  try {
    return await withSpan(
      "pipeline.drain",
      { "pipeline.budget_ms": budgetMs },
      async (drainSpan) => {
        // Pick Claude path once per drain (cached 5m) — auto OpenRouter on cap.
        const decision = await resolveAnthropicTransport();
        otelLog.info(
          `Claude transport=${decision.transport} (${decision.reason})`,
          { scope: "pipeline", transport: decision.transport, reason: decision.reason },
        );

        await recoverStale(wdb);
        while (Date.now() < deadline - 45_000) {
          const job = await claimJob(wdb);
          if (!job) break;
          jobsClaimed.add(1, { stage: job.stage });
          const cursor = (job.payload as { cursor?: number } | null)?.cursor;
          otelLog.info(`job claimed: ${job.stage}`, {
            scope: "pipeline",
            bookId: job.bookId,
            stage: job.stage,
            jobId: job.id,
            attempts: job.attempts,
            cursor,
          });
          try {
            await withSpan(
              `pipeline.stage.${job.stage}`,
              {
                "book.id": job.bookId,
                "pipeline.stage": job.stage,
                "job.id": job.id,
                "job.attempts": job.attempts,
                ...(cursor != null ? { "job.cursor": cursor } : {}),
              },
              async () => {
                const handler = STAGES[job.stage];
                if (!handler) throw new Error(`Unknown stage: ${job.stage}`);
                const next = await handler(job, wdb, deadline);
                await completeJob(wdb, job.id, next, job.stage);
                otelLog.info(`job completed: ${job.stage}`, {
                  scope: "pipeline",
                  bookId: job.bookId,
                  stage: job.stage,
                  jobId: job.id,
                  next: next?.stage ?? null,
                });
                processed.push({
                  id: job.id,
                  stage: job.stage,
                  ok: true,
                  next: next?.stage ?? null,
                });
              },
            );
          } catch (e) {
            const { bookFailed } = await failJob(wdb, job, e);
            const msg = e instanceof Error ? e.message : String(e);
            await markStageFailed(wdb, job.bookId, job.stage as PipelineStage, msg);
            if (bookFailed) {
              await wdb
                .update(books)
                .set({ status: "failed", statusError: msg })
                .where(eq(books.bookId, job.bookId));
              pipelineBooksCompleted.add(1, { status: "failed" });
            }
            processed.push({
              id: job.id,
              stage: job.stage,
              ok: false,
              error: msg,
            });
          }
        }

        const [pending] = await wdb
          .select({ id: jobs.id })
          .from(jobs)
          .where(eq(jobs.status, "pending"))
          .limit(1);
        needsContinue = !!pending;

        drainSpan.setAttribute("pipeline.jobs_processed", processed.length);
        return { processed };
      },
    );
  } finally {
    await pool.end().catch(() => {});
    draining = false;
    if (needsContinue) {
      setTimeout(() => {
        void drainPipeline({ budgetMs });
      }, 500);
    }
  }
}
