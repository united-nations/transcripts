/**
 * Shared core for realigning transcripts whose audio was re-cut by WebTV after
 * transcription. WebTV sometimes trims dead air off the FRONT of a video
 * post-upload, leaving our stored timestamps ahead of the (now shorter) audio
 * by a constant amount. The fix is a single constant offset added at render
 * time; stored timestamps are left untouched (reversible, re-runnable).
 *
 * Detection signal — ANY REDUCTION in duration vs the length we last reconciled
 * to (COALESCE(aligned_duration_ms, source_duration_ms, last-statement-end
 * proxy)). We do NOT key on "content sticking out past the audio end": a front
 * cut can be fully absorbed by trailing silence, leaving content within bounds
 * yet shifted — that must still be caught. A reduction is the only reliable
 * fingerprint. (Trailing-silence trims also reduce duration; those resolve to a
 * ~0 offset and are harmless — see validation below.)
 *
 * For the actual shift we ask Gemini to locate the meeting's opening statements
 * in only the first few minutes of audio (downloaded via Kaltura `clipTo`, so
 * the request is tiny), then VALIDATE geometrically that a single front-shift
 * explains the change. If it doesn't (mid-cut / content truncation), we don't
 * write an offset — the row is flagged for full re-transcription.
 *
 * Used by both app/api/cron/realign (ongoing) and scripts/realign-backfill.ts
 * (one-off legacy cleanup).
 */
import { pool, type TranscriptContent } from "./db";
import { notifyIndexNowByTranscriptId } from "./indexnow-transcript";
import { getKalturaAudioUrl } from "./transcription";
import { fetchKalturaDurations } from "./kaltura-helpers";
import { bcp47ToKalturaName } from "./languages";
import {
  GEMINI_API_KEY,
  GEMINI_MODEL,
  GEMINI_BASE,
  httpsPostJson,
  fmtHHMMSS,
} from "./gemini-utils";

import { REDUCTION_TRIGGER_S } from "./realignment-constants";
export { REDUCTION_TRIGGER_S };

export const CLIP_MS = 5 * 60 * 1000; // 5-min front clip — reliable margin over observed trims
export const OVERSHOOT_TOL_S = 45; // after shifting, content may not exceed audio by > this
export const START_TOL_S = 30; // after shifting, content may not start before -this

type Stmt = TranscriptContent["statements"][number];

export interface RealignInput {
  transcriptId: string;
  entryId: string;
  kalturaId: string;
  languageCode: string | null;
  statements: Stmt[];
  /** Audio length recorded at transcription time (ms). null for legacy rows. */
  sourceDurationMs: number | null;
  /**
   * Duration (ms) to compare the current audio against for the reduction
   * trigger — the length we last reconciled to: COALESCE(aligned_duration_ms,
   * source_duration_ms, last-statement-end proxy). A current duration shorter
   * than this by REDUCTION_TRIGGER_S means a (new) cut to investigate.
   */
  baselineDurationMs: number | null;
}

export type RealignStatus =
  | "applied" // valid offset written
  | "valid_dryrun" // valid offset, not written (apply=false)
  | "no_change" // content fits within current audio — nothing to do
  | "invalid" // not a constant front-shift (mid-cut / truncation) — flag for reprocess
  | "no_duration" // Kaltura returned no current duration (deleted?)
  | "no_anchors" // no usable opening phrases
  | "no_offset" // Gemini didn't return a parseable offset
  | "clip_failed" // could not download the front clip
  | "error";

export interface RealignResult {
  transcriptId: string;
  label: string;
  status: RealignStatus;
  currentSec?: number;
  lastEndSec?: number;
  reductionS?: number;
  offsetMs?: number | null;
  confidence?: string;
  geminiConstant?: boolean;
  validErrS?: number;
  message?: string;
  tokensIn: number;
  tokensOut: number;
}

/** Flatten the leading `n` word texts from a statement, whatever its shape. */
function leadingText(s: Stmt, n: number): string {
  const out: string[] = [];
  const fromWords = (ws?: Array<{ text: string }>) =>
    ws?.forEach((w) => w.text && out.push(w.text));
  if (s.words?.length) fromWords(s.words);
  for (const p of s.paragraphs ?? []) {
    if (out.length >= n) break;
    if (p.words?.length) fromWords(p.words);
    else
      for (const sent of p.sentences ?? []) {
        if (out.length >= n) break;
        if (sent.words?.length) fromWords(sent.words);
        else for (const w of sent.text.split(/\s+/)) if (w) out.push(w);
      }
  }
  return out.slice(0, n).join(" ");
}

/** Resolve the playManifest URL to its serveFlavor target and inject clipTo. */
async function buildFrontClipUrl(
  playManifestUrl: string,
  ms: number,
): Promise<string> {
  const res = await fetch(playManifestUrl, { redirect: "manual" });
  const loc = res.headers.get("location");
  if (!loc) throw new Error("no redirect from playManifest");
  if (!loc.includes("/fileName/"))
    throw new Error(`unexpected serveFlavor URL: ${loc}`);
  return loc.replace("/fileName/", `/clipTo/${ms}/fileName/`);
}

async function askGeminiOffset(
  clipBase64: string,
  anchors: { ts: string; phrase: string }[],
): Promise<{
  offsetSec: number | null;
  confidence?: string;
  constant?: boolean;
  tokensIn: number;
  tokensOut: number;
}> {
  const refList = anchors.map((a) => `- [${a.ts}] "${a.phrase}"`).join("\n");
  const prompt = `This is the FIRST ${CLIP_MS / 60000} MINUTES of the audio recording of a UN meeting. We have an OLD transcript whose timestamps no longer match this audio because content was trimmed from the START of the recording, shifting everything earlier.

Below are phrases with their timestamps IN THE OLD TRANSCRIPT (the meeting's first statements):
${refList}

For each phrase you can actually hear in this clip, find its real timestamp now and compute its individual shift = (new time − old time). If ONLY the front was trimmed, every phrase shifts by the same amount. Some of the later phrases may fall beyond this short clip — ignore those and use only the phrases you can locate.

Respond with ONLY a JSON object:
{
  "offset_seconds": <number>,   // the common shift to ADD to the old timestamps; negative because front content was removed
  "confidence": "<low|medium|high>",
  "constant": <true|false>      // true if every phrase you located shares (within ~2s) the SAME shift — a clean front trim; false if different phrases need different shifts, meaning content was also cut from the middle so no single offset can align the whole transcript
}`;
  const body = {
    contents: [
      {
        parts: [
          { inlineData: { mimeType: "audio/mp4", data: clipBase64 } },
          { text: prompt },
        ],
      },
    ],
    generationConfig: { temperature: 0, maxOutputTokens: 4096 }, // thinking ON
  };
  const url = `${GEMINI_BASE}/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await httpsPostJson(url, body);
  if (res.status !== 200) {
    return { offsetSec: null, tokensIn: 0, tokensOut: 0 };
  }
  const raw = JSON.parse(res.body) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
    };
  };
  const u = raw.usageMetadata ?? {};
  const tokensIn = u.promptTokenCount ?? 0;
  const tokensOut = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  const text = (raw.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  try {
    const j = JSON.parse(
      text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
    );
    return {
      offsetSec: Number(j.offset_seconds),
      confidence: j.confidence,
      constant: j.constant,
      tokensIn,
      tokensOut,
    };
  } catch {
    return { offsetSec: null, tokensIn, tokensOut };
  }
}

/** Batch-fetch current Kaltura durations (seconds) for many canonical entries. */
export async function fetchCurrentDurations(
  entryIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < entryIds.length; i += 400) {
    const slice = entryIds.slice(i, i + 400);
    try {
      const m = await fetchKalturaDurations(slice);
      for (const [k, v] of m) out.set(k, v);
    } catch {
      // leave missing; per-row realign will treat as no_duration
    }
  }
  return out;
}

/**
 * Compute and (optionally) apply the realignment offset for one transcript.
 * `currentSec` may be supplied (e.g. from a batched duration fetch) to skip the
 * per-row Kaltura duration lookup.
 */
export async function realignTranscript(
  input: RealignInput,
  opts: { apply: boolean; currentSec?: number },
): Promise<RealignResult> {
  const label = input.transcriptId;
  const base: RealignResult = {
    transcriptId: input.transcriptId,
    label,
    status: "error",
    tokensIn: 0,
    tokensOut: 0,
  };

  // Kaltura flavor language name (e.g. "interlingua" for floor, "english"),
  // NOT getLanguageFullName — that returns the prompt phrase "the original
  // language" for floor, which never matches a flavor so every floor-track
  // realignment throws "no flavors ready". Mirror the main pipeline and
  // process-scheduled, which both use bcp47ToKalturaName here.
  const lang = bcp47ToKalturaName(input.languageCode || "en");
  const { entryId, audioUrl } = await getKalturaAudioUrl(input.kalturaId, lang);

  let currentSec = opts.currentSec;
  if (currentSec == null) {
    const m = await fetchKalturaDurations([entryId]);
    currentSec = m.get(entryId);
  }
  if (!currentSec) return { ...base, status: "no_duration" };
  const currentMs = currentSec * 1000;

  const ends = input.statements
    .map((s) => s.end)
    .filter((n): n is number => typeof n === "number");
  const starts = input.statements
    .map((s) => s.start)
    .filter((n): n is number => typeof n === "number");
  if (!ends.length || !starts.length) return { ...base, status: "no_anchors" };
  const lastEndMs = Math.max(...ends);
  const firstStartMs = Math.min(...starts);

  // Trigger on ANY reduction of duration vs the length we last reconciled to.
  // (Falls back to the last-statement-end proxy only if no baseline is given —
  // that proxy underestimates the original length when there is trailing
  // silence and can miss a front cut, which is exactly why callers pass an
  // explicit baseline whenever they have one.)
  const baselineMs = input.baselineDurationMs ?? lastEndMs;
  const reductionS = (baselineMs - currentMs) / 1000;

  const res: RealignResult = {
    ...base,
    currentSec,
    lastEndSec: lastEndMs / 1000,
    reductionS,
  };

  if (reductionS < REDUCTION_TRIGGER_S) return { ...res, status: "no_change" };

  // Download the front clip (server-side clipped — tiny).
  let clipBase64: string;
  try {
    const clipUrl = await buildFrontClipUrl(audioUrl, CLIP_MS);
    const r = await fetch(clipUrl, { redirect: "follow" });
    if (!r.ok)
      return { ...res, status: "clip_failed", message: `clip ${r.status}` };
    clipBase64 = Buffer.from(await r.arrayBuffer()).toString("base64");
  } catch (e) {
    return { ...res, status: "clip_failed", message: (e as Error).message };
  }

  // Anchors: opening words + old timestamps of the first statements.
  const anchors = input.statements
    .slice(0, 8)
    .filter((s) => typeof s.start === "number")
    .map((s) => ({
      ts: fmtHHMMSS((s.start as number) / 1000),
      phrase: leadingText(s, 14),
    }))
    .filter((a) => a.phrase.length > 0);
  if (anchors.length === 0) return { ...res, status: "no_anchors" };

  const g = await askGeminiOffset(clipBase64, anchors);
  res.tokensIn = g.tokensIn;
  res.tokensOut = g.tokensOut;
  res.confidence = g.confidence;
  res.geminiConstant = g.constant;
  if (g.offsetSec == null || Number.isNaN(g.offsetSec)) {
    return { ...res, status: "no_offset" };
  }
  const offsetSec = g.offsetSec;
  res.offsetMs = Math.round(offsetSec * 1000);

  // Geometric validation of the constant-front-shift hypothesis:
  //  • after shifting, content must not stick out past the audio end (catches
  //    mid-cuts / content truncation, which a single offset can't explain);
  //  • after shifting, content must not start before zero;
  //  • a front trim removes content, so the offset is ≤ ~0;
  //  • the front trim can't exceed the total length change (when known).
  // Note we do NOT require the shifted end to EQUAL the audio end — trailing
  // silence (or a trailing-silence trim) legitimately leaves content ending
  // before the audio does. That asymmetry is the whole point (see file header).
  const predictedEndS = lastEndMs / 1000 + offsetSec;
  const predictedStartS = firstStartMs / 1000 + offsetSec;
  const endOvershoot = predictedEndS - currentSec; // want ≤ OVERSHOOT_TOL_S
  const startOk = predictedStartS >= -START_TOL_S;
  const signOk = offsetSec <= START_TOL_S;
  let boundOk = true;
  if (input.sourceDurationMs != null) {
    const maxFrontTrim =
      input.sourceDurationMs / 1000 - currentSec + OVERSHOOT_TOL_S;
    boundOk = Math.abs(offsetSec) <= Math.max(maxFrontTrim, 0);
  }
  const valid = endOvershoot <= OVERSHOOT_TOL_S && startOk && signOk && boundOk;
  res.validErrS = endOvershoot;

  const alignedMs = Math.round(currentMs);

  if (!valid) {
    // Mark "checked at this duration" so we don't re-run Gemini every hour, and
    // clear any now-stale offset (a re-cut can invalidate a previous shift).
    if (opts.apply) {
      await pool.query(
        "UPDATE webtv.transcripts SET time_offset_ms = NULL, aligned_duration_ms = $1, updated_at = NOW() WHERE transcript_id = $2",
        [alignedMs, input.transcriptId],
      );
      await notifyIndexNowByTranscriptId(input.transcriptId);
    }
    return {
      ...res,
      status: "invalid",
      message: `not a constant front-shift (endOvershoot=${endOvershoot.toFixed(0)}s startOk=${startOk} signOk=${signOk} boundOk=${boundOk})`,
    };
  }

  if (opts.apply) {
    await pool.query(
      "UPDATE webtv.transcripts SET time_offset_ms = $1, aligned_duration_ms = $2, updated_at = NOW() WHERE transcript_id = $3",
      [res.offsetMs, alignedMs, input.transcriptId],
    );
    await notifyIndexNowByTranscriptId(input.transcriptId);
    return { ...res, status: "applied" };
  }
  return { ...res, status: "valid_dryrun" };
}
