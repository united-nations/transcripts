"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Link as LinkIcon } from "lucide-react";
import type { DisplaySpeakerMapping as SpeakerMapping } from "@/lib/public-speakers";
import { SpeakerBadges } from "@/components/speaker-badges";
import { getTopicColor } from "@/components/transcription-panel";
import { formatTimecode } from "@/lib/transcript-formatting";
import { typography } from "@/lib/typography";
import { cn } from "@/lib/utils";
import { weaveSentenceParts } from "@/lib/weave-sentence-parts";

interface Word {
  text: string;
  speaker?: string | null;
  start: number;
  end: number;
}

interface Statement {
  paragraphs: Array<{
    sentences: Array<{
      text: string;
      start: number;
      end: number;
      topic_keys?: string[];
      words?: Word[];
    }>;
    start: number;
    end: number;
    // Optional at every level — first paint runs without word-level
    // timestamps; they get merged in once /api/transcripts/[id]/words
    // returns and the panel re-renders.
    words?: Word[];
  }>;
  start: number;
  end: number;
  words?: Word[];
}

interface SpeakerSegment {
  speaker: string;
  statementIndices: number[];
  timestamp: number;
}

function renderSpeakerInfo(
  statementIndex: number | undefined,
  speakerMappings: SpeakerMapping,
  countryNames: Map<string, string>,
  labels: { speaker: string; speakerN: (n: number) => string },
) {
  if (statementIndex === undefined) {
    return <span>{labels.speaker}</span>;
  }

  const info = speakerMappings[statementIndex.toString()];

  if (!info || (!info.affiliation && !info.group && !info.function)) {
    return <span>{labels.speakerN(statementIndex + 1)}</span>;
  }

  return (
    <SpeakerBadges
      info={info}
      affiliationName={
        info.affiliation ? countryNames.get(info.affiliation) : null
      }
    />
  );
}

interface TranscriptViewProps {
  segments: SpeakerSegment[];
  statements: Statement[] | null;
  speakerMappings: SpeakerMapping;
  countryNames: Map<string, string>;
  topics: Record<string, { key: string; label: string; description: string }>;
  activeSegmentIndex: number;
  activeStatementIndex: number;
  activeParagraphIndex: number;
  activeSentenceIndex: number;
  activeWordIndex: number;
  selectedTopic: string | null;
  topicCollapsed: boolean;
  onSeek: (timestampSeconds: number) => void;
  /** Build the shareable deeplink for a segment's timestamp (`?t=` anchor).
   *  Omitted by callers that have no canonical URL to link to. */
  getAnchorUrl?: (timestampSeconds: number) => string;
  /** Segment to pulse once on arrival via a `?t=` deeplink. */
  flashSegmentIndex?: number | null;
}

export function TranscriptView({
  segments,
  statements,
  speakerMappings,
  countryNames,
  topics,
  activeSegmentIndex,
  activeStatementIndex,
  activeParagraphIndex,
  activeSentenceIndex,
  activeWordIndex,
  selectedTopic,
  topicCollapsed,
  onSeek,
  getAnchorUrl,
  flashSegmentIndex = null,
}: TranscriptViewProps) {
  const t = useTranslations("transcript.view");
  const speakerLabels = {
    speaker: t("speaker"),
    speakerN: (n: number) => t("speakerN", { n }),
  };
  // Which segment's anchor button just copied — swaps the link icon for a
  // check for a beat as the confirmation, announced via the aria-live span.
  const [copiedSegment, setCopiedSegment] = useState<number | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyAnchor = async (segmentIndex: number, seconds: number) => {
    if (!getAnchorUrl) return;
    try {
      await navigator.clipboard.writeText(getAnchorUrl(seconds));
    } catch {
      return;
    }
    setCopiedSegment(segmentIndex);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopiedSegment(null), 2000);
  };
  const allTopicKeys = Object.keys(topics);
  const highlightColor = selectedTopic
    ? getTopicColor(selectedTopic, allTopicKeys)
    : null;

  return (
    <div className="space-y-3">
      <span aria-live="polite" className="sr-only">
        {copiedSegment !== null ? t("linkCopied") : ""}
      </span>
      {segments.map((segment, segmentIndex) => {
        const isSegmentActive = segmentIndex === activeSegmentIndex;
        const firstStmtIndex = segment.statementIndices[0] ?? 0;

        if (topicCollapsed && selectedTopic) {
          const hasAnyHighlight = segment.statementIndices.some((stmtIdx) => {
            const stmt = statements?.[stmtIdx];
            return stmt?.paragraphs.some((para) =>
              para.sentences.some((sent) =>
                sent.topic_keys?.includes(selectedTopic),
              ),
            );
          });
          if (!hasAnyHighlight) return null;
        }

        return (
          <div key={segmentIndex} className="group space-y-1 pt-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className={typography.speakerLabel}>
                {renderSpeakerInfo(
                  firstStmtIndex,
                  speakerMappings,
                  countryNames,
                  speakerLabels,
                )}
              </div>
              <button
                onClick={() => onSeek(segment.timestamp)}
                className={cn(
                  typography.caption,
                  "rounded px-1.5 py-0.5 transition-colors hover:bg-muted hover:text-primary",
                )}
                title="Jump to this timestamp"
              >
                {formatTimecode(segment.timestamp)}
              </button>
              {getAnchorUrl && (
                <button
                  onClick={() => copyAnchor(segmentIndex, segment.timestamp)}
                  className={cn(
                    "rounded p-1 text-muted-foreground transition-[opacity,color,background-color] hover:bg-muted hover:text-primary",
                    // Hidden until the segment is hovered or the button is
                    // focused — but only where hover exists; touch devices
                    // show it always (muted) since there is nothing to hover.
                    copiedSegment !== segmentIndex &&
                      "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100",
                  )}
                  aria-label={t("copyLink")}
                  title={t("copyLink")}
                >
                  {copiedSegment === segmentIndex ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <LinkIcon className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
            </div>
            <div
              className={cn(
                "rounded-lg border p-3 transition-colors duration-200",
                isSegmentActive
                  ? "border-primary/40 bg-primary/5"
                  : "border-transparent bg-muted/40",
                segmentIndex === flashSegmentIndex && "anchor-flash",
              )}
            >
              <div className={cn(typography.body, "space-y-2")}>
                {segment.statementIndices.map((stmtIdx, indexInSegment) => {
                  const stmt = statements?.[stmtIdx];
                  if (!stmt) return null;

                  const isStmtActive = stmtIdx === activeStatementIndex;

                  return (
                    <div key={indexInSegment} className="space-y-3">
                      {stmt.paragraphs.map((para, paraIdx) => {
                        const isParaActive =
                          isStmtActive && paraIdx === activeParagraphIndex;

                        if (topicCollapsed && selectedTopic) {
                          const hasHighlight = para.sentences.some((sent) =>
                            sent.topic_keys?.includes(selectedTopic),
                          );
                          if (!hasHighlight) return null;
                        }

                        return (
                          <p
                            key={paraIdx}
                            dir="auto"
                            className="scroll-mt-[20vh] text-start"
                            data-paragraph-key={`${stmtIdx}-${paraIdx}`}
                          >
                            {para.sentences.map((sent, sentIdx) => {
                              const isSentActive =
                                isParaActive && sentIdx === activeSentenceIndex;
                              const isTopicHit = (
                                s: (typeof para.sentences)[number],
                              ) =>
                                Boolean(
                                  selectedTopic &&
                                  s.topic_keys?.includes(selectedTopic),
                                );
                              const isHighlighted = isTopicHit(sent);

                              if (
                                topicCollapsed &&
                                selectedTopic &&
                                !isHighlighted
                              ) {
                                return null;
                              }

                              // Merge consecutive highlights into one run:
                              // only round/pad the outer edges so neighbouring
                              // highlighted sentences read as a single block.
                              const prevHighlighted =
                                sentIdx > 0 &&
                                isTopicHit(para.sentences[sentIdx - 1]);
                              const nextHighlighted =
                                sentIdx < para.sentences.length - 1 &&
                                isTopicHit(para.sentences[sentIdx + 1]);
                              const pillClass = [
                                "py-1",
                                prevHighlighted ? "" : "rounded-l-full pl-2",
                                nextHighlighted ? "" : "rounded-r-full pr-2",
                              ]
                                .filter(Boolean)
                                .join(" ");

                              // Source the visible text from sent.text and
                              // attach click/karaoke handlers to the spans
                              // that match a word. Whitespace and punctuation
                              // between words (or trailing punctuation like
                              // Chinese "。") render inline as non-interactive
                              // spans. Inserting trailing spaces between words
                              // would be wrong for CJK — use whatever is in
                              // sent.text instead.
                              const parts = weaveSentenceParts(
                                sent.text,
                                sent.words,
                              );
                              const wholeIsClickable = !parts.some(
                                (p) => p.word,
                              );
                              const inner = parts.map((part, partIdx) => {
                                if (part.word) {
                                  const isActiveWord =
                                    isSentActive &&
                                    part.wordIdx === activeWordIndex;
                                  return (
                                    <span
                                      key={partIdx}
                                      onClick={() =>
                                        onSeek(part.word!.start / 1000)
                                      }
                                      className="cursor-pointer hover:opacity-70"
                                      style={{
                                        textDecorationLine: isActiveWord
                                          ? "underline"
                                          : "none",
                                        textDecorationColor: isActiveWord
                                          ? "hsl(var(--primary))"
                                          : "transparent",
                                        textDecorationThickness: "2px",
                                        textUnderlineOffset: "3px",
                                      }}
                                    >
                                      {part.text}
                                    </span>
                                  );
                                }
                                return <span key={partIdx}>{part.text}</span>;
                              });

                              return (
                                <span
                                  key={sentIdx}
                                  {...(wholeIsClickable
                                    ? {
                                        onClick: () =>
                                          onSeek(sent.start / 1000),
                                      }
                                    : {})}
                                  className={`${
                                    wholeIsClickable
                                      ? "cursor-pointer hover:opacity-70"
                                      : ""
                                  }${isHighlighted ? pillClass : ""}`}
                                  style={{
                                    ...(isHighlighted && highlightColor
                                      ? {
                                          backgroundColor:
                                            highlightColor + "30",
                                          display: "inline",
                                        }
                                      : {}),
                                    // No per-word timestamps from the provider
                                    // (Azure gpt-4o-transcribe-diarize emits
                                    // segments per utterance; Gemini emits
                                    // segments per sentence/clause). The
                                    // segment IS the smallest honest timed
                                    // unit, so underline the whole active
                                    // sentence as the karaoke cue.
                                    ...(wholeIsClickable
                                      ? {
                                          textDecorationLine: isSentActive
                                            ? "underline"
                                            : "none",
                                          textDecorationColor: isSentActive
                                            ? "hsl(var(--primary))"
                                            : "transparent",
                                          textDecorationThickness: "2px",
                                          textUnderlineOffset: "3px",
                                        }
                                      : {}),
                                  }}
                                >
                                  {inner}{" "}
                                </span>
                              );
                            })}
                          </p>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
