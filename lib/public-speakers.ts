import type { SpeakerInfo, SpeakerMapping } from "./db";

/** Attribution safe for ordinary display and exports; inferred names stay internal. */
export interface PublicSpeakerInfo {
  affiliation: string | null;
  group: string | null;
  function: string | null;
  name?: never;
  /** Transcript-local turn number, never a name or a hash of one. */
  turn_id?: number;
}

export type DisplaySpeakerInfo = SpeakerInfo | PublicSpeakerInfo;
export type DisplaySpeakerMapping = Record<string, DisplaySpeakerInfo>;

export function publicSpeakerInfo(
  info: DisplaySpeakerInfo | null | undefined,
): PublicSpeakerInfo {
  return {
    affiliation: info?.affiliation || null,
    group: info?.group || null,
    function:
      info?.function?.toLowerCase() === "representative"
        ? null
        : info?.function || null,
  };
}

/** Call after off-record filtering. Preserve original consecutive speaker turns. */
export function publicSpeakerMapping(
  mapping: SpeakerMapping,
  statementCount: number,
): Record<string, PublicSpeakerInfo> {
  const result: Record<string, PublicSpeakerInfo> = {};
  let previousIdentity: string | undefined;
  let turn = -1;
  for (let index = 0; index < statementCount; index++) {
    const info = mapping[index.toString()];
    const identity = JSON.stringify(info || {});
    if (identity !== previousIdentity) turn++;
    previousIdentity = identity;
    result[index.toString()] = { ...publicSpeakerInfo(info), turn_id: turn };
  }
  return result;
}
