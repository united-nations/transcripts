import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cache = vi.hoisted(() => new Map<string, unknown>());
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>, keys: string[]) => async () => {
    const key = keys.join(":");
    if (cache.has(key)) return cache.get(key);
    const value = await fn();
    cache.set(key, value);
    return value;
  },
}));

beforeEach(() => {
  vi.resetModules();
  cache.clear();
  delete (globalThis as Record<string, unknown>).__transcriptsUpstream;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const url = "https://webtv.un.org/en/asset/test";
const options = { purpose: "webtv_metadata" as const, cacheSeconds: 10800 };

describe("metered upstream requests", () => {
  it("counts one actual fetch for concurrent and cached readers, with independent response bodies", async () => {
    const fetcher = vi.fn(async () => new Response("metadata"));
    vi.stubGlobal("fetch", fetcher);
    const { upstreamFetch } = await import("./upstream-http");
    const [a, b] = await Promise.all([
      upstreamFetch(url, {}, options),
      upstreamFetch(url, {}, options),
    ]);
    const c = await upstreamFetch(url, {}, options);
    expect(await Promise.all([a.text(), b.text(), c.text()])).toEqual([
      "metadata",
      "metadata",
      "metadata",
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const init = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(init[1].cache).toBe("no-store");
    expect(new Headers(init[1].headers).get("User-Agent")).toBe(
      "Transcripts-Metadata-Sync/1.0 (+https://transcripts.un.org/)",
    );
    const events = vi
      .mocked(console.error)
      .mock.calls.map(([line]) => JSON.parse(String(line)).event);
    expect(events.filter((e) => e === "network")).toHaveLength(1);
    expect(events).toContain("coalesced");
    expect(events).toContain("cache_hit");
  });

  it("keeps removal probes fresh even when visitor metadata is cached", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("old"))
      .mockResolvedValueOnce(new Response("gone", { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    const { upstreamFetch } = await import("./upstream-http");
    await upstreamFetch(url, {}, options);
    const fresh = await upstreamFetch(url, {}, { purpose: "webtv_removal" });
    expect(fresh.status).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await (await upstreamFetch(url, {}, options)).text()).toBe("old");
  });

  it("does not cache HTTP failures or Kaltura API exceptions", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("gone", { status: 404 }))
      .mockResolvedValueOnce(new Response("good"));
    vi.stubGlobal("fetch", fetcher);
    const { upstreamFetch } = await import("./upstream-http");
    expect((await upstreamFetch(url, {}, options)).status).toBe(404);
    expect(await (await upstreamFetch(url, {}, options)).text()).toBe("good");
    const { validateKalturaResponse } = await import("./kaltura-response");
    const kaltura = "https://cdnapisec.kaltura.com/api_v3/service/multirequest";
    fetcher.mockResolvedValueOnce(
      new Response('[{"objectType":"KalturaAPIException"}]'),
    );
    const config = {
      purpose: "kaltura_visitor_status" as const,
      cacheSeconds: 300,
      validate: validateKalturaResponse,
    };
    await expect(upstreamFetch(kaltura, {}, config)).rejects.toThrow(
      "Invalid Kaltura",
    );
    fetcher.mockResolvedValueOnce(new Response('[{}, {"objects":[]}]'));
    expect((await upstreamFetch(kaltura, {}, config)).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("honors a long Retry-After across purposes without blocking a handler", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("busy", {
          status: 429,
          headers: { "Retry-After": "120" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const { upstreamFetch } = await import("./upstream-http");
    await expect(upstreamFetch(url, {}, options)).rejects.toThrow(
      "Retry-After",
    );
    await expect(
      upstreamFetch(url, {}, { purpose: "webtv_removal" }),
    ).rejects.toThrow("cooldown");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries a short throttle and counts both network attempts", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("busy", { status: 503, headers: { "Retry-After": "1" } }),
      )
      .mockResolvedValueOnce(new Response("ready"));
    vi.stubGlobal("fetch", fetcher);
    const { upstreamFetch } = await import("./upstream-http");
    expect(await (await upstreamFetch(url, {}, options)).text()).toBe("ready");
    expect(fetcher).toHaveBeenCalledTimes(2);
    const events = vi
      .mocked(console.error)
      .mock.calls.map(([line]) => JSON.parse(String(line)).event);
    expect(events.filter((e) => e === "network")).toHaveLength(2);
  });

  it("spaces Web TV starts and never exceeds three in-flight requests", async () => {
    let active = 0,
      peak = 0;
    const starts: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        starts.push(Date.now());
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 700));
        active--;
        return new Response("ok");
      }),
    );
    const { upstreamFetch } = await import("./upstream-http");
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        upstreamFetch(`${url}/${i}`, {}, { purpose: "webtv_removal" }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(3);
    for (let i = 1; i < starts.length; i++)
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(270);
  });

  it("meters redirect hops separately", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "/en/asset/canonical" },
        }),
      )
      .mockResolvedValueOnce(new Response("ready"));
    vi.stubGlobal("fetch", fetcher);
    const { upstreamFetch } = await import("./upstream-http");
    expect(await (await upstreamFetch(url, {}, options)).text()).toBe("ready");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0]).toBe(
      "https://webtv.un.org/en/asset/canonical",
    );
    const events = vi
      .mocked(console.error)
      .mock.calls.map(([line]) => JSON.parse(String(line)).event);
    expect(events.filter((e) => e === "network")).toHaveLength(2);
  });

  it("parses both Retry-After forms", async () => {
    const { retryAfterMs } = await import("./upstream-http");
    expect(retryAfterMs("60")).toBe(60_000);
    const now = Date.parse("2026-09-14T12:00:00Z");
    expect(retryAfterMs("Mon, 14 Sep 2026 12:01:00 GMT", now)).toBe(60_000);
    expect(retryAfterMs("nonsense")).toBeNull();
  });
});
