// Public data API: meeting list and single-meeting detail as JSON or plain text.
import { formatTimestamp } from "@/lib/timestamp-url";
import { routing } from "@/i18n/routing";
import {
  getCachedTranscriptedEntries,
  getCachedTranscriptedEntriesByLanguage,
} from "@/lib/cached-db";
import { compressedJson, compressedText } from "@/lib/compressed-json";
import { TRANSCRIPT_DISCLAIMER } from "@/lib/config";
import { getCountryName } from "@/lib/country-lookup";
import {
  getTranscriptByKalturaId,
  getVideoByAssetId,
  getVideoByCitation,
  getVideoByKalturaId,
  isTranscriptFlagged,
  queryVideos,
  type VideoRecord,
  type VideosQueryParams,
} from "@/lib/db";
import { getBaseUrl } from "@/lib/get-base-url";
import { getLanguageDisplayName } from "@/lib/languages";
import { filterOffRecord } from "@/lib/off-record";
import { symbolFromSlug } from "@/lib/meeting-slug";
import { buildExportHeaderText } from "@/lib/transcript-export";
import {
  formatSpeakerInfo,
  getSpeakerMapping,
  SpeakerInfo,
} from "@/lib/speakers";
import {
  buildSpeakerSegments,
  formatSpeakerText,
  formatTimecode,
  formatTranscriptAsPlainText,
} from "@/lib/transcript-formatting";
import { PUBLIC_CORS_HEADERS } from "@/lib/security-headers";
import { getVideoMetadata, recordToVideo } from "@/lib/un-api";
import { safeDecodePathSegmentsArray } from "@/lib/utils";
import { videoUrl } from "@/lib/video-url";
import { parseTranscriptIdentifier } from "@/lib/transcript-availability";
import { NextRequest, NextResponse } from "next/server";

// Unified data-API handler. The proxy (proxy.ts) rewrites
//   /{locale}/{slug}.json     → /api/data/{locale}/json/{slug}
//   /{locale}/{slug}.txt      → /api/data/{locale}/text/{slug}
//   /{locale}/meetings.json   → /api/data/{locale}/json/meetings
// so the public URL grammar mirrors page URLs ("append .json / .txt to any
// meeting page to get the same content as data"), while the implementation
// lives in one place. Format is encoded as a path segment rather than a
// query param because `NextResponse.rewrite` does not reliably surface
// added search params to the destination handler's `request.nextUrl`.

const SUPPORTED_LOCALES = routing.locales as readonly string[];
const SUPPORTED_FORMATS = ["json", "text"] as const;
type Format = (typeof SUPPORTED_FORMATS)[number];

// Page size for the public data API. Larger than the homepage feed's 100
// chunk (lib/cached-db) — the homepage is paginated for UI rendering, this
// surface is read by machines / LLMs that want fewer round-trips.
const LIST_PAGE_SIZE = 250;
const LIST_DAYS_BACK = 365;

const SORT_VALUES = ["date_desc", "date_asc", "title_asc", "title_desc"];

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

// `compressedJson` / `compressedText` honor the request's Accept-Encoding
// and gzip when present (Next's built-in compress middleware doesn't fire
// for App Router route handlers — see lib/compressed-json.ts).

async function jsonResponse(
  request: NextRequest,
  data: unknown,
): Promise<Response> {
  return compressedJson(request, data, {
    headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" },
  });
}

async function textResponse(
  request: NextRequest,
  body: string,
  cacheable = true,
): Promise<Response> {
  return compressedText(request, body, {
    headers: cacheable
      ? { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" }
      : {},
  });
}

// CORS is applied to every response — success and error alike — in the GET
// wrapper below, so a browser client can read a 404/400 body instead of
// getting an opaque CORS failure. See PUBLIC_CORS_HEADERS for why the value
// is a static `*`.
export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{ locale: string; format: string; path: string[] }>;
  },
) {
  const response = await handleRequest(request, context);
  for (const [key, value] of Object.entries(PUBLIC_CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

// Plain cross-origin GETs are "simple requests" and skip preflight, but a
// fetch with custom headers triggers an OPTIONS preflight, which would
// otherwise 405 (this route only exports GET).
export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      ...PUBLIC_CORS_HEADERS,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

async function handleRequest(
  request: NextRequest,
  context: {
    params: Promise<{ locale: string; format: string; path: string[] }>;
  },
): Promise<Response> {
  try {
    const { locale, format: formatRaw, path } = await context.params;
    if (!SUPPORTED_LOCALES.includes(locale)) {
      return NextResponse.json({ error: "Unknown locale" }, { status: 404 });
    }
    if (!SUPPORTED_FORMATS.includes(formatRaw as Format)) {
      return badRequest(
        `format must be one of: ${SUPPORTED_FORMATS.join(", ")}`,
      );
    }
    const format = formatRaw as Format;

    // Decode each segment (proxy.ts passes them through unchanged). Malformed
    // percent-encoding from scanners/attack URLs would otherwise throw a
    // URIError → 500; a clean 404 is the right answer for a bad path.
    const segs = safeDecodePathSegmentsArray(path);
    if (segs === null) {
      return NextResponse.json(
        { error: "Invalid meeting path" },
        { status: 404 },
      );
    }

    // List / search endpoint: /{locale}/meetings.{json|txt}
    if (segs.length === 1 && segs[0] === "meetings") {
      return handleList(request, locale, format);
    }

    // Asset permalink: /{locale}/asset/{id...}.{json|txt}
    if (segs[0] === "asset" && segs.length >= 2) {
      const assetId = segs.slice(1).join("/");
      const record = await getVideoByAssetId(assetId);
      if (!record || record.removed_at) {
        return NextResponse.json({ error: "Video not found" }, { status: 404 });
      }
      return handleMeeting(request, locale, record, format);
    }

    // Stable Kaltura player ID: /{locale}/kaltura/{id}.{json|txt}. This is a
    // second entry point into the SAME meeting response builder as asset and
    // citation URLs; the response's canonical URL remains the human-facing
    // citation/asset permalink.
    if (segs[0] === "kaltura" && segs.length === 2) {
      let kalturaId: string;
      try {
        kalturaId = parseTranscriptIdentifier({ kalturaId: segs[1] }).value;
      } catch {
        return NextResponse.json(
          { error: "Invalid Kaltura ID" },
          { status: 404 },
        );
      }
      const record = await getVideoByKalturaId(kalturaId);
      if (!record || record.removed_at) {
        return NextResponse.json({ error: "Video not found" }, { status: 404 });
      }
      return handleMeeting(request, locale, record, format);
    }

    // Citation slug: /{locale}/sc/10175(/N).{json|txt}, etc.
    const slug = segs.join("/");
    const parsed = symbolFromSlug(slug);
    if (!parsed) {
      return NextResponse.json(
        { error: "Invalid meeting path" },
        { status: 404 },
      );
    }
    const record = await getVideoByCitation(parsed);
    if (!record || record.removed_at) {
      return NextResponse.json({ error: "Video not found" }, { status: 404 });
    }
    return handleMeeting(request, locale, record, format);
  } catch (error) {
    console.error("Data API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}

// -- meeting detail --------------------------------------------------------

async function handleMeeting(
  request: NextRequest,
  locale: string,
  record: VideoRecord,
  format: Format,
) {
  const video = recordToVideo(record, false, locale);
  const url = videoUrl(record);
  const baseUrl = await getBaseUrl();
  // ?language=XX wins; otherwise default to the URL locale's transcript when
  // one exists, falling back to the most-recent transcript in any language.
  const requestedLanguage =
    request.nextUrl.searchParams.get("language") || undefined;
  const transcript =
    (await getTranscriptByKalturaId(
      record.kaltura_id,
      requestedLanguage ?? locale,
    )) ??
    (requestedLanguage
      ? null
      : await getTranscriptByKalturaId(record.kaltura_id));

  // No transcript at all.
  if (!transcript) {
    if (format === "text") {
      return textResponse(
        request,
        buildHeader(baseUrl, locale, video, record, null) +
          "No transcript available.\n",
      );
    }
    const metadata = await getVideoMetadata(record.asset_id);
    return jsonResponse(request, {
      disclaimer: TRANSCRIPT_DISCLAIMER,
      url: canonicalTranscriptUrl(baseUrl, locale, record, null),
      llms: buildLlmsPointer(locale, url),
      video: serializeVideo(video, record),
      metadata: serializeMetadata(metadata),
      transcript: null,
      message: "No transcript available",
    });
  }

  // In progress.
  if (transcript.transcription_status !== "completed") {
    if (format === "text") {
      return textResponse(
        request,
        buildHeader(baseUrl, locale, video, record, transcript.language_code) +
          `Transcript not yet available (status: ${transcript.transcription_status}).\n`,
      );
    }
    const metadata = await getVideoMetadata(record.asset_id);
    return jsonResponse(request, {
      disclaimer: TRANSCRIPT_DISCLAIMER,
      url: canonicalTranscriptUrl(
        baseUrl,
        locale,
        record,
        transcript.language_code,
      ),
      llms: buildLlmsPointer(locale, url),
      video: serializeVideo(video, record),
      metadata: serializeMetadata(metadata),
      transcript: {
        status: transcript.transcription_status,
        transcriptId: transcript.transcript_id,
      },
      message: "Transcript not completed",
    });
  }

  const fullMapping = (await getSpeakerMapping(transcript.transcript_id)) || {};
  // Off-record statements are stored but never served (lib/off-record.ts) —
  // the public JSON/text outputs get the same filtered view as the app.
  const { statements: visibleStatements, speakerMappings } = filterOffRecord(
    transcript.content.statements,
    fullMapping,
  );

  const countryNames = new Map<string, string>();
  const iso3Codes = new Set<string>();
  Object.values(speakerMappings).forEach((info: SpeakerInfo) => {
    if (info.affiliation && info.affiliation.length === 3) {
      iso3Codes.add(info.affiliation);
    }
  });
  for (const code of iso3Codes) {
    const name = getCountryName(code);
    if (name) countryNames.set(code, name);
  }

  const topics = transcript.content.topics || {};

  if (format === "text") {
    const segments = buildSpeakerSegments(visibleStatements, speakerMappings);
    const body = formatTranscriptAsPlainText(
      segments,
      visibleStatements,
      (idx) => formatSpeakerText(idx, speakerMappings, countryNames),
      formatTimecode,
    );
    return textResponse(
      request,
      buildHeader(baseUrl, locale, video, record, transcript.language_code) +
        body,
    );
  }

  // Per-statement citation link: same `?t=` grammar as the search-hit and
  // copy-link buttons (whole seconds, CEIL'd), carrying ?lang= when the served
  // transcript isn't the URL locale's track. Lets a consumer cite a statement
  // without re-deriving the URL from the sentence `start` themselves.
  const statementPageUrl = (startMs: number) => {
    const t = Math.max(0, Math.ceil(startMs / 1000));
    const langQuery =
      transcript.language_code !== locale
        ? `lang=${transcript.language_code}&`
        : "";
    return `/${locale}/${url}?${langQuery}t=${formatTimestamp(t)}`;
  };

  // Timestamps are already realignment-shifted by the display getter
  // (getTranscriptByKalturaId).
  const transcriptData = visibleStatements.map((stmt, index) => {
    const info = speakerMappings[index.toString()];
    const startMs = stmt.paragraphs[0]?.sentences[0]?.start ?? 0;
    return {
      statement_number: index + 1,
      start: startMs / 1000,
      pageUrl: statementPageUrl(startMs),
      paragraphs: stmt.paragraphs.map((para) => ({
        sentences: para.sentences.map((sent) => ({
          text: sent.text,
          start: sent.start / 1000,
          end: sent.end / 1000,
          topics:
            sent.topic_keys?.map((key) => ({
              key,
              label: topics[key]?.label || key,
              description: topics[key]?.description || "",
            })) || [],
          ...(sent.words && sent.words.length > 0
            ? {
                words: sent.words.map((w) => ({
                  text: w.text,
                  start: w.start / 1000,
                  end: w.end / 1000,
                })),
              }
            : {}),
        })),
      })),
      speaker: formatSpeakerInfo(info, countryNames),
    };
  });

  const metadata = await getVideoMetadata(record.asset_id);
  return jsonResponse(request, {
    disclaimer: TRANSCRIPT_DISCLAIMER,
    url: canonicalTranscriptUrl(
      baseUrl,
      locale,
      record,
      transcript.language_code,
    ),
    llms: buildLlmsPointer(locale, url),
    video: serializeVideo(video, record),
    metadata: serializeMetadata(metadata),
    transcript: {
      transcript_id: transcript.transcript_id,
      language: transcript.language_code,
      // Realignment-flagged (lib/db.ts isTranscriptFlagged): UN Web TV re-cut
      // the video after transcription in a way no single offset could fix, so
      // the timestamps below may not match the current video. Additive and
      // only present when flagged — unflagged responses are unchanged.
      ...(isTranscriptFlagged(transcript)
        ? {
            timestamps_flagged: true,
            timestamps_note:
              "UN Web TV re-edited this video after the transcript was created; timestamps may no longer match the current video.",
            original_duration_seconds: Math.round(
              (transcript.source_duration_ms as number) / 1000,
            ),
            current_duration_seconds: Math.round(
              (transcript.aligned_duration_ms as number) / 1000,
            ),
          }
        : {}),
      data: transcriptData,
      topics: Object.values(topics).map((t) => ({
        key: t.key,
        label: t.label,
        description: t.description,
      })),
    },
  });
}

function serializeVideo(
  video: ReturnType<typeof recordToVideo>,
  record: VideoRecord,
) {
  const url = videoUrl(record);
  return {
    id: record.asset_id,
    kaltura_id: record.kaltura_id,
    title: video.title,
    clean_title: video.cleanTitle,
    url: video.url,
    date: video.date,
    scheduled_time: video.scheduledTime,
    status: video.status,
    duration: video.duration,
    category: video.category,
    body: video.body,
    event_code: video.eventCode,
    event_type: video.eventType,
    session_number: video.sessionNumber,
    pv_symbol: record.pv_symbol,
    pv_part: record.pv_part,
    slug: url,
  };
}

function serializeMetadata(
  metadata: Awaited<ReturnType<typeof getVideoMetadata>>,
) {
  return {
    summary: metadata.summary,
    description: metadata.description,
    categories: metadata.categories,
    geographic_subject: metadata.geographicSubject,
    subject_topical: metadata.subjectTopical,
    corporate_name: metadata.corporateName,
    speaker_affiliation: metadata.speakerAffiliation,
    related_documents: metadata.relatedDocuments,
  };
}

// Slim, English-only orientation block for agents that land on this JSON
// directly (not via meetings.json). Not localized: llms.txt itself is
// English-only regardless of locale, and the footer link to it follows the
// same precedent (see components/site-footer.tsx).
function buildLlmsPointer(locale: string, url: string) {
  return {
    note: "Plain-text sibling of this page, compact for LLM context. For the full API guide (search, listing, URL grammar) see /llms.txt.",
    textUrl: `/${locale}/${url}.txt`,
    guide: "/llms.txt",
  };
}

// English labels, matching the rest of this endpoint's chrome (disclaimer,
// speaker names, llms pointer). The client passes localized labels to the same
// builder, so a downloaded `.txt` and this response differ only in language —
// and, because the server has no user timezone, in whether the date carries a
// clock time.
const EXPORT_LABELS = {
  date: "Date",
  language: "Language",
  transcript: "Transcript",
  json: "JSON",
  aiAgents: "Information for AI Agents",
};

/** Absolute, language-qualified URL of the page this data mirrors. */
function canonicalTranscriptUrl(
  baseUrl: string,
  locale: string,
  record: VideoRecord,
  language: string | null,
) {
  const suffix = language && language !== locale ? `?lang=${language}` : "";
  return `${baseUrl}/${locale}/${videoUrl(record)}${suffix}`;
}

function buildHeader(
  baseUrl: string,
  locale: string,
  video: ReturnType<typeof recordToVideo>,
  record: VideoRecord,
  language: string | null,
) {
  return buildExportHeaderText(
    {
      title: video.cleanTitle || video.title,
      // `recordToVideo` already resolved the locale variant of `category`,
      // matching the meeting page's pill. Not `video.body`, which is
      // English-only and diverges for GA Main Committee meetings.
      category: video.category,
      date: video.date
        ? new Date(video.date).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "long",
            year: "numeric",
          })
        : "",
      language: language ? getLanguageDisplayName(language) : "",
      transcriptUrl: canonicalTranscriptUrl(baseUrl, locale, record, language),
      labels: EXPORT_LABELS,
    },
    TRANSCRIPT_DISCLAIMER,
  );
}

// -- meeting list / search -------------------------------------------------

async function handleList(
  request: NextRequest,
  locale: string,
  format: Format,
) {
  const sp = request.nextUrl.searchParams;

  // Validation: malformed known params return 400 rather than silently
  // degrading to plausible-but-wrong results. Unknown params are still
  // ignored (that's not "malformed", just extra). ft/xlang are lenient
  // booleans — only "1" turns them on; any other value reads as off.
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  // Pagination is 1-based `page` (was `offset`, which silently rounded down
  // to a multiple of the page size and confused callers).
  const pageRaw = sp.get("page");
  let page = 1;
  if (pageRaw !== null) {
    if (!/^\d+$/.test(pageRaw) || Number(pageRaw) < 1) {
      return badRequest("page must be a positive integer (1-based).");
    }
    page = Number(pageRaw);
  }

  const qRaw = sp.get("q")?.trim();
  if (qRaw !== undefined && qRaw.length > 0 && qRaw.length < 2) {
    return badRequest("q must be at least 2 characters.");
  }
  const q = qRaw && qRaw.length >= 2 ? qRaw : undefined;

  const sortRaw = sp.get("sort");
  if (sortRaw !== null && !SORT_VALUES.includes(sortRaw)) {
    return badRequest(`sort must be one of: ${SORT_VALUES.join(", ")}.`);
  }
  const sortKey = sortRaw ?? "date_desc";
  const [by, dir] = sortKey.split("_") as ["date" | "title", "asc" | "desc"];

  const dateRaw = sp.get("date");
  const fromRaw = sp.get("from");
  const toRaw = sp.get("to");
  for (const [name, value] of [
    ["date", dateRaw],
    ["from", fromRaw],
    ["to", toRaw],
  ] as const) {
    if (value !== null && !DATE_RE.test(value)) {
      return badRequest(`${name} must be in YYYY-MM-DD format.`);
    }
  }
  const date = dateRaw ?? undefined;
  const dateFrom = fromRaw ?? undefined;
  const dateTo = toRaw ?? undefined;

  const docsRaw = sp.getAll("text");
  const badDoc = docsRaw.find((d) => !["transcript", "pv", "sr"].includes(d));
  if (badDoc !== undefined) {
    return badRequest("text must be one of: transcript, pv, sr.");
  }
  const docs = docsRaw;

  // ?ft=1 (with q): also search INSIDE transcript statements. Adds
  // content-matched meetings to the result set and a `matches` object per
  // meeting (count + first hits with speaker, text, start seconds, and a
  // ready-made pageUrl deeplink). It needs a query to run against.
  if (sp.get("ft") === "1" && !q) {
    return badRequest("ft=1 requires a q of at least 2 characters.");
  }
  const includeOther = sp.get("xlang") === "1";
  const fullText = sp.get("ft") === "1" && !!q;

  const [transcriptedEntries, transcriptedEntriesInLocale] = await Promise.all([
    getCachedTranscriptedEntries(),
    locale !== "en"
      ? getCachedTranscriptedEntriesByLanguage(locale)
      : Promise.resolve([] as string[]),
  ]);

  const params: VideosQueryParams = {
    q,
    daysBack: LIST_DAYS_BACK,
    date,
    dateFrom,
    dateTo,
    category: sp.get("category") || undefined,
    docs: docs.length ? docs : undefined,
    sort: { by, dir },
    page,
    pageSize: LIST_PAGE_SIZE,
    transcriptedEntryIds: docs.includes("transcript")
      ? transcriptedEntries
      : undefined,
    localeFilter: { locale, includeOther },
    contentSearch: fullText ? { language: locale } : undefined,
  };

  const {
    records,
    total,
    totalIncludingOther,
    contentMatches,
    statementTotal,
  } = await queryVideos(params);
  const transcriptedSet = new Set(transcriptedEntries);
  const transcriptedInLocaleSet = new Set(transcriptedEntriesInLocale);

  const items = records.map((record) => {
    const v = recordToVideo(
      record,
      record.entry_id ? transcriptedSet.has(record.entry_id) : false,
      locale,
      record.entry_id
        ? transcriptedInLocaleSet.has(record.entry_id) ||
            transcriptedSet.has(record.entry_id)
        : false,
    );
    const url = videoUrl(record);
    const matchSummary = contentMatches?.[record.asset_id];
    return {
      title: v.title,
      date: v.date,
      body: v.body,
      category: v.category,
      slug: url,
      duration: v.duration,
      hasTranscript: v.hasTranscript,
      pageUrl: `/${locale}/${url}`,
      jsonUrl: `/${locale}/${url}.json`,
      textUrl: v.hasTranscript ? `/${locale}/${url}.txt` : null,
      // Content-search hits (ft=1 only): who said it, what, and a deeplink
      // that opens the transcript at that moment.
      ...(matchSummary
        ? {
            matches: {
              count: matchSummary.count,
              statements: matchSummary.hits.map((hit) => ({
                speaker: hit.speaker,
                // Snippet window centered on the first match, with ellipses
                // marking truncation — full statements live in jsonUrl.
                text: `${hit.leading ? "… " : ""}${hit.text}${hit.trailing ? " …" : ""}`,
                start: hit.startSeconds,
                pageUrl: `/${locale}/${url}?t=${formatTimestamp(hit.startSeconds)}`,
              })),
            },
          }
        : {}),
    };
  });

  const shown = (page - 1) * LIST_PAGE_SIZE + items.length;
  const hasMore = shown < total;

  if (format === "text") {
    const header = `# UN meetings — one per line. Fetch each URL below verbatim; do not construct URLs.
# [T] transcript available (URL is the .txt transcript; append .json for structured data).
# [ ] occurred, no transcript yet (URL is the meeting page).
# Format: {date}  {[T]|[ ]}  {url}  {body} — {title}
\n`;
    const lines = items.map((m) => {
      const d = m.date ? new Date(m.date).toISOString().slice(0, 10) : "?";
      const t = m.hasTranscript ? "[T]" : "[ ]";
      const url = m.textUrl ?? m.pageUrl;
      return `${d}  ${t}  ${url}  ${m.body ?? ""} — ${m.title}`;
    });
    const tail = hasMore
      ? `\n... ${total - shown} more. Append ?page=${page + 1} for the next page.\n`
      : "";
    return textResponse(request, header + lines.join("\n") + tail + "\n");
  }

  return jsonResponse(request, {
    meetings: items,
    total,
    totalIncludingOther,
    hasMore,
    page,
    pageSize: LIST_PAGE_SIZE,
    ...(fullText ? { statementTotal } : {}),
  });
}
