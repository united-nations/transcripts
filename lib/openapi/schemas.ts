import { z } from "zod";

// Zod schemas that are the single source of truth for the public data API's
// request parameters and response shapes. `scripts/generate-openapi.ts` feeds
// these through `z.toJSONSchema()` to assemble `public/openapi.json`.
//
// This module is intentionally dependency-free (no `next/server`, no DB
// imports) so it runs under `tsx` in the `prebuild` step without dragging in
// the server runtime. That's also why the locale list is duplicated as a
// literal here rather than imported from `i18n/routing` — keep this graph
// pure.

// ── Shared ────────────────────────────────────────────────────────────────

/** The six official UN languages, in canonical order (see i18n/routing.ts). */
export const LocaleSchema = z
  .enum(["ar", "zh", "en", "fr", "ru", "es"])
  .describe("ISO 639-1 code of one of the six official UN languages.");

// ── Request parameters ──────────────────────────────────────────────────────

/** Query params for `GET /{locale}/meetings.{json,txt}`. */
export const MeetingsQuerySchema = z.object({
  q: z
    .string()
    .min(2)
    .optional()
    .describe("Search titles/metadata (400 if a non-empty q is < 2 chars)."),
  ft: z
    .literal("1")
    .optional()
    .describe(
      "With q: also search inside transcript statements. 400 without a valid q.",
    ),
  category: z.string().optional().describe("Filter by WebTV category name."),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe(
      "Filter to a single date (YYYY-MM-DD). Combining with from/to " +
        "intersects rather than erroring.",
    ),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Inclusive start of a date range (YYYY-MM-DD)."),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Inclusive end of a date range (YYYY-MM-DD)."),
  sort: z
    .enum(["date_desc", "date_asc", "title_asc", "title_desc"])
    .optional()
    .describe("Sort order (default: date_desc)."),
  page: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based page number (default 1); page size is 250."),
  text: z
    .union([
      z.enum(["transcript", "pv", "sr"]),
      z.array(z.enum(["transcript", "pv", "sr"])),
    ])
    .optional()
    .describe(
      "Restrict to meetings that have the given document(s) available. " +
        "Repeating the param matches ANY of the types (OR), not all.",
    ),
  xlang: z
    .literal("1")
    .optional()
    .describe(
      "Set to 1 to include meetings whose transcript exists only in other " +
        "languages than the requested locale.",
    ),
});

/** Query param for `GET /{locale}/{slug}.{json,txt}`. */
export const MeetingQuerySchema = z.object({
  language: LocaleSchema.optional().describe(
    "Transcript language to return. Defaults to the URL locale's transcript " +
      "if one exists, otherwise the most recent transcript in any language.",
  ),
});

/** Query param for `GET /api/languages`. */
export const LanguagesQuerySchema = z.object({
  kalturaId: z
    .string()
    .min(1)
    .describe("Kaltura player ID of the video (the `kaltura_id` field)."),
});

/** Query params for `GET /api/pv`. */
export const PvQuerySchema = z.object({
  symbol: z
    .string()
    .min(1)
    .describe("UN document symbol, e.g. S/PV.10175 or A/79/PV.21."),
  lang: LocaleSchema.optional().describe("Document language (default: en)."),
});

// ── Response building blocks ────────────────────────────────────────────────

export const TopicSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    description: z.string(),
  })
  .describe("A substantive policy topic identified across the meeting.");

export const SpeakerSchema = z
  .object({
    affiliation: z
      .string()
      .nullable()
      .describe("ISO alpha-3 country code or short affiliation label."),
    affiliation_full: z
      .string()
      .nullable()
      .describe("Official UN country name resolved from the ISO code."),
    group: z.string().nullable(),
    function: z.string().nullable(),
  })
  .describe(
    "Speaker attribution without inferred person names; generic representative functions are null.",
  );

export const WordSchema = z.object({
  text: z.string(),
  start: z.number().describe("Start time in seconds."),
  end: z.number().describe("End time in seconds."),
});

export const SentenceSchema = z.object({
  text: z.string(),
  start: z.number().describe("Start time in seconds."),
  end: z.number().describe("End time in seconds."),
  topics: z.array(TopicSchema),
  words: z
    .array(WordSchema)
    .optional()
    .describe("Per-word timing; present only when word-level timing exists."),
});

export const ParagraphSchema = z.object({
  sentences: z.array(SentenceSchema),
});

export const StatementSchema = z.object({
  statement_number: z
    .number()
    .int()
    .describe("1-based index of the statement."),
  start: z
    .number()
    .describe("Start time of the statement in seconds (its first sentence)."),
  pageUrl: z
    .string()
    .describe(
      "Meeting page deep-linked to this statement via `?t=` — cite a " +
        "statement without rebuilding the URL from `start`.",
    ),
  paragraphs: z.array(ParagraphSchema),
  speaker: SpeakerSchema,
});

export const VideoInfoSchema = z.object({
  id: z.string().describe("UN Web TV asset ID (the DB primary key)."),
  kaltura_id: z.string().nullable(),
  title: z.string().nullable(),
  clean_title: z.string().nullable(),
  url: z.string().nullable(),
  date: z.string().nullable(),
  scheduled_time: z.string().nullable(),
  status: z.string().nullable(),
  duration: z.number().nullable(),
  category: z.string().nullable(),
  body: z.string().nullable().describe("UN organ / body name."),
  event_code: z.string().nullable(),
  event_type: z.string().nullable(),
  session_number: z.string().nullable(),
  pv_symbol: z.string().nullable().describe("Official UN document symbol."),
  pv_part: z.string().nullable(),
  slug: z.string().describe("Human-readable meeting slug, e.g. sc/10175."),
});

export const MetadataSchema = z
  .object({
    summary: z.string().nullable(),
    description: z.string().nullable(),
    categories: z.array(z.string()),
    geographic_subject: z.array(z.string()),
    subject_topical: z.array(z.string()),
    corporate_name: z.array(z.string()),
    speaker_affiliation: z.array(z.string()),
    related_documents: z.array(z.string()),
  })
  .describe("Structured metadata harvested from the UN Web TV page.");

// ── Meeting list response ───────────────────────────────────────────────────

export const MeetingMatchesSchema = z
  .object({
    count: z
      .number()
      .int()
      .describe("Total matching statements in this meeting's transcript."),
    statements: z
      .array(
        z.object({
          speaker: SpeakerSchema.nullable(),
          text: z
            .string()
            .describe(
              "Snippet centered on the first match; ellipses mark truncation. " +
                "Full statements live in jsonUrl.",
            ),
          start: z.number().int().describe("Seconds into the video."),
          pageUrl: z
            .string()
            .describe(
              "Meeting page deep-linked to this moment via `?t=` — opens " +
                "with the player seeked and the statement highlighted.",
            ),
        }),
      )
      .describe("First 3 matches in transcript order."),
  })
  .describe(
    "Transcript-content hits for this meeting (present only with `ft=1` " +
      "when the transcript matched).",
  );

export const MeetingListItemSchema = z.object({
  title: z.string().nullable(),
  date: z.string().nullable(),
  body: z.string().nullable(),
  category: z.string().nullable(),
  slug: z.string(),
  duration: z.number().nullable(),
  hasTranscript: z.boolean(),
  pageUrl: z.string(),
  jsonUrl: z.string(),
  textUrl: z.string().nullable(),
  matches: MeetingMatchesSchema.optional(),
});

export const MeetingsResponseSchema = z.object({
  meetings: z.array(MeetingListItemSchema),
  total: z.number().int(),
  totalIncludingOther: z
    .number()
    .int()
    .describe("Total ignoring the locale filter (see the xlang param)."),
  hasMore: z.boolean(),
  page: z.number().int().describe("1-based page number of this response."),
  pageSize: z.number().int(),
  statementTotal: z
    .number()
    .int()
    .optional()
    .describe("With `ft=1`: matching statements across all result meetings."),
});

// ── Meeting detail response (three variants) ────────────────────────────────

const CompletedTranscriptSchema = z.object({
  transcript_id: z.string(),
  language: z.string(),
  data: z.array(StatementSchema),
  topics: z.array(TopicSchema),
});

/** Returned when the transcript is finished. */
export const MeetingCompletedResponseSchema = z.object({
  disclaimer: z.string(),
  video: VideoInfoSchema,
  metadata: MetadataSchema,
  transcript: CompletedTranscriptSchema,
});

/** Returned when no transcript exists for the meeting. */
export const MeetingNoTranscriptResponseSchema = z.object({
  disclaimer: z.string(),
  video: VideoInfoSchema,
  metadata: MetadataSchema,
  transcript: z.null(),
  message: z.string(),
});

/** Returned while the transcription pipeline is still running. */
export const MeetingInProgressResponseSchema = z.object({
  disclaimer: z.string(),
  video: VideoInfoSchema,
  metadata: MetadataSchema,
  transcript: z.object({
    status: z.string().describe("Current pipeline stage."),
    transcriptId: z.string(),
  }),
  message: z.string(),
});

export const MeetingResponseSchema = z
  .union([
    MeetingCompletedResponseSchema,
    MeetingNoTranscriptResponseSchema,
    MeetingInProgressResponseSchema,
  ])
  .describe(
    "One of three shapes depending on transcript availability: completed " +
      "(full transcript), in-progress (status only), or absent (null).",
  );

// ── Other endpoints ─────────────────────────────────────────────────────────

export const LanguagesResponseSchema = z.object({
  entryId: z.string().describe("Canonical Kaltura entry ID."),
  languages: z.array(
    z.object({
      code: LocaleSchema,
      name: z.string(),
      available: z
        .boolean()
        .describe("Whether an audio track exists for this language."),
      transcriptStatus: z
        .string()
        .nullable()
        .describe("Transcription status, or null if none exists."),
    }),
  ),
});

export const TranscriptAvailabilityStatusSchema = z.enum([
  "available",
  "processing",
  "unavailable",
  "removed",
]);

export const TranscriptPipelineStatusSchema = z.enum([
  "scheduled",
  "transcribing",
  "identifying_speakers",
  "analyzing_topics",
  "completed",
  "no_content",
  "error",
  "interrupted",
]);

export const TranscriptAvailabilityResponseSchema = z.object({
  query: z.object({
    type: z.enum(["assetId", "kalturaId", "entryId"]),
    value: z.string(),
  }),
  generationUrl: z
    .string()
    .describe(
      "Exact meeting page for one match; locale landing page when unresolved or ambiguous.",
    ),
  matches: z.array(
    z.object({
      assetId: z.string(),
      kalturaId: z.string(),
      entryId: z.string().nullable(),
      removed: z.boolean(),
      pvSymbol: z.string().nullable(),
      pvPart: z.number().int().nullable(),
      pageUrl: z.string(),
      jsonUrl: z.string(),
      generationUrl: z.string(),
      status: TranscriptAvailabilityStatusSchema,
      languages: z.array(
        z.object({
          language: z.string(),
          status: TranscriptPipelineStatusSchema,
          transcriptId: z.string(),
        }),
      ),
    }),
  ),
});

const PvTurnSchema = z.object({
  speaker: z.string(),
  affiliation: z.string().optional(),
  spokenLanguage: z.string().optional(),
  onBehalfOf: z.string().optional(),
  paragraphNumber: z.number().optional(),
  paragraphs: z.array(z.string()),
  type: z.enum(["speech", "procedural"]),
  proceduralParagraphs: z.array(z.number()).optional(),
});

export const PvResponseSchema = z
  .object({
    symbol: z.string(),
    body: z.string(),
    session: z.string(),
    meetingNumber: z.string(),
    date: z.string(),
    location: z.string(),
    language: z.string(),
    status: z.enum(["provisional", "official"]),
    president: z.object({ name: z.string(), country: z.string() }).nullable(),
    members: z.array(
      z.object({ country: z.string(), representative: z.string() }),
    ),
    agendaItems: z.array(z.string()),
    turns: z.array(PvTurnSchema),
    fullText: z.string(),
  })
  .describe("Parsed UN verbatim (PV) or summary (SR) record.");

export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "error"]),
});

// ── Error shapes (two distinct conventions in the codebase) ─────────────────

/** Shape returned by the data-API routes (`/{locale}/...`). */
export const DataApiErrorSchema = z
  .object({ error: z.string() })
  .describe("Error response from the meeting data API.");

/** Shape returned by `apiError()` (`/api/languages`, `/api/pv`). */
export const ApiErrorSchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string() }),
  })
  .describe("Structured error response from /api/* routes.");
