import { UPSTREAM_USER_AGENT } from "./upstream-identity";
import { randomUUID } from "crypto";
import * as Sentry from "@sentry/nextjs";

const ts = () => new Date().toTimeString().slice(0, 8);
const plog = (...args: unknown[]) => console.log(`[${ts()}]`, ...args);
const perr = (...args: unknown[]) => console.error(`[${ts()}]`, ...args);
import {
  saveTranscript,
  getTranscriptById,
  getActiveTranscriptByKalturaId,
  updateTranscriptionStatus,
  setRowOwnership,
  releaseTranscript,
  claimTranscript,
  withVideoLock,
  type TranscriptionStatus,
  type AnalysisStatus,
  type TranscriptContent,
  type RawParagraph,
} from "./db";
import { currentWorkerId } from "./worker-identity";
import { identifySpeakers } from "./pipeline";
import { notifyTranscriptSubscribersById } from "./notifications/notify";
import type { SpeakerMapping } from "./speakers";
import { trackTranscription, trackTranscriptionError } from "./usage-tracking";
import { bcp47ToKalturaName } from "./languages";
import type { GeminiTranscriptionOptions } from "./gemini-transcription";
import { setSpeakerMapping } from "./speakers";
import {
  KALTURA_PARTNER_ID,
  KALTURA_WIDGET_ID,
  audioFlavorsForLanguage,
  pickReadyAudioFlavor,
} from "./kaltura";
import { isTransientPipelineError } from "./pipeline-errors";
import { getSTTProvider } from "./providers/config";
import { toRawParagraphs } from "./providers/convert";
import { applyTimeOffset } from "./transcript-offset";
import type { GeminiTranscriptionResult } from "./gemini-transcription";

export { type TranscriptionStatus } from "./db";

export interface PollResult {
  stage: TranscriptionStatus;
  analysis_status?: AnalysisStatus;
  raw_paragraphs?: RawParagraph[];
  statements?: TranscriptContent["statements"];
  topics?: TranscriptContent["topics"];
  propositions?: TranscriptContent["propositions"];
  error_message?: string;
}

async function fetchKalturaFlavors(kalturaId: string) {
  const apiResponse = await fetch(
    "https://cdnapisec.kaltura.com/api_v3/service/multirequest",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UPSTREAM_USER_AGENT,
      },
      body: JSON.stringify({
        "1": {
          service: "session",
          action: "startWidgetSession",
          widgetId: KALTURA_WIDGET_ID,
        },
        "2": {
          service: "baseEntry",
          action: "list",
          ks: "{1:result:ks}",
          filter: { redirectFromEntryId: kalturaId },
          responseProfile: { type: 1, fields: "id,duration,objectType" },
        },
        "3": {
          service: "flavorAsset",
          action: "list",
          ks: "{1:result:ks}",
          filter: { entryIdEqual: "{2:result:objects:0:id}" },
        },
        apiVersion: "3.3.0",
        format: 1,
        ks: "",
        clientTag: "html5:v3.17.30",
        partnerId: KALTURA_PARTNER_ID,
      }),
    },
  );

  if (!apiResponse.ok) throw new Error("Failed to query Kaltura API");

  const apiData = await apiResponse.json();
  const entryId = apiData[1]?.objects?.[0]?.id;
  if (!entryId) throw new Error("No entry found");

  const flavors = apiData[2]?.objects || [];
  const isLiveStream =
    apiData[1]?.objects?.[0]?.objectType === "KalturaLiveStreamEntry";

  return { entryId, flavors, isLiveStream };
}

function buildAudioUrl(entryId: string, flavorParamId: number) {
  return `https://cdnapisec.kaltura.com/p/${KALTURA_PARTNER_ID}/sp/0/playManifest/entryId/${entryId}/format/download/protocol/https/flavorParamIds/${flavorParamId}`;
}

export async function getKalturaAudioUrl(
  kalturaId: string,
  language = "english",
) {
  const { entryId, flavors, isLiveStream } =
    await fetchKalturaFlavors(kalturaId);

  const candidates = audioFlavorsForLanguage(flavors, language);
  const readyFlavor = pickReadyAudioFlavor(candidates);

  // Flavors are time-varying: right after the live→VOD flip the entry exists
  // but its audio-only flavors are still converting (status != 2), and a
  // playManifest URL for a non-ready flavor 404s at the provider. Refuse to
  // hand out a doomed URL — the "no flavors" wording is load-bearing: the
  // process-scheduled picker classifies it as audio-not-ready and leaves the
  // row scheduled for the next tick. (Live entries are exempt so the picker
  // still sees `isLiveStream` and skips them on its own.)
  if (!isLiveStream && !readyFlavor) {
    throw new Error(
      `Audio for entry ${entryId} has no flavors ready for language "${language}" (still converting or unavailable)`,
    );
  }
  const flavorParamId =
    readyFlavor?.flavorParamsId ?? candidates[0]?.flavorParamsId;
  // No flavor for the requested language at all (only reachable for live
  // entries — the guard above already threw for VOD). This used to fall back
  // to flavor 100, which is ENGLISH: a wrong-language-audio risk on the
  // submitTranscription path, which uses the URL without checking
  // `isLiveStream`. Throw instead — same load-bearing "no flavors" wording.
  if (flavorParamId === undefined) {
    throw new Error(
      `Audio for entry ${entryId} has no flavors ready for language "${language}" (still converting or unavailable)`,
    );
  }

  return {
    entryId,
    audioUrl: buildAudioUrl(entryId, flavorParamId),
    flavorParamId,
    isLiveStream,
  };
}

export async function getAvailableAudioLanguages(kalturaId: string) {
  const { entryId, flavors } = await fetchKalturaFlavors(kalturaId);

  const audioFlavors = flavors.filter(
    (f: { tags?: string; status?: number }) =>
      f.tags?.includes("audio_only") && f.status === 2,
  );

  const languages = [
    ...new Set(
      audioFlavors
        .map((f: { language?: string }) => f.language?.toLowerCase())
        .filter(Boolean) as string[],
    ),
  ];

  return {
    entryId,
    languages: languages.map((lang) => {
      const flavor = audioFlavors.find(
        (f: { language?: string }) => f.language?.toLowerCase() === lang,
      );
      return {
        language: lang,
        flavorParamId: flavor?.flavorParamsId as number,
        audioUrl: buildAudioUrl(entryId, flavor?.flavorParamsId as number),
      };
    }),
  };
}

export async function pollTranscription(
  transcriptId: string,
): Promise<PollResult> {
  const transcript = await getTranscriptById(transcriptId);
  // Polling is a public serving path. Suppressed rows remain queryable through
  // internal DB helpers for audit/recovery, but their content must not be
  // recoverable by guessing or retaining a transcript ID.
  if (!transcript || transcript.suppressed_at) {
    throw new Error("Transcript not found");
  }

  // Realignment offset (WebTV re-cut the audio after transcription) is applied
  // here at the serving boundary; downstream consumers see aligned timestamps.
  const content = applyTimeOffset(
    transcript.content,
    transcript.time_offset_ms,
  );

  if (transcript.transcription_status === "completed") {
    return {
      stage: "completed",
      analysis_status: transcript.analysis_status,
      raw_paragraphs: content.raw_paragraphs,
      statements: content.statements,
      topics: content.topics,
      propositions: content.propositions,
    };
  }

  if (transcript.transcription_status === "error") {
    return {
      stage: "error",
      analysis_status: transcript.analysis_status,
      error_message: transcript.error_message || "Unknown error",
      raw_paragraphs: content.raw_paragraphs,
      statements: content.statements,
      topics: content.topics,
      propositions: content.propositions,
    };
  }

  // No substantive content detected (LLM assessment). The junk stays in the
  // DB for auditing but must never reach a client — return the bare state.
  // The internal `reason` lives in error_message and is deliberately not
  // exposed.
  if (transcript.transcription_status === "no_content") {
    return {
      stage: "no_content",
      analysis_status: transcript.analysis_status,
      statements: [],
      topics: {},
      propositions: [],
    };
  }

  // In-flight stages (transcribing / identifying_speakers / analyzing_topics)
  // or interrupted: return current state read-only. Recovery of interrupted
  // rows is handled by the boot picker + cron liveness sweep + process-scheduled
  // tick — not by polling side effects. (The previous opportunistic re-entry
  // here meant a user opening the page was what resurrected a dead pipeline;
  // see migration 020 / lib/cron/liveness-sweep.ts.)
  return {
    stage: transcript.transcription_status,
    analysis_status: transcript.analysis_status,
    raw_paragraphs: content.raw_paragraphs,
    statements: content.statements,
    topics: content.topics,
    propositions: content.propositions,
  };
}

// ---- Provider-agnostic transcription pipeline ----

async function runTranscriptionPipeline(
  transcriptId: string,
  entryId: string,
  audioUrl: string,
  options: GeminiTranscriptionOptions,
  languageCode: string,
  kalturaId: string,
): Promise<void> {
  try {
    const provider = getSTTProvider(languageCode);
    await updateTranscriptionStatus(transcriptId, "transcribing");
    plog(
      `[Pipeline] Starting transcription with ${provider.name} for ${transcriptId}`,
    );

    const start = Date.now();
    let transcript;
    try {
      transcript = await provider.transcribe(audioUrl, {
        language: languageCode,
      });
    } catch (err) {
      await trackTranscriptionError({
        transcriptId,
        provider,
        durationMs: Date.now() - start,
        error: err,
        requestMeta: { language: languageCode },
      });
      throw err;
    }
    const durationMs = Date.now() - start;

    const paragraphs: RawParagraph[] = toRawParagraphs(transcript);
    const speakerMapping: SpeakerMapping | undefined = undefined;

    const rawResult = transcript.raw as GeminiTranscriptionResult | undefined;
    await trackTranscription({
      transcriptId,
      provider,
      usage: transcript.usage,
      durationMs,
      requestMeta: {
        // Gemini-only fields are harmless on other providers (undefined).
        chunked: rawResult?.chunked,
        chunkCount: rawResult?.chunkCount,
        withThinking: options.withThinking ?? false,
        paragraph_count: paragraphs.length,
      },
    });

    plog(
      `[Pipeline] Transcription complete: ${paragraphs.length} segments (${provider.name}, ${durationMs}ms)`,
    );

    // Coverage sanity check, provider-agnostic: a transcript whose last
    // paragraph ends far short of the audio length usually means truncated
    // provider output — e.g. Gemini exhausting its output-token budget on
    // audio that skipped chunking can return parseable JSON that silently
    // covers only half the meeting. Warn (console + Sentry) rather than
    // fail: a meeting that adjourns early while the recording keeps rolling
    // is legitimate, so a hard error here would destroy valid transcripts.
    const lastEndMs = paragraphs.length
      ? paragraphs[paragraphs.length - 1].end
      : 0;
    if (
      transcript.durationMs != null &&
      transcript.durationMs > 0 &&
      lastEndMs < transcript.durationMs * 0.85 &&
      transcript.durationMs - lastEndMs > 10 * 60 * 1000
    ) {
      const coverageMsg =
        `[Pipeline] Transcript ${transcriptId} may be truncated: last paragraph ` +
        `ends at ${Math.round(lastEndMs / 60_000)} min of ${Math.round(
          transcript.durationMs / 60_000,
        )} min audio (${Math.round((100 * lastEndMs) / transcript.durationMs)}% ` +
        `coverage, ${provider.name})`;
      perr(coverageMsg);
      Sentry.captureMessage(coverageMsg, "warning");
    }

    const content: TranscriptContent = {
      raw_paragraphs: paragraphs,
      statements: [],
      topics: {},
    };
    await saveTranscript(
      entryId,
      transcriptId,
      null,
      null,
      audioUrl,
      "identifying_speakers",
      languageCode,
      content,
      kalturaId,
      // Audio length we just transcribed — frozen baseline for re-cut detection.
      transcript.durationMs != null ? Math.round(transcript.durationMs) : null,
    );
    if (speakerMapping) {
      await setSpeakerMapping(transcriptId, speakerMapping);
    }

    // Continue into analysis on the same worker — we already own the row
    // (worker_id was set at insert / picker claim time and saveTranscript
    // above doesn't touch worker_id). The status CAS in claimTranscript
    // ensures we hand off cleanly even if a concurrent stale claim somehow
    // raced us (shouldn't happen in the new design, but cheap to keep).
    runAnalysisPipeline(transcriptId, paragraphs, speakerMapping).catch(
      (err) => {
        // runAnalysisPipeline's own catch has already released the row
        // (error or interrupted) — releasing again here would overwrite an
        // `interrupted` (retryable) status with a terminal `error`.
        perr("[Pipeline] Analysis error:", err);
      },
    );
  } catch (err) {
    perr("[Pipeline] Error:", err);
    if (!isTransientPipelineError(err)) {
      Sentry.captureException(err, {
        tags: { pipeline: "transcription", transcript_id: transcriptId },
      });
    }
    await releaseTranscript(
      transcriptId,
      isTransientPipelineError(err) ? "interrupted" : "error",
      err instanceof Error ? err.message : "Transcription failed",
    );
    throw err;
  }
}

async function runAnalysisPipeline(
  transcriptId: string,
  paragraphs: RawParagraph[],
  speakerMapping?: SpeakerMapping,
): Promise<void> {
  try {
    await updateTranscriptionStatus(transcriptId, "identifying_speakers");
    await identifySpeakers(paragraphs, transcriptId, speakerMapping);
    await releaseTranscript(transcriptId, "completed");
  } catch (err) {
    if (!isTransientPipelineError(err)) {
      Sentry.captureException(err, {
        tags: { pipeline: "analysis", transcript_id: transcriptId },
      });
    }
    await releaseTranscript(
      transcriptId,
      isTransientPipelineError(err) ? "interrupted" : "error",
      err instanceof Error ? err.message : "Analysis pipeline failed",
    );
    throw err;
  }

  // Fast-path notification: the transcript is durably `completed`. Notify
  // subscribers now instead of waiting up to 5 min for the cron. Placed
  // OUTSIDE the try/catch and awaited (not detached) so it runs to completion
  // within this background pipeline's lifetime; the helper never throws, so it
  // cannot flip the just-completed row to `error`. The cron remains the
  // backstop and the ledger dedups the two triggers.
  await notifyTranscriptSubscribersById(transcriptId);
}

export type SpeakerIdentificationResult =
  | {
      ok: true;
      mapping: SpeakerMapping;
      statements: TranscriptContent["statements"];
      topics: TranscriptContent["topics"];
    }
  | {
      ok: false;
      code: "not_found" | "missing_data" | "claim_failed";
      message: string;
    };

/**
 * Run speaker identification + the analysis pipeline for an existing
 * transcript, in-process. Used by:
 *   - the picker resuming an `interrupted` row that already has raw paragraphs
 *   - the `pnpm reidentify` script
 *
 * Atomically claims the row (status CAS to `identifying_speakers` + sets
 * `worker_id` + refreshes heartbeat). Returns `claim_failed` if another
 * worker concurrently grabbed it — caller treats that as "not my row,
 * skip" rather than as an error.
 */
export async function runSpeakerIdentification(
  transcriptId: string,
): Promise<SpeakerIdentificationResult> {
  const transcript = await getTranscriptById(transcriptId);
  if (!transcript) {
    return { ok: false, code: "not_found", message: "Transcript not found" };
  }

  const paragraphs = transcript.content.raw_paragraphs;
  if (!paragraphs || paragraphs.length === 0) {
    return {
      ok: false,
      code: "missing_data",
      message: "No raw paragraphs available",
    };
  }

  // Claim from any state that has raw_paragraphs and is safe to resume:
  // `interrupted` (picker resume), `identifying_speakers`/`analyzing_topics`
  // (mid-stage recovery via reidentify), or `completed` (force re-run via
  // reidentify script).
  const claimed = await claimTranscript(
    transcriptId,
    ["interrupted", "identifying_speakers", "analyzing_topics", "completed"],
    "identifying_speakers",
    currentWorkerId(),
  );
  if (!claimed) {
    return {
      ok: false,
      code: "claim_failed",
      message: "Pipeline already running or row in unexpected state",
    };
  }

  try {
    const mapping = await identifySpeakers(paragraphs, transcriptId, undefined);
    await releaseTranscript(transcriptId, "completed");

    // Fast-path notification for resumed/reidentified rows (see runAnalysisPipeline).
    // Never throws; the ledger dedups against the cron and against prior runs
    // (so a `reidentify` re-run won't re-email already-notified subscribers).
    await notifyTranscriptSubscribersById(transcriptId);

    const updated = await getTranscriptById(transcriptId);
    return {
      ok: true,
      mapping,
      statements: updated?.content.statements || [],
      topics: updated?.content.topics || {},
    };
  } catch (error) {
    if (!isTransientPipelineError(error)) {
      Sentry.captureException(error, {
        tags: {
          pipeline: "speaker_identification",
          transcript_id: transcriptId,
        },
      });
    }
    await releaseTranscript(
      transcriptId,
      isTransientPipelineError(error) ? "interrupted" : "error",
      error instanceof Error ? error.message : "Pipeline failed",
    );
    throw error;
  }
}

/**
 * Submit a Gemini transcription job and return immediately.
 * The transcription + analysis runs in the background; clients poll via pollTranscription().
 */
export async function submitTranscription(
  kalturaId: string,
  options: GeminiTranscriptionOptions & {
    force?: boolean;
    existingTranscriptId?: string;
    /**
     * How to run the long-lived pipeline relative to the caller. In a
     * serverless request/cron handler this MUST be Next's `after()`, otherwise
     * Vercel may freeze/kill the function once the response is sent and the
     * pipeline dies mid-flight. In a standalone Node script, leave it undefined:
     * the default detaches the promise, which survives because the process
     * stays alive (e.g. while `pollTranscription` awaits).
     */
    schedule?: (work: () => void) => void;
    /**
     * User who initiated this transcript (tracking only; daily limits are
     * counter-based, not ownership-based). null/omitted for script runs.
     */
    createdBy?: string | null;
    /** Explicit user request to replace an existing transcript. */
    isRetranscription?: boolean;
  } = {},
): Promise<{
  entryId: string;
  transcriptId: string;
  stage: TranscriptionStatus;
  started: boolean;
}> {
  const lang = options.language || "en";
  const kalturaLang = bcp47ToKalturaName(lang);
  const { entryId, audioUrl } = await getKalturaAudioUrl(
    kalturaId,
    kalturaLang,
  );

  const provider = getSTTProvider(lang);

  // Serialize the start decision per video+language so two simultaneous
  // requests can't each create a fresh transcript row. Reuse an existing
  // in-progress/completed transcript instead of starting a duplicate — unless
  // forcing, or resuming a specific (scheduled) row by id.
  const result = await withVideoLock(kalturaId, lang, async (client) => {
    if (!options.force && !options.existingTranscriptId) {
      const existing = await getActiveTranscriptByKalturaId(
        kalturaId,
        lang,
        client,
      );
      // A `no_content` row is terminal but re-runnable (WebTV usually trims
      // silence-dominated feeds later) — treat it like "no existing run".
      if (existing && existing.transcription_status !== "no_content") {
        return {
          transcriptId: existing.transcript_id,
          stage: existing.transcription_status,
          started: false,
        };
      }
    }
    const transcriptId =
      options.existingTranscriptId ?? `${provider.name}-${randomUUID()}`;
    await saveTranscript(
      entryId,
      transcriptId,
      null,
      null,
      audioUrl,
      "transcribing",
      lang,
      { statements: [], topics: {} },
      kalturaId,
      null, // source_duration_ms unknown until transcription completes
      client,
      options.createdBy ?? null,
    );
    if (options.isRetranscription && options.createdBy) {
      await client.query(
        "UPDATE webtv.transcripts SET is_retranscription = TRUE WHERE transcript_id = $1",
        [transcriptId],
      );
    }
    // Claim ownership in the same advisory-locked transaction so the row
    // never sits in `transcribing` without a worker_id — closes the window
    // where a SIGTERM right after insert would leave the row invisible to
    // the SIGTERM handler (which only flips its own rows). For picker-resume
    // (existingTranscriptId) the picker has already set worker_id; this
    // call is idempotent (same workerId in-process).
    await setRowOwnership(transcriptId, currentWorkerId(), client);
    return {
      transcriptId,
      stage: "transcribing" as TranscriptionStatus,
      started: true,
    };
  });

  if (result.started) {
    const runPipeline = () => {
      runTranscriptionPipeline(
        result.transcriptId,
        entryId,
        audioUrl,
        options,
        lang,
        kalturaId,
      ).catch((err) => {
        perr("[Pipeline] Unhandled error:", err);
      });
    };
    // In serverless contexts the caller passes `after` so the work is tied to
    // the function's keep-alive window instead of a dangling promise. Scripts
    // omit it and rely on the live process.
    if (options.schedule) options.schedule(runPipeline);
    else runPipeline();
  }

  return {
    entryId,
    transcriptId: result.transcriptId,
    stage: result.stage,
    started: result.started,
  };
}

/**
 * Headless proposition-analysis runner — same work as the POST analysis
 * route, factored out so the picker can resume `analysis_status =
 * 'interrupted'` rows without going through HTTP/auth. Claims the row
 * atomically; on `claim_failed` the caller treats it as "another worker
 * has it" and moves on.
 */
export async function runPropositionAnalysisJob(
  transcriptId: string,
): Promise<{ ok: boolean; code?: string; message?: string }> {
  const { claimAnalysis, releaseAnalysis, updateTranscriptContent } =
    await import("./db");
  const { getSpeakerMapping } = await import("./speakers");
  const { analyzePropositions } = await import("./pipeline");
  const { AzureOpenAI } = await import("openai");

  const transcript = await getTranscriptById(transcriptId);
  if (!transcript) return { ok: false, code: "not_found" };

  const paragraphs = transcript.content.raw_paragraphs;
  if (!paragraphs || paragraphs.length === 0) {
    return { ok: false, code: "missing_data" };
  }

  const speakerMapping = await getSpeakerMapping(transcriptId);
  if (!speakerMapping || Object.keys(speakerMapping).length === 0) {
    return { ok: false, code: "missing_speakers" };
  }

  const claimed = await claimAnalysis(
    transcriptId,
    ["interrupted"],
    "analyzing",
    currentWorkerId(),
    { incrementRetry: true },
  );
  if (!claimed) return { ok: false, code: "claim_failed" };

  try {
    const client = new AzureOpenAI({
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-12-01-preview",
    });
    const propositions = await analyzePropositions(
      paragraphs,
      speakerMapping,
      client,
      transcriptId,
      transcript.language_code ?? undefined,
    );
    await updateTranscriptContent(transcriptId, {
      ...transcript.content,
      propositions,
    });
    await releaseAnalysis(transcriptId, "completed");
    return { ok: true };
  } catch (error) {
    Sentry.captureException(error, {
      tags: { pipeline: "propositions", transcript_id: transcriptId },
    });
    await releaseAnalysis(
      transcriptId,
      "error",
      error instanceof Error ? error.message : "Analysis failed",
    );
    return {
      ok: false,
      code: "analysis_failed",
      message: error instanceof Error ? error.message : "Analysis failed",
    };
  }
}
