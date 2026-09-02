import { after, NextResponse } from "next/server";
import { drainPipeline, isPipelineDraining } from "@/lib/pipeline/drain";
import { resetFailedJobs } from "@/lib/pipeline/resume";
import { otelLog } from "@/lib/otel/logger";
import { withRouteMetrics } from "@/lib/otel/http-metrics";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/pipeline/resume
 * Body (optional): { bookIds?: string[] }
 *
 * Resets failed/stuck jobs and starts a background drain.
 */
export const POST = withRouteMetrics(
  "/api/pipeline/resume",
  "POST",
  async (req: Request) => {
  let bookIds: string[] | undefined;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      bookIds?: string[];
    };
    if (
      Array.isArray(body.bookIds) &&
      body.bookIds.every((x) => typeof x === "string")
    ) {
      bookIds = body.bookIds;
    }
  } catch {
    /* empty body ok */
  }

  if (isPipelineDraining()) {
    otelLog.warn("resume rejected — already draining", { scope: "pipeline", bookIds });
    return NextResponse.json(
      { ok: false, error: "Pipeline already draining" },
      { status: 409 },
    );
  }

  otelLog.info("pipeline resume requested", { scope: "pipeline", bookIds });
  const result = await resetFailedJobs({ bookIds });

  after(() => {
    void drainPipeline({ budgetMs: 720_000 });
  });

  return NextResponse.json({
    ok: true,
    ...result,
    draining: true,
  });
  },
);

export const GET = withRouteMetrics("/api/pipeline/resume", "GET", async () => {
  return NextResponse.json({
    draining: isPipelineDraining(),
  });
});
