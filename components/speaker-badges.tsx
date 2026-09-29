"use client";

import type { DisplaySpeakerInfo as SpeakerInfo } from "@/lib/public-speakers";

/**
 * The speaker badge row used wherever a transcript statement is attributed:
 * blue affiliation pill (display name resolved by the caller — country
 * lookup is locale-dependent), purple group pill, muted function text
 * (suppressed for the generic "representative"). Extracted from
 * transcript-view so search-hit rows render speakers identically to the
 * transcript itself. Renders nothing when the info carries no signal —
 * callers decide their own fallback (e.g. "Speaker N").
 */
export function SpeakerBadges({
  info,
  affiliationName,
}: {
  info: SpeakerInfo | null | undefined;
  /** Localized display name for info.affiliation (ISO code otherwise). */
  affiliationName?: string | null;
}) {
  if (!info || (!info.affiliation && !info.group && !info.function)) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {info.affiliation && (
        <span className="inline-flex items-center rounded-md bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
          {affiliationName || info.affiliation}
        </span>
      )}
      {info.group && (
        <span className="inline-flex items-center rounded-md bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800 dark:bg-purple-900/30 dark:text-purple-300">
          {info.group}
        </span>
      )}
      {info.function && info.function.toLowerCase() !== "representative" && (
        <span className="text-sm font-medium text-muted-foreground">
          {info.function}
        </span>
      )}
    </div>
  );
}
