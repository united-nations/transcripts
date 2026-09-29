"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown } from "lucide-react";
import type { DisplaySpeakerMapping as SpeakerMapping } from "@/lib/public-speakers";
import type { Proposition } from "@/lib/pipeline";
import { formatTimecodeMs } from "@/lib/transcript-formatting";
import { typography } from "@/lib/typography";
import { cn } from "@/lib/utils";

const STANCE_COLORS: Record<
  string,
  { bg: string; text: string; border: string }
> = {
  support: {
    bg: "bg-green-50",
    text: "text-green-700",
    border: "border-green-200",
  },
  oppose: { bg: "bg-red-50", text: "text-red-700", border: "border-red-200" },
  conditional: {
    bg: "bg-amber-50",
    text: "text-amber-700",
    border: "border-amber-200",
  },
  neutral: {
    bg: "bg-gray-50",
    text: "text-gray-600",
    border: "border-gray-200",
  },
};

type StanceKey = "support" | "oppose" | "conditional" | "neutral";

interface Statement {
  paragraphs: Array<{
    sentences: Array<{
      text: string;
      start: number;
      end: number;
      topic_keys?: string[];
      words?: Array<{
        text: string;
        start: number;
        end: number;
        speaker?: string | null;
      }>;
    }>;
    start: number;
    end: number;
    // Optional at every level — see transcription-panel.tsx; first paint
    // runs without words and the array fills in once /words returns.
    words?: Array<{
      text: string;
      start: number;
      end: number;
      speaker?: string | null;
    }>;
  }>;
  start: number;
  end: number;
  words?: Array<{
    text: string;
    start: number;
    end: number;
    speaker?: string | null;
  }>;
}

export interface AnalysisViewProps {
  propositions: Proposition[];
  statements: Statement[] | null;
  speakerMappings: SpeakerMapping;
  countryNames: Map<string, string>;
  onJumpToTimestamp: (ms: number) => void;
}

export function AnalysisView({
  propositions,
  statements,
  speakerMappings,
  countryNames,
  onJumpToTimestamp,
}: AnalysisViewProps) {
  const [expandedProps, setExpandedProps] = useState<Set<string>>(new Set());
  const [expandedPositions, setExpandedPositions] = useState<Set<string>>(
    new Set(),
  );
  const t = useTranslations("analysis");
  const tStance = useTranslations("analysis.stance");
  const tSpeaker = useTranslations("transcript.view");

  const toggleProp = (key: string) => {
    setExpandedProps((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const togglePosition = (key: string) => {
    setExpandedPositions((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const getStatementData = (
    statementIndex: number,
  ): { text: string; start: number; statementIndex: number } | null => {
    if (!statements || statementIndex >= statements.length) return null;
    const stmt = statements[statementIndex];
    const text = stmt.paragraphs
      .flatMap((p) => p.sentences.map((s) => s.text))
      .join(" ");
    return { text, start: stmt.start, statementIndex };
  };

  const renderSpeakerInfo = (statementIndex: number) => {
    const info = speakerMappings[statementIndex.toString()];
    if (
      !info ||
      (!info.affiliation && !info.group && !info.function && !info.name)
    ) {
      return (
        <span className="text-sm font-medium">
          {tSpeaker("speakerN", { n: statementIndex + 1 })}
        </span>
      );
    }
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {info.affiliation && (
          <span className="inline-flex items-center rounded-md bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
            {countryNames.get(info.affiliation) || info.affiliation}
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
        {info.name && (
          <span className="text-sm font-semibold">{info.name}</span>
        )}
      </div>
    );
  };

  return (
    <div className="mt-2 space-y-4">
      {propositions.map((prop) => {
        const isExpanded = expandedProps.has(prop.key);

        return (
          <div key={prop.key} className="overflow-hidden rounded-lg border">
            <button
              onClick={() => toggleProp(prop.key)}
              className="w-full bg-muted/30 px-4 py-3 text-left transition-colors hover:bg-muted/50"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium">{prop.title}</h3>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {prop.statement}
                  </p>
                </div>
                <ChevronDown
                  className={`mt-1 h-4 w-4 flex-shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {prop.positions.map((pos) => (
                  <span
                    key={pos.stance}
                    className={`rounded-full px-2 py-0.5 text-xs ${STANCE_COLORS[pos.stance].bg} ${STANCE_COLORS[pos.stance].text}`}
                  >
                    {tStance(pos.stance as StanceKey)}:{" "}
                    {pos.stakeholders.length}
                  </span>
                ))}
              </div>
            </button>

            {isExpanded && (
              <div className="divide-y">
                {prop.positions.map((pos) => {
                  const posKey = `${prop.key}-${pos.stance}`;
                  const isPosExpanded = expandedPositions.has(posKey);
                  const colors = STANCE_COLORS[pos.stance];

                  return (
                    <div key={pos.stance} className={`${colors.bg}`}>
                      <div className="px-4 py-3">
                        <div className="mb-1 flex items-center gap-2">
                          <span
                            className={cn(
                              typography.label,
                              "uppercase",
                              colors.text,
                            )}
                          >
                            {tStance(pos.stance as StanceKey)}
                          </span>
                        </div>
                        <div className="mb-1 text-sm font-medium">
                          {pos.stakeholders
                            .map((s) => countryNames.get(s) || s)
                            .join(", ")}
                        </div>
                        <p className={typography.meta}>{pos.summary}</p>

                        {pos.evidence && pos.evidence.length > 0 && (
                          <button
                            onClick={() => togglePosition(posKey)}
                            className="mt-2 text-xs text-primary hover:underline"
                          >
                            {isPosExpanded
                              ? t("hideQuotes")
                              : t("viewQuotes", {
                                  count: pos.evidence.length,
                                })}
                          </button>
                        )}

                        {isPosExpanded && pos.evidence && (
                          <div className="mt-3 space-y-3">
                            {pos.evidence.map((ev, idx) => {
                              const stmtData = getStatementData(
                                ev.statementIndex,
                              );
                              if (!stmtData) return null;

                              return (
                                <div key={idx} className="space-y-1.5">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <div className="text-sm font-semibold">
                                      {renderSpeakerInfo(ev.statementIndex)}
                                    </div>
                                    <button
                                      onClick={() =>
                                        onJumpToTimestamp(stmtData.start)
                                      }
                                      className="cursor-pointer text-xs text-muted-foreground transition-colors hover:text-primary hover:underline"
                                      title="Jump to this timestamp"
                                    >
                                      [{formatTimecodeMs(stmtData.start)}]
                                    </button>
                                  </div>
                                  <div
                                    className="cursor-pointer rounded-lg border border-border/50 bg-background/50 p-3 transition-colors hover:bg-background/80"
                                    onClick={() =>
                                      onJumpToTimestamp(stmtData.start)
                                    }
                                    title={t("clickToJump")}
                                  >
                                    <p
                                      dir="auto"
                                      className={cn(
                                        typography.body,
                                        "text-start text-foreground italic",
                                      )}
                                    >
                                      &ldquo;{ev.quote}&rdquo;
                                    </p>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
