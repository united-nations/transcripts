import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/cron/auth";
import { withJobLock } from "@/lib/db";
import { reapRemovedVideos } from "@/lib/removed-videos";

// Hourly for today's meetings; daily for other recently-seen records.
export async function GET(request: NextRequest) {
  const unauthorized = checkCronAuth(request);
  if (unauthorized) return unauthorized;
  const scope = request.nextUrl.searchParams.get("scope");
  if (scope !== "today" && scope !== "other") {
    return NextResponse.json(
      { error: "scope must be today or other" },
      { status: 400 },
    );
  }
  const result = await withJobLock(`reap-removed-${scope}`, async () => {
    const result = await reapRemovedVideos({
      apply: true,
      lookbackDays: 30,
      scope,
    });
    if (result.webtvAborted) {
      Sentry.captureMessage("WebTV reap circuit breaker tripped", {
        level: "warning",
        tags: { pipeline: "reap_removed", scope },
      });
    }
    console.log(`[reap-removed:${scope}] ${JSON.stringify(result)}`);
    return result;
  });
  return NextResponse.json(result ?? { skipped: "lock_held" });
}
