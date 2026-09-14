# UN Web TV Transcribed

Browse and search UN Web TV videos with automatically generated transcripts, speaker identification, and topic analysis.

**Live site**: [transcripts.un.org](https://transcripts.un.org)

## Overview

This app scrapes [UN Web TV](https://webtv.un.org/en/schedule) (which has no public API), stores video metadata in PostgreSQL, and provides AI-powered transcription with speaker diarization, speaker identification, and topic analysis. Videos are displayed in a filterable table with real-time status tracking, search across the full archive, and individual video pages with embedded Kaltura player.

## Features

- **Video schedule table** with column filters, sorting, pagination, and global search (TanStack Table)
- **Full-archive search** via PostgreSQL (beyond the rolling schedule window)
- **Full-text search inside transcripts** — find meetings by what was _said_, not just by title. Each hit shows the speaker, a snippet, and links to the exact moment. Document symbols (`L.73`, `S/2026/243`) match as fragments, so they survive compound tokenization and garbled speech recognition
- **Timestamp deeplinks** — `?t={seconds}` on any meeting page seeks the video there and highlights the statement; every statement has a copy-link button, so a speech can be cited down to the sentence
- **Embedded video pages** with Kaltura player
- **Automatic transcription** with per-language speech-to-text routing (Azure AI Speech / Alibaba / Speechmatics), diarization, and paragraph breaks
- **Speaker identification** via Azure OpenAI (maps speaker labels to named delegates)
- **Scheduled transcription** for upcoming events (cron job picks them up when audio becomes available)
- **JSON API** for programmatic access to video data
- **Status badges** (Live / Scheduled / Finished) with smart sorting
- **Metadata extraction** from titles (UN body, event code, session number, etc.)
- **API cost tracking** per transcript (STT provider usage, OpenAI tokens)

## Documentation

Detailed documentation lives in [`docs/`](docs/):

- [AI Pipeline](docs/ai.md) — models, pipeline stages, design decisions
- [UN Web TV & Kaltura](docs/webtv-kaltura.md) — scraping, the three-ID system (asset → player → canonical entry), redirects, audio flavors, data flow
- [Evaluation System](docs/eval.md) — STT benchmarking, metrics, dashboard
- [Official Meeting Records](docs/official-transcripts.md) — PV vs SR records by UN organ
- [Public API](docs/api.md) — URL scheme, JSON/text endpoints, transcript search (`ft=1`), timestamp deeplinks (`?t=`)

## Getting Started

```bash
pnpm install
cp .env.example .env.local   # fill in values
pnpm dev                     # http://localhost:3000
```

## Commands

```bash
pnpm dev                      # Next.js dev server with Turbopack
pnpm build                    # Production build
pnpm lint                     # ESLint
pnpm typecheck                # TypeScript type-check (no emit)
pnpm format                   # Prettier

# Data management
pnpm sync-videos              # Sync video metadata from UN Web TV into PostgreSQL
pnpm fetch-video-metadata     # Dump stored video records to analysis/video-metadata.json
pnpm retranscribe             # Re-run transcription pipeline on stored transcripts
pnpm reidentify               # Re-run speaker identification on stored transcripts
pnpm usage-report             # Print API usage/cost report
pnpm usage-benchmark          # Compare/benchmark API pricing config

# Eval system (see eval/README.md)
pnpm eval -- --symbol=S/PV.9826 --providers=assemblyai --languages=en
```

## Environment Variables

See `.env.example` for all variables. Core ones:

| Variable                | Required   | Purpose                                             |
| ----------------------- | ---------- | --------------------------------------------------- |
| `DATABASE_URL`          | Yes        | PostgreSQL connection string                        |
| `GEMINI_API_KEY`        | Yes        | PV alignment (no longer transcription)              |
| `ASSEMBLYAI_API_KEY`    | Yes        | English transcription                               |
| `SPEECHMATICS_API_KEY`  | Yes        | Floor (multilingual) transcription                  |
| `AZURE_SPEECH_KEY`      | Yes        | fr/es/ar/ru transcription (Azure AI Speech)         |
| `AZURE_SPEECH_ENDPOINT` | Yes        | as above (must be the `services.ai.azure.com` host) |
| `DASHSCOPE_API_KEY`     | Yes        | Chinese transcription (Fun-ASR)                     |
| `AZURE_OPENAI_API_KEY`  | Yes        | Speaker ID, topics, propositions                    |
| `AZURE_OPENAI_ENDPOINT` | Yes        | as above                                            |
| `CRON_SECRET`           | Production | Cron job auth (Bearer token)                        |
| `BASE_URL`              | Production | Base URL for outbound email links                   |

## Tech Stack

- **Framework**: Next.js 16 (App Router, Server Components, Turbopack)
- **Language**: TypeScript 6
- **Styling**: Tailwind CSS v4
- **UI**: shadcn/ui, Lucide icons, Radix UI primitives
- **Table**: TanStack Table v8
- **Database**: PostgreSQL via `pg` connection pool
- **Transcription**: per-language STT routing (Azure LLM Speech for en/fr/es/ar/ru, Alibaba Fun-ASR for zh, Speechmatics Melia for the floor) — see `lib/providers/config.ts`
- **Speaker ID**: Azure OpenAI (structured output via Zod)
- **Video hosting**: Kaltura (partner ID: 2503451)
- **Deployment**: Azure Web App — container cron schedules today every 30 min, tomorrow hourly, and days 2–7 ahead every 6 hours. Removal checks run hourly for today and daily for other recent meetings. See `docker/crontab.template` for all jobs.
- **Package manager**: pnpm

## Project Structure

```
app/
  page.tsx                          # Home page (server component, fetches schedule)
  [...meeting]/page.tsx             # Video page with player + transcript
  about/page.tsx                    # About page
  methodology/page.tsx              # Methodology page
  layout.tsx                        # Root layout (Roboto font, corner logo)
  globals.css                       # Tailwind v4 theme + UN color palette
  api/
    health/route.ts                 # DB health probe
    languages/route.ts              # Available audio languages for a Kaltura entry
    transcripts/route.ts            # Start or schedule transcription
    transcripts/check/route.ts      # Cache lookup for an existing transcript
    transcripts/[id]/route.ts       # Poll transcript status / fetch result
    transcripts/[id]/analysis/...   # Run proposition analysis
    search/route.ts                 # Full-archive video search
    pv/route.ts                     # Fetch + cache PV document JSON
    pv/align/route.ts               # Align PV document with audio (timestamps)
    cron/sync-videos/route.ts       # Cron: sync video metadata
    cron/process-scheduled/route.ts # Cron: process scheduled transcriptions
    cron/check-pv/route.ts          # Cron: check PV document availability
  json/
    route.ts                        # JSON API: video list
    [...meeting]/route.ts           # JSON API: single video

components/                         # Mixed PascalCase / kebab-case naming — match neighbours
  TranscriptTable.tsx               # Main schedule table (client, TanStack Table)
  SiteHeader.tsx                    # Header (home vs nav variants)
  NavMenu.tsx, TimezonePicker.tsx, AnimatedCornerLogo.tsx
  video-page-client.tsx             # Video page client wrapper
  transcription-panel.tsx           # Transcribe/poll/display flow
  transcript-view.tsx, transcript-toolbar.tsx, raw-transcript-view.tsx
  speaker-toc.tsx                   # Speaker table of contents
  pv-panel.tsx                      # Official verbatim record panel
  analysis-view.tsx                 # Propositions / stakeholder positions
  stage-progress.tsx                # Pipeline progress indicator
  video-player.tsx                  # Kaltura embedded player
  ui/                               # shadcn primitives

lib/
  db.ts                             # Database layer (all queries, pg pool, webtv.-qualified tables)
  cached-db.ts                      # next/cache wrappers for read-heavy queries
  un-api.ts                         # UN Web TV HTML scraper + metadata extraction
  transcription.ts                  # Transcription submission + audio URL resolution
  gemini-transcription.ts           # Gemini Files API transcription (chunked)
  pipeline/                         # Analysis pipeline stages (speaker ID, resegment, topics, propositions)
  speakers.ts                       # Speaker mapping CRUD
  usage-tracking.ts                 # API cost tracking (Gemini + OpenAI)
  pv-alignment.ts, pv-documents.ts, pv-parser.ts  # PV document pipeline
  kaltura.ts, kaltura-helpers.ts    # Kaltura entry ID resolution + audio URL
  meeting-slug.ts                   # Bidirectional slug ↔ document symbol conversion
  config.ts                         # App config (lookback days, Gemini pricing card)
  api-error.ts                      # Standardized API error responses
  languages.ts, country-lookup.ts, timezone.ts
  providers/                        # STT provider implementations (shared with eval/)
    registry.ts, config.ts, models.ts, types.ts, convert.ts
    gemini-production.ts, gemini.ts, assemblyai.ts, ...
  hooks/
    use-playback-tracking.ts, use-timezone.tsx
  load-env.ts                       # Loads .env.local for scripts outside Next.js

scripts/                            # CLI scripts (run via tsx, use lib/load-env)
  sync-videos.ts                    # Scrape UN Web TV → database
  fetch-video-metadata.ts           # Dump video records to analysis/
  retranscribe.ts                   # Re-run transcription on existing records
  reidentify.ts                     # Re-run speaker identification
  test-pv-parser.ts, test-pv-alignment.ts, compare-transcription.ts

sql/
  schema.sql                        # webtv schema, tables, indexes
  role.sql                          # webtv_app application role

docs/
  ai.md                             # AI pipeline: models, stages, design decisions
  webtv-kaltura.md                  # UN Web TV scraping & Kaltura three-ID system
  eval.md                           # Eval system: providers, metrics, corpus, dashboard
  official-transcripts.md           # PV vs SR records by UN organ
  api.md                            # Public JSON API + URL scheme
  TODO.md                           # Backlog notes

eval/                               # Independent eval harness (see docs/eval.md)
  dashboard/                        # Standalone Vite + React dashboard (npm, not pnpm)
```

## Eval System

The `eval/` directory is an independent benchmarking harness for transcription providers. It has its own `tsconfig`, is excluded from the root type-check, and the dashboard uses npm (not pnpm). See [docs/eval.md](docs/eval.md) for full details and [eval/README.md](eval/README.md) for running instructions.
