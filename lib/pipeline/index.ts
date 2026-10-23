import { AzureOpenAI } from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import "@/lib/load-env";
import { setSpeakerMapping, type SpeakerInfo } from "@/lib/speakers";
import {
  getTranscriptById,
  updateTranscriptContent,
  updateTranscriptionStatus,
  touchHeartbeat,
} from "@/lib/db";
import {
  trackOpenAIChatCompletion,
  UsageOperations,
  UsageStages,
} from "@/lib/usage-tracking";
import { getAnalysisModel } from "@/lib/providers/models";
import { getLanguageFullName } from "@/lib/languages";
import {
  type ParagraphInput,
  type SpeakerMapping,
  normalizeText,
  speakersEqual,
  buildStatementsWithSentences,
  IDENTIFICATION_RULES,
  INTERPRETED_SPEECH_RULES,
  COMMON_ABBREVIATIONS,
  SCHEMA_DEFINITIONS,
} from "./shared";
import { resegmentParagraph } from "./resegment";
import { defineTopics } from "./define-topics";
import { tagSentencesWithTopics } from "./tag-sentences";

// Re-exports preserve the historical public API of speaker-identification.ts.
export {
  normalizeText,
  speakersEqual,
  matchWordsToText,
  buildStatementsWithSentences,
} from "./shared";
export type {
  ParagraphWord,
  ParagraphInput,
  StatementWithSentences,
  SpeakerMapping,
} from "./shared";
export { analyzePropositions } from "./analyze-propositions";
export type {
  EvidenceQuote,
  Position,
  Proposition,
} from "./analyze-propositions";

const API_VERSION = "2025-01-01-preview";

/** Run async tasks with a concurrency limit */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

const ParagraphSpeakerMapping = z.object({
  // Whole-transcript verdict. Complements the per-paragraph `is_off_record`
  // flag (which is deliberately restricted to the very start/end): a recording
  // that contains NO substantive proceedings at all — silence-dominated feeds
  // where the ASR transcribed ambience as words (SYNTHESIS §13.4) — can only
  // be caught by a transcript-level judgment. `reason` is internal
  // (error_message), never shown to users.
  transcript_assessment: z.object({
    is_substantive: z.boolean(),
    reason: z.string(),
  }),
  paragraphs: z.array(
    z.object({
      index: z.number(),
      name: z.string().nullable(),
      function: z.string().nullable(),
      affiliation: z.string().nullable(),
      group: z.string().nullable(),
      has_multiple_speakers: z.boolean(),
      is_off_record: z.boolean(),
    }),
  ),
});

function createOpenAIClient() {
  return new AzureOpenAI({
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiVersion: API_VERSION,
  });
}

export async function identifySpeakers(
  paragraphs: ParagraphInput[],
  transcriptId?: string,
  prebuiltMapping?: SpeakerMapping,
  sourceLanguage?: string,
) {
  if (!paragraphs?.length) {
    throw new Error("No paragraphs provided");
  }

  // Resolve source language from the transcript record if not provided by the
  // caller. The downstream prompts use this to emit free-text fields in the
  // transcript's language (topic labels, group names, etc.).
  let resolvedSourceLanguage = sourceLanguage;
  if (!resolvedSourceLanguage && transcriptId) {
    const transcriptRow = await getTranscriptById(transcriptId);
    resolvedSourceLanguage = transcriptRow?.language_code ?? undefined;
  }
  const langName = getLanguageFullName(resolvedSourceLanguage ?? "en");

  const client = createOpenAIClient();
  let finalParagraphs = [...paragraphs];
  let finalMapping: SpeakerMapping = {};
  // Whole-transcript verdict from the speaker-ID call (legacy path only).
  // The prebuilt-mapping path skips that call, so it defaults to substantive.
  let assessment = { is_substantive: true, reason: "" };

  if (prebuiltMapping) {
    // Gemini path: speaker identity already resolved — skip OpenAI speaker ID + resegmentation
    console.log(
      `  → Using pre-built speaker mapping for ${paragraphs.length} paragraphs (Gemini path)...`,
    );
    finalMapping = { ...prebuiltMapping };
  } else {
    // Legacy path: identify speakers via OpenAI (for transcripts without pre-built mapping)
    console.log(`  → Analyzing ${paragraphs.length} paragraphs...`);

    const transcriptParts = paragraphs.map((para, index) => {
      const asrSpeaker = para.speaker || para.words?.[0]?.speaker || "Unknown";
      return `[${index}] (ASR: Speaker ${asrSpeaker}) ${para.text}`;
    });

    const completion = await trackOpenAIChatCompletion({
      client,
      transcriptId,
      stage: UsageStages.identifyingSpeakers,
      operation: UsageOperations.initialSpeakerMapping,
      model: getAnalysisModel(),
      requestMeta: { paragraph_count: paragraphs.length },
      request: {
        model: getAnalysisModel(),
        reasoning_effort: "medium" as const,
        messages: [
          {
            role: "system",
            content: `You are an expert at identifying speakers in UN proceedings. For each paragraph in the transcript, extract the speaker's name, function/title, affiliation, and country-group information strictly from the context.

OUTPUT LANGUAGE: ${langName}
- The transcript is in ${langName}. Write free-text fields (function/title, group description) in ${langName}.
- Speaker names come verbatim from the transcript — keep them in their original script (do not transliterate).
- Affiliation should be an ISO-3166 country code or recognized organization abbreviation (e.g., USA, FRA, UN, WHO, UNICEF) — never localize these codes.

CRITICAL: Identify the participant whose intervention each paragraph conveys, including speech through interpretation. Do not attribute introductions to the person being introduced.

TASK:
- Each paragraph is numbered [0], [1], [2], etc.
- Each paragraph has an ASR speaker label (A, B, C, etc.) - these are HINTS from automatic diarization
- WARNING: ASR labels may be incorrect or inconsistent - use them as hints, not facts
- For each paragraph, identify the owner of the intervention based on text and conversational context
- IMPORTANT: If a paragraph contains "I invite X" or "X has the floor", the speaker is the person doing the inviting/giving the floor (usually the Chair), NOT X
- X will speak in SUBSEQUENT paragraphs
- When a speaker continues across multiple paragraphs, repeat their information
- Process EVERY paragraph from [0] to [last]. Never stop early.

MIXED SPEAKER DETECTION:
Your task is to determine: Does this paragraph contain interventions belonging to multiple different participants?

Focus on whose intervention is conveyed, including interpretation. Ask yourself:
- Does the whole paragraph belong to one participant's intervention?
- Or does it contain interventions from different participants?

Common scenarios where paragraphs mix speakers:
  - Previous speaker finishes their remarks, then chair/moderator responds
  - Chair gives floor to someone, and that person begins speaking
  - Question and answer both captured in same paragraph
  - Brief exchanges between people in informal settings
  - Speaker concludes, procedural language follows

Helpful indicators (but not hard rules):
  - Shift from one person's remarks to another person's procedural language
  - Topic/tone/perspective changes midway through paragraph
  - First-person speech mixed with third-person procedural descriptions
  - ASR speaker labels changing within the paragraph
  - Phrases like "I give/invite/call upon [Name]" followed by more text

NOT mixed speakers:
  - Opening courtesies within one person's speech ("Thank you, Chair. Today I will discuss...")
  - One person's continuous remarks, even if long or referring to others
  - Rhetorical questions, quotes, or historical references within one speech
  - Pure procedural language from one chair/moderator

When uncertain, flag it - we'll verify during resegmentation. The goal is to catch genuine multi-speaker paragraphs while avoiding obvious false positives.

OFF-RECORD CONTENT DETECTION:
Mark is_off_record = true for paragraphs that are clearly NOT part of the formal meeting/proceeding.

ONLY mark paragraphs at the VERY START or VERY END of the transcript. NEVER mark middle paragraphs.

Examples of off-record content:
  - Pre-meeting small talk, audio testing, technical checks
  - "Can you hear me?", "Testing, testing", "Is the mic on?"
  - Private conversations before the meeting starts
  - Gibberish, single words with no context (e.g., just "It", just "Okay")
  - Post-meeting informal remarks clearly after formal closing
  - Background noise transcribed as words

Only mark as off-record when it's VERY CLEAR the content is not part of the official proceeding.
If uncertain, mark as false - better to include too much than exclude formal content.

Typical patterns:
  - First 1-3 paragraphs: check if they're pre-meeting chatter before formal opening
  - Last 1-3 paragraphs: check if they're post-meeting remarks after formal closing
  - Middle paragraphs: ALWAYS mark is_off_record = false

TRANSCRIPT-LEVEL ASSESSMENT:
Separately from the per-paragraph flags, assess the transcript AS A WHOLE and
report it in transcript_assessment.

Substantive means FORMAL CONTENT: official proceedings, statements,
briefings, Q&A sessions, or press encounters. Genuine-but-incidental speech
does NOT make a transcript substantive — visitor tours, waiting-room or
corridor conversations, private small talk between individuals, and other
real speech captured by an open microphone are all non-substantive.

Set is_substantive = false when the ENTIRE recording contains no formal
content — for example:
  - Ambient noise, music, or background audio transcribed as words
  - Repetition loops, fragments, or gibberish throughout
  - Only incidental speech: tour groups, corridor chatter, mic checks,
    private conversations — real voices, but no proceedings
  - Text that reads as speech-recognition artifacts rather than real speech

If ANY portion of the transcript is a genuine statement, briefing, Q&A, or
press encounter — even a short one at the very end of a long recording — set
is_substantive = true. When uncertain whether some portion is formal content,
set true: hiding real proceedings is far worse than showing a poor
transcript. But do not treat mere incidental conversation as that portion.

In the reason field, give one short English sentence explaining the verdict
(internal diagnostics only — never shown to users).

${IDENTIFICATION_RULES}

${COMMON_ABBREVIATIONS}

${SCHEMA_DEFINITIONS}

has_multiple_speakers: Boolean - True only if this paragraph contains interventions from different participants. Original speech and its interpretation belong to the same participant.

is_off_record: Boolean - Is this paragraph clearly NOT part of the formal meeting? Only true for paragraphs at the very start/end that are obviously pre-meeting chatter, audio tests, gibberish, or post-meeting remarks. When uncertain, use false.

transcript_assessment: Object - Whole-transcript verdict. is_substantive: false only when the ENTIRE recording clearly contains no real proceedings/statements (see TRANSCRIPT-LEVEL ASSESSMENT above); reason: one short English sentence (internal only).


${INTERPRETED_SPEECH_RULES}`,
          },
          {
            role: "user",
            content: `Analyze the following UN transcript and identify the speaker for each numbered paragraph.

Transcript:
${transcriptParts.join("\n\n")}`,
          },
        ],
        response_format: zodResponseFormat(
          ParagraphSpeakerMapping,
          "paragraph_speaker_mapping",
        ),
      },
    });

    const result = completion.choices[0]?.message?.content;
    if (!result) throw new Error("Failed to identify speakers");

    const parsed = JSON.parse(result) as z.infer<
      typeof ParagraphSpeakerMapping
    >;
    console.log(`  ✓ Initial identification complete`);

    assessment = parsed.transcript_assessment ?? assessment;
    if (!assessment.is_substantive) {
      console.log(
        `  ℹ Transcript assessed as non-substantive: ${assessment.reason}`,
      );
    }

    // Log off-record paragraphs
    const offRecord = parsed.paragraphs
      .filter((p) => p.is_off_record)
      .map((p) => p.index);
    if (offRecord.length > 0) {
      console.log(
        `  ℹ Found ${offRecord.length} off-record paragraph(s): [${offRecord.join(", ")}]`,
      );
    }

    // Collect paragraphs needing resegmentation. Splitting a paragraph into
    // sub-segments requires per-word timing to place the split boundary in
    // time; without words a paragraph is already the smallest honest unit, so
    // skip it (no fabricated sub-timing). Off-record paragraphs are hidden at
    // the serving boundary (lib/off-record.ts), so resegmenting them would
    // spend an LLM call on content nobody will ever see.
    const toResegment = parsed.paragraphs
      .filter((p) => p.has_multiple_speakers && !p.is_off_record)
      .map((p) => p.index)
      .filter((idx) => (paragraphs[idx]?.words?.length ?? 0) > 0);

    // Build initial mapping
    parsed.paragraphs.forEach((para) => {
      finalMapping[para.index.toString()] = {
        name: para.name,
        function: para.function,
        affiliation: para.affiliation,
        group: para.group,
        is_off_record: para.is_off_record || undefined,
      };
    });

    // Resegment in parallel
    if (toResegment.length > 0) {
      console.log(
        `  → Found ${toResegment.length} paragraph(s) with mixed speakers: [${toResegment.join(", ")}]`,
      );

      const CONTEXT_SIZE = 3; // Number of paragraphs before and after

      // Resegmentation is the longest stage on big debates. Refresh the
      // heartbeat at most every 30s as paragraphs complete so the liveness
      // sweep doesn't treat a slow-but-alive job as dead. (The per-worker
      // tick already does this every 60s; this is an extra in-stage refresh
      // that costs almost nothing.)
      let lastHeartbeat = Date.now();
      const heartbeat = async () => {
        if (!transcriptId) return;
        if (Date.now() - lastHeartbeat < 30_000) return;
        lastHeartbeat = Date.now();
        await touchHeartbeat(transcriptId).catch(() => {});
      };

      const resegmented = await mapWithConcurrency(
        toResegment,
        10,
        async (idx) => {
          const para = paragraphs[idx];
          const speaker = finalMapping[idx.toString()];

          // Gather context paragraphs
          const contextParas: Array<{
            para: ParagraphInput;
            speaker: SpeakerInfo;
            position: "before" | "current" | "after";
          }> = [];

          // Add before context
          for (let i = Math.max(0, idx - CONTEXT_SIZE); i < idx; i++) {
            contextParas.push({
              para: paragraphs[i],
              speaker: finalMapping[i.toString()],
              position: "before",
            });
          }

          // Add current
          contextParas.push({
            para: para,
            speaker: speaker,
            position: "current",
          });

          // Add after context
          for (
            let i = idx + 1;
            i <= Math.min(paragraphs.length - 1, idx + CONTEXT_SIZE);
            i++
          ) {
            contextParas.push({
              para: paragraphs[i],
              speaker: finalMapping[i.toString()],
              position: "after",
            });
          }

          const result = await resegmentParagraph(
            client,
            para,
            contextParas,
            idx,
            transcriptId,
          );
          await heartbeat();
          return { index: idx, ...result };
        },
      );
      console.log(`  ✓ Resegmentation and speaker identification complete`);
      console.log(`  → Rebuilding transcript with split paragraphs...`);

      // Rebuild paragraphs array and mapping
      const newParagraphs: ParagraphInput[] = [];
      const newMapping: SpeakerMapping = {};
      let currentNewIndex = 0;

      for (let i = 0; i < paragraphs.length; i++) {
        const reseg = resegmented.find((r) => r.index === i);

        if (reseg) {
          // Replace with segments. `resegmentParagraph` rebuilds SpeakerInfo
          // from its own schema, which has no `is_off_record` — so the parent's
          // flag has to be carried across explicitly or a split off-record
          // paragraph survives the filter below.
          const parentOffRecord = finalMapping[i.toString()]?.is_off_record;
          for (let j = 0; j < reseg.segments.length; j++) {
            newParagraphs.push(reseg.segments[j]);
            newMapping[currentNewIndex.toString()] = parentOffRecord
              ? { ...reseg.speakers[j], is_off_record: true }
              : reseg.speakers[j];
            currentNewIndex++;
          }
        } else {
          // Keep original
          newParagraphs.push(paragraphs[i]);
          newMapping[currentNewIndex.toString()] = finalMapping[i.toString()];
          currentNewIndex++;
        }
      }

      finalParagraphs = newParagraphs;
      finalMapping = newMapping;
      console.log(
        `  ✓ Rebuilt transcript: ${paragraphs.length} → ${finalParagraphs.length} paragraphs`,
      );
    }
  } // end legacy path (else block)

  // Off-record paragraphs are KEPT (flagged in the mapping) rather than
  // hard-deleted: the data stays in the DB for auditing while every serving
  // surface hides flagged statements via lib/off-record.ts. (The previous
  // hard-delete made the decision unreviewable and unrecoverable.)
  const offRecordIndices = Object.keys(finalMapping)
    .filter((idx) => finalMapping[idx]?.is_off_record)
    .map((idx) => parseInt(idx));
  if (offRecordIndices.length > 0) {
    console.log(
      `  ℹ ${offRecordIndices.length} off-record paragraph(s) flagged (kept in DB, hidden from output): [${offRecordIndices.join(", ")}]`,
    );
  }

  // Group consecutive same-speaker paragraphs
  if (finalParagraphs.length > 0) {
    const groupedParagraphs: ParagraphInput[] = [];
    const groupedMapping: SpeakerMapping = {};

    let currentGroup = { ...finalParagraphs[0] };
    let currentSpeaker = finalMapping["0"];

    for (let i = 1; i < finalParagraphs.length; i++) {
      const para = finalParagraphs[i];
      const speaker = finalMapping[i.toString()];

      // Never merge across an off-record boundary: the serving-side filter
      // hides whole statements, so an off-record paragraph folded into an
      // on-record group would either leak or take real content down with it.
      const sameOffRecord =
        !!currentSpeaker?.is_off_record === !!speaker?.is_off_record;

      if (sameOffRecord && speakersEqual(currentSpeaker, speaker)) {
        const hasWords =
          (currentGroup.words?.length ?? 0) > 0 &&
          (para.words?.length ?? 0) > 0;
        if (hasWords) {
          // Merge with current group, concatenating real word timestamps.
          currentGroup = {
            ...currentGroup,
            text: currentGroup.text + "\n\n" + para.text,
            end: para.end,
            words: [...(currentGroup.words ?? []), ...(para.words ?? [])],
          };
        } else {
          // No word timing: merge text but preserve each provider segment's
          // real start/end as a segment so per-segment sentences can be built.
          const existingSegs = currentGroup.segments ?? [
            {
              text: currentGroup.text,
              start: currentGroup.start,
              end: currentGroup.end,
            },
          ];
          currentGroup = {
            ...currentGroup,
            text: currentGroup.text + "\n\n" + para.text,
            end: para.end,
            segments: [
              ...existingSegs,
              { text: para.text, start: para.start, end: para.end },
            ],
          };
        }
      } else {
        // Save current group and start new
        groupedParagraphs.push(currentGroup);
        groupedMapping[groupedParagraphs.length - 1] = currentSpeaker;
        currentGroup = { ...para };
        currentSpeaker = speaker;
      }
    }

    // Don't forget the last group
    groupedParagraphs.push(currentGroup);
    groupedMapping[groupedParagraphs.length - 1] = currentSpeaker;

    if (groupedParagraphs.length < finalParagraphs.length) {
      console.log(
        `  ✓ Grouped consecutive same-speaker paragraphs: ${finalParagraphs.length} → ${groupedParagraphs.length} paragraphs`,
      );
    }

    finalParagraphs = groupedParagraphs;
    finalMapping = groupedMapping;
  }

  // Build statements with sentences
  const statementsWithSentences = buildStatementsWithSentences(finalParagraphs);

  // Save statements immediately after speaker identification (before topic analysis)
  if (transcriptId) {
    console.log(`  → Saving speaker identification results...`);
    const transcript = await getTranscriptById(transcriptId);
    if (transcript) {
      await updateTranscriptContent(transcriptId, {
        raw_paragraphs: transcript.content.raw_paragraphs,
        statements: statementsWithSentences,
        topics: {},
      });
      await setSpeakerMapping(transcriptId, finalMapping);
      console.log(`  ✓ Saved statements and speaker mappings`);
    }
  }

  // Whole-transcript no-content gate. Fires when the LLM assessed the
  // recording as non-substantive, or when nothing visible remains anyway
  // (no statements at all, or every statement flagged off-record — the
  // "empty after hiding" edge that previously left rows stuck mid-status).
  const visibleStatementCount = statementsWithSentences.filter(
    (_, idx) => !finalMapping[idx.toString()]?.is_off_record,
  ).length;

  if (
    transcriptId &&
    (!assessment.is_substantive || visibleStatementCount === 0)
  ) {
    const reason = assessment.is_substantive
      ? "No visible statements after off-record flagging"
      : assessment.reason || "LLM assessed transcript as non-substantive";
    console.log(`  ⚠ Marking transcript no_content: ${reason}`);
    // Internal diagnostics only — pollTranscription never exposes
    // error_message for no_content rows.
    await updateTranscriptionStatus(transcriptId, "no_content", reason);
    return finalMapping;
  }

  // Define and tag topics
  let topics: Record<
    string,
    { key: string; label: string; description: string }
  > = {};
  let taggedStatements = statementsWithSentences;

  if (statementsWithSentences.length > 0 && transcriptId) {
    // --- Stage: Analyzing topics ---
    await updateTranscriptionStatus(transcriptId, "analyzing_topics");
    await touchHeartbeat(transcriptId); // keep this worker's liveness signal fresh
    console.log(`  → Analyzing topics...`);

    try {
      topics = await defineTopics(
        finalParagraphs,
        finalMapping,
        client,
        transcriptId,
        resolvedSourceLanguage,
      );
      taggedStatements = await tagSentencesWithTopics(
        statementsWithSentences,
        topics,
        finalMapping,
        client,
        transcriptId,
        resolvedSourceLanguage,
      );

      // Save topics immediately so the frontend can show them while propositions are analyzed
      const transcriptForTopics = await getTranscriptById(transcriptId);
      if (transcriptForTopics) {
        await updateTranscriptContent(transcriptId, {
          raw_paragraphs: transcriptForTopics.content.raw_paragraphs,
          statements: taggedStatements,
          topics,
        });
        console.log(`  ✓ Saved topics`);
      }
    } catch (error) {
      console.warn(
        `  ⚠ Failed to analyze topics:`,
        error instanceof Error ? error.message : error,
      );
      // Keep the statements without topics — still continue to propositions
    }

    // Proposition analysis is intentionally NOT run here — it is always a
    // separate, on-demand step (POST /api/transcripts/[id]/analysis) tracked
    // by analysis_status, so it never blocks or hides the transcript.
    await updateTranscriptionStatus(transcriptId, "completed");
  }

  return finalMapping;
}
