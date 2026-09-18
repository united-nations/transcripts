import { PUBLIC_CORS_HEADERS } from "@/lib/security-headers";

const CONTENT = `# UN Transcripts

> Automatically generated transcripts of public United Nations meetings — not official UN records.

UN Transcripts provides searchable, timestamped transcripts of public meetings from UN Web TV (webtv.un.org), covering the Security Council, General Assembly, Human Rights Council, ECOSOC, and other inter-governmental bodies. Transcripts include speaker identification, topic analysis, and word-level timestamps synchronized to the video. Available in all six official UN languages: English, French, Spanish, Arabic, Chinese, Russian.

The append rule: every meeting page URL has matching data URLs — append \`.json\` for structured data or \`.txt\` for plain text (recommended for LLM context). Page \`/en/sc/10175\` → \`/en/sc/10175.json\` or \`/en/sc/10175.txt\`. The locale prefix (\`/en\`, \`/fr\`, \`/es\`, \`/ar\`, \`/zh\`, \`/ru\`) selects the transcript language; override with \`?language=XX\`.

Recommended workflow (do not construct or guess URLs, and do not scrape the rendered HTML page): start from the list endpoint and follow the literal URLs it returns.

- \`GET https://transcripts.un.org/en/meetings.json?date=2026-06-30\` lists every meeting on that date. Each item includes \`hasTranscript\` and, when a transcript exists, a ready-to-fetch \`textUrl\` (and \`jsonUrl\`). Filters: \`?date=YYYY-MM-DD\`, \`?from=…&to=…\` (range), \`?q={query}\` (titles/metadata, min 2 chars; add \`&ft=1\` to also search inside transcript statements — matched meetings then carry a \`matches\` object whose \`statements[].pageUrl\` deep-links to the exact moment via \`?t=\`), \`?category=…\`, \`?text=transcript|pv|sr\` (has that document type). Paginated 250/page over the last 365 days.
- Then fetch each item's \`textUrl\` verbatim from that response, e.g. \`https://transcripts.un.org/en/sc/10189.txt\`.

Common task — "summarize a day's meetings": call \`meetings.json?date=…\` WITHOUT \`text=transcript\` so you see everything that happened, then (1) summarize each meeting that has a transcript by fetching its \`textUrl\`, and (2) still list every meeting that lacks one as "occurred; transcript not available". Do not silently drop untranscribed meetings, and do not refuse the whole summary because some are missing. Use \`?text=transcript\` only when the task is explicitly to summarize the transcripts themselves.

Meeting slugs come from UN document symbols; multi-part recordings take a trailing \`/N\` (unsuffixed = part 1): Security Council \`/{locale}/sc/{n}\` (S/PV.{n}); General Assembly \`/{locale}/ga/{session}/{meeting}\`; GA committees \`/{locale}/ga/c{n}/{session}/{meeting}\`; Human Rights Council \`/{locale}/hrc/{session}/{meeting}\`; ECOSOC \`/{locale}/ecosoc/{year}/{meeting}\`; treaty bodies \`/{locale}/cat/{n}\`, \`/cerd/{n}\`, \`/ccpr/{n}\`, \`/cedaw/{n}\`, \`/crc/{n}\`, \`/crpd/{n}\`, \`/cescr/{n}\`, \`/cmw/{n}\`, \`/ced/{n}\`, \`/spt/{n}\`; daily briefings \`/{locale}/briefing/sg/{YYYY-MM-DD}\`, \`/briefing/pga/{YYYY-MM-DD}\`, \`/briefing/geneva/{YYYY-MM-DD}\`. Any meeting is also addressable by its UN Web TV asset id at \`/{locale}/asset/{asset_id}\` (e.g. /en/asset/k1o/k1o43lgs4z mirrors webtv.un.org/en/asset/k1o/k1o43lgs4z).

## API

- [Search / browse meetings](/en/meetings.json): \`GET /{locale}/meetings.json\` — filter by \`date\`, \`from\`/\`to\`, \`q\`, \`ft\`, \`category\`, \`text\`; returns items with literal \`pageUrl\`, \`jsonUrl\`, \`textUrl\`. Plain-text sibling at \`/{locale}/meetings.txt\` (no match snippets — use \`.json\` with \`ft=1\`).
- [Search inside transcripts](/en/meetings.json?q=ceasefire&ft=1): \`GET /{locale}/meetings.json?q={query}&ft=1\` — find meetings by what was *said*. Each hit carries the speaker, a snippet, and a \`?t=\` link to that exact moment.
- [Read a transcript (plain text)](/en/sc/10175.txt): \`GET /{locale}/{slug}.txt\` — speaker labels, timestamps, compact for LLM context.
- [Read a transcript (JSON)](/en/sc/10175.json): \`GET /{locale}/{slug}.json\` — statements, speakers, topics, optional word-level timing.
- Cite a moment: append \`?t=1:23:45\` to any meeting page URL — seeks the video there and highlights the statement. Accepts clock timestamps (\`m:ss\` or \`h:mm:ss\`) and legacy seconds (\`?t=5025\`); generated links use clock timestamps. Share a topic filter with \`?topic=<topic-key>\` (highlights only), or add \`&topicMode=all\` to show all content with highlights.

## Pages

- [Home](/en): browsable schedule of recent and upcoming meetings.
- [About](/en/about): how the transcripts are produced and their limitations.

## Optional

- [Full API reference](/llms-full.txt): detailed query parameters, response shapes, and known limitations.
- [OpenAPI spec](/openapi.json): machine-readable OpenAPI 3.0 spec (interactive UI at /openapi).
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
