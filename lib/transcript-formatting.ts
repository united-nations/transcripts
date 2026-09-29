/**
 * Pure formatting helpers for transcript rendering, extracted from
 * transcription-panel.tsx so they can be unit-tested in isolation.
 */
import { publicSpeakerInfo } from "./public-speakers";
import type { DisplaySpeakerMapping as SpeakerMapping } from "@/lib/public-speakers";

/** Format a duration in seconds as `M:SS` (or `H:MM:SS` past an hour). */
export function formatTimecode(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || isNaN(seconds)) return "";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

/** Format a duration in milliseconds as `M:SS` (or `H:MM:SS` past an hour). */
export function formatTimecodeMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || isNaN(ms)) return "";
  return formatTimecode(ms / 1000);
}

// Minimal structural shapes for the plain-text transcript serializer below —
// declared locally so this helper stays decoupled from the panel's richer
// internal types.
export interface PlainTextSegment {
  speaker?: string;
  statementIndices: number[];
  timestamp: number | null;
}

export interface PlainTextStatement {
  paragraphs: Array<{ sentences: Array<{ text: string; start?: number }> }>;
}

/**
 * Group consecutive statements by speaker identity into segments. Pure-data
 * utility shared by the client-side panel and the server-side text formatter.
 */
export function buildSpeakerSegments(
  statements: PlainTextStatement[],
  speakerMappings: SpeakerMapping,
): PlainTextSegment[] {
  const segs: PlainTextSegment[] = [];
  if (statements.length === 0) return segs;

  let currentSegment: PlainTextSegment | null = null;
  statements.forEach((stmt, index) => {
    const speakerInfo = speakerMappings[index.toString()];
    const speakerId = JSON.stringify(speakerInfo || {});
    const firstSentence = stmt.paragraphs[0]?.sentences[0];
    const timestamp =
      firstSentence?.start != null ? firstSentence.start / 1000 : null;

    if (!currentSegment || currentSegment.speaker !== speakerId) {
      if (currentSegment) segs.push(currentSegment);
      currentSegment = {
        speaker: speakerId,
        statementIndices: [index],
        timestamp,
      };
    } else {
      currentSegment.statementIndices.push(index);
    }
  });
  if (currentSegment) segs.push(currentSegment);
  return segs;
}

/**
 * Speaker-segmented plain-text body for a transcript: one block per speaker
 * turn, with a `Speaker [M:SS]:` header, blank line, then each paragraph on
 * its own line separated by blank lines. Used by the `.txt` download and the
 * "Copy to clipboard" action.
 */
export function formatTranscriptAsPlainText(
  segments: PlainTextSegment[],
  statements: PlainTextStatement[],
  getSpeakerText: (statementIndex: number) => string,
  formatTime: (seconds: number) => string,
): string {
  const lines: string[] = [];
  segments.forEach((segment) => {
    const firstStmtIndex = segment.statementIndices[0] ?? 0;
    const speaker = getSpeakerText(firstStmtIndex);
    const timestamp =
      segment.timestamp !== null ? ` [${formatTime(segment.timestamp)}]` : "";
    lines.push(`${speaker}${timestamp}:`);
    lines.push("");
    segment.statementIndices.forEach((stmtIdx) => {
      const stmt = statements[stmtIdx];
      if (!stmt) return;
      stmt.paragraphs.forEach((para) => {
        lines.push(para.sentences.map((s) => s.text).join(" "));
        lines.push("");
      });
    });
    lines.push("");
  });
  return lines.join("\n");
}

/**
 * Build a human-readable speaker label from the resolved speaker mapping,
 * expanding ISO country codes via `countryNames` when available. Falls back to
 * `Speaker N` when the speaker is unknown.
 */
export function formatSpeakerText(
  statementIndex: number | undefined,
  speakerMappings: SpeakerMapping,
  countryNames: Map<string, string>,
): string {
  if (statementIndex === undefined) return "Speaker";
  const info = publicSpeakerInfo(speakerMappings[statementIndex.toString()]);
  if (!info || (!info.affiliation && !info.group && !info.function)) {
    return `Speaker ${statementIndex + 1}`;
  }
  const parts: string[] = [];
  if (info.affiliation)
    parts.push(countryNames.get(info.affiliation) || info.affiliation);
  if (info.group) parts.push(info.group);
  if (info.function && info.function.toLowerCase() !== "representative")
    parts.push(info.function);
  return parts.join(" · ");
}
