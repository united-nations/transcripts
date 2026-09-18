import { AzureOpenAI } from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import Bottleneck from "bottleneck";
import type { SpeakerMapping } from "@/lib/speakers";
import {
  trackOpenAIChatCompletion,
  UsageOperations,
  UsageStages,
} from "@/lib/usage-tracking";
import { getAnalysisModelMini } from "@/lib/providers/models";
import { getLanguageFullName } from "@/lib/languages";
import type { StatementWithSentences } from "./shared";

export async function tagSentencesWithTopics(
  statements: StatementWithSentences[],
  topics: Record<string, { key: string; label: string; description: string }>,
  speakerMapping: SpeakerMapping,
  client: AzureOpenAI,
  transcriptId?: string,
  sourceLanguage?: string,
): Promise<StatementWithSentences[]> {
  console.log(`  → Tagging sentences with topics...`);

  const topicKeys = Object.keys(topics);
  if (topicKeys.length === 0) {
    console.log(`  ℹ No topics defined, skipping tagging`);
    return statements;
  }

  const topicDescriptions = topicKeys
    .map((key) => `- ${key}: ${topics[key].description}`)
    .join("\n");

  // Build context only from on-record sentences, preserving stored indices.
  interface SentenceWithMeta {
    statementIdx: number;
    paragraphIdx: number;
    sentenceIdx: number;
    text: string;
  }

  const allSentences: SentenceWithMeta[] = [];

  statements.forEach((stmt, stmtIdx) => {
    const speaker = speakerMapping[stmtIdx.toString()];
    if (speaker?.is_off_record) return;
    stmt.paragraphs.forEach((para, paraIdx) => {
      para.sentences.forEach((sent, sentIdx) => {
        allSentences.push({
          statementIdx: stmtIdx,
          paragraphIdx: paraIdx,
          sentenceIdx: sentIdx,
          text: sent.text,
        });
      });
    });
  });

  // Let the model assess substantive content regardless of speaker role.
  const taggableSentences = allSentences.map((sentence, index) => ({
    index,
    sentence,
  }));

  // Batched tagging with rate-limited concurrency
  const BATCH_SIZE = 15;
  const BatchTopicResponse = z.object({
    results: z.array(
      z.object({
        index: z.number(),
        topic_keys: z.array(z.string()),
      }),
    ),
  });

  const batches: Array<typeof taggableSentences> = [];
  for (let i = 0; i < taggableSentences.length; i += BATCH_SIZE) {
    batches.push(taggableSentences.slice(i, i + BATCH_SIZE));
  }

  console.log(
    `  → Processing ${taggableSentences.length} sentences in ${batches.length} batches...`,
  );

  const limiter = new Bottleneck({
    maxConcurrent: 20,
    minTime: 100,
  });

  const batchResults = await Promise.all(
    batches.map((batch) =>
      limiter.schedule(async () => {
        const sentenceList = batch
          .map(({ index: globalIdx, sentence: sent }, i) => {
            const contextBefore =
              globalIdx > 0
                ? `  [context] ${allSentences[globalIdx - 1].text}\n`
                : "";
            return `${contextBefore}  [${i}] ${sent.text}`;
          })
          .join("\n");

        try {
          const completion = await trackOpenAIChatCompletion({
            client,
            transcriptId,
            stage: UsageStages.taggingSentences,
            operation: UsageOperations.tagSentenceTopics,
            model: getAnalysisModelMini(),
            requestMeta: {
              batch_size: batch.length,
              first_global_index: batch[0].index,
            },
            request: {
              model: getAnalysisModelMini(),
              reasoning_effort: "none" as const,
              messages: [
                {
                  role: "system",
                  content: `You are categorizing UN proceeding sentences by topic.

The sentences are in ${getLanguageFullName(sourceLanguage ?? "en")}; topic descriptions may be in the same language. Match sentences to topic keys based on meaning regardless of language. Return only the kebab-case ASCII topic keys — never localize them.

AVAILABLE TOPICS:
${topicDescriptions}

TASK:
- For each numbered sentence, select 0-3 topics that are directly discussed
- Only tag substantive policy discussions or substantive announcements
- Judge eligibility by content, regardless of speaker role, including chairs, presidents, and moderators
- Return empty array if no topics apply or if purely procedural
- Lines marked [context] are for reference only — do not tag them

RULES:
- A topic applies if the sentence makes substantive points about it
- Brief mentions don't count
- When uncertain, don't tag
- Return only topic keys, not labels or descriptions`,
                },
                {
                  role: "user",
                  content: `Tag each numbered sentence with relevant topics:

${sentenceList}`,
                },
              ],
              response_format: zodResponseFormat(
                BatchTopicResponse,
                "batch_sentence_topics",
              ),
            },
          });

          const result = completion.choices[0]?.message?.content;
          if (!result)
            return batch.map(({ sentence: sent }) => ({
              ...sent,
              topic_keys: [] as string[],
            }));

          const parsed = JSON.parse(result) as z.infer<
            typeof BatchTopicResponse
          >;
          const resultMap = new Map(
            parsed.results.map((r) => [r.index, r.topic_keys]),
          );
          return batch.map(({ sentence: sent }, i) => ({
            ...sent,
            topic_keys: resultMap.get(i) ?? [],
          }));
        } catch (error) {
          console.warn(`  ⚠ Failed to tag batch:`, error);
          return batch.map(({ sentence: sent }) => ({
            ...sent,
            topic_keys: [] as string[],
          }));
        }
      }),
    ),
  );

  const taggedSentences = batchResults.flat();

  // Apply topic tags back to statements
  const updatedStatements: StatementWithSentences[] = statements.map(
    (stmt) => ({
      ...stmt,
      paragraphs: stmt.paragraphs.map((para) => ({
        ...para,
        sentences: para.sentences.map((s) => ({ ...s })),
      })),
    }),
  );

  taggedSentences.forEach((tagged) => {
    const stmt = updatedStatements[tagged.statementIdx];
    const para = stmt.paragraphs[tagged.paragraphIdx];
    para.sentences[tagged.sentenceIdx].topic_keys = tagged.topic_keys;
  });

  const taggedCount = taggedSentences.filter(
    (s) => s.topic_keys && s.topic_keys.length > 0,
  ).length;
  console.log(
    `  ✓ Tagged ${taggedCount}/${taggableSentences.length} sentences with topics`,
  );

  return updatedStatements;
}
