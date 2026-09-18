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
import type { ParagraphInput } from "./shared";

const TopicDefinitions = z.object({
  topics: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      description: z.string(),
    }),
  ),
});

export async function defineTopics(
  paragraphs: ParagraphInput[],
  speakerMapping: SpeakerMapping,
  client: AzureOpenAI,
  transcriptId?: string,
  sourceLanguage?: string,
): Promise<
  Record<string, { key: string; label: string; description: string }>
> {
  console.log(`  → Defining topics...`);

  // Exclude off-record text before building model context; retain original indices.
  // Substantiveness is determined from content, not the speaker's role.
  const visibleStatements = paragraphs
    .map((p, idx) => {
      const speaker = speakerMapping[idx.toString()];
      return { paragraph: p, index: idx, speaker };
    })
    .filter(({ speaker }) => !speaker?.is_off_record);

  if (visibleStatements.length < 2) {
    console.log(
      `  ℹ Too few on-record statements (${visibleStatements.length}), skipping topic analysis`,
    );
    return {};
  }

  const contextParts = visibleStatements.map(
    ({ paragraph, index, speaker }) => {
      const speakerLabel = speaker?.name || speaker?.affiliation || "Unknown";
      return `[${index}] ${speakerLabel}: ${paragraph.text}`;
    },
  );

  const completion = await trackOpenAIChatCompletion({
    client,
    transcriptId,
    stage: UsageStages.analyzingTopics,
    operation: UsageOperations.defineTopics,
    model: getAnalysisModel(),
    requestMeta: {
      paragraph_count: paragraphs.length,
      substantive_statements: visibleStatements.length,
    },
    request: {
      model: getAnalysisModel(),
      reasoning_effort: "medium" as const,
      messages: [
        {
          role: "system",
          content: `You are analyzing a UN proceedings transcript to identify main discussion topics.

TASK:
- Identify 0-10 distinct topics discussed in the transcript
- Each topic must appear in at least 2 different statements by different speakers
- Focus on substantive policy topics, not procedural matters
- Judge eligibility by content, regardless of speaker role: chairs, presidents, and moderators can make substantive statements or announcements
- Do not invent or split topics to fill a quota; return an empty array when no topics meet the criteria
- For each topic provide:
  - key: kebab-case slug (2-4 words, always ASCII, e.g., "climate-finance")
  - label: Human-readable title in the OUTPUT LANGUAGE (proper case, spaces, native script)
  - description: Clear 1-2 sentence explanation in the OUTPUT LANGUAGE

OUTPUT LANGUAGE: ${getLanguageFullName(sourceLanguage ?? "en")}
- Write the label and description fields in the OUTPUT LANGUAGE shown above.
- The key field is always a kebab-case ASCII slug regardless of OUTPUT LANGUAGE — never localize it.
- Examples below are in English purely for illustration; produce your actual output in the OUTPUT LANGUAGE.

EXAMPLES (illustrative only — match the OUTPUT LANGUAGE in your response):
- key: "climate-finance", label: "Climate Finance", description: "Financing mechanisms for climate action and adaptation"
- key: "peacekeeping-mandate", label: "Peacekeeping Mandate", description: "Scope and renewal of peacekeeping operations"
- key: "humanitarian-access", label: "Humanitarian Access", description: "Ensuring humanitarian aid reaches affected populations"
- key: "sdg-implementation", label: "SDG Implementation", description: "Progress on Sustainable Development Goals"

OUTPUT:
- Return 0-10 topics as an array
- Each topic must have key, label, and description fields`,
        },
        {
          role: "user",
          content: `Analyze these statements from a UN proceeding and identify the main topics:

${contextParts.join("\n\n")}`,
        },
      ],
      response_format: zodResponseFormat(TopicDefinitions, "topics"),
    },
  });

  const result = completion.choices[0]?.message?.content;
  if (!result) throw new Error("Failed to define topics");

  const parsed = JSON.parse(result) as z.infer<typeof TopicDefinitions>;

  // Convert array to record for easier lookup
  const topicsRecord: Record<
    string,
    { key: string; label: string; description: string }
  > = {};
  parsed.topics.forEach((topic) => {
    topicsRecord[topic.key] = topic;
  });

  const topicKeys = Object.keys(topicsRecord);
  console.log(
    `  ✓ Identified ${topicKeys.length} topics: [${topicKeys.join(", ")}]`,
  );

  return topicsRecord;
}
