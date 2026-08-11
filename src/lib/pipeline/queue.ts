import { eq, sql } from "drizzle-orm";
import { jobs, type Job, type NewJob } from "@/db/schema";
import type { WorkerDb } from "@/db";
import { classifyApiLimitError } from "@/lib/llm/api-errors";
import {
  forceOpenRouterFallback,
  getAnthropicTransport,
} from "@/lib/llm/client";

const MAX_ATTEMPTS = 3;

export async function claimJob(wdb: WorkerDb): Promise<Job | null> {
  return wdb.transaction(async (tx) => {
    const res = await tx.execute(sql`
      SELECT id FROM jobs
      WHERE status = 'pending' AND run_after <= now()
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT 1`);
    const id = (res as unknown as { rows: { id: number }[] }).rows[0]?.id;
    if (id == null) return null;

    const [job] = await tx
      .update(jobs)
      .set({
        status: "running",
        lockedAt: new Date(),
        attempts: sql`${jobs.attempts} + 1`,
      })
      .where(eq(jobs.id, id))
      .returning();

    return job ?? null;
  });
}

export async function completeJob(
  wdb: WorkerDb,
  id: number,
  next: NewJob | null,
) {
  await wdb.transaction(async (tx) => {
    await tx
      .update(jobs)
      .set({ status: "done", lockedAt: null })
      .where(eq(jobs.id, id));
    if (next) await tx.insert(jobs).values(next);
  });
}

export async function failJob(
  wdb: WorkerDb,
  job: Job,
  err: unknown,
): Promise<{ bookFailed: boolean }> {
  const msg =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const limit = classifyApiLimitError(err);

  // Anthropic usage cap + OpenRouter available → switch transport and retry
  // soon instead of burning the job dead.
  if (
    limit?.kind === "usage_cap" &&
    process.env.OPENROUTER_API_KEY &&
    getAnthropicTransport() === "direct"
  ) {
    forceOpenRouterFallback(
      `Anthropic usage-capped — switched to OpenRouter`,
      limit.regainAt,
    );
    await wdb
      .update(jobs)
      .set({
        status: "pending",
        lockedAt: null,
        lastError: `${msg} → retrying via OpenRouter`,
        // Don't count this against attempts — provider path changed.
        attempts: sql`GREATEST(${jobs.attempts} - 1, 0)`,
        runAfter: sql`now() + interval '5 seconds'`,
      })
      .where(eq(jobs.id, job.id));
    return { bookFailed: false };
  }

  // Already on OpenRouter (or no fallback) and still usage-capped → fail loud.
  const dead =
    (limit?.kind === "usage_cap" && !process.env.OPENROUTER_API_KEY) ||
    (limit?.kind === "usage_cap" && getAnthropicTransport() === "openrouter") ||
    job.attempts >= MAX_ATTEMPTS;

  const backoff =
    limit?.kind === "rate_limit" || limit?.kind === "overloaded"
      ? Math.min(2 ** job.attempts * 120, 900)
      : 2 ** job.attempts * 30;

  await wdb
    .update(jobs)
    .set({
      status: dead ? "failed" : "pending",
      lockedAt: null,
      lastError: msg,
      runAfter: sql`now() + (${backoff} * interval '1 second')`,
    })
    .where(eq(jobs.id, job.id));

  return { bookFailed: dead };
}

export async function recoverStale(wdb: WorkerDb) {
  await wdb.execute(sql`
    UPDATE jobs
    SET status='pending',
        locked_at=NULL,
        attempts = GREATEST(attempts - 1, 0),
        run_after = now()
    WHERE status='running'
      AND locked_at < now() - interval '15 minutes'`);
}

export async function enqueueJob(wdb: WorkerDb, job: NewJob) {
  await wdb.insert(jobs).values(job);
}
