// Cron: scrapes UN Web TV and upserts meeting records.
import { NextRequest, NextResponse } from "next/server";
import { runSyncVideos } from "@/lib/cron/sync-videos";
import { checkCronAuth } from "@/lib/cron/auth";

export async function GET(request: NextRequest) {
  const unauthorized = checkCronAuth(request);
  if (unauthorized) return unauthorized;
  const requestedRange = request.nextUrl.searchParams.get("range");
  const range =
    requestedRange === "far" || requestedRange === "tomorrow"
      ? requestedRange
      : "near";
  const result = await runSyncVideos(range);
  return NextResponse.json(result);
}
