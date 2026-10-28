import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  automaticIndexNowEnabled,
  INDEXNOW_KEY,
  INDEXNOW_KEY_URL,
  INDEXNOW_ORIGIN,
  indexNowUrls,
  submitIndexNow,
  verifyIndexNowKey,
} from "./indexnow";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => {}) }));
const url = `${INDEXNOW_ORIGIN}/en/sc/10245`;
const request = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", request);
  vi.spyOn(console, "log").mockImplementation(() => {});
  request.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("IndexNow delivery", () => {
  it("ships an ownership file matching the submitted key", () => {
    expect(readFileSync(`public/${INDEXNOW_KEY}.txt`, "utf8").trim()).toBe(
      INDEXNOW_KEY,
    );
  });
  it("sends deduplicated URLs with the ownership proof, not transcript content", async () => {
    request.mockResolvedValue(new Response(null, { status: 202 }));
    expect(await submitIndexNow([url, url, `${url}.txt`])).toBe(2);
    expect(request).toHaveBeenCalledTimes(1);
    const [endpoint, init] = request.mock.calls[0];
    expect(endpoint).toBe("https://www.bing.com/indexnow");
    expect(JSON.parse(init!.body as string)).toEqual({
      host: "transcripts.un.org",
      key: INDEXNOW_KEY,
      keyLocation: INDEXNOW_KEY_URL,
      urlList: [url, `${url}.txt`],
    });
  });
  it("validates the entire list before any external request", async () => {
    await expect(
      submitIndexNow([url, "https://other.example/en/sc/1"]),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(() => indexNowUrls([`${INDEXNOW_ORIGIN}/en/login`])).toThrow();
    expect(() => indexNowUrls([`${url}?token=private`])).toThrow();
    expect(indexNowUrls([`${INDEXNOW_ORIGIN}/fr/cerd/100.txt`])).toHaveLength(
      1,
    );
  });
  it("retries transient failures and stops after three attempts", async () => {
    request
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(await submitIndexNow([url])).toBe(1);
    expect(request).toHaveBeenCalledTimes(3);
    request.mockReset().mockResolvedValue(new Response(null, { status: 503 }));
    await expect(submitIndexNow([url])).rejects.toThrow("503");
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("does not retry rejected ownership and splits large submissions", async () => {
    request.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(submitIndexNow([url])).rejects.toThrow("403");
    expect(request).toHaveBeenCalledTimes(1);
    request
      .mockReset()
      .mockImplementation(async () => new Response(null, { status: 200 }));
    const urls = Array.from(
      { length: 1001 },
      (_, i) => `${INDEXNOW_ORIGIN}/en/sc/${i + 1}`,
    );
    expect(await submitIndexNow(urls)).toBe(1001);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("rejects an undeployed or incorrect verification file", async () => {
    request.mockResolvedValueOnce(new Response("404", { status: 404 }));
    await expect(verifyIndexNowKey()).rejects.toThrow("Deploy");
    request.mockResolvedValueOnce(new Response("wrong"));
    await expect(verifyIndexNowKey()).rejects.toThrow("Deploy");
    request.mockResolvedValueOnce(new Response(INDEXNOW_KEY + "\n"));
    await expect(verifyIndexNowKey()).resolves.toBeUndefined();
  });
  it("enables automatic delivery only for the canonical production deployment", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BASE_URL", INDEXNOW_ORIGIN);
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("INDEXNOW_ENABLED", "true");
    expect(automaticIndexNowEnabled()).toBe(true);
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(automaticIndexNowEnabled()).toBe(false);
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("BASE_URL", "https://preview.example");
    expect(automaticIndexNowEnabled()).toBe(false);
    vi.stubEnv("BASE_URL", INDEXNOW_ORIGIN);
    vi.stubEnv("NODE_ENV", "development");
    expect(automaticIndexNowEnabled()).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INDEXNOW_ENABLED", "false");
    expect(automaticIndexNowEnabled()).toBe(false);
  });
});
