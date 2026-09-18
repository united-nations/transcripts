import { serializeMeetingParams } from "./timestamp-url";

/**
 * Update a single query-string param on the current URL in place, preserving
 * every other param (and the hash), WITHOUT triggering a Next.js navigation or
 * RSC round-trip. Uses the native History API, which Next integrates with the
 * router so `useSearchParams` stays in sync — see the "Native History API"
 * section of node_modules/next/dist/docs/.../linking-and-navigating.md.
 *
 * This is deliberately `replaceState` (not `pushState`) and not `router.push`:
 * the params it drives (audio-language, transcript/analysis/PV view) are pure
 * client-side UI state that doesn't change what the server renders, so a real
 * navigation would needlessly re-run the force-dynamic meeting page (DB + auth)
 * and scroll. Replace keeps the link shareable and refresh-stable without
 * spamming the history stack on every toggle.
 *
 * Pass `undefined` (or an empty string) as `value` to DELETE the param — used
 * for the "omit when it equals the default" semantics: a plain shared link
 * stays clean and only carries the params the user explicitly deviated on.
 */
export function setUrlParam(key: string, value: string | undefined): void {
  setUrlParams({ [key]: value });
}

/** Apply related filter changes in one history update. */
export function setUrlParams(values: Record<string, string | undefined>): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(values)) {
    if (!value) params.delete(key);
    else params.set(key, value);
  }
  const qs = serializeMeetingParams(params);
  const url =
    window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
  window.history.replaceState(null, "", url);
}
