import { AzureOpenAI } from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import type { SpeakerInfo } from "@/lib/speakers";
import {
  trackOpenAIChatCompletion,
  UsageOperations,
  UsageStages,
} from "@/lib/usage-tracking";
import { getAnalysisModel } from "@/lib/providers/models";
import {
  type ParagraphInput,
  type ParagraphWord,
  normalizeText,
  IDENTIFICATION_RULES,
  INTERPRETED_SPEECH_RULES,
  COMMON_ABBREVIATIONS,
  SCHEMA_DEFINITIONS,
} from "./shared";

const ResegmentationResult = z.object({
  should_split: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string(),
  segments: z.array(
    z.object({
      text: z.string(),
      name: z.string().nullable(),
      function: z.string().nullable(),
      affiliation: z.string().nullable(),
      group: z.string().nullable(),
    }),
  ),
});

export async function resegmentParagraph(
  client: AzureOpenAI,
  paragraph: ParagraphInput,
  contextParas: Array<{
    para: ParagraphInput;
    speaker: SpeakerInfo;
    position: "before" | "current" | "after";
  }>,
  paragraphIndex?: number,
  transcriptId?: string,
): Promise<{ segments: ParagraphInput[]; speakers: SpeakerInfo[] }> {
  const formatSpeaker = (s: SpeakerInfo) => {
    const parts = [];
    if (s?.name) parts.push(`name: "${s.name}"`);
    if (s?.function) parts.push(`function: "${s.function}"`);
    if (s?.affiliation) parts.push(`affiliation: "${s.affiliation}"`);
    if (s?.group) parts.push(`group: "${s.group}"`);
    return parts.length > 0 ? `{ ${parts.join(", ")} }` : "{ unknown }";
  };

  const formatPara = (p: ParagraphInput, s: SpeakerInfo, label: string) => {
    const text = p.text;
    const preview = text.length > 150 ? text.substring(0, 150) + "..." : text;
    return `${label}:\nSpeaker: ${formatSpeaker(s)}\nText: ${preview}`;
  };

  const beforeParas = contextParas.filter((c) => c.position === "before");
  const currentPara = contextParas.find((c) => c.position === "current")!;
  const afterParas = contextParas.filter((c) => c.position === "after");
  const currentSpeaker = currentPara.speaker;

  // Collect all known speakers from context for reference
  const knownSpeakers = contextParas
    .filter((c) => c.speaker?.name)
    .map((c) => formatSpeaker(c.speaker));
  const uniqueKnownSpeakers = [...new Set(knownSpeakers)];

  const contextParts = [
    ...beforeParas
      .reverse()
      .map((c, i) =>
        formatPara(c.para, c.speaker, `BEFORE-${beforeParas.length - i}`),
      ),
    `CURRENT (TO SPLIT):\nSpeaker: ${formatSpeaker(currentSpeaker)}\nText: ${paragraph.text}`,
    ...afterParas.map((c, i) =>
      formatPara(c.para, c.speaker, `AFTER+${i + 1}`),
    ),
  ];

  const context = contextParts.join("\n\n");

  const knownSpeakersSection =
    uniqueKnownSpeakers.length > 0
      ? `\n\nKNOWN SPEAKERS (from previous identification - REUSE these exact labels when applicable):\n${uniqueKnownSpeakers.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
      : "";

  const completion = await trackOpenAIChatCompletion({
    client,
    transcriptId,
    stage: UsageStages.resegmenting,
    operation: UsageOperations.resegmentParagraph,
    model: getAnalysisModel(),
    requestMeta: {
      paragraph_index: paragraphIndex ?? null,
      context_size: contextParas.length,
    },
    request: {
      model: getAnalysisModel(),
      reasoning_effort: "medium" as const,
      messages: [
        {
          role: "system",
          content: `You are an expert at correcting speaker segmentation errors in UN proceedings transcripts.

BACKGROUND:
This transcript was created by automatic speech recognition, which divided the audio into paragraphs. However, the automatic paragraph boundaries are sometimes incorrect - a paragraph may contain the end of one speaker's remarks followed by the beginning of another speaker's remarks, all incorrectly grouped together.

In an initial identification pass, we detected that the CURRENT paragraph likely contains speech from multiple different speakers mixed together (e.g., the last few sentences of one speaker followed by the first sentences of the next speaker).

YOUR TASK:
Determine whose intervention each part of the CURRENT paragraph conveys. Split only at boundaries between different participants' interventions, including genuine chair handoffs and questions/answers.

You are provided context:
- BEFORE-N paragraphs: Who was speaking before, providing conversation flow
- CURRENT paragraph: The paragraph to evaluate (may contain multiple speakers)
- AFTER+N paragraphs: Who speaks next, helping identify transitions

FUNDAMENTAL QUESTION:
Does the entire CURRENT paragraph convey one participant's intervention, including interpretation, or interventions belonging to different participants?

Think semantically, not by keyword patterns:
- WHO is saying the opening words?
- WHO is saying the closing words?
- Does the speaker change in the middle?
- Use BEFORE/AFTER context to understand who should be speaking when

DECISION PROCESS:

1. Analyze the content semantically:
   - If one participant's intervention continues, including through interpretation → should_split = false
   - If different participants' interventions occupy different parts → should_split = true
   - Look for actual speaker changes, not just topic shifts within one speech

2. Common scenarios where splitting IS needed:
   - Previous speaker finishes, then chair/moderator speaks
   - Chair hands off floor, and next speaker begins
   - Question from one person, answer from another
   - Brief back-and-forth exchanges

3. Common scenarios where splitting is NOT needed:
   - Opening formalities as part of one speech: "Thank you, Chair. Today I will..."
   - One person's continuous remarks, however long
   - Rhetorical devices, quotes, or references within one speech

4. If should_split = true:
   - Split at EACH speaker boundary
   - Return exact text for each segment (one segment per speaker)
   - Identify who is speaking each segment
   - Text integrity: concatenated segments MUST equal original exactly

5. IMPORTANT - Reuse known speaker labels:
   - A list of KNOWN SPEAKERS (already identified) is provided below the context
   - When a segment is spoken by a known speaker, COPY their exact name/function/affiliation/group
   - Do NOT re-identify or vary the labels - use them exactly as provided
   - This ensures consistency across the transcript

6. Set confidence and reason:
   - confidence: "high" if clear speaker changes, "medium" if somewhat ambiguous, "low" if uncertain
   - reason: Brief explanation focused on WHO is speaking and why you're splitting/not splitting

${IDENTIFICATION_RULES}

${COMMON_ABBREVIATIONS}

${SCHEMA_DEFINITIONS}

should_split: Boolean - True only for boundaries between different participants' interventions; false for original/interpretation alternation alone.

confidence: Your confidence in determining who is speaking:
- "high": Very clear who speaks each part
- "medium": Reasonably clear but some ambiguity
- "low": Uncertain about speaker boundaries

reason: Brief explanation (1-2 sentences) focusing on WHO is speaking. Examples: "Delegate finishes remarks, then chair responds" or "One continuous speech by the representative, opening courtesy is part of their remarks".

text: EXACT text of each segment, copied character-by-character from the CURRENT paragraph. Every word, comma, period, space must be preserved exactly. Do NOT include speaker labels, prefixes like "(Speaker: ...)", or other metadata - ONLY the actual spoken words.


${INTERPRETED_SPEECH_RULES}`,
        },
        {
          role: "user",
          content: `Analyze the CURRENT paragraph in context and determine if it should be split:

${context}${knownSpeakersSection}

The BEFORE and AFTER paragraphs provide context about the conversation flow. Use them to understand:
- Who was speaking before
- Who speaks after
- Whether the CURRENT paragraph likely contains a transition between these speakers

IMPORTANT: When identifying speakers for segments, REUSE the exact labels from KNOWN SPEAKERS above. Do not vary or re-identify speakers that are already known.

If you determine the CURRENT paragraph should be split, copy the exact text from the "Text:" line of the CURRENT paragraph (not from BEFORE/AFTER paragraphs) and split it at speaker boundaries, returning each segment with its speaker identification.`,
        },
      ],
      response_format: zodResponseFormat(
        ResegmentationResult,
        "resegmentation",
      ),
    },
  });

  const result = completion.choices[0]?.message?.content;
  const finishReason = completion.choices[0]?.finish_reason;

  if (!result) {
    if (finishReason === "content_filter") {
      const indexStr =
        paragraphIndex !== undefined ? ` [${paragraphIndex}]` : "";
      console.warn(
        `  ⚠ Content filter triggered for paragraph${indexStr}, keeping original unsplit`,
      );
      return {
        segments: [paragraph],
        speakers: [currentSpeaker],
      };
    }
    console.error(
      "Resegmentation API response:",
      JSON.stringify(completion, null, 2),
    );
    throw new Error(
      `Failed to resegment paragraph: no content in response. Finish reason: ${finishReason}`,
    );
  }

  let parsed: z.infer<typeof ResegmentationResult>;
  try {
    parsed = JSON.parse(result);
  } catch (e) {
    console.error("Failed to parse resegmentation result:", result);
    throw new Error(
      `Failed to parse resegmentation JSON: ${e instanceof Error ? e.message : e}`,
    );
  }

  // Check if splitting is recommended
  if (!parsed.should_split) {
    const indexStr = paragraphIndex !== undefined ? ` [${paragraphIndex}]` : "";
    console.log(
      `  → Para${indexStr} kept unsplit (${parsed.confidence} confidence): ${parsed.reason}`,
    );
    return {
      segments: [paragraph],
      speakers: [currentSpeaker],
    };
  }

  // For low confidence splits, keep original
  if (parsed.confidence === "low") {
    const indexStr = paragraphIndex !== undefined ? ` [${paragraphIndex}]` : "";
    console.warn(
      `  ⚠ Low confidence split for para${indexStr}, keeping original: ${parsed.reason}`,
    );
    return {
      segments: [paragraph],
      speakers: [currentSpeaker],
    };
  }

  // Reject the whole proposal on any integrity or timing-alignment failure.
  // Partial splits can shift the remaining speaker labels or silently lose text.
  const keepOriginal = (reason: string) => {
    console.warn(`  ⚠ Rejected resegmentation; keeping original: ${reason}`);
    return { segments: [paragraph], speakers: [currentSpeaker] };
  };

  if (parsed.segments.length < 2) {
    return keepOriginal("fewer than two segments");
  }

  // Verify content integrity
  const originalNormalized = normalizeText(paragraph.text);
  const segmentsNormalized = normalizeText(
    parsed.segments.map((s) => s.text).join(" "),
  );

  if (originalNormalized !== segmentsNormalized) {
    return keepOriginal("segment text differs from source text");
  }
  if (parsed.segments.some((segment) => !normalizeText(segment.text))) {
    return keepOriginal("empty segment text");
  }

  // Splitting requires per-word timing to place each segment's boundary in
  // time. Word-less paragraphs are never sent here (see index.ts), but guard
  // anyway: keep them unsplit rather than fabricate sub-timing.
  const paraWords = paragraph.words;
  if (!paraWords || paraWords.length === 0) {
    return keepOriginal("no word timestamps");
  }

  // Match segment texts to words
  const segments: ParagraphInput[] = [];
  const speakers: SpeakerInfo[] = [];
  let wordOffset = 0;

  for (const seg of parsed.segments) {
    const segNormalized = normalizeText(seg.text);
    const words: ParagraphWord[] = [];
    let matchedNormalized = "";

    while (
      wordOffset < paraWords.length &&
      matchedNormalized.length < segNormalized.length
    ) {
      words.push(paraWords[wordOffset]);
      matchedNormalized = normalizeText(words.map((w) => w.text).join(" "));
      wordOffset++;
    }

    // Equal character counts alone do not establish a word boundary: a split
    // can land inside a source word or the word stream can disagree with text.
    if (words.length === 0 || matchedNormalized !== segNormalized) {
      return keepOriginal("segment does not match a complete source word span");
    }

    segments.push({
      text: words.map((w) => w.text).join(" "),
      start: words[0].start,
      end: words[words.length - 1].end,
      words,
    });
    speakers.push({
      name: seg.name,
      function: seg.function,
      affiliation: seg.affiliation,
      group: seg.group,
    });
  }

  if (wordOffset !== paraWords.length) {
    return keepOriginal("unconsumed source words");
  }

  const indexStr = paragraphIndex !== undefined ? ` [${paragraphIndex}]` : "";
  console.log(
    `  ✓ Para${indexStr} split into ${segments.length} (${parsed.confidence} confidence): ${parsed.reason}`,
  );
  return { segments, speakers };
}
