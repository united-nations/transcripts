import * as Sentry from "@sentry/nextjs";

import {
  getVideoByAssetId,
  saveVideo,
  type VideoI18n,
  type VideoRecord,
} from "./db";
import { parseMeetingSymbol } from "./pv-documents";
import { escapeRegExp } from "./utils";
import { videoUrl } from "./video-url";
import { extractKalturaId } from "./kaltura";

// Locales whose schedule pages get scraped alongside English. Mirrors the
// next-intl routing config (i18n/routing.ts) minus `en` — English values live
// in the canonical Video fields. Keep these in sync if the locale set changes.
export const SCHEDULE_LOCALES = ["en", "ar", "zh", "fr", "ru", "es"] as const;
export type ScheduleLocale = (typeof SCHEDULE_LOCALES)[number];

export interface Video {
  id: string;
  url: string;
  title: string;
  cleanTitle: string;
  category: string;
  duration: string;
  date: string;
  scheduledTime: string | null;
  status: "finished" | "live" | "scheduled";
  eventCode: string | null;
  eventType: string | null;
  body: string | null; // UN body (committee, council, assembly, etc.)
  sessionNumber: string | null;
  pvSymbol: string | null;
  pvPart: number | null;
  pvAvailable: boolean;
  /** Locale-agnostic path (no leading slash). Derived via `videoUrl()`. */
  slug: string;
  // `hasTranscript` = at least one completed transcript exists in *any*
  // language; `hasTranscriptInLocale` = one exists in the active UI locale
  // specifically. The two-tier T badge renders solid when the second is true
  // and muted when only the first is. When `recordToVideo` is called without
  // a locale (the public /json API, scripts) `hasTranscriptInLocale` always
  // mirrors `hasTranscript`.
  hasTranscript: boolean;
  hasTranscriptInLocale: boolean;
  // Per-locale variants of title/cleanTitle/category harvested from the
  // ar/zh/fr/ru/es WebTV schedule pages. Empty when the asset wasn't scraped
  // for that locale; render-time helpers fall back to English.
  i18n: Record<string, VideoI18n>;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// Strip HTML tags. A single `.replace(/<[^>]*>/g, "")` pass is unsafe: deleting
// one match can splice two fragments into a fresh tag (`<scr<x>ipt>` becomes
// `<script>`), so a lone pass leaves reconstructed tags behind — which is why
// CodeQL flags it (js/incomplete-multi-character-sanitization). Re-apply to a
// fixpoint so nothing tag-shaped survives. Real WebTV markup never nests like
// this, so on actual input the loop runs exactly once; it only hardens the
// adversarial case.
export function stripTags(html: string): string {
  let out = html;
  let prev: string;
  do {
    prev = out;
    out = out.replace(/<[^>]*>/g, "");
  } while (out !== prev);
  return out;
}

function extractTextContent(html: string): string {
  const text = stripTags(html).trim().replace(/\s+/g, " ");
  return decodeEntities(text);
}

/**
 * Like extractTextContent, but keeps block boundaries as newlines.
 *
 * WebTV descriptions are rich text — bullet lists and paragraphs. Stripping
 * every tag runs adjacent blocks together, so two list items collapse into
 * "...Production Patterns SDG 9 and interlinkages...". Callers render the
 * result with `whitespace-pre-line`.
 */
function extractRichText(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|li|h[1-6]|div|tr)>/gi, "\n");
  return decodeEntities(stripTags(withBreaks))
    .replace(/[^\S\n]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

export function videoToRecord(
  video: Video,
): Omit<VideoRecord, "created_at" | "updated_at" | "removed_at" | "pv_part"> {
  // Parse duration: can be "HH:MM:SS" or "XX min" format, convert to seconds
  let durationSeconds: number | null = null;
  if (video.duration) {
    if (video.duration.includes(":")) {
      // HH:MM:SS format
      const [hours, minutes, seconds] = video.duration.split(":").map(Number);
      durationSeconds = hours * 3600 + minutes * 60 + seconds;
    } else {
      // "XX min" format - extract number and convert to seconds
      const minutes = parseInt(video.duration.replace(/[^\d]/g, ""));
      durationSeconds = minutes * 60;
    }
  }

  const pv_symbol = parseMeetingSymbol(video.title, video.category, video.date);

  const kaltura_id = extractKalturaId(video.id);
  if (!kaltura_id) {
    throw new Error(`videoToRecord: cannot derive kaltura_id from ${video.id}`);
  }
  return {
    asset_id: video.id,
    entry_id: null, // Will be resolved later
    kaltura_id,
    title: video.title,
    clean_title: video.cleanTitle,
    date: video.date,
    scheduled_time: video.scheduledTime
      ? new Date(video.scheduledTime.slice(0, 19) + "Z")
      : null,
    duration: durationSeconds,
    url: video.url,
    body: video.body,
    category: video.category,
    event_code: video.eventCode,
    event_type: video.eventType,
    session_number: video.sessionNumber,
    pv_symbol,
    pv_available: null,
    pv_checked_at: null,
    last_seen: new Date().toISOString().split("T")[0],
    i18n: video.i18n ?? {},
  };
}

/**
 * Pick the locale-appropriate variant of a video's text fields. English stays
 * in the canonical columns; ar/zh/fr/ru/es entries (when present) override
 * `title`, `cleanTitle`, and `category`. Anything not in the i18n map falls
 * back to the English canonical value.
 *
 * `locale` is optional: callers without locale context (the public /json API,
 * scripts) get the English canonical values unchanged.
 *
 * `hasTranscriptInLocale` is the strict per-language flag used by the
 * two-tier T badge. When omitted (callers without locale context), it
 * mirrors `hasTranscript` so the badge always renders solid.
 */
export function recordToVideo(
  record: VideoRecord,
  hasTranscript: boolean,
  locale?: string,
  hasTranscriptInLocale?: boolean,
): Video {
  // Convert duration from seconds to HH:MM:SS for status calculation
  const durationSeconds = record.duration || 0;
  const hours = Math.floor(durationSeconds / 3600);
  const minutes = Math.floor((durationSeconds % 3600) / 60);
  const seconds = durationSeconds % 60;
  const durationHMS = `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;

  // Calculate status based on scheduled time and duration
  const scheduledTimeStr = record.scheduled_time
    ? record.scheduled_time.toISOString()
    : null;
  const status = calculateStatus(record.scheduled_time, durationHMS);

  // English remains the canonical (and the FTS/search source); only the
  // user-facing strings get swapped when a non-English locale has a harvested
  // variant. `body`, `category` filtering, etc. stay keyed on English values.
  const i18n = record.i18n ?? {};
  const variant = locale && locale !== "en" ? i18n[locale] : undefined;

  return {
    id: record.asset_id,
    url: record.url,
    title: variant?.title || record.title,
    cleanTitle: variant?.clean_title || record.clean_title || record.title,
    category: variant?.category || record.category || "",
    duration: durationHMS,
    date: record.date,
    scheduledTime: scheduledTimeStr,
    status,
    eventCode: record.event_code,
    eventType: record.event_type,
    body: record.body,
    sessionNumber: record.session_number,
    pvSymbol: record.pv_symbol ?? null,
    pvPart: record.pv_part,
    pvAvailable: record.pv_available === true,
    slug: videoUrl(record),
    hasTranscript,
    hasTranscriptInLocale: hasTranscriptInLocale ?? hasTranscript,
    i18n,
  };
}

export function calculateStatus(
  scheduledTime: Date | null,
  duration: string,
): "finished" | "live" | "scheduled" {
  if (!scheduledTime) return "finished";

  const startTime = scheduledTime;

  const now = new Date();

  // Parse duration (format: HH:MM:SS)
  const [hours, minutes, seconds] = duration.split(":").map(Number);
  const durationMs = (hours * 3600 + minutes * 60 + seconds) * 1000;
  const endTime = new Date(startTime.getTime() + durationMs);

  if (now < startTime) {
    return "scheduled";
  }

  if (durationMs > 0) {
    return now <= endTime ? "live" : "finished";
  }

  // Duration is unknown (zero) — video was cached before the meeting started/ended.
  // UN Web TV scraping may be unavailable (bot protection), so we can't get the real duration.
  // Treat as live for up to 8 hours after the scheduled start time as a best-effort fallback.
  const maxLiveFallbackMs = 8 * 60 * 60 * 1000;
  return now <= new Date(startTime.getTime() + maxLiveFallbackMs)
    ? "live"
    : "finished";
}

export function decodeEventCode(code: string): string {
  const eventTypes: Record<string, string> = {
    EM: "Event - Ministerial",
    GO: "Global Occasion",
    IM: "Interactive Meeting",
    WD: "Water Dialogue",
    SD: "Strategic Dialogue",
    ST: "Strategic Session",
    YM: "Youth Meeting",
  };

  const prefix = code.substring(0, 2);
  return eventTypes[prefix] || `Event ${code}`;
}

export function cleanTitle(
  title: string,
  metadata: {
    eventCode: string | null;
    body: string | null;
    sessionNumber: string | null;
  },
): string {
  let cleaned = title;

  // Remove event code prefix only
  if (metadata.eventCode) {
    cleaned = cleaned.replace(
      new RegExp(`^${metadata.eventCode}\\s*-\\s*`),
      "",
    );
  }

  return cleaned.trim();
}

export function extractMetadataFromTitle(title: string, category?: string) {
  const metadata = {
    eventCode: null as string | null,
    eventType: null as string | null,
    body: null as string | null,
    sessionNumber: null as string | null,
  };

  // Extract event code (e.g., "EM07", "GO19")
  const eventCodeMatch = title.match(/^([A-Z]{2}\d{2})\s*-\s*/);
  if (eventCodeMatch) {
    metadata.eventCode = eventCodeMatch[1];
    metadata.eventType = decodeEventCode(eventCodeMatch[1]);
  }

  // Extract committee (First, Second, Third, Fourth, Fifth, Sixth)
  const committeeMatch = title.match(
    /(First|Second|Third|Fourth|Fifth|Sixth) Committee/,
  );
  if (committeeMatch) {
    metadata.body = committeeMatch[0];
  }

  // If no committee found, check category for councils/assemblies
  if (!metadata.body && category) {
    const councilMatch = category.match(
      /General Assembly|Security Council|Economic and Social Council|Trusteeship Council/i,
    );
    if (councilMatch) {
      metadata.body = councilMatch[0];
    }
  }

  // Extract session number (e.g., "9th plenary meeting", "80th session")
  const sessionMatch = title.match(
    /(\d+)(?:st|nd|rd|th) (?:plenary meeting|session)/,
  );
  if (sessionMatch) metadata.sessionNumber = sessionMatch[0];

  return metadata;
}

/**
 * Fetch the WebTV schedule for a given date in a given locale. English is the
 * authoritative pass (it populates the full Video record); ar/zh/fr/ru/es
 * passes are merged in via `scrapeVideos` to fill the i18n map.
 *
 * The HTML structure is the same across locales — only the locale prefix in
 * `/{locale}/asset/...` and the rendered category/title strings differ.
 */
export async function fetchVideosForDate(
  date: string,
  locale: ScheduleLocale = "en",
): Promise<Video[]> {
  const today = formatDate(new Date());
  const yesterday = formatDate(new Date(Date.now() - 86400000));
  const revalidate = date >= today ? 300 : date === yesterday ? 3600 : 86400;

  const response = await fetch(
    `https://webtv.un.org/${locale}/schedule/${date}`,
    {
      next: { revalidate },
    },
  );

  const html = await response.text();
  const videos: Video[] = [];
  const seen = new Set<string>();

  // First, extract all timezone divs with their node IDs
  const timezoneMap = new Map<string, string>();
  const timezonePattern =
    /<div class="d-none mediaun-timezone" data-nid="(\d+)">([^<]+)<\/div>/g;
  for (const match of html.matchAll(timezonePattern)) {
    const [, nid, timestamp] = match;
    timezoneMap.set(nid, timestamp);
  }

  // WebTV can publish meetings with an empty category heading (e.g. CED).
  // Category is optional metadata, not a prerequisite for discovery.
  const videoBlockPattern = new RegExp(
    `<h6[^>]*class="text-primary"[^>]*>([^<]*)<\\/h6>[\\s\\S]*?<h4[^>]*>[\\s\\S]*?href="\\/${locale}\\/asset\\/([^"]+)"[^>]*>[\\s\\S]*?<div class="field__item">([^<]+)<\\/div>`,
    "g",
  );

  for (const match of html.matchAll(videoBlockPattern)) {
    const [, category, assetId, title] = match;

    if (seen.has(assetId)) continue;
    seen.add(assetId);

    // Check for live badge - this is more reliable than calculated status
    const matchIndex = match.index!;
    const contextWindow = html.substring(
      Math.max(0, matchIndex - 500),
      matchIndex + 1000,
    );
    const isLiveBadge = /<span class="badge[^"]*"[^>]*>Live<\/span>/i.test(
      contextWindow,
    );

    // Extract duration. `assetId` is scraped from WebTV's markup, so it must be
    // escaped before interpolation: an id containing `(` would otherwise throw
    // out of this function and take the whole schedule sweep down with it.
    const durationPattern = new RegExp(
      `<span class="badge[^"]*">(\\d{2}:\\d{2}:\\d{2})<\\/span>[\\s\\S]{0,500}?href="\\/${locale}\\/asset\\/${escapeRegExp(assetId)}"`,
    );
    const durationMatch = html.match(durationPattern);

    // Extract scheduled time by finding the closest preceding timezone div
    const precedingHtml = html.substring(
      Math.max(0, matchIndex - 3000),
      matchIndex,
    );

    // Find all data-nid occurrences and take the last one (closest to our match)
    const nidMatches = Array.from(precedingHtml.matchAll(/data-nid="(\d+)"/g));
    const lastNidMatch =
      nidMatches.length > 0 ? nidMatches[nidMatches.length - 1] : null;
    const scheduledTime =
      lastNidMatch && timezoneMap.has(lastNidMatch[1])
        ? timezoneMap.get(lastNidMatch[1])!
        : null;

    // Extract metadata from title and category
    const rawTitle = extractTextContent(title);
    const categoryText = extractTextContent(category);
    const titleMetadata = extractMetadataFromTitle(rawTitle, categoryText);
    const titleCleaned = cleanTitle(rawTitle, titleMetadata);

    const duration = durationMatch?.[1] || "00:00:00";
    const scheduledDate = scheduledTime
      ? new Date(scheduledTime.slice(0, 19) + "Z")
      : null;
    const status = isLiveBadge
      ? "live"
      : calculateStatus(scheduledDate, duration);

    const pvSymbol = parseMeetingSymbol(rawTitle, categoryText, date);
    videos.push({
      id: assetId,
      // The canonical Video.url stays on `/en/` regardless of which locale
      // scrape produced this row; per-locale URL resolution happens at render
      // time in `webtvUrlForLocale()`. This keeps DB rows identical no matter
      // the harvest order.
      url: `https://webtv.un.org/en/asset/${assetId}`,
      title: rawTitle,
      cleanTitle: titleCleaned,
      category: categoryText,
      duration,
      date,
      scheduledTime,
      status,
      ...titleMetadata,
      pvSymbol,
      // pvPart is assigned by the DB on save; freshly-scraped rows don't
      // know their cluster position yet.
      pvPart: null,
      pvAvailable: false, // Determined by cron check
      slug: videoUrl({
        pv_symbol: pvSymbol,
        // Fresh scrapes are treated as pv_part=1 for link purposes; the
        // backend reconciles on save.
        pv_part: pvSymbol ? 1 : null,
        asset_id: assetId,
      }),
      hasTranscript: false, // Will be updated later
      hasTranscriptInLocale: false,
      i18n: {},
    });
  }

  return videos;
}

export async function getVideoById(
  videoId: string,
  maxDaysBack: number = 30,
): Promise<Video | null> {
  // Step 1: Check PostgreSQL cache first (instant lookup)
  try {
    const cached = await getVideoByAssetId(videoId);
    if (cached) {
      // Check if it has a transcript
      const { getAllTranscriptedEntries } = await import("./db");
      const transcriptedEntries = await getAllTranscriptedEntries();
      const hasTranscript = cached.entry_id
        ? transcriptedEntries.includes(cached.entry_id)
        : false;

      return recordToVideo(cached, hasTranscript);
    }
  } catch (error) {
    console.warn("Video cache lookup failed:", error);
    // Continue to fallback
  }

  // Step 2: Fallback - search backwards from today
  // Most videos will be recent, so this is much faster than loading all 365 days
  const today = new Date();

  for (let i = -1; i < maxDaysBack; i++) {
    // Start with tomorrow (-1)
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = formatDate(date);

    const videos = await fetchVideosForDate(dateStr);
    const video = videos.find((v) => v.id === videoId);

    if (video) {
      // Save to cache for next time
      try {
        await saveVideo(videoToRecord(video));
      } catch (error) {
        console.warn("Failed to cache video:", error);
      }
      return video;
    }
  }

  return null;
}

export async function getScheduleVideos(days: number = 365): Promise<Video[]> {
  const { getRecentVideos, getAllTranscriptedEntries } = await import("./db");
  const [records, transcriptedEntries] = await Promise.all([
    getRecentVideos(days),
    getAllTranscriptedEntries(),
  ]);
  const transcriptedSet = new Set(transcriptedEntries);

  return records.map((record) =>
    recordToVideo(
      record,
      record.entry_id ? transcriptedSet.has(record.entry_id) : false,
    ),
  );
}

/**
 * Scrape UN Web TV across all six locales for the given list of dates and
 * return one merged Video[] keyed on asset_id.
 *
 * The English pass is authoritative for every non-text field (duration,
 * scheduled time, status, body, etc.); each non-English pass contributes its
 * `{ title, clean_title, category }` to the i18n map. Assets that only appear
 * on a non-English schedule still produce a Video, with that locale's text
 * duplicated into the canonical (English) slots until/unless an English
 * entry shows up later.
 */
export async function scrapeVideosForDates(dates: string[]): Promise<Video[]> {
  // (locale, date) pairs flattened — keeping the parallelism flat instead of
  // nested keeps a slow locale from stalling the whole batch.
  const tasks = SCHEDULE_LOCALES.flatMap((locale) =>
    dates.map((date) => ({ locale, date })),
  );
  const passes = await Promise.all(
    tasks.map(async ({ locale, date }) => ({
      locale,
      videos: await fetchVideosForDate(date, locale),
    })),
  );

  // Merge by asset_id. English pass wins for canonical fields; every locale
  // (including English) populates its slot in the i18n map.
  const merged = new Map<string, Video>();
  for (const { locale, videos } of passes) {
    for (const v of videos) {
      const existing = merged.get(v.id);
      if (locale === "en") {
        // English is authoritative — start from this row, preserving any
        // non-English variants seen earlier.
        const i18n = { ...(existing?.i18n ?? {}), ...v.i18n };
        i18n.en = {
          title: v.title,
          clean_title: v.cleanTitle,
          category: v.category,
        };
        merged.set(v.id, { ...v, i18n });
      } else {
        // Non-English pass: attach this locale's variant; keep whatever
        // canonical fields we already had.
        const base = existing ?? v;
        const i18n = { ...(base.i18n ?? {}) };
        i18n[locale] = {
          title: v.title,
          clean_title: v.cleanTitle,
          category: v.category,
        };
        merged.set(v.id, { ...base, i18n });
      }
    }
  }

  return Array.from(merged.values());
}

/**
 * Convenience wrapper around scrapeVideosForDates for CLI scripts
 * (sync-videos, fetch-video-metadata) that want "tomorrow + last N days".
 */
export async function scrapeVideos(days: number): Promise<Video[]> {
  const dates: string[] = [];
  const today = new Date();

  // Fetch tomorrow's videos
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  dates.push(formatDate(tomorrow));

  // Fetch videos from the past N days
  for (let i = 0; i < days; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    dates.push(formatDate(date));
  }

  return scrapeVideosForDates(dates);
}

export interface VideoMetadata {
  summary: string | null;
  description: string | null;
  categories: string[];
  relatedDocuments: Array<{ title: string; url: string }>;
  geographicSubject: string[];
  subjectTopical: string[];
  corporateName: string[];
  speakerAffiliation: string[];
}

/** Parse the metadata block out of a WebTV asset page. Pure; see getVideoMetadata. */
export function parseVideoMetadata(html: string): VideoMetadata {
  return {
    summary: extractSummary(html),
    description: extractDescription(html),
    categories: extractCategories(html),
    relatedDocuments: extractRelatedDocuments(html),
    geographicSubject: extractFieldItems(html, "Geographic Subject"),
    subjectTopical: extractFieldItems(html, "Subject Topical"),
    corporateName: extractFieldItems(html, "Corporate Name"),
    speakerAffiliation: extractFieldItems(html, "Speaker Affiliation"),
  };
}

function isEmptyMetadata(metadata: VideoMetadata): boolean {
  return (
    metadata.summary === null &&
    metadata.description === null &&
    metadata.categories.length === 0 &&
    metadata.relatedDocuments.length === 0 &&
    metadata.geographicSubject.length === 0 &&
    metadata.subjectTopical.length === 0 &&
    metadata.corporateName.length === 0 &&
    metadata.speakerAffiliation.length === 0
  );
}

/**
 * Fetch a WebTV asset page. Returns the HTTP status plus the body (null on any
 * non-2xx or network error, where `status` is 0). Shared by `getVideoMetadata`
 * (which parses the body) and the removal detectors (which read the status as a
 * liveness signal — a 404 means the asset was unpublished). Never throws.
 *
 * The `/en/` is load-bearing: WebTV localizes the labels the parser keys on, and
 * not every asset has a translated page — pointing this at the request locale
 * would silently return empty metadata.
 */
export async function fetchAssetPage(
  assetId: string,
): Promise<{ status: number; html: string | null }> {
  const url = `https://webtv.un.org/en/asset/${assetId}`;
  try {
    const response = await fetch(url, {
      next: { revalidate: 3600 }, // 1 hour cache
    });
    if (!response.ok) return { status: response.status, html: null };
    return { status: response.status, html: await response.text() };
  } catch {
    return { status: 0, html: null }; // network error → unknown liveness
  }
}

export async function getVideoMetadata(
  assetId: string,
): Promise<VideoMetadata> {
  const url = `https://webtv.un.org/en/asset/${assetId}`;
  const { status, html } = await fetchAssetPage(assetId);

  if (html === null) {
    // A 404 means the asset was unpublished — an expected outcome the removal
    // detectors act on, not something to alert on. Only a non-404 failure
    // (403/5xx, or 0 for a network error) points at a genuine upstream problem.
    if (status !== 404) {
      Sentry.captureMessage("WebTV asset metadata fetch failed", {
        level: "warning",
        extra: { assetId, url, status },
      });
    }
    return createEmptyMetadata();
  }

  const metadata = parseVideoMetadata(html);

  // Assets with no metadata block at all (live feeds, b-roll) contain no
  // `field__label` markup and legitimately parse empty. If the block is there
  // but nothing came out, the markup drifted and the extractors need updating.
  if (isEmptyMetadata(metadata) && html.includes("field__label")) {
    Sentry.captureMessage("WebTV metadata parsed empty despite metadata block", {
      level: "warning",
      extra: { assetId, url, htmlLength: html.length },
    });
  }

  return metadata;
}

export function createEmptyMetadata(): VideoMetadata {
  return {
    summary: null,
    description: null,
    categories: [],
    relatedDocuments: [],
    geographicSubject: [],
    subjectTopical: [],
    corporateName: [],
    speakerAffiliation: [],
  };
}

function extractSummary(html: string): string | null {
  const match = html.match(
    /<div class="h4 field__label">Summary<\/div>[\s\S]*?<div class="smt-content"[^>]*>([\s\S]*?)<\/div>/,
  );
  if (!match) return null;
  return extractTextContent(match[1]);
}

function extractDescription(html: string): string | null {
  const match = html.match(
    /<div class="h4 field__label">Description<\/div>[\s\S]*?<div class="smt-content"[^>]*>([\s\S]*?)<\/div>/,
  );
  if (!match) return null;
  return extractRichText(match[1]) || null;
}

function extractCategories(html: string): string[] {
  const match = html.match(
    /<div class="small text-muted field__label">Categories<\/div>[\s\S]*?<div class="field__item">([\s\S]*?)<\/div>/,
  );
  if (!match) return [];

  // Extract just the link text, not the "/" separators
  const links = [...match[1].matchAll(/<a[^>]*>([^<]+)<\/a>/g)];
  return links.map(([, text]) => extractTextContent(text));
}

function extractRelatedDocuments(
  html: string,
): Array<{ title: string; url: string }> {
  const match = html.match(
    /<div class="h4 field__label">Related Sites and Documents<\/div>([\s\S]*?)(?=<div\s+class="(?:block|pb-3|border-|col-)|$)/,
  );
  if (!match) return [];

  // Anchors carry attributes after the href (`target="_blank"`), so the href
  // is not the last thing before the closing angle bracket.
  const links = [
    ...match[1].matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g),
  ];
  return links.map(([, url, title]) => ({
    title: extractTextContent(title),
    url,
  }));
}

function extractFieldItems(html: string, fieldLabel: string): string[] {
  const pattern = new RegExp(
    `<div class="small text-muted field__label">${fieldLabel}<\\/div>([\\s\\S]*?)(?=<\\/div>\\s*<\\/div>\\s*<div class="(?:pb-3|block)|$)`,
    "i",
  );
  const match = html.match(pattern);
  if (!match) return [];

  // Extract text from <a> tags
  const links = [...match[1].matchAll(/<a[^>]*>([^<]+)<\/a>/g)];
  return links.map(([, text]) => extractTextContent(text));
}
