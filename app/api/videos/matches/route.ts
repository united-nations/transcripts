// All content-search hits inside one meeting — backs the "show all N
// matches" expansion of the schedule's transcript-search sub-rows.
import { formatTimestamp } from "@/lib/timestamp-url";
import { NextRequest, NextResponse } from "next/server";
import { getStatementMatches, getVideoByAssetId } from "@/lib/db";
import { videoUrl } from "@/lib/video-url";

const LIMIT = 100;

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const assetId = sp.get("assetId");
  const q = sp.get("q")?.trim();
  if (!assetId || !q) {
    return NextResponse.json(
      { error: "assetId and q are required" },
      { status: 400 },
    );
  }
  const language = sp.get("locale") || "en";
  const offset = Math.max(0, parseInt(sp.get("offset") || "0", 10) || 0);

  const [result, record] = await Promise.all([
    getStatementMatches(assetId, language, q, offset, LIMIT),
    getVideoByAssetId(assetId),
  ]);

  // Ready-made `?t=` deeplink per hit, same as meetings.json?ft=1 — so callers
  // don't have to re-derive the URL from `startSeconds` themselves. Omitted
  // only if the asset resolves to no video record.
  const slug = record ? videoUrl(record) : null;
  const hits = slug
    ? result.hits.map((hit) => ({
        ...hit,
        pageUrl: `/${language}/${slug}?t=${formatTimestamp(hit.startSeconds)}`,
      }))
    : result.hits;

  const response = NextResponse.json({ ...result, hits });
  response.headers.set(
    "Cache-Control",
    "s-maxage=30, stale-while-revalidate=60",
  );
  return response;
}
