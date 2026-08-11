import { and, eq, inArray, sql } from "drizzle-orm";
import { books, jobs, stageRuns, type PipelineStage } from "@/db/schema";
import { makeWorkerDb } from "@/db";
import { drainPipeline } from "@/lib/pipeline/drain";

export type ResetResult = {
  resetJobs: number;
  resetBooks: string[];
};

/**
 * Reset failed (or stale running) jobs back to pending.
 * Does not drain — call drainPipeline separately (or via after()).
 */
export async function resetFailedJobs(opts?: {
  bookIds?: string[];
}): Promise<ResetResult> {
  const { pool, wdb } = makeWorkerDb();
  try {
    const bookFilter = opts?.bookIds?.length
      ? inArray(jobs.bookId, opts.bookIds)
      : undefined;

    const failed = await wdb
      .select()
      .from(jobs)
      .where(
        bookFilter
          ? and(inArray(jobs.status, ["failed", "running"]), bookFilter)
          : inArray(jobs.status, ["failed", "running"]),
      );

    if (!failed.length) {
      return { resetJobs: 0, resetBooks: [] };
    }

    const ids = failed.map((j) => j.id);
    const bookIds = [...new Set(failed.map((j) => j.bookId))];

    await wdb
      .update(jobs)
      .set({
        status: "pending",
        attempts: 0,
        lockedAt: null,
        lastError: null,
        runAfter: sql`now()`,
      })
      .where(inArray(jobs.id, ids));

    for (const j of failed) {
      await wdb
        .update(stageRuns)
        .set({
          status: "pending",
          error: null,
          finishedAt: null,
        })
        .where(
          and(
            eq(stageRuns.bookId, j.bookId),
            eq(stageRuns.stage, j.stage as PipelineStage),
            eq(stageRuns.status, "failed"),
          ),
        );
    }

    await wdb
      .update(books)
      .set({ status: "running", statusError: null })
      .where(inArray(books.bookId, bookIds));

    return { resetJobs: ids.length, resetBooks: bookIds };
  } finally {
    await pool.end().catch(() => {});
  }
}

/** Reset + drain (CLI / scripts). */
export async function resumeFailedPipelines(opts?: {
  bookIds?: string[];
}): Promise<ResetResult & { drain: { processed: unknown[]; skipped?: string } }> {
  const reset = await resetFailedJobs(opts);
  const drain = await drainPipeline({ budgetMs: 720_000 });
  return { ...reset, drain };
}
