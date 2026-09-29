"use client";

import type {
  DisplaySpeakerInfo as SpeakerInfo,
  DisplaySpeakerMapping as SpeakerMapping,
} from "@/lib/public-speakers";
import { TocItem, useTocActiveScroll } from "@/components/toc-item";
import { formatTimecode } from "@/lib/transcript-formatting";
import { typography } from "@/lib/typography";
import { cn } from "@/lib/utils";

interface SpeakerSegment {
  speaker: string;
  statementIndices: number[];
  timestamp: number;
}

interface StatementForTopic {
  paragraphs: Array<{
    sentences: Array<{
      topic_keys?: string[];
    }>;
  }>;
}

interface SpeakerTocProps {
  segments: SpeakerSegment[];
  speakerMappings: SpeakerMapping;
  countryNames: Map<string, string>;
  activeSegmentIndex: number;
  onSeek: (timestampSeconds: number) => void;
  selectedTopic?: string | null;
  topicColor?: string | null;
  statements?: StatementForTopic[] | null;
}

export function getSpeakerInfoFlags(info: SpeakerInfo | undefined) {
  const hasAffiliation = !!info?.affiliation;
  const hasGroup = !!info?.group;
  const hasFunction =
    !!info?.function &&
    info.function.toLowerCase() !== "representative" &&
    !/^speaker\s/i.test(info.function);
  return { hasAffiliation, hasGroup, hasFunction };
}

export function hasMeaningfulSpeakerInfo(
  info: SpeakerInfo | undefined,
): boolean {
  const { hasAffiliation, hasGroup, hasFunction } = getSpeakerInfoFlags(info);
  return hasAffiliation || hasGroup || hasFunction;
}

function segmentHasTopic(
  segment: SpeakerSegment,
  statements: StatementForTopic[],
  topicKey: string,
): boolean {
  return segment.statementIndices.some((stmtIdx) => {
    const stmt = statements[stmtIdx];
    if (!stmt) return false;
    return stmt.paragraphs.some((para) =>
      para.sentences.some((sent) => sent.topic_keys?.includes(topicKey)),
    );
  });
}

export function SpeakerToc({
  segments,
  speakerMappings,
  countryNames,
  activeSegmentIndex,
  onSeek,
  selectedTopic,
  topicColor,
  statements,
}: SpeakerTocProps) {
  const itemRefs = useTocActiveScroll(activeSegmentIndex);

  if (segments.length === 0) return null;

  return (
    <div>
      {segments.map((segment, idx) => {
        const isActive = idx === activeSegmentIndex;
        const firstStmtIndex = segment.statementIndices[0] ?? 0;
        const info = speakerMappings[firstStmtIndex.toString()];

        const { hasAffiliation, hasGroup, hasFunction } =
          getSpeakerInfoFlags(info);
        if (!hasAffiliation && !hasGroup && !hasFunction) return null;

        const hasTopic =
          selectedTopic && statements
            ? segmentHasTopic(segment, statements, selectedTopic)
            : false;

        return (
          <TocItem
            key={idx}
            buttonRef={(el) => {
              itemRefs.current[idx] = el;
            }}
            isActive={isActive}
            onClick={() => onSeek(segment.timestamp)}
            timestamp={formatTimecode(segment.timestamp)}
            trailing={
              hasTopic && topicColor ? (
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: topicColor }}
                />
              ) : undefined
            }
          >
            {hasAffiliation && (
              <span
                className={cn(
                  typography.label,
                  "rounded bg-blue-100 px-1 py-px text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
                )}
              >
                {countryNames.get(info!.affiliation!) || info!.affiliation}
              </span>
            )}
            {hasGroup && (
              <span
                className={cn(
                  typography.label,
                  "rounded bg-purple-100 px-1 py-px text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
                )}
              >
                {info!.group}
              </span>
            )}
            {hasFunction && (
              <span className="text-muted-foreground">{info!.function}</span>
            )}
          </TocItem>
        );
      })}
    </div>
  );
}
