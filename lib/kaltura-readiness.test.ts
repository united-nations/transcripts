import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), event: vi.fn() }));
vi.mock("./upstream-http", () => ({
  upstreamFetch: mocks.fetch,
  upstreamEvent: mocks.event,
}));
import {
  createKalturaReadinessProbe,
  getAvailableAudioLanguages,
  getKalturaAudioUrl,
} from "./transcription";

const response = () =>
  new Response(
    JSON.stringify([
      {},
      { objects: [{ id: "1_canonical", objectType: "KalturaMediaEntry" }] },
      {
        objects: [
          {
            tags: "audio_only",
            language: "English",
            status: 2,
            flavorParamsId: 100,
          },
          {
            tags: "audio_only",
            language: "French",
            status: 2,
            flavorParamsId: 200,
          },
          {
            tags: "audio_only",
            language: "Spanish",
            status: 1,
            flavorParamsId: 300,
          },
        ],
      },
    ]),
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockImplementation(async () => response());
});

describe("Kaltura readiness sharing", () => {
  it("shares a response across languages but still selects and validates each track", async () => {
    const probe = createKalturaReadinessProbe();
    const en = await probe("1_player", "english");
    const fr = await probe("1_player", "french");
    await expect(probe("1_player", "spanish")).rejects.toThrow(
      "no flavors ready",
    );
    expect(en.flavorParamId).toBe(100);
    expect(fr.flavorParamId).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0][2]).toMatchObject({
      purpose: "kaltura_readiness",
      cacheSeconds: 0,
    });
  });

  it("fetches again on the next tick and for direct transcription", async () => {
    await createKalturaReadinessProbe()("1_player", "english");
    await createKalturaReadinessProbe()("1_player", "english");
    await getKalturaAudioUrl("1_player", "english");
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(mocks.fetch.mock.calls[2][2]).toMatchObject({
      purpose: "kaltura_audio",
      cacheSeconds: 0,
    });
  });

  it("shares a failed probe only until the next tick", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("fetch failed"));
    const probe = createKalturaReadinessProbe();
    await expect(probe("1_player", "english")).rejects.toThrow("fetch failed");
    await expect(probe("1_player", "french")).rejects.toThrow("fetch failed");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    await createKalturaReadinessProbe()("1_player", "english");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("caches visitor language availability for five minutes, excluding unready tracks", async () => {
    const result = await getAvailableAudioLanguages("1_player");
    expect(mocks.fetch.mock.calls[0][2]).toMatchObject({
      purpose: "kaltura_visitor_languages",
      cacheSeconds: 300,
    });
    expect(result.languages.map((l) => l.language)).toEqual([
      "english",
      "french",
    ]);
  });
});
