"use client";

import { formatTimestamp } from "@/lib/timestamp-url";
import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { ContentMatchSummary, StatementHit } from "@/lib/db";
import { markParts, parseSearchQuery } from "@/lib/statement-search";
import { getCountryName } from "@/lib/country-lookup";

/**
 * Content-search hit sub-rows, rendered directly after their meeting's row
 * in the schedule table (plain `<tr>`s — always expanded while the
 * "search inside transcripts" checkbox is on). Each hit deep-links into the
 * transcript at its timestamp via `?t=`; the first CONTENT_HITS_PER_MEETING
 * hits arrive inline with the feed, the rest load on "show all".
 *
 * Deliberately quiet styling: a single muted speaker line (no name — the
 * transcript pages hide names too — and no colored pills) so the UN-blue
 * term highlight is the only color in the row.
 */
export function TranscriptMatchRows({
  assetId,
  slug,
  query,
  matches,
}: {
  assetId: string;
  /** Locale-agnostic meeting path (Video.slug). */
  slug: string;
  query: string;
  matches: ContentMatchSummary;
}) {
  const locale = useLocale();
  const t = useTranslations("schedule");
  const highlightTerms = useMemo(
    () => parseSearchQuery(query).highlightTerms,
    [query],
  );

  // null until "show all" fetched the complete hit list for this meeting.
  const [allHits, setAllHits] = useState<StatementHit[] | null>(null);
  const [loadingAll, setLoadingAll] = useState(false);
  const hits = allHits ?? matches.hits;
  const remaining = matches.count - hits.length;

  const showAll = async () => {
    if (loadingAll) return;
    setLoadingAll(true);
    try {
      const sp = new URLSearchParams({ assetId, q: query, locale });
      const res = await fetch(`/api/videos/matches?${sp.toString()}`);
      if (res.ok) {
        const data = (await res.json()) as { hits?: StatementHit[] };
        if (Array.isArray(data.hits)) setAllHits(data.hits);
      }
    } catch {
      // Leave the inline hits in place; the button stays clickable.
    } finally {
      setLoadingAll(false);
    }
  };

  // Muted one-line attribution: affiliation · group · function. Names are
  // hidden (matching the transcript pages); "representative" is noise.
  const speakerLine = (speaker: StatementHit["speaker"]): string =>
    [
      speaker?.affiliation
        ? getCountryName(speaker.affiliation, locale) || speaker.affiliation
        : null,
      speaker?.group,
      speaker?.function?.toLowerCase() !== "representative"
        ? speaker?.function
        : null,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <>
      {hits.map((hit) => {
        const attribution = speakerLine(hit.speaker);
        return (
          <tr
            key={hit.statementIdx}
            className="border-b border-gray-100 bg-muted/30 transition-colors last:border-0 hover:bg-muted/60"
          >
            <td className="px-4 py-2" />
            <td className="px-0 py-2" />
            <td className="px-4 py-2 align-top" colSpan={2}>
              <Link
                href={`/${slug}?t=${formatTimestamp(hit.startSeconds)}`}
                className="group block"
              >
                {attribution && (
                  <div className="text-xs font-medium text-muted-foreground">
                    {attribution}
                  </div>
                )}
                <p
                  dir="auto"
                  className="mt-0.5 text-start text-xs leading-relaxed text-muted-foreground group-hover:text-foreground"
                >
                  {hit.leading && "… "}
                  {markParts(hit.text, highlightTerms).map((part, i) =>
                    part.mark ? (
                      <mark
                        key={i}
                        className="rounded-sm bg-un-blue/25 px-0.5 text-foreground"
                      >
                        {part.text}
                      </mark>
                    ) : (
                      <span key={i}>{part.text}</span>
                    ),
                  )}
                  {hit.trailing && " …"}
                </p>
              </Link>
            </td>
          </tr>
        );
      })}
      {remaining > 0 && (
        <tr className="border-b border-gray-100 bg-muted/30 last:border-0">
          <td className="px-4 py-1.5" />
          <td className="px-0 py-1.5" />
          <td className="px-4 py-1.5" colSpan={2}>
            <button
              onClick={showAll}
              disabled={loadingAll}
              className="text-xs text-un-blue underline-offset-4 hover:underline disabled:opacity-50"
            >
              {loadingAll
                ? t("loading")
                : t("showAllMatches", { count: matches.count })}
            </button>
          </td>
        </tr>
      )}
    </>
  );
}
