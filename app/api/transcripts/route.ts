// Starts or schedules a new transcription for a video.
import { NextRequest, NextResponse } from "next/server";
import {
  getTranscriptByKalturaId,
  getPendingTranscriptByKalturaId,
  isTranscriptFlagged,
  scheduleTranscript,
} from "@/lib/db";
import { submitTranscription } from "@/lib/transcription";
import { after } from "next/server";
import { buildTranscriptPayload } from "@/lib/transcript-payload";
import { apiError } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/service";
import { requireUser } from "@/lib/auth/require-user";
import {
  enforceUserDailyLimit,
  enforceGlobalDailyLimit,
} from "@/lib/rate-limit";
import type { Transcript } from "@/lib/db";

const TRANSCRIBE_USER_DAILY_LIMIT =
  Number(process.env.TRANSCRIBE_USER_DAILY_LIMIT) || 5;
const TRANSCRIBE_GLOBAL_DAILY_LIMIT =
  Number(process.env.TRANSCRIBE_GLOBAL_DAILY_LIMIT) || 50;

// The transcription pipeline runs in `after()` (see below), so this function's
// keep-alive window must cover a full transcription + analysis run. 800s is the
// Vercel Pro + Fluid Compute ceiling; lower to 300 if the deploy rejects it.
export const maxDuration = 800;

async function respondWithCached(cached: Transcript) {
  // Legacy rows: either no `statements` field at all, or an empty array (which
  // historically triggered an auto-rerun of the analysis pipeline from this
  // POST). Both now return the same error: a cached short-circuit must not
  // silently kick off paid GPT work — recover via `pnpm retranscribe`.
  if (!cached.content.statements || cached.content.statements.length === 0) {
    return apiError(
      400,
      "old_format",
      "Transcript uses old format, please retranscribe",
    );
  }

  const user = await getCurrentUser();
  const { analysisStatus, ...payload } = await buildTranscriptPayload(cached, {
    experimentalAccess: !!user?.experimentalAccess,
  });
  return NextResponse.json(
    {
      ...payload,
      cached: true,
      stage: "completed",
      analysis_status: analysisStatus,
    },
    { headers: { "Cache-Control": "private, no-cache", Vary: "Cookie" } },
  );
}

export async function POST(request: NextRequest) {
  try {
    const { kalturaId, assetId, language, schedule, retranscribe } =
      await request.json();

    if (!kalturaId) {
      return apiError(400, "missing_parameter", "kalturaId is required");
    }

    const lang = language || "en";

    // Generation requires login — viewing transcripts is fully public, but
    // kicking off paid Gemini + GPT work is not. Placed *after* parameter
    // validation and *before* the cache short-circuits below, because the
    // cache short-circuits live inside `respondWithCached` (returned from the
    // two cache-check blocks) and shouldn't be auth-gated — already-completed
    // transcripts must remain viewable for everyone via this POST too.
    //
    // To keep that invariant, login + daily limits are enforced only on the
    // schedule branch and the pre-`submitTranscription` start point.
    const enforceTranscribeLimits = async (userId: string) => {
      const userLimited = await enforceUserDailyLimit(
        userId,
        "transcribe",
        TRANSCRIBE_USER_DAILY_LIMIT,
      );
      if (userLimited) return userLimited;
      const globalLimited = await enforceGlobalDailyLimit(
        "transcribe",
        TRANSCRIBE_GLOBAL_DAILY_LIMIT,
      );
      if (globalLimited) return globalLimited;
      return null;
    };

    // Schedule action: queue transcript for later processing (video still live/upcoming).
    // Idempotent — returns the existing transcript if one is already queued/running/done.
    if (schedule) {
      const auth = await requireUser();
      if (auth.response) return auth.response;
      const limited = await enforceTranscribeLimits(auth.user.id);
      if (limited) return limited;
      const { transcriptId, stage } = await scheduleTranscript(
        assetId || kalturaId,
        kalturaId,
        null,
        null,
        lang,
        auth.user.id,
      );
      return NextResponse.json({ transcriptId, stage });
    }

    // Retranscribe of a realignment-flagged transcript — soft-replace path.
    // The cron flags transcripts whose audio WebTV cut in a way no single
    // offset can fix; a fresh transcription on the current audio is the only
    // recovery. We expose this only for flagged rows (server-side check) to
    // keep general retranscribe-on-demand out of reach (cost/abuse). The new
    // row is inserted alongside the old one (no delete) — the active-getter
    // prefers completed, so viewers keep seeing the old content with a
    // "fresh transcription in progress" banner until the new one finishes.
    if (retranscribe) {
      const existing = await getTranscriptByKalturaId(kalturaId, lang);
      if (!existing || !isTranscriptFlagged(existing)) {
        return apiError(
          400,
          "not_flagged",
          "Retranscribe is only available for transcripts flagged by the realignment cron.",
        );
      }
      const auth = await requireUser();
      if (auth.response) return auth.response;
      // If a retranscribe is already in flight for this video+language, reuse
      // it — don't spawn a duplicate or charge the user a second time.
      const pending = await getPendingTranscriptByKalturaId(kalturaId, lang);
      if (pending) {
        return NextResponse.json({
          transcriptId: pending.transcript_id,
          stage: pending.transcription_status,
        });
      }
      const limited = await enforceTranscribeLimits(auth.user.id);
      if (limited) return limited;
      const { transcriptId, stage } = await submitTranscription(kalturaId, {
        language: lang,
        schedule: after,
        createdBy: auth.user.id,
        force: true,
        isRetranscription: true,
      });
      return NextResponse.json({ transcriptId, stage });
    }

    // Cache check by stable player ID — kaltura_id is the canonical pivot
    // (migration 015), so a single lookup finds any existing completed row.
    // First-time POSTs for already-completed transcripts return the cached
    // row. Retranscribe of a stale row is handled above; nothing else lets
    // callers bypass this short-circuit (cost/abuse).
    {
      const cached = await getTranscriptByKalturaId(kalturaId, lang);
      if (cached && cached.transcription_status === "completed") {
        return await respondWithCached(cached);
      }
    }

    // About to start (or resume) real work — require login + enforce per-user
    // and global daily caps here, after the cache short-circuit, so only
    // genuine starts are gated and counted.
    const auth = await requireUser();
    if (auth.response) return auth.response;
    const limited = await enforceTranscribeLimits(auth.user.id);
    if (limited) return limited;

    // Idempotent: reuses an in-progress transcript if one already exists for
    // this video, so concurrent viewers don't kick off duplicate runs. The
    // pipeline runs in `after()` so it survives past this response on Vercel.
    const { transcriptId, stage, started, entryId } = await submitTranscription(
      kalturaId,
      {
        language: lang,
        schedule: after,
        createdBy: auth.user.id,
      },
    );
    console.log(
      started ? "Transcription started:" : "Reusing in-progress transcript:",
      transcriptId,
      "for entryId:",
      entryId,
    );
    return NextResponse.json({
      transcriptId,
      stage,
    });
  } catch (error) {
    console.error("Transcription error:", error);
    return apiError(
      500,
      "internal_error",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}
