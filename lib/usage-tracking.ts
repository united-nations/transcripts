import { appendFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { AzureOpenAI } from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions/completions";

import { insertProcessingUsageEvent, type ProcessingUsageProvider } from "./db";
import type { GeminiUsageMetadata } from "./gemini-transcription";
import { estimateCostUsd } from "./providers/pricing";
import type { TranscriptionProvider, TranscriptUsage } from "./providers/types";

// Where failed usage-event inserts are spooled for later backfill. Override
// with USAGE_EVENTS_FAILED_PATH; defaults to the OS temp dir (writable on Vercel).
const USAGE_EVENTS_FAILED_PATH =
  process.env.USAGE_EVENTS_FAILED_PATH ||
  join(tmpdir(), "usage-events.failed.jsonl");

export const UsageStages = {
  transcribing: "transcribing",
  identifyingSpeakers: "identifying_speakers",
  resegmenting: "resegmenting",
  analyzingTopics: "analyzing_topics",
  taggingSentences: "tagging_sentences",
  analyzingPropositions: "analyzing_propositions",
  aligningPv: "aligning_pv",
} as const;

// Vendor-neutral stage-action names. The actual vendor/model lives in the
// `provider` and `model` columns of processing_usage_events — keep these
// labels descriptive of what the call does, not who serves it.
export const UsageOperations = {
  initialSpeakerMapping: "initial_speaker_mapping",
  resegmentParagraph: "resegment_paragraph",
  defineTopics: "define_topics",
  tagSentenceTopics: "tag_sentence_topics",
  analyzePropositions: "analyze_propositions",
  transcribe: "transcribe",
  pvAlignment: "pv_alignment",
} as const;

function safeObject(value: unknown): object | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "object") return value as object;
  return null;
}

async function safeInsertUsageEvent(
  event: Parameters<typeof insertProcessingUsageEvent>[0],
): Promise<void> {
  try {
    await insertProcessingUsageEvent(event);
  } catch (error) {
    console.warn(
      "Failed to persist usage event:",
      error instanceof Error ? error.message : error,
    );
    // Spool to a JSONL fallback so usage rows can be backfilled if Postgres
    // was flaking. A spool failure must never break the pipeline either.
    try {
      await appendFile(
        USAGE_EVENTS_FAILED_PATH,
        JSON.stringify({ failedAt: new Date().toISOString(), event }) + "\n",
      );
    } catch (spoolError) {
      console.warn(
        "Failed to spool usage event to fallback file:",
        spoolError instanceof Error ? spoolError.message : spoolError,
      );
    }
  }
}

interface OpenAITrackedCallArgs {
  client: AzureOpenAI;
  transcriptId?: string;
  stage: string;
  operation: string;
  model: string;
  request: ChatCompletionCreateParamsNonStreaming;
  requestMeta?: Record<string, unknown>;
}

export async function trackOpenAIChatCompletion({
  client,
  transcriptId,
  stage,
  operation,
  model,
  request,
  requestMeta,
}: OpenAITrackedCallArgs): Promise<ChatCompletion> {
  const maxRetries = 5;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const start = Date.now();
    try {
      const completion: ChatCompletion =
        await client.chat.completions.create(request);
      const durationMs = Date.now() - start;
      const usage = completion.usage;

      const cachedInput = usage?.prompt_tokens_details?.cached_tokens ?? 0;
      // Azure exposes cache writes before the SDK types include the field.
      const cacheWriteInput =
        (
          usage?.prompt_tokens_details as
            { cache_write_tokens?: number } | undefined
        )?.cache_write_tokens ?? 0;
      // Prompt and completion totals include the separately billed subcounts.
      const promptUncached = Math.max(
        0,
        (usage?.prompt_tokens ?? 0) - cachedInput - cacheWriteInput,
      );
      const reasoningTokens =
        usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      const cost = estimateCostUsd({
        provider: "openai",
        model,
        inputTokens: promptUncached,
        cachedInputTokens: cachedInput,
        cacheWriteInputTokens: cacheWriteInput,
        outputTokens: Math.max(
          0,
          (usage?.completion_tokens ?? 0) - reasoningTokens,
        ),
        reasoningTokens,
      });

      await safeInsertUsageEvent({
        transcript_id: transcriptId ?? "unknown",
        provider: "openai",
        stage,
        operation,
        status: "success",
        model,
        input_tokens: usage?.prompt_tokens ?? null,
        output_tokens: usage?.completion_tokens ?? null,
        reasoning_tokens: reasoningTokens || null,
        cached_input_tokens: cachedInput || null,
        total_tokens: usage?.total_tokens ?? null,
        rate_card_version: cost?.pricing.rateCardVersion ?? null,
        pricing_meta: safeObject({
          cache_write_input_tokens: cacheWriteInput,
          estimated_cost_usd: cost?.costUsd ?? null,
          pricing: cost?.pricing ?? null,
        }),
        duration_ms: durationMs,
        request_meta: safeObject(requestMeta),
      });

      return completion;
    } catch (error) {
      const durationMs = Date.now() - start;
      // Retry on 429 rate limit errors
      const status = (error as { status?: number }).status;
      if (status === 429 && attempt < maxRetries) {
        const retryAfterMs =
          Number(
            (error as { headers?: Headers }).headers?.get("retry-after-ms"),
          ) || 1000 * 2 ** attempt;
        console.warn(
          `  ⏳ Rate limited, retrying in ${retryAfterMs}ms (attempt ${attempt + 1}/${maxRetries})`,
        );
        await new Promise((r) => setTimeout(r, retryAfterMs));
        continue;
      }
      await safeInsertUsageEvent({
        transcript_id: transcriptId ?? "unknown",
        provider: "openai",
        stage,
        operation,
        status: "error",
        model,
        duration_ms: durationMs,
        request_meta: safeObject(requestMeta),
        error_message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
  throw new Error("Unreachable");
}

interface GeminiTrackedCallArgs {
  transcriptId?: string;
  stage: string;
  operation: string;
  model: string;
  usageMetadata: GeminiUsageMetadata;
  /** Duration of the audio in seconds, used to populate usage_hours for cost comparison */
  audioSeconds?: number;
  durationMs: number;
  requestMeta?: Record<string, unknown>;
}

export async function trackGeminiTranscription({
  transcriptId,
  stage,
  operation,
  model,
  usageMetadata,
  audioSeconds,
  durationMs,
  requestMeta,
}: GeminiTrackedCallArgs): Promise<void> {
  const usageHours = audioSeconds ? audioSeconds / 3600 : null;
  const cost = estimateCostUsd({
    provider: "gemini",
    model,
    inputTokens: usageMetadata.promptTokenCount,
    outputTokens: usageMetadata.candidatesTokenCount,
    reasoningTokens: usageMetadata.thoughtsTokenCount,
  });

  await safeInsertUsageEvent({
    transcript_id: transcriptId ?? "unknown",
    provider: "gemini",
    stage,
    operation,
    status: "success",
    model,
    input_tokens: usageMetadata.promptTokenCount,
    output_tokens: usageMetadata.candidatesTokenCount,
    reasoning_tokens: usageMetadata.thoughtsTokenCount || null,
    total_tokens: usageMetadata.totalTokenCount,
    usage_hours: usageHours,
    usage_seconds: audioSeconds ? Math.round(audioSeconds) : null,
    usage_quantity_type: audioSeconds ? "audio_hours" : null,
    rate_card_version: cost?.pricing.rateCardVersion ?? null,
    base_rate_per_hour_usd: null, // Gemini is token-priced, not hour-priced
    pricing_meta: safeObject({
      estimated_cost_usd: cost?.costUsd ?? null,
      pricing: cost?.pricing ?? null,
    }),
    duration_ms: durationMs,
    request_meta: safeObject(requestMeta),
  });
}

/**
 * Map a registry `provider.name` (e.g. `assemblyai-universal-3-pro`) to the
 * vendor token stored in `processing_usage_events.provider`. Keeps the column
 * to a closed vendor enum while still letting the pricing table key on
 * `${vendor}/${model}` for finer-grained rates.
 */
function vendorFromProviderName(name: string): ProcessingUsageProvider {
  if (name.startsWith("gemini")) return "gemini";
  if (name.startsWith("assemblyai")) return "assemblyai";
  // Azure AI Speech is a different service (and rate card) from Azure OpenAI —
  // must be tested before the generic `azure` prefix below, which would
  // otherwise swallow it and misattribute the cost.
  if (name.startsWith("azure-llm-speech") || name.startsWith("azure-speech"))
    return "azure-speech";
  if (name.startsWith("azure")) return "azure-openai";
  if (name.startsWith("alibaba")) return "alibaba";
  if (name.startsWith("openai")) return "openai";
  if (name.startsWith("speechmatics")) return "speechmatics";
  // Unknown — log loudly so a missing mapping doesn't silently mis-label rows.
  console.warn(
    `[usage-tracking] Unknown provider name "${name}" — defaulting vendor to "openai". Add a case to vendorFromProviderName.`,
  );
  return "openai";
}

interface TrackTranscriptionArgs {
  transcriptId: string;
  provider: TranscriptionProvider;
  usage?: TranscriptUsage;
  durationMs: number;
  requestMeta?: Record<string, unknown>;
}

/**
 * Vendor-neutral entry point for the `transcribing` stage. Pulls token /
 * audio-second counters from the provider's normalized `usage` field, looks
 * up the rate in `lib/providers/pricing.ts`, and writes one
 * `processing_usage_events` row with `pricing_meta.estimated_cost_usd`
 * populated whenever the pricing table covers the (vendor, model) pair.
 */
export async function trackTranscription({
  transcriptId,
  provider,
  usage,
  durationMs,
  requestMeta,
}: TrackTranscriptionArgs): Promise<void> {
  const vendor = vendorFromProviderName(provider.name);
  const model = provider.model;
  const audioSeconds = usage?.audioSeconds ?? null;
  const usageHours = audioSeconds ? audioSeconds / 3600 : null;

  const cost = estimateCostUsd({
    provider: vendor,
    model,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    reasoningTokens: usage?.reasoningTokens,
    cachedInputTokens: usage?.cachedInputTokens,
    audioSeconds: audioSeconds ?? undefined,
  });

  const baseRate =
    cost?.pricing.kind === "audio_hours" ? cost.pricing.perHourUsd : null;

  await safeInsertUsageEvent({
    transcript_id: transcriptId,
    provider: vendor,
    stage: UsageStages.transcribing,
    operation: UsageOperations.transcribe,
    status: "success",
    model,
    input_tokens: usage?.inputTokens ?? null,
    output_tokens: usage?.outputTokens ?? null,
    reasoning_tokens: usage?.reasoningTokens ?? null,
    cached_input_tokens: usage?.cachedInputTokens ?? null,
    usage_hours: usageHours,
    usage_seconds: audioSeconds != null ? Math.round(audioSeconds) : null,
    usage_quantity_type: audioSeconds != null ? "audio_hours" : null,
    rate_card_version: cost?.pricing.rateCardVersion ?? null,
    base_rate_per_hour_usd: baseRate,
    pricing_meta: safeObject({
      estimated_cost_usd: cost?.costUsd ?? null,
      pricing: cost?.pricing ?? null,
    }),
    duration_ms: durationMs,
    request_meta: safeObject({
      provider_name: provider.name,
      ...(requestMeta ?? {}),
    }),
  });
}

export async function trackTranscriptionError({
  transcriptId,
  provider,
  durationMs,
  error,
  requestMeta,
}: {
  transcriptId: string;
  provider: TranscriptionProvider;
  durationMs: number;
  error: unknown;
  requestMeta?: Record<string, unknown>;
}): Promise<void> {
  await safeInsertUsageEvent({
    transcript_id: transcriptId,
    provider: vendorFromProviderName(provider.name),
    stage: UsageStages.transcribing,
    operation: UsageOperations.transcribe,
    status: "error",
    model: provider.model,
    duration_ms: durationMs,
    request_meta: safeObject({
      provider_name: provider.name,
      ...(requestMeta ?? {}),
    }),
    error_message: error instanceof Error ? error.message : String(error),
  });
}
