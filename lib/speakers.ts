import { publicSpeakerInfo, type DisplaySpeakerInfo } from "./public-speakers";

export type { SpeakerInfo, SpeakerMapping } from "@/lib/db";
export { getSpeakerMapping, setSpeakerMapping } from "@/lib/db";

export interface FormattedSpeakerInfo {
  affiliation: string | null;
  affiliation_full: string | null;
  group: string | null;
  function: string | null;
}

export function formatSpeakerInfo(
  info: DisplaySpeakerInfo | undefined,
  countryNames?: Map<string, string>,
): FormattedSpeakerInfo {
  const speaker = publicSpeakerInfo(info);
  return {
    ...speaker,
    affiliation_full: speaker.affiliation
      ? countryNames?.get(speaker.affiliation) || speaker.affiliation
      : null,
  };
}
