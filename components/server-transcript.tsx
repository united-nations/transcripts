import { getActiveTranscriptByKalturaId, type VideoRecord } from "@/lib/db";
import {
  buildTranscriptPayload,
  type TranscriptPayload,
} from "@/lib/transcript-payload";
import type { Video } from "@/lib/un-api";
import { TranscriptionPanel } from "@/components/transcription-panel";

/**
 * Server async component that resolves the transcript for the URL locale
 * and renders <TranscriptionPanel> with it pre-populated.
 *
 * Rendered without a Suspense/loading boundary so the transcript query
 * completes before the page shell is sent. The speeches are then visible
 * HTML, rather than hidden streamed content requiring a script to reveal it.
 *
 * Word-level timestamps are stripped before sending (63% of the payload)
 * — the panel fetches them lazily via /api/transcripts/[id]/words once
 * the transcript is on screen.
 */
export async function ServerTranscript({
  kalturaId,
  locale,
  experimentalAccess,
  isLoggedIn,
  video,
  record,
}: {
  kalturaId: string;
  locale: string;
  experimentalAccess: boolean;
  isLoggedIn: boolean;
  video: Video;
  record: VideoRecord;
}) {
  const initialTranscript = await loadInitialTranscript({
    kalturaId,
    locale,
    experimentalAccess,
  });

  return (
    <TranscriptionPanel
      kalturaId={kalturaId}
      video={video}
      experimentalAccess={experimentalAccess}
      isLoggedIn={isLoggedIn}
      pvSymbol={
        video.pvAvailable && video.pvSymbol ? video.pvSymbol : undefined
      }
      initialTranscript={initialTranscript}
      // record is consumed inside the panel via context already; declared
      // here only to keep the call sites symmetrical with what video-page.tsx
      // resolved when picking the URL.
      key={record.asset_id}
    />
  );
}

async function loadInitialTranscript({
  kalturaId,
  locale,
  experimentalAccess,
}: {
  kalturaId: string;
  locale: string;
  experimentalAccess: boolean;
}): Promise<TranscriptPayload | null> {
  const transcript = await getActiveTranscriptByKalturaId(kalturaId, locale);
  if (
    !transcript ||
    transcript.transcription_status !== "completed" ||
    !transcript.content.statements?.length
  ) {
    return null;
  }
  // Same builder as /api/transcripts/check — the two delivery paths must
  // serve the identical package (experimental-access-gated propositions, word-stripping,
  // flagged/realignment state) or panel state silently diverges between
  // server-rendered and fetched loads.
  return buildTranscriptPayload(transcript, { experimentalAccess });
}
