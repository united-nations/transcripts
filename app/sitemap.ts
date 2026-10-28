import type { MetadataRoute } from "next";
import { routing } from "@/i18n/routing";
import { getSitemapMeetingLanguages } from "@/lib/db";
import { getBaseUrl } from "@/lib/get-base-url";
import { videoUrl } from "@/lib/video-url";
import { meetingHtmlLastModified } from "@/lib/meeting-freshness";

// Public-facing routes that are the same path across locales. Auth-walled
// surfaces (login, verify, subscriptions) and the entire speaker directory
// (overview + detail pages, login-gated) are intentionally omitted; they
// shouldn't be crawled or indexed.
const STATIC_PATHS = ["/", "/about"] as const;

/**
 * Emit a sitemap that lists every public route × every official locale, with
 * `alternates.languages` cross-references so search engines can resolve the
 * right language variant. Required complement to the per-page `<link
 * rel="alternate">` tags set by `alternatesFor()` — Google in particular
 * weights sitemap hreflang more reliably than HTML hreflang.
 *
 * Meeting URLs are restricted to (meeting × language) pairs that actually
 * have a completed transcript in that language. Meetings without any
 * transcript would be thin pages (player + UN Web TV link only), and locale
 * variants of a transcribed meeting without a same-language transcript would
 * be near-duplicates. Untranscribed meetings stay crawlable via the homepage
 * schedule; we simply don't push search engines to index stubs.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = await getBaseUrl();

  function staticLanguages(path: string) {
    const tail = path === "/" ? "" : path;
    return Object.fromEntries(
      routing.locales.map((l) => [l, `${base}/${l}${tail}`]),
    );
  }

  const staticEntries: MetadataRoute.Sitemap = STATIC_PATHS.flatMap((path) => {
    const languages = staticLanguages(path);
    return routing.locales.map((locale) => ({
      url: languages[locale],
      // No reliable static-page revision date: omit rather than falsely
      // announcing an edit every time the sitemap is requested.
      alternates: { languages },
    }));
  });

  const rows = await getSitemapMeetingLanguages(routing.locales).catch(
    () => [] as Awaited<ReturnType<typeof getSitemapMeetingLanguages>>,
  );

  // Group rows by slug so each meeting's hreflang `alternates.languages` only
  // references the locales where a transcript actually exists. A meeting with
  // en+fr transcripts emits two URL entries (/en/… and /fr/…) and each entry
  // cross-references just those two — no /es alternate that would point to a
  // page without same-language content.
  const bySlug = new Map<string, { languages: Record<string, Date> }>();
  for (const row of rows) {
    const slug = videoUrl(row);
    let bucket = bySlug.get(slug);
    if (!bucket) {
      bucket = { languages: {} };
      bySlug.set(slug, bucket);
    }
    const previous = bucket.languages[row.languageCode];
    if (!previous || row.lastModified > previous) {
      bucket.languages[row.languageCode] = row.lastModified;
    }
  }

  const meetingEntries: MetadataRoute.Sitemap = [];
  for (const [slug, { languages: byLang }] of bySlug) {
    const languages: Record<string, string> = Object.fromEntries(
      Object.keys(byLang).map((l) => [l, `${base}/${l}/${slug}`]),
    );
    // x-default points at English when present; otherwise omit so we don't
    // direct crawlers at a locale that has no transcript for this meeting.
    if (byLang.en) languages["x-default"] = `${base}/en/${slug}`;
    // Same hreflang grouping for the .txt sibling — LLM crawlers that follow
    // sitemap.xml (most do, since they share infra with search) get a direct
    // path to the plain-text transcript.
    const textLanguages: Record<string, string> = Object.fromEntries(
      Object.keys(byLang).map((l) => [l, `${base}/${l}/${slug}.txt`]),
    );
    if (byLang.en) textLanguages["x-default"] = `${base}/en/${slug}.txt`;
    for (const locale of Object.keys(byLang)) {
      meetingEntries.push({
        url: `${base}/${locale}/${slug}`,
        lastModified: meetingHtmlLastModified(byLang[locale]),
        alternates: { languages },
      });
      meetingEntries.push({
        url: `${base}/${locale}/${slug}.txt`,
        lastModified: byLang[locale],
        alternates: { languages: textLanguages },
      });
    }
  }

  return [...staticEntries, ...meetingEntries];
}
