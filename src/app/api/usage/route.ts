import { fetchUsageSnapshot } from "@/lib/usage/providers";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
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
}
