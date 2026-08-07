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
    await recoverStale(wdb);
    while (Date.now() < deadline - 45_000) {
      const job = await claimJob(wdb);
      if (!job) break;
      try {
        const handler = STAGES[job.stage];
        if (!handler) throw new Error(`Unknown stage: ${job.stage}`);
        const next = await handler(job, wdb, deadline);
        await completeJob(wdb, job.id, next);
        processed.push({
          id: job.id,
          stage: job.stage,
          ok: true,
          next: next?.stage ?? null,
        });
      } catch (e) {
        await failJob(wdb, job, e);
        const msg = e instanceof Error ? e.message : String(e);
        await markStageFailed(wdb, job.bookId, job.stage as PipelineStage, msg);
        if (job.attempts >= 3) {
          await wdb
            .update(books)
            .set({ status: "failed", statusError: msg })
            .where(eq(books.bookId, job.bookId));
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

    return { processed };
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
