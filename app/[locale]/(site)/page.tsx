import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { recordToVideo } from "@/lib/un-api";
import { queryVideos, type VideosQueryParams } from "@/lib/db";
import {
  getCachedTranscriptedEntries,
  getCachedTranscriptedEntriesByLanguage,
  getCachedAvailableDates,
  getCachedFilterOptions,
} from "@/lib/cached-db";
import { VideoTable } from "@/components/transcript-table";
import { SiteHeader } from "@/components/site-header";
import { HomeHero } from "@/components/home-hero";
import { pageWidth } from "@/lib/layout";
import { cn, jsonLdScript } from "@/lib/utils";
import { parseScheduleParams } from "@/lib/schedule-params";
import { getBaseUrl } from "@/lib/get-base-url";

export const dynamic = "force-dynamic";

const DAYS_BACK = 365;

// UTC today + N days as YYYY-MM-DD. Used to compute the default-browse window
// bounds. UTC (not local-TZ) math is deliberate: local `setDate` near midnight
// can roll into a different UTC day than `toISOString` reports, producing an
// off-by-one window edge depending on what time of day the page is rendered.
// Server (Vercel) and Postgres both run in UTC, so this matches the date
// column's semantics.
function shiftDate(deltaDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// Parsing and the ServerParams shape live in lib/schedule-params.ts — the
// client table runs the same parser over window.location to detect dropped
// navigations, so the two sides must never diverge.
export type { ServerParams } from "@/lib/schedule-params";

export default async function Home({
  params: routeParams,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, raw] = await Promise.all([routeParams, searchParams]);
  const params = parseScheduleParams(raw);

  // Sort: explicit param wins. Otherwise default to relevance (undefined →
  // rank DESC inside queryVideos) when there's a free-text query, else
  // date_desc for plain browsing.
  const sort = (() => {
    if (params.sort) {
      const [by, dir] = params.sort.split("_") as [
        "date" | "title",
        "asc" | "desc",
      ];
      return { by, dir };
    }
    if (params.q) return undefined;
    return { by: "date" as const, dir: "desc" as const };
  })();

  // Fetch transcript IDs (needed for hasTranscript filter AND for enriching
  // video records). We fetch both the union ("any language") and the
  // active-locale subset so the two-tier T badge can render correctly.
  const [transcriptedEntries, transcriptedEntriesInLocale] = await Promise.all([
    getCachedTranscriptedEntries(),
    getCachedTranscriptedEntriesByLanguage(locale),
  ]);

  // Default-browse mode: when no filters and no search are active, the
  // Recent/Upcoming toggle splits the same rows into past vs future groups,
  // so the loaded set has to cover BOTH sides for the toggle to be
  // meaningful. We bound the query to a symmetric `(7·weeks)`-day window
  // each side of today (today is inclusive on both sides, so the span is
  // `14·weeks − 1` days) and drop the row-count cap, so the initial render
  // reliably shows one full week each way regardless of schedule density
  // (a busy week of future-scheduled meetings used to eat the row budget
  // and leave only 2–3 days of past meetings visible). The bound excludes
  // the corresponding day from the *previous* / *next* week — at weeks=1
  // with today=Monday, the window is `[Tue…Mon]`, not `[Mon…Mon]`, so
  // "one week" really means seven distinct days. The "Load more" button
  // widens the window by another week via the `weeks` URL param.
  const isDefaultBrowse =
    !params.q && !params.date && !params.category && !params.text;
  const weeks = Math.max(1, params.weeks ?? 1);
  const windowDays = 7 * weeks - 1;

  const pageParams: VideosQueryParams = isDefaultBrowse
    ? {
        daysBack: DAYS_BACK,
        dateFrom: shiftDate(-windowDays),
        dateTo: shiftDate(windowDays),
        sort,
        // Effectively uncapped for the default window — even at peak GA
        // density a 13-day window holds well under 2000 meetings. The cap
        // only ever bites at very large `weeks` values, where it's a
        // safety net rather than a UX constraint.
        page: 1,
        pageSize: 2000,
        localeFilter: {
          locale,
          includeOther: params.includeOtherLangs === true,
        },
      }
    : {
        q: params.q,
        daysBack: DAYS_BACK,
        date: params.date,
        category: params.category,
        docs: params.text,
        sort,
        // Filtered/search mode: keep offset-based "Load more" pagination
        // (CHUNK rows per click). Must match CHUNK in
        // app/api/videos/route.ts.
        page: 1,
        pageSize: 100,
        transcriptedEntryIds: params.text?.includes("transcript")
          ? transcriptedEntries
          : undefined,
        localeFilter: {
          locale,
          includeOther: params.includeOtherLangs === true,
        },
        contentSearch:
          params.fullText && params.q ? { language: locale } : undefined,
      };

  const [
    { records, total, totalIncludingOther, contentMatches, statementTotal },
    availableDates,
    filterOptions,
  ] = await Promise.all([
    queryVideos(pageParams),
    getCachedAvailableDates(DAYS_BACK),
    getCachedFilterOptions(DAYS_BACK),
  ]);

  const transcriptedSet = new Set(transcriptedEntries);
  const transcriptedInLocaleSet = new Set(transcriptedEntriesInLocale);
  const videos = records.map((r) =>
    recordToVideo(
      r,
      r.entry_id ? transcriptedSet.has(r.entry_id) : false,
      locale,
      r.entry_id ? transcriptedInLocaleSet.has(r.entry_id) : false,
    ),
  );

  const base = await getBaseUrl();
  const tMeta = await getTranslations({ locale, namespace: "metadata" });
  const siteName = tMeta("siteTitle");
  // Two schema.org blocks for the homepage:
  //   - WebSite + potentialAction → enables Google's sitelinks search box,
  //     which deep-links queries straight into our schedule page's `q` param.
  //   - Organization → seeds a knowledge-graph identity for the project so
  //     brand searches start to consolidate around our domain instead of
  //     other "UN transcripts" results.
  // Both are emitted as a JSON-LD `@graph` so they share one <script> tag.
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${base}/#website`,
        url: `${base}/${locale}`,
        name: siteName,
        description: tMeta("siteDescription"),
        inLanguage: locale,
        potentialAction: {
          "@type": "SearchAction",
          target: {
            "@type": "EntryPoint",
            urlTemplate: `${base}/${locale}/?q={search_term_string}`,
          },
          "query-input": "required name=search_term_string",
        },
        publisher: { "@id": `${base}/#organization` },
      },
      {
        "@type": "Organization",
        "@id": `${base}/#organization`,
        name: siteName,
        url: base,
      },
    ],
  };

  return (
    <PageShell jsonLd={jsonLd}>
      <VideoTable
        videos={videos}
        totalCount={total}
        totalCountIncludingOther={totalIncludingOther}
        serverParams={params}
        availableDates={availableDates}
        filterOptions={filterOptions}
        contentMatches={contentMatches}
        statementTotal={statementTotal}
      />
    </PageShell>
  );
}

function PageShell({
  children,
  jsonLd,
}: {
  children: React.ReactNode;
  jsonLd?: object;
}) {
  return (
    <main id="main" tabIndex={-1} className="min-h-screen bg-background">
      {jsonLd && (
        <script
          type="application/ld+json"
          // Payload is currently translation-catalog + base URL only, but use
          // the escaping serializer for parity with the meeting page and to
          // stay safe if a DB/scraped field is ever added here.
          dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
        />
      )}
      <SiteHeader />
      <div className={cn("mx-auto px-4 sm:px-8", pageWidth)}>
        <HomeHero />
        <div className="pb-24">
          <Suspense fallback={null}>{children}</Suspense>
        </div>
      </div>
    </main>
  );
}
