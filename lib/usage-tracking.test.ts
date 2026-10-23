import type { AzureOpenAI } from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ insertProcessingUsageEvent: vi.fn() }));

import { insertProcessingUsageEvent } from "./db";
import { trackOpenAIChatCompletion } from "./usage-tracking";

describe("OpenAI usage accounting", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["gpt-6.1-sol", 0.0682],
    ["gpt-6-luna", 0.00342],
  ])(
    "bills cache writes and counts reasoning once for %s",
    async (model, expectedCost) => {
      const completion = {
        usage: {
          prompt_tokens: 10_000,
          prompt_tokens_details: {
            cached_tokens: 2_000,
            cache_write_tokens: 4_000,
          },
          completion_tokens: 5_000,
          completion_tokens_details: { reasoning_tokens: 3_000 },
          total_tokens: 15_000,
        },
      };
      const client = {
        chat: {
          completions: { create: vi.fn().mockResolvedValue(completion) },
        },
      } as unknown as AzureOpenAI;
      expect(
        await trackOpenAIChatCompletion({
          client,
          transcriptId: "test",
          stage: "analyzing_topics",
          operation: "define_topics",
          model,
          request: { model, messages: [] },
        }),
      ).toBe(completion);

      const event = vi.mocked(insertProcessingUsageEvent).mock.calls[0][0];
      // Preserve inclusive API counters for existing reports; normalize only for pricing.
      expect(event).toMatchObject({
        model,
        input_tokens: 10_000,
        cached_input_tokens: 2_000,
        output_tokens: 5_000,
        reasoning_tokens: 3_000,
        total_tokens: 15_000,
        pricing_meta: { cache_write_input_tokens: 4_000 },
      });
      expect(
        (event.pricing_meta as { estimated_cost_usd: number })
          .estimated_cost_usd,
      ).toBeCloseTo(expectedCost, 8);
    },
  );
});
