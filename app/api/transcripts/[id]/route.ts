import { publicSpeakerMapping } from "@/lib/public-speakers";
// Polls transcript pipeline status and returns the result when complete.
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { pollTranscription } from "@/lib/transcription";
import { getSpeakerMapping } from "@/lib/speakers";
import { filterOffRecord } from "@/lib/off-record";
import { apiError } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/service";
import { compressedJson } from "@/lib/compressed-json";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id: transcriptId } = await context.params;

    if (!transcriptId) {
      return apiError(400, "missing_parameter", "Transcript ID required");
    }

    const result = await pollTranscription(transcriptId);
    const user = await getCurrentUser();
    // Filter before serializing and computing the ETag, including on 304s.
    if (!user?.experimentalAccess) result.propositions = [];

    // If completed or has statements, include speaker mappings — with
    // off-record statements hidden (kept in DB, filtered at the serving
    // boundary; see lib/off-record.ts).
    let speakerMappings = {};
    if (result.statements && result.statements.length > 0) {
      const fullMapping = (await getSpeakerMapping(transcriptId)) || {};
      const visible = filterOffRecord(result.statements, fullMapping);
      result.statements = visible.statements;
      // Once structured statements exist, raw paragraphs bypass their
      // off-record filter and are no longer needed for the fallback view.
      delete result.raw_paragraphs;
      speakerMappings = user?.experimentalAccess
        ? visible.speakerMappings
        : publicSpeakerMapping(
            visible.speakerMappings,
            visible.statements.length,
          );
    }

    // The client polls this every few seconds while a transcript progresses.
    // The body carries the full `statements` array — large and mostly unchanged
    // between polls. Attach a weak validator (ETag over the body) with
    // `Cache-Control: private, no-cache` so the browser revalidates via If-None-Match and
    // unchanged polls get a bodiless 304 (no client changes — the browser
    // transparently reuses its cached copy). Saves the repeated re-download.
    // ETag is computed over the raw (un-gzipped) JSON so it stays stable
    // regardless of whether the response gets encoded; clients sending
    // Accept-Encoding: gzip just get a smaller 200 body with the same ETag.
    const body = JSON.stringify({ ...result, speakerMappings });
    const etag = `"${createHash("sha1").update(body).digest("base64")}"`;

    if (request.headers.get("if-none-match") === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          "Cache-Control": "private, no-cache",
          Vary: "Cookie",
          ETag: etag,
        },
      });
    }

    return compressedJson(
      request,
      { ...result, speakerMappings },
      {
        headers: {
          "Cache-Control": "private, no-cache",
          Vary: "Cookie",
          ETag: etag,
        },
      },
    );
  } catch (error) {
    console.error("Poll error:", error);
    if (error instanceof Error && error.message === "Transcript not found") {
      return apiError(404, "not_found", "Transcript not found");
    }
    return apiError(
      500,
      "internal_error",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}
