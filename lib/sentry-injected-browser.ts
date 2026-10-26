// Only signatures attributed to injected browser scripts in the Sentry audit.
// Unknown executors (including M_ID), storage and media errors stay visible.
interface Frame {
  filename?: string;
  abs_path?: string;
  function?: string;
}

interface Exception {
  type?: string;
  value?: string;
  stacktrace?: { frames?: Frame[] };
}

interface BrowserEvent {
  exception?: { values?: Exception[] };
}

const FIREFOX_MESSAGES = new Set([
  "Can't find variable: __firefox__",
  "undefined is not an object (evaluating 'window.__firefox__.reader')",
  "undefined is not an object (evaluating 'window.__firefox__.refresh_youtube_quality_C85C5288CC2B4BDCBB20C5778007F667')",
]);

function source(frame: Frame): string {
  return frame.abs_path ?? frame.filename ?? "";
}

function isInjectedFirefox(error: Exception, frames: Frame[]): boolean {
  if (!FIREFOX_MESSAGES.has(error.value ?? "")) return false;
  return frames.every(
    (frame) =>
      frame.function === "global code" &&
      /^app:\/\/\/(en|fr|es|ar|ru|zh)(\/|$)/.test(source(frame)),
  );
}

function isInjectedMetaMask(error: Exception, frames: Frame[]): boolean {
  const known = [
    "MetaMask extension not found",
    "Failed to connect to MetaMask",
  ];
  return (
    known.includes(error.value ?? "") &&
    frames.every((frame) => source(frame) === "app:///scripts/inpage.js")
  );
}

function isInjectedPerformanceLogger(
  error: Exception,
  frames: Frame[],
): boolean {
  return (
    error.value === "Error invoking postMessage: Java object is gone" &&
    frames.every(
      (frame) =>
        source(frame) === "app://navigation_performance_logger_android",
    ) &&
    frames[frames.length - 1].function === "sendDataToNative"
  );
}

function isKnownInjection(error: Exception): boolean {
  const frames = error.stacktrace?.frames ?? [];
  if (frames.length === 0) return false;
  return (
    isInjectedFirefox(error, frames) ||
    isInjectedMetaMask(error, frames) ||
    isInjectedPerformanceLogger(error, frames)
  );
}

export function shouldDropInjectedBrowserEvent(event: BrowserEvent): boolean {
  const values = event.exception?.values ?? [];
  // Keep mixed exception chains: an injected cause does not excuse an app bug.
  return values.length > 0 && values.every(isKnownInjection);
}
