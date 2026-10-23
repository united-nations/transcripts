/**
 * Unified pricing table for every provider that can emit a
 * `processing_usage_events` row, keyed by the provider/model identifier the
 * usage event will carry.
 *
 * Two pricing shapes:
 *   - `audio_hours`: priced per hour of input audio (AssemblyAI, Fun-ASR).
 *   - `tokens`: priced per million input/output tokens (Gemini, Azure
 *     transcribe, OpenAI chat models, token-priced Alibaba models).
 *
 * Lookup happens at insert time inside `lib/usage-tracking.ts`, which produces
 * `pricing_meta.estimated_cost_usd` consistently across vendors. Rates here
 * are the source of truth — nothing else in the codebase should hold a
 * pricing table.
 *
 * Each entry tracks a `rateCardVersion` (YYYY-MM-DD of the rate sheet it was
 * copied from) so historical events stay interpretable when prices change:
 * bump the version on the same day you change the numbers.
 *
 * Confidence notes:
 *   - AssemblyAI, Azure gpt-4o-transcribe and Gemini rates verified
 *     2026-05-30 from the public pricing pages (assemblyai.com/pricing,
 *     developers.openai.com/api/docs/pricing, ai.google.dev/gemini-api/docs/pricing).
 *   - Sol/Luna rates verified 2026-10-23 against their OpenAI model pages.
 *   - Legacy OpenAI chat-model rates carried forward from the prior internal table
 *     (lib/config.ts → scripts/usage-benchmark.ts).
 *   - Alibaba (Qwen3-ASR / Fun-ASR) is not published in English on
 *     alibabacloud.com — left as 0 with TODO until rates are confirmed from
 *     the DashScope console or Chinese-region pricing page.
 */

export type AudioHoursPricing = {
  kind: "audio_hours";
  perHourUsd: number;
  rateCardVersion: string;
};

export type TokenPricing = {
  kind: "tokens";
  /** USD per 1M input (prompt / audio-input) tokens. */
  inputPerM: number;
  /** USD per 1M output (completion / text-output) tokens. */
  outputPerM: number;
  /** USD per 1M cached-input tokens (OpenAI). */
  cachedInputPerM?: number;
  /** USD per 1M cache-write input tokens (falls back to ordinary input). */
  cacheWriteInputPerM?: number;
  longContext?: {
    inputTokenThreshold: number;
    inputMultiplier: number;
    outputMultiplier: number;
  };
  /** USD per 1M thinking / reasoning tokens (Gemini "thoughts"). */
  thinkingPerM?: number;
  rateCardVersion: string;
};

export type Pricing = AudioHoursPricing | TokenPricing;

/**
 * Pricing keyed by `${provider}/${model}`. Provider comes from
 * `processing_usage_events.provider` and model from `.model`, so the key is
 * formed at the lookup site as `${event.provider}/${event.model}`.
 *
 * Why composite keys? `provider` alone is not granular enough (gpt-5.4 vs
 * gpt-5.4-mini share `openai` but have very different rates), and `model`
 * alone collides across vendors.
 */
export const PROVIDER_PRICING: Record<string, Pricing> = {
  // ── OpenAI analysis models ──
  "openai/gpt-6.1-sol": {
    kind: "tokens",
    inputPerM: 2,
    cachedInputPerM: 0.1,
    cacheWriteInputPerM: 2.5,
    outputPerM: 10,
    longContext: {
      inputTokenThreshold: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
    },
    rateCardVersion: "2026-10-23",
  },
  "openai/gpt-6-luna": {
    kind: "tokens",
    inputPerM: 0.1,
    cachedInputPerM: 0.01,
    cacheWriteInputPerM: 0.125,
    outputPerM: 0.5,
    longContext: {
      inputTokenThreshold: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
    },
    rateCardVersion: "2026-10-23",
  },
  // Retained for historical usage and pinned evaluations.
  "openai/gpt-5.4": {
    kind: "tokens",
    inputPerM: 1.25,
    cachedInputPerM: 0.125,
    outputPerM: 10,
    rateCardVersion: "2026-01-01", // TODO: confirm date
  },
  "openai/gpt-5.4-mini": {
    kind: "tokens",
    inputPerM: 0.25,
    cachedInputPerM: 0.025,
    outputPerM: 2,
    rateCardVersion: "2026-01-01", // TODO: confirm date
  },
  "openai/gpt-5.4-nano": {
    kind: "tokens",
    inputPerM: 0.05,
    cachedInputPerM: 0.005,
    outputPerM: 0.4,
    rateCardVersion: "2026-01-01", // TODO: confirm date
  },

  // ── Gemini ──
  // Audio input is billed at a higher rate than text/image/video (1.00 vs
  // 0.50 for 3-flash-preview); we use the audio rate because every Gemini
  // call in this app is either transcription or PV alignment (audio-bearing).
  // Output rate includes thinking tokens per Google's docs.
  "gemini/gemini-3-flash-preview": {
    kind: "tokens",
    inputPerM: 1.0,
    outputPerM: 3.0,
    thinkingPerM: 3.0,
    rateCardVersion: "2026-05-30",
  },
  "gemini/gemini-3.5-flash": {
    kind: "tokens",
    inputPerM: 1.5,
    outputPerM: 9.0,
    thinkingPerM: 9.0,
    rateCardVersion: "2026-05-30",
  },

  // ── Azure OpenAI transcribe (token-priced like the OpenAI API) ──
  // Rates from OpenAI's public pricing page; Azure mirrors them.
  "azure-openai/gpt-4o-transcribe-diarize": {
    kind: "tokens",
    inputPerM: 2.5, // audio input
    outputPerM: 10.0, // text output
    rateCardVersion: "2026-05-30",
  },

  // ── AssemblyAI (per-hour async pricing) ──
  // Base rates only. We send `speaker_labels: true`, which AssemblyAI bills at
  // +$0.02/hr on top of every rate below; that surcharge is not modelled here,
  // so AssemblyAI rows under-report by ~10%.
  "assemblyai/universal-3-5-pro": {
    kind: "audio_hours",
    perHourUsd: 0.21,
    rateCardVersion: "2026-07-09",
  },
  "assemblyai/universal-3-pro": {
    kind: "audio_hours",
    perHourUsd: 0.21,
    rateCardVersion: "2026-05-30",
  },
  "assemblyai/universal-2": {
    kind: "audio_hours",
    perHourUsd: 0.15,
    rateCardVersion: "2026-05-30",
  },

  // ── Azure AI Speech — LLM Speech "enhanced mode" (fr/es/ar/ru since 2026-07-14) ──
  // ⚠️ RATE IS UNCONFIRMED FOR THE DEFAULT ENHANCED MODEL. Microsoft does not
  // publish a separate LLM-Speech line item. $0.36/hr is the **fast
  // transcription** tier that LLM Speech is served on, and it is corroborated by
  // MAI-Transcribe-1.5's published $6 per 1,000 minutes (= $0.36/hr) on the same
  // endpoint. Enhanced add-ons (diarization, language ID) are documented as free
  // for batch. Priced rather than left NULL because these four tracks are ~38 h
  // of audio in total (≈$14 lifetime) — the blast radius of being wrong is
  // negligible, and a NULL would hide the cost of four production languages.
  // Confirm against the Azure invoice once real traffic lands.
  "azure-speech/llm-speech-enhanced": {
    kind: "audio_hours",
    perHourUsd: 0.36,
    rateCardVersion: "2026-07-14",
  },

  // ── Speechmatics (batch; Melia = production floor since 2026-07-10) ──
  // Three distinct models at three distinct rates — see lib/providers/speechmatics.ts.
  // Melia is multilingual-only; standard/enhanced are monolingual-only. First
  // ~10 h/month free (docs); volume tiers above 500 h/month lower these.
  "speechmatics/melia-1": {
    kind: "audio_hours",
    perHourUsd: 0.129,
    rateCardVersion: "2026-07-10",
  },
  "speechmatics/standard": {
    kind: "audio_hours",
    perHourUsd: 0.24,
    rateCardVersion: "2026-07-13",
  },
  "speechmatics/enhanced": {
    kind: "audio_hours",
    perHourUsd: 0.4,
    rateCardVersion: "2026-07-13",
  },

  // ── Alibaba (Qwen3-ASR-Flash, Qwen3.5-Omni, Fun-ASR) ──
  // Intentionally NOT in the table: DashScope ASR pricing is not published in
  // English on alibabacloud.com and third-party aggregators disagree by >1000×.
  // Until a rate is confirmed from the DashScope console, leave the lookup to
  // return null so cost stays NULL instead of being silently summed as $0.
};

/**
 * Compute USD cost for a usage event. Returns `null` when the
 * provider/model isn't in the pricing table or required counters are missing.
 */
export function estimateCostUsd(args: {
  provider: string;
  model: string | null | undefined;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheWriteInputTokens?: number | null;
  reasoningTokens?: number | null;
  audioSeconds?: number | null;
}): { costUsd: number; pricing: Pricing } | null {
  if (!args.model) return null;
  const pricing = PROVIDER_PRICING[`${args.provider}/${args.model}`];
  if (!pricing) return null;

  if (pricing.kind === "audio_hours") {
    if (!args.audioSeconds) return null;
    return {
      costUsd: (args.audioSeconds / 3600) * pricing.perHourUsd,
      pricing,
    };
  }

  // tokens
  const input = args.inputTokens ?? 0;
  const cachedInput = args.cachedInputTokens ?? 0;
  const cacheWriteInput = args.cacheWriteInputTokens ?? 0;
  const output = args.outputTokens ?? 0;
  const reasoning = args.reasoningTokens ?? 0;
  if (input + cachedInput + cacheWriteInput + output + reasoning === 0)
    return null;

  // Callers supply disjoint counters: ordinary input excludes cache reads and
  // writes; output excludes any separately supplied reasoning tokens.
  const cachedRate = pricing.cachedInputPerM ?? pricing.inputPerM;
  const writeRate = pricing.cacheWriteInputPerM ?? pricing.inputPerM;
  const thinkingRate = pricing.thinkingPerM ?? pricing.outputPerM;
  const longContext =
    pricing.longContext &&
    input + cachedInput + cacheWriteInput >
      pricing.longContext.inputTokenThreshold;
  const inputMultiplier = longContext
    ? pricing.longContext!.inputMultiplier
    : 1;
  const outputMultiplier = longContext
    ? pricing.longContext!.outputMultiplier
    : 1;

  const costUsd =
    ((input * pricing.inputPerM +
      cachedInput * cachedRate +
      cacheWriteInput * writeRate) *
      inputMultiplier +
      (output * pricing.outputPerM + reasoning * thinkingRate) *
        outputMultiplier) /
    1_000_000;

  return { costUsd, pricing };
}
