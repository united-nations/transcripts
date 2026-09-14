/** Upstream throttling/outage: retry on a later worker tick. */
export class UpstreamUnavailableError extends Error {}

// Thrown when a downloaded audio file is missing / empty / truncated / a
// non-audio error body saved with an audio name, or ffmpeg cannot decode it.
// These are download-timing / availability problems (Kaltura still converting
// after the live→VOD flip, a transient CDN error page), not permanent
// corruption — so they should be retried, not escalated to a hard `error`.
// The retry cap (MAX_INTERRUPTED_RETRIES) bounds the rare genuinely-corrupt
// source that never becomes decodable.
export class UnusableAudioError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UnusableAudioError";
  }
}

// Transient = the input wasn't fetchable or the network flaked — retrying
// later can succeed (Kaltura still converting audio after the live→VOD flip,
// provider unable to download the file, request timeouts). The pipeline
// releases these as `interrupted` so the process-scheduled picker retries
// them under the MAX_INTERRUPTED_RETRIES cap; intrinsic failures stay
// `error` and need a human.
export function isTransientPipelineError(err: unknown): boolean {
  // Unusable/undecodable/empty audio downloads are retryable by construction.
  if (
    err instanceof UnusableAudioError ||
    err instanceof UpstreamUnavailableError
  )
    return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return [
    "download error",
    "unable to download",
    "download failed",
    "404",
    "timed out",
    "timeout",
    "fetch failed",
    "econnreset",
    "econnrefused",
    "etimedout",
    "enotfound",
    "socket hang up",
    // pg / pg-pool: socket killed by PgBouncer/Azure LB/NAT idle reap.
    // The "timeout" patterns above already cover "Connection terminated due
    // to connection timeout", but the bare "unexpectedly" wording does not.
    "connection terminated unexpectedly",
    // Gemini hit the output-token cap (finishReason MAX_TOKENS) and returned
    // incomplete JSON — a chunk was too dense. Retrying (chunked/sub-sliced)
    // can succeed, so treat it as transient rather than an intrinsic failure.
    "output truncated",
    // getAudioDurationSeconds (gemini-utils.ts) fails closed rather than
    // silently disabling chunking. A probe failure is usually a truncated /
    // not-yet-converted download that a later re-download fixes; if it is a
    // missing ffprobe binary instead, the retry cap escalates to `error`
    // and the boot check in server-init.ts has already raised a Sentry event.
    "audio duration probe failed",
  ].some((pattern) => msg.includes(pattern));
}
