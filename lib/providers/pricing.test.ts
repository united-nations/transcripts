import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "./pricing";

describe("token pricing", () => {
  it.each([
    [270_000, 0.0815],
    [271_000, 0.1382],
  ])(
    "applies the Sol long-context tier to the entire prompt (%i cached)",
    (cached, expected) => {
      const cost = estimateCostUsd({
        provider: "openai",
        model: "gpt-6.1-sol",
        inputTokens: 1_000,
        cachedInputTokens: cached,
        cacheWriteInputTokens: 1_000,
        outputTokens: 2_000,
        reasoningTokens: 3_000,
      });
      expect(cost?.costUsd).toBeCloseTo(expected, 8);
    },
  );

  it("still bills Gemini's separately reported thoughts", () => {
    expect(
      estimateCostUsd({
        provider: "gemini",
        model: "gemini-3.5-flash",
        inputTokens: 1_000_000,
        outputTokens: 200_000,
        reasoningTokens: 100_000,
      })?.costUsd,
    ).toBeCloseTo(4.2, 8);
  });
});
