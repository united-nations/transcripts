import { Pool } from "pg";
import { readFileSync } from "fs";
import { randomUUID } from "crypto";
import "@/lib/load-env";
import { applyTimeOffset } from "./transcript-offset";
import { REDUCTION_TRIGGER_MS } from "./realignment-constants";
import {
  buildStatementConditions,
  firstMatchIndex,
  parseSearchQuery,
  windowText,
} from "./statement-search";

// Transcript production lifecycle. Proposition analysis is a separate axis
// (`AnalysisStatus`) and intentionally not part of this enum.
// `interrupted` (migration 020) = worker died mid-flight (SIGTERM, OOM,
// crash). Distinct from `error` (intrinsic failure) so the picker can
// safely auto-retry interrupted rows while leaving genuine errors alone.
// `no_content` = transcription ran to completion but the LLM assessment found
// no substantive proceedings (silence-dominated feeds, ambience transcribed
// as words — see eval/analysis/SYNTHESIS.md §13.4). Terminal like `error`,
// but surfaced to viewers as its own state; content stays in the DB and is
// hidden at the serving boundary (lib/off-record.ts). Manual re-transcription
// is allowed (WebTV often trims such feeds later, making a re-run useful).
export type TranscriptionStatus =
  | "scheduled"
  | "transcribing"
  | "identifying_speakers"
  | "analyzing_topics"
  | "completed"
  | "no_content"
  | "error"
  | "interrupted";
// On-demand proposition analysis, independent of transcript viewability.
export type AnalysisStatus =
  "none" | "analyzing" | "completed" | "error" | "interrupted";

// In-flight transcription states. SIGTERM handler / heartbeat sweep flip
// these to `interrupted`; the picker's claim CAS transitions out of them.
export const IN_FLIGHT_TRANSCRIPTION_STATUSES = [
  "transcribing",
  "identifying_speakers",
  "analyzing_topics",
] as const;

// Max times the picker resumes an `interrupted` row before escalating to
// `error`. `error` itself is never auto-retried, regardless of count.
export const MAX_INTERRUPTED_RETRIES = 5;
export type ProcessingUsageProvider =
  | "openai"
  | "gemini"
  | "azure-openai"
  | "azure-speech" // Azure AI Speech (LLM Speech / batch) — a different service
  // and rate card from Azure OpenAI, so it gets its own vendor token.
  | "assemblyai"
  | "alibaba"
  | "speechmatics";
export type ProcessingUsageStatus = "success" | "error";

// Lazily construct the Pool so importing this module during `next build`'s
// page-data collection (when DATABASE_URL isn't injected) doesn't throw.
let _pool: Pool | undefined;
function getPool(): Pool {
  if (_pool) return _pool;
  if (!process.env.DATABASE_URL) {
    throw new Error(`Missing required env var DATABASE_URL`);
  }
  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Verify the server's TLS certificate (chain + hostname) against Node's
    // built-in CA bundle. Azure Database for PostgreSQL presents certs chained to
    // DigiCert roots that ship with Node, so no custom CA file is needed. The
    // previous `rejectUnauthorized: false` encrypted the connection but trusted
    // ANY certificate — i.e. no protection against a man-in-the-middle. Set
    // PG_SSL_CA to a PEM path if a future Azure cert chain isn't in the bundle.
    ssl: process.env.PG_SSL_CA
      ? { ca: readFileSync(process.env.PG_SSL_CA, "utf8") }
      : { rejectUnauthorized: true },
    // Per-instance pool size. We run a small number of long-lived Node
    // processes on Azure (not the Vercel fan-out model), so a pool of 10 fits
    // comfortably under Azure Postgres `max_connections` even with several
    // app instances, and gives Promise.all-style cron stages headroom to run
    // queries in parallel without forcing new connects. Override with
    // PG_POOL_MAX for long-running scripts.
    max: Number(process.env.PG_POOL_MAX) || 10,
    // Keep idle sockets warm for 10 min so cron ticks (5–15 min cadence) and
    // low-traffic pages don't pay the cold-connect cost on every request.
    idleTimeoutMillis: 600_000,
    connectionTimeoutMillis: 5_000,
    // Send TCP keepalives so we detect sockets silently dropped by an
    // intermediate (Azure load balancer / NAT / PgBouncer idle reap) before
    // the next query trips over a dead connection. Without this, the pool
    // happily hands out corpses and surfaces "Connection terminated
    // unexpectedly" to the caller.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  _pool.on("error", (err) => {
    console.error("PostgreSQL pool error:", err);
  });
  return _pool;
}

// Proxy so existing `pool.query(...)` / `pool.connect()` / `pool.on(...)` call
// sites work unchanged — the real Pool is only created on first property access.
const pool = new Proxy({} as Pool, {
  get(_target, prop, receiver) {
    const real = getPool();
    const value = Reflect.get(real, prop, receiver);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

// Convert ?-style placeholders to $N for pg
export function q(
  sql: string,
  args: unknown[] = [],
): { text: string; values: unknown[] } {
  let i = 0;
  return { text: sql.replace(/\?/g, () => `$${++i}`), values: args };
}

// Expose pool for scripts that need raw query access
export { pool };

export interface RawParagraph {
  text: string;
  start: number;
  end: number;
  /** ASR speaker label for the whole paragraph (used when there are no words). */
  speaker?: string;
  /** Real per-word timestamps. Absent for providers that only return segment-level timing. */
  words?: Array<{
    text: string;
    start: number;
    end: number;
    speaker?: string;
  }>;
}

export interface TranscriptContent {
  raw_paragraphs?: RawParagraph[];
  statements: Array<{
    paragraphs: Array<{
      sentences: Array<{
        text: string;
        start: number;
        end: number;
        topic_keys?: string[];
        words?: Array<{
          text: string;
          start: number;
          end: number;
        }>;
      }>;
      start: number;
      end: number;
      words?: Array<{
        text: string;
        start: number;
        end: number;
      }>;
    }>;
    start: number;
    end: number;
    words?: Array<{
      text: string;
      start: number;
      end: number;
    }>;
  }>;
  topics?: Record<string, { key: string; label: string; description: string }>;
  propositions?: Array<{
    key: string;
    title: string;
    statement: string;
    positions: Array<{
      stance: "support" | "oppose" | "conditional" | "neutral";
      stakeholders: string[];
      summary: string;
      evidence: Array<{
        stakeholder: string;
        quote: string;
        statementIndex: number;
      }>;
    }>;
  }>;
}

export interface Transcript {
  entry_id: string;
  kaltura_id: string;
  transcript_id: string;
  start_time: number | null;
  end_time: number | null;
  audio_url: string;
  transcription_status: TranscriptionStatus;
  analysis_status: AnalysisStatus;
  language_code: string | null;
  content: TranscriptContent;
  // Liveness signal refreshed by the owning worker (~60s tick). Stale
  // heartbeats are flipped to `interrupted` by the liveness sweep.
  heartbeat_at: Date | null;
  // Identity of the process currently running this row, or NULL.
  worker_id: string | null;
  // Times the picker has resumed this row after an interruption.
  retry_count: number;
  error_message: string | null;
  /** Soft-hidden from every user-facing read path; content remains in the DB. */
  suppressed_at: Date | null;
  /** Auditable machine-readable reason paired with suppressed_at. */
  suppression_reason: string | null;
  source_duration_ms: number | null;
  time_offset_ms: number | null;
  aligned_duration_ms: number | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * "Flagged" = completed transcript whose audio was shrunk by WebTV after
 * transcription in a way the realignment cron couldn't resolve with a single
 * front-shift (typically content removed mid- or end-of-video). The cron sets
 * `aligned_duration_ms` to the current length and leaves `time_offset_ms` NULL
 * to mark this state — see lib/realignment.ts:328-336.
 *
 * Takes only the columns it reads, so partial row projections (e.g.
 * getStatementsForRefs) can reuse the one predicate instead of re-encoding
 * the rule in SQL.
 */
export function isTranscriptFlagged(
  t: Pick<
    Transcript,
    | "transcription_status"
    | "time_offset_ms"
    | "aligned_duration_ms"
    | "source_duration_ms"
  >,
): boolean {
  return (
    t.transcription_status === "completed" &&
    t.time_offset_ms == null &&
    t.aligned_duration_ms != null &&
    t.source_duration_ms != null &&
    t.aligned_duration_ms < t.source_duration_ms - REDUCTION_TRIGGER_MS
  );
}

export interface ProcessingUsageEventInsert {
  transcript_id: string;
  provider: ProcessingUsageProvider;
  stage: string;
  operation: string;
  status: ProcessingUsageStatus;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  reasoning_tokens?: number | null;
  cached_input_tokens?: number | null;
  total_tokens?: number | null;
  usage_hours?: number | null;
  usage_seconds?: number | null;
  usage_quantity_type?: string | null;
  usage_multiplier?: number | null;
  rate_card_version?: string | null;
  base_rate_per_hour_usd?: number | null;
  feature_rate_per_hour_usd?: number | null;
  pricing_meta?: object | null;
  duration_ms?: number | null;
  request_meta?: object | null;
  error_message?: string | null;
}

export interface ProcessingUsageEvent {
  id: number;
  transcript_id: string;
  provider: ProcessingUsageProvider;
  stage: string;
  operation: string;
  status: ProcessingUsageStatus;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cached_input_tokens: number | null;
  total_tokens: number | null;
  usage_hours: number | null;
  usage_seconds: number | null;
  usage_quantity_type: string | null;
  usage_multiplier: number | null;
  rate_card_version: string | null;
  base_rate_per_hour_usd: number | null;
  feature_rate_per_hour_usd: number | null;
  pricing_meta: object | null;
  duration_ms: number | null;
  request_meta: object | null;
  error_message: string | null;
  created_at: Date;
}

export interface ProcessingUsageSummaryRow {
  provider: ProcessingUsageProvider;
  stage: string;
  events: number;
  success_events: number;
  error_events: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_input_tokens: number;
  total_tokens: number;
  usage_hours: number;
  usage_seconds: number;
  estimated_cost_usd: number;
}

function mapTranscriptRow(row: Record<string, unknown>): Transcript {
  return {
    entry_id: row.entry_id as string,
    kaltura_id: row.kaltura_id as string,
    transcript_id: row.transcript_id as string,
    start_time: row.start_time as number | null,
    end_time: row.end_time as number | null,
    audio_url: row.audio_url as string,
    transcription_status: row.transcription_status as TranscriptionStatus,
    analysis_status: (row.analysis_status as AnalysisStatus) ?? "none",
    language_code: row.language_code as string | null,
    content: row.content as TranscriptContent,
    heartbeat_at: row.heartbeat_at as Date | null,
    worker_id: (row.worker_id as string | null) ?? null,
    retry_count: Number(row.retry_count ?? 0),
    error_message: row.error_message as string | null,
    suppressed_at: (row.suppressed_at as Date | null) ?? null,
    suppression_reason: (row.suppression_reason as string | null) ?? null,
    source_duration_ms: (row.source_duration_ms as number | null) ?? null,
    time_offset_ms: (row.time_offset_ms as number | null) ?? null,
    aligned_duration_ms: (row.aligned_duration_ms as number | null) ?? null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

// Display-facing mapper: applies the realignment offset (WebTV re-cut the audio
// after transcription) so any caller serving a transcript to users gets aligned
// timestamps — the single chokepoint, so new read sites can't silently diverge.
// NEVER use this on reprocessing/realignment paths: those must read the raw
// stored timestamps (via mapTranscriptRow / getTranscriptById), since the offset
// is computed from — and re-saved relative to — the original timeline.
function mapTranscriptRowForDisplay(row: Record<string, unknown>): Transcript {
  const t = mapTranscriptRow(row);
  if (!t.time_offset_ms) return t;
  return { ...t, content: applyTimeOffset(t.content, t.time_offset_ms) };
}

export interface TranscriptLanguageInfo {
  language_code: string | null;
  transcription_status: TranscriptionStatus;
  transcript_id: string;
}

// Transcript languages + status for a video, keyed on `kaltura_id` (the
// URL-stable player ID). Filtering by `entry_id` instead would mean trusting
// that a fresh Kaltura redirect resolution agrees with what was stored on
// the transcript row when it was first created — that has been seen to
// diverge for legacy/edge rows and silently drops valid transcripts. Since
// migration 015 every transcript row has a kaltura_id, so this is reliable.
//
// Returns at most one row per `language_code`: when retries / forced reruns
// leave multiple rows for the same (kaltura_id, language), preserve a
// completed/viewable row until its replacement completes. This matches the
// display getter and prevents an in-progress soft replacement from making an
// available transcript appear unavailable.
export async function getTranscriptLanguagesByKalturaId(
  kalturaId: string,
): Promise<TranscriptLanguageInfo[]> {
  const result = await pool.query(
    q(
      `SELECT DISTINCT ON (language_code)
              language_code, transcription_status, transcript_id
        FROM webtv.transcripts
       WHERE kaltura_id = ?
         AND suppressed_at IS NULL
       ORDER BY language_code,
                (transcription_status = 'completed') DESC,
                 updated_at DESC`,
      [kalturaId],
    ),
  );
  return result.rows.map((row) => ({
    language_code: row.language_code as string | null,
    transcription_status: row.transcription_status as TranscriptionStatus,
    transcript_id: row.transcript_id as string,
  }));
}

export async function getTranscriptById(
  transcriptId: string,
): Promise<Transcript | null> {
  const result = await pool.query(
    q("SELECT * FROM webtv.transcripts WHERE transcript_id = ?", [
      transcriptId,
    ]),
  );
  if (result.rows.length === 0) return null;
  return mapTranscriptRow(result.rows[0]);
}

/**
 * Display-shifted lookup by transcript_id — same realignment offset that
 * `getTranscriptByKalturaId` applies, but keyed on the row id (used by the
 * lazy words endpoint, which already knows the transcript_id from the
 * /check response that preceded it).
 */
export async function getTranscriptByIdForDisplay(
  transcriptId: string,
): Promise<Transcript | null> {
  const result = await pool.query(
    q(
      `SELECT * FROM webtv.transcripts
        WHERE transcript_id = ? AND suppressed_at IS NULL`,
      [transcriptId],
    ),
  );
  if (result.rows.length === 0) return null;
  return mapTranscriptRowForDisplay(result.rows[0]);
}

export async function saveTranscript(
  entryId: string,
  transcriptId: string,
  startTime: number | null,
  endTime: number | null,
  audioUrl: string,
  status: TranscriptionStatus,
  languageCode: string | null,
  content: TranscriptContent,
  // The video's stable player ID (videos.kaltura_id). Required — see migration
  // 015 + CLAUDE.md "Joining transcripts ↔ videos".
  kalturaId: string,
  // Actual audio length we transcribed (ms). Frozen baseline for detecting
  // later WebTV re-cuts (see migration 008). null when unknown.
  sourceDurationMs: number | null = null,
  // Optional executor so this can run inside an advisory-locked transaction
  // (see withVideoLock) on the same connection as the lock.
  executor: Pick<Pool, "query"> = pool,
  // User who initiated this transcript (tracking only; the daily limit is
  // counter-based). null for script-initiated runs (e.g. pnpm retranscribe).
  // On upsert we COALESCE so an existing creator is never overwritten by null.
  createdBy: string | null = null,
): Promise<void> {
  await executor.query(
    q(
      `INSERT INTO webtv.transcripts (entry_id, kaltura_id, transcript_id, start_time, end_time, audio_url, transcription_status, language_code, content, source_duration_ms, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(transcript_id) DO UPDATE SET
         entry_id = EXCLUDED.entry_id,
         kaltura_id = EXCLUDED.kaltura_id,
         audio_url = EXCLUDED.audio_url,
         transcription_status = EXCLUDED.transcription_status,
         language_code = EXCLUDED.language_code,
         content = EXCLUDED.content,
         source_duration_ms = COALESCE(EXCLUDED.source_duration_ms, transcripts.source_duration_ms),
         created_by = COALESCE(transcripts.created_by, EXCLUDED.created_by),
         updated_at = NOW()`,
      [
        entryId,
        kalturaId,
        transcriptId,
        startTime,
        endTime,
        audioUrl,
        status,
        languageCode,
        content,
        sourceDurationMs,
        createdBy,
      ],
    ),
  );
  // A completed upsert (e.g. re-save of a finished transcript) must keep the
  // statement search index in sync. Same executor: inside withVideoLock
  // transactions the row isn't visible to other connections yet.
  if (status === "completed") {
    try {
      await reindexTranscriptStatements(transcriptId, executor);
    } catch (err) {
      console.error(
        `Statement reindex failed for ${transcriptId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export async function updateTranscriptionStatus(
  transcriptId: string,
  status: TranscriptionStatus,
  errorMessage?: string,
): Promise<void> {
  await pool.query(
    q(
      "UPDATE webtv.transcripts SET transcription_status = ?, error_message = ?, updated_at = NOW() WHERE transcript_id = ?",
      [status, errorMessage ?? null, transcriptId],
    ),
  );
  // Completion is the point where content becomes final (and off-record
  // flags settled in the speaker mapping), i.e. indexable; `no_content`
  // clears any rows a previous completed run left behind.
  if (status === "completed" || status === "no_content") {
    await reindexStatementsSafe(transcriptId);
  }
}

// On-demand proposition analysis lives on its own axis so it never moves the
// transcript off 'completed' (which would hide it from other viewers).
export async function updateAnalysisStatus(
  transcriptId: string,
  status: AnalysisStatus,
  errorMessage?: string,
): Promise<void> {
  await pool.query(
    q(
      "UPDATE webtv.transcripts SET analysis_status = ?, error_message = ?, updated_at = NOW() WHERE transcript_id = ?",
      [status, errorMessage ?? null, transcriptId],
    ),
  );
}

export async function updateTranscriptContent(
  transcriptId: string,
  content: TranscriptContent,
): Promise<void> {
  await pool.query(
    q(
      "UPDATE webtv.transcripts SET content = ?, updated_at = NOW() WHERE transcript_id = ?",
      [content, transcriptId],
    ),
  );
  // Keep the statement search index in sync (no-op unless completed).
  await reindexStatementsSafe(transcriptId);
}

// ── Statement search index (migration 026) ───────────────────────────────────

/**
 * Rebuild the search-index rows for one transcript.
 *
 * Rows exist only for COMPLETED transcripts — earlier pipeline stages persist
 * intermediate content, and `no_content` junk must never be searchable. The
 * off-record rule mirrors lib/off-record.ts: statements flagged
 * `is_off_record` in the speaker mapping are skipped, so the index never
 * contains material the serving boundary hides. `statement_idx` keeps the
 * RAW content index (hits deep-link by timestamp, not index, so the
 * serving-side reindexing of visible statements doesn't matter here).
 *
 * Called wherever the indexed inputs can change: transcription completion,
 * content updates, speaker-mapping updates (off-record flags live there),
 * and completed saveTranscript upserts. Delete + insert is idempotent;
 * FK ON DELETE CASCADE cleans up deleted transcripts.
 */
export async function reindexTranscriptStatements(
  transcriptId: string,
  executor: Pick<Pool, "query"> = pool,
): Promise<void> {
  const res = await executor.query(
    q(
      `SELECT t.transcription_status, t.language_code, t.content, sm.mapping
         FROM webtv.transcripts t
         LEFT JOIN webtv.speaker_mappings sm ON sm.transcript_id = t.transcript_id
        WHERE t.transcript_id = ?`,
      [transcriptId],
    ),
  );
  const row = res.rows[0] as
    | {
        transcription_status: TranscriptionStatus;
        language_code: string | null;
        content: TranscriptContent | null;
        mapping: SpeakerMapping | null;
      }
    | undefined;
  if (!row) return;

  const rows: Array<{ idx: number; startMs: number; text: string }> = [];
  if (row.transcription_status === "completed") {
    const mapping = row.mapping ?? {};
    (row.content?.statements ?? []).forEach((stmt, idx) => {
      if (mapping[idx.toString()]?.is_off_record) return;
      const text = (stmt.paragraphs ?? [])
        .flatMap((p) => (p.sentences ?? []).map((s) => s.text))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) return;
      // FIRST SENTENCE start, not stmt.start: the player-page highlight
      // (usePlaybackTracking) anchors a statement at its first sentence, so a
      // deeplink derived from anything earlier would light up the previous
      // statement. Query-side CEIL handles the sub-second remainder.
      const startMs =
        stmt.paragraphs?.[0]?.sentences?.[0]?.start ?? stmt.start ?? 0;
      rows.push({
        idx,
        startMs: Math.max(0, Math.round(startMs)),
        text,
      });
    });
  }

  await executor.query(
    q("DELETE FROM webtv.transcript_statements WHERE transcript_id = ?", [
      transcriptId,
    ]),
  );
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
    await executor.query(
      q(
        `INSERT INTO webtv.transcript_statements
           (transcript_id, statement_idx, language_code, start_ms, text)
         VALUES ${values}`,
        chunk.flatMap((r) => [
          transcriptId,
          r.idx,
          row.language_code ?? "floor",
          r.startMs,
          r.text,
        ]),
      ),
    );
  }
}

// Pipeline-safe wrapper: index maintenance must never fail a status/content
// write — e.g. while migration 026 hasn't been applied yet.
async function reindexStatementsSafe(transcriptId: string): Promise<void> {
  try {
    await reindexTranscriptStatements(transcriptId);
  } catch (err) {
    console.error(
      `Statement reindex failed for ${transcriptId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// Idempotent + race-safe: if a non-error transcript already exists for this
// video (queued, in-progress, or completed), reuse it instead of queuing a
// duplicate. The advisory lock serializes concurrent Schedule clicks.
export async function scheduleTranscript(
  assetId: string,
  kalturaId: string,
  startTime: number | null,
  endTime: number | null,
  languageCode: string = "en",
  // User who queued this transcript (tracking only; see saveTranscript).
  // null for any system-initiated scheduling.
  createdBy: string | null = null,
): Promise<{ transcriptId: string; stage: TranscriptionStatus }> {
  return withVideoLock(kalturaId, null, async (client) => {
    const existing = await getActiveTranscriptByKalturaId(
      kalturaId,
      languageCode,
      client,
    );
    // `no_content` is terminal but deliberately re-runnable: WebTV usually
    // trims silence-dominated feeds (media stakeouts) after publication, so a
    // manual re-run against the trimmed audio is legitimate — don't let the
    // old no-content row block it.
    if (existing && existing.transcription_status !== "no_content") {
      return {
        transcriptId: existing.transcript_id,
        stage: existing.transcription_status,
      };
    }
    // Random UUID (not `${assetId}-${Date.now()}`): asset IDs can contain "/"
    // (multi-segment WebTV asset paths), which breaks the single-segment
    // `/api/transcripts/[id]` poll route. The `scheduled-` prefix is kept; the
    // asset ID is preserved in the `audio_url` column below (`pending:...`) for
    // the process-scheduled cron, so it need not live in the transcript ID.
    const transcriptId = `scheduled-${randomUUID()}`;
    await client.query(
      q(
        `INSERT INTO webtv.transcripts (entry_id, kaltura_id, transcript_id, start_time, end_time, audio_url, transcription_status, language_code, content, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, '{}', ?)
       ON CONFLICT(transcript_id) DO NOTHING`,
        [
          kalturaId,
          kalturaId,
          transcriptId,
          startTime,
          endTime,
          `pending:${assetId}`,
          languageCode,
          createdBy,
        ],
      ),
    );
    return { transcriptId, stage: "scheduled" as TranscriptionStatus };
  });
}

export interface RunnableTranscript {
  transcript_id: string;
  // Canonical pivot for Kaltura lookups and the videos join. Deliberately
  // NOT entry_id: passing entry_id back into submitTranscription would
  // overwrite the row's kaltura_id with a post-redirect entry id and break
  // the videos FK/join (see the three-ID rules in CLAUDE.md).
  kaltura_id: string;
  start_time: number | null;
  end_time: number | null;
  audio_url: string;
  language_code: string | null;
  // Narrowed: the runnable query's WHERE clause only ever matches these two.
  transcription_status: Extract<
    TranscriptionStatus,
    "scheduled" | "interrupted"
  >;
  retry_count: number;
  has_raw_paragraphs: boolean;
  created_at: Date;
  // The video's scheduled start (null for videos without one). Lets the
  // picker skip Kaltura probes for meetings that haven't started and age out
  // bookings whose recording never materialized.
  scheduled_time: Date | null;
  // For `interrupted` rows: the most recent failure reason (claimTranscript
  // clears it on every resume, so it never goes stale). The picker's retry-cap
  // guard folds it into the final "Abandoned after N retries" message —
  // without it the escalation destroys the diagnostic trail.
  error_message: string | null;
}

/**
 * Rows the picker should pick up: freshly `scheduled` (waiting for audio /
 * first attempt) or `interrupted` (a prior worker died mid-flight). Both
 * classes are surfaced uniformly — the picker decides whether to (re)submit
 * transcription from scratch or resume the analysis stage based on
 * `has_raw_paragraphs`. FIFO by `created_at` keeps the oldest backlog
 * draining first.
 *
 * Deliberately does NOT filter on `retry_count` — interrupted rows at or
 * above the cap must still reach the picker loop so its cap guard escalates
 * them to `error`. Filtering them out here would leave them invisible
 * zombies: never retried, never errored, shown as forever-in-progress by
 * the UI (which treats any non-error row as active).
 */
export async function getRunnableTranscripts(): Promise<RunnableTranscript[]> {
  const result = await pool.query(
    `SELECT t.transcript_id, t.kaltura_id, t.start_time, t.end_time, t.audio_url,
            t.language_code, t.transcription_status, t.retry_count,
            jsonb_array_length(COALESCE(t.content->'raw_paragraphs', '[]'::jsonb)) > 0
              AS has_raw_paragraphs,
            t.created_at,
            v.scheduled_time,
            t.error_message
       FROM webtv.transcripts t
       JOIN webtv.videos v ON v.kaltura_id = t.kaltura_id
      WHERE t.transcription_status IN ('scheduled', 'interrupted')
        AND t.suppressed_at IS NULL
        AND v.removed_at IS NULL
      ORDER BY t.created_at ASC`,
  );
  return result.rows.map((row) => ({
    transcript_id: row.transcript_id as string,
    kaltura_id: row.kaltura_id as string,
    start_time: row.start_time as number | null,
    end_time: row.end_time as number | null,
    audio_url: row.audio_url as string,
    language_code: row.language_code as string | null,
    transcription_status:
      row.transcription_status as RunnableTranscript["transcription_status"],
    retry_count: Number(row.retry_count ?? 0),
    has_raw_paragraphs: row.has_raw_paragraphs as boolean,
    created_at: row.created_at as Date,
    scheduled_time: row.scheduled_time as Date | null,
    error_message: row.error_message as string | null,
  }));
}

/**
 * Transcripts whose `analysis_status` was `interrupted` (on-demand
 * proposition analysis killed mid-flight). The picker resumes them on the
 * analysis axis only — the transcript itself remains `completed`.
 */
export interface RunnableAnalysis {
  transcript_id: string;
  retry_count: number;
  // Most recent failure reason — see RunnableTranscript.error_message.
  error_message: string | null;
}

export async function getRunnableAnalyses(): Promise<RunnableAnalysis[]> {
  // No retry_count filter — capped rows must reach the picker's escalation
  // guard (see getRunnableTranscripts).
  const result = await pool.query(
    `SELECT transcript_id, retry_count, error_message
       FROM webtv.transcripts
      WHERE analysis_status = 'interrupted'
        AND suppressed_at IS NULL
      ORDER BY updated_at ASC`,
  );
  return result.rows.map((row) => ({
    transcript_id: row.transcript_id as string,
    retry_count: Number(row.retry_count ?? 0),
    error_message: row.error_message as string | null,
  }));
}

/**
 * Atomic status-CAS claim. Transitions a row from one of `fromStatuses` to
 * `toStatus`, stamping `worker_id` and refreshing `heartbeat_at`. Optionally
 * increments `retry_count` (used when resuming an interrupted row). Returns
 * true if this caller actually claimed the row, false if some other process
 * already moved it (idempotent under double-fire).
 */
export async function claimTranscript(
  transcriptId: string,
  fromStatuses: readonly TranscriptionStatus[],
  toStatus: TranscriptionStatus,
  workerId: string,
  options: { incrementRetry?: boolean } = {},
): Promise<boolean> {
  const placeholders = fromStatuses.map(() => "?").join(", ");
  const retryClause = options.incrementRetry
    ? ", retry_count = retry_count + 1"
    : "";
  const result = await pool.query(
    q(
      `UPDATE webtv.transcripts
          SET transcription_status = ?,
              worker_id = ?,
              heartbeat_at = NOW(),
              error_message = NULL,
              updated_at = NOW()
              ${retryClause}
        WHERE transcript_id = ?
          AND transcription_status IN (${placeholders})`,
      [toStatus, workerId, transcriptId, ...fromStatuses],
    ),
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Claim a row on the `analysis_status` axis. Same semantics as
 * `claimTranscript` but for on-demand proposition analysis. Does not touch
 * `transcription_status` (the transcript stays `completed` and viewable).
 */
export async function claimAnalysis(
  transcriptId: string,
  fromStatuses: readonly AnalysisStatus[],
  toStatus: AnalysisStatus,
  workerId: string,
  options: { incrementRetry?: boolean } = {},
): Promise<boolean> {
  const placeholders = fromStatuses.map(() => "?").join(", ");
  const retryClause = options.incrementRetry
    ? ", retry_count = retry_count + 1"
    : "";
  const result = await pool.query(
    q(
      `UPDATE webtv.transcripts
          SET analysis_status = ?,
              worker_id = ?,
              heartbeat_at = NOW(),
              updated_at = NOW()
              ${retryClause}
        WHERE transcript_id = ?
          AND analysis_status IN (${placeholders})`,
      [toStatus, workerId, transcriptId, ...fromStatuses],
    ),
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Release ownership of a row after it has reached a terminal-for-this-worker
 * state (`completed`, `error`, or `interrupted`). Clears `worker_id` and
 * `heartbeat_at` so the liveness sweep / picker treat it correctly. Does not
 * change status — caller updates status in its own transition.
 */
export async function clearWorkerOwnership(
  transcriptId: string,
): Promise<void> {
  await pool.query(
    q(
      "UPDATE webtv.transcripts SET worker_id = NULL, heartbeat_at = NULL WHERE transcript_id = ?",
      [transcriptId],
    ),
  );
}

/**
 * Mark a row as owned by this worker (sets `worker_id` and refreshes
 * `heartbeat_at`) without conditioning on status. Used right after
 * `saveTranscript` inserts a new row, inside the same advisory-locked
 * transaction, so the row never sits in an in-flight status without an
 * owner. For status-conditional claims (e.g. `scheduled` → `transcribing`),
 * use `claimTranscript` instead.
 */
export async function setRowOwnership(
  transcriptId: string,
  workerId: string,
  executor: Pick<Pool, "query"> = pool,
): Promise<void> {
  await executor.query(
    q(
      "UPDATE webtv.transcripts SET worker_id = ?, heartbeat_at = NOW() WHERE transcript_id = ?",
      [workerId, transcriptId],
    ),
  );
}

/**
 * Set a not-owned-by-any-worker `transcription_status` (completed | error |
 * interrupted | scheduled) AND clear worker ownership in a single statement.
 * Used at every pipeline exit so we never leave a row marked terminal with a
 * stale `worker_id`. `scheduled` is the give-back path: the picker claimed a
 * row but failed to start the pipeline, and returns it to the queue.
 */
export async function releaseTranscript(
  transcriptId: string,
  status: Extract<
    TranscriptionStatus,
    "completed" | "error" | "interrupted" | "scheduled"
  >,
  errorMessage?: string,
): Promise<void> {
  await pool.query(
    q(
      `UPDATE webtv.transcripts
          SET transcription_status = ?,
              error_message = ?,
              worker_id = NULL,
              heartbeat_at = NULL,
              updated_at = NOW()
        WHERE transcript_id = ?`,
      [status, errorMessage ?? null, transcriptId],
    ),
  );
}

/** Analogue of `releaseTranscript` for the proposition-analysis axis. */
export async function releaseAnalysis(
  transcriptId: string,
  status: Extract<AnalysisStatus, "completed" | "error" | "interrupted">,
  errorMessage?: string,
): Promise<void> {
  await pool.query(
    q(
      `UPDATE webtv.transcripts
          SET analysis_status = ?,
              error_message = ?,
              worker_id = NULL,
              heartbeat_at = NULL,
              updated_at = NOW()
        WHERE transcript_id = ?`,
      [status, errorMessage ?? null, transcriptId],
    ),
  );
}

/**
 * Refresh the heartbeat on a single row. Long-running stages call this
 * mid-stage (e.g. inside the resegmentation loop) so the liveness sweep
 * doesn't treat a slow-but-alive job as dead. No-op if the row no longer
 * has a worker (e.g. status was already flipped to terminal).
 */
export async function touchHeartbeat(transcriptId: string): Promise<void> {
  await pool.query(
    q(
      "UPDATE webtv.transcripts SET heartbeat_at = NOW() WHERE transcript_id = ? AND worker_id IS NOT NULL",
      [transcriptId],
    ),
  );
}

/**
 * Refresh the heartbeat for every row this worker currently owns. Called by
 * the per-process tick (~60s). Single statement, single round-trip — uses
 * the partial index on `worker_id` so the scan is cheap even as the table
 * grows. Returns the number of rows refreshed (0 if this worker holds none).
 */
export async function heartbeatOwnRows(workerId: string): Promise<number> {
  const result = await pool.query(
    q(
      `UPDATE webtv.transcripts
          SET heartbeat_at = NOW()
        WHERE worker_id = ?
          AND (
            transcription_status IN ('transcribing','identifying_speakers','analyzing_topics')
            OR analysis_status = 'analyzing'
          )`,
      [workerId],
    ),
  );
  return result.rowCount ?? 0;
}

/**
 * SIGTERM-time cleanup. Flips every in-flight row owned by this worker to
 * `interrupted` on whichever status axis is active, then clears ownership.
 * Single statement per axis — must complete fast so the orchestrator's
 * shutdown grace period (Azure default 30s) doesn't expire mid-update.
 * Returns the count flipped per axis for logging.
 */
export async function markOwnRowsInterrupted(
  workerId: string,
): Promise<{ transcription: number; analysis: number }> {
  const transcription = await pool.query(
    q(
      `UPDATE webtv.transcripts
          SET transcription_status = 'interrupted',
              worker_id = NULL,
              heartbeat_at = NULL,
              error_message = COALESCE(NULLIF(error_message, ''),
                'Interrupted (worker SIGTERM)'),
              updated_at = NOW()
        WHERE worker_id = ?
          AND transcription_status IN ('transcribing','identifying_speakers','analyzing_topics')`,
      [workerId],
    ),
  );
  const analysis = await pool.query(
    q(
      `UPDATE webtv.transcripts
          SET analysis_status = 'interrupted',
              worker_id = NULL,
              heartbeat_at = NULL,
              error_message = COALESCE(NULLIF(error_message, ''),
                'Analysis interrupted (worker SIGTERM)'),
              updated_at = NOW()
        WHERE worker_id = ?
          AND analysis_status = 'analyzing'`,
      [workerId],
    ),
  );
  return {
    transcription: transcription.rowCount ?? 0,
    analysis: analysis.rowCount ?? 0,
  };
}

/** Run `fn` inside a single BEGIN/COMMIT on one pooled client. */
export async function withTransaction<T>(
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Advisory-lock namespaces. The 2-arg pg_advisory_*_lock form takes a
// (classid, objid) pair, partitioning the global lock keyspace by classid so
// `withVideoLock` and `withJobLock` can't collide on hashtext values that
// happen to coincide.
const LOCK_NS_VIDEO = 1;
const LOCK_NS_JOB = 2;
// Serializes pv_part assignment within a pv_symbol cluster during saveVideo
// so concurrent syncs of sibling rows can't double-claim the same ordinal.
const LOCK_NS_PV_SYMBOL = 3;

// Serialize the "start transcription / schedule" critical section for one
// video+language so two simultaneous clicks can't create duplicate rows.
// The advisory lock is held only for `fn`'s transaction; `fn` runs on the
// lock's own connection (passed in) so it never needs a second pool
// connection — avoiding deadlock under the small serverless pool.
export async function withVideoLock<T>(
  kalturaId: string,
  language: string | null,
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const key = `${kalturaId}:${language ?? ""}`;
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2)::int)", [
      LOCK_NS_VIDEO,
      key,
    ]);
    return fn(client);
  });
}

/**
 * Serialize a named cron job across replicas using a TRANSACTION-scoped
 * advisory lock held open for the duration of `fn`. Returns `fn`'s result on
 * success, or `null` if another replica already holds the lock (caller
 * should treat that as "skipped, not an error").
 *
 * MUST be xact-scoped, not session-scoped, because the app connects through
 * PgBouncer in transaction-pooling mode (port 6432): outside an explicit
 * transaction, consecutive statements on one client can be routed to
 * DIFFERENT server connections. A session-scoped pg_try_advisory_lock would
 * bind the lock to whichever server connection happened to execute it, the
 * later pg_advisory_unlock would land on a different one (failing with only
 * a WARNING), and the lock would leak until PgBouncer recycled the original
 * connection — permanently blocking the job for every replica. (This
 * happened in production; see the 020 job-system rework.)
 *
 * The explicit BEGIN pins the client to one server connection until COMMIT,
 * and the xact lock auto-releases on COMMIT/ROLLBACK/disconnect — so a
 * crashed job can never leak its lock. The connection sits
 * "idle in transaction" while `fn` runs (`fn`'s own queries use the pool,
 * not this client); job ticks are seconds-to-minutes, which is acceptable.
 */
export async function withJobLock<T>(
  jobName: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1, hashtext($2)::int) AS locked",
      [LOCK_NS_JOB, jobName],
    );
    if (!rows[0]?.locked) {
      await client.query("ROLLBACK");
      return null;
    }
    try {
      const result = await fn();
      await client.query("COMMIT"); // releases the xact lock
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  } finally {
    client.release();
  }
}

// FK ON DELETE CASCADE (migration 014) handles `speaker_mappings`,
// `processing_usage_events`, and `sent_transcript_notifications` — a single
// DELETE on `transcripts` is atomic on its own, no transaction wrapper needed.

// Destructive maintenance helper (currently no callers). Normal and forced
// retranscription preserve old rows and their notification history. Keyed on
// kaltura_id so deletion cannot miss rows after Kaltura redirect changes.
export async function deleteTranscriptsForKalturaId(
  kalturaId: string,
  languageCode?: string,
): Promise<void> {
  const langFilter = languageCode ? " AND language_code = ?" : "";
  const args = languageCode ? [kalturaId, languageCode] : [kalturaId];
  const { text, values } = q(
    `DELETE FROM webtv.transcripts WHERE kaltura_id = ?${langFilter}`,
    args,
  );
  await pool.query(text, values);
}

export async function insertProcessingUsageEvent(
  event: ProcessingUsageEventInsert,
): Promise<void> {
  await pool.query(
    q(
      `INSERT INTO webtv.processing_usage_events (
         transcript_id, provider, stage, operation, status, model,
         input_tokens, output_tokens, reasoning_tokens, cached_input_tokens, total_tokens,
         usage_hours, usage_seconds, usage_quantity_type, usage_multiplier,
         rate_card_version, base_rate_per_hour_usd, feature_rate_per_hour_usd, pricing_meta,
         duration_ms, request_meta, error_message
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.transcript_id,
        event.provider,
        event.stage,
        event.operation,
        event.status,
        event.model ?? null,
        event.input_tokens ?? null,
        event.output_tokens ?? null,
        event.reasoning_tokens ?? null,
        event.cached_input_tokens ?? null,
        event.total_tokens ?? null,
        event.usage_hours ?? null,
        event.usage_seconds ?? null,
        event.usage_quantity_type ?? null,
        event.usage_multiplier ?? null,
        event.rate_card_version ?? null,
        event.base_rate_per_hour_usd ?? null,
        event.feature_rate_per_hour_usd ?? null,
        event.pricing_meta ?? null,
        event.duration_ms ?? null,
        event.request_meta ?? null,
        event.error_message ?? null,
      ],
    ),
  );
}

export async function listProcessingUsageEventsByTranscript(
  transcriptId: string,
): Promise<ProcessingUsageEvent[]> {
  const result = await pool.query(
    q(
      "SELECT * FROM webtv.processing_usage_events WHERE transcript_id = ? ORDER BY created_at ASC, id ASC",
      [transcriptId],
    ),
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    transcript_id: row.transcript_id as string,
    provider: row.provider as ProcessingUsageProvider,
    stage: row.stage as string,
    operation: row.operation as string,
    status: row.status as ProcessingUsageStatus,
    model: (row.model as string) ?? null,
    input_tokens: (row.input_tokens as number) ?? null,
    output_tokens: (row.output_tokens as number) ?? null,
    reasoning_tokens: (row.reasoning_tokens as number) ?? null,
    cached_input_tokens: (row.cached_input_tokens as number) ?? null,
    total_tokens: (row.total_tokens as number) ?? null,
    usage_hours: (row.usage_hours as number) ?? null,
    usage_seconds: (row.usage_seconds as number) ?? null,
    usage_quantity_type: (row.usage_quantity_type as string) ?? null,
    usage_multiplier: (row.usage_multiplier as number) ?? null,
    rate_card_version: (row.rate_card_version as string) ?? null,
    base_rate_per_hour_usd: (row.base_rate_per_hour_usd as number) ?? null,
    feature_rate_per_hour_usd:
      (row.feature_rate_per_hour_usd as number) ?? null,
    pricing_meta: (row.pricing_meta as object) ?? null,
    duration_ms: (row.duration_ms as number) ?? null,
    request_meta: (row.request_meta as object) ?? null,
    error_message: (row.error_message as string) ?? null,
    created_at: row.created_at as Date,
  }));
}

export async function getProcessingUsageSummaryByTranscript(
  transcriptId: string,
): Promise<ProcessingUsageSummaryRow[]> {
  const result = await pool.query(
    q(
      `SELECT
         provider,
         stage,
         COUNT(*) AS events,
         SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_events,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_events,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
         COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(SUM(usage_hours), 0) AS usage_hours,
         COALESCE(SUM(usage_seconds), 0) AS usage_seconds,
         COALESCE(SUM(
           COALESCE((pricing_meta->>'estimated_cost_usd')::float, 0)
         ), 0) AS estimated_cost_usd
       FROM webtv.processing_usage_events
       WHERE transcript_id = ?
       GROUP BY provider, stage
       ORDER BY provider, stage`,
      [transcriptId],
    ),
  );
  return result.rows.map((row) => ({
    provider: row.provider as ProcessingUsageProvider,
    stage: row.stage as string,
    events: Number(row.events),
    success_events: Number(row.success_events),
    error_events: Number(row.error_events),
    input_tokens: Number(row.input_tokens),
    output_tokens: Number(row.output_tokens),
    reasoning_tokens: Number(row.reasoning_tokens),
    cached_input_tokens: Number(row.cached_input_tokens),
    total_tokens: Number(row.total_tokens),
    usage_hours: Number(row.usage_hours),
    usage_seconds: Number(row.usage_seconds),
    estimated_cost_usd: Number(row.estimated_cost_usd),
  }));
}

export async function getTranscriptByKalturaId(
  kalturaId: string,
  languageCode?: string,
  completedOnly = true,
): Promise<Transcript | null> {
  const conditions: string[] = ["kaltura_id = ?", "suppressed_at IS NULL"];
  const args: unknown[] = [kalturaId];
  if (completedOnly) conditions.push("transcription_status = 'completed'");
  if (languageCode) {
    conditions.push("language_code = ?");
    args.push(languageCode);
  }
  const result = await pool.query(
    q(
      `SELECT * FROM webtv.transcripts WHERE ${conditions.join(" AND ")}
       ORDER BY updated_at DESC LIMIT 1`,
      args,
    ),
  );
  if (result.rows.length === 0) return null;
  return mapTranscriptRowForDisplay(result.rows[0]);
}

// Heartbeat staleness threshold. Owning workers tick at ~60s; 5 min is 5×
// that, generous enough to ride out a GC pause or short DB blip without
// false positives, tight enough that a dead worker's rows are recovered
// within one Azure deploy cycle (the deploy redeploys-then-sweeps within
// a few minutes). Hard kills that bypass the SIGTERM handler are the only
// path that gets here in the new design — graceful shutdowns flip rows
// themselves via markOwnRowsInterrupted.
const HEARTBEAT_STALE_THRESHOLD = "5 minutes";

/**
 * Liveness sweep — flips any in-flight row whose heartbeat is stale to
 * `interrupted`, on both status axes. Backstop for hard kills (OOM,
 * SIGKILL after grace-period overrun, network partition before the
 * SIGTERM UPDATE committed). The picker then resumes them.
 *
 * Flips to `interrupted` (not `error`) so the picker auto-retries — these
 * are extrinsic failures, the job itself isn't broken.
 */
export async function sweepStaleHeartbeats(): Promise<{
  transcription: number;
  analysis: number;
}> {
  const transcription = await pool.query(
    `UPDATE webtv.transcripts
        SET transcription_status = 'interrupted',
            worker_id = NULL,
            heartbeat_at = NULL,
            error_message = COALESCE(NULLIF(error_message, ''),
              'Interrupted (heartbeat stale >${HEARTBEAT_STALE_THRESHOLD})'),
            updated_at = NOW()
      WHERE transcription_status IN ('transcribing','identifying_speakers','analyzing_topics')
        AND (heartbeat_at IS NULL OR heartbeat_at < NOW() - INTERVAL '${HEARTBEAT_STALE_THRESHOLD}')`,
  );
  const analysis = await pool.query(
    `UPDATE webtv.transcripts
        SET analysis_status = 'interrupted',
            worker_id = NULL,
            heartbeat_at = NULL,
            error_message = COALESCE(NULLIF(error_message, ''),
              'Analysis interrupted (heartbeat stale >${HEARTBEAT_STALE_THRESHOLD})'),
            updated_at = NOW()
      WHERE analysis_status = 'analyzing'
        AND (heartbeat_at IS NULL OR heartbeat_at < NOW() - INTERVAL '${HEARTBEAT_STALE_THRESHOLD}')`,
  );
  return {
    transcription: transcription.rowCount ?? 0,
    analysis: analysis.rowCount ?? 0,
  };
}

// Latest non-error transcript for a player ID — completed, in-progress,
// scheduled, or interrupted (the picker will resume the latter). Powers the
// viewability path: a transcript is shown whenever its content exists, and
// in-progress/scheduled rows are surfaced to all viewers (with their stage)
// so others don't start a duplicate.
export async function getActiveTranscriptByKalturaId(
  kalturaId: string,
  languageCode?: string,
  executor: Pick<Pool, "query"> = pool,
): Promise<Transcript | null> {
  const conditions: string[] = [
    "kaltura_id = ?",
    "transcription_status <> 'error'",
    "suppressed_at IS NULL",
  ];
  const args: unknown[] = [kalturaId];
  if (languageCode) {
    conditions.push("language_code = ?");
    args.push(languageCode);
  }
  // Prefer a completed row over any in-progress one. When a user triggers a
  // soft-replace retranscribe (the realignment-flagged path), a new in-progress
  // row is inserted alongside the old completed one — viewers should keep
  // seeing the old completed content (with the flagged banner) until the new
  // run finishes and becomes the latest completed row.
  const result = await executor.query(
    q(
      `SELECT * FROM webtv.transcripts WHERE ${conditions.join(" AND ")}
       ORDER BY (transcription_status = 'completed') DESC, updated_at DESC LIMIT 1`,
      args,
    ),
  );
  if (result.rows.length === 0) return null;
  return mapTranscriptRowForDisplay(result.rows[0]);
}

/**
 * Returns the latest non-completed, non-error transcript row for the given
 * video+language — i.e. one currently being (re)transcribed. Used by the
 * retranscribe endpoint to avoid spawning a duplicate run when one is already
 * in flight.
 */
export async function getPendingTranscriptByKalturaId(
  kalturaId: string,
  languageCode: string,
): Promise<Transcript | null> {
  // Returns any row that the picker will keep working on:
  //   - `scheduled` (waiting for audio / first attempt)
  //   - `transcribing | identifying_speakers | analyzing_topics` (in flight)
  //   - `interrupted` (will be auto-resumed by the picker)
  // Excluding terminal states (`completed | error | no_content`) matches
  // "do not spawn a duplicate run."
  const result = await pool.query(
    q(
      `SELECT * FROM webtv.transcripts
        WHERE kaltura_id = ? AND language_code = ?
          AND suppressed_at IS NULL
          AND transcription_status NOT IN ('completed', 'error', 'no_content')
        ORDER BY created_at DESC LIMIT 1`,
      [kalturaId, languageCode],
    ),
  );
  if (result.rows.length === 0) return null;
  return mapTranscriptRowForDisplay(result.rows[0]);
}

export async function getAllTranscriptedEntries(): Promise<string[]> {
  // Returns videos.entry_id values for every video with at least one completed
  // transcript. Joined on the canonical pivot (v.kaltura_id = t.kaltura_id) —
  // see CLAUDE.md "Joining transcripts ↔ videos".
  const result = await pool.query(
    `SELECT DISTINCT v.entry_id
       FROM webtv.videos v
       JOIN webtv.transcripts t ON v.kaltura_id = t.kaltura_id
      WHERE t.transcription_status = 'completed'
        AND t.suppressed_at IS NULL
        AND v.entry_id IS NOT NULL`,
  );
  return result.rows.map((row) => row.entry_id as string);
}

/**
 * Like `getAllTranscriptedEntries` but scoped to a single language. Powers
 * the two-tier T badge: a solid badge when an entry has a completed
 * transcript in the active locale, a muted badge when it only has one in
 * some other language.
 *
 * Pass through the raw locale string (`'ar'`, `'fr'`, etc.) — it matches
 * `transcripts.language_code` directly.
 */
export async function getTranscriptedEntriesByLanguage(
  language: string,
): Promise<string[]> {
  const result = await pool.query(
    q(
      `SELECT DISTINCT v.entry_id
         FROM webtv.videos v
         JOIN webtv.transcripts t ON v.kaltura_id = t.kaltura_id
        WHERE t.transcription_status = 'completed'
          AND t.suppressed_at IS NULL
          AND t.language_code = ?
          AND v.entry_id IS NOT NULL`,
      [language],
    ),
  );
  return result.rows.map((row) => row.entry_id as string);
}

export interface VideoRecord {
  asset_id: string;
  entry_id: string | null;
  kaltura_id: string;
  title: string;
  clean_title: string | null;
  date: string;
  scheduled_time: Date | null;
  duration: number | null;
  url: string;
  body: string | null;
  category: string | null;
  event_code: string | null;
  event_type: string | null;
  session_number: string | null;
  pv_symbol: string | null;
  /**
   * Chronological ordinal within the pv_symbol cluster (1..N); populated iff
   * pv_symbol is. Drives the citation URL — pv_part=1 has no suffix
   * (`/sc/10175`), pv_part>1 is suffixed (`/sc/10175/2`). Frozen per-row
   * after first assignment so URLs stay stable when later siblings arrive.
   */
  pv_part: number | null;
  pv_available: boolean | null;
  pv_checked_at: Date | null;
  removed_at: Date | null;
  last_seen: string;
  created_at: Date;
  updated_at: Date;
  // Per-locale variants of title/clean_title/category (migration 019). English
  // lives in the canonical columns above; this map covers ar/zh/fr/ru/es.
  // Missing entries fall back to English at render time.
  i18n: Record<string, VideoI18n>;
}

export interface VideoI18n {
  title?: string;
  clean_title?: string;
  category?: string;
}

function mapVideoRow(row: Record<string, unknown>): VideoRecord {
  return {
    asset_id: row.asset_id as string,
    entry_id: row.entry_id as string | null,
    kaltura_id: row.kaltura_id as string,
    title: row.title as string,
    clean_title: row.clean_title as string | null,
    date: row.date as string,
    scheduled_time: row.scheduled_time as Date | null,
    duration: row.duration as number | null,
    url: row.url as string,
    body: row.body as string | null,
    category: row.category as string | null,
    event_code: row.event_code as string | null,
    event_type: row.event_type as string | null,
    session_number: row.session_number as string | null,
    pv_symbol: (row.pv_symbol as string | null) ?? null,
    pv_part: (row.pv_part as number | null) ?? null,
    pv_available: (row.pv_available as boolean | null) ?? null,
    pv_checked_at: (row.pv_checked_at as Date | null) ?? null,
    removed_at: (row.removed_at as Date | null) ?? null,
    last_seen: row.last_seen as string,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
    i18n: (row.i18n as Record<string, VideoI18n> | null) ?? {},
  };
}

/**
 * Persist a scraped video. When a `pv_symbol` is set, `pv_part` is computed
 * inline as the next available ordinal in that symbol's cluster (MAX+1) so
 * the (pv_symbol, pv_part) CHECK constraint and partial UNIQUE index are
 * satisfied at statement boundary — Postgres can't defer CHECK constraints.
 *
 * URL stability: an existing row's pv_part is preserved on UPSERT — only
 * rows that don't already have a pv_part get one assigned. So when WebTV
 * adds a new "(Resumed)" sibling later, existing siblings keep their
 * citation URL and the new one takes the next available number.
 *
 * Concurrency: a per-pv_symbol transaction-scoped advisory lock serializes
 * the MAX+1 read-then-write so concurrent saves on sibling rows can't
 * double-assign the same number.
 */
export async function saveVideo(
  video: Omit<
    VideoRecord,
    "created_at" | "updated_at" | "removed_at" | "pv_part"
  >,
): Promise<void> {
  await withTransaction(async (client) => {
    if (video.pv_symbol) {
      await client.query(
        q("SELECT pg_advisory_xact_lock(?, hashtext(?))", [
          LOCK_NS_PV_SYMBOL,
          video.pv_symbol,
        ]),
      );
    }
    await client.query(
      q(
        `INSERT INTO webtv.videos (
             asset_id, entry_id, kaltura_id, title, clean_title, date, scheduled_time,
             duration, url, body, category, event_code, event_type,
             session_number, pv_symbol, pv_part, last_seen, i18n
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             CASE WHEN ?::text IS NULL THEN NULL
                  ELSE COALESCE(
                    (SELECT MAX(sib.pv_part) FROM webtv.videos sib
                      WHERE sib.pv_symbol = ?),
                    0
                  ) + 1
             END,
             ?, ?::jsonb)
           ON CONFLICT(asset_id) DO UPDATE SET
             entry_id = COALESCE(EXCLUDED.entry_id, videos.entry_id),
             kaltura_id = EXCLUDED.kaltura_id,
             title = EXCLUDED.title,
             clean_title = EXCLUDED.clean_title,
             scheduled_time = EXCLUDED.scheduled_time,
             duration = EXCLUDED.duration,
             body = EXCLUDED.body,
             category = EXCLUDED.category,
             event_code = EXCLUDED.event_code,
             event_type = EXCLUDED.event_type,
             session_number = EXCLUDED.session_number,
             pv_symbol = COALESCE(EXCLUDED.pv_symbol, videos.pv_symbol),
             pv_part = CASE
               -- Already assigned — keep it (URL stability).
               WHEN videos.pv_part IS NOT NULL THEN videos.pv_part
               -- Symbol stays NULL → pv_part stays NULL (CHECK iff).
               WHEN COALESCE(EXCLUDED.pv_symbol, videos.pv_symbol) IS NULL THEN NULL
               -- Newly gaining a symbol → take the next ordinal in the cluster.
               -- The inner scan MUST be aliased (sib): an unaliased
               -- FROM webtv.videos shadows the ON CONFLICT target, so a bare
               -- videos.asset_id here would bind to the inner row (making the
               -- self-exclusion asset_id <> asset_id always false, i.e. an
               -- empty set, MAX NULL, pv_part always 1 -- colliding on every
               -- 2nd sibling in a symbol cluster).
               ELSE COALESCE(
                 (SELECT MAX(sib.pv_part) FROM webtv.videos sib
                   WHERE sib.pv_symbol = COALESCE(EXCLUDED.pv_symbol, videos.pv_symbol)
                     AND sib.asset_id <> videos.asset_id),
                 0
               ) + 1
             END,
             last_seen = EXCLUDED.last_seen,
             -- Merge per-locale variants: a later sync that only re-scrapes a
             -- subset of locales must not blank the others. Newer keys win.
             i18n = videos.i18n || EXCLUDED.i18n,
             updated_at = NOW()`,
        [
          video.asset_id,
          video.entry_id,
          video.kaltura_id,
          video.title,
          video.clean_title,
          video.date,
          video.scheduled_time,
          video.duration,
          video.url,
          video.body,
          video.category,
          video.event_code,
          video.event_type,
          video.session_number,
          video.pv_symbol,
          video.pv_symbol, // for the VALUES CASE: NULL guard
          video.pv_symbol, // for the VALUES CASE: cluster MAX lookup
          video.last_seen,
          JSON.stringify(video.i18n ?? {}),
        ],
      ),
    );
  });
}

/**
 * Backfill helper: set both `pv_symbol` and `pv_part` on a row that
 * currently has neither, computing pv_part as MAX+1 within the cluster.
 * Done in a single statement so the CHECK constraint is satisfied at
 * statement boundary. Caller must take the pv_symbol advisory lock first
 * to serialize against concurrent siblings.
 */
export async function assignPvSymbolAndPart(
  client: import("pg").PoolClient,
  assetId: string,
  pvSymbol: string,
): Promise<void> {
  await client.query(
    q("SELECT pg_advisory_xact_lock(?, hashtext(?))", [
      LOCK_NS_PV_SYMBOL,
      pvSymbol,
    ]),
  );
  await client.query(
    q(
      `UPDATE webtv.videos
          SET pv_symbol = ?,
              pv_part = COALESCE(
                (SELECT MAX(pv_part) FROM webtv.videos WHERE pv_symbol = ?),
                0
              ) + 1
        WHERE asset_id = ?`,
      [pvSymbol, pvSymbol, assetId],
    ),
  );
}

export async function getVideoByAssetId(
  assetId: string,
): Promise<VideoRecord | null> {
  const result = await pool.query(
    q("SELECT * FROM webtv.videos WHERE asset_id = ?", [assetId]),
  );
  if (result.rows.length === 0) return null;
  return mapVideoRow(result.rows[0]);
}

/**
 * Look up a video by its citation URL — the pv_symbol it cites and its
 * chronological ordinal within that symbol's cluster.
 *
 * Slugs for SR-emitting organs (GA committees 2–6, HRC, ECOSOC) are
 * ambiguous between PV and SR document symbols, so the parser hands us
 * both candidates; this matches on either.
 */
export async function getVideoByCitation(parsed: {
  pvSymbol: string;
  srSymbol?: string;
  pvPart: number;
}): Promise<VideoRecord | null> {
  const candidates = parsed.srSymbol
    ? [parsed.pvSymbol, parsed.srSymbol]
    : [parsed.pvSymbol];
  const result = await pool.query(
    q(
      "SELECT * FROM webtv.videos WHERE pv_symbol = ANY(?::text[]) AND pv_part = ?",
      [candidates as unknown as string[], parsed.pvPart],
    ),
  );
  if (result.rows.length === 0) return null;
  return mapVideoRow(result.rows[0]);
}

// Listing visibility: a video that's gone upstream (`removed_at` — Kaltura
// entry deleted or WebTV asset unpublished) is hidden, transcript or not.
// If it's no longer on UN Web TV it's no longer on ours. References the
// unaliased `videos` table, matching the listing queries below.
const VISIBLE_VIDEO = `(videos.removed_at IS NULL)`;

/**
 * Per-(meeting, language) entries for the sitemap. We only list pairs where a
 * completed transcript exists in that exact language — meetings without any
 * transcript would be thin pages (player + UN Web TV link), and locale variants
 * without a matching transcript would be near-duplicates that risk being
 * flagged as low-quality. The full archive is in scope (no `daysBack`
 * cutoff): transcribed meetings are permanent indexable content.
 *
 * Filtered to `supportedLocales` so `floor`-track transcripts (multilingual
 * mixed audio, not a public UI locale) don't leak into the sitemap.
 */
export async function getSitemapMeetingLanguages(
  supportedLocales: readonly string[],
): Promise<
  Array<{
    asset_id: string;
    pv_symbol: string | null;
    pv_part: number | null;
    languageCode: string;
    lastModified: Date;
  }>
> {
  const result = await pool.query(
    q(
      `SELECT v.asset_id, v.pv_symbol, v.pv_part, t.language_code,
              GREATEST(v.updated_at, t.updated_at) AS last_modified
         FROM webtv.videos v
         JOIN webtv.transcripts t ON t.kaltura_id = v.kaltura_id
        WHERE t.transcription_status = 'completed'
          AND t.suppressed_at IS NULL
          AND v.removed_at IS NULL
          AND t.language_code = ANY(?::text[])
        ORDER BY v.date DESC`,
      [supportedLocales as unknown as string[]],
    ),
  );
  return result.rows.map((r) => ({
    asset_id: r.asset_id as string,
    pv_symbol: (r.pv_symbol as string | null) ?? null,
    pv_part: (r.pv_part as number | null) ?? null,
    languageCode: r.language_code as string,
    lastModified: r.last_modified as Date,
  }));
}

export async function getRecentVideos(
  daysBack: number = 365,
): Promise<VideoRecord[]> {
  const result = await pool.query(
    q(
      `SELECT * FROM webtv.videos WHERE last_seen >= CURRENT_DATE - ?::int
       AND ${VISIBLE_VIDEO} ORDER BY date DESC, scheduled_time DESC`,
      [daysBack],
    ),
  );
  return result.rows.map(mapVideoRow);
}

/**
 * Which detector owns a removal. Each maps to its own timestamp column
 * (migration 025) so clearing one source never un-hides the other's removal.
 */
export type RemovalSource = "kaltura" | "webtv";

const REMOVAL_COLUMN: Record<RemovalSource, string> = {
  kaltura: "kaltura_deleted_at",
  webtv: "webtv_unpublished_at",
};

/**
 * Rows to reconcile against their upstream status: those with a resolved
 * entry_id seen within `lookbackDays`. Returns both currently-removed and
 * not-yet-removed rows so the reaper can both flag removals and clear false
 * positives. The per-source timestamps let the caller skip no-op updates.
 */
export type RemovalScope = "all" | "today" | "other";

export async function getRemovalCandidates(
  lookbackDays: number,
  scope: RemovalScope = "all",
): Promise<
  Array<{
    asset_id: string;
    entry_id: string;
    kaltura_deleted_at: Date | null;
    webtv_unpublished_at: Date | null;
  }>
> {
  const result = await pool.query(
    q(
      `SELECT asset_id, entry_id, kaltura_deleted_at, webtv_unpublished_at
         FROM webtv.videos
        WHERE entry_id IS NOT NULL
          AND last_seen >= CURRENT_DATE - ?::int
          ${scope === "today" ? "AND date = CURRENT_DATE" : scope === "other" ? "AND date IS DISTINCT FROM CURRENT_DATE" : ""}
        ORDER BY date DESC NULLS LAST`,
      [lookbackDays],
    ),
  );
  return result.rows as Array<{
    asset_id: string;
    entry_id: string;
    kaltura_deleted_at: Date | null;
    webtv_unpublished_at: Date | null;
  }>;
}

/**
 * Soft-disable a video for one removal source. No-op if already flagged for
 * that source. `source` is a fixed enum (not user input) so interpolating its
 * column name is injection-safe.
 */
export async function markVideoRemoved(
  assetId: string,
  source: RemovalSource,
): Promise<void> {
  const col = REMOVAL_COLUMN[source];
  await pool.query(
    q(
      `UPDATE webtv.videos SET ${col} = NOW(), updated_at = NOW()
       WHERE asset_id = ? AND ${col} IS NULL`,
      [assetId],
    ),
  );
}

/**
 * Clear one source's removal flag (upstream came back / false positive).
 * Returns true iff a row was actually un-flagged.
 */
export async function clearVideoRemoved(
  assetId: string,
  source: RemovalSource,
): Promise<boolean> {
  const col = REMOVAL_COLUMN[source];
  const result = await pool.query(
    q(
      `UPDATE webtv.videos SET ${col} = NULL, updated_at = NOW()
       WHERE asset_id = ? AND ${col} IS NOT NULL`,
      [assetId],
    ),
  );
  return (result.rowCount ?? 0) > 0;
}

export async function updateVideoEntryId(
  assetId: string,
  entryId: string,
): Promise<void> {
  await pool.query(
    q(
      "UPDATE webtv.videos SET entry_id = ?, updated_at = NOW() WHERE asset_id = ?",
      [entryId, assetId],
    ),
  );
}

// ── Unified video query (browse + search) ────────────────────────────────────
//
// `queryVideos` is the single entry point for both schedule browsing and
// free-text search. A query (`q`) is just another filter: when set, it adds an
// FTS predicate (with trigram ILIKE fallback for short tokens / FTS errors).
// Ordering is always date-based — there is no rank/relevance mode — so search
// and browse render in the same time-sorted layout. All structural filters
// (date, body, category, docs, locale) apply uniformly whether or not a query
// is present.

export interface SearchSort {
  by: "date" | "title";
  dir: "asc" | "desc";
}

/**
 * Per-locale visibility filter. When `includeOther` is false (the default
 * client state) AND `locale` is non-English, only videos with a harvested
 * `i18n[locale]` entry are returned. English is treated as always-available
 * because every video has English canonical metadata.
 *
 * Callers also receive `totalIncludingOther` so the UI can render a
 * "(N more in other languages)" CTA without a separate request.
 */
export interface LocaleFilter {
  locale: string;
  includeOther: boolean;
}

export interface VideosQueryParams {
  /** Free-text query. When set, adds an FTS predicate (with trigram ILIKE
   *  fallback). Does not change ordering — results are always date-sorted. */
  q?: string;
  daysBack?: number;
  date?: string;
  /** Inclusive lower bound on the meeting date (YYYY-MM-DD). Applied as
   *  `date >= ?::date`. Used by the home page's week-window mode. */
  dateFrom?: string;
  /** Inclusive upper bound on the meeting date (YYYY-MM-DD). Applied as
   *  `date <= ?::date`. Used by the home page's week-window mode. */
  dateTo?: string;
  category?: string;
  status?: "past" | "scheduled";
  docs?: string[];
  /** Explicit sort. When omitted, default is `date DESC` for both browse
   *  and search. */
  sort?: SearchSort;
  page?: number;
  pageSize?: number;
  transcriptedEntryIds?: string[];
  localeFilter?: LocaleFilter;
  /** Full-text search inside transcript statements (the schedule's
   *  "search inside transcripts" checkbox / `?ft=1`). Widens the result set
   *  to meetings whose transcript CONTENT matches `q` (union with title
   *  matches) and attaches per-meeting hit summaries. `language` selects the
   *  transcript track to search — the UI locale. */
  contentSearch?: { language: string };
}

/** One content-search hit inside a meeting's transcript. */
export interface StatementHit {
  /** RAW index into content.statements (ordering key; links use time). */
  statementIdx: number;
  /** Display-time start (realignment offset applied), whole seconds,
   *  rounded UP so a seek always lands inside the statement. */
  startSeconds: number;
  /** Snippet window centered on the first term occurrence (built server-side
   *  over the full statement text — the client only marks terms). */
  text: string;
  /** Text continues before/after the snippet window. */
  leading: boolean;
  trailing: boolean;
  speaker: SpeakerInfo | null;
}

export interface ContentMatchSummary {
  /** Total matching statements in this meeting's transcript. */
  count: number;
  /** First matches in transcript order, capped at CONTENT_HITS_PER_MEETING. */
  hits: StatementHit[];
}

export interface VideosQueryResult {
  records: VideoRecord[];
  /** Count under all active filters, including the per-locale visibility cut. */
  total: number;
  /** Count under all active filters, but ignoring the per-locale cut. Equal
   *  to `total` when the locale filter is a no-op (English, or
   *  `includeOther === true`). */
  totalIncludingOther: number;
  /** Per-meeting transcript hits, keyed by asset_id. Present only when
   *  `contentSearch` was requested (meetings with no content match — pure
   *  title matches — have no entry). */
  contentMatches?: Record<string, ContentMatchSummary>;
  /** Total matching statements across all `total` meetings (content search). */
  statementTotal?: number;
}

/**
 * Returns true when the locale filter actually narrows the result set:
 * a non-English locale AND `includeOther` is false. The locale clause
 * (`(i18n -> ?) IS NOT NULL`) is only added in that case.
 */
function localeFilterActive(f: LocaleFilter | undefined): boolean {
  return !!f && !f.includeOther && f.locale !== "en";
}

// Explicit ORDER BY for a user-chosen sort. The `auto` (no-sort) ordering is
// always date DESC (see the `orderBy` defaults in `queryVideos`).
// `asset_id ASC` tiebreaker keeps OFFSET pagination stable across requests.
function explicitOrderBy(sort: SearchSort): string {
  const dir = sort.dir === "asc" ? "ASC" : "DESC";
  if (sort.by === "title") {
    return `COALESCE(clean_title, title) ${dir}, asset_id ASC`;
  }
  // Within a day, always earliest-first so meetings read chronologically as
  // the day unfolds — independent of the day-level sort direction.
  return `date ${dir}, scheduled_time ASC, asset_id ASC`;
}

// Runs the three-query pattern (data + localized count + optional all-locale
// count) shared by every text/structural combination. The caller has already
// assembled `conditions` (structural + optional text predicate); this helper
// appends the locale clause when active and dispatches the SQL.
async function runVideosQuery(args: {
  conditions: string[];
  conditionArgs: unknown[];
  orderBy: string;
  pageSize: number;
  offset: number;
  localeFilter?: LocaleFilter;
}): Promise<VideosQueryResult> {
  const { conditions, conditionArgs, orderBy, pageSize, offset, localeFilter } =
    args;

  const filterActive = localeFilterActive(localeFilter);
  const whereAll = conditions.join(" AND ");
  // `(i18n -> ?) IS NOT NULL` is the semantic equivalent of the JSONB
  // existence operator `i18n ? ?`, but written so the `q()` helper's
  // `?`-to-`$N` rewrite doesn't try to substitute the operator itself.
  const whereLocalized = filterActive
    ? `${whereAll} AND (i18n -> ?) IS NOT NULL`
    : whereAll;
  const localizedArgs = filterActive
    ? [...conditionArgs, localeFilter!.locale]
    : conditionArgs;

  const dataPromise = pool.query(
    q(
      `SELECT * FROM webtv.videos WHERE ${whereLocalized}
       ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...localizedArgs, pageSize, offset],
    ),
  );
  const countLocalizedPromise = pool.query(
    q(
      `SELECT COUNT(*) AS total FROM webtv.videos WHERE ${whereLocalized}`,
      localizedArgs,
    ),
  );
  // Skip the extra count when the locale filter is a no-op.
  const countAllPromise = filterActive
    ? pool.query(
        q(
          `SELECT COUNT(*) AS total FROM webtv.videos WHERE ${whereAll}`,
          conditionArgs,
        ),
      )
    : null;
  const [data, countLocalized, countAll] = await Promise.all([
    dataPromise,
    countLocalizedPromise,
    countAllPromise,
  ]);

  const total = Number(
    (countLocalized.rows[0] as { total?: string } | undefined)?.total ?? 0,
  );
  const totalIncludingOther = countAll
    ? Number((countAll.rows[0] as { total?: string } | undefined)?.total ?? 0)
    : total;
  return {
    records: data.rows.map(mapVideoRow),
    total,
    totalIncludingOther,
  };
}

export async function queryVideos(
  params: VideosQueryParams,
): Promise<VideosQueryResult> {
  const {
    q: queryText,
    daysBack = 365,
    date,
    dateFrom,
    dateTo,
    category,
    status,
    docs,
    sort,
    page = 1,
    pageSize = 50,
    transcriptedEntryIds,
    localeFilter,
  } = params;

  // Structural WHERE — shared across all text paths (none / FTS / ILIKE).
  const conditions: string[] = [
    "last_seen >= CURRENT_DATE - ?::int",
    VISIBLE_VIDEO,
  ];
  const conditionArgs: unknown[] = [daysBack];

  if (date) {
    conditions.push("date = ?");
    conditionArgs.push(date);
  }

  if (dateFrom) {
    conditions.push("date >= ?::date");
    conditionArgs.push(dateFrom);
  }

  if (dateTo) {
    conditions.push("date <= ?::date");
    conditionArgs.push(dateTo);
  }

  if (category) {
    conditions.push("category = ?");
    conditionArgs.push(category);
  }

  if (status === "past") {
    conditions.push(`(scheduled_time IS NULL OR scheduled_time < NOW())`);
  } else if (status === "scheduled") {
    conditions.push(`(scheduled_time IS NOT NULL AND scheduled_time >= NOW())`);
  }

  if (docs && docs.length > 0) {
    const docConditions: string[] = [];
    if (docs.includes("transcript")) {
      if (transcriptedEntryIds) {
        if (transcriptedEntryIds.length === 0 && docs.length === 1) {
          return { records: [], total: 0, totalIncludingOther: 0 };
        }
        if (transcriptedEntryIds.length > 0) {
          docConditions.push(
            `entry_id IN (${transcriptedEntryIds.map(() => "?").join(", ")})`,
          );
          conditionArgs.push(...transcriptedEntryIds);
        }
      }
    }
    if (docs.includes("pv")) {
      docConditions.push(
        "(pv_available = TRUE AND (pv_symbol IS NULL OR pv_symbol NOT LIKE '%/SR.%'))",
      );
    }
    if (docs.includes("sr")) {
      docConditions.push("(pv_available = TRUE AND pv_symbol LIKE '%/SR.%')");
    }
    if (docConditions.length > 0) {
      conditions.push(`(${docConditions.join(" OR ")})`);
    } else if (
      docs.includes("transcript") &&
      (!transcriptedEntryIds || transcriptedEntryIds.length === 0)
    ) {
      return { records: [], total: 0, totalIncludingOther: 0 };
    }
  }

  const offset = (page - 1) * pageSize;
  const explicit = sort ? explicitOrderBy(sort) : null;

  const trimmedQ = queryText?.trim() ?? "";
  if (trimmedQ && params.contentSearch) {
    // Full-text search inside transcripts: one date-ordered union of
    // title-matched and content-matched meetings, with per-meeting hit
    // summaries. Falls through to the title-only paths when the query
    // parses to nothing searchable.
    const parsed = parseSearchQuery(trimmedQ);
    const stmt = buildStatementConditions(
      parsed,
      params.contentSearch.language,
    );
    if (stmt) {
      return runContentSearchQuery({
        conditions,
        conditionArgs,
        stmtConditions: stmt.conditions,
        stmtArgs: stmt.args,
        language: params.contentSearch.language,
        queryText: trimmedQ,
        orderBy: explicit ?? "date DESC, scheduled_time ASC, asset_id ASC",
        pageSize,
        offset,
        localeFilter,
      });
    }
  }
  if (trimmedQ) {
    const words = trimmedQ.split(/\s+/);
    const allShort = words.every((w) => w.length < 3);

    if (!allShort) {
      // Primary text path: FTS with websearch_to_tsquery (non-adjacent
      // keywords, English stemming). Adds the FTS predicate alongside the
      // structural filters. No ranking — results are date-ordered like the
      // browse feed.
      try {
        const ftsResult = await runVideosQuery({
          conditions: [
            ...conditions,
            "fts_vec @@ websearch_to_tsquery('english', ?)",
          ],
          conditionArgs: [...conditionArgs, trimmedQ],
          orderBy: explicit ?? "date DESC, scheduled_time ASC, asset_id ASC",
          pageSize,
          offset,
          localeFilter,
        });
        // FTS surfaced something (rows OR a non-zero count under the locale
        // filter) → trust it. Empty results fall through to ILIKE — which
        // catches partial words / typos the FTS index has no token for.
        if (ftsResult.records.length > 0 || ftsResult.total > 0) {
          return ftsResult;
        }
      } catch (err) {
        // fts_vec column may be missing in dev — warn so a broken index
        // doesn't silently degrade us to trigram-only.
        console.warn(
          "FTS query failed, falling back to trigram ILIKE:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Fallback: trigram-accelerated ILIKE. Fires for all-short tokens, when
    // FTS throws, or when FTS returned no matches. Applies the same
    // structural filters; ranking isn't available so the default order falls
    // back to date desc.
    const pattern = `%${trimmedQ}%`;
    return runVideosQuery({
      conditions: [...conditions, "(title ILIKE ? OR clean_title ILIKE ?)"],
      conditionArgs: [...conditionArgs, pattern, pattern],
      orderBy: explicit ?? "date DESC, scheduled_time ASC, asset_id ASC",
      pageSize,
      offset,
      localeFilter,
    });
  }

  // No text query — structural filters only.
  return runVideosQuery({
    conditions,
    conditionArgs,
    orderBy: explicit ?? "date DESC, scheduled_time ASC, asset_id ASC",
    pageSize,
    offset,
    localeFilter,
  });
}

/** Inline hits returned per meeting by the content-search feed; the rest are
 *  fetched on demand via getStatementMatches ("show all N matches"). */
export const CONTENT_HITS_PER_MEETING = 3;

/**
 * The `contentSearch` variant of the feed query: meetings matching the query
 * by TITLE or by TRANSCRIPT CONTENT, one row per meeting, date-ordered like
 * the browse feed, each content-matched meeting carrying its match count and
 * first hits.
 *
 * The statement scan runs once over the GIN indexes (not per-video); when a
 * meeting briefly has several completed transcripts for the language
 * (mid-retranscribe), only the newest one counts. The title predicate is a
 * single-stage `FTS OR ILIKE` — the title-only path's prefer-FTS fallback
 * doesn't apply to a union that's date-ordered anyway.
 */
async function runContentSearchQuery(args: {
  conditions: string[];
  conditionArgs: unknown[];
  stmtConditions: string[];
  stmtArgs: unknown[];
  language: string;
  queryText: string;
  orderBy: string;
  pageSize: number;
  offset: number;
  localeFilter?: LocaleFilter;
}): Promise<VideosQueryResult> {
  const {
    conditions,
    conditionArgs,
    stmtConditions,
    stmtArgs,
    language,
    queryText,
    orderBy,
    pageSize,
    offset,
    localeFilter,
  } = args;

  // `speaker` comes from the mapping at the statement's RAW index. Indexed
  // rows are on-record only, but strip the internal flag regardless — it
  // must never appear in a response payload (see lib/off-record.ts).
  const matchCte = `
    stmt_matches AS (
      SELECT t.kaltura_id,
             s.transcript_id,
             s.statement_idx,
             GREATEST(0, s.start_ms + COALESCE(t.time_offset_ms, 0)) AS adj_ms,
             s.text,
             (sm.mapping -> s.statement_idx::text) - 'is_off_record' AS speaker,
             t.created_at
        FROM webtv.transcript_statements s
        JOIN webtv.transcripts t ON t.transcript_id = s.transcript_id
        LEFT JOIN webtv.speaker_mappings sm ON sm.transcript_id = s.transcript_id
       WHERE t.language_code = ?
         AND t.transcription_status = 'completed'
         AND t.suppressed_at IS NULL
         AND ${stmtConditions.join(" AND ")}
    ),
    ranked AS (
      SELECT m.*,
             DENSE_RANK() OVER (
               PARTITION BY kaltura_id ORDER BY created_at DESC, transcript_id
             ) AS transcript_rank,
             ROW_NUMBER() OVER (
               PARTITION BY kaltura_id, transcript_id ORDER BY statement_idx
             ) AS hit_rank
        FROM stmt_matches m
    ),
    agg AS (
      SELECT kaltura_id,
             COUNT(*) AS match_count,
             -- CEIL, not FLOOR: statement starts are fractional seconds, and
             -- the player page highlights the statement containing t — a t
             -- even a fraction BEFORE the start lights up the previous one.
             -- Full text here (server-side only); the snippet window is cut
             -- in mapStatementHits, where the match position is known.
             jsonb_agg(
               jsonb_build_object(
                 'transcriptId', transcript_id,
                 'statementIdx', statement_idx,
                 'startSeconds', CEIL(adj_ms / 1000.0),
                 'text', text,
                 'speaker', speaker
               ) ORDER BY statement_idx
             ) FILTER (WHERE hit_rank <= ${CONTENT_HITS_PER_MEETING}) AS hits
        FROM ranked
       WHERE transcript_rank = 1
       GROUP BY kaltura_id
    )`;
  const cteArgs = [language, ...stmtArgs];

  const titleMatch = `(fts_vec @@ websearch_to_tsquery('english', ?) OR title ILIKE ? OR clean_title ILIKE ?)`;
  const titleArgs = [queryText, `%${queryText}%`, `%${queryText}%`];

  const filterActive = localeFilterActive(localeFilter);
  const structural = conditions.join(" AND ");
  const matchClause = `(${titleMatch} OR agg.match_count IS NOT NULL)`;
  // Arg reading order: CTE → structural → (locale) → title.
  const whereAll = `${structural} AND ${matchClause}`;
  const whereLocalized = filterActive
    ? `${structural} AND (i18n -> ?) IS NOT NULL AND ${matchClause}`
    : whereAll;
  const allArgs = [...cteArgs, ...conditionArgs, ...titleArgs];
  const localizedArgs = filterActive
    ? [...cteArgs, ...conditionArgs, localeFilter!.locale, ...titleArgs]
    : allArgs;

  const fromJoin = `FROM webtv.videos LEFT JOIN agg ON agg.kaltura_id = videos.kaltura_id`;
  const dataPromise = pool.query(
    q(
      `WITH ${matchCte}
       SELECT videos.*, agg.match_count AS content_match_count, agg.hits AS content_hits
       ${fromJoin} WHERE ${whereLocalized}
       ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...localizedArgs, pageSize, offset],
    ),
  );
  const countLocalizedPromise = pool.query(
    q(
      `WITH ${matchCte}
       SELECT COUNT(*) AS total, COALESCE(SUM(agg.match_count), 0) AS stmt_total
       ${fromJoin} WHERE ${whereLocalized}`,
      localizedArgs,
    ),
  );
  const countAllPromise = filterActive
    ? pool.query(
        q(
          `WITH ${matchCte}
           SELECT COUNT(*) AS total ${fromJoin} WHERE ${whereAll}`,
          allArgs,
        ),
      )
    : null;

  const [data, countLocalized, countAll] = await Promise.all([
    dataPromise,
    countLocalizedPromise,
    countAllPromise,
  ]);

  const highlightTerms = parseSearchQuery(queryText).highlightTerms;
  const contentMatches: Record<string, ContentMatchSummary> = {};
  const allRefs: SentenceRef[] = [];
  const records = data.rows.map((row) => {
    const rec = mapVideoRow(row);
    if (row.content_match_count != null) {
      const { hits, refs } = mapStatementHits(row.content_hits, highlightTerms);
      contentMatches[rec.asset_id] = {
        count: Number(row.content_match_count),
        hits,
      };
      allRefs.push(...refs);
    }
    return rec;
  });
  // Refine hit timestamps from statement start to the SENTENCE containing
  // the first match — long statements can run for minutes, and the deeplink
  // should land where the term was actually said.
  await applySentenceStarts(
    Object.values(contentMatches).flatMap((m) => m.hits),
    allRefs,
  );

  const countRow = countLocalized.rows[0] as
    { total?: string; stmt_total?: string } | undefined;
  const total = Number(countRow?.total ?? 0);
  return {
    records,
    total,
    totalIncludingOther: countAll
      ? Number((countAll.rows[0] as { total?: string })?.total ?? 0)
      : total,
    contentMatches,
    statementTotal: Number(countRow?.stmt_total ?? 0),
  };
}

/** Ties a produced StatementHit back to its statement in the content JSONB
 *  plus the first-match char offset in the flattened statement text — the
 *  inputs sentence-level timestamp resolution needs. */
interface SentenceRef {
  hit: StatementHit;
  transcriptId: string;
  statementIdx: number;
  matchIdx: number;
}

function mapStatementHits(
  raw: unknown,
  highlightTerms: string[],
): { hits: StatementHit[]; refs: SentenceRef[] } {
  if (!Array.isArray(raw)) return { hits: [], refs: [] };
  const hits: StatementHit[] = [];
  const refs: SentenceRef[] = [];
  for (const h of raw) {
    const rowHit = h as Record<string, unknown>;
    const fullText = String(rowHit.text ?? "");
    const matchIdx = firstMatchIndex(fullText, highlightTerms);
    const windowed = windowText(fullText, highlightTerms);
    const hit: StatementHit = {
      statementIdx: Number(rowHit.statementIdx),
      startSeconds: Number(rowHit.startSeconds),
      text: windowed.text,
      leading: windowed.leading,
      trailing: windowed.trailing,
      speaker: (rowHit.speaker as SpeakerInfo | null) ?? null,
    };
    hits.push(hit);
    if (matchIdx >= 0 && typeof rowHit.transcriptId === "string") {
      refs.push({
        hit,
        transcriptId: rowHit.transcriptId,
        statementIdx: hit.statementIdx,
        matchIdx,
      });
    }
  }
  return { hits, refs };
}

/**
 * Upgrade hit timestamps from statement start to the start of the SENTENCE
 * containing the first match. One bounded query extracts (text, start) for
 * just the referenced statements' sentences; the flattened text is rebuilt
 * exactly as reindexTranscriptStatements built it, so the match offset maps
 * onto a sentence range. Best-effort: on any mismatch the statement start
 * stays (correct, just coarser). `hits` is accepted only to keep call sites
 * honest about what gets mutated.
 */
async function applySentenceStarts(
  hits: StatementHit[],
  refs: SentenceRef[],
): Promise<void> {
  void hits;
  if (refs.length === 0) return;

  // De-dup extraction per statement; several hits can share one statement.
  const byKey = new Map<string, SentenceRef[]>();
  for (const ref of refs) {
    const key = `${ref.transcriptId}:${ref.statementIdx}`;
    const list = byKey.get(key);
    if (list) list.push(ref);
    else byKey.set(key, [ref]);
  }
  const keys = [...byKey.keys()];
  const tids = keys.map((k) => k.slice(0, k.lastIndexOf(":")));
  const idxs = keys.map((k) => Number(k.slice(k.lastIndexOf(":") + 1)));

  const result = await pool.query(
    `SELECT p.tid AS transcript_id,
            p.idx AS statement_index,
            t.time_offset_ms,
            (
              SELECT jsonb_agg(
                       jsonb_build_object('text', s.sent->>'text',
                                          'start', s.sent->'start')
                       ORDER BY para.ord, s.ord
                     )
                FROM jsonb_array_elements(
                       t.content->'statements'->p.idx->'paragraphs'
                     ) WITH ORDINALITY AS para(par, ord),
                     jsonb_array_elements(para.par->'sentences')
                       WITH ORDINALITY AS s(sent, ord)
            ) AS sentences
       FROM webtv.transcripts t
       JOIN unnest($1::text[], $2::int[]) AS p(tid, idx)
         ON p.tid = t.transcript_id
      WHERE t.suppressed_at IS NULL`,
    [tids, idxs],
  );

  for (const row of result.rows) {
    const sentences = row.sentences as Array<{
      text: string;
      start: number;
    }> | null;
    const targets = byKey.get(`${row.transcript_id}:${row.statement_index}`);
    if (!sentences || !targets) continue;

    // Rebuild the indexed flattening (per-sentence whitespace collapse,
    // empties skipped, single-space joins) with cumulative char ranges.
    const ranges: Array<{ end: number; startMs: number }> = [];
    let cursor = 0;
    for (const sent of sentences) {
      const norm = String(sent.text ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!norm) continue;
      cursor += (ranges.length > 0 ? 1 : 0) + norm.length; // joining space
      ranges.push({ end: cursor, startMs: Number(sent.start) });
    }
    if (ranges.length === 0) continue;

    const offsetMs = Number(row.time_offset_ms ?? 0);
    for (const ref of targets) {
      const range =
        ranges.find((r) => ref.matchIdx < r.end) ?? ranges[ranges.length - 1];
      if (!Number.isFinite(range.startMs)) continue;
      ref.hit.startSeconds = Math.ceil(
        Math.max(0, range.startMs + offsetMs) / 1000,
      );
    }
  }
}

export interface StatementMatchesResult {
  total: number;
  hits: StatementHit[];
}

/**
 * All content-search hits inside one meeting (backs the sub-rows'
 * "show all N matches"), transcript order, paged. Same query semantics as
 * the feed's aggregation: newest completed transcript for the language.
 * Keyed by asset_id — the client-side Video shape doesn't carry kaltura_id.
 */
export async function getStatementMatches(
  assetId: string,
  language: string,
  queryText: string,
  offset = 0,
  limit = 100,
): Promise<StatementMatchesResult> {
  const parsed = parseSearchQuery(queryText);
  const stmt = buildStatementConditions(parsed, language);
  if (!stmt) return { total: 0, hits: [] };

  const result = await pool.query(
    q(
      `SELECT s.transcript_id,
              s.statement_idx,
              CEIL(GREATEST(0, s.start_ms + COALESCE(t.time_offset_ms, 0)) / 1000.0) AS start_s,
              s.text,
              (sm.mapping -> s.statement_idx::text) - 'is_off_record' AS speaker,
              COUNT(*) OVER () AS total
         FROM webtv.transcript_statements s
         JOIN webtv.transcripts t ON t.transcript_id = s.transcript_id
         LEFT JOIN webtv.speaker_mappings sm ON sm.transcript_id = s.transcript_id
        WHERE t.transcript_id = (
                SELECT t2.transcript_id
                  FROM webtv.transcripts t2
                  JOIN webtv.videos v ON v.kaltura_id = t2.kaltura_id
                 WHERE v.asset_id = ? AND t2.language_code = ?
                   AND t2.transcription_status = 'completed'
                   AND t2.suppressed_at IS NULL
                 ORDER BY t2.created_at DESC
                 LIMIT 1
              )
          AND ${stmt.conditions.join(" AND ")}
        ORDER BY s.statement_idx
        LIMIT ? OFFSET ?`,
      [assetId, language, ...stmt.args, limit, offset],
    ),
  );

  const highlightTerms = parsed.highlightTerms;
  const refs: SentenceRef[] = [];
  const hits = result.rows.map((row) => {
    const fullText = String(row.text ?? "");
    const matchIdx = firstMatchIndex(fullText, highlightTerms);
    const windowed = windowText(fullText, highlightTerms);
    const hit: StatementHit = {
      statementIdx: Number(row.statement_idx),
      startSeconds: Number(row.start_s),
      text: windowed.text,
      leading: windowed.leading,
      trailing: windowed.trailing,
      speaker: (row.speaker as SpeakerInfo | null) ?? null,
    };
    if (matchIdx >= 0) {
      refs.push({
        hit,
        transcriptId: String(row.transcript_id),
        statementIdx: hit.statementIdx,
        matchIdx,
      });
    }
    return hit;
  });
  await applySentenceStarts(hits, refs);

  return {
    total: Number(
      (result.rows[0] as { total?: string } | undefined)?.total ?? 0,
    ),
    hits,
  };
}

export async function getAvailableDates(
  daysBack: number = 365,
): Promise<string[]> {
  const result = await pool.query(
    q(
      "SELECT DISTINCT TO_CHAR(date, 'YYYY-MM-DD') AS date FROM webtv.videos WHERE last_seen >= CURRENT_DATE - ?::int AND removed_at IS NULL ORDER BY date DESC",
      [daysBack],
    ),
  );
  return result.rows.map((row) => row.date as string);
}

export async function getFilterOptions(daysBack: number = 365): Promise<{
  categories: string[];
  categoryCounts: Record<string, number>;
}> {
  const categoriesResult = await pool.query(
    q(
      "SELECT category, COUNT(*) as cnt FROM webtv.videos WHERE last_seen >= CURRENT_DATE - ?::int AND removed_at IS NULL AND category IS NOT NULL GROUP BY category ORDER BY category",
      [daysBack],
    ),
  );

  const categoryCounts: Record<string, number> = {};
  for (const row of categoriesResult.rows)
    categoryCounts[row.category as string] = Number(row.cnt);

  return {
    categories: Object.keys(categoryCounts),
    categoryCounts,
  };
}

export async function updatePVAvailability(
  assetId: string,
  available: boolean,
): Promise<void> {
  await pool.query(
    q(
      "UPDATE webtv.videos SET pv_available = ?, pv_checked_at = NOW(), updated_at = NOW() WHERE asset_id = ?",
      [available, assetId],
    ),
  );
}

export async function getVideosNeedingPVCheck(
  maxAgeDays: number = 90,
  recheckAfterDays: number = 7,
): Promise<Array<{ asset_id: string; pv_symbol: string }>> {
  const result = await pool.query(
    q(
      `SELECT asset_id, pv_symbol FROM webtv.videos
       WHERE pv_symbol IS NOT NULL
         AND removed_at IS NULL
         AND date >= CURRENT_DATE - ?::int
         AND (
           pv_checked_at IS NULL
           OR (pv_available = FALSE AND pv_checked_at < NOW() - make_interval(days => ?::int))
         )
       ORDER BY date DESC`,
      [maxAgeDays, recheckAfterDays],
    ),
  );
  return result.rows.map((row) => ({
    asset_id: row.asset_id as string,
    pv_symbol: row.pv_symbol as string,
  }));
}

// ── PV Content CRUD ───────────────────────────────────────────────────────────

export async function getPVContent(
  pvSymbol: string,
  language: string = "en",
): Promise<{ content: object; fetchedAt: Date; parsedAt: Date } | null> {
  const result = await pool.query(
    q(
      "SELECT content, fetched_at, parsed_at FROM webtv.pv_contents WHERE pv_symbol = ? AND language = ?",
      [pvSymbol, language],
    ),
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    content: row.content as object,
    fetchedAt: row.fetched_at as Date,
    parsedAt: row.parsed_at as Date,
  };
}

export async function savePVContent(
  pvSymbol: string,
  language: string,
  content: object,
): Promise<void> {
  await pool.query(
    q(
      `INSERT INTO webtv.pv_contents (pv_symbol, language, content, fetched_at, parsed_at)
       VALUES (?, ?, ?, NOW(), NOW())
       ON CONFLICT (pv_symbol, language)
       DO UPDATE SET content = EXCLUDED.content, parsed_at = NOW()`,
      [pvSymbol, language, content],
    ),
  );
}

// ── Speaker mappings ──────────────────────────────────────────────────────────

export interface SpeakerInfo {
  name: string | null;
  function: string | null;
  affiliation: string | null;
  group: string | null;
  is_off_record?: boolean;
}

export type SpeakerMapping = Record<string, SpeakerInfo>;

export async function getSpeakerMapping(
  transcriptId: string,
): Promise<SpeakerMapping | null> {
  const result = await pool.query(
    q("SELECT mapping FROM webtv.speaker_mappings WHERE transcript_id = ?", [
      transcriptId,
    ]),
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].mapping as SpeakerMapping;
}

export async function setSpeakerMapping(
  transcriptId: string,
  mapping: SpeakerMapping,
): Promise<void> {
  await pool.query(
    q(
      `INSERT INTO webtv.speaker_mappings (transcript_id, mapping)
       VALUES (?, ?)
       ON CONFLICT(transcript_id) DO UPDATE SET
         mapping = EXCLUDED.mapping,
         updated_at = NOW()`,
      [transcriptId, mapping],
    ),
  );
  // Off-record flags live in the mapping, and the statement search index
  // skips flagged statements — a mapping change on a completed transcript
  // (e.g. pnpm reidentify) must therefore reindex. No-op mid-pipeline.
  await reindexStatementsSafe(transcriptId);
}

/** One speaker mapping plus the meeting metadata needed to build links. */
export interface SpeakerMappingWithMeta {
  transcript_id: string;
  mapping: SpeakerMapping;
  entry_id: string;
  language_code: string | null;
  asset_id: string | null;
  pv_symbol: string | null;
  pv_part: number | null;
  title: string | null;
  date: string | null;
}

/**
 * Every speaker mapping joined to its meeting metadata, for the cross-transcript
 * speaker directory. A meeting (`entry_id`) can have several transcripts — extra
 * languages or re-transcription runs — which would otherwise surface the same
 * statement multiple times. `DISTINCT ON (entry_id)` keeps a single
 * representative transcript per meeting (completed → English → newest). The
 * LATERAL picks one `videos` row per entry (most-recently-seen). Returns the
 * small JSONB mappings only — never the heavy `content` blob.
 */
export async function getSpeakerMappingsWithMeta(): Promise<
  SpeakerMappingWithMeta[]
> {
  const result = await pool.query(
    `SELECT DISTINCT ON (t.entry_id)
            sm.transcript_id, sm.mapping,
            t.entry_id, t.language_code,
            v.asset_id, v.pv_symbol, v.pv_part,
            COALESCE(v.clean_title, v.title) AS title, v.date
       FROM webtv.speaker_mappings sm
       JOIN webtv.transcripts t ON t.transcript_id = sm.transcript_id
       LEFT JOIN webtv.videos v ON v.kaltura_id = t.kaltura_id
      WHERE t.transcription_status <> 'error'
        AND t.suppressed_at IS NULL
      ORDER BY t.entry_id,
               (t.transcription_status = 'completed') DESC,
               (t.language_code = 'en') DESC,
               t.updated_at DESC`,
  );
  return result.rows.map((row) => ({
    transcript_id: row.transcript_id as string,
    mapping: row.mapping as SpeakerMapping,
    entry_id: row.entry_id as string,
    language_code: (row.language_code as string | null) ?? null,
    asset_id: (row.asset_id as string | null) ?? null,
    pv_symbol: (row.pv_symbol as string | null) ?? null,
    pv_part: (row.pv_part as number | null) ?? null,
    title: (row.title as string | null) ?? null,
    date: row.date ? String(row.date) : null,
  }));
}

export interface ExtractedStatement {
  start: number | null;
  text: string;
  /**
   * True when the owning transcript is realignment-flagged (see
   * isTranscriptFlagged): WebTV re-cut the audio and no valid offset exists,
   * so `start` is known-wrong. Consumers deriving anything time-anchored from
   * it (video stills, timed playback links) must skip those affordances.
   */
  flagged: boolean;
}

/**
 * Extract only the specific statements we need (by transcript + index),
 * pulling just the start time and concatenated sentence text out of the JSONB
 * server-side. Avoids transferring whole `content` blobs (avg ~550KB each) when
 * a speaker profile only needs a handful of statements per transcript.
 * Keyed by `${transcriptId}:${statementIndex}`.
 */
export async function getStatementsForRefs(
  refs: Array<{ transcriptId: string; statementIndex: number }>,
): Promise<Map<string, ExtractedStatement>> {
  const out = new Map<string, ExtractedStatement>();
  if (refs.length === 0) return out;

  const tids = refs.map((r) => r.transcriptId);
  const idxs = refs.map((r) => r.statementIndex);
  const result = await pool.query(
    `SELECT p.tid AS transcript_id,
            p.idx AS statement_index,
            -- Apply the realignment offset here too (the speaker feed links into
            -- the player by timestamp), keeping this path aligned with the
            -- display getters. COALESCE: most rows have no offset.
            ((t.content->'statements'->p.idx->>'start')::float8
               + COALESCE(t.time_offset_ms, 0)) AS start,
            -- The columns isTranscriptFlagged reads — the flag itself is
            -- computed in TS below so the rule stays defined in one place.
            t.transcription_status,
            t.time_offset_ms,
            t.aligned_duration_ms,
            t.source_duration_ms,
            (
              SELECT string_agg(sent->>'text', ' ')
                FROM jsonb_array_elements(
                       t.content->'statements'->p.idx->'paragraphs'
                     ) AS para,
                     jsonb_array_elements(para->'sentences') AS sent
            ) AS text
       FROM webtv.transcripts t
       JOIN unnest($1::text[], $2::int[]) AS p(tid, idx)
         ON p.tid = t.transcript_id
      WHERE t.suppressed_at IS NULL`,
    [tids, idxs],
  );
  for (const row of result.rows) {
    out.set(`${row.transcript_id}:${row.statement_index}`, {
      start: row.start != null ? Number(row.start) : null,
      text: (row.text as string | null)?.trim() ?? "",
      flagged: isTranscriptFlagged(row),
    });
  }
  return out;
}

// Resolve a video by its stable player ID. kaltura_id is the canonical pivot
// (NOT NULL + UNIQUE; see migration 015), so a single equality is sufficient.
export async function getVideoByKalturaId(
  kalturaId: string,
): Promise<VideoRecord | null> {
  const result = await pool.query(
    q(`SELECT * FROM webtv.videos WHERE kaltura_id = ? LIMIT 1`, [kalturaId]),
  );
  if (result.rows.length === 0) return null;
  return mapVideoRow(result.rows[0]);
}

// Canonical Kaltura entry IDs are intentionally not unique: multiple stable
// player IDs / WebTV assets can redirect to the same underlying media. This is
// only a compatibility resolver; cross-table joins continue to use kaltura_id.
export async function getVideosByEntryId(
  entryId: string,
): Promise<VideoRecord[]> {
  const result = await pool.query(
    q(
      `SELECT * FROM webtv.videos
        WHERE entry_id = ?
        ORDER BY pv_part ASC NULLS LAST, asset_id ASC`,
      [entryId],
    ),
  );
  return result.rows.map(mapVideoRow);
}

/**
 * For each transcript, return statementIndex → durationMs (end − start) for
 * every statement. Used by the speaker directory to drop short statements
 * (where the camera typically hasn't framed the speaker yet) from counts and
 * feeds at the source.
 */
export async function getStatementDurationsForTranscripts(
  transcriptIds: string[],
): Promise<Map<string, Map<number, number>>> {
  const out = new Map<string, Map<number, number>>();
  if (transcriptIds.length === 0) return out;
  const result = await pool.query(
    `SELECT t.transcript_id,
            (s.ord - 1)::int                       AS statement_index,
            (s.stmt->>'end')::float8
              - (s.stmt->>'start')::float8         AS duration_ms
       FROM webtv.transcripts t,
            jsonb_array_elements(t.content->'statements')
              WITH ORDINALITY AS s(stmt, ord)
      WHERE t.transcript_id = ANY($1::text[])
        AND t.suppressed_at IS NULL`,
    [transcriptIds],
  );
  for (const row of result.rows) {
    const tid = row.transcript_id as string;
    let inner = out.get(tid);
    if (!inner) {
      inner = new Map();
      out.set(tid, inner);
    }
    const d = row.duration_ms;
    inner.set(Number(row.statement_index), d == null ? 0 : Number(d));
  }
  return out;
}

// ── Feeds & subscriptions (migration 004) ─────────────────────────────────────

export interface Feed {
  key: string;
  label: string;
  description: string | null;
  enabled: boolean;
  match_categories: string[] | null;
  match_title_ilike: string | null;
  match_event_type: string | null;
}

function mapFeedRow(row: Record<string, unknown>): Feed {
  return {
    key: row.key as string,
    label: row.label as string,
    description: (row.description as string | null) ?? null,
    enabled: row.enabled as boolean,
    match_categories: (row.match_categories as string[] | null) ?? null,
    match_title_ilike: (row.match_title_ilike as string | null) ?? null,
    match_event_type: (row.match_event_type as string | null) ?? null,
  };
}

export async function getAllFeeds(): Promise<Feed[]> {
  const result = await pool.query(
    `SELECT * FROM webtv.feeds ORDER BY label ASC`,
  );
  return result.rows.map(mapFeedRow);
}

export async function getEnabledFeeds(): Promise<Feed[]> {
  const result = await pool.query(
    `SELECT * FROM webtv.feeds WHERE enabled = TRUE ORDER BY label ASC`,
  );
  return result.rows.map(mapFeedRow);
}

export async function addVideoSubscription(
  userId: string,
  kalturaId: string,
  language: string,
): Promise<void> {
  await pool.query(
    q(
      `INSERT INTO webtv.video_subscriptions (user_id, kaltura_id, language)
       VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      [userId, kalturaId, language],
    ),
  );
}

export async function removeVideoSubscription(
  userId: string,
  kalturaId: string,
  language: string,
): Promise<void> {
  await pool.query(
    q(
      `DELETE FROM webtv.video_subscriptions
        WHERE user_id = ? AND kaltura_id = ? AND language = ?`,
      [userId, kalturaId, language],
    ),
  );
}

export async function getVideoSubscription(
  userId: string,
  kalturaId: string,
  language: string,
): Promise<boolean> {
  const result = await pool.query(
    q(
      `SELECT 1 FROM webtv.video_subscriptions
        WHERE user_id = ? AND kaltura_id = ? AND language = ? LIMIT 1`,
      [userId, kalturaId, language],
    ),
  );
  return result.rows.length > 0;
}

export interface UserVideoSubscription {
  kaltura_id: string;
  language: string;
  title: string | null;
  asset_id: string | null;
  pv_symbol: string | null;
  pv_part: number | null;
  created_at: Date;
  /** When the "transcript ready" email was sent to this user, if it has been. */
  emailed_at: Date | null;
}

export async function getUserVideoSubscriptions(
  userId: string,
): Promise<UserVideoSubscription[]> {
  // emailed_at: notification ledger keyed by transcript_id, joined back through
  // transcripts on the canonical kaltura_id pivot.
  const result = await pool.query(
    q(
      `SELECT vs.kaltura_id, vs.language, vs.created_at,
              COALESCE(v.clean_title, v.title) AS title,
              v.asset_id, v.pv_symbol, v.pv_part,
              (SELECT MAX(stn.sent_at)
                 FROM webtv.sent_transcript_notifications stn
                 JOIN webtv.transcripts t ON t.transcript_id = stn.transcript_id
                WHERE stn.user_id = vs.user_id
                  AND t.kaltura_id = vs.kaltura_id
              ) AS emailed_at
         FROM webtv.video_subscriptions vs
         LEFT JOIN webtv.videos v ON v.kaltura_id = vs.kaltura_id
        WHERE vs.user_id = ?
        ORDER BY vs.created_at DESC`,
      [userId],
    ),
  );
  return result.rows.map((row) => ({
    kaltura_id: row.kaltura_id as string,
    language: row.language as string,
    title: (row.title as string | null) ?? null,
    asset_id: (row.asset_id as string | null) ?? null,
    pv_symbol: (row.pv_symbol as string | null) ?? null,
    pv_part: (row.pv_part as number | null) ?? null,
    created_at: row.created_at as Date,
    emailed_at: (row.emailed_at as Date | null) ?? null,
  }));
}

export async function addFeedSubscription(
  userId: string,
  feedKey: string,
  language: string,
): Promise<void> {
  await pool.query(
    q(
      `INSERT INTO webtv.feed_subscriptions (user_id, feed_key, language)
       VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      [userId, feedKey, language],
    ),
  );
}

export async function removeFeedSubscription(
  userId: string,
  feedKey: string,
  language: string,
): Promise<void> {
  await pool.query(
    q(
      `DELETE FROM webtv.feed_subscriptions
        WHERE user_id = ? AND feed_key = ? AND language = ?`,
      [userId, feedKey, language],
    ),
  );
}

export interface UserFeedSubscription {
  feed_key: string;
  language: string;
}

export async function getUserFeedSubscriptions(
  userId: string,
): Promise<UserFeedSubscription[]> {
  const result = await pool.query(
    q(
      `SELECT feed_key, language FROM webtv.feed_subscriptions WHERE user_id = ?`,
      [userId],
    ),
  );
  return result.rows.map((row) => ({
    feed_key: row.feed_key as string,
    language: row.language as string,
  }));
}

// ── Notification engine queries ───────────────────────────────────────────────

export interface CompletedTranscriptRef {
  transcript_id: string;
  kaltura_id: string;
  entry_id: string;
  language_code: string | null;
}

// Recently-completed transcripts with content, candidates for notification.
export async function getRecentlyCompletedTranscripts(
  sinceHours: number,
): Promise<CompletedTranscriptRef[]> {
  const result = await pool.query(
    q(
      `SELECT transcript_id, kaltura_id, entry_id, language_code
         FROM webtv.transcripts
        WHERE transcription_status = 'completed'
          AND suppressed_at IS NULL
          AND updated_at > NOW() - (? || ' hours')::interval
          AND jsonb_exists(content, 'statements')`,
      [String(sinceHours)],
    ),
  );
  return result.rows.map((row) => ({
    transcript_id: row.transcript_id as string,
    kaltura_id: row.kaltura_id as string,
    entry_id: row.entry_id as string,
    language_code: (row.language_code as string | null) ?? null,
  }));
}

export interface Recipient {
  user_id: string;
  email: string;
}

// Users with a per-video subscription matching this player ID AND the
// completing transcript's language. Subscriptions are per-(video, language)
// (see `video_subscriptions` PK); dropping the language filter would email
// Spanish subscribers when the Chinese transcript completes, etc.
export async function getVideoSubscribers(
  kalturaId: string,
  language: string,
): Promise<Recipient[]> {
  const result = await pool.query(
    q(
      `SELECT DISTINCT u.id AS user_id, u.email
         FROM webtv.video_subscriptions vs
         JOIN webtv.users u ON u.id = vs.user_id
        WHERE vs.kaltura_id = ?
          AND vs.language = ?`,
      [kalturaId, language],
    ),
  );
  return result.rows.map((row) => ({
    user_id: row.user_id as string,
    email: row.email as string,
  }));
}

// Users subscribed to any of the given feed keys for the given language.
// Feed subscriptions are per-(feed, language) since migration 018; dropping
// the language filter would email everyone subscribed to e.g. "Security
// Council" each time ANY language of a matching meeting completed.
export async function getFeedSubscribers(
  feedKeys: string[],
  language: string,
): Promise<Recipient[]> {
  if (feedKeys.length === 0) return [];
  const result = await pool.query(
    q(
      `SELECT DISTINCT u.id AS user_id, u.email
         FROM webtv.feed_subscriptions fs
         JOIN webtv.users u ON u.id = fs.user_id
        WHERE fs.feed_key = ANY(?)
          AND fs.language = ?`,
      [feedKeys, language],
    ),
  );
  return result.rows.map((row) => ({
    user_id: row.user_id as string,
    email: row.email as string,
  }));
}

/** The explicit replacement requester is eligible even without a subscription. */
export async function getRetranscriptionRequester(
  transcriptId: string,
): Promise<Recipient | null> {
  const result = await pool.query(
    `SELECT u.id AS user_id, u.email
       FROM webtv.transcripts t JOIN webtv.users u ON u.id = t.created_by
      WHERE t.transcript_id = $1 AND t.is_retranscription`,
    [transcriptId],
  );
  return result.rows[0] ?? null;
}

// Serialize across transcript versions, as well as instant/cron workers. A
// separate statement after acquiring the lock sees the previous holder's commit
// under READ COMMITTED. Historical ledger rows count without any backfill.
// Keep claiming before delivery: delivery failures are reported to Sentry, but
// retain the claim to avoid duplicate mail after ambiguous transport failures.
export async function claimTranscriptNotification(
  userId: string,
  transcriptId: string,
): Promise<boolean> {
  return withTransaction(async (client) => {
    const target = await client.query(
      `SELECT kaltura_id, language_code FROM webtv.transcripts
        WHERE transcript_id = $1`,
      [transcriptId],
    );
    if (!target.rows.length) return false;
    const { kaltura_id, language_code } = target.rows[0];
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2)::int)", [
      4, // Notification namespace (distinct from video/job/PV locks).
      JSON.stringify([userId, kaltura_id, language_code]),
    ]);
    const result = await client.query(
      `INSERT INTO webtv.sent_transcript_notifications (user_id, transcript_id)
       SELECT $1, t.transcript_id FROM webtv.transcripts t
        WHERE t.transcript_id = $2
          AND t.transcription_status = 'completed'
          AND t.suppressed_at IS NULL
          AND (
            (t.is_retranscription AND t.created_by = $1::uuid)
            OR NOT EXISTS (
              SELECT 1 FROM webtv.sent_transcript_notifications n
              JOIN webtv.transcripts prior ON prior.transcript_id = n.transcript_id
              WHERE n.user_id = $1::uuid
                AND prior.kaltura_id = t.kaltura_id
                AND prior.language_code = t.language_code
            )
          )
       ON CONFLICT DO NOTHING RETURNING user_id`,
      [userId, transcriptId],
    );
    return (result.rowCount ?? 0) > 0;
  });
}
