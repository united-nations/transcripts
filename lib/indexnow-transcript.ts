import * as Sentry from "@sentry/nextjs";
import { routing } from "@/i18n/routing";
import { getTranscriptById, getVideoByKalturaId } from "@/lib/db";
import { filterOffRecord } from "@/lib/off-record";
import { getSpeakerMapping } from "@/lib/speakers";
import { videoUrl } from "@/lib/video-url";
import {
  automaticIndexNowEnabled,
  INDEXNOW_ORIGIN,
  submitIndexNow,
} from "@/lib/indexnow";

/** Never throws: search-engine availability must not affect a completed transcript. */
export async function notifyIndexNowByTranscriptId(id: string): Promise<void> {
  if (!automaticIndexNowEnabled()) return;
  try {
    const transcript = await getTranscriptById(id);
    if (
      !transcript ||
      transcript.suppressed_at ||
      transcript.transcription_status !== "completed" ||
      !routing.locales.some((locale) => locale === transcript.language_code)
    )
      return;
    const mapping = (await getSpeakerMapping(id)) || {};
    if (
      !filterOffRecord(transcript.content.statements, mapping).statements.length
    )
      return;
    const video = await getVideoByKalturaId(transcript.kaltura_id);
    if (!video || video.removed_at) return;
    const url = `${INDEXNOW_ORIGIN}/${transcript.language_code}/${videoUrl(video)}`;
    await submitIndexNow([url, `${url}.txt`, `${url}.json`]);
  } catch (error) {
    console.error("[indexnow] Transcript notification failed", id, error);
    Sentry.captureException(error, {
      tags: { pipeline: "indexnow", transcript_id: id },
    });
  }
}
