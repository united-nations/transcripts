import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { alternatesFor } from "@/i18n/routing";
import {
  extractKalturaId,
  KALTURA_PARTNER_ID,
  KALTURA_UICONF_ID,
} from "@/lib/kaltura";
import { getCachedTranscriptedEntries } from "@/lib/cached-db";
import { getBaseUrl } from "@/lib/get-base-url";
import { getCurrentUser } from "@/lib/auth/service";
import { localizeWebtvAssetUrl } from "@/lib/un-links";
import type { VideoRecord } from "@/lib/db";
import { formatDateForMetadata } from "@/lib/timezone";
import { videoUrl } from "@/lib/video-url";
import {
  fetchAssetPage,
  parseVideoMetadata,
  createEmptyMetadata,
  recordToVideo,
} from "@/lib/un-api";
import { fetchKalturaEntryStatuses } from "@/lib/kaltura-helpers";
import {
  applyRemoval,
  classifyKaltura,
  classifyWebtv,
  type Liveness,
} from "@/lib/removed-videos";
import { widePageWidth } from "@/lib/layout";
import { cn, jsonLdScript } from "@/lib/utils";
import { ExternalLink } from "@/components/external-link";
import { VideoPageClient } from "@/components/video-page-client";
import { MeetingStateProvider } from "@/components/meeting-state/meeting-state";
import { ServerTranscript } from "@/components/server-transcript";
import { TranscriptSkeleton } from "@/components/transcript-skeleton";
import { Suspense } from "react";

/**
 * A WebTV category in the active locale, for the meta description and
 * `og:section`. Server-side twin of the `useCategoryName()` hook: same catalog,
 * same `has()` fallback for categories we haven't catalogued.
 *
 * Callers pass `recordToVideo(...).category`, never `record.body` — body has no
 * per-locale variant, so it drops an English "Security Council" into a
 * translated sentence. Returns "" for an uncategorized meeting, which selects
 * the category-less description variant.
 */
async function localizedCategoryName(
  category: string,
  locale: string,
): Promise<string> {
  if (!category) return "";
  const t = await getTranslations({
    locale,
    namespace: "schedule.categoryNames",
  });
  return t.has(category) ? t(category) : category;
}

/**
 * Shared metadata builder for a video page. Both the citation route
 * (`/{citation}`) and the permalink route (`/asset/{asset_id}`) call this;
 * `canonicalPath` is `videoUrl(record)` so both forms canonicalize to the
 * preferred URL (citation when available, asset permalink otherwise).
 */
export async function buildVideoMetadata({
  record,
  locale,
}: {
  record: VideoRecord;
  locale: string;
}): Promise<Metadata> {
  // The locale-resolved view, so <title> and og:title match the <h1> the page
  // actually renders. `record.clean_title` is the English canonical (kept as
  // the FTS source); reading it here shipped an identical English <title> to
  // all six hreflang alternates.
  const video = recordToVideo(record, false, locale);
  const title = video.cleanTitle || video.title;
  const t = await getTranslations({ locale, namespace: "metadata" });
  const siteTitle = t("siteTitle");
  const pageTitle = `${title} — ${siteTitle}`;
  const dateLabel = formatDateForMetadata(record.date, locale);
  const category = await localizedCategoryName(video.category, locale);
  const description = category
    ? t("meetingDescription", { category, date: dateLabel })
    : t("meetingDescriptionNoCategory", { date: dateLabel });

  const canonicalPath = videoUrl(record);
  const ogImage = `/api/og/meeting/${canonicalPath}`;

  // Per-meeting machine-readable siblings. Each gets a <link rel="alternate"
  // type="..."> in <head> (Next.js Metadata.alternates.types) so HTML-only
  // crawlers discover the .txt/.json variants without needing the HTTP Link
  // header set by proxy.ts.
  const langAlternates = alternatesFor(locale, `/${canonicalPath}`);

  return {
    title: pageTitle,
    description,
    alternates: {
      ...langAlternates,
      types: {
        "text/plain": `/${locale}/${canonicalPath}.txt`,
        "application/json": `/${locale}/${canonicalPath}.json`,
      },
    },
    openGraph: {
      type: "article",
      siteName: siteTitle,
      title,
      description,
      url: `/${locale}/${canonicalPath}`,
      publishedTime: record.date,
      section: category || undefined,
      images: [{ url: ogImage, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogImage],
    },
  };
}

/**
 * Shared video page renderer. Both /{citation} and /asset/{asset_id} routes
 * call this with the resolved VideoRecord. The OG image and JSON-LD
 * thumbnail use the canonical (citation-preferred) URL.
 */
export async function renderVideoPage({
  record,
  locale,
}: {
  record: VideoRecord;
  locale: string;
}) {
  // Already-removed videos are gone from our site, transcript or not. (Newly
  // removed ones are caught below by the lazy probe on this same render.)
  if (record.removed_at) notFound();

  const kalturaId = extractKalturaId(record.asset_id);

  if (!kalturaId) {
    return (
      <main
        id="main"
        tabIndex={-1}
        className="min-h-screen bg-background px-4 sm:px-6"
      >
        <div className="mx-auto max-w-5xl py-8">
          <Link
            href="/"
            className="mb-4 inline-block text-primary hover:underline"
          >
            &larr; Back to homepage
          </Link>
          <div className="space-y-2">
            <p className="text-red-600">Unable to extract video ID</p>
            <p className="text-sm text-muted-foreground">
              Asset ID: {record.asset_id}
            </p>
            <ExternalLink
              href={localizeWebtvAssetUrl(record.url, locale)}
              className="block text-sm text-primary hover:underline"
            >
              View on UN Web TV &rarr;
            </ExternalLink>
          </div>
        </div>
      </main>
    );
  }

  const transcriptedEntries = await getCachedTranscriptedEntries();
  const hasTranscript =
    record.entry_id !== null && transcriptedEntries.includes(record.entry_id);

  const video = recordToVideo(record, hasTranscript, locale);

  // Lazy removal detection. The render already fetches the WebTV asset page for
  // metadata, so reuse that response as a liveness signal: a 404 means the asset
  // was unpublished. Probe Kaltura only when WebTV is still live (a WebTV 404
  // alone already settles it). If either upstream is gone, persist the removal
  // off the response path via after() and 404 this render. Already-removed rows
  // never reach here — getVideoBy* filters them (they 404 upstream in the route).
  const { status, html } = await fetchAssetPage(record.asset_id);
  const webtv = classifyWebtv(status);
  let kaltura: Liveness = "unknown";
  if (webtv === "live" && record.entry_id) {
    const statuses = await fetchKalturaEntryStatuses([record.entry_id], {
      visitor: true,
    });
    kaltura = classifyKaltura(statuses.get(record.entry_id));
  }
  if (webtv === "gone" || kaltura === "gone") {
    after(() => applyRemoval(record.asset_id, { webtv, kaltura }));
    notFound();
  }

  const metadata = html ? parseVideoMetadata(html) : createEmptyMetadata();
  const user = await getCurrentUser();
  const isLoggedIn = !!user;
  const experimentalAccess = user?.experimentalAccess ?? false;

  const tMeta = await getTranslations({ locale, namespace: "metadata" });
  const dateLabel = formatDateForMetadata(record.date, locale);
  const category = await localizedCategoryName(video.category, locale);
  const fallbackDescription = category
    ? tMeta("meetingDescription", { category, date: dateLabel })
    : tMeta("meetingDescriptionNoCategory", { date: dateLabel });
  const baseUrl = await getBaseUrl();
  const canonicalPath = videoUrl(record);
  const embedUrl = `https://cdnapisec.kaltura.com/p/${KALTURA_PARTNER_ID}/sp/${KALTURA_PARTNER_ID}00/embedIframeJs/uiconf_id/${KALTURA_UICONF_ID}/partner_id/${KALTURA_PARTNER_ID}?iframeembed=true&entry_id=${record.entry_id ?? kalturaId}`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: video.cleanTitle || video.title,
    description:
      metadata.description || metadata.summary || fallbackDescription,
    thumbnailUrl: `${baseUrl}/api/og/meeting/${canonicalPath}`,
    uploadDate: record.date,
    duration:
      typeof record.duration === "number" && record.duration > 0
        ? `PT${Math.round(record.duration)}S`
        : undefined,
    embedUrl,
    inLanguage: locale,
    isFamilyFriendly: true,
    publisher: {
      "@type": "Organization",
      name: "United Nations",
      url: "https://www.un.org",
    },
  };

  const tFormats = await getTranslations({
    locale,
    namespace: "video.formats",
  });
  const textHref = `/${locale}/${canonicalPath}.txt`;
  const jsonHref = `/${locale}/${canonicalPath}.json`;

  // Streaming SSR: the page shell (header, player, sidebar, machine-formats
  // line below) is rendered synchronously and flushed at ~TTFB. The
  // <ServerTranscript> inside the Suspense boundary awaits the transcript
  // DB query in parallel; its resolved markup arrives as a late HTTP chunk
  // and React swaps the skeleton for the real transcript in place. No-JS
  // crawlers wait for the full response and see the transcript text inline
  // either way — but humans see chrome paint at ~150 ms instead of ~700.
  //
  // State shared across the Suspense boundary (selectedLanguage, panelData,
  // player, …) lives in <MeetingStateProvider> above, so the chrome
  // (VideoPageClient) and the streamed-in panel can both read/write it.
  return (
    <main id="main" tabIndex={-1} className="min-h-screen bg-background">
      <script
        type="application/ld+json"
        // Escape </script> and U+2028/2029 breakout: name/description derive
        // from scraped WebTV titles + AI summaries, which are untrusted.
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
      />
      <MeetingStateProvider kalturaId={kalturaId}>
        <VideoPageClient
          kalturaId={kalturaId}
          video={video}
          metadata={metadata}
          isLoggedIn={isLoggedIn}
        >
          <Suspense fallback={<TranscriptSkeleton />}>
            <ServerTranscript
              kalturaId={kalturaId}
              locale={locale}
              isLoggedIn={isLoggedIn}
              experimentalAccess={experimentalAccess}
              video={video}
              record={record}
            />
          </Suspense>
        </VideoPageClient>
      </MeetingStateProvider>
      {/* Server-rendered after the (client-only) transcript panel so an
          agent fetching this URL with no JS sees fetchable links to the
          .txt / .json siblings. Position is "below the transcript" in the
          rendered DOM but — critically — appears in the initial HTML
          payload before hydration, which is what HTML-parsing crawlers see.
          The site-wide llms.txt is linked from the site footer instead. */}
      <p
        className={cn(
          "mx-auto px-4 py-4 text-xs text-muted-foreground sm:px-8",
          widePageWidth,
        )}
      >
        {tFormats("title")}:{" "}
        <a href={textHref} className="underline hover:text-foreground">
          {tFormats("text")}
        </a>{" "}
        ·{" "}
        <a href={jsonHref} className="underline hover:text-foreground">
          {tFormats("json")}
        </a>
      </p>
    </main>
  );
}
