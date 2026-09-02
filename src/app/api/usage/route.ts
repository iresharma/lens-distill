import { fetchUsageSnapshot } from "@/lib/usage/providers";
import { NextResponse } from "next/server";
import { withRouteMetrics } from "@/lib/otel/http-metrics";

export const dynamic = "force-dynamic";

export const GET = withRouteMetrics("/api/usage", "GET", async () => {
  try {
    const snapshot = await fetchUsageSnapshot();
    return NextResponse.json(snapshot);
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "Failed to fetch usage",
      },
      { status: 500 },
    );
  }
});
