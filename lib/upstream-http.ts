import Bottleneck from "bottleneck";
import { createHash, randomUUID } from "node:crypto";
import { unstable_cache } from "next/cache";
import { UpstreamUnavailableError } from "./pipeline-errors";
import { UPSTREAM_USER_AGENT } from "./upstream-identity";

export type UpstreamPurpose =
  | "webtv_schedule"
  | "webtv_metadata"
  | "webtv_removal"
  | "webtv_categories"
  | "kaltura_resolve"
  | "kaltura_duration"
  | "kaltura_status"
  | "kaltura_visitor_status"
  | "kaltura_visitor_languages"
  | "kaltura_readiness"
  | "kaltura_audio";

type Snapshot = {
  body: string;
  status: number;
  headers: [string, string][];
  requestId: string;
  observedAt: string;
};
type HostState = { limiter: Bottleneck; blockedUntil: number };
type State = {
  hosts: Map<string, HostState>;
  pending: Map<string, Promise<Snapshot>>;
  instance: string;
};
const globalState = globalThis as typeof globalThis & {
  __transcriptsUpstream?: State;
};
const state = (globalState.__transcriptsUpstream ??= {
  hosts: new Map(),
  pending: new Map(),
  instance: randomUUID(),
});

/** Structured, credential-free events captured by the container's log collector. */
export function upstreamEvent(
  purpose: UpstreamPurpose,
  event: string,
  fields: Record<string, unknown> = {},
) {
  console.error(
    JSON.stringify({
      type: "upstream",
      at: new Date().toISOString(),
      instance: state.instance,
      purpose,
      event,
      ...fields,
    }),
  );
}

export function observeUpstreamContent(
  purpose: UpstreamPurpose,
  key: string,
  content: unknown,
  observedAt: string | null,
) {
  upstreamEvent(purpose, "content", {
    key: digest(key),
    fingerprint: digest(JSON.stringify(content)),
    observedAt,
  });
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function retryAfterMs(
  value: string | null,
  now = Date.now(),
): number | null {
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function hostState(host: string): HostState {
  let entry = state.hosts.get(host);
  if (!entry) {
    const webtv = host === "webtv.un.org";
    entry = {
      limiter: new Bottleneck({
        maxConcurrent: webtv ? 3 : 4,
        minTime: webtv ? 300 : 100,
      }),
      blockedUntil: 0,
    };
    state.hosts.set(host, entry);
  }
  return entry;
}

class UncacheableResponse extends Error {
  // Next may log background-revalidation errors. Keep response bodies/headers
  // out of enumerable Error properties (they can contain upstream tokens).
  #snapshot: Snapshot;
  constructor(snapshot: Snapshot) {
    super(`Upstream HTTP ${snapshot.status}`);
    this.#snapshot = snapshot;
  }
  get snapshot() {
    return this.#snapshot;
  }
}

/** All underlying fetches bypass Next's fetch cache, so network events count real attempts. */
async function network(
  url: string,
  init: RequestInit,
  purpose: UpstreamPurpose,
  redirects = 0,
): Promise<Snapshot> {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:")
    throw new Error("Metadata requests require HTTPS");
  const host = parsedUrl.hostname;
  if (host !== "webtv.un.org" && host !== "cdnapisec.kaltura.com")
    throw new Error("Unsupported metadata host");
  const entry = hostState(host);
  for (let attempt = 0; ; attempt++) {
    const response = await entry.limiter.schedule(async () => {
      if (entry.blockedUntil > Date.now()) {
        upstreamEvent(purpose, "deferred", {
          host,
          retryAfterMs: entry.blockedUntil - Date.now(),
        });
        throw new UpstreamUnavailableError(
          `Upstream temporarily unavailable: ${host} Retry-After cooldown`,
        );
      }
      const start = Date.now();
      const headers = new Headers(init.headers);
      headers.set("User-Agent", UPSTREAM_USER_AGENT);
      let status: number | undefined;
      try {
        const res = await fetch(url, {
          ...init,
          headers,
          cache: "no-store",
          redirect: "manual",
          signal: init.signal ?? AbortSignal.timeout(30_000),
        });
        status = res.status;
        if (status === 429 || status === 503) {
          const delay = Math.max(
            retryAfterMs(res.headers.get("retry-after")) ?? 0,
            1000 * 2 ** attempt + Math.floor(Math.random() * 250),
          );
          entry.blockedUntil = Math.max(entry.blockedUntil, Date.now() + delay);
        }
        const body = await res.text();
        upstreamEvent(purpose, "network", {
          host,
          status,
          attempt: attempt + 1,
          durationMs: Date.now() - start,
          bytes: Buffer.byteLength(body),
        });
        return {
          body,
          status,
          headers: [...res.headers.entries()],
          requestId: randomUUID(),
          observedAt: new Date().toISOString(),
        };
      } catch (error) {
        upstreamEvent(purpose, "network", {
          host,
          status: status ?? 0,
          attempt: attempt + 1,
          durationMs: Date.now() - start,
          failed: true,
        });
        throw error;
      }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = new Headers(response.headers).get("location");
      if (!location) return response;
      const nextUrl = new URL(location, url);
      if (redirects >= 5 || nextUrl.origin !== parsedUrl.origin) {
        throw new Error("Unsupported upstream metadata redirect");
      }
      const switchToGet =
        response.status === 303 ||
        ([301, 302].includes(response.status) && init.method === "POST");
      upstreamEvent(purpose, "redirect", { host });
      return network(
        nextUrl.href,
        switchToGet ? { ...init, method: "GET", body: undefined } : init,
        purpose,
        redirects + 1,
      );
    }
    if (![429, 503].includes(response.status)) return response;
    if (attempt >= 2)
      throw new UpstreamUnavailableError(
        `Upstream HTTP ${response.status} after retries`,
      );
    const delay = Math.max(0, entry.blockedUntil - Date.now());
    // Long Retry-After values apply to all calls on this host, but do not hold
    // an HTTP handler open. A later page access/cron tick can retry after expiry.
    if (delay > 10_000)
      throw new UpstreamUnavailableError(
        `Upstream HTTP ${response.status}; Retry-After cooldown`,
      );
    upstreamEvent(purpose, "retry", { host, delayMs: delay });
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/** Persistent cache + in-flight coalescing, shared across routes/locales per instance. */
export async function upstreamFetch(
  url: string,
  init: RequestInit,
  options: {
    purpose: UpstreamPurpose;
    cacheSeconds?: number;
    validate?: (body: string) => void;
  },
): Promise<Response> {
  const { purpose, cacheSeconds = 0, validate } = options;
  const key = digest(
    JSON.stringify([
      url,
      init.method ?? "GET",
      init.body ?? null,
      purpose,
      [...new Headers(init.headers).entries()].sort(),
    ]),
  );
  let snapshot: Snapshot;
  if (!cacheSeconds) {
    snapshot = await network(url, init, purpose);
    if (snapshot.status === 200 && validate) {
      try {
        validate(snapshot.body);
      } catch (error) {
        upstreamEvent(purpose, "validation_error");
        throw error;
      }
    }
  } else {
    upstreamEvent(purpose, "cache_lookup");
    const pending = state.pending.get(key);
    if (pending) {
      upstreamEvent(purpose, "coalesced");
      snapshot = await pending;
    } else {
      const task = (async () => {
        let fetchedId: string | undefined;
        const cached = unstable_cache(
          async () => {
            const result = await network(url, init, purpose);
            if (result.status !== 200) throw new UncacheableResponse(result);
            try {
              validate?.(result.body);
            } catch (error) {
              upstreamEvent(purpose, "validation_error");
              throw error;
            }
            fetchedId = result.requestId;
            return result;
          },
          ["upstream-metadata-v1", key],
          { revalidate: cacheSeconds },
        );
        try {
          const result = await cached();
          upstreamEvent(
            purpose,
            fetchedId === result.requestId ? "cache_miss" : "cache_hit",
          );
          return result;
        } catch (error) {
          if (error instanceof UncacheableResponse) return error.snapshot;
          // CLI scripts have no Next request context/cache. Still pace and
          // meter their real requests rather than trying to cache via Next.
          if (
            error instanceof Error &&
            error.message.includes("incrementalCache missing")
          ) {
            upstreamEvent(purpose, "cache_bypass");
            return network(url, init, purpose);
          }
          throw error;
        }
      })();
      state.pending.set(key, task);
      try {
        snapshot = await task;
      } finally {
        state.pending.delete(key);
      }
    }
  }
  const headers = new Headers(snapshot.headers);
  headers.set("x-transcripts-observed-at", snapshot.observedAt);
  return new Response(
    snapshot.status === 204 || snapshot.status === 304 ? null : snapshot.body,
    { status: snapshot.status, headers },
  );
}
