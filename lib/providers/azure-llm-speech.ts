import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { TranscriptionProvider, NormalizedTranscript } from "./types";
import {
  downloadAudioToTemp,
  apiLanguage,
  splitAudioAsync,
  parallelMap,
} from "./utils";

const runFile = promisify(execFile);
const MAX_DURATION_SECONDS = 5 * 60 * 60;
const MAX_FILE_BYTES = 500_000_000;
const CHUNK_SECONDS = 60 * 60;

const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY!;
const AZURE_SPEECH_ENDPOINT = process.env.AZURE_SPEECH_ENDPOINT!;

/**
 * `locales` requires full BCP-47 — a bare ISO code is rejected with
 * `400 InvalidLocale "The specified locale is not supported."` (verified for
 * every one of our codes; `zh-Hans` is likewise rejected — it must be `zh-CN`).
 * Arabic is pinned to `ar-SA` (Modern Standard Arabic, which is what UN Arabic
 * is, and what the service itself auto-detects on our Arabic track).
 */
const AZURE_LOCALE: Record<string, string> = {
  en: "en-US",
  fr: "fr-FR",
  es: "es-ES",
  ar: "ar-SA",
  ru: "ru-RU",
  zh: "zh-CN",
};

/**
 * Azure "LLM Speech" enhanced-mode fast transcription (api-version 2025-10-15)
 * on the existing Speech resource (same creds as azure-speech-batch). Multi-
 * lingual by default — the docs' own sample shows an en→zh→fr file returned as
 * one mixed-script transcript with per-phrase `locale` labels — with
 * diarization (`maxSpeakers`) and word timestamps. Synchronous multipart call,
 * <5 h / <500 MB per file. LLM-family model → hallucination risk is the thing
 * this arm is being evaluated FOR; `confidence` is documented as always 0.
 * Audio is converted to mono MP3 first (m4a/mp4 containers are not in the
 * documented format list).
 *
 * IMPORTANT: enhanced mode only works on the `<resource>.services.ai.azure.com`
 * hostname. The same request against the `<resource>.cognitiveservices.azure.com`
 * hostname of the SAME resource returns `400 "Enhanced mode is currently not
 * supported yet"` (which reads like a region problem but isn't). Plain fast
 * transcription works on either hostname. Set AZURE_SPEECH_ENDPOINT accordingly.
 *
 * WHAT MODEL IS THIS? "Enhanced mode" is a serving surface, not a model. Omitting
 * `enhancedMode.model` — which is what we do — routes to Microsoft's *unnamed*
 * default speech-LLM ("multimodal model" / "renewed speech-LLM model" in the docs;
 * never identified). It is NOT MAI-Transcribe: that is a separate, named model you
 * opt into via `enhancedMode.model: "mai-transcribe-1.5"` (which has no diarization
 * and no word timestamps, so it is not usable for us).
 *
 * ⚠️ THE DEFAULT MODEL IS UNPINNABLE. There is no version identifier, and Microsoft
 * has already replaced it once ("renewed speech-LLM model", Build 2026) under an
 * unchanged request shape. Behavior can shift under us with no signal. This is
 * guarded by `eval/analysis/regression-azure-llm.ts` — run it on a schedule; a step
 * change in drift means the model moved and the §14/§15 evals must be re-run.
 *
 * Not a concern (measured, SYNTHESIS §15.0a): the "readability-optimized" default
 * does NOT rewrite content. Word counts land within 0.3% of classic ASR, fillers are
 * retained at the same rate as AssemblyAI, and side-by-side passages are word-for-
 * word identical — it is display formatting, not paraphrase. (`transcribeStyle:
 * "verbatim"` exists only on mai-transcribe-1.5 and would merely *preserve* filler
 * words, which a UN verbatim record does not want anyway — the PV itself strips them.)
 *
 * `locales`: omitting it puts the service in multi-lingual auto-detect mode. For a
 * single-language track that is the wrong config — the docs say pinning `locales`
 * "forces recognition in a single language" and improves accuracy and latency. We
 * pin it per-track and leave it off only for the multilingual floor.
 */
export const azureLlmSpeech: TranscriptionProvider = {
  name: "azure-llm-speech",
  label: "Azure LLM Speech (enhanced)",
  model: "llm-speech-enhanced",
  capabilities: {
    speakerIdentification: false,
    paragraphSegmentation: false,
    wordTimestamps: true,
  },

  async transcribe(audioUrl, opts) {
    const ownedPath = !opts?.audioFilePath;
    const filePath =
      opts?.audioFilePath ||
      (await downloadAudioToTemp(audioUrl, "AzureLLMSpeech"));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "azure-llm-speech-"));
    const mp3Path = path.join(tmpDir, "audio.mp3");
    let chunks: { path: string; offsetMs: number }[] = [];

    try {
      // Keep the event loop free for pipeline heartbeats during long conversions.
      await runFile("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        filePath,
        // Kaltura audio can contain timestamp gaps (including many tiny gaps).
        // MP3 has a continuous sample clock: preserve the playback timeline by
        // padding gaps, rather than collapsing them and shifting later speech.
        "-af",
        "aresample=async=1:first_pts=0",
        "-ac",
        "1",
        "-b:a",
        "64k",
        mp3Path,
      ]);
      const { stdout } = await runFile("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        mp3Path,
      ]);
      const durationSeconds = Number(stdout.trim());
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new Error("Azure LLM Speech: cannot determine audio duration");
      }
      chunks =
        durationSeconds >= MAX_DURATION_SECONDS ||
        fs.statSync(mp3Path).size >= MAX_FILE_BYTES
          ? await splitAudioAsync(mp3Path, CHUNK_SECONDS, "azure-llm-chunks-")
          : [{ path: mp3Path, offsetMs: 0 }];

      const definition: Record<string, unknown> = {
        enhancedMode: { enabled: true, task: "transcribe" },
        diarization: { enabled: true, maxSpeakers: 20 },
      };
      // Pin the language on single-language tracks; leave unset for `floor` so
      // the service stays in multi-lingual mode and code-switches (see above).
      const lang = apiLanguage(opts?.language);
      const locale = lang ? AZURE_LOCALE[lang] : undefined;
      if (lang && !locale)
        throw new Error(
          `azure-llm-speech: no BCP-47 locale mapped for language "${lang}". ` +
            `Bare ISO codes are rejected by the API — add it to AZURE_LOCALE.`,
        );
      if (locale) definition.locales = [locale];

      const endpoint = AZURE_SPEECH_ENDPOINT.replace(/\/$/, "");
      const transcribeChunk = async (chunkPath: string) => {
        const audioBytes = fs.readFileSync(chunkPath);
        const t0 = Date.now();

        // Retry per Microsoft's own guidance: up to 5 attempts with exponential
        // backoff on 429 and 5xx, plus network/timeout errors ("the API might
        // accept a request but time out while generating the response"). Both a
        // 500 and a hard timeout were observed during the §15 sweep, so this is
        // not theoretical. 4xx other than 429 is a request bug — fail fast.
        // The body is rebuilt each attempt: a FormData/Blob is single-use.
        const RETRYABLE = new Set([429, 500, 502, 503, 504]);
        const BACKOFF_MS = [2000, 4000, 8000, 16000];
        let res: Response | undefined;
        let lastErr: unknown;

        for (let attempt = 0; attempt < 5; attempt++) {
          if (attempt > 0) {
            const wait = BACKOFF_MS[attempt - 1];
            console.log(
              `  [azure-llm-speech] retry ${attempt}/4 in ${wait / 1000}s (${
                res ? `HTTP ${res.status}` : (lastErr as Error)?.message
              })`,
            );
            await new Promise((r) => setTimeout(r, wait));
          }

          const form = new FormData();
          form.append(
            "audio",
            new Blob([audioBytes], { type: "audio/mpeg" }),
            path.basename(chunkPath),
          );
          form.append("definition", JSON.stringify(definition));

          try {
            res = await fetch(
              `${endpoint}/speechtotext/transcriptions:transcribe?api-version=2025-10-15`,
              {
                method: "POST",
                headers: { "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY },
                body: form,
              },
            );
            lastErr = undefined;
          } catch (err) {
            // Network error / timeout — retryable.
            res = undefined;
            lastErr = err;
            continue;
          }

          if (res.ok) break;
          if (!RETRYABLE.has(res.status))
            throw new Error(
              `Azure LLM Speech failed ${res.status}: ${await res.text()}`,
            );
        }

        if (!res || !res.ok) {
          const detail = res
            ? `${res.status}: ${await res.text()}`
            : `network error: ${(lastErr as Error)?.message}`;
          throw new Error(
            `Azure LLM Speech failed after 5 attempts — ${detail}`,
          );
        }

        console.log(
          `  [azure-llm-speech] transcribed in ${((Date.now() - t0) / 1000).toFixed(0)}s`,
        );
        return (await res.json()) as {
          durationMilliseconds?: number;
          combinedPhrases?: Array<{ text: string }>;
          phrases?: Array<{
            offsetMilliseconds: number;
            durationMilliseconds: number;
            text: string;
            locale?: string;
            speaker?: number | string;
            words?: Array<{
              text: string;
              offsetMilliseconds: number;
              durationMilliseconds: number;
            }>;
          }>;
        };
      };
      // Settle all in-flight calls before cleanup; stop starting new chunks after
      // a failure. parallelMap itself otherwise rejects while workers still run.
      let failure: { error: unknown } | undefined;
      const results = await parallelMap(chunks, 3, async (chunk) => {
        if (failure) return undefined;
        try {
          return await transcribeChunk(chunk.path);
        } catch (error) {
          failure ??= { error };
          return undefined;
        }
      });
      if (failure) throw failure.error;

      // One utterance per phrase; merge consecutive same-speaker phrases.
      const utterances: NormalizedTranscript["utterances"] = [];
      const textParts: string[] = [];
      let audioSeconds = 0;
      for (let i = 0; i < results.length; i++) {
        const raw = results[i]!;
        const offsetMs = chunks[i].offsetMs;
        textParts.push(
          raw.combinedPhrases?.map((c) => c.text).join("\n") ||
            (raw.phrases || []).map((p) => p.text).join("\n"),
        );
        audioSeconds += (raw.durationMilliseconds ?? 0) / 1000;
        for (const p of raw.phrases || []) {
          const speaker = `${chunks.length > 1 ? `chunk${i + 1}:` : ""}${p.speaker ?? "1"}`;
          const start = p.offsetMilliseconds + offsetMs;
          const end = p.offsetMilliseconds + p.durationMilliseconds + offsetMs;
          const words = (p.words || []).map((w) => ({
            text: w.text,
            start: w.offsetMilliseconds + offsetMs,
            end: w.offsetMilliseconds + w.durationMilliseconds + offsetMs,
            speaker,
          }));
          const last = utterances[utterances.length - 1];
          if (last && last.speaker === speaker) {
            last.end = end;
            last.text += " " + p.text;
            if (last.words && words.length) last.words.push(...words);
          } else {
            utterances.push({ speaker, start, end, text: p.text, words });
          }
        }
      }
      const durationMs = Math.round(durationSeconds * 1000);
      return {
        provider: "azure-llm-speech",
        language: opts?.language || "multi",
        fullText: textParts.join("\n"),
        utterances,
        durationMs,
        usage: audioSeconds ? { audioSeconds } : undefined,
        raw:
          chunks.length === 1
            ? results[0]
            : {
                chunked: true,
                chunkCount: chunks.length,
                chunks: results.map((raw, i) => ({
                  offsetMs: chunks[i].offsetMs,
                  raw,
                })),
              },
      } satisfies NormalizedTranscript;
    } finally {
      for (const dir of new Set(
        chunks
          .filter((c) => c.path !== mp3Path)
          .map((c) => path.dirname(c.path)),
      )) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (ownedPath) {
        try {
          fs.unlinkSync(filePath);
        } catch {}
      }
    }
  },
};
