import { isTransientPipelineError } from "@/lib/pipeline-errors";
import { after } from "next/server";
import * as Sentry from "@sentry/nextjs";
import {
  getRunnableTranscripts,
  getRunnableAnalyses,
  claimTranscript,
  releaseTranscript,
  releaseAnalysis,
  withJobLock,
  MAX_INTERRUPTED_RETRIES,
} from "@/lib/db";
import {
  createKalturaReadinessProbe,
  submitTranscription,
  runSpeakerIdentification,
  runPropositionAnalysisJob,
} from "@/lib/transcription";
import { currentWorkerId } from "@/lib/worker-identity";
import { bcp47ToKalturaName } from "@/lib/languages";

const ts = () => new Date().toTimeString().slice(0, 8);

// How long after a video's scheduled start a `scheduled` booking may keep
// waiting for audio before it is abandoned as "recording never materialized".
const SCHEDULED_AGE_OUT_MS = 48 * 60 * 60 * 1000;

// The final `error` row is the only durable record of why a transcript kept
// failing — claimTranscript wipes error_message on every resume, so the
// message present at escalation time is the *last* attempt's failure reason.
// Fold it into the abandonment message instead of overwriting it (during the
// 2026-07 missing-ffmpeg investigation, 11 abandoned rows had lost what they
// had been retrying and needed Sentry archaeology to reconstruct).
function lastErrorSuffix(lastError: string | null): string {
  return lastError
    ? `; last error: ${lastError.slice(0, 500)}`
    : " (no failure reason recorded)";
}

// Detaching strategy for the long-running per-row work. From a cron HTTP
// handler we pass Next's `after()` so the work outlives the response on
// platforms (Vercel) that freeze the function after responding; from the
// boot picker (no request context — `after()` would throw) we pass
// `setImmediate` so the work just runs in the background of the live
// Node process.
export type ScheduleFn = (work: () => void) => void;

export type ProcessScheduledResult =
  | { skipped: "lock_held" }
  | {
      processed: number;
      started: number;
      resumed: number;
      pending: number;
      abandoned: number;
      analysisResumed: number;
      errors: string[];
      message?: string;
    };

/**
 * Picks up runnable transcripts and resumes/starts the pipeline for each.
 *
 * Runnable = `scheduled` (waiting for audio / first attempt) OR
 * `interrupted` with retry_count < cap (worker died mid-flight; safe to
 * resume). Dispatches per row:
 *   - empty raw_paragraphs → (re)transcribe from scratch via
 *     submitTranscription, reusing the existing transcript_id
 *   - non-empty raw_paragraphs → resume the analysis stage via
 *     runSpeakerIdentification (skips the expensive provider call)
 *
 * `interrupted` rows that have hit the retry cap are escalated to `error`
 * in this same tick so a poison-pill row never loops forever.
 *
 * Also handles `analysis_status = 'interrupted'` on a separate pass — those
 * are on-demand proposition runs that got SIGTERMed.
 *
 * Long-running per-row work is dispatched via `after()` (when the cron tick
 * runs in a serverless request context) so the HTTP response can return
 * promptly while the pipelines continue.
 *
 * Idempotent across replicas via `withJobLock`.
 */
export async function runProcessScheduled(
  options: { schedule?: ScheduleFn } = {},
): Promise<ProcessScheduledResult> {
  const schedule = options.schedule ?? after;
  const result = await withJobLock("process-scheduled", async () => {
    const [scheduled, interruptedAnalyses] = await Promise.all([
      getRunnableTranscripts(),
      getRunnableAnalyses(),
    ]);

    const probeReadiness = createKalturaReadinessProbe();
    let started = 0;
    let resumed = 0;
    let pending = 0;
    let abandoned = 0;
    let analysisResumed = 0;
    const errors: string[] = [];
    const workerId = currentWorkerId();

    for (const item of scheduled) {
      try {
        const kalturaId = item.kaltura_id;

        if (item.transcription_status === "scheduled" && item.scheduled_time) {
          const startMs = item.scheduled_time.getTime();
          // The meeting hasn't started yet — the Kaltura entry is only a
          // pre-created live placeholder, so don't burn a probe on it.
          if (startMs > Date.now()) {
            pending++;
            continue;
          }
          // Measured audio-ready time is <2 h after meeting end even for
          // 4 h meetings (see docs/webtv-kaltura.md). A booking still not
          // runnable 48 h after the video's start means the recording never
          // materialized (meeting cancelled/removed) — stop probing forever.
          if (Date.now() - startMs > SCHEDULED_AGE_OUT_MS) {
            await releaseTranscript(
              item.transcript_id,
              "error",
              "Recording did not become available within 48 hours of the scheduled meeting time",
            );
            abandoned++;
            continue;
          }
        }

        if (item.transcription_status === "interrupted") {
          // Hard cap reached — escalate to `error` so it stops appearing
          // here. The picker filter already excludes >= cap, but a row at
          // exactly cap-1 will pass the filter, then this branch trips on
          // the next failure. Keep both as a belt-and-suspenders guard.
          if (item.retry_count >= MAX_INTERRUPTED_RETRIES) {
            await releaseTranscript(
              item.transcript_id,
              "error",
              `Abandoned after ${MAX_INTERRUPTED_RETRIES} interruption-retries${lastErrorSuffix(item.error_message)}`,
            );
            Sentry.captureMessage(
              `Transcript abandoned after ${MAX_INTERRUPTED_RETRIES} interruption-retries`,
              {
                level: "error",
                tags: {
                  pipeline: "transcription",
                  kind: "abandoned",
                  transcript_id: item.transcript_id,
                },
                extra: {
                  language: item.language_code,
                  last_error: item.error_message,
                },
              },
            );
            abandoned++;
            continue;
          }

          if (item.has_raw_paragraphs) {
            // Resume the analysis stage only — transcription already
            // produced raw_paragraphs, which are expensive to redo.
            // claimTranscript atomically transitions from `interrupted` to
            // `identifying_speakers` + stamps worker_id + retry_count++.
            const claimed = await claimTranscript(
              item.transcript_id,
              ["interrupted"],
              "identifying_speakers",
              workerId,
              { incrementRetry: true },
            );
            if (!claimed) continue; // another worker grabbed it

            const runResume = () => {
              runSpeakerIdentification(item.transcript_id).catch((err) => {
                console.error(
                  `[${ts()}] [process-scheduled] resume analysis failed for ${item.transcript_id}:`,
                  err,
                );
              });
            };
            schedule(runResume);
            console.log(
              `[${ts()}] ↻ Resumed analysis for ${item.transcript_id} (retry ${item.retry_count + 1})`,
            );
            resumed++;
            continue;
          }
          // No raw_paragraphs yet — fall through to the (re)transcribe
          // path below. submitTranscription will overwrite the empty
          // content and run the full pipeline.
        }

        // Readiness gate, in the row's own language: throws "no flavors"
        // (classified as pending below) while the audio is still converting
        // after the live→VOD flip. Runs BEFORE the claim below so a
        // not-ready tick doesn't burn an interrupted-row retry or churn
        // claim/release on the row.
        const { isLiveStream } = await probeReadiness(
          kalturaId,
          bcp47ToKalturaName(item.language_code || "en"),
        );
        if (isLiveStream) {
          pending++;
          continue;
        }

        // Claim BEFORE submitTranscription, for both scheduled and
        // interrupted rows. submitTranscription with existingTranscriptId
        // skips its own dedupe check, so without this gate two overlapping
        // ticks (job lock expired/contended) could both start a pipeline
        // for the same row. The claim is the atomic arbiter; incrementRetry
        // only on the interrupted path so first runs don't count against
        // the cap.
        const fromStatus = item.transcription_status;
        const claimed = await claimTranscript(
          item.transcript_id,
          [fromStatus],
          "transcribing",
          workerId,
          { incrementRetry: fromStatus === "interrupted" },
        );
        if (!claimed) continue; // another worker grabbed it

        try {
          const { transcriptId } = await submitTranscription(kalturaId, {
            existingTranscriptId: item.transcript_id,
            language: item.language_code || "en",
            schedule,
          });
          if (fromStatus === "interrupted") {
            console.log(
              `[${ts()}] ↻ Resumed transcription for ${kalturaId} → ${transcriptId} (retry ${item.retry_count + 1})`,
            );
            resumed++;
          } else {
            console.log(
              `[${ts()}] ✓ Started scheduled transcript for ${kalturaId} → ${transcriptId}`,
            );
            started++;
          }
        } catch (err) {
          // We claimed but failed to start the pipeline — release back to
          // the ORIGINAL status so the row isn't a zombie that the blanket
          // heartbeat (worker_id = us, status in-flight) keeps "alive"
          // forever with no actual pipeline running. Scheduled rows go back
          // to `scheduled` (audio may simply not be ready — must not burn
          // the retry cap); interrupted rows go back to `interrupted` (the
          // claim already counted the attempt, so the cap bounds repeated
          // submit failures).
          await releaseTranscript(
            item.transcript_id,
            fromStatus,
            err instanceof Error ? err.message : "Submit failed after claim",
          ).catch(() => {});
          throw err;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          msg.includes("404") ||
          msg.includes("not found") ||
          msg.includes("no flavors") ||
          isTransientPipelineError(err)
        ) {
          pending++;
        } else {
          console.error(
            `[${ts()}] [process-scheduled] error on ${item.transcript_id}:`,
            err,
          );
          Sentry.captureException(err, {
            tags: {
              pipeline: "process_scheduled",
              transcript_id: item.transcript_id,
            },
          });
          errors.push(`${item.transcript_id}: ${msg}`);
        }
      }
    }

    // Second pass: on-demand proposition analyses that were interrupted.
    // These don't go through submitTranscription — the transcript itself
    // is `completed` and we only need to re-run propositions.
    for (const item of interruptedAnalyses) {
      try {
        if (item.retry_count >= MAX_INTERRUPTED_RETRIES) {
          await releaseAnalysis(
            item.transcript_id,
            "error",
            `Analysis abandoned after ${MAX_INTERRUPTED_RETRIES} interruption-retries${lastErrorSuffix(item.error_message)}`,
          );
          Sentry.captureMessage(
            `Proposition analysis abandoned after ${MAX_INTERRUPTED_RETRIES} interruption-retries`,
            {
              level: "error",
              tags: {
                pipeline: "propositions",
                kind: "abandoned",
                transcript_id: item.transcript_id,
              },
              extra: { last_error: item.error_message },
            },
          );
          abandoned++;
          continue;
        }
        const runResume = () => {
          runPropositionAnalysisJob(item.transcript_id).catch((err) => {
            console.error(
              `[${ts()}] [process-scheduled] resume analysis failed for ${item.transcript_id}:`,
              err,
            );
          });
        };
        after(runResume);
        console.log(
          `[${ts()}] ↻ Resumed proposition analysis for ${item.transcript_id} (retry ${item.retry_count + 1})`,
        );
        analysisResumed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        Sentry.captureException(err, {
          tags: {
            pipeline: "process_scheduled_analysis",
            transcript_id: item.transcript_id,
          },
        });
        errors.push(`analysis ${item.transcript_id}: ${msg}`);
      }
    }

    if (scheduled.length === 0 && interruptedAnalyses.length === 0) {
      return {
        processed: 0,
        started: 0,
        resumed: 0,
        pending: 0,
        abandoned: 0,
        analysisResumed: 0,
        errors: [] as string[],
        message: "No runnable transcripts",
      };
    }

    return {
      processed: scheduled.length + interruptedAnalyses.length,
      started,
      resumed,
      pending,
      abandoned,
      analysisResumed,
      errors,
    };
  });
  return result ?? { skipped: "lock_held" };
}
