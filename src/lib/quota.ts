import { gte, sql } from "drizzle-orm";
import { quotaEvents } from "@/db/schema";
import { db } from "@/db";
import { otelLog } from "@/lib/otel/logger";
import { quotaExceededCount } from "@/lib/otel/meter";

export const WEEKLY_BOOK_LIMIT = 3;

// Worker transaction type differs from HTTP db — keep loose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

export async function getSlotsRemaining(): Promise<{
  used: number;
  limit: number;
  remaining: number;
  windowStartedAt: string;
}> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [{ used }] = await db
    .select({ used: sql<number>`count(*)::int` })
    .from(quotaEvents)
    .where(gte(quotaEvents.createdAt, weekAgo));

  return {
    used,
    limit: WEEKLY_BOOK_LIMIT,
    remaining: Math.max(0, WEEKLY_BOOK_LIMIT - used),
    windowStartedAt: weekAgo.toISOString(),
  };
}

/**
 * Call inside an open transaction AFTER the books row exists.
 * Holds a site-wide advisory lock so two uploads can't race past the cap.
 */
export async function assertAndRecordQuota(
  tx: Tx,
  bookId: string,
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(420420)`);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const res = await tx.execute(sql`
    SELECT count(*)::int AS n FROM quota_events
    WHERE created_at >= ${weekAgo.toISOString()}::timestamptz
  `);
  const used = Number((res.rows[0] as { n: number }).n);
  if (used >= WEEKLY_BOOK_LIMIT) {
    otelLog.warn("quota exceeded", { scope: "pipeline", used, limit: WEEKLY_BOOK_LIMIT });
    quotaExceededCount.add(1);
    throw new QuotaExceededError(used);
  }
  await tx.insert(quotaEvents).values({ bookId });
}

export class QuotaExceededError extends Error {
  used: number;
  constructor(used: number) {
    super(
      `Global weekly limit reached (${used}/${WEEKLY_BOOK_LIMIT}). This demo caps distill runs site-wide to protect billing.`,
    );
    this.name = "QuotaExceededError";
    this.used = used;
  }
}
