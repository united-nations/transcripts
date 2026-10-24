import { shouldDropInjectedBrowserEvent } from "./sentry-injected-browser";

// Surgical client-side Sentry noise filtering.
//
// This module holds the *decision* of whether a browser error event is one of
// a small set of known-unactionable signatures we deliberately drop instead of
// reporting. It is intentionally free of any `@sentry/*` runtime imports and of
// browser-only globals so it can be unit-tested in plain Node.
//
// Signatures dropped (Sentry issue IDs):
//   - TRANSCRIPTS-2K: `TypeError: undefined is not an object (evaluating
//     'e.charAt')` thrown *inside* Kaltura's third-party player bundle.
//   - TRANSCRIPTS-2A: `TypeError: null is not an object (evaluating
//     'e.ownerNode.id')` — same Kaltura `embedPlaykitJs` bundle.
//   - TRANSCRIPTS-2F: `SecurityError: Failed to read the 'localStorage'
//     property from 'Window': Access is denied for this document.` — fires in
//     privacy/sandboxed browser contexts where storage is blocked.
//   - TRANSCRIPTS-D / 29 / 2S / 2R / 2P: unhandled promise rejections raised
//     *inside* the Kaltura player. Its `play()` wrapper is literally
//     `function(){this._localPlayer.play()}` — it starts the underlying
//     `HTMLMediaElement.play()` but neither returns nor catches the promise,
//     so an autoplay-policy `NotAllowedError` or a transient Kaltura media
//     error (a `{category, code, data, errorDetails, severity}` object, or a
//     bare `CustomEvent`/empty object) surfaces as an unhandled rejection with
//     no JS stack. Playback itself is unaffected (the player recovers on the
//     next gesture/seek); these are pure noise we can't fix upstream and can't
//     intercept in-app (our `player.play()` call returns `undefined`).
//
// Everything else passes through. We match on precise signatures, never on the
// broad error *type* (a real `TypeError` from our own code must still report).

// Minimal structural shapes of the parts of a Sentry `ErrorEvent` we inspect.
// A full `ErrorEvent` from `@sentry/nextjs` is assignable to `FilterableEvent`
// (all fields optional), so `beforeSend` can pass its event straight through.
interface FilterableFrame {
  filename?: string;
  abs_path?: string;
  module?: string;
  function?: string;
}

interface FilterableException {
  type?: string;
  value?: string;
  stacktrace?: { frames?: FilterableFrame[] };
}

export interface FilterableEvent {
  message?: string;
  exception?: { values?: FilterableException[] };
}

// Markers that identify a stack frame originating in Kaltura's player bundle.
// `embedPlaykitJs` is the bundle path; `/p/2503451/` is our Kaltura partner's
// player path; the host covers the CDN origin. Any one is sufficient.
const KALTURA_FRAME_MARKERS = [
  "embedPlaykitJs",
  "/p/2503451/",
  "cdnapisec.kaltura.com",
];

// Substrings unique to the blocked-localStorage SecurityError (2F).
const LOCALSTORAGE_BLOCKED_MARKERS = [
  "Failed to read the 'localStorage' property",
  "Access is denied for this document",
];

// Substrings unique to the Kaltura player's stackless unhandled rejections
// (TRANSCRIPTS-D, 29, 2S, 2R, 2P). These carry no stack frames (so the
// frame-based Kaltura match above can't catch them) — we key off Sentry's
// synthetic description of the rejected non-Error value, or the DOMException
// message for the autoplay-policy variants. Each string is specific enough not
// to collide with a genuine app error.
const KALTURA_REJECTION_MARKERS = [
  // Rejected with a Kaltura error object (D).
  "promise rejection with keys: category, code, data, errorDetails, severity",
  // Rejected with an empty object — no actionable payload (2R).
  "promise rejection with keys: [object has no keys]",
  // Rejected with a Kaltura FakeEvent / CustomEvent (2S).
  "CustomEvent` (type=unhandledrejection)",
  // Autoplay-policy NotAllowedError from the media element's play() (29, 2P).
  "play method is not allowed by the user agent",
  "request is not allowed by the user agent or the platform",
];

function frameIsKaltura(frame: FilterableFrame): boolean {
  return [frame.filename, frame.abs_path, frame.module].some(
    (loc) =>
      typeof loc === "string" &&
      KALTURA_FRAME_MARKERS.some((marker) => loc.includes(marker)),
  );
}

/**
 * Returns `true` when the event is one of the known-unactionable client-side
 * signatures we drop (Kaltura player bundle, or blocked localStorage), `false`
 * otherwise. Pure and side-effect-free.
 */
export function shouldDropClientEvent(event: FilterableEvent): boolean {
  if (shouldDropInjectedBrowserEvent(event)) return true;

  const exceptions = event.exception?.values ?? [];

  // 1. Kaltura player bundle frames (TRANSCRIPTS-2K, 2A). If any exception in
  //    the chain has a frame from that bundle, the error is upstream noise.
  for (const exception of exceptions) {
    const frames = exception.stacktrace?.frames ?? [];
    if (frames.some(frameIsKaltura)) return true;
  }

  // 2. Blocked-localStorage SecurityError (TRANSCRIPTS-2F). Match the message
  //    / exception value, never the bare error type.
  const messages: string[] = [];
  if (typeof event.message === "string") messages.push(event.message);
  for (const exception of exceptions) {
    if (typeof exception.value === "string") messages.push(exception.value);
  }
  if (
    messages.some((message) =>
      LOCALSTORAGE_BLOCKED_MARKERS.some((marker) => message.includes(marker)),
    )
  ) {
    return true;
  }

  // 3. Kaltura player unhandled promise rejections (TRANSCRIPTS-D, 29, 2S, 2R,
  //    2P). Stackless, so matched by their rejected-value / DOMException text.
  if (
    messages.some((message) =>
      KALTURA_REJECTION_MARKERS.some((marker) => message.includes(marker)),
    )
  ) {
    return true;
  }

  return false;
}
