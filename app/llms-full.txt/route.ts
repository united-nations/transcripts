import { TRANSCRIPT_DISCLAIMER } from "@/lib/config";
import { PUBLIC_CORS_HEADERS } from "@/lib/security-headers";

const CONTENT = `# UN Transcripts — Full API Reference

> Automatically generated transcripts of public United Nations meetings — not official UN records.

UN Transcripts provides searchable, timestamped transcripts of public meetings from UN Web TV (webtv.un.org). Transcripts include speaker identification, topic analysis, and word-level timestamps synchronized to the video. Available in all six official UN languages: English, French, Spanish, Arabic, Chinese, Russian.

Disclaimer: "${TRANSCRIPT_DISCLAIMER}"

## The "append .json / .txt" rule

Every meeting page URL has matching data URLs — just append \`.json\` or \`.txt\` to the page path. Three shapes of the same content:

| Format | URL example | Use for |
|--------|-------------|---------|
| HTML page | \`/en/sc/10175\` | Humans, browsers |
| Structured JSON | \`/en/sc/10175.json\` | Programmatic access, downstream processing |
| Plain text | \`/en/sc/10175.txt\` | LLM context (compact, easy to parse) |

The locale prefix (\`/en\`, \`/fr\`, \`/es\`, \`/ar\`, \`/zh\`, \`/ru\`) selects the transcript language. Override with \`?language=XX\` if you want a language different from the URL locale.

The collection endpoint follows the same rule: \`/en/meetings.json\` is the JSON form of "the meetings list page."

## Quick start

1. **List** meetings for a date: \`GET /en/meetings.json?date=2026-06-30\`
2. **Read** each transcript by fetching the literal \`textUrl\` from that response, e.g. \`GET /en/sc/10189.txt\`

## Recommended workflow (for agents)

Prefer \`meetings.json\` (not \`meetings.txt\`) as your entry point: the JSON
response carries ready-to-fetch \`pageUrl\` / \`jsonUrl\` / \`textUrl\` strings for
every meeting. Fetch those URLs **verbatim from the response**.

**Reporting what happened on a date (e.g. "summarize yesterday's meetings"):**
call \`meetings.json?date=YYYY-MM-DD\` **without** \`text=transcript\`, so
untranscribed meetings stay visible. Then do *both*:

1. Summarize every meeting that has a transcript (fetch its \`textUrl\`).
2. Still list every meeting where \`hasTranscript\` is \`false\` / \`textUrl\` is
   \`null\`, flagged as "occurred; transcript not available".

Do not silently drop untranscribed meetings from the agenda ("not transcribed"
is not "did not happen"), and do not refuse the whole summary because some are
missing. Add \`?text=transcript\` only when the task is explicitly to summarize
the *transcripts* themselves (it filters out untranscribed meetings).

---

## Search & browse meetings

\`\`\`
GET /{locale}/meetings.json
\`\`\`

Returns a paginated list of UN meetings matching the given filters. Covers the last 365 days.

### Query parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| \`q\`     | string | Search meeting titles and metadata. Min 2 characters — a shorter non-empty \`q\` is a **400**. Add \`ft=1\` to also search inside the transcripts. |
| \`ft\`    | \`1\` | With \`q\`: also search **inside transcript statements** — i.e. find meetings by what was *said*, not just by title. See "Searching inside transcripts" below. \`ft=1\` without a valid \`q\` is a **400**. |
| \`category\` | string | Filter by meeting category. |
| \`date\`  | YYYY-MM-DD | Filter to a specific date; malformed → **400**. Pass either \`date\` or \`from\`/\`to\` — passing both is not rejected, it just intersects the two constraints. |
| \`from\`  | YYYY-MM-DD | Inclusive start of a date range; malformed → **400**. |
| \`to\`    | YYYY-MM-DD | Inclusive end of a date range; malformed → **400**. |
| \`sort\`  | enum | \`date_desc\` (default), \`date_asc\`, \`title_asc\`, \`title_desc\`. There is no relevance sort — even a content search comes back newest-first (by design). An unrecognized value is a **400**. |
| \`page\`  | integer | 1-based page number (default 1). Results come in pages of 250 — page with \`1\`, \`2\`, \`3\`, …. A non-positive or non-integer value is a **400**. |
| \`text\`  | string (multi) | Filter by document type: \`transcript\` = has automatic transcript; \`pv\` = has official verbatim record; \`sr\` = has official summary record. Repeating it matches **any** of the given types, not all. An unrecognized value is a **400**. Use \`text=transcript\` to exclude meetings with no content. |
| \`xlang\` | \`1\` | Include meetings not yet available in the URL locale (default: hide them). |

A malformed **known** parameter returns \`400\` with \`{ "error": "…" }\`. \`ft\`/\`xlang\` are lenient (only \`1\` enables them; other values read as off), and unknown params are ignored — neither is an error.

### Response shape

\`\`\`json
{
  "meetings": [
    {
      "title": "...",
      "date": "YYYY-MM-DDT00:00:00.000Z",
      "body": "Security Council",
      "category": "...",
      "slug": "sc/{n}",
      "duration": "HH:MM:SS",
      "hasTranscript": true,
      "pageUrl": "/en/sc/{n}",
      "jsonUrl": "/en/sc/{n}.json",
      "textUrl": "/en/sc/{n}.txt"
    }
  ],
  "total": 42,
  "totalIncludingOther": 42,
  "hasMore": true,
  "page": 1,
  "pageSize": 250
}
\`\`\`

### Notes

- Covers the last 365 days (same window as the website homepage).
- Use \`hasMore\` + incrementing \`page\` to paginate through all results.
- The \`.txt\` variant (\`GET /{locale}/meetings.txt\`) returns a one-line-per-meeting summary, useful for quickly listing meetings into an LLM prompt. It carries **no** match snippets — if you use \`ft=1\`, request \`meetings.json\`.

---

## Searching inside transcripts (\`ft=1\`)

\`\`\`
GET /{locale}/meetings.json?q={query}&ft=1
\`\`\`

By default \`?q=\` only looks at meeting titles and metadata. Add \`&ft=1\` and the
search *also* runs over the text of every statement in every completed
transcript — so you can find meetings by **what was said in them**, and get back
the exact passages and the moment in the video where each was spoken.

How terms are matched:

- **Terms containing digits** (\`L.73\`, \`2735\`, \`S/2026/243\`) match as exact
  fragments. This is what makes document symbols and resolution numbers findable:
  they hide inside compound tokens that stemmed full-text search would not split,
  and fragment matching also survives a speech-recognition-garbled prefix.
- **Word terms** use stemmed full-text search in the transcript's language.
- **Quoted phrases** work.

Scope: the URL locale's transcript track, and only meetings whose transcript has
finished processing. A meeting whose transcript is still being generated is not
searchable yet.

Matched meetings appear in \`meetings[]\` alongside the title matches, but carry an
extra \`matches\` object; the top level gains \`statementTotal\` (matching statements
across every meeting in the result):

\`\`\`json
{
  "meetings": [
    {
      "title": "...",
      "slug": "sc/10175",
      "pageUrl": "/en/sc/10175",
      "jsonUrl": "/en/sc/10175.json",
      "textUrl": "/en/sc/10175.txt",
      "hasTranscript": true,
      "matches": {
        "count": 12,
        "statements": [
          {
            "speaker": {
              "name": "...",
              "function": "...",
              "affiliation": "USA",
              "affiliation_full": "United States of America",
              "group": null
            },
            "text": "... snippet centred on the first match; leading/trailing ellipses mark truncation ...",
            "start": 5025,
            "pageUrl": "/en/sc/10175?t=1:23:45"
          }
        ]
      }
    }
  ],
  "statementTotal": 27
}
\`\`\`

- \`count\` — how many statements in this meeting matched (the full total).
- \`statements\` — only the **first 3** matches, in transcript order. To read the
  rest, fetch the meeting's \`jsonUrl\` or \`textUrl\` and search within it.
- \`text\` — a ~240-character snippet centred on the first occurrence, not the
  whole statement.
- \`start\` — whole seconds into the video, at the **sentence** containing the
  first match.
- \`pageUrl\` — that moment as a ready-made link. Use it verbatim when citing.

---

## Citing a moment: \`?t=\`

Every meeting page URL accepts clock timestamps or seconds:

\`\`\`
https://transcripts.un.org/en/sc/10175?t=1:23:45
\`\`\`

It opens the meeting with the video seeked to that second (paused) and the
statement being spoken there scrolled to and highlighted. This is the citation
primitive of the site — it is how you point a reader at a specific sentence of a
specific speech rather than at an 8-hour recording.

- Accepts \`m:ss\` (\`?t=3:50\`), \`h:mm:ss\` (\`?t=4:15:59\`),
  or legacy seconds (\`?t=230\`). Generated links use clock timestamps.
  Malformed values such as \`?t=90s\` or \`?t=3:60\` are ignored.
- The \`start\`/\`end\` values on every sentence in a transcript \`.json\` are in the
  same unit (seconds), so any sentence can be turned into a citation link:
  \`{pageUrl}?t={Math.ceil(sentence.start)}\`.
- The \`.txt\` transcript prints \`[H:MM:SS]\` timecodes next to each speaker. Those
  can also be used directly in \`?t=\`.
- Share a topic filter with \`?topic=<topic-key>\` (highlights only). Add
  \`&topicMode=all\` for all content with highlights. These also work alongside \`t\`.
- Add \`&lang=XX\` alongside \`t\` if you are citing a transcript track other than
  the one the URL locale implies.

---

## Read a transcript

### Plain text (recommended for LLMs)

\`\`\`
GET /{locale}/{slug}.txt
\`\`\`

Returns the transcript as plain text with speaker labels. Compact and easy to parse.

The locale selects the transcript language. Override with \`?language=XX\` (en, fr, es, ar, zh, ru).

**Example response:**

\`\`\`
UN Transcripts — https://transcripts.un.org/en/sc/10175
{title} — {body} — {date}
Language: en
${TRANSCRIPT_DISCLAIMER}

---

{Country} · {Function} · {Name} [{timestamp}]:

{transcript text...}
\`\`\`

### Structured JSON

\`\`\`
GET /{locale}/{slug}.json
\`\`\`

Returns full structured data with timestamps, speaker mappings, topics, and word-level timing.

**Response shape:**

\`\`\`json
{
  "disclaimer": "Transcripts available through this tool are created by using automatic speech recognition ...",
  "video": {
    "id": "...",
    "kaltura_id": "...",
    "title": "...",
    "clean_title": "...",
    "url": "https://webtv.un.org/en/asset/...",
    "date": "YYYY-MM-DDT00:00:00.000Z",
    "duration": "HH:MM:SS",
    "category": "...",
    "body": "...",
    "pv_symbol": "S/PV.10175",
    "pv_part": 1,
    "slug": "sc/10175"
  },
  "transcript": {
    "transcript_id": "...",
    "language": "en",
    "data": [
      {
        "statement_number": 1,
        "start": 12.0,
        "pageUrl": "/en/sc/10175?t=0:12",
        "speaker": {
          "name": "...",
          "affiliation": "XXX",
          "affiliation_full": "...",
          "group": null,
          "function": "..."
        },
        "paragraphs": [
          {
            "sentences": [
              {
                "text": "...",
                "start": 12.0,
                "end": 15.0,
                "topics": [
                  {
                    "key": "...",
                    "label": "...",
                    "description": "..."
                  }
                ],
                "words": [
                  { "text": "...", "start": 12.0, "end": 12.2 }
                ]
              }
            ]
          }
        ]
      }
    ],
    "topics": [
      {
        "key": "...",
        "label": "...",
        "description": "..."
      }
    ]
  }
}
\`\`\`

**Key fields:**

- \`data[]\` — speaker turns (statements). Each has \`start\` (seconds, the statement's first sentence), a ready-made \`pageUrl\` deeplinking to that moment (\`?t=\`; carries \`?lang=\` when the served track isn't the URL locale's), \`paragraphs[].sentences[]\` with \`text\`, \`start\`/\`end\` (seconds, float), \`topics\`, and optional \`words[]\`.
- \`speaker\` — resolved speaker info. \`affiliation\` is ISO 3166-1 alpha-3. \`affiliation_full\` is the expanded country name.
- \`topics[]\` on each sentence — 0–3 topics this sentence relates to.
- \`words[]\` — word-level timing (omitted when the provider didn't supply it).

---

## Meeting URL scheme

Slugs are derived from UN document symbols. Multi-part recordings of the same meeting take a trailing \`/N\` (the unsuffixed form addresses part 1).

| UN Body | Symbol | URL | Example |
|---------|--------|-----|---------|
| Security Council | S/PV.{n} | /{locale}/sc/{n}[/{p}] | /en/sc/10175 |
| General Assembly | A/{s}/PV.{n} | /{locale}/ga/{s}/{n}[/{p}] | /en/ga/79/21 |
| GA Emergency Session | A/ES-{s}/PV.{n} | /{locale}/ga/es{s}/{n}[/{p}] | /en/ga/es11/23 |
| GA Committees | A/C.{c}/{s}/{PV|SR}.{n} | /{locale}/ga/c{c}/{s}/{n}[/{p}] | /en/ga/c1/79/7 |
| Human Rights Council | A/HRC/{s}/SR.{n} | /{locale}/hrc/{s}/{n}[/{p}] | /en/hrc/58/59 |
| ECOSOC | E/{y}/SR.{n} | /{locale}/ecosoc/{y}/{n}[/{p}] | /en/ecosoc/2024/10 |
| Permalink (any meeting) | — | /{locale}/asset/{asset_id} | /en/asset/k1o/k1o43lgs4z |

The \`asset/...\` form mirrors UN Web TV's URL grammar exactly — swap the host \`webtv.un.org\` → \`transcripts.un.org\` to find the corresponding transcript page.

GA committee records use \`PV\` (verbatim) only for the 1st Committee; the 2nd–6th Committees use \`SR\` (summary). The \`/{locale}/ga/c{c}/…\` page URL is the same either way — only the underlying UN document symbol suffix differs.

---

## Coverage

Public meetings recorded on UN Web TV, including:

- Security Council
- General Assembly (plenary and all main committees)
- Human Rights Council
- Economic and Social Council
- Other inter-governmental bodies as available

Closed or confidential meetings are not covered (they are not recorded on Web TV).

---

## Known limitations

- **Search scope**: \`?q=\` alone searches titles and metadata only. Add \`&ft=1\` to search transcript content — but note that only meetings with a **completed transcript in the requested language** are covered, so a content search is a search of what has been transcribed, not of everything the UN has said.
- **Date-ordered, by design**: results — including content searches — are always newest-first, never ranked by match quality. This is intentional (the archive is a chronological record); paging deep into a busy query walks backwards in time. If you want the most *relevant* hits rather than the most *recent*, narrow with \`date\`/\`from\`/\`to\` and read them all.
- **Snippets are capped**: \`ft=1\` returns at most 3 matching statements per meeting (\`matches.count\` tells you the true total). Fetch the transcript itself to see the rest.
- **No speaker filtering**: you cannot ask "what did France say about X" in one query. Search the content, then fetch the transcripts and filter on \`speaker\` yourself.
- **Time window**: search and browse cover the last 365 days, matching the website homepage.
- **Transcript accuracy**: these are automatic speech recognition outputs, not official records. Names, abbreviations, and document symbols may be misheard. Accuracy varies by speaker and microphone quality.
- **Languages**: six UN languages are supported (en, fr, es, ar, zh, ru). Not every meeting has transcripts in all languages — it depends on which audio tracks are available.

---

## Machine-readable spec

OpenAPI 3.0 spec: \`GET /openapi.json\`
Interactive reference: \`/openapi\`
`;

export function GET() {
  return new Response(CONTENT, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "s-maxage=86400, stale-while-revalidate=604800",
      ...PUBLIC_CORS_HEADERS,
    },
  });
}
