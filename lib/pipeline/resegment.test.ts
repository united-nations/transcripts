import type { AzureOpenAI } from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeakerInfo } from "@/lib/speakers";
import type { ParagraphInput } from "./shared";

vi.mock("@/lib/usage-tracking", () => ({
  trackOpenAIChatCompletion: vi.fn(),
  UsageOperations: { resegmentParagraph: "resegment_paragraph" },
  UsageStages: { resegmenting: "resegmenting" },
}));
import { trackOpenAIChatCompletion } from "@/lib/usage-tracking";
import { resegmentParagraph } from "./resegment";

const originalSpeaker: SpeakerInfo = {
  name: null,
  function: "Representative",
  affiliation: "ZAF",
  group: null,
};
const chair: SpeakerInfo = {
  name: null,
  function: "Chair",
  affiliation: null,
  group: null,
};
const brazil: SpeakerInfo = {
  name: null,
  function: "Representative",
  affiliation: "BRA",
  group: null,
};

function paragraph(text = "Thank you. Brazil supports peace."): ParagraphInput {
  const words = text.split(" ").map((word, index) => ({
    text: word,
    start: 1_000 + index * 100,
    end: 1_100 + index * 100,
  }));
  return { text, start: words[0].start, end: words.at(-1)!.end, words };
}

async function split(
  source: ParagraphInput,
  texts: string[],
  speakers = [chair, brazil],
) {
  vi.mocked(trackOpenAIChatCompletion).mockResolvedValue({
    choices: [
      {
        message: {
          content: JSON.stringify({
            should_split: true,
            confidence: "high",
            reason: "Speaker handoff.",
            segments: texts.map((text, i) => ({
              text,
              ...speakers[i % speakers.length],
            })),
          }),
        },
      },
    ],
  } as never);
  return resegmentParagraph({} as AzureOpenAI, source, [
    { para: source, speaker: originalSpeaker, position: "current" },
  ]);
}

function expectOriginal(
  result: Awaited<ReturnType<typeof split>>,
  source: ParagraphInput,
) {
  expect(result.segments).toHaveLength(1);
  expect(result.segments[0]).toBe(source);
  expect(result.speakers).toEqual([originalSpeaker]);
}

describe("resegmentation integrity", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["omitted middle word", ["Thank you.", "Brazil peace."]],
    ["omitted tail", ["Thank you.", "Brazil supports"]],
    ["added text", ["Thank you.", "Brazil strongly supports peace."]],
    ["reordered text", ["Brazil supports peace.", "Thank you."]],
    ["no segments", []],
    ["empty segment", ["Thank you.", "", "Brazil supports peace."]],
  ])("retains the original text and speaker for %s", async (_reason, texts) => {
    const source = paragraph();
    expectOriginal(await split(source, texts), source);
  });

  it("rejects a text-preserving split that lands inside an ASR word", async () => {
    const source = paragraph("Thankyou Brazil.");
    // The normalized concatenation matches, but these are not real word boundaries.
    expectOriginal(await split(source, ["Thank", "you Brazil."]), source);
  });

  it("rejects an aligned-looking prefix that leaves source words unconsumed", async () => {
    const source = paragraph();
    source.words!.push({
      text: "Unrepresented.",
      start: source.end,
      end: source.end + 100,
    });
    source.end += 100;
    expectOriginal(
      await split(source, ["Thank you.", "Brazil supports peace."]),
      source,
    );
  });

  it("rejects word spans with the right length but different text", async () => {
    const source = paragraph();
    source.words![2] = { ...source.words![2], text: "France" };
    expectOriginal(
      await split(source, ["Thank you.", "Brazil supports peace."]),
      source,
    );
  });

  it("preserves every source word, timestamp and speaker on a valid split", async () => {
    const source = paragraph();
    const result = await split(source, [
      "Thank you.",
      "Brazil supports peace.",
    ]);
    expect(result.speakers).toEqual([chair, brazil]);
    expect(result.segments).toEqual([
      {
        text: "Thank you.",
        start: 1_000,
        end: 1_200,
        words: source.words!.slice(0, 2),
      },
      {
        text: "Brazil supports peace.",
        start: 1_200,
        end: 1_500,
        words: source.words!.slice(2),
      },
    ]);
    expect(result.segments.flatMap((segment) => segment.words)).toEqual(
      source.words,
    );
  });

  it("preserves the original word spelling when only model punctuation/case differs", async () => {
    const source = paragraph();
    const result = await split(source, ["THANK YOU", "Brazil supports peace!"]);
    expect(result.segments.map((segment) => segment.text)).toEqual([
      "Thank you.",
      "Brazil supports peace.",
    ]);
  });

  it("validates non-Latin text without collapsing it to empty strings", async () => {
    const source = paragraph("شكرا لكم. نؤيد السلام.");
    const result = await split(source, ["شكرا لكم.", "نؤيد السلام."]);
    expect(result.segments.flatMap((segment) => segment.words)).toEqual(
      source.words,
    );
    expect(result.speakers).toEqual([chair, brazil]);
    expectOriginal(await split(source, ["شكرا لكم.", "نرفض السلام."]), source);
  });

  it("retains wordless source paragraphs rather than inventing timing", async () => {
    const source = paragraph();
    delete source.words;
    expectOriginal(
      await split(source, ["Thank you.", "Brazil supports peace."]),
      source,
    );
  });
});
