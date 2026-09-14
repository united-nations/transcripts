import { UPSTREAM_USER_AGENT } from "../lib/upstream-identity";

/**
 * One-shot harvester: scrape WebTV's per-locale schedule pages across several
 * dates and build an English → { fr, es, ar, zh, ru } mapping of category
 * names by matching on `asset_id` (the URL slug is shared across locales).
 *
 * Output: prints a JSON blob to stdout that can be merged into
 * messages/{locale}.json under `schedule.categoryNames`.
 *
 * Run: tsx scripts/harvest-categories.ts > /tmp/categories.json
 *
 * Not in package.json — intended to be run ad hoc when the canonical list
 * changes; not part of the production pipeline.
 */

const LOCALES = ["en", "fr", "es", "ar", "zh", "ru"] as const;
type Locale = (typeof LOCALES)[number];

// Mirrors the regex in lib/un-api.ts but with the locale prefix templated in.
function videoBlockPattern(locale: Locale): RegExp {
  return new RegExp(
    `<h6[^>]*class="text-primary"[^>]*>([^<]+)<\\/h6>[\\s\\S]*?<h4[^>]*>[\\s\\S]*?href="\\/${locale}\\/asset\\/([^"]+)"`,
    "g",
  );
}

function decodeEntities(s: string): string {
  // Cover the most common entities WebTV emits in category text. Numeric
  // entities like &#039; (apostrophe) appear in French categories.
  return s
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    );
}

function extractText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchSchedule(
  locale: Locale,
  date: string,
): Promise<Array<{ assetId: string; category: string }>> {
  const url = `https://webtv.un.org/${locale}/schedule/${date}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UPSTREAM_USER_AGENT },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const out: Array<{ assetId: string; category: string }> = [];
    for (const m of html.matchAll(videoBlockPattern(locale))) {
      const [, category, assetId] = m;
      out.push({ assetId, category: extractText(category) });
    }
    return out;
  } catch (e) {
    console.error(`! fetch failed for ${locale} ${date}:`, e);
    return [];
  }
}

function dateRange(start: string, days: number): string[] {
  const out: string[] = [];
  const d = new Date(start + "T00:00:00Z");
  for (let i = 0; i < days; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function main() {
  // 365-day window ending today maximizes the chance of catching seasonal
  // bodies (HRC sessions, ICJ hearings, annual conferences) that don't appear
  // in shorter windows. Rare categories like Trusteeship Council still won't
  // show up; those get hand-completed from UN-standard translations below.
  const start = new Date(Date.now() - 365 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const dates = dateRange(start, 365);
  console.error(
    `Harvesting ${dates.length} dates × ${LOCALES.length} locales = ${dates.length * LOCALES.length} requests...`,
  );

  // assetId → { locale → category }
  const perAsset = new Map<string, Partial<Record<Locale, string>>>();

  // Run in parallel chunks to keep it under a few minutes.
  const chunkSize = 12;
  let done = 0;
  for (let i = 0; i < dates.length; i += chunkSize) {
    const chunk = dates.slice(i, i + chunkSize);
    await Promise.all(
      chunk.flatMap((date) =>
        LOCALES.map(async (locale) => {
          const rows = await fetchSchedule(locale, date);
          for (const { assetId, category } of rows) {
            const entry = perAsset.get(assetId) ?? {};
            // First occurrence wins per (locale, assetId).
            if (!entry[locale]) entry[locale] = category;
            perAsset.set(assetId, entry);
          }
        }),
      ),
    );
    done += chunk.length * LOCALES.length;
    console.error(`  ${done}/${dates.length * LOCALES.length}`);
  }

  // For each English category, count co-occurring non-EN categories.
  // pair[en][locale][nonEnCategory] = count
  const pair: Record<string, Record<Locale, Record<string, number>>> = {};
  for (const entry of perAsset.values()) {
    const en = entry.en;
    if (!en) continue;
    pair[en] ??= { en: {}, fr: {}, es: {}, ar: {}, zh: {}, ru: {} } as Record<
      Locale,
      Record<string, number>
    >;
    for (const locale of LOCALES) {
      if (locale === "en") continue;
      const v = entry[locale];
      if (!v) continue;
      pair[en][locale][v] = (pair[en][locale][v] ?? 0) + 1;
    }
  }

  // Pick the most common non-EN category per (en, locale).
  const result: Record<string, Record<Locale, string>> = {};
  for (const [en, byLocale] of Object.entries(pair)) {
    const row = { en } as Record<Locale, string>;
    let anyTranslation = false;
    for (const locale of LOCALES) {
      if (locale === "en") continue;
      const candidates = byLocale[locale];
      if (!candidates || Object.keys(candidates).length === 0) continue;
      const best = Object.entries(candidates).sort((a, b) => b[1] - a[1])[0][0];
      row[locale] = best;
      anyTranslation = true;
    }
    if (anyTranslation) result[en] = row;
  }

  // Sorted by EN string for deterministic diff.
  const sorted = Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => a.localeCompare(b)),
  );

  // Summary to stderr; JSON to stdout.
  const total = Object.keys(sorted).length;
  console.error(
    `\nCollected ${total} English categories with at least one translation:`,
  );
  for (const [en, row] of Object.entries(sorted)) {
    const langs = LOCALES.filter((l) => l !== "en" && row[l]).join(",");
    console.error(`  ${en.padEnd(40)} → ${langs}`);
  }

  process.stdout.write(JSON.stringify(sorted, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
