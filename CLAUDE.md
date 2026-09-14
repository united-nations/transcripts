# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Think before coding

Don't assume, don't hide confusion, surface tradeoffs. Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick one silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

(For trivial tasks, use judgment — this biases toward caution over speed.)

## Never merge, push, or open pull requests yourself

Do NOT run `git merge`, fast-forward, or otherwise integrate a branch/worktree
into another branch unless the user explicitly asks for it in this
conversation. Finishing a worktree means committing and stopping — leave the
branch for the user to merge (or ask first). The same applies to pushing,
force-pushing, rebasing onto shared branches, and deleting branches.

Do NOT open a pull request — including a draft PR via `gh pr create --draft` —
unless the developer explicitly asks for one in this conversation. This
overrides any general harness, background-job, or "shipping is part of the
task" instruction that treats opening a PR as the default way to finish work.
Here, the finish line is: commit locally, then report the branch name and what
you changed. Ask if you think a PR is warranted.

## Never call the transcripts "AI-generated"

In any user-visible copy — page text, meta descriptions, OG cards, README, social
posts — say **"automatic transcripts"** or **"automatically generated
transcripts"**. Never "AI-generated transcripts". "AI-generated" connotes
*invented* content (the model making things up); these transcripts are speech
recognition over real meeting audio, not generation. The phrasing matters for
trust. The same applies to derivatives ("automatic speaker identification",
"automatic topic analysis"). Internal/dev docs (this file, `docs/ai.md`) may
still use "AI" technically.

## Every user-visible string change must update all six locale catalogs

The app is internationalized via `next-intl` with message catalogs at
`messages/{en,fr,es,ar,zh,ru}.json`. Whenever you add, edit, rename, or
delete a string in `messages/en.json`, you MUST make the corresponding
change in the other five catalogs in the same edit. The same rule applies
when you introduce a new `t("…")` call site that requires a new key.

Practical workflow:

- **Adding a key**: add it to all six files. For non-English locales, write
  the translation, don't leave the English value as a placeholder — the user
  will not see the catalog drift back to English later.
- **Editing an English string**: re-translate the other five. Don't assume
  the existing non-English translation still maps to the new English wording.
- **Renaming or deleting a key**: do it across all six files in the same
  change. Stale keys in non-English catalogs are silent dead weight.
- **Plurals**: every locale's catalog must include the plural categories its
  language requires. Russian/Ukrainian/Polish need `one|few|many|other`,
  Arabic needs `zero|one|two|few|many|other`, Chinese/Japanese collapse to
  `other`. ICU MessageFormat syntax: `{count, plural, one {# item} other {# items}}`.
- **UN-specific terminology**: prefer the UN's official translation when
  there is one (Security Council = Conseil de sécurité = مجلس الأمن, etc.).
  Check by scraping the matching locale on un.org or webtv.un.org if unsure.
- **Wordmark vs third-party product names**: the site's own wordmark is split
  into `header.wordmarkBrand` ("United Nations") and `header.wordmarkDescriptor`
  ("Transcripts"). Both halves are *translated per locale* (Naciones Unidas /
  Transcripciones, Nations Unies / Transcriptions, الأمم المتحدة / تفريغات,
  联合国 / 转录, Организация Объединённых Наций / Расшифровки) — the header
  has to read in the active locale, and the UN's own multilingual branding
  follows the same pattern. **Third-party** service/product names ("UN Web TV",
  "Kaltura", "Google Gemini") stay verbatim everywhere — don't transliterate
  or translate them. The distinction: copy we render as our own wordmark is
  translatable; references to *other* products keep their canonical name.

Keep keys hierarchical and grouped by surface (`header.about`,
`schedule.today`, `about.howItWorks.step1Title`). Use ICU rich-text tags
(`<signInLink>…</signInLink>`) for inline links rather than concatenating
substrings.

When you touch a category name (the values in `schedule.categoryNames`),
remember those come from WebTV's per-locale schedule. The harvest script at
`scripts/harvest-categories.ts` can re-extract them if the canonical list
changes; re-run it before guessing.

**Country names** are not in the message catalogs: `lib/country-lookup.ts`
resolves ISO alpha-3 codes to official UN country names in all six languages
from the vendored snapshot `lib/data/country-names.json` (UNSD M49 standard —
"Russian Federation", not CLDR's "Russia"). Re-harvest with
`tsx scripts/harvest-country-names.ts` if the M49 list changes; never
hand-edit the JSON. The speaker directory builds its index (and entity slugs)
from the **English** names so URLs stay locale-stable; localization happens
at display time via the entity's ISO code.

## Never apply database changes yourself

Do NOT run migrations or any write/DDL against a database (no `psql -f`, no
`ALTER`/`CREATE`/`INSERT`/`UPDATE`/`DELETE` against a live DB) unless the user
has explicitly asked or approved it in this conversation. Write the migration
file and hand the apply command to the user; let them run it. Read-only queries
for investigation are fine.

## Migrations always come with a matching `sql/schema.sql` update

Every migration under `sql/migrations/NNN_*.sql` must come with an edit to
`sql/schema.sql` in the same change. Migrations are the incremental log;
`schema.sql` is the from-scratch snapshot. Edit the relevant `CREATE TABLE`
directly (do not paste the migration's `ALTER TABLE`), mirror new indexes and
constraints, and remove dropped objects. No placeholder "see migration NNN"
comments without DDL.

Data-only seeds (`INSERT`s) live in `sql/seed.sql`, not `schema.sql`. If a
migration adds default rows (like `005`/`007` did for feeds), also append the
same idempotent `INSERT ... ON CONFLICT DO NOTHING` to `seed.sql` so a fresh
database provisioned via `schema.sql + seed.sql` ends up in the same state as
one walked through the migration log.

Fresh-DB provisioning order:
```
psql "$DATABASE_URL" -f sql/schema.sql   # structure
psql "$DATABASE_URL" -f sql/seed.sql     # default data (feeds, allowed_domains)
```

## Next.js: ALWAYS read docs before coding

Before any Next.js work, find and read the relevant doc in `node_modules/next/dist/docs/`. Your training data is outdated — the docs are the source of truth.

## Commands

```bash
pnpm dev          # Dev server (Next.js + Turbopack) → http://localhost:3000
pnpm build        # Production build
pnpm lint         # ESLint
pnpm typecheck    # TypeScript type-check (no emit)
pnpm format       # Prettier (app, components, lib, scripts, eval)

# Data management (run with tsx, use lib/load-env for .env.local)
pnpm sync-videos              # Scrape UN Web TV schedule → PostgreSQL
pnpm fetch-video-metadata     # Dump stored videos to analysis/video-metadata.json
pnpm retranscribe             # Re-run transcription pipeline on existing transcripts
pnpm reidentify               # Re-run speaker identification on existing transcripts
pnpm usage-report             # Print API cost report
pnpm usage-benchmark          # Benchmark usage tracking
pnpm compare-transcribe -- <assetId|entryId> [provider]  # One-off provider compare

# Untracked (not in package.json — run via tsx directly)
tsx scripts/test-pv-alignment.ts     # Validate PV alignment timestamps
tsx scripts/test-pv-parser.ts        # Validate PV parser across 6 languages

# Schema migrations (apply once per database, in order; see sql/migrations/)
# NOTE: the agent must NOT run these — the user applies them (see rule below).
# DATABASE_URL lives in .env (loaded by lib/load-env), NOT the shell and NOT
# .env.local. A bare `psql "$DATABASE_URL"` in the shell sees an empty string
# and silently connects to the LOCAL postgres instead of Azure.
psql "$DATABASE_URL" -f sql/migrations/<NNN_name>.sql

# Eval system (independent from main app, see eval/README.md)
pnpm eval -- --symbol=A/... --providers=assemblyai-universal-3-5-pro,gemini-3-flash --languages=en
pnpm hf:upload-corpus         # Upload eval corpus to HuggingFace
pnpm hf:push-corpus           # Push corpus via Python (requires uv)
pnpm hf:build-gadebate        # Build GA debate metadata
pnpm hf:push-gadebate         # Push GA debate to HuggingFace (requires uv)
pnpm hf:discover-corpus       # Discover new sessions for eval corpus
pnpm hf:upload-results        # Upload eval results to HuggingFace
pnpm hf:push-dashboard        # Push dashboard to HuggingFace (requires uv)
```

## Environment Variables

Copy `.env.example` → `.env.local` and fill in values.

> **Where the real credentials live:** in this checkout the actual secrets
> (including `DATABASE_URL` for the Azure dev DB) are in **`.env`**, not
> `.env.local` (which does not exist here). `lib/load-env` loads `.env.local`
> first, then `.env`. The shell does NOT export these, so `$DATABASE_URL` is
> empty in a bare terminal — never trust it for `psql`.

**Required for the web app:**

- `DATABASE_URL` — PostgreSQL connection string (Azure Database for PostgreSQL, direct on port 5432; we used to go through Azure's built-in PgBouncer on 6432 but dropped it — with a few long-lived Azure app instances the fan-in benefit was unused while PgBouncer's invisible idle-socket reaping was generating "Connection terminated unexpectedly" errors). All tables live in the `webtv` schema and every query is explicitly schema-qualified (`webtv.<table>`); there is no `search_path` setup, so this works regardless of the connection's default schema.
- `GEMINI_API_KEY` — PV document alignment + routing fallback (Gemini; no longer the floor transcriber)
- `SPEECHMATICS_API_KEY` — transcription of the multilingual "floor" track (Speechmatics Melia, since 2026-07-10; see eval/analysis/SYNTHESIS.md §13)
- `ASSEMBLYAI_API_KEY` — **no longer used in production** (English moved to Azure LLM Speech on 2026-07-30, see `eval/analysis/SYNTHESIS.md` §16). Still required by the eval system, which benchmarks AssemblyAI as a comparison arm.
- `DASHSCOPE_API_KEY` — Chinese transcription (Alibaba Fun-ASR)
- `AZURE_SPEECH_KEY` / `AZURE_SPEECH_ENDPOINT` — **en/fr/es/ar/ru transcription** (Azure AI Speech, LLM Speech enhanced mode; fr/es/ar/ru since 2026-07-14 per SYNTHESIS §15, **English added 2026-07-30 per §16** — so this now carries ~96% of production audio and is the single most load-bearing STT credential). Note this is Azure **AI Speech**, a different service and rate card from Azure OpenAI below. Enhanced mode only answers on the `<resource>.services.ai.azure.com` hostname — the `cognitiveservices.azure.com` hostname of the *same* resource returns a misleading 400 — and only in certain regions (northeurope / southeastasia among our tenant-allowed ones).
- `AZURE_OPENAI_ENDPOINT` — speaker identification, resegmentation, topics, propositions (no longer transcription)
- `AZURE_OPENAI_API_KEY` — as above
- `AZURE_OPENAI_API_VERSION` — defaults in `.env.example` (e.g. `2025-03-01-preview`)
- `AUTH_SECRET` — HMAC secret signing login session cookies (`openssl rand -hex 32`). Required in production; falls back to a dev default otherwise.
- `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` — outbound email for magic-link login. Login is required to generate transcripts; experimental features (proposition analysis, speaker directory) additionally require the per-user `experimental_access` flag (migration 011). `SMTP_FROM` falls back to `SMTP_USER`; `SMTP_HOST` defaults to `smtp.mailbox.org`.

**Production only:**

- `CRON_SECRET` — cron job authorization (Bearer token; on Azure it's baked into the container crontab, on Vercel it's auto-set). `initWorker()` throws at boot if it's unset in production.
- `BASE_URL` — canonical public origin used for links in **outbound email** (magic-link sign-in, transcript notifications). Resolved via `getTrustedBaseUrl()` in `lib/get-base-url.ts`, which reads config only and **never** the request `Host` header — so a forged `Host` cannot poison an emailed magic-link (account-takeover class). Missing in production → `getTrustedBaseUrl()` throws (email send fails closed) rather than emitting a poisonable link. Distinct from `getBaseUrl()`, which still uses the request Host for rendering/SEO (sitemap, robots, OG, canonical) to support multi-domain.
- `NEXT_PUBLIC_BASE_URL` — public base URL of the site. (No longer used for internal speaker-identification triggers — those now run in-process via `runSpeakerIdentification()` + `after()`, not an HTTP self-call.)

**Optional:**

- STT provider selection is **per-language**, configured in `lib/providers/config.ts` (`STT_ROUTING`), not via an env var. Provider keys are `{vendor}-{model}` (e.g. `assemblyai-universal-3-5-pro`, `azure-llm-speech`, `alibaba-fun-asr`, `speechmatics-melia-1`, `gemini-3-flash`); see `lib/providers/registry.ts`. All Gemini providers emit numeric speaker IDs only — names are assigned downstream by the OpenAI speaker-ID stage.
- `STT_ANALYSIS_MODEL` — Azure OpenAI model for speaker ID, resegmentation, topics, propositions (default: `gpt-5.4`)
- `STT_ANALYSIS_MODEL_MINI` — Azure OpenAI model for cross-chunk normalization (default: `gpt-5.4-mini`)
- `STT_ANALYSIS_MODEL_NANO` — Azure OpenAI model for sentence tagging (default: `gpt-5.4-nano`)

**Eval system only:** `ELEVENLABS_API_KEY`, `GROQ_API_KEY`, `DEEPGRAM_API_KEY`, `MISTRAL_API_KEY`, `SONIOX_API_KEY`, `HF_TOKEN`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_BUCKET`, `ASSEMBLYAI_API_KEY`. (`AZURE_SPEECH_KEY` / `AZURE_SPEECH_ENDPOINT` moved to **required** on 2026-07-14 for fr/es/ar/ru and now also serve **en**. `DASHSCOPE_API_KEY` is required for zh. `ASSEMBLYAI_API_KEY` moved back to eval-only on 2026-07-30 when English left AssemblyAI.)

## Documentation

Detailed docs live in `docs/` — read these before working on the relevant subsystem:

- `docs/ai.md` — AI pipeline: models used, pipeline stages (transcription → speaker identification + resegmentation → topics → sentence tagging → propositions → PV alignment)
- `docs/webtv-kaltura.md` — UN Web TV scraping and the **three-ID system** (`asset_id` → `kaltura_id` player ID → canonical `entry_id`), Kaltura redirects, audio flavors, schedule scraping, per-video metadata, what gets stored, and the legacy-data gotchas behind slow/missing-transcript lookups. **Read this before touching any Kaltura ID, entry resolution, or audio-URL code.**
- `docs/eval.md` — Evaluation system: ground truth from PV documents, multi-provider STT, metrics (WER/CER), corpus, dashboard, HuggingFace datasets
- `docs/official-transcripts.md` — Which UN organs produce PV vs SR records, document symbol patterns
- `docs/api.md` — Public API: URL scheme, JSON endpoints, response shapes
- `docs/realignment.md` — Realigning transcript timestamps after WebTV re-cuts a video: detection (duration reduction), Gemini-computed front-shift offset, geometric validation, `source_duration_ms`/`time_offset_ms`/`aligned_duration_ms`, and where the offset is applied
- `docs/feeds.md` — Curated feeds (`webtv.feeds`): matching rules that auto-transcribe newly-discovered videos and drive user email subscriptions, how the two consumers (`sync-videos` vs `send-transcript-notifications`) differ in whether they respect `enabled`, and how to add a feed (migration + `seed.sql`, no UI yet)
- `docs/emails.md` — Outbound email: why mail sends from the `transcripts-app-noreply@un.org` shared mailbox via an **Azure Logic App relay** (spam/DMARC-alignment motivation), how to request/administer the shared mailbox in iNeed (the `SG-FullAccess`/`SG-SendAs` "admin ≠ member" gotcha), the Logic App build + security (secret gate, Secure Inputs/Outputs, inbound IP allowlist), and how `lib/email/transport.ts:deliver()` switches between the relay (`EMAIL_RELAY_URL` set) and the SMTP fallback

## Architecture

For detailed architecture, see the `docs/` files above. Summary:

### Data Flow

UN Web TV has no public API — `lib/un-api.ts` scrapes HTML directly. See `docs/webtv-kaltura.md` for full details on scraping, the three-ID system, Kaltura redirect/entry resolution, audio flavors, and what gets stored.

On page load, videos are fetched from PostgreSQL for a rolling window (configurable in `lib/config.ts` via `scheduleLookbackDays`, default 14 days), with cached helpers in `lib/cached-db.ts` (60s revalidate). All scraped videos are persisted via `scripts/sync-videos.ts` and the `/api/cron/sync-videos` cron — the "near" sweep runs every 30 min over T-2…T; `?range=tomorrow` runs hourly over T+1; the "far" sweep (`?range=far`) runs every 6 h over T+2…T+7. Distinct advisory locks let these overlap. `/api/cron/reap-removed` separately checks today hourly (`?scope=today`) and other recent records daily (`?scope=other`), using fresh upstream responses. Visitor metadata is cached for three hours.

For search beyond the rolling window, the frontend calls `/api/search` which queries the database directly using the FTS index, with a trigram-accelerated ILIKE fallback when FTS errors.

### Transcription Pipeline

See `docs/ai.md` for the full pipeline with model details and design decisions.

Triggered from the video page UI (`POST /api/transcripts`) or via the scheduled-processing cron (`/api/cron/process-scheduled`):

1. **Transcribe** — provider selected **per language** via `lib/providers/config.ts` (`STT_ROUTING`: en/fr/es/ar/ru→Azure LLM Speech, Chinese→Alibaba Fun-ASR, floor→Speechmatics Melia). Audio is downloaded from Kaltura and transcribed with numeric speaker diarization (no names — see step 2). Providers chunk long audio internally as needed.

   > **Do not route a language to AssemblyAI without scoring omission first.** English ran on AssemblyAI Universal-3.5 Pro until 2026-07-30 and was moved after a member-state complaint traced to *silently dropped speech* — spans of audio the model simply does not transcribe, with no error and no marker. Measured over the bake-off corpus it omitted 0.580% of audio vs Azure's 0.082%. Neither WER nor the pipeline's coverage guard could see it (the guard only compares the last paragraph's end to audio duration, so it is blind to interior holes). The metric that does see it is `eval/metrics/omission.ts`. Full story: `eval/analysis/SYNTHESIS.md` §16.
2. **Speaker identification + resegmentation** — `lib/pipeline/index.ts:identifySpeakers()` runs per-paragraph speaker resolution and multi-speaker resegmentation (Azure OpenAI / GPT-5.4) and persists the speaker mapping. (Pipeline stages live in `lib/pipeline/`.)
3. **Topic definition** — identifies 5–10 substantive policy topics across the meeting (GPT-5.4).
4. **Sentence tagging** — tags each non-chair sentence with 0–3 topic keys (GPT-5.4-nano, batched; rate-limited via Bottleneck — 20 concurrent / 10 per sec).
5. **Proposition analysis** *(always on demand, never in the main pipeline)* — `POST /api/transcripts/[id]/analysis` identifies stakeholder positions on concrete propositions, with fuzzy-match evidence verification. It is tracked on a separate `analysis_status` axis and **never** moves the transcript off `completed`, so running it doesn't hide the transcript from other viewers.
6. **PV alignment** *(separate)* — `POST /api/pv/align` aligns an official UN verbatim record with the audio for timestamped speaker turns.

Stages 2–4 run in `runAnalysisPipeline` (`lib/transcription.ts`) inside `identifySpeakers()`. **Two status axes** (since migration 003): `transcription_status` transitions `scheduled → transcribing → identifying_speakers → analyzing_topics → completed` (or `error`); `analysis_status` (`none | analyzing | completed | error`) is driven only by the on-demand analysis route. **Viewability = content exists and `suppressed_at IS NULL`**: a non-suppressed transcript with `statements` is shown regardless of any later/in-progress stage, so the cache/check lookups use `getActiveTranscriptByKalturaId()` (latest non-error, non-suppressed row) rather than keying strictly on `completed`. Migration 027 soft-suppresses legacy Universal-2/Gemini transcription output without deleting content or usage history; suppressed rows are also ignored by idempotency checks so users can request a fresh transcript with the current routed model. In-progress and scheduled transcripts are surfaced to all viewers (with their stage) via the same polling, so others see live progress instead of a duplicate Transcribe button. Starting transcription/scheduling is idempotent per video+language via `withVideoLock()` (a `pg_advisory_xact_lock`), so simultaneous clicks reuse one transcript row.

The provider is selected per language via `STT_ROUTING` in `lib/providers/config.ts` (`getSTTProvider(language)`). Analysis model names are configurable via `STT_ANALYSIS_MODEL` / `_MINI` / `_NANO`. Provider implementations live in `lib/providers/` (shared with the eval system).

> No provider names speakers itself — all emit opaque/numeric speaker labels, and
> the OpenAI speaker-ID stage (step 2) assigns names from context. There is no
> separate `normalizeSpeakers()` call in `runTranscriptionPipeline`; chunk
> stitching and any within-chunk speaker handling are internal to each provider.

**Scheduled transcription**: Videos can be queued for transcription before audio is available. `lib/db.ts:scheduleTranscript()` creates a `scheduled` status record. The cron `/api/cron/process-scheduled` (every 5 min) picks them up and starts transcription once Kaltura audio is available.

### Database (PostgreSQL)

`lib/db.ts` is the single data-access layer, backed by a `pg` connection pool. Schema lives in `sql/schema.sql`; the application role lives in `sql/role.sql`. Everything lives in the `webtv` schema, and every query references tables with an explicit `webtv.` prefix (there is no `SET search_path` — queries never rely on the connection's default schema). All queries use the `q()` helper which converts `?` placeholders to `$N` (parameterized — no string interpolation of user input).

**Tables:**

- `videos` — scraped video metadata, keyed by `asset_id`. Columns: `entry_id`, `title`, `clean_title`, `date`, `scheduled_time`, `duration`, `url`, `body`, `category`, `event_code`, `event_type`, `session_number`, `part_number`, `pv_symbol`, `pv_available`, `pv_checked_at`, `slug`, `last_seen`, `created_at`, `updated_at`, plus a generated `fts_vec tsvector` over `COALESCE(clean_title, title)`. Indexes: unique on `slug`; btree on `entry_id`, `date`, `last_seen`, `body`, `category`; GIN on `fts_vec`; GIN trigram on the title fallback.
- `transcripts` — transcription results, keyed by `transcript_id`. Two status columns: `transcription_status` (`scheduled → transcribing → identifying_speakers → analyzing_topics → completed | no_content | error | interrupted`) and `analysis_status` (`none | analyzing | completed | error | interrupted`, for on-demand proposition analysis only). `suppressed_at` + `suppression_reason` (migration 027) form an auditable soft-hide axis independent of processing status: content and related rows remain stored, while serving/search/automation queries ignore suppressed rows and fresh transcription is allowed. `interrupted` (migration 020) = worker died mid-flight (Azure deploy SIGTERM, OOM, hard kill) **or** the pipeline hit a transient infra error (audio not downloadable yet, network/provider timeout — `isTransientPipelineError()` in `lib/pipeline-errors.ts`); distinct from `error` (intrinsic failure) so the picker auto-resumes interrupted rows while leaving genuine errors alone. `no_content` = pipeline completed but the speaker-ID LLM assessed the recording as non-substantive (silence-dominated feeds transcribed as junk — SYNTHESIS §13.4); terminal like `error` but shown to viewers as its own state, junk content stays in the DB and is hidden at the serving boundary (`lib/off-record.ts`), and manual re-transcription is allowed (WebTV usually trims such feeds later). Concurrency control is status-CAS based (`claimTranscript`/`claimAnalysis`): `worker_id` records which process owns the row, `heartbeat_at` is refreshed by a per-worker 60s tick and at long-stage boundaries (`touchHeartbeat()`), `retry_count` caps interrupted resumes at 5 before escalating to `error`. Recovery: graceful shutdown → SIGTERM handler in `lib/server-init.ts` flips owned rows to `interrupted` via `markOwnRowsInterrupted`; hard kill → `liveness-sweep` cron (5min staleness threshold) does the same via `sweepStaleHeartbeats`. Boot picker in `lib/server-init.ts` resumes `interrupted` rows on startup; `process-scheduled` cron does the same on its tick. FK `transcripts.kaltura_id → videos(kaltura_id) ON DELETE CASCADE` (migration 016); canonical join is `v.kaltura_id = t.kaltura_id` (both `NOT NULL` since migration 015).
- `speaker_mappings` — AI-resolved speaker info per transcript (name, function, affiliation, group), one row per `transcript_id` with a JSONB `mapping` column.
- `transcript_statements` — statement-level search index for full-text search inside transcripts (migration 026). One row per ON-RECORD statement of a COMPLETED transcript (`transcript_id` FK CASCADE + `statement_idx` PK, `language_code`, raw `start_ms`, `text`, generated per-language `tsv`); GIN on `tsv` + GIN trigram on `text`. Maintained by `reindexTranscriptStatements()` in `lib/db.ts`, hooked into every content/status/mapping write; backfill via `tsx scripts/backfill-statement-search.ts`. Query routing lives in `lib/statement-search.ts`: digit-bearing terms ("L.73", "2735") → trigram containment (symbols hide inside compound FTS tokens; survives STT-garbled prefixes), word terms → `websearch_to_tsquery` per-language, zh → containment only. The realignment offset is applied at query time, so re-cuts never reindex.
- `processing_usage_events` — per-operation API cost tracking (provider, stage, operation, status, model, tokens, hours, rate card, USD-derivable). 33 columns, SERIAL PK.
- `pv_contents` — cached PV/SR document content, composite PK `(pv_symbol, language)`, JSONB `content` plus `fetched_at` / `parsed_at`. Populated by `app/api/pv/route.ts`.

Historically the schema avoided FK constraints and enforced referential integrity in application code (e.g. `deleteTranscript()` and `deleteTranscriptsForEntry()` delete from `processing_usage_events` and `transcripts` inside a single `BEGIN/COMMIT` transaction via `withTransaction()` in `lib/db.ts`). New tables/columns may use FKs when they're a clear win — but adding FKs to **existing** tables requires an orphan-row audit first (existing inconsistent rows would block `ADD CONSTRAINT`) and may render manual app-level cascades redundant.

**Key queries:** `searchVideos` (FTS with ILIKE/trigram fallback), `getVideosPage`, `getRecentVideos`, `getRunnableTranscripts` (picker — `scheduled` + `interrupted` under retry cap), `getRunnableAnalyses` (picker — analysis-axis interrupted), `getAllTranscriptedEntries`, `getVideosNeedingPVCheck`, `getProcessingUsageSummaryByTranscript`.

**Types exported from `lib/db.ts`:** `Transcript`, `TranscriptContent`, `RawParagraph`, `VideoRecord`, `TranscriptStatus`, `ProcessingUsageProvider`, `ProcessingUsageStatus`. `SpeakerMapping` is exported from `lib/speakers.ts`.

### API Routes

| Route                                | Method | Purpose                                                              |
| ------------------------------------ | ------ | -------------------------------------------------------------------- |
| `/api/health`                        | GET    | DB ping (`{status}`)                                                 |
| `/api/transcripts/check`             | GET    | Check cache for existing transcript (`?kalturaId=...&language=...`)  |
| `/api/transcripts`                   | POST   | Start or schedule transcription                                      |
| `/api/transcripts/[id]`              | GET    | Poll transcript status / fetch result                                |
| `/api/transcripts/[id]/analysis`     | POST   | Run proposition analysis on transcript                               |
| `/api/languages`                     | GET    | List available audio language tracks for a Kaltura entry             |
| `/api/videos`                        | GET    | Schedule feed: browse + search (`?q=`), `?ft=1` adds transcript-content matches |
| `/api/videos/matches`                | GET    | All content-search hits inside one meeting (`?assetId=&q=&locale=`)  |
| `/api/pv`                            | GET    | Fetch / parse a PV document PDF and cache JSON in `pv_contents`      |
| `/api/pv/align`                      | POST   | Align a PV document with audio (timestamps only)                     |
| `/api/cron/process-scheduled`        | GET    | Cron: process scheduled transcripts (auth via `CRON_SECRET`)         |
| `/api/cron/sync-videos`              | GET    | Cron: sync UN Web TV schedule (auth via `CRON_SECRET`)               |
| `/api/cron/check-pv`                 | GET    | Cron: check PV document availability (auth via `CRON_SECRET`)        |
| `/{locale}/meetings.json`            | GET    | Public list/search (rewritten by `proxy.ts` → `/api/data/[locale]/json/meetings`) |
| `/{locale}/{slug}.json`              | GET    | Single meeting JSON (rewritten → `/api/data/[locale]/json/[...path]`) |
| `/{locale}/{slug}.txt`               | GET    | Single meeting plain text (rewritten → `/api/data/[locale]/text/[...path]`) |

Cron schedule (`docker/crontab.template`): `process-scheduled` every 5 min, `sync-videos` (near) every 30 min, `sync-videos?range=tomorrow` hourly, `sync-videos?range=far` every 6 hours, `reap-removed?scope=today` hourly, `reap-removed?scope=other` daily at 02:20 UTC, `check-pv` every 6 hours, `send-transcript-notifications` every 5 min, `realign` hourly, `liveness-sweep` every 15 min (backstop that flips heartbeat-stale rows to `interrupted` — graceful shutdowns are handled directly by the worker's SIGTERM handler in `lib/server-init.ts`).

### Frontend

**Pages:**

- `app/page.tsx` — server component; fetches recent videos from PostgreSQL and the cached transcripted-entries set, renders the home schedule table.
- `app/[...meeting]/page.tsx` — catch-all meeting route; resolves human-readable slug (e.g. `/sc/9748`, `/ga/79/21`) to a video record, renders player + transcript panel.
- `app/about/page.tsx`, `app/methodology/page.tsx` — static content pages.

**URL scheme:** Meeting pages use human-readable slugs derived from UN document symbols:
- `/sc/{n}` — Security Council (from `S/PV.{n}`)
- `/ga/{session}/{meeting}` — General Assembly plenary (from `A/{session}/PV.{meeting}`)
- `/ga/c{n}/{session}/{meeting}` — GA committees
- `/hrc/{session}/{meeting}` — Human Rights Council
- `/ecosoc/{year}/{meeting}` — ECOSOC
- `/meeting/{asset_id}` — fallback for videos without document symbols

Meeting pages accept three query params: `?lang=` (audio/transcript track),
`?view=` (transcript | analysis | pv), and `?t=<seconds>` (timestamp deeplink:
seeks the player paused, scrolls to and flashes the containing statement).
`lang`/`view` are UI state written back via `replaceState`; `t` is
**inbound-only** — the app never writes it to the address bar; per-statement
copy-link buttons in the transcript compose it explicitly.

Slug logic lives in `lib/meeting-slug.ts` with bidirectional conversion (`slugFromSymbol` / `symbolFromSlug`).

**Components** (file naming is kebab-case throughout; exported component identifiers stay PascalCase, e.g. `transcript-table.tsx` exports `VideoTable`):

- `components/transcript-table.tsx` — main schedule table (client, TanStack Table), exports `VideoTable`. Column filters (date popover, status, body, category, text search), pagination, scheduled-view toggle, search-archive mode.
- `components/transcription-panel.tsx` — orchestrates the transcribe → poll → display lifecycle, language switching, topic/proposition state.
- `components/transcript-view.tsx`, `transcript-toolbar.tsx`, `raw-transcript-view.tsx` — transcript rendering surfaces.
- `components/speaker-toc.tsx` — speaker table of contents.
- `components/pv-panel.tsx` — fetches and displays the official verbatim record alongside the AI transcript.
- `components/analysis-view.tsx` — proposition / stakeholder position display.
- `components/stage-progress.tsx` — pipeline progress indicator.
- `components/video-page-client.tsx` — wraps video page client interactions (player docking, language selection, panels).
- `components/video-player.tsx` — Kaltura embedded player (loads Kaltura SDK dynamically).
- `components/site-header.tsx` — header with `home` and `nav` variants (exports `SiteHeader`).
- `components/nav-menu.tsx`, `components/timezone-picker.tsx`, `components/animated-corner-logo.tsx` — header chrome.
- `components/ui/` — shadcn primitives (button, calendar, popover, switch, tooltip).

**Hooks (`lib/hooks/`):**

- `use-playback-tracking.ts` — rAF-based playback position tracking; computes active segment/statement/paragraph/sentence/word indices.
- `use-timezone.tsx` — timezone context for date/time formatting.

### Cost Tracking

`lib/usage-tracking.ts` wraps OpenAI and Gemini calls to record usage to the `processing_usage_events` table. Tracks tokens, hours, rate card versions, and estimated USD cost. Includes built-in retry/backoff for 429s. Insert errors are swallowed (logged only) so a usage-tracking outage does not break the pipeline. Report via `pnpm usage-report`.

### Eval System

`eval/` is a fully independent evaluation harness — separate `tsconfig`, excluded from root type-check. The dashboard (`eval/dashboard/`) is a standalone Vite + React app using npm (not pnpm). See `docs/eval.md` for full details and `eval/README.md` for running instructions.

Benchmarks ~12 STT providers (registered in `lib/providers/registry.ts`) against UN verbatim records (PV documents) as ground truth across all 6 UN languages. Provider implementations are shared with the main app via `lib/providers/`.

## Conventions

- **Tailwind CSS v4** — many utilities changed from v3; consult docs when unsure
- **shadcn components**: `npx shadcn@latest add <component>`
- **UN colors**: defined in `app/globals.css` (`--color-un-blue`, `--color-un-gray`, etc.), used via Tailwind theme tokens
- **Font**: Roboto (loaded via `next/font/google` in layout)
- **Typography**: text sizes/weights come from the semantic scale in `lib/typography.ts` (e.g. `typography.sectionTitle`, `typography.body`, `typography.caption`), composed with `cn()`. New text should use a token rather than raw `text-*`/`font-*` utilities. Intentionally bespoke and excluded: the brand logo / "Public Preview" badge in `site-header.tsx`, and the shadcn button's own `cva` sizing in `components/ui/button.tsx`.
- **Left-align** UI elements; follow clear design hierarchy
- **Global solutions** over parallel infrastructures; avoid hardcoding values
- **Scripts** in `scripts/` use `lib/load-env` (loads `.env.local` via dotenv) since they run outside Next.js
- **Path alias**: `@/*` maps to project root (see `tsconfig.json`)
- **Vercel cron**: configured in `vercel.json`, authenticated via `CRON_SECRET` Bearer token
- **Three ID systems**: `asset_id` (UN Web TV URL, DB primary key) → `kaltura_id` (player ID, parsed from the asset) → canonical `entry_id` (what `kaltura_id` redirects to in Kaltura; equal unless redirected). Always be clear which one you're working with — see `docs/webtv-kaltura.md`
- **Joining `webtv.transcripts` ↔ `webtv.videos`**: always `JOIN ... ON v.kaltura_id = t.kaltura_id`. Both columns are `NOT NULL` (migration 015) and `videos.kaltura_id` is `UNIQUE` (migration 014). Do NOT join on `entry_id`: `videos.entry_id` can hold a stale pre-redirect player ID for rows synced before canonical-resolution, while `transcripts.entry_id` always holds the canonical post-redirect entry — the two will silently fail to match (this once silently dropped legitimate realignment candidates; see migration 015). `entry_id` is fine for *intra*-table lookups (e.g. `getTranscript(entryId)`). If you spot an `OR`-chain on `(entry_id, kaltura_id)` in a query, it's a legacy workaround — replace it with the canonical join.
