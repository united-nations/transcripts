# AI Pipeline

Overview of how AI models are used in the transcription and analysis pipeline.

## Models

Transcription is routed **per language** (`STT_ROUTING` in `lib/providers/config.ts`, chosen from the eval in `eval/analysis/out/SYNTHESIS.md`):

| Track | Provider | Model |
| --- | --- | --- |
| English / French / Spanish / Arabic / Russian | Azure AI Speech | LLM Speech enhanced mode (`locales` pinned per track) |
| Chinese | Alibaba | `fun-asr` |
| Floor (multilingual original) | Speechmatics Melia | `melia-1` (`language: multi` + six-language `language_hints`) |

English moved from AssemblyAI `universal-3-5-pro` to Azure LLM Speech on **2026-07-30**
because AssemblyAI **silently omits speech** on long recordings — spans of audio it
returns no words for, with no error and no marker. Over the 24-session English
bake-off corpus (27.5 h) it dropped 0.580% of the audio against Azure's 0.082%, and
879 words that Azure captured against 370 the other way. The defect surfaced through a
member-state complaint about `A/80/PV.106`, where a sentence was cut mid-clause
("…reassess our engagement, [participation, and funding.]") along with ~30 s more of
the same statement and a 56-word passage from another. Re-running does not help (10 of
10 runs reproduced it) and neither does chunking (only 60-minute windows beat the whole
file; 30/15/5-minute windows were about twice as bad). Accepted in exchange: Azure is
~1.46× dearer and renders document symbols and names less well. See
`eval/analysis/SYNTHESIS.md` §16 and `eval/metrics/omission.ts`.

| Other AI | Model | Used for |
| --- | --- | --- |
| Azure OpenAI | `gpt-5.4` (configurable via `STT_ANALYSIS_MODEL`) | Speaker identification, resegmentation, topic definition, proposition analysis |
| Azure OpenAI | `gpt-5.4-mini` (configurable via `STT_ANALYSIS_MODEL_MINI`) | Sentence-level topic tagging (reasoning disabled) |
| Google Gemini | `gemini-3-flash-preview` | PV document alignment |

The choice of provider does not change the rest of the pipeline — the same Azure OpenAI analysis stages run regardless, and **no provider names speakers** (they emit opaque/numeric labels; the OpenAI stage in step 2 assigns names from context). Analysis model names are configurable via `STT_ANALYSIS_MODEL` and `STT_ANALYSIS_MODEL_MINI`.

All AI calls are tracked in the `processing_usage_events` table via `lib/usage-tracking.ts`, recording token counts, duration, and estimated cost.

## Pipeline

```
Kaltura audio URL
       │
       ▼
 1. Transcription — STT provider chosen per language (STT_ROUTING)
       │   Long audio may be split into chunks inside the provider.
       │
       ▼
 2. Speaker identification + resegmentation (GPT-5.4)
       │   Single call in lib/pipeline/index.ts:identifySpeakers().
       │   Runs for every transcript regardless of provider.
       │   Per-paragraph speaker resolution; multi-speaker paragraphs are
       │   resegmented in parallel; speaker mapping persisted.
       │
       ▼
 3. Topic definition (GPT-5.4)
       │   0–10 substantive policy topics from on-record statements.
       │
       ▼
 4. Sentence topic tagging (GPT-5.4-mini, batched, rate-limited)
       │   0–3 topic keys per on-record sentence.
       │
       ▼ (on demand only — POST /api/transcripts/[id]/analysis)
 5. Proposition analysis (GPT-5.4)
```

Separately, PV document alignment can run independently when an official verbatim record is available (`POST /api/pv/align`).

The transcript has **two status columns** (since migration 003). `transcription_status` transitions
`scheduled → transcribing → identifying_speakers → analyzing_topics → completed | error`.
Proposition analysis is **never** part of this pipeline — it is always on-demand and tracked by a separate `analysis_status` column (`none | analyzing | completed | error`), which never moves the transcript off `completed`. A transcript is viewable as soon as its content (`statements`) exists, independent of either status, provided `suppressed_at` is null. Suppression is a separate, reversible serving flag: it preserves the transcript and usage history while allowing a new transcription to be requested.

---

## 1. Transcription

**Entry point:** `lib/transcription.ts` → `getSTTProvider(language).transcribe()` (provider chosen per language via `STT_ROUTING` in `lib/providers/config.ts`)
**Triggered by:** `POST /api/transcripts`

Audio is downloaded from Kaltura and transcribed by the provider routed for that language. Provider implementations live in `lib/providers/` and are registered in `lib/providers/registry.ts`. Each provider normalizes its output into the same `RawParagraph` shape, so the downstream pipeline is identical regardless of which provider ran. All 6 UN official languages plus the "floor" (original) channel are supported.

**Chunking:** Providers that need it split long audio into chunks internally and stitch the results back together. (The Gemini provider, for example, chunks at 10 minutes with ffmpeg to avoid timestamp hallucination on long clips.)

**Output per segment:** sentence-level segments with `start`/`end` timestamps and verbatim `text`. Some providers also emit speaker labels and metadata; these are treated as hints, not authoritative — speaker identity is (re)derived in stage 2 below for every transcript. Word-level timestamps are derived by interpolation within each segment, except for providers that emit real word-level timestamps (AssemblyAI, Deepgram, ElevenLabs, Azure Speech, Google Chirp, Cohere), which are preserved directly.

## 2. Speaker identification

**File:** `lib/pipeline/index.ts` — `identifySpeakers()`
**Model:** `gpt-5.4` via Azure OpenAI (structured output)
**Runs for every transcript**, regardless of STT provider.

Identifies who is actually speaking each paragraph (not who is being mentioned or introduced). Uses any provider-supplied diarization labels as hints only.

**Output per paragraph:** `name`, `function`, `affiliation`, `group`, `has_multiple_speakers`, `is_off_record`.

**Output per transcript:** `transcript_assessment` — `{is_substantive, reason}`, a whole-transcript verdict. `is_substantive: false` (only when the *entire* recording clearly contains no proceedings — ambience/gibberish transcribed as words) flips the row to `transcription_status: no_content`: content is kept in the DB but never served, and topics/tagging are skipped. The per-paragraph `is_off_record` flags are likewise **kept, not deleted** — every serving surface (transcript check/poll/words routes, public JSON/text) hides flagged statements via `lib/off-record.ts`, which filters, reindexes, and strips the flag. The `reason` string is internal diagnostics (stored in `error_message`), never exposed to users or the API.

## 3. Resegmentation

**File:** `lib/pipeline/resegment.ts` — `resegmentParagraph()`
**Model:** `gpt-5.4` via Azure OpenAI (structured output)
**Only runs for paragraphs flagged as `has_multiple_speakers`.**

ASR sometimes places a speaker boundary incorrectly, merging two speakers into one paragraph. This step splits them. Each flagged paragraph is processed in parallel with surrounding context.

Low-confidence splits are discarded.

## 4. Topic definition

**File:** `lib/pipeline/define-topics.ts` — `defineTopics()`
**Model:** `gpt-5.4` via Azure OpenAI (structured output)
**Runs automatically after speaker identification.**

Identifies 0-10 substantive policy topics discussed in the transcript, without filling a minimum quota. Each topic must appear in at least 2 different statements by different speakers. Off-record paragraphs are excluded before constructing prompts. Eligibility is based on substantive content, including announcements, rather than speaker role; chairs, presidents, and moderators are included.

**Output per topic:** `key` (kebab-case ASCII slug, never localized), `label` (human-readable, in transcript source language), `description` (1-2 sentences, in transcript source language).

> **Output language:** Since the i18n cutover, free-text fields (topic labels and descriptions, proposition statements and position summaries, speaker functions and group names) are emitted in the transcript's source language (`transcripts.language_code`), not in English. Stable enum/key fields (topic keys, stance enums, ISO country codes) remain ASCII. Speaker names are always preserved verbatim from the transcript and never transliterated. Transcripts analyzed before this change retain their English labels until someone re-runs analysis.

## 5. Sentence-level topic tagging

**File:** `lib/pipeline/tag-sentences.ts` — `tagSentencesWithTopics()`
**Model:** `gpt-5.4-mini` via Azure OpenAI (structured output, `reasoning_effort: "none"`)
**Runs immediately after topic definition, batched with rate-limited concurrency.**

Sentences are grouped into batches of 15 and tagged in parallel (up to 20 concurrent requests, rate-limited to 10/sec via Bottleneck). Each on-record sentence is tagged with 0-3 topic keys from the defined topics. Off-record sentences are excluded from both tagging input and preceding-sentence context. Substantive content is eligible regardless of speaker role; purely procedural sentences receive no tags. Original statement indices are retained when applying tags.

## 6. Proposition analysis (on demand)

**File:** `lib/pipeline/analyze-propositions.ts` — `analyzePropositions()`
**API route:** `POST /api/transcripts/[id]/analysis`
**Model:** `gpt-5.4` via Azure OpenAI (structured output)
**Not part of the automatic pipeline** — must be explicitly triggered.

Identifies 3-8 concrete propositions (not generic topics) and maps stakeholder positions on each.

**Output per proposition:**
- `key`, `title`, `statement` — the proposition itself
- `positions[]` — grouped by stance (`support`, `oppose`, `conditional`, `neutral`), each with:
  - `stakeholders[]` — speaker names/organizations
  - `summary` — 1-sentence position summary
  - `evidence[]` — exact quotes from the transcript with source paragraph indices

All evidence quotes are verified against the actual transcript text using fuzzy word matching; unverifiable quotes are filtered out.

## 7. PV document alignment

**File:** `lib/pv-alignment.ts`
**API route:** `POST /api/pv/align`
**Model:** `gemini-3-flash-preview` via Gemini Files API

Aligns an official UN verbatim record (Procès-Verbal) with the meeting audio to produce timestamps for each official speaker turn. The PV text is an edited version of what was spoken, so alignment is by speaker identity and content meaning rather than exact wording.

Uses the same 10-minute chunking strategy as transcription. Output is timestamps only (no text), making it token-efficient.

**Merging strategy for chunks:** Configurable — either "first occurrence wins" or best-fit (picks the alignment whose timestamp falls within the chunk's time range).
