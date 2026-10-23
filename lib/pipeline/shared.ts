// Shared helpers, types, and prompt fragments for the analysis pipeline stages.
// Split out of the former monolithic speaker-identification.ts (see ./index.ts).
// @ts-expect-error - no types available for sbd
import sbd from "sbd";
import type { SpeakerInfo } from "@/lib/speakers";
export type { SpeakerMapping } from "@/lib/speakers";

export const INTERPRETED_SPEECH_RULES = `INTERPRETED SPEECH ATTRIBUTION:
- The speaker fields identify the person whose intervention is conveyed, including through interpretation.
- Attribute a faithful oral translation to the original participant: use that participant's exact name, function, affiliation and group for both the original words and their interpreted rendering.
- Alternating languages, voices or ASR labels during one interpreted intervention do not create another participant or a mixed-speaker paragraph. Do not split solely between an original and its translation.
- An interpreter's own interventions (asking someone to introduce themselves, clarification, technical comments, or their own substantive remarks) remain separate and may be labelled Interpreter. Do not assign those remarks to the person being interpreted.
- The same ASR voice may interpret different participants and also speak independently. Resolve ownership from conversational context; never copy one identity to every occurrence of that voice.
- Genuine handoffs between participants, chair introductions, and audience question/answer boundaries still require separate attribution and splitting when they share a paragraph.
- Preserve every original and translated word in its original order. This is attribution only: never delete repetitions, translate, paraphrase, or invent an original participant when context does not identify one.
- For has_multiple_speakers / should_split, count distinct owners of interventions under these rules, rather than physical voices. Original speech plus its interpretation alone is one intervention.`;

export const IDENTIFICATION_RULES = `IDENTIFICATION RULES:
- Use ASR speaker labels as HINTS for speaker changes (label change often = new speaker), but verify with text
- ASR may incorrectly group different speakers under same label, or split one speaker across labels
- Extract both personal names AND official functions when available
- For country representatives, provide ISO 3166-1 alpha-3 country codes (e.g., PRY, USA, CHN)
- For UN bodies/agencies, use standard abbreviations (e.g., ACABQ, UNICEF, UNDP, OHCHR, 5th Committee)
- CRITICAL: Only fill "group" when speaker EXPLICITLY says they are speaking ON BEHALF OF that group
  - YES: "on behalf of the G77 + China", "speaking for the EU", "representing the Africa Group"
  - NO: "aligns with", "supports the statement by", "agrees with", "echoes", "associates with"
- If identity cannot be determined, return all null values
- Only use information literally in the text (no world knowledge)
- Fix transcription errors: "UN80 Initiative" (not "UNAT", "UNA", "UNAT Initiative", etc.)
- The co-chairs of the UN80 / MIR IAHWG are called "Carolyn Schwalger" and "Brian Wallace", their affiliation is "IAHWG", and their function is "Co-Chair"
- In IAHWG meetings: if someone is chairing but name isn't stated, use function="Co-Chair" and affiliation="IAHWG" (name can be null)`;

export const COMMON_ABBREVIATIONS = `COMMON ABBREVIATIONS
- Informal Ad hoc Working Group (on UN80 initiative / mandate implementation review / ...) -> IAHWG (just "IAHWG", NOT "IAHWG on ...")
- common member state groups (use only the short form in your response, not the part in brackets):
  - G77 + China (Group of 77 + China)
  - NAM (Non-Aligned Movement)
  - WEOG (Western European and Others Group)
  - GRULAC (Latin American and Caribbean Group)
  - Africa Group
  - Asia-Pacific Group
  - EEG (Eastern European Group)
  - LDCs (Least Developed Countries)
  - SIDS (Small Island Developing States)
  - LLDCs (Landlocked Developing Countries)
  - AOSIS (Alliance of Small Island States)
  - Arab Group
  - OIC (Organisation of Islamic Cooperation)
  - ACP (African, Caribbean and Pacific States)
  - EU (European Union)
  - JUSCANZ
  - CANZ
  - Nordic Group
  - LMG (Like-Minded Group)
  - LGBTI Core Group
  - Friends of R2P
  - Friends of the SDGs
  - Friends of Mediation
  - Friends of UNAOC (UN Alliance of Civilizations)
  - G24 (Intergovernmental Group of 24)
  - BRICS
  - G20
  - OECD-DAC
  - Umbrella Group
  - BASIC (Brazil, South Africa, India, China)
  - LMDC (Like-Minded Developing Countries)
  - EIG (Environmental Integrity Group)`;

export const SCHEMA_DEFINITIONS = `SCHEMA DEFINITIONS:

name: The actual personal name (first name, surname, or full name) of the speaker. Do NOT use world knowledge – you do not reliably know who is really in the room and other people may have taken over posts where you have strongly memorized the (now outdated) name. Only use what is literally stated. Fix transcription errors that concern incorrect spelling, but never fix more than that. Add "Mr."/"Ms." only if surname-only AND gender explicitly known. E.g., "Yacine Hamzaoui", "Mr. Hamasu", "Dave". MUST be null if the actual personal name is unknown — NEVER put role descriptions like "Representative of Germany", "Delegate of Kenya", or "Chair" in this field. Those belong in function/affiliation.

function: Function/title. Be concise, use canonical abbreviations. E.g. "SG", "PGA", "Chair", "Representative", "Vice-Chair", "Officer", "Spokesperson", "USG Policy". Use null if unknown.

affiliation: For country representatives, use ISO 3166-1 alpha-3 country codes of their country, e.g. "PRY", "KEN". For organizations use the canonical abbreviation of the organization, e.g. "OECD", "OHCHR", "UN Secretariat", "GA", "5th Committee", "UN80 Initiative". Use null if unknown/not applicable.

group: If the speaker EXPLICITLY states they are speaking ON BEHALF OF a group (not merely supporting, aligning with, or agreeing with). Use canonical abbreviation, e.g. "G77 + China", "EU", "AU". Use null if not speaking on behalf of a group.`;

export interface ParagraphWord {
  text: string;
  start: number;
  end: number;
  speaker?: string;
}

export interface ParagraphInput {
  text: string;
  start: number;
  end: number;
  /** ASR speaker label for the whole paragraph (used when there are no words). */
  speaker?: string;
  /** Real per-word timestamps. Absent for segment-level-only providers. */
  words?: ParagraphWord[];
  /**
   * For word-less providers: the original provider segments merged into this
   * paragraph during same-speaker grouping, each with its real start/end.
   * Used to emit per-segment sentences with honest timing (no fabrication).
   * Absent on un-merged single-segment paragraphs (the paragraph itself is the
   * segment).
   */
  segments?: Array<{ text: string; start: number; end: number }>;
}

export function normalizeText(text: string): string {
  // Unicode-aware: keep any letter or number from any script (Han, Cyrillic,
  // Arabic, Latin, digits). The Latin-only `[a-z0-9]` form collapsed every
  // non-Latin sentence to "", causing matchWordsToText to consume exactly one
  // word per sentence (silently losing ~half the text on Chinese transcripts).
  return text.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

export function speakersEqual(a: SpeakerInfo, b: SpeakerInfo): boolean {
  return (
    a.name === b.name &&
    a.function === b.function &&
    a.affiliation === b.affiliation &&
    a.group === b.group
  );
}

export interface StatementWithSentences {
  paragraphs: Array<{
    sentences: Array<{
      text: string;
      start: number;
      end: number;
      topic_keys?: string[];
      words?: ParagraphWord[];
    }>;
    start: number;
    end: number;
    words?: ParagraphWord[];
  }>;
  start: number;
  end: number;
  words?: ParagraphWord[];
}

export function matchWordsToText(
  words: ParagraphWord[],
  offset: number,
  targetText: string,
): ParagraphWord[] {
  const normalized = normalizeText(targetText);
  const matched: ParagraphWord[] = [];
  let matchedNorm = "";

  for (let i = offset; i < words.length; i++) {
    const testWords = [...matched, words[i]];
    const testNorm = normalizeText(testWords.map((w) => w.text).join(" "));

    if (normalized.startsWith(testNorm)) {
      matched.push(words[i]);
      matchedNorm = testNorm;
      if (matchedNorm === normalized) break;
    } else {
      break;
    }
  }

  return matched;
}

export function buildStatementsWithSentences(
  paragraphInputs: ParagraphInput[],
): StatementWithSentences[] {
  return paragraphInputs.map((paraInput) => {
    // Split by \n\n to create separate paragraphs
    const parts = paraInput.text.split("\n\n").filter((p) => p.trim());

    const paragraphs: StatementWithSentences["paragraphs"] = [];

    // No real word timestamps: the provider segment is the smallest honest
    // timed unit. Emit one sentence per provider segment, each carrying its
    // real start/end — no sbd splitting, no fabricated timing. Segments of a
    // speaker turn live in one paragraph so they render as flowing text.
    if (!paraInput.words || paraInput.words.length === 0) {
      const segs = paraInput.segments ?? [
        { text: paraInput.text, start: paraInput.start, end: paraInput.end },
      ];
      const sentences = segs
        .map((s) => ({ text: s.text.trim(), start: s.start, end: s.end }))
        .filter((s) => s.text);
      if (sentences.length > 0) {
        paragraphs.push({
          sentences,
          start: paraInput.start,
          end: paraInput.end,
        });
      }
      return {
        paragraphs,
        start: paraInput.start,
        end: paraInput.end,
      };
    }

    // Real word timestamps: split into sentences and derive per-sentence
    // timing by matching each sentence's text against the word stream.
    const words = paraInput.words;
    let wordOffset = 0;

    parts.forEach((part) => {
      const partSentences: string[] = sbd.sentences(part.trim(), {
        preserve_whitespace: false,
      });
      const sentences: Array<{
        text: string;
        start: number;
        end: number;
        words: ParagraphWord[];
      }> = [];

      partSentences.forEach((sentText: string) => {
        // Match sentence to words
        const sentWords = matchWordsToText(words, wordOffset, sentText);
        if (sentWords.length > 0) {
          sentences.push({
            text: sentText,
            start: sentWords[0].start,
            end: sentWords[sentWords.length - 1].end,
            words: sentWords,
          });
          wordOffset += sentWords.length;
        }
      });

      if (sentences.length > 0) {
        paragraphs.push({
          sentences,
          start: sentences[0].start,
          end: sentences[sentences.length - 1].end,
          words: sentences.flatMap((s) => s.words),
        });
      }
    });

    return {
      paragraphs,
      start: paraInput.start,
      end: paraInput.end,
      words,
    };
  });
}
