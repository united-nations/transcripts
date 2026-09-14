import * as Sentry from "@sentry/nextjs";
import { formatDate, scrapeVideosForDates, videoToRecord } from "@/lib/un-api";
import { resolveEntryId } from "@/lib/kaltura-helpers";
import {
  saveVideo,
  getVideoByAssetId,
  getEnabledFeeds,
  scheduleTranscript,
  withJobLock,
} from "@/lib/db";
import { matchFeeds } from "@/lib/feeds";
import { backfillDurations } from "@/lib/duration-backfill";

export type SyncVideosRange = "near" | "tomorrow" | "far";

export type SyncVideosResult =
  | { skipped: "lock_held" }
  | {
      synced: number;
      resolved: number;
      autoScheduled: number;
      durationsBackfilled: number;
      videosRemoved: number;
      videosRestored: number;
      errors: string[];
    };

/**
 * Scrape a slice of the UN Web TV schedule, persist videos, resolve Kaltura
 * entry IDs, and auto-schedule transcription for newly-seen videos matching
 * enabled feeds.
 *
 * - "near" (every 30 min): today and the last 2 days, plus duration backfill.
 * - "tomorrow" (hourly): tomorrow in all six locales.
 * - "far" (every 6 hours): T+2 through T+7.
 * Each range holds its own advisory lock. Removal checks have a separate cron.
 */
export async function runSyncVideos(
  range: SyncVideosRange = "near",
): Promise<SyncVideosResult> {
  const result = await withJobLock(`sync-videos-${range}`, async () => {
    const today = new Date();
    const dates: string[] = [];
    if (range === "near") {
      for (let i = 0; i < 3; i++) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        dates.push(formatDate(date));
      }
    } else if (range === "tomorrow") {
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      dates.push(formatDate(tomorrow));
    } else {
      for (let i = 2; i <= 7; i++) {
        const date = new Date(today);
        date.setDate(date.getDate() + i);
        dates.push(formatDate(date));
      }
    }

    console.log(`[sync-videos:${range}] Scraping dates: ${dates.join(", ")}`);

    // scrapeVideosForDates fans out across all six locales and returns a
    // deduplicated Video[] keyed on asset_id, with the localized
    // title/category pre-merged into each row's i18n map.
    const uniqueVideos = await scrapeVideosForDates(dates);

    let synced = 0;
    let resolved = 0;
    let autoScheduled = 0;
    const errors: string[] = [];
    const enabledFeeds = await getEnabledFeeds();

    for (const video of uniqueVideos) {
      try {
        const record = videoToRecord(video);
        const existing = await getVideoByAssetId(video.id);
        const cachedEntryId = existing?.entry_id ?? null;
        const entryId = await resolveEntryId(video.id, cachedEntryId);
        if (entryId) {
          record.entry_id = entryId;
          if (!cachedEntryId) resolved++;
        }
        await saveVideo(record);
        synced++;
        if (!existing && record.kaltura_id) {
          const matched = matchFeeds(record, enabledFeeds);
          if (matched.length > 0) {
            await scheduleTranscript(video.id, record.kaltura_id, null, null);
            autoScheduled++;
            console.log(
              `[sync-videos:${range}] Auto-scheduled ${video.id} for feeds: ${matched.join(", ")}`,
            );
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[sync-videos:${range}] Error syncing ${video.id}: ${msg}`,
        );
        Sentry.captureException(err, {
          tags: { pipeline: "sync_videos", range, asset_id: video.id },
        });
        errors.push(`${video.id}: ${msg}`);
      }
    }

    let durationsBackfilled = 0;
    const videosRemoved = 0;
    const videosRestored = 0;
    if (range === "near") {
      try {
        const r = await backfillDurations({ apply: true, lookbackDays: 30 });
        durationsBackfilled = r.updated;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[sync-videos:${range}] Duration backfill failed: ${msg}`,
        );
        Sentry.captureException(err, {
          tags: { pipeline: "sync_videos", kind: "duration_backfill" },
        });
      }
    }

    console.log(
      `[sync-videos:${range}] Done: ${synced} synced, ${resolved} new entry IDs resolved, ` +
        `${autoScheduled} auto-scheduled, ${durationsBackfilled} durations backfilled, ` +
        `${videosRemoved} removed, ${videosRestored} restored, ${errors.length} errors`,
    );

    return {
      synced,
      resolved,
      autoScheduled,
      durationsBackfilled,
      videosRemoved,
      videosRestored,
      errors,
    };
  });
  return result ?? { skipped: "lock_held" };
}
