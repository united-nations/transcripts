# UN Web TV & Kaltura: Video Fetching Pipeline

## Overview

UN Web TV (`webtv.un.org`) has no public API. All video data is obtained by scraping HTML pages. The videos themselves are not hosted by the UN — they live in the UN's account on **Kaltura** (partner ID `2503451`), a commercial video platform that the UN Web TV site embeds. This split is the source of nearly all the ID complexity below:

- To **discover** videos, we scrape UN Web TV's HTML (it has no API).
- To get the **actual audio** for transcription, we talk to the **Kaltura API** directly (the UN doesn't expose it).

The two worlds use different identifiers, and a single video carries **three** of them.

## The Three IDs (read this before touching anything)

Worked example — the video at `webtv.un.org/.../k1h/k1hrmtg9f4`:

```
asset_id            kaltura_id (player)        entry_id (canonical)
k1h/k1hrmtg9f4  ──►  1_hrmtg9f4          ──►   1_yuo0w3j6
   (regex, free)        (Kaltura API, follows redirect)
```

### 1. `asset_id` — UN Web TV's own identifier

The UN's ID for the video, found in the page URL (e.g. `k1h/k1hrmtg9f4`). It is the **primary key** of the `videos` table and means nothing to Kaltura. Free to obtain (it's in the URL).

### 2. `kaltura_id` — the "player ID" (the entry ID embedded in the page)

The Kaltura ID the embedded player uses, parsed straight out of the asset string by [`extractKalturaId()`](../lib/kaltura.ts) — **pure string parsing, no network**. It tries several regex shapes (parenthetical `(1_xxx)`, `/id/1_xxx` path segment, `k1`-prefixed, double-segment, or a bare `1_xxxxxxxx`). For the example, `k1h/k1hrmtg9f4` → `1_hrmtg9f4`. Kaltura entry IDs always look like `1_xxxxxxxx`.

Think of this as "the ID printed on the embed code." Stable and cheap — and therefore the **preferred** key for looking transcripts up.

### 3. `entry_id` — the *canonical* Kaltura entry

The player ID is **not necessarily the real, current entry**. Kaltura supports **redirects**: an entry can forward to another via a field literally named `redirectFromEntryId`. This happens when content is re-uploaded, replaced, merged, or re-published — the old ID keeps working but points at the new canonical entry, where the actual media (and its audio) lives.

For the example, `1_hrmtg9f4` **redirects to `1_yuo0w3j6`**. Resolving player → canonical **requires a Kaltura API call**, because only Kaltura knows about the redirect.

> **Most videos have no redirect**, so `kaltura_id == entry_id` and the distinction never matters. The painful cases are the ones where they differ — those are where lookups get slow and legacy data gets inconsistent (see [Gotchas](#legacy-data-gotchas-the-redirect-case)).

### Resolving player ID → canonical entry ID

Two code paths do this, both POSTing to `https://cdnapisec.kaltura.com/api_v3/service/multirequest`:

- [`resolveEntryIdFromKaltura()`](../lib/kaltura-helpers.ts) — minimal: `session.startWidgetSession` (widget `_2503451`) to get a token, then `baseEntry.list` filtered by `redirectFromEntryId` to get the canonical `id`. Wrapped by [`resolveEntryId()`](../lib/kaltura-helpers.ts), which **returns the cached `videos.entry_id` immediately if present** and only calls Kaltura on a miss, writing the result back via `updateVideoEntryId`.
- [`getKalturaAudioUrl()`](../lib/transcription.ts) — same session + lookup, but also pulls the **flavor list** (next section) so it can return both the canonical `entryId` and a downloadable `audioUrl` in one round trip.

## Flavors — getting the actual audio

A Kaltura entry is **not one file**; it's a bundle of **flavors** (renditions of the same content):

- video at various resolutions (1080p, 720p, …);
- **audio-only** tracks — and the UN provides a **separate audio-only flavor per interpreted language** (the floor/original plus the other official UN languages).

Each flavor carries:

- `flavorParamsId` — which rendition/profile it is (e.g. "English audio-only");
- `status` — **`2` = READY/transcodable**; other values mean queued, converting, or errored;
- `tags` (e.g. `audio_only`) and a `language`.

[`getKalturaAudioUrl()`](../lib/transcription.ts) filters the flavor list to `audio_only` + the requested language + `status === 2`, picks one (preferring the default), and builds a Kaltura `playManifest` download URL with `buildAudioUrl(entryId, flavorParamId)`. That URL is handed to the transcription provider. [`getAvailableAudioLanguages()`](../lib/transcription.ts) uses the same list to enumerate which languages have ready audio.

> **Flavors are time-varying.** Right after a meeting ends, often only the floor audio exists; the interpreted-language flavors are transcoded and flip to `status 2` over the following minutes-to-hours. This is *not* something we cache — `/api/cron/process-scheduled` polls this very list to decide "is the recording ready to transcribe yet?" (and skips live streams via the returned `isLiveStream`). See `docs/ai.md` for the scheduled-transcription flow.
>
> **Measured timeline (June 2026).** Playback ≠ downloadability: the player streams HLS segments throughout the live event and seamlessly after it, but the `playManifest …/format/download` flat file per flavor only exists after Kaltura's live→VOD ingest. Observed live on a ~4 h meeting: the live entry reports its *live* flavors as `status 2` the whole time **while the download URL 404s**; a few minutes after the broadcast stops, the redirect flips to a **new VOD entry with an empty flavor list**; the per-language audio files then appear all-at-once as `status 2` with working downloads ~35–65 min later. Across production bookings the end-to-ready window is typically **15–60 min** (occasionally hours), scaling with meeting length. Consequences: a live entry's flavor statuses mean nothing for downloads; a fresh VOD entry with no/no-ready flavors means "still converting, retry later" (never fall back to a guessed `flavorParamId`); and `scheduled` bookings are abandoned only ~48 h after the video's start time.

## How the IDs map to the database

| Table | `asset_id` | `kaltura_id` | `entry_id` |
|---|---|---|---|
| `videos` | **PK** | **NOT NULL, UNIQUE** — player ID (from `extractKalturaId`) | canonical, resolved & cached (nullable until resolution) |
| `transcripts` | — | **NOT NULL** — player ID | **NOT NULL** — the canonical entry the transcript was produced from |

**Canonical cross-table join: `JOIN webtv.videos v ON v.kaltura_id = t.kaltura_id`** (migration 015). Both columns are `NOT NULL`; `videos.kaltura_id` is `UNIQUE`; `transcripts.kaltura_id` FKs to it with `ON DELETE CASCADE` (migration 016). Never join on `entry_id` — `videos.entry_id` can lag the canonical resolution (sometimes holds the pre-redirect player ID) while `transcripts.entry_id` always holds the canonical, so the two can silently fail to match. `entry_id` is fine for intra-table lookups.

Lookups go through `getActiveTranscriptByKalturaId` / `getTranscriptByKalturaId` — a single equality on `kaltura_id`, no Kaltura call. The legacy "fall back to resolving `entry_id`" path is gone (migration 015 makes it dead — every transcript has a `kaltura_id` matching `videos.kaltura_id`).

"Active" lookups return the **latest non-`error`** full-meeting row (`start_time`/`end_time` NULL), so a failed re-transcription can't mask an older good one.

## Legacy-data gotchas (the redirect case)

When `kaltura_id != entry_id` **and** the rows are old, three independent problems used to stack up. The example video hit all three:

1. **Transcript rows with `kaltura_id = NULL`.** Older rows predated the `kaltura_id` column being populated. The cheap step-1 lookup missed entirely, forcing the Kaltura-resolution fallback on every page load. **Fixed by migration 015** — `transcripts.kaltura_id` is now `NOT NULL`, backfilled via `scripts/backfill-kaltura-ids.ts`.
2. **Stale `videos.entry_id`.** For redirected videos, `videos.entry_id` may hold the **pre-redirect player ID** rather than the true canonical. This is **why we pivot on `kaltura_id`, not `entry_id`, for all cross-table joins** — see the table above. The `resolveEntryId` cache still can't be blindly trusted, but no query reaches it through `videos.entry_id` any more.
3. **Newer `error` row masking an older `completed` one.** A meeting transcribed successfully and later re-transcribed unsuccessfully has both a `completed` and a newer `error` row under the same `kaltura_id`. A naive "latest row, any status" lookup returns the error and reports "no transcript." This is exactly why `getActiveTranscriptByKalturaId` filters out `error` rows rather than returning a plain `latest`.

## Schedule Scraping

`lib/un-api.ts:fetchVideosForDate(date)` scrapes `https://webtv.un.org/en/schedule/{date}`:

- Extracts scheduled timestamps from hidden `<div class="d-none mediaun-timezone" data-nid="NNN">` elements
- Extracts video blocks via regex: category (`<h6>`), title (`<div class="field__item">`), asset ID (`href="/en/asset/..."`)
- Extracts duration from `<span class="badge">HH:MM:SS</span>` and live status from a `Live` badge
- Derives additional fields from the title: `eventCode`, `eventType`, `body`, `sessionNumber`, `partNumber`, `pvSymbol`

`scrapeVideos(days)` fetches tomorrow + past N days concurrently, deduplicating by asset ID.

### Caching / Revalidation

- Today/tomorrow: 5 min (`next.revalidate: 300`)
- Yesterday: 1 hour
- Older: 24 hours

## Per-Video Metadata (On-Demand)

`getVideoMetadata(assetId)` scrapes `https://webtv.un.org/en/asset/{assetId}` and extracts:

| Field | Source |
|---|---|
| `summary` | `.smt-content` under "Summary" heading |
| `description` | `.smt-content` under "Description" heading |
| `categories` | Links under "Categories" section |
| `relatedDocuments` | `{ title, url }[]` from "Related Sites and Documents" |
| `geographicSubject` | Field items under geographic section |
| `subjectTopical` | Field items under topical section |
| `corporateName` | Field items under corporate name section |
| `speakerAffiliation` | Field items under speaker section |

**None of these are stored in the database.** They are fetched on demand only.

## What Gets Stored (`videos` table)

| Column | Source | Notes |
|---|---|---|
| `asset_id` | Schedule page URL | Primary key |
| `kaltura_id` | `extractKalturaId(asset_id)` | Player ID, parsed from the asset (no network) |
| `entry_id` | Kaltura API | Canonical entry; resolved asynchronously and cached. Equals `kaltura_id` unless the entry redirects |
| `title`, `clean_title` | Schedule page | `clean_title` strips event code prefix |
| `date` | Schedule page | `YYYY-MM-DD` |
| `scheduled_time` | Hidden `mediaun-timezone` div | ISO timestamp |
| `duration` | Schedule page badge | Stored as integer seconds |
| `url` | Derived from asset ID | |
| `category` | Schedule page `<h6>` | |
| `body` | Parsed from title/category | Committee/council name |
| `event_code`, `event_type` | Parsed from title | e.g. `EM07` / `Event - Ministerial` |
| `session_number` | Parsed from title | e.g. `9th plenary meeting` |
| `part_number` | Parsed from title | Integer |
| `pv_symbol` | Parsed from title | Meeting document symbol |
| `pv_available`, `pv_checked_at` | PV check system | Availability of verbatim record |
| `slug` | Derived from `pv_symbol` or `asset_id` | Human-readable URL slug (e.g. `sc/9748`, `ga/79/21`) |
| `last_seen` | Sync date | Used for recency filtering |

The `saveVideo` upsert uses `COALESCE` for `entry_id` and `pv_symbol` to never overwrite resolved values with null.

## Data Flow Summary

```
Schedule page HTML
  ├─ scrapeVideos() → Video[] (in-memory)
  ├─ saveVideo() → `videos` table (upsert; COALESCE preserves resolved entry_id / pv_symbol)
  └─ resolveEntryId() → Kaltura API → updates `entry_id`

App page load
  └─ getRecentVideos(14 days) → VideoTable (with cached helpers in lib/cached-db.ts)

Search
  └─ /api/search?q=... → tsvector FTS over clean_title/title, with trigram-accelerated ILIKE fallback

Video page
  ├─ Video record from DB (lookup by slug, fall back to asset_id)
  ├─ getVideoMetadata() → on-demand scrape of asset page (not stored)
  └─ entry_id → Kaltura player embed + audio URL for transcription
```

## Scripts

- `pnpm sync-videos` (`scripts/sync-videos.ts`) — scrapes past N days (default 7), upserts to the database, resolves entry IDs. Contains its own inline copy of the Kaltura resolution logic.
- `pnpm fetch-video-metadata` (`scripts/fetch-video-metadata.ts`) — dumps stored video records to `analysis/video-metadata.json`. Despite the name, does **not** call the per-video metadata scraper.
- `pnpm backfill-slugs` / `pnpm fix-slugs` — populate or repair the `slug` column when the meeting-slug logic changes.
- `/api/cron/sync-videos` — Azure container cron calls the same scraper logic against the live DB; see the cadence below. The script is mostly used for ad-hoc backfills.

## Limitations & Gotchas

- Search uses Postgres FTS + trigram fallback only on `title` / `clean_title`. There is no search across category/body/metadata.
- Rich per-video metadata (summary, topics, related documents, speakers) is fetched on demand and never persisted.
- `getVideoBySlug` falls back to looking up by `asset_id` if no slug match — useful during the slug-migration window.
- Status calculation (`scheduled`/`live`/`finished`) works around UN Web TV's broken timezone handling by stripping timezones and appending `Z` — see `lib/timezone.ts`.

## Upstream request budget (14 September 2026)

All server-side Web TV schedule/asset requests and Kaltura metadata API requests
identify themselves as `Transcripts-Metadata-Sync/1.0 (+https://transcripts.un.org/)`.
The ad-hoc category harvester uses the same identity. Browser player requests
and media downloads are separate from these metadata calls.

The Azure schedules in `docker/crontab.template` are:

- `sync-videos` (near): every 30 minutes, today and the previous two days.
  Historical fetch TTLs remain one hour for yesterday and 24 hours for T-2.
  Duration backfill also runs here.
- `sync-videos?range=tomorrow`: hourly at minute 5, all six languages.
- `sync-videos?range=far`: every six hours at minute 7, T+2 through T+7.
- `reap-removed?scope=today`: hourly at minute 10, today's meetings only.
- `reap-removed?scope=other`: daily at 02:20 UTC, other records seen within
  30 days, including future/undated records and previously removed records.

Removal scopes are disjoint and have separate advisory locks. Sweeps request
fresh Web TV pages (`cache: no-store`), so visitor metadata's three-hour TTL
cannot delay the removal verdict. Normal page rendering and meeting JSON
exports share a three-hour asset-page cache per Next.js instance. They still
perform the existing lazy removal check; cached HTML can lag upstream, while
persisted removal flags hide a meeting immediately on subsequent DB reads.

A read-only database snapshot contained 409 removal candidates, 9 dated today,
and 34 missing-duration candidates. These are capacity estimates, not measured
production traffic; cache state, replicas, errors, and changing record counts
alter the totals. The earlier investigation had 408 removal candidates.

| Web TV source | Previous requests/day | Revised requests/day |
| --- | ---: | ---: |
| Today's schedules | 576 | 288 |
| Tomorrow's schedules | 576 | 144 |
| Yesterday / T-2 schedules, with working cache | ~150 | ~150 |
| T+2 through T+7 schedules | 144 | 144 |
| Removal sweeps, using the same 409-row snapshot | 1,636 | 616 |
| Total scheduled | ~3,082 | ~1,342 |

Revised removal formula: `24 * today + other = 24 * 9 + 400`.
This is approximately 56% less scheduled Web TV traffic: 56/hour or 0.93/minute,
versus 128/hour or 2.14/minute. These are daily averages, not peak rates.
Visitor/reaper cache overlap can lower the previous estimate. Cache TTL expiry
and stale-while-revalidate can also shift the nominal schedule request counts.
Without working caching, scheduled fetch volume is 4,084/day before versus
1,768/day after (57% less), using this same snapshot.

60,000 page views per 30-day month = 2,000/day. Listing/search pages use only
the DB. Each meeting render attempts one Web TV asset fetch; cache hits do not
reach Web TV. Three hours instead of one reduces refresh opportunities for a
continuously popular asset from ~24/day to ~8/day per instance (up to 67% fewer).
It does not reduce requests for assets visited once. Exact visitor savings need
actual cache-miss and page-mix telemetry; bot/API traffic may not be in page views.

Kaltura HTTP requests (a multirequest is ONE HTTP request, containing 2–3 API
operations):

- A normal interactive meeting visit causes one uncached entry-status request
  on server render and one uncached flavor/language request on client mount.
  At 2,000 meeting views/day this is about 4,000 API requests/day before player
  traffic, language refreshes, or transcription. Actual volume depends on the
  fraction of views that are meeting pages. This behavior is unchanged.
- Missing-duration backfill: 100 entries/request. With 34 candidates, 96/day
  previously versus 48/day now, if those candidates persist.
- Removal status batches: 100 entries/request. Previously `4 * ceil(409/100)`
  = 20/day; now `24 * ceil(9/100) + ceil(400/100)` = 28/day. The small increase
  buys hourly detection for today's meetings. These two maintenance sources
  together fall from 116 to 76/day (34%).
- New entry resolution: one request per uncached/unresolved video per sync
  attempt; successful resolutions are persisted. No extra lookup for cached IDs.
- Scheduled transcription: every five minutes, one flavor request per eligible
  waiting transcript/language. Future bookings are skipped; live or converting
  recordings are retried. For P continuously waiting eligible rows, this is
  12P/hour, plus a further lookup when submitting transcription. Counts of all
  scheduled rows alone would overestimate this traffic.
- Realignment: hourly duration batches of up to 400 unique entries, plus
  on-demand metadata/media calls for actual realignments. Player manifests,
  segments, thumbnails, and audio downloads are additional media traffic.

Follow-up opportunities for Kaltura: cache page-only status/language lookups
briefly and deduplicate flavor probes across languages of the same meeting per
worker tick. Keep recording readiness probes fresh, and cache only upstream
language availability (not the DB-derived transcript status returned beside it).
