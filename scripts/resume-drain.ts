/** Resume pipeline drain after a server restart / API limit recovery. */
import { eq } from "drizzle-orm";
import { makeWorkerDb } from "../src/db";
import { jobs } from "../src/db/schema";
import { drainPipeline } from "../src/lib/pipeline/drain";
import { resetFailedJobs } from "../src/lib/pipeline/resume";

async function hasPending(): Promise<boolean> {
  const { pool, wdb } = makeWorkerDb();
  try {
    const [row] = await wdb
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.status, "pending"))
      .limit(1);
    return !!row;
  } finally {
    await pool.end().catch(() => {});
  }
}

async function main() {
  const reset = await resetFailedJobs();
  console.log(JSON.stringify({ reset }, null, 2));

  const allProcessed: unknown[] = [];
  // Keep draining until the queue is empty — process.exit would kill setTimeout
  // continues from a single drainPipeline call.
  for (let i = 0; i < 40; i++) {
    const r = await drainPipeline({ budgetMs: 720_000 });
    allProcessed.push(...r.processed);
    if (r.skipped === "already_running") {
      await new Promise((res) => setTimeout(res, 2000));
      continue;
    }
    const pending = await hasPending();
    console.log(
      JSON.stringify({
        pass: i + 1,
        processedThisPass: r.processed.length,
        pendingLeft: pending,
      }),
    );
    if (!pending) break;
  }

  console.log(
    JSON.stringify(
      {
        resetJobs: reset.resetJobs,
        resetBooks: reset.resetBooks,
        totalProcessed: allProcessed.length,
        processed: allProcessed,
      },
      null,
      2,
    ),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
