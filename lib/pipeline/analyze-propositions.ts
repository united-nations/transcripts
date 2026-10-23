import { AzureOpenAI } from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import type { SpeakerMapping } from "@/lib/speakers";
import {
  trackOpenAIChatCompletion,
  UsageOperations,
  UsageStages,
} from "@/lib/usage-tracking";
import { getAnalysisModel } from "@/lib/providers/models";
import { getLanguageFullName } from "@/lib/languages";
import type { StatementWithSentences } from "./shared";

const EvidenceQuoteSchema = z.object({
  stakeholder: z.string(),
  quote: z.string(),
  statementIndex: z.number(),
});

const PositionSchema = z.object({
  stance: z.enum(["support", "oppose", "conditional", "neutral"]),
  stakeholders: z.array(z.string()),
  summary: z.string(),
  evidence: z.array(EvidenceQuoteSchema),
});

const PropositionSchema = z.object({
  key: z.string(),
  title: z.string(),
  statement: z.string(),
  positions: z.array(PositionSchema),
});

const PropositionAnalysis = z.object({
  propositions: z.array(PropositionSchema),
});

// Export types
export type EvidenceQuote = z.infer<typeof EvidenceQuoteSchema>;
export type Position = z.infer<typeof PositionSchema>;
export type Proposition = z.infer<typeof PropositionSchema>;

export async function analyzePropositions(
  statements: StatementWithSentences[],
  speakerMapping: SpeakerMapping,
  client: AzureOpenAI,
  transcriptId?: string,
  sourceLanguage?: string,
): Promise<Proposition[]> {
  console.log(`  → Analyzing propositions...`);

  // Speaker mappings are indexed by the final split/grouped statements, never
  // by raw ASR paragraphs. Keep those indices through filtering and verification.
  const statementTexts = statements.map((statement) =>
    statement.paragraphs
      .map((paragraph) =>
        paragraph.sentences.map((sentence) => sentence.text).join(" "),
      )
      .join("\n\n"),
  );
  const substantiveStatements = statementTexts
    .map((text, idx) => {
      const speaker = speakerMapping[idx.toString()];
      const isChair =
        speaker?.function?.toLowerCase().includes("chair") ||
        speaker?.function?.toLowerCase().includes("president") ||
        speaker?.function?.toLowerCase().includes("moderator");
      return { text, index: idx, speaker, isChair };
    })
    .filter(({ isChair, speaker }) => !isChair && !speaker?.is_off_record);

  if (substantiveStatements.length < 2) {
    console.log(
      `  ℹ Too few non-chair statements (${substantiveStatements.length}), skipping proposition analysis`,
    );
    return [];
  }

  // Format: [index] (Speaker) Text...
  const transcriptParts = substantiveStatements.map(
    ({ text, index, speaker }) => {
      const speakerLabel =
        speaker?.name || speaker?.affiliation || speaker?.group || "Unknown";
      return `[${index}] (${speakerLabel}) ${text}`;
    },
  );

  const completion = await trackOpenAIChatCompletion({
    client,
    transcriptId,
    stage: UsageStages.analyzingPropositions,
    operation: UsageOperations.analyzePropositions,
    model: getAnalysisModel(),
    requestMeta: {
      statement_count: statements.length,
      substantive_statements: substantiveStatements.length,
    },
    request: {
      model: getAnalysisModel(),
      reasoning_effort: "medium" as const,
      messages: [
        {
          role: "system",
          content: `You are analyzing a UN proceedings transcript to identify key propositions and stakeholder positions.

OUTPUT LANGUAGE: ${getLanguageFullName(sourceLanguage ?? "en")}
- Write free-text fields (title, statement, summary) in the OUTPUT LANGUAGE shown above.
- The key field is always a kebab-case ASCII slug — never localize it.
- The stance field is always one of the enum values: support / oppose / conditional / neutral — never localize it.
- Stakeholder names and quotes come verbatim from the transcript — keep them in their original script as they appear.

TASK:
1. Identify 3-8 distinct PROPOSITIONS discussed in the transcript
   - A proposition is a specific claim, demand, or position that stakeholders can support or oppose
   - NOT generic topics, but concrete statements (e.g., "African countries should achieve health financing independence by 2035")
   - Must be discussed by at least 2 different speakers

2. For each proposition, identify POSITIONS (grouped by stance):
   - Stance: support, oppose, conditional, or neutral
   - Group stakeholders who share the same position
   - Write a concise 1-sentence summary of their shared position
   - Provide EVIDENCE: specific quotes from the transcript for each stakeholder

OUTPUT FORMAT:
- key: kebab-case ASCII slug (2-5 words)
- title: Short display title (2-5 words) in the OUTPUT LANGUAGE
- statement: The full proposition as a clear statement in the OUTPUT LANGUAGE
- positions: Array of positions, each with:
  - stance: support/oppose/conditional/neutral (enum — never translated)
  - stakeholders: Array of speaker names/organizations (verbatim from transcript)
  - summary: 1-sentence summary of their position in the OUTPUT LANGUAGE
  - evidence: Array of quotes, sorted by importance/relevance, each with:
    - stakeholder: Which stakeholder said this (must be in stakeholders array)
    - quote: EXACT quote from the transcript (1-3 sentences, must appear verbatim in text)
    - statementIndex: The [index] number where this quote appears

RULES:
- Use stakeholder names exactly as they appear in the transcript
- Only include positions that are clearly expressed (not implied)
- A stakeholder can appear in multiple propositions
- Skip purely procedural statements
- EVERY stakeholder in a position MUST have at least one quote in evidence
- Quotes must be EXACT text from the transcript (will be verified)
- Sort evidence by relevance/importance (most compelling quotes first)
- Keep quotes focused and relevant (1-3 sentences max)`,
        },
        {
          role: "user",
          content: `Analyze this UN transcript and identify propositions with stakeholder positions:

${transcriptParts.join("\n\n")}`,
        },
      ],
      response_format: zodResponseFormat(PropositionAnalysis, "propositions"),
    },
  });

  const result = completion.choices[0]?.message?.content;
  if (!result) throw new Error("Failed to analyze propositions");

  const parsed = JSON.parse(result) as z.infer<typeof PropositionAnalysis>;

  // Evidence uses the same source text and original statement indices as the prompt.
  const evidenceSources = new Map(
    substantiveStatements.map(({ index, text }) => [index, text]),
  );
  const verified: Proposition[] = parsed.propositions.map((prop) => ({
    ...prop,
    positions: prop.positions.map((pos) => {
      const verifiedEvidence = pos.evidence.filter((ev) => {
        const statementText = evidenceSources.get(ev.statementIndex);
        if (statementText === undefined) {
          console.log(`  ⚠ Invalid statement index: ${ev.statementIndex}`);
          return false;
        }
        // Normalize for comparison (handle minor transcription variations)
        const normalize = (s: string) =>
          s
            .toLowerCase()
            .replace(/[^\w\s]/g, "")
            .replace(/\s+/g, " ")
            .trim();
        const paraText = normalize(statementText);
        const quoteText = normalize(ev.quote);
        // Check if quote is contained in paragraph (with some fuzzy matching for minor variations)
        const found =
          paraText.includes(quoteText) ||
          quoteText
            .split(" ")
            .filter((w) => w.length > 3)
            .every((word) => paraText.includes(word));
        if (!found) {
          console.log(
            `  ⚠ Quote not found in statement ${ev.statementIndex}: "${ev.quote.substring(0, 50)}..."`,
          );
        }
        return found;
      });
      return { ...pos, evidence: verifiedEvidence };
    }),
  }));

  console.log(`  ✓ Identified ${verified.length} propositions`);
  return verified;
}
