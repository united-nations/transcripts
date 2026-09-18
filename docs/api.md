# Public API

All endpoints are public with no authentication required.

All data endpoints (`.json`/`.txt`, `/api/transcripts/availability`, `/llms.txt`, `/llms-full.txt`, `/openapi.json`) are CORS-enabled (`Access-Control-Allow-Origin: *`), so browser code on any origin — e.g. a static site — can `fetch()` them directly without a proxy server.

## URL Scheme

Every meeting page URL has matching data URLs — just append `.json` or `.txt`:

| Format          | Example             | Use for             |
| --------------- | ------------------- | ------------------- |
| HTML page       | `/en/sc/10175`      | Humans, browsers    |
| Structured JSON | `/en/sc/10175.json` | Programmatic access |
| Plain text      | `/en/sc/10175.txt`  | LLM context         |

The locale prefix selects the transcript language (`en`, `fr`, `es`, `ar`, `zh`, `ru`). Override with `?language=XX` if you want a language different from the URL locale.

Internally the rewrite is handled by `proxy.ts`, which maps `/{locale}/{...path}.{json|txt}` to `app/api/data/[locale]/[format]/[...path]/route.ts`, encoding the format as a **path segment** (`json`/`text`) rather than a query param — `NextResponse.rewrite` doesn't reliably surface added search params to the destination handler's `request.nextUrl`, but path segments survive via the route's params. The catch-all handler dispatches on the first path segment (`meetings` → list, `asset` → permalink, `kaltura` → stable player ID, anything else → citation slug).

### Citation slugs

Slugs are derived from UN document symbols. Multi-part recordings of the same meeting take a trailing `/N` (the unsuffixed form addresses part 1).

| UN Body                      | Symbol Pattern             | URL Pattern                       | Example              |
| ---------------------------- | -------------------------- | --------------------------------- | -------------------- |
| Security Council             | `S/PV.{n}`                 | `/{locale}/sc/{n}[/{p}]`          | `/en/sc/10175`       |
| General Assembly plenary     | `A/{s}/PV.{n}`             | `/{locale}/ga/{s}/{n}[/{p}]`      | `/en/ga/79/21`       |
| GA Emergency Special Session | `A/ES-{s}/PV.{n}`          | `/{locale}/ga/es{s}/{n}[/{p}]`    | `/en/ga/es11/23`     |
| GA Committees                | `A/C.{c}/{s}/{PV\|SR}.{n}` | `/{locale}/ga/c{c}/{s}/{n}[/{p}]` | `/en/ga/c1/79/7`     |
| Human Rights Council         | `A/HRC/{s}/SR.{n}`         | `/{locale}/hrc/{s}/{n}[/{p}]`     | `/en/hrc/58/59`      |
| ECOSOC                       | `E/{y}/SR.{n}`             | `/{locale}/ecosoc/{y}/{n}[/{p}]`  | `/en/ecosoc/2024/10` |

GA committees use `PV` (verbatim) only for the 1st Committee; the 2nd–6th Committees use `SR` (summary) — see `docs/official-transcripts.md`. The `/ga/c{c}/…` page URL is identical either way; only the underlying document symbol suffix differs.

### Permalink (any meeting by asset id)

```
/{locale}/asset/{asset_id}
```

Mirrors UN Web TV's URL grammar exactly — swap the host `webtv.un.org` → `transcripts.un.org` to find the corresponding transcript page.

Slug logic lives in `lib/meeting-slug.ts`; the page-URL builder is `videoUrl()` in `lib/video-url.ts`.

### Resolve transcript availability

Clients that only need to decide whether to show transcript content should use
the lightweight resolver rather than download the full meeting JSON:

```http
GET /api/transcripts/availability?kalturaId=1_hrmtg9f4&locale=en
```

Pass **exactly one** of `assetId`, `webtvUrl`, `kalturaId`, or `entryId`.
`locale` defaults to `en`. A WebTV URL is normalized to its full asset ID.
Asset IDs and stable player IDs resolve uniquely. A canonical `entryId` is only
a compatibility fallback and can return multiple matches because several
stable player IDs may redirect to the same underlying Kaltura media.

```json
{
  "query": { "type": "kalturaId", "value": "1_hrmtg9f4" },
  "generationUrl": "https://transcripts.un.org/en/sc/10001",
  "matches": [
    {
      "assetId": "k1h/k1hrmtg9f4",
      "kalturaId": "1_hrmtg9f4",
      "entryId": "1_yuo0w3j6",
      "removed": false,
      "pvSymbol": "S/PV.10001",
      "pvPart": 1,
      "pageUrl": "https://transcripts.un.org/en/sc/10001",
      "jsonUrl": "https://transcripts.un.org/en/sc/10001.json",
      "generationUrl": "https://transcripts.un.org/en/sc/10001",
      "status": "available",
      "languages": [
        {
          "language": "en",
          "status": "completed",
          "transcriptId": "..."
        }
      ]
    }
  ]
}
```

Overall `status` is `available`, `processing`, `unavailable`, or `removed`.
Language rows expose the pipeline status (`scheduled`, `transcribing`,
`identifying_speakers`, `analyzing_topics`, `completed`, `no_content`, `error`,
or `interrupted`). A syntactically valid unknown identifier returns `200` with
an empty `matches` array and a locale landing-page `generationUrl`; malformed,
missing, or multiple identifiers return `400`.

The top-level `generationUrl` is the exact meeting page for one match. For an
unresolved or ambiguous identifier it safely falls back to the Transcripts
locale landing page. Each match always carries its exact meeting page as
`generationUrl`, where a signed-in user can generate a missing transcript.

### Timestamp deeplinks (`?t=`)

Any meeting **page** URL accepts clock timestamps or legacy seconds:

```
/en/sc/10175?t=1:23:45
```

It opens the page with the player seeked to that second (paused — browsers block
unmuted autoplay without a gesture) and the statement spoken there scrolled to
and flashed. This is the site's citation primitive: it addresses a sentence of a
speech rather than an eight-hour recording.

- **Clock timestamps or seconds.** Accepts `?t=3:50`, `?t=4:15:59`, or
  `?t=230`. Generated links use `m:ss` below an hour and `h:mm:ss` above it.
  Zero is valid. Numeric fractions are floored; generated statement links round
  up to avoid highlighting the preceding statement. Malformed values such as
  `?t=90s`, negative values, or `?t=3:60` are silently ignored.
- **Same unit as the data.** Sentence `start`/`end` in `/{locale}/{slug}.json` are
  seconds, so `?t=${Math.ceil(sentence.start)}` turns any sentence into a citation.
  The `.txt` transcript prints `[H:MM:SS]` timecodes, which can be used directly
  without the brackets.
- **Inbound only.** The app never writes `t` back to the address bar; the
  per-statement copy-link buttons in the transcript compose it explicitly, so the
  URL doesn't drift to a random moment as you scroll. Combine with `?lang=XX` when
  citing a track other than the URL locale's.

Produced server-side at `matches.statements[].pageUrl` (below), and client-side by
the copy-link anchor in `components/transcription-panel.tsx` and the search hit
rows in `components/transcript-match-rows.tsx`.

### Topic filters (`?topic=`)

Use `?topic=<topic-key>` to show only statements matching a topic. Add
`&topicMode=all` to show all content with that topic highlighted. Topic keys come
from the transcript's `topics` dictionary. Unknown keys are ignored once the
transcript loads. Selecting or clearing a topic updates the URL without reloading;
clearing removes both parameters. Copied statement links preserve the topic view.

Topic filters combine with timestamps and language selection, for example
`?topic=nuclear_risk&t=3:50&lang=fr` (when `nuclear_risk` exists on the page).

## Search & browse meetings

```
GET /{locale}/meetings.json
```

Returns a paginated list of UN meetings matching the given filters. Covers the last 365 days.

### Query parameters

| Parameter  | Type           | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `q`        | string         | Search meeting titles and metadata (FTS with trigram ILIKE fallback). Min 2 characters — a shorter (non-empty) `q` is a **400**. Add `ft=1` to also search transcript content.                                                                                                                                                                                                                                                                                                        |
| `ft`       | `1`            | With `q`: also search **inside transcript statements** (the URL locale's transcript track). Adds content-matched meetings to the results and a per-meeting `matches` object (see below). Terms containing digits (`L.73`, `2735`, `S/2026/243`) match as exact fragments — robust for document symbols; word terms use stemmed full-text search, and quoted phrases work. Only meetings with a completed transcript are searchable this way. `ft=1` without a valid `q` is a **400**. |
| `category` | string         | Filter by meeting category.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `date`     | YYYY-MM-DD     | Filter to a specific date. A value not matching `YYYY-MM-DD` is a **400**. Pass either `date` or `from`/`to` — combining them is _not_ rejected, the conditions are `AND`ed into an intersection.                                                                                                                                                                                                                                                                                     |
| `from`     | YYYY-MM-DD     | Inclusive start of a date range. Malformed → **400**.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `to`       | YYYY-MM-DD     | Inclusive end of a date range. Malformed → **400**.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `sort`     | enum           | `date_desc` (default), `date_asc`, `title_asc`, `title_desc`. No relevance mode — content searches are date-ordered too, by design. An unrecognized value is a **400**.                                                                                                                                                                                                                                                                                                               |
| `page`     | integer        | 1-based page number (default 1). Results come in pages of 250; page with `1`, `2`, `3`, …. A non-positive or non-integer value is a **400**. (Replaces the former `offset`, which silently rounded down to a multiple of the page size.)                                                                                                                                                                                                                                              |
| `text`     | string (multi) | Filter by available documents: `transcript`, `pv` (verbatim record), `sr` (summary record). Repeating it matches **any** of the given types, not all (`lib/db.ts` joins the conditions with `OR`). An unrecognized value is a **400**.                                                                                                                                                                                                                                                |
| `xlang`    | `1`            | Include meetings not yet available in the URL locale (default: hide them).                                                                                                                                                                                                                                                                                                                                                                                                            |

A malformed **known** parameter returns `400` with `{ "error": "…" }` rather than
silently degrading to plausible-but-wrong results. `ft` and `xlang` are lenient
booleans (only `1` turns them on; any other value reads as off), and unknown
parameters are ignored — neither is an error. Combining `date` with `from`/`to` is
also not rejected (see the `date` row).

### Response

```json
{
  "meetings": [
    {
      "title": "...",
      "date": "YYYY-MM-DDT00:00:00.000Z",
      "body": "Security Council",
      "category": "...",
      "slug": "sc/10175",
      "duration": "01:30:00",
      "hasTranscript": true,
      "pageUrl": "/en/sc/10175",
      "jsonUrl": "/en/sc/10175.json",
      "textUrl": "/en/sc/10175.txt"
    }
  ],
  "total": 42,
  "totalIncludingOther": 50,
  "hasMore": true,
  "page": 1,
  "pageSize": 250
}
```

With `ft=1`, meetings whose transcript matched additionally carry a `matches`
object, and the top level gains `statementTotal` (matching statements across
all result meetings):

```json
{
  "meetings": [
    {
      "…": "…",
      "matches": {
        "count": 12,
        "statements": [
          {
            "speaker": {
              "name": "…",
              "function": "…",
              "affiliation": "USA",
              "group": null
            },
            "text": "… snippet centered on the first match, ellipses mark truncation …",
            "start": 5025,
            "pageUrl": "/en/sc/10175?t=1:23:45"
          }
        ]
      }
    }
  ],
  "statementTotal": 27
}
```

`statements` holds the first 3 matches in transcript order, each `text` a
~240-char snippet centered on the first term occurrence (fetch `jsonUrl` for
full statements); `start` is seconds into the video **at the sentence
containing the first match** (falling back to the statement start), and
`pageUrl` opens the meeting page with the player seeked to that moment
(`?t=` is supported on all meeting pages). `count` is the meeting's full
match total.

The `.txt` variant (`GET /{locale}/meetings.txt`) returns a one-line-per-meeting summary. It accepts the same parameters, but the line format carries only date / transcript flag / URL / body / title — so `ft=1` still _selects_ content-matched meetings while **silently dropping** their snippets and `?t=` deeplinks. Use `meetings.json` when searching content.

The internal homepage feed still lives at `/api/videos` and returns the full video shape used by the table component — it is not part of the public contract and may change.

## Get a single meeting

```
GET /{locale}/{slug}.json
```

Examples:

- `GET /en/sc/10175.json`
- `GET /fr/ga/79/21.json` (French transcript)
- `GET /en/sc/10175/2.json` (part 2)
- `GET /en/asset/k1o/k1o43lgs4z.json` (permalink form)
- `GET /en/kaltura/1_o43lgs4z.json` (stable Kaltura player ID)

Returns the video object with full transcript data including statements, speaker mappings, and topics.

### Query parameters

| Parameter  | Type   | Description                                                                            |
| ---------- | ------ | -------------------------------------------------------------------------------------- |
| `language` | string | Language track to return (en, fr, es, ar, zh, ru). Overrides the URL locale's default. |

### Plain-text format

```
GET /{locale}/{slug}.txt
```

Returns the transcript as plain text with speaker labels, compact for LLM context:

```
{title}
{category}
Date: 8 July 2026
Language: English
Transcript: https://transcripts.un.org/en/sc/10175
Transcripts available through this tool are created by using automatic speech recognition and are not official records nor official documents of the United Nations. ...

---

{Country} · {Function} · {Name} [{timestamp}]:

{transcript text...}
```

The header comes from the shared builder in `lib/transcript-export.ts`, so it
matches the header of the `.txt` file the site's Download menu produces (the
downloaded one is localized and carries a clock time; this one is English and
date-only, since the server has no user timezone). A field is omitted when it
has no value — a meeting with no transcript has no `Language:` line. The
`Transcript:` URL carries `?lang=XX` whenever the returned transcript's
language differs from the URL locale.

### JSON response shape

```json
{
  "disclaimer": "Automatically generated transcript — ...",
  "url": "https://transcripts.un.org/en/sc/10175",
  "video": {
    "id": "...",
    "kaltura_id": "...",
    "title": "...",
    "clean_title": "...",
    "url": "https://webtv.un.org/...",
    "date": "YYYY-MM-DDT00:00:00.000Z",
    "duration": "HH:MM:SS",
    "category": "...",
    "body": "...",
    "pv_symbol": "S/PV.10175",
    "pv_part": 1,
    "slug": "sc/10175"
  },
  "metadata": {
    "summary": "...",
    "description": "...",
    "categories": ["..."],
    "geographic_subject": "...",
    "related_documents": ["..."]
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
                  { "key": "...", "label": "...", "description": "..." }
                ],
                "words": [{ "text": "...", "start": 12.0, "end": 12.2 }]
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
```

**Key fields:**

- `data[]` — speaker turns (statements); each has `start` (**seconds**, the statement's first sentence), a ready-made `pageUrl` deeplinking to that moment (`?t=`, plus `?lang=` when the served track isn't the URL locale's), and `paragraphs[].sentences[]` with `text`, `start`/`end` (**seconds**, floating point), `topics`, and an optional per-sentence `words[]` array with `text` + `start`/`end` in seconds. `words` is omitted when the underlying STT provider didn't supply word-level timing.
- `speaker` on each statement — resolved speaker info (name, function, affiliation as ISO 3166-1 alpha-3, affiliation_full as country name, group).
- `topics[]` on each sentence — 0–3 topics this sentence relates to (key + label + description, denormalized for convenience).

## LLM discovery

- `/llms.txt` — concise site overview for LLM context (llms.txt spec)
- `/llms-full.txt` — detailed API reference for LLM use
