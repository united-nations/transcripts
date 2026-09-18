import { getBaseUrl } from "@/lib/get-base-url";

// Hand-written robots.txt (instead of Next's MetadataRoute.Robots) so the
// header comments referencing llms.txt + the agent-readable URL grammar
// survive. Some agentic crawlers grep robots.txt before doing anything else.
export async function GET() {
  const base = await getBaseUrl();
  const body = `# LLM / agent index:
#   ${base}/llms.txt         — concise overview (llms.txt convention)
#   ${base}/llms-full.txt    — detailed API reference
#
# Every meeting has a plain-text and JSON sibling at the same URL:
#   /{locale}/{slug}.txt
#   /{locale}/{slug}.json
# e.g. /en/sc/10175.txt or /en/sc/10175.json
#
# Search inside the transcripts (find meetings by what was said):
#   /{locale}/meetings.json?q={query}&ft=1
# Each hit returns the speaker, a snippet, and a link to the exact moment.
#
# Cite a moment: append ?t={m:ss} or ?t={h:mm:ss} (legacy seconds also accepted) to any meeting page URL
#   /en/sc/10175?t=1:23:45

User-agent: *
Allow: /
# Locale-prefixed paths require the wildcard — /en/login etc. wouldn't
# match a bare "/login" disallow under Google's matching rules.
Disallow: /*/login
Disallow: /*/verify
Disallow: /*/subscriptions
# Speaker directory (overview + per-entity profiles) is login-gated and
# must not be indexed.
Disallow: /*/speakers
Disallow: /*/speakers/*

Sitemap: ${base}/sitemap.xml
`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
