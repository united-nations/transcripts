import { setTimeout as sleep } from "node:timers/promises";
import { MEETING_URL_PREFIXES } from "@/lib/meeting-slug";

// Public proof of ownership, not a secret. Keep the matching file in public/.
export const INDEXNOW_KEY = "c80053a69b8736992cdd46870177969a";
export const INDEXNOW_ORIGIN = "https://transcripts.un.org";
export const INDEXNOW_KEY_URL = `${INDEXNOW_ORIGIN}/${INDEXNOW_KEY}.txt`;
const ENDPOINT = "https://www.bing.com/indexnow";
const BATCH_SIZE = 1_000; // Protocol maximum is 10,000.

export function automaticIndexNowEnabled(): boolean {
  return (
    process.env.NODE_ENV === "production" &&
    process.env.INDEXNOW_ENABLED !== "false" &&
    (!process.env.VERCEL_ENV || process.env.VERCEL_ENV === "production") &&
    process.env.BASE_URL?.replace(/\/$/, "") === INDEXNOW_ORIGIN
  );
}

/** Validate the complete list before sending anything; never notify private URLs. */
export function indexNowUrls(urls: readonly string[]): string[] {
  return [...new Set(urls)].map((value) => {
    const url = new URL(value);
    const [, locale, prefix, ...tail] = url.pathname.split("/");
    if (
      url.origin !== INDEXNOW_ORIGIN ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^(en|fr|es|ar|zh|ru)$/.test(locale ?? "") ||
      !MEETING_URL_PREFIXES.some((p) => p === prefix) ||
      !tail.join("/")
    ) {
      throw new Error(`Not a public canonical meeting URL: ${value}`);
    }
    return url.href;
  });
}

/** Run before a manual/backfill submission so undeployed keys cannot silently fail. */
export async function verifyIndexNowKey(): Promise<void> {
  const response = await fetch(INDEXNOW_KEY_URL, {
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || (await response.text()).trim() !== INDEXNOW_KEY) {
    throw new Error(`Deploy the verification file first: ${INDEXNOW_KEY_URL}`);
  }
}

/**
 * Awaited and bounded: retry network failures, 429 and 5xx three times, then
 * throw for the caller to report. Acceptance means received, not indexed.
 * No transcript text, credentials, or user data is submitted.
 */
export async function submitIndexNow(urls: readonly string[]): Promise<number> {
  const validated = indexNowUrls(urls);
  let submitted = 0;
  for (let offset = 0; offset < validated.length; offset += BATCH_SIZE) {
    const batch = validated.slice(offset, offset + BATCH_SIZE);
    for (let attempt = 1; attempt <= 3; attempt++) {
      let response: Response;
      try {
        response = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            host: new URL(INDEXNOW_ORIGIN).host,
            key: INDEXNOW_KEY,
            keyLocation: INDEXNOW_KEY_URL,
            urlList: batch,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        });
      } catch (error) {
        if (attempt === 3) throw error;
        await sleep(attempt * 1_000);
        continue;
      }
      // Drain the response before retrying/reusing the connection.
      await response.text();
      if (response.status === 200 || response.status === 202) {
        submitted += batch.length;
        console.log(
          JSON.stringify({
            type: "indexnow",
            event: "accepted",
            status: response.status,
            count: batch.length,
            urls: batch,
          }),
        );
        break;
      }
      if (attempt === 3 || (response.status !== 429 && response.status < 500)) {
        throw new Error(`IndexNow returned HTTP ${response.status}`);
      }
      await sleep(attempt * 1_000);
    }
  }
  return submitted;
}
