import { z } from "zod";
import {
  MeetingsResponseSchema,
  MeetingResponseSchema,
  LanguagesResponseSchema,
  PvResponseSchema,
  HealthResponseSchema,
  TranscriptAvailabilityResponseSchema,
  DataApiErrorSchema,
  ApiErrorSchema,
} from "./schemas";

// Assembles the OpenAPI 3.0.3 document for the public data API. Response
// bodies come from the Zod schemas in ./schemas via `z.toJSONSchema` +
// `toOas30`; path/operation metadata is hand-written TypeScript.
// See scripts/generate-openapi.ts.
//
// We target OpenAPI 3.0.3 (not 3.1) because swagger-ui-react's 3.1 parsing
// layer (apidom) fails under Turbopack / certain bundlers. 3.0 uses swagger-
// ui's legacy parser which is battle-tested. The main schema difference:
// nullable fields use `nullable: true` instead of `anyOf: [{type:"null"},…]`.
// `toOas30` handles that conversion automatically.

const OPENAPI_VERSION = "3.0.3";

type JsonObj = Record<string, unknown>;

/**
 * Recursively convert a JSON Schema 2020-12 object (from `z.toJSONSchema`) to
 * an OpenAPI 3.0-compatible schema object.
 *
 * The only structural difference we need to handle: nullable fields.
 * - 2020-12: `{anyOf: [T, {type:"null"}]}` (possibly with sibling props)
 * - OAS 3.0:  spread T + `nullable: true` (+ sibling props)
 * - Standalone `{type:"null"}`: `{nullable: true}`
 */
function toOas30(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    return schema;
  const s = schema as JsonObj;

  // Standalone null type (e.g. z.null() in a union variant)
  if (s.type === "null") {
    const { type: _t, ...rest } = s;
    return { nullable: true, ...rest };
  }

  // anyOf containing exactly one {type:"null"} → collapse to nullable
  if (Array.isArray(s.anyOf)) {
    const nullIdx = (s.anyOf as unknown[]).findIndex(
      (v) =>
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        (v as JsonObj).type === "null",
    );
    if (nullIdx !== -1) {
      const others = (s.anyOf as unknown[]).filter((_, i) => i !== nullIdx);
      const { anyOf: _a, ...siblings } = s;
      if (others.length === 1) {
        return {
          ...(toOas30(others[0]) as JsonObj),
          nullable: true,
          ...siblings,
        };
      }
      return { anyOf: others.map(toOas30), nullable: true, ...siblings };
    }
  }

  // Recurse into nested schema locations
  const out: JsonObj = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = Object.fromEntries(
        Object.entries(v as JsonObj).map(([pk, pv]) => [pk, toOas30(pv)]),
      );
    } else if (k === "items") {
      out[k] = toOas30(v);
    } else if (
      (k === "anyOf" || k === "oneOf" || k === "allOf") &&
      Array.isArray(v)
    ) {
      out[k] = v.map(toOas30);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Convert a Zod schema to an OpenAPI 3.0-compatible component schema.
 * Strips `$schema` (dialect is declared at the document level in OAS) and
 * runs `toOas30` to fix nullable encoding.
 */
function toComponent(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "output",
  }) as JsonObj;
  delete json.$schema;
  return toOas30(json) as JsonObj;
}

const COMPONENT_SCHEMAS: Record<string, z.ZodType> = {
  MeetingsResponse: MeetingsResponseSchema,
  MeetingResponse: MeetingResponseSchema,
  LanguagesResponse: LanguagesResponseSchema,
  PvResponse: PvResponseSchema,
  HealthResponse: HealthResponseSchema,
  TranscriptAvailabilityResponse: TranscriptAvailabilityResponseSchema,
  DataApiError: DataApiErrorSchema,
  ApiError: ApiErrorSchema,
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const jsonContent = (schemaName: string) => ({
  "application/json": { schema: ref(schemaName) },
});

const localeParam = {
  name: "locale",
  in: "path" as const,
  required: true,
  description: "One of the six official UN languages.",
  schema: { type: "string", enum: ["ar", "zh", "en", "fr", "ru", "es"] },
};

export function buildSpec(): Record<string, unknown> {
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: "UN Transcripts API",
      version: "1.0.0",
      description:
        "Public, read-only API for UN Web TV meeting records and " +
        "automatically generated transcripts.\n\n" +
        "Meeting URLs use human-readable slugs derived from official UN " +
        "document symbols (S/PV.10175 → `sc/10175`, A/79/PV.21 → " +
        "`ga/79/21`). Append `.json` or `.txt` to any meeting page URL to " +
        "get the same content as data. Videos without a document symbol are " +
        "addressable at `/{locale}/asset/{asset_id}`.\n\n" +
        "Citing a moment: every meeting page URL accepts `?t=<m:ss>`, `?t=<h:mm:ss>`, or `?t=<seconds>` " +
        "(e.g. `/en/sc/10175?t=1:23:45`), which opens the page " +
        "with the video seeked to that moment and the matching statement " +
        "highlighted. The sentence timings in a transcript's `.json` " +
        "(`start`/`end`, in seconds) are exactly what you put in `?t=`, so " +
        "any statement can be turned into a citation link. Generated links use " +
        "clock timestamps; malformed values such as `?t=90s` are ignored.\n\n" +
        "Transcripts available through this API are created by using " +
        "automatic speech recognition and are not official records nor " +
        "official documents of the United Nations. Official records and " +
        "official documents are available on the Official Document System " +
        "of the United Nations; the verbatim (PV) or summary (SR) document " +
        "for a meeting can be fetched via `GET /api/pv`.",
    },
    servers: [{ url: "/" }],
    tags: [
      { name: "meetings", description: "Meeting records and transcripts." },
      { name: "discovery", description: "Audio tracks and source documents." },
      { name: "health", description: "Service status." },
    ],
    paths: {
      "/{locale}/meetings.json": {
        get: {
          tags: ["meetings"],
          summary: "Browse or search meetings (JSON)",
          description:
            "Paginated list of meetings within the last 365 days, newest " +
            "first. Supports full-text search and filtering. Page size is 250.",
          operationId: "listMeetings",
          parameters: [
            localeParam,
            qp(
              "q",
              "Search meeting titles and metadata. Minimum 2 characters — a " +
                "shorter non-empty q is a 400. Add `ft=1` to also search " +
                "inside transcript content.",
              {
                type: "string",
                minLength: 2,
              },
            ),
            qp(
              "ft",
              "Set to 1 (with q) to also search INSIDE transcript statements. " +
                "Content-matched meetings are added to the results and carry a " +
                "`matches` object with speaker, snippet, and a `?t=` deeplink per " +
                "hit. Terms containing digits (L.73, 2735, S/2026/243) match as " +
                "exact fragments — robust for document symbols; word terms use " +
                "stemmed full-text search; quoted phrases work. Searches the URL " +
                "locale's transcript track; only meetings with a completed " +
                "transcript are covered. `ft=1` without a valid q is a 400.",
              { type: "string", enum: ["1"] },
            ),
            qp("category", "Filter by WebTV category name.", {
              type: "string",
            }),
            qp(
              "date",
              "Filter to a single date (YYYY-MM-DD). Combining it with from/to " +
                "is not rejected but intersects the two constraints, which is " +
                "rarely what you want — pass either date or from/to.",
              {
                type: "string",
                pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              },
            ),
            qp("from", "Inclusive start of a date range (YYYY-MM-DD).", {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            }),
            qp("to", "Inclusive end of a date range (YYYY-MM-DD).", {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            }),
            qp(
              "sort",
              "Sort order (default date_desc). There is no relevance mode — " +
                "content searches (ft=1) come back date-ordered too, by design. " +
                "An unrecognized value is a 400.",
              {
                type: "string",
                enum: ["date_desc", "date_asc", "title_asc", "title_desc"],
              },
            ),
            qp(
              "page",
              "1-based page number (default 1). Results come in pages of 250; " +
                "page with 1, 2, 3, … A non-positive or non-integer value is a 400.",
              {
                type: "integer",
                minimum: 1,
              },
            ),
            {
              name: "text",
              in: "query",
              required: false,
              description:
                "Filter by available document type. `transcript` = has an automatic transcript; " +
                "`pv` = has an official verbatim record; `sr` = has an official summary record. " +
                "Repeating it matches ANY of the given types, not all " +
                "(`text=transcript&text=pv` = has a transcript OR a verbatim record). " +
                "Use `text=transcript` to exclude meetings with no content to read.",
              schema: {
                type: "array",
                items: { type: "string", enum: ["transcript", "pv", "sr"] },
              },
              style: "form",
              explode: true,
            },
            qp(
              "xlang",
              "Set to 1 to include transcripts that exist only in other languages.",
              { type: "string", enum: ["1"] },
            ),
          ],
          responses: {
            "200": {
              description: "A page of meetings.",
              content: jsonContent("MeetingsResponse"),
            },
            "400": {
              description:
                "A known parameter was malformed — a bad date/from/to, an " +
                "unknown sort or text value, q shorter than 2 chars, ft=1 " +
                "without q, or a non-positive page.",
              content: jsonContent("DataApiError"),
            },
          },
        },
      },
      "/{locale}/meetings.txt": {
        get: {
          tags: ["meetings"],
          summary: "Browse or search meetings (plain text)",
          description:
            "Same data as `meetings.json` in a compact, LLM-friendly plain-text " +
            "table. Accepts the same query parameters.",
          operationId: "listMeetingsText",
          parameters: [localeParam],
          responses: {
            "200": {
              description: "Plain-text meeting list.",
              content: { "text/plain": { schema: { type: "string" } } },
            },
          },
        },
      },
      "/{locale}/{slug}.json": {
        get: {
          tags: ["meetings"],
          summary: "Get a single meeting and its transcript (JSON)",
          description:
            "Returns the meeting metadata and transcript for a slug derived " +
            "from a UN document symbol. The response has one of three shapes " +
            "depending on transcript availability (completed, in-progress, or " +
            "absent — see the schema).\n\n" +
            "`slug` may contain slashes (it is a multi-segment path). Examples:\n" +
            "- `sc/10175` — Security Council (S/PV.10175)\n" +
            "- `ga/79/21` — General Assembly plenary (A/79/PV.21)\n" +
            "- `ga/c1/79/21` — GA First Committee\n" +
            "- `hrc/55/12` — Human Rights Council\n" +
            "- `ecosoc/2024/30` — ECOSOC\n" +
            "- `asset/k1a2b3c4` — permalink for videos without a document symbol",
          operationId: "getMeeting",
          parameters: [
            localeParam,
            slugParam,
            qp(
              "language",
              "Transcript language to return (defaults to the URL locale).",
              { type: "string", enum: ["ar", "zh", "en", "fr", "ru", "es"] },
            ),
          ],
          responses: {
            "200": {
              description: "The meeting and (if available) its transcript.",
              content: jsonContent("MeetingResponse"),
            },
            "404": {
              description: "Unknown locale, invalid slug, or video not found.",
              content: jsonContent("DataApiError"),
            },
          },
        },
      },
      "/{locale}/kaltura/{kalturaId}.json": {
        get: {
          tags: ["meetings"],
          summary: "Get meeting transcript data by Kaltura player ID",
          description:
            "Returns the same response as the asset/citation `.json` route, " +
            "looked up by the stable Kaltura player ID (`videos.kaltura_id`). " +
            "The response still advertises the canonical citation or asset URL.",
          operationId: "getMeetingByKalturaId",
          parameters: [localeParam, kalturaIdPathParam],
          responses: {
            "200": {
              description: "The meeting and (if available) its transcript.",
              content: jsonContent("MeetingResponse"),
            },
            "404": {
              description: "Malformed/unknown player ID or removed video.",
              content: jsonContent("DataApiError"),
            },
          },
        },
      },
      "/{locale}/{slug}.txt": {
        get: {
          tags: ["meetings"],
          summary: "Get a single meeting transcript (plain text)",
          description:
            "Plain-text rendering of the transcript with speaker headers and " +
            "timecodes. See the `.json` variant for the slug grammar.",
          operationId: "getMeetingText",
          parameters: [localeParam, slugParam],
          responses: {
            "200": {
              description: "Plain-text transcript.",
              content: { "text/plain": { schema: { type: "string" } } },
            },
            "404": {
              description: "Unknown locale, invalid slug, or video not found.",
              content: jsonContent("DataApiError"),
            },
          },
        },
      },
      "/api/languages": {
        get: {
          tags: ["discovery"],
          summary: "List audio language tracks for a video",
          description:
            "Returns all six UN languages with a flag for whether an audio " +
            "track exists and the current transcript status for each.",
          operationId: "getLanguages",
          parameters: [
            {
              name: "kalturaId",
              in: "query",
              required: true,
              description: "Kaltura player ID (the `kaltura_id` field).",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Available languages and transcript statuses.",
              content: jsonContent("LanguagesResponse"),
            },
            "400": {
              description: "Missing kalturaId.",
              content: jsonContent("ApiError"),
            },
          },
        },
      },
      "/api/transcripts/availability": {
        get: {
          tags: ["discovery"],
          summary: "Resolve a recording and its transcript availability",
          description:
            "Lightweight, public CORS endpoint. Pass exactly one identifier. " +
            "Asset and player IDs are unique; canonical entry IDs may return " +
            "multiple matches because several WebTV assets can redirect to " +
            "the same Kaltura media. Valid unknown identifiers return an " +
            "empty matches array and a safe Transcripts landing-page " +
            "generationUrl.",
          operationId: "getTranscriptAvailability",
          parameters: [
            qp("assetId", "UN Web TV asset ID, including any slash.", {
              type: "string",
            }),
            qp("webtvUrl", "Full https://webtv.un.org/.../asset/... URL.", {
              type: "string",
              format: "uri",
            }),
            qp("kalturaId", "Stable Kaltura player ID (1_...).", {
              type: "string",
              pattern: "^1_[A-Za-z0-9]+$",
            }),
            qp(
              "entryId",
              "Canonical Kaltura entry ID fallback; may return multiple matches.",
              { type: "string", pattern: "^1_[A-Za-z0-9]+$" },
            ),
            qp("locale", "Locale used to build page and generation URLs.", {
              type: "string",
              enum: ["ar", "zh", "en", "fr", "ru", "es"],
              default: "en",
            }),
          ],
          responses: {
            "200": {
              description: "Resolution result, including zero or more matches.",
              content: jsonContent("TranscriptAvailabilityResponse"),
            },
            "400": {
              description:
                "Missing, multiple, or malformed identifiers/locale.",
              content: jsonContent("ApiError"),
            },
          },
        },
      },
      "/api/pv": {
        get: {
          tags: ["discovery"],
          summary: "Fetch a UN verbatim/summary record",
          description:
            "Fetches the official UN verbatim (PV) or summary (SR) record PDF " +
            "for a document symbol, parses it to structured JSON, and caches " +
            "it. This is the authoritative record (transcripts are not).",
          operationId: "getPvDocument",
          parameters: [
            {
              name: "symbol",
              in: "query",
              required: true,
              description: "UN document symbol, e.g. S/PV.10175.",
              schema: { type: "string" },
            },
            {
              name: "lang",
              in: "query",
              required: false,
              description: "Document language (default en).",
              schema: {
                type: "string",
                enum: ["ar", "zh", "en", "fr", "ru", "es"],
              },
            },
          ],
          responses: {
            "200": {
              description: "Parsed document.",
              content: jsonContent("PvResponse"),
            },
            "400": {
              description: "Missing symbol.",
              content: jsonContent("ApiError"),
            },
            "404": {
              description: "Document not found or not available.",
              content: jsonContent("ApiError"),
            },
          },
        },
      },
      "/api/health": {
        get: {
          tags: ["health"],
          summary: "Service health check",
          description: "Pings the database. 200 when healthy, 503 otherwise.",
          operationId: "getHealth",
          responses: {
            "200": {
              description: "Healthy.",
              content: jsonContent("HealthResponse"),
            },
            "503": {
              description: "Database unreachable.",
              content: jsonContent("HealthResponse"),
            },
          },
        },
      },
    },
    components: {
      schemas: Object.fromEntries(
        Object.entries(COMPONENT_SCHEMAS).map(([name, schema]) => [
          name,
          toComponent(schema),
        ]),
      ),
    },
  };
}

/** Build a simple query parameter object. */
function qp(
  name: string,
  description: string,
  schema: Record<string, unknown>,
) {
  return { name, in: "query", required: false, description, schema };
}

const slugParam = {
  name: "slug",
  in: "path" as const,
  required: true,
  description:
    "Meeting slug derived from a UN document symbol (may contain slashes), " +
    "or `asset/{asset_id}` for videos without a symbol.",
  schema: { type: "string" },
  examples: {
    securityCouncil: { value: "sc/10175", summary: "Security Council" },
    generalAssembly: { value: "ga/79/21", summary: "GA plenary" },
    gaCommittee: { value: "ga/c1/79/21", summary: "GA First Committee" },
    humanRights: { value: "hrc/55/12", summary: "Human Rights Council" },
    ecosoc: { value: "ecosoc/2024/30", summary: "ECOSOC" },
    assetPermalink: { value: "asset/k1a2b3c4", summary: "Asset permalink" },
  },
};

const kalturaIdPathParam = {
  name: "kalturaId",
  in: "path" as const,
  required: true,
  description: "Stable Kaltura player ID stored as videos.kaltura_id.",
  schema: { type: "string", pattern: "^1_[A-Za-z0-9]+$" },
};
