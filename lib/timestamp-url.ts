/** Parse seconds or a clock timestamp from a meeting URL. */
export function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const seconds = Math.floor(Number(value));
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  if (!/^\d+:\d{2}(?::\d{2})?$/.test(value)) return null;
  const parts = value.split(":").map(Number);
  if (parts.slice(1).some((part) => part > 59)) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

/** Round up so fractional statement starts link inside the correct statement. */
export function formatTimestamp(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const tail = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${tail}`
    : `${minutes}:${tail}`;
}

/** Keep clock timestamps readable while retaining normal query escaping. */
export function serializeMeetingParams(params: URLSearchParams): string {
  return params
    .toString()
    .replace(
      /(^|&)t=([^&]*)/g,
      (_, prefix, value) => `${prefix}t=${value.replace(/%3A/gi, ":")}`,
    );
}
