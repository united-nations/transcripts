"use client";

import { formatTimestamp, serializeMeetingParams } from "@/lib/timestamp-url";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { setUrlParam } from "@/lib/url-params";
import type { SpeakerMapping } from "@/lib/speakers";
import type { Video } from "@/lib/un-api";
import { getCountryName } from "@/lib/country-lookup";
import { useScrollToActive } from "@/lib/hooks/use-scroll-to-active";
import { BarChart3 } from "lucide-react";
import { PVPanel, type PVSpeakerEntry } from "@/components/pv-panel";
import { useMeetingState } from "@/components/meeting-state/meeting-state";
import { TranscriptSkeleton } from "@/components/transcript-skeleton";
import ExcelJS from "exceljs";
import type { Proposition } from "@/lib/pipeline";
import { StageProgress, type Stage } from "@/components/stage-progress";
import { AnalysisView } from "@/components/analysis-view";
import { usePlaybackTracking } from "@/lib/hooks/use-playback-tracking";
import { useMeetingFormat } from "@/lib/hooks/use-meeting-format";
import {
  formatTimecode,
  formatSpeakerText,
  formatTranscriptAsPlainText,
  buildSpeakerSegments,
} from "@/lib/transcript-formatting";
import {
  buildExportHeaderRtf,
  buildExportHeaderText,
  buildExportHeaderVtt,
  buildExportMetaFields,
  escapeRtf,
  type ExportMetaInput,
} from "@/lib/transcript-export";
import { useCategoryName } from "@/lib/hooks/use-category-name";
import { useLanguageDisplayName } from "@/lib/hooks/use-language-display-name";
import { localeComma } from "@/lib/timezone";
import {
  TranscriptToolbar,
  type ViewMode,
} from "@/components/transcript-toolbar";
import { TranscriptView } from "@/components/transcript-view";
import { RawTranscriptView } from "@/components/raw-transcript-view";
import { FlaggedTranscriptBanner } from "@/components/flagged-transcript-banner";
import type { TranscriptPayload } from "@/lib/transcript-payload";
import { Link } from "@/i18n/navigation";
import { typography } from "@/lib/typography";
import { cn } from "@/lib/utils";

export interface LanguageOption {
  code: string;
  name: string;
  available: boolean;
  transcriptStatus: string | null;
}

interface RawParagraph {
  text: string;
  start: number;
  end: number;
  words: Array<{ text: string; start: number; end: number; speaker?: string }>;
}

// Official UN accent palette ("True Values" from un_brand_colour_palette.pdf).
// Used here per the guide: accents are intended for "instances when large
// amounts of information need to be differentiated by colour, such as in
// charts, graphs or maps." Assignment is by index (no semantic mapping).
export const TOPIC_COLOR_PALETTE = [
  "#009EDB", // UN Blue
  "#72BF44", // Green
  "#FFC800", // Yellow
  "#F58220", // Orange
  "#ED1847", // Red
  "#A05FB4", // Purple
  "#AEA29A", // Gray
];

export function getTopicColor(
  _topicKey: string,
  _allTopicKeys: string[],
): string {
  return TOPIC_COLOR_PALETTE[0];
}

export interface TranscriptionPanelData {
  segments: SpeakerSegment[] | null;
  statements: Statement[] | null;
  speakerMappings: SpeakerMapping;
  countryNames: Map<string, string>;
  topics: Record<string, { key: string; label: string; description: string }>;
  activeSegmentIndex: number;
  hasPropositions: boolean;
  stage: Stage;
  checking: boolean;
  hasSegments: boolean;
  hasRawParagraphs: boolean;
  pvSpeakers?: PVSpeakerEntry[] | null;
  pvActiveTurnIndex?: number;
  viewMode?: string;
}

interface TranscriptionPanelProps {
  kalturaId: string;
  video: Video;
  isLoggedIn: boolean;
  experimentalAccess: boolean;
  pvSymbol?: string;
  /**
   * Pre-loaded transcript data the meeting page can pass when it was already
   * fetched server-side (the same TranscriptPayload shape /api/transcripts/check
   * returns — built by the shared lib/transcript-payload builder). When this is
   * supplied, the panel skips its first /check round-trip on mount; the
   * transcript is in the initial HTML payload (visible to no-JS crawlers) and
   * the first paint happens at hydration instead of after a network call.
   *
   * Word-level timing is intentionally absent — the panel fetches it lazily
   * from /api/transcripts/[id]/words, same as the /check fast path.
   */
  initialTranscript?: TranscriptPayload | null;
}

/**
 * Transcript-row metadata the panel must learn on BOTH delivery paths (SSR
 * pre-load and /check fetch): the realignment-flagged state and its
 * durations, the analysis-axis status, and any in-flight fresh transcription
 * replacing a flagged row. Kept as ONE state atom seeded by metaFromPayload()
 * at both entry points, so a field added to TranscriptPayload cannot reach
 * the fetch path and silently miss the server-rendered one (which is exactly
 * how the flagged banner and the "Analyzing…" state were lost on SSR'd pages).
 */
interface TranscriptMeta {
  analysisStatus: TranscriptPayload["analysisStatus"];
  flagged: boolean;
  sourceDurationMs: number | null;
  alignedDurationMs: number | null;
  pendingRetranscribeId: string | null;
  pendingRetranscribeStage: Stage | null;
}

const EMPTY_META: TranscriptMeta = {
  analysisStatus: "none",
  flagged: false,
  sourceDurationMs: null,
  alignedDurationMs: null,
  pendingRetranscribeId: null,
  pendingRetranscribeStage: null,
};

function metaFromPayload(p: TranscriptPayload): TranscriptMeta {
  return {
    analysisStatus: p.analysisStatus,
    flagged: p.flagged,
    sourceDurationMs: p.sourceDurationMs,
    alignedDurationMs: p.alignedDurationMs,
    pendingRetranscribeId: p.pendingRetranscribeId,
    pendingRetranscribeStage: p.pendingRetranscribeId
      ? ((p.pendingRetranscribeStage ?? "transcribing") as Stage)
      : null,
  };
}

interface Word {
  text: string;
  speaker?: string | null;
  start: number;
  end: number;
}

interface SpeakerSegment {
  speaker: string;
  statementIndices: number[];
  timestamp: number;
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
    // Words are optional at every level: the /api/transcripts/check fast
    // path and the SSR pre-load both strip them for speed, and the panel
    // re-merges them in once /api/transcripts/[id]/words returns.
    words?: Word[];
  }>;
  start: number;
  end: number;
  words?: Word[];
}

export function TranscriptionPanel({
  kalturaId,
  video,
  isLoggedIn,
  experimentalAccess,
  pvSymbol,
  initialTranscript,
}: TranscriptionPanelProps) {
  // Chrome-side state (player, language switcher, topic filter, sidebar
  // data) lives in MeetingStateContext so we can stay in sync with
  // VideoPageClient now that the panel is its sibling, not its child.
  const {
    player,
    selectedLanguage,
    selectLanguage: onLanguageChange,
    availableLanguages,
    refreshLanguages: onLanguagesRefresh,
    selectedTopic,
    setSelectedTopic: onTopicSelect,
    topicCollapsed,
    setTopicCollapsed: onTopicCollapsedChange,
    setPanelData: onDataChange,
    initialSeekSeconds,
  } = useMeetingState();
  // Server-fetched data is only "initial" when it matches the URL locale.
  // After a language switch the panel falls back to the /check fast path,
  // and the initial value is no longer relevant.
  const hasMatchingInitial =
    !!initialTranscript && initialTranscript.language === selectedLanguage;

  const [stage, setStage] = useState<Stage>(
    hasMatchingInitial ? "completed" : "idle",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(!hasMatchingInitial);
  const [speakerMappings, setSpeakerMappings] = useState<SpeakerMapping>(
    hasMatchingInitial ? initialTranscript!.speakerMappings : {},
  );
  const [topics, setTopics] = useState<
    Record<string, { key: string; label: string; description: string }>
  >(hasMatchingInitial ? initialTranscript!.topics : {});
  const [statements, setStatements] = useState<Statement[] | null>(
    hasMatchingInitial ? initialTranscript!.statements : null,
  );
  const [rawParagraphs, setRawParagraphs] = useState<RawParagraph[] | null>(
    null,
  );
  const [transcriptId, setTranscriptId] = useState<string | null>(
    hasMatchingInitial ? initialTranscript!.transcriptId : null,
  );
  const [pvSpeakers, setPvSpeakers] = useState<PVSpeakerEntry[] | null>(null);
  const [pvActiveTurnIndex, setPvActiveTurnIndex] = useState<number>(-1);
  const [propositions, setPropositions] = useState<Proposition[]>(
    hasMatchingInitial ? initialTranscript!.propositions : [],
  );
  // Deep-linkable view: `?view=pv` / `?view=analysis` (transcript is the
  // default and carries no param). Gate the initial read against what actually
  // exists for this viewer — a `pv` link needs a PV symbol, an `analysis` link
  // needs experimental access (the analysis tab isn't rendered otherwise) — so a
  // stale/forged param falls back to the transcript rather than an empty tab.
  const searchParams = useSearchParams();
  const [requestedViewMode, setViewMode] = useState<ViewMode>(() => {
    const v = searchParams.get("view");
    if (v === "pv" && pvSymbol) return "pv";
    if (v === "analysis" && experimentalAccess) return "analysis";
    return "transcript";
  });
  const viewMode =
    requestedViewMode === "analysis" && !experimentalAccess
      ? "transcript"
      : requestedViewMode;
  // Wrap the setter so a tab switch reflects into `?view=`, dropping the param
  // for the transcript default. Pure client state — replaceState only, no
  // navigation (see lib/url-params.ts).
  const changeViewMode = useCallback(
    (mode: ViewMode) => {
      if (mode === "analysis" && !experimentalAccess) return;
      setViewMode(mode);
      setUrlParam("view", mode === "transcript" ? undefined : mode);
    },
    [experimentalAccess],
  );
  // One atom for the transcript-row metadata (see TranscriptMeta) — seeded
  // here for the SSR path and via metaFromPayload(data) in checkCache for the
  // fetch path; the shared function is what keeps the two paths identical.
  // Post-mount transitions (run analysis, retranscribe lifecycle) update it
  // functionally. The old completed content stays visible while a pending
  // retranscribe runs; only the banner reflects its progress.
  const [meta, setMeta] = useState<TranscriptMeta | null>(
    hasMatchingInitial ? metaFromPayload(initialTranscript!) : null,
  );
  const analyzingPropositions = meta?.analysisStatus === "analyzing";
  const flagged = meta?.flagged ?? false;
  const sourceDurationMs = meta?.sourceDurationMs ?? null;
  const alignedDurationMs = meta?.alignedDurationMs ?? null;
  const pendingRetranscribeId = meta?.pendingRetranscribeId ?? null;
  const pendingRetranscribeStage = meta?.pendingRetranscribeStage ?? null;
  const [retranscribeStarting, setRetranscribeStarting] = useState(false);
  const [retranscribeError, setRetranscribeError] = useState<string | null>(
    null,
  );
  const t = useTranslations("transcript.panel");
  const tExport = useTranslations("transcript.export");
  const locale = useLocale();
  const languageDisplayName = useLanguageDisplayName();
  const categoryName = useCategoryName();
  // Covers the POST round-trip (click → response) so the Generate button can
  // show instant feedback before the server resolves Kaltura and starts polling.
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  // Cancels any in-flight cache check + polling when the language tab changes,
  // the kalturaId switches, or the component unmounts. Without this, a poll
  // loop started for `zh` keeps writing `setStage` / `setRawParagraphs` /
  // `setStatements` into the freshly-reset panel after the user switches to
  // `en`, so the new tab inherits the previous language's progress + preview.
  const pollAbortRef = useRef<AbortController | null>(null);

  // Derived from statements + speakerMappings. Computed during render so
  // it's part of the SSR output — without this, segments stays null until
  // hydration, the panel renders empty markup server-side, and the user
  // sees the skeleton swap to a near-blank panel for a frame before the
  // transcript appears. Cheap enough to recompute (a single pass over
  // statements grouping by speaker identity).
  const segments = useMemo<SpeakerSegment[] | null>(() => {
    if (!statements || Object.keys(speakerMappings).length === 0) return null;
    return buildSpeakerSegments(
      statements,
      speakerMappings,
    ) as SpeakerSegment[];
  }, [statements, speakerMappings]);

  const {
    activeSegmentIndex,
    activeStatementIndex,
    activeParagraphIndex,
    activeSentenceIndex,
    activeWordIndex,
    currentTimeRef,
  } = usePlaybackTracking(player, segments, statements);

  // Arriving via a `?t=` deeplink: pulse the segment the link points at, once,
  // so the recipient sees unambiguously which statement they were sent — the
  // persistent active style alone doesn't distinguish "you are here because of
  // the link" from ordinary playback. The seek itself happens in meeting-state
  // when the player is ready; scrolling comes from useScrollToActive below.
  const [flashSegmentIndex, setFlashSegmentIndex] = useState<number | null>(
    null,
  );
  const flashDone = useRef(false);
  useEffect(() => {
    if (flashDone.current || initialSeekSeconds === null || !segments) return;
    let idx = -1;
    for (let i = segments.length - 1; i >= 0; i--) {
      if (initialSeekSeconds >= segments[i].timestamp) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return;
    flashDone.current = true;
    setFlashSegmentIndex(idx);
    const timer = setTimeout(() => setFlashSegmentIndex(null), 2600);
    return () => clearTimeout(timer);
  }, [initialSeekSeconds, segments]);

  const handlePvSpeakersChange = useCallback(
    (speakers: PVSpeakerEntry[], activeIdx: number) => {
      setPvSpeakers(speakers);
      setPvActiveTurnIndex(activeIdx);
    },
    [],
  );

  const isLoading =
    stage !== "idle" &&
    stage !== "scheduled" &&
    stage !== "completed" &&
    stage !== "no_content" &&
    stage !== "error";

  const formatTime = formatTimecode;
  const { meetingIsoDay, formatMeetingDate, formatMeetingTime } =
    useMeetingFormat();

  // Derived from speakerMappings + active UI locale. Computed during
  // render so it's in the SSR output. getCountryName is a pure lookup
  // against the vendored ISO snapshot (lib/country-lookup), no I/O.
  // Declared before its first use (getSpeakerText, below) so the React
  // Compiler can preserve this manual memoization — a useMemo referenced
  // before its source-order declaration triggers a compile bailout.
  const countryNames = useMemo<Map<string, string>>(() => {
    const names = new Map<string, string>();
    const iso3Codes = new Set<string>();
    Object.values(speakerMappings).forEach((info) => {
      if (info.affiliation && info.affiliation.length === 3)
        iso3Codes.add(info.affiliation);
    });
    for (const code of iso3Codes) {
      const name = getCountryName(code, locale);
      if (name) names.set(code, name);
    }
    return names;
  }, [speakerMappings, locale]);

  const getSpeakerText = (statementIndex: number | undefined): string =>
    formatSpeakerText(statementIndex, speakerMappings, countryNames);

  // Build a download filename whose date prefix matches what the page header
  // shows: derived from `scheduledTime` (a full UTC-ish ISO) interpreted in
  // the user's selected timezone, falling back to the WebTV schedule date
  // string when a meeting has no scheduled time. The slug keeps Unicode
  // letters/digits (so French/Arabic/Chinese titles survive) and collapses
  // every other run into a single underscore. Adds HH-MM when known, and
  // tags the active language track so en/fr/etc. don't collide.
  const baseFileName = () => {
    const dateSource = video.scheduledTime ?? video.date;
    const datePart = meetingIsoDay(dateSource);
    const timePart = video.scheduledTime
      ? `_${formatMeetingTime(video.scheduledTime).replace(":", "-")}`
      : "";
    const titlePart = video.cleanTitle
      .slice(0, 50)
      .replace(/[^\p{L}\p{N}]+/gu, "_")
      .replace(/^_+|_+$/g, "");
    return `${datePart}${timePart}_${titlePart}_${selectedLanguage}`;
  };

  const seekToTimestamp = (timestamp: number) => {
    if (!player) return;
    try {
      player.currentTime = timestamp;
      player.play();
    } catch (err) {
      console.error("Failed to seek:", err);
    }
  };

  // Shareable anchor for one statement: canonical URL (locale + slug, same
  // rationale as exportUrls — the address bar can disagree with the rendered
  // track) plus `?t=` and, when off the locale default, `?lang=`. Composed
  // here and written straight to the clipboard by TranscriptView; `t` is
  // never reflected into the address bar.
  const anchorUrl = (seconds: number) => {
    const params = new URLSearchParams();
    if (selectedLanguage !== locale) params.set("lang", selectedLanguage);
    // CEIL, not floor: segment starts are fractional seconds, and the
    // arrival highlight picks the statement CONTAINING t — flooring lands a
    // fraction before the start and lights up the previous statement.
    params.set("t", formatTimestamp(seconds));
    if (selectedTopic) {
      params.set("topic", selectedTopic);
      if (!topicCollapsed) params.set("topicMode", "all");
    }
    return `${window.location.origin}/${locale}/${video.slug}?${serializeMeetingParams(params)}`;
  };

  // Lazy word-level timestamps. The /api/transcripts/check fast path strips
  // words[] from its response (63% of payload) so first paint is fast; this
  // pulls them in once the transcript is on screen and merges by index so
  // sentence-level karaoke highlight + click-to-seek light up after a beat.
  // The polling paths (pollForCompletion / the retranscribe polling effect)
  // still receive full word data, so we only fire this after the /check fast
  // path.
  const loadWords = useCallback(async (tid: string, signal: AbortSignal) => {
    try {
      const res = await fetch(
        `/api/transcripts/${encodeURIComponent(tid)}/words`,
        { signal },
      );
      if (signal.aborted) return;
      if (!res.ok) return;
      const { statements: wordsByStatement } = (await res.json()) as {
        statements: Array<{
          words?: Word[];
          paragraphs: Array<{
            words?: Word[];
            sentences: Array<{ words?: Word[] }>;
          }>;
        }>;
      };
      if (signal.aborted || !wordsByStatement) return;
      setStatements((prev) => {
        if (!prev) return prev;
        return prev.map((stmt, si) => {
          const wstmt = wordsByStatement[si];
          if (!wstmt) return stmt;
          return {
            ...stmt,
            ...(wstmt.words ? { words: wstmt.words } : {}),
            paragraphs: stmt.paragraphs.map((para, pi) => {
              const wpara = wstmt.paragraphs[pi];
              if (!wpara) return para;
              return {
                ...para,
                ...(wpara.words ? { words: wpara.words } : {}),
                sentences: para.sentences.map((sent, sei) => {
                  const wsent = wpara.sentences[sei];
                  if (!wsent?.words) return sent;
                  return { ...sent, words: wsent.words };
                }),
              };
            }),
          };
        });
      });
    } catch {
      // Network error or aborted; the panel keeps working with
      // sentence-level seeks only.
    }
  }, []);

  useEffect(() => {
    onDataChange?.({
      segments,
      statements,
      speakerMappings,
      countryNames,
      topics,
      activeSegmentIndex,
      hasPropositions: propositions.length > 0,
      stage,
      checking,
      hasSegments: !!segments,
      hasRawParagraphs: !!rawParagraphs,
      pvSpeakers,
      pvActiveTurnIndex,
      viewMode,
    });
  }, [
    segments,
    speakerMappings,
    countryNames,
    topics,
    activeSegmentIndex,
    propositions,
    stage,
    checking,
    rawParagraphs,
    onDataChange,
    pvSpeakers,
    pvActiveTurnIndex,
    viewMode,
  ]);

  const handleTranscribe = async () => {
    // Guard against a double-click firing a second POST while one is in flight.
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setStage("transcribing");
    setErrorMessage(null);
    try {
      const response = await fetch("/api/transcripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kalturaId, language: selectedLanguage }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error?.message || errorData.error || "Transcription failed",
        );
      }
      const data = await response.json();
      // POST resolved — hand off to the stage list / polling. Clear before the
      // awaited pollForCompletion below (a finally would keep it set for the
      // entire transcription).
      startingRef.current = false;
      setStarting(false);
      setTranscriptId(data.transcriptId);
      if (data.statements && data.statements.length > 0) {
        setStatements(data.statements);
        if (data.topics) setTopics(data.topics);
        if (data.propositions) setPropositions(data.propositions);
        if (data.speakerMappings) setSpeakerMappings(data.speakerMappings);
        setStage("completed");
        onLanguagesRefresh?.();
        return;
      }
      if (data.stage) setStage(data.stage);
      if (data.raw_paragraphs) setRawParagraphs(data.raw_paragraphs);
      if (data.transcriptId) {
        // Bind to the active language's controller so a tab switch aborts the
        // long-running poll instead of leaking state into the new language.
        const signal =
          pollAbortRef.current?.signal ?? new AbortController().signal;
        await pollForCompletion(data.transcriptId, signal);
      }
    } catch (err) {
      startingRef.current = false;
      setStarting(false);
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to transcribe",
      );
      setStage("error");
    }
  };

  const handleSchedule = async () => {
    try {
      const response = await fetch("/api/transcripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kalturaId,
          assetId: video.id,
          schedule: true,
          language: selectedLanguage,
        }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error?.message ||
            errorData.error ||
            "Failed to schedule transcript",
        );
      }
      setStage("scheduled");
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to schedule transcript",
      );
      setStage("error");
    }
  };

  const pollForCompletion = async (tid: string, signal: AbortSignal) => {
    // Job lifetime belongs to the server; elapsed browser time is not failure.

    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (signal.aborted) return;

      let pollResponse: Response;
      try {
        pollResponse = await fetch(
          `/api/transcripts/${encodeURIComponent(tid)}`,
          { signal },
        );
      } catch (err) {
        if (signal.aborted) return;
        throw err;
      }
      if (!pollResponse.ok) throw new Error("Failed to poll transcript status");

      const data = await pollResponse.json();
      // Re-check after every await: language could have changed while the
      // response was in flight, in which case nothing on this row applies to
      // the now-visible panel.
      if (signal.aborted) return;
      if (data.stage) setStage(data.stage);
      if (data.raw_paragraphs && !rawParagraphs)
        setRawParagraphs(data.raw_paragraphs);

      if (data.statements?.length > 0) {
        setStatements(data.statements);
        if (
          data.speakerMappings &&
          Object.keys(data.speakerMappings).length > 0
        ) {
          setSpeakerMappings(data.speakerMappings);
        }
      }

      if (data.topics && Object.keys(data.topics).length > 0)
        setTopics(data.topics);
      if (data.propositions && data.propositions.length > 0)
        setPropositions(data.propositions);

      if (data.stage === "completed") break;
      // Terminal: the pipeline assessed the recording as having no
      // transcribable content. setStage above already switched the UI to the
      // dedicated state; just stop polling.
      if (data.stage === "no_content") break;
      if (data.stage === "error")
        throw new Error(data.error_message || "Pipeline failed");
    }
  };

  // Poll a pending fresh retranscription (of a realignment-flagged row) until
  // it completes, then swap the displayed transcript in and clear the flagged
  // banner. Errors surface as `retranscribeError` without touching the
  // existing transcript display.
  //
  // Polling is a consequence of the PENDING STATE, not of the action that
  // created it: whoever records meta.pendingRetranscribeId — the retranscribe
  // click, the /check response, or the SSR initializer — gets exactly one
  // polling loop, owned by this effect and cancelled when the pending id
  // clears, the language switches (meta reset), or the panel unmounts. An
  // earlier version threaded an imperative loop from each of those call sites
  // with a borrowed AbortController; a single transient fetch failure (laptop
  // sleep, dev-server recompile, offline blip) escaped its catch, was
  // swallowed by the caller, and left the banner on "in progress" forever.
  // Hence the rules here: network-level failures RETRY (the pipeline runs
  // server-side and is unaffected), only explicit outcomes — completed, error
  // stage, HTTP error — end the wait, and a visibilitychange nudge
  // re-syncs immediately when the user returns to a timer-throttled
  // background tab.
  const retranscribePendingId = meta?.pendingRetranscribeId ?? null;
  useEffect(() => {
    if (!retranscribePendingId) return;
    const tid = retranscribePendingId;
    const ctrl = new AbortController();
    const signal = ctrl.signal;
    const POLL_MS = 3000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;

    const clearPending = () =>
      setMeta((m) => ({
        ...(m ?? EMPTY_META),
        pendingRetranscribeId: null,
        pendingRetranscribeStage: null,
      }));

    const tick = async () => {
      if (inFlight || signal.aborted) return;
      inFlight = true;
      try {
        let res: Response;
        try {
          res = await fetch(`/api/transcripts/${encodeURIComponent(tid)}`, {
            signal,
          });
        } catch {
          // Network-level failure — transient by assumption; keep polling.
          return;
        }
        if (signal.aborted) return;
        if (!res.ok) {
          setRetranscribeError("Failed to poll fresh transcription");
          clearPending();
          return;
        }
        const data = await res.json();
        if (signal.aborted) return;
        if (data.stage === "error") {
          setRetranscribeError(
            data.error_message || "Fresh transcription failed",
          );
          clearPending();
          return;
        }
        if (data.stage === "completed" && data.statements?.length > 0) {
          // Swap the displayed transcript to the freshly produced one and
          // clear the flagged banner. (The new row was made from the current
          // audio so its source_duration_ms matches; the cron won't re-flag
          // it.)
          setStatements(data.statements);
          if (data.topics) setTopics(data.topics);
          if (data.propositions) setPropositions(data.propositions);
          if (data.speakerMappings) setSpeakerMappings(data.speakerMappings);
          setTranscriptId(tid);
          setRetranscribeError(null);
          setMeta((m) => ({
            ...(m ?? EMPTY_META),
            flagged: false,
            sourceDurationMs: null,
            alignedDurationMs: null,
            pendingRetranscribeId: null,
            pendingRetranscribeStage: null,
          }));
          return;
        }
        if (data.stage && data.stage !== "completed") {
          setMeta((m) => ({
            ...(m ?? EMPTY_META),
            pendingRetranscribeStage: data.stage,
          }));
        }
      } finally {
        inFlight = false;
      }
    };

    const schedule = () => {
      if (signal.aborted) return;
      timer = setTimeout(async () => {
        await tick();
        schedule();
      }, POLL_MS);
    };
    schedule();

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      ctrl.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // setX functions are stable; the polling lifecycle is keyed on the
    // pending id alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retranscribePendingId]);

  const handleRetranscribe = async () => {
    if (retranscribeStarting || pendingRetranscribeId) return;
    setRetranscribeStarting(true);
    setRetranscribeError(null);
    try {
      const res = await fetch("/api/transcripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kalturaId,
          language: selectedLanguage,
          retranscribe: true,
        }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(
          errorData.error?.message ||
            errorData.error ||
            "Failed to start fresh transcription",
        );
      }
      const data = await res.json();
      if (data.transcriptId) {
        // Recording the pending id is all that's needed — the polling effect
        // keyed on meta.pendingRetranscribeId takes it from here.
        setMeta((m) => ({
          ...(m ?? EMPTY_META),
          pendingRetranscribeId: data.transcriptId,
          pendingRetranscribeStage: data.stage || "transcribing",
        }));
      }
    } catch (err) {
      setRetranscribeError(
        err instanceof Error
          ? err.message
          : "Failed to start fresh transcription",
      );
    } finally {
      setRetranscribeStarting(false);
    }
  };

  const handleRetry = () => {
    if (transcriptId) {
      setStage("transcribing");
      setErrorMessage(null);
      const signal =
        pollAbortRef.current?.signal ?? new AbortController().signal;
      pollForCompletion(transcriptId, signal).catch((err) => {
        if (signal.aborted) return;
        setErrorMessage(err instanceof Error ? err.message : "Retry failed");
        setStage("error");
      });
    } else {
      handleTranscribe();
    }
  };

  const handleRunAnalysis = async () => {
    if (!experimentalAccess || !transcriptId) return;
    const setAnalysisStatus = (s: TranscriptMeta["analysisStatus"]) =>
      setMeta((m) => ({ ...(m ?? EMPTY_META), analysisStatus: s }));
    setAnalysisStatus("analyzing");
    try {
      const response = await fetch(
        `/api/transcripts/${encodeURIComponent(transcriptId)}/analysis`,
        { method: "POST" },
      );
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error?.message || data.error || "Analysis failed");
      }
      const data = await response.json();
      if (data.propositions) setPropositions(data.propositions);
      setAnalysisStatus("completed");
    } catch (err) {
      console.error("Analysis failed:", err);
      setErrorMessage(err instanceof Error ? err.message : "Analysis failed");
      setAnalysisStatus("error");
    }
  };

  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
    } catch (err) {
      console.error("Failed to copy URL:", err);
    }
  };

  // Canonical URLs for the export header. Built from `locale` + `video.slug`
  // rather than `window.location.href` so an exported file always names the
  // transcript the reader is actually looking at: the language picker falls
  // back to floor / first-available without writing `?lang=` to the URL (see
  // meeting-state.tsx), so the address bar can silently disagree with the
  // rendered transcript. The `?lang=` / `?language=` suffix mirrors the rule in
  // `selectLanguage` \u2014 omitted when the track matches the page locale.
  const exportUrls = () => {
    const origin = window.location.origin;
    const langSuffix = (param: "lang" | "language") =>
      selectedLanguage === locale ? "" : `?${param}=${selectedLanguage}`;
    return {
      transcriptUrl: `${origin}/${locale}/${video.slug}${langSuffix("lang")}`,
      jsonUrl: `${origin}/${locale}/${video.slug}.json${langSuffix("language")}`,
      llmsUrl: `${origin}/llms.txt`,
    };
  };

  // `withAgentLinks` is true only for the clipboard: the JSON and llms.txt
  // pointers exist to help someone hand a meeting to an LLM, which is not what
  // a downloaded .rtf or .xlsx is for.
  const exportMeta = (withAgentLinks = false): ExportMetaInput => {
    const { transcriptUrl, jsonUrl, llmsUrl } = exportUrls();
    // Absolute date only ("15 June 2026") \u2014 an export carries no schedule
    // context, so a weekday or a relative "Today" would be meaningless later,
    // and the year must be present even for a meeting held this year.
    const dateDisplay = formatMeetingDate(video.scheduledTime ?? video.date, {
      weekday: "none",
      relative: "off",
      year: "always",
    });
    const timeDisplay = video.scheduledTime
      ? formatMeetingTime(video.scheduledTime)
      : null;
    return {
      title: video.cleanTitle,
      // The category pill's text, not `video.body` — body has no per-locale
      // variant, so it would print "Security Council" on a French export.
      category: categoryName(video.category),
      date: timeDisplay
        ? `${dateDisplay}${localeComma(locale)}${timeDisplay}`
        : dateDisplay,
      language: languageDisplayName(selectedLanguage),
      transcriptUrl,
      jsonUrl: withAgentLinks ? jsonUrl : null,
      llmsUrl: withAgentLinks ? llmsUrl : null,
      labels: {
        date: tExport("date"),
        language: tExport("language"),
        transcript: tExport("transcript"),
        json: tExport("json"),
        aiAgents: tExport("aiAgents"),
      },
    };
  };

  const downloadDocx = () => {
    if (!segments || !statements) return;
    let rtf = buildExportHeaderRtf(exportMeta(), tExport("disclaimer"));
    segments.forEach((segment) => {
      const firstStmtIndex = segment.statementIndices[0] ?? 0;
      rtf += `{\\b ${escapeRtf(getSpeakerText(firstStmtIndex))}`;
      if (segment.timestamp !== null)
        rtf += ` [${formatTime(segment.timestamp)}]`;
      rtf += ":}\\line\\line\n";
      segment.statementIndices.forEach((stmtIdx) => {
        const stmt = statements[stmtIdx];
        if (stmt) {
          stmt.paragraphs.forEach((para) => {
            const text = para.sentences.map((s) => s.text).join(" ");
            rtf += escapeRtf(text) + "\\line\\line\n";
          });
        }
      });
    });
    rtf += "}";
    const blob = new Blob([rtf], { type: "application/rtf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${baseFileName()}.rtf`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadExcel = async () => {
    if (!segments) return;
    const meta = exportMeta();
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Transcript");
    const topicList = Object.values(topics);
    const baseColumns = [
      { header: "Date", key: "date", width: 12 },
      { header: "Source Type", key: "source_type", width: 12 },
      { header: "Title", key: "title", width: 40 },
      { header: "URL", key: "url", width: 35 },
      { header: "Paragraph Number", key: "paragraph_number", width: 15 },
      { header: "Speaker Affiliation", key: "speaker_affiliation", width: 20 },
      { header: "Speaker Group", key: "speaker_group", width: 20 },
      { header: "Function", key: "function", width: 20 },
      { header: "Text", key: "text", width: 60 },
    ];
    const topicColumns = topicList.map((topic) => ({
      header: `Topic ${topic.label}`,
      key: `topic_${topic.key}`,
      width: 15,
    }));
    worksheet.columns = [...baseColumns, ...topicColumns];
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFD9D9D9" },
    };
    headerRow.alignment = { vertical: "middle", horizontal: "left" };
    worksheet.views = [{ state: "frozen", ySplit: 1 }];

    let paragraphNumber = 1;
    segments.forEach((segment) => {
      segment.statementIndices.forEach((stmtIdx) => {
        const info = speakerMappings[stmtIdx.toString()];
        const stmt = statements?.[stmtIdx];
        if (stmt) {
          stmt.paragraphs.forEach((para) => {
            const text = para.sentences.map((s) => s.text).join(" ");
            const paragraphTopics = new Set<string>();
            para.sentences.forEach((sent) => {
              sent.topic_keys?.forEach((key) => paragraphTopics.add(key));
            });
            const rowData: Record<string, string | number> = {
              date: video.date,
              source_type: "WebTV",
              title: video.cleanTitle,
              url: meta.transcriptUrl,
              paragraph_number: paragraphNumber++,
              speaker_affiliation: info?.affiliation
                ? countryNames.get(info.affiliation) || info.affiliation
                : "",
              speaker_group: info?.group || "",
              function: info?.function || "",
              text,
            };
            topicList.forEach((topic) => {
              rowData[`topic_${topic.key}`] = paragraphTopics.has(topic.key)
                ? "Yes"
                : "";
            });
            const row = worksheet.addRow(rowData);
            row.eachCell((cell) => {
              cell.alignment = {
                vertical: "top",
                horizontal: "left",
                wrapText: true,
              };
            });
          });
        }
      });
    });

    // Keep the metadata off the data sheet (row 1 stays the header for anyone
    // piping the file into pandas etc.) — it gets its own sheet. "Transcript"
    // stays first so `pd.read_excel(path)`, which defaults to sheet 0, still
    // lands on the data.
    const infoSheet = workbook.addWorksheet("Info");
    infoSheet.getColumn(1).width = 16;
    infoSheet.getColumn(2).width = 100;
    infoSheet.getCell("A1").value = meta.title;
    infoSheet.getCell("A1").font = { bold: true, size: 14 };
    if (meta.category) infoSheet.getCell("A2").value = meta.category;

    let infoRow = 4;
    for (const field of buildExportMetaFields(meta)) {
      infoSheet.getCell(`A${infoRow}`).value = field.label;
      infoSheet.getCell(`A${infoRow}`).font = { bold: true };
      const valueCell = infoSheet.getCell(`B${infoRow}`);
      valueCell.value = field.href
        ? { text: field.value, hyperlink: field.href }
        : field.value;
      if (field.href) valueCell.font = { color: { argb: "FF0066CC" } };
      infoRow++;
    }

    const disclaimerCell = infoSheet.getCell(`A${infoRow + 1}`);
    disclaimerCell.value = tExport("disclaimer");
    disclaimerCell.alignment = { vertical: "top", wrapText: true };
    infoSheet.mergeCells(`A${infoRow + 1}:B${infoRow + 1}`);
    infoSheet.getRow(infoRow + 1).height = 60;

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${baseFileName()}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // The `.json` export is the server's, not a client rebuild: that response
  // already carries the disclaimer, the llms pointer and the video metadata,
  // so the downloaded file is byte-identical to what an agent fetches from
  // `/{locale}/{slug}.json`. Same-origin, so `download` names the file.
  const downloadJson = () => {
    const a = document.createElement("a");
    a.href = exportUrls().jsonUrl;
    a.download = `${baseFileName()}.json`;
    a.click();
  };

  const triggerDownload = (
    text: string,
    extension: string,
    mimeType: string,
  ) => {
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${baseFileName()}.${extension}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const buildPlainTextBody = (): string | null => {
    if (!segments || !statements) return null;
    return formatTranscriptAsPlainText(
      segments,
      statements,
      (idx) => getSpeakerText(idx),
      formatTime,
    );
  };

  const downloadTxt = () => {
    const body = buildPlainTextBody();
    if (body === null) return;
    const header = buildExportHeaderText(exportMeta(), tExport("disclaimer"));
    triggerDownload(`${header}${body}`, "txt", "text/plain;charset=utf-8");
  };

  // Returns true on a successful clipboard write so the toolbar can decide
  // whether to flash its "Copied to clipboard" toast.
  const copyToClipboard = async (): Promise<boolean> => {
    const body = buildPlainTextBody();
    if (body === null) return false;
    const header = buildExportHeaderText(
      exportMeta(true),
      tExport("disclaimer"),
    );
    const text = `${header}${body}`;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.error("Failed to copy transcript to clipboard:", err);
      return false;
    }
  };

  // Format milliseconds as `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (VTT).
  const formatCueTime = (ms: number, separator: "," | ".") => {
    const safe = Math.max(0, Math.round(ms));
    const h = Math.floor(safe / 3600000);
    const m = Math.floor((safe % 3600000) / 60000);
    const s = Math.floor((safe % 60000) / 1000);
    const milli = safe % 1000;
    const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(milli, 3)}`;
  };

  type CaptionCue = { start: number; end: number; text: string };

  const buildCaptionCues = (): CaptionCue[] => {
    if (!segments || !statements) return [];
    const cues: CaptionCue[] = [];
    segments.forEach((segment) => {
      const speaker = getSpeakerText(segment.statementIndices[0] ?? 0);
      let isFirstSentenceOfSegment = true;
      segment.statementIndices.forEach((stmtIdx) => {
        const stmt = statements[stmtIdx];
        if (!stmt) return;
        stmt.paragraphs.forEach((para) => {
          para.sentences.forEach((sent) => {
            if (!sent.text.trim()) return;
            if (sent.end <= sent.start) return;
            const prefix = isFirstSentenceOfSegment ? `${speaker}: ` : "";
            cues.push({
              start: sent.start,
              end: sent.end,
              text: `${prefix}${sent.text.trim()}`,
            });
            isFirstSentenceOfSegment = false;
          });
        });
      });
    });
    return cues;
  };

  const downloadSrt = () => {
    const cues = buildCaptionCues();
    if (cues.length === 0) return;
    // SRT has no comment syntax, so the disclaimer rides as a short cue at
    // the very start (briefly visible in the player).
    const disclaimerEnd = Math.max(1000, Math.min(2000, cues[0].start));
    const disclaimerCue = `1\n${formatCueTime(0, ",")} --> ${formatCueTime(disclaimerEnd, ",")}\n[${tExport("disclaimer")}]\n`;
    const body = [
      disclaimerCue,
      ...cues.map(
        (cue, i) =>
          `${i + 2}\n${formatCueTime(cue.start, ",")} --> ${formatCueTime(cue.end, ",")}\n${cue.text}\n`,
      ),
    ].join("\n");
    triggerDownload(body, "srt", "application/x-subrip;charset=utf-8");
  };

  const downloadVtt = () => {
    const cues = buildCaptionCues();
    if (cues.length === 0) return;
    const body =
      buildExportHeaderVtt(exportMeta(), tExport("disclaimer")) +
      cues
        .map(
          (cue) =>
            `${formatCueTime(cue.start, ".")} --> ${formatCueTime(cue.end, ".")}\n${cue.text}\n`,
        )
        .join("\n");
    triggerDownload(body, "vtt", "text/vtt;charset=utf-8");
  };

  // Tracks the language we've already wired the panel for, so the effect
  // is a no-op when it re-fires with the same (kalturaId, selectedLanguage).
  // Critical for React Strict Mode dev double-invocation: a naive "consumed
  // once" boolean ran the skip-branch on the first invoke then the reset+
  // fetch branch on Strict Mode's second invoke, flipping `checking` true
  // for a frame and producing a spurious "Checking for existing transcript"
  // spinner even on pages whose SSR'd transcript was fully populated.
  // Compare against the actual deps instead — only do work when they
  // actually changed.
  const wiredKeyRef = useRef<string | null>(null);

  // Check cache on mount and language change
  useEffect(() => {
    const key = `${kalturaId}|${selectedLanguage}`;
    if (wiredKeyRef.current === key) return;
    const firstWire = wiredKeyRef.current === null;
    wiredKeyRef.current = key;

    if (firstWire && hasMatchingInitial) {
      // SSR pre-loaded the full TranscriptPayload (statements, speaker
      // mappings, topics, propositions, and the meta atom — all seeded in the
      // useState initializers above; segments + countryNames are computed
      // inline via useMemo, so they're already in the SSR DOM). The only
      // side-effect left is pulling word-level timestamps for karaoke/
      // click-to-seek — any pending retranscribe in the payload is picked up
      // by the polling effect keyed on meta.pendingRetranscribeId.
      const ctrl = new AbortController();
      pollAbortRef.current = ctrl;
      setChecking(false);
      void loadWords(initialTranscript!.transcriptId, ctrl.signal);
      return () => ctrl.abort();
    }

    setStatements(null);
    setRawParagraphs(null);
    setTopics({});
    setPropositions([]);
    setSpeakerMappings({});
    setTranscriptId(null);
    setErrorMessage(null);
    setStage("idle");
    setChecking(true);
    setMeta(null);
    setRetranscribeStarting(false);
    setRetranscribeError(null);

    const ctrl = new AbortController();
    pollAbortRef.current = ctrl;
    const signal = ctrl.signal;

    const checkCache = async () => {
      try {
        const response = await fetch(
          `/api/transcripts/check?kalturaId=${encodeURIComponent(kalturaId)}&language=${encodeURIComponent(selectedLanguage)}`,
          { signal },
        );
        if (signal.aborted) return;
        if (response.ok) {
          const data = await response.json();
          if (signal.aborted) return;
          if (data.transcriptId) setTranscriptId(data.transcriptId);
          if (data.statements && data.statements.length > 0) {
            setStatements(data.statements);
            // /api/transcripts/check returns statements WITHOUT word-level
            // timestamps for speed. Kick off the words fetch in parallel —
            // the transcript renders immediately with sentence-level seeks;
            // word-level karaoke/click lights up once /words arrives.
            if (data.transcriptId) {
              void loadWords(data.transcriptId, signal);
            }
            if (data.topics) setTopics(data.topics);
            if (data.propositions) setPropositions(data.propositions);
            if (data.speakerMappings) setSpeakerMappings(data.speakerMappings);
            // Transcript-row metadata (analysis-axis status, realignment-
            // flagged state, pending retranscribe) — same seeding function as
            // the SSR initializer, same TranscriptPayload shape. Covers:
            // a viewer who loads mid-analysis sees "Analyzing…" rather than
            // the Run button, and a flagged row shows the out-of-sync banner.
            // If a fresh retranscribe is already in flight (any user kicked
            // one off), the pendingRetranscribeId seeded here activates the
            // polling effect, so this viewer sees stage progress and the new
            // transcript swaps in automatically when it completes.
            setMeta(metaFromPayload(data as TranscriptPayload));
            setStage("completed");
            onLanguagesRefresh?.();
          } else if (data.raw_paragraphs) {
            setRawParagraphs(data.raw_paragraphs);
            if (data.stage) setStage(data.stage);
            if (data.transcriptId) {
              pollForCompletion(data.transcriptId, signal).catch((err) => {
                if (signal.aborted) return;
                setErrorMessage(
                  err instanceof Error ? err.message : "Pipeline failed",
                );
                setStage("error");
              });
            }
          } else if (data.stage === "scheduled") {
            // Queued — the cron starts it once audio is available. Show the
            // queued state to everyone but don't poll (nothing progresses yet).
            setStage("scheduled");
          } else if (data.stage === "no_content") {
            // Terminal: processed, but no transcribable content found.
            // Show the dedicated state; don't poll. Re-transcription stays
            // available (WebTV often trims such recordings later).
            setStage("no_content");
          } else if (
            data.stage &&
            data.stage !== "completed" &&
            data.transcriptId
          ) {
            // Transcription is in progress (started by anyone) — show its stage
            // and poll, so this viewer doesn't start a duplicate.
            setStage(data.stage);
            pollForCompletion(data.transcriptId, signal).catch((err) => {
              if (signal.aborted) return;
              setErrorMessage(
                err instanceof Error ? err.message : "Pipeline failed",
              );
              setStage("error");
            });
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        console.log("Cache check failed:", err);
      } finally {
        if (!signal.aborted) setChecking(false);
      }
    };

    checkCache();
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kalturaId, selectedLanguage]);

  // Auto-scroll to the active paragraph as playback advances. Respects manual
  // scrolling: won't yank the view if the user has scrolled the active
  // paragraph far out of view during continuous playback.
  useScrollToActive({
    activeKey:
      activeStatementIndex < 0 || activeParagraphIndex < 0
        ? null
        : `${activeStatementIndex}-${activeParagraphIndex}`,
    getElement: (key) =>
      document.querySelector<HTMLElement>(`[data-paragraph-key="${key}"]`),
    currentTimeRef,
    respectManualScroll: true,
  });

  return (
    <div>
      <TranscriptToolbar
        viewMode={viewMode}
        onViewModeChange={changeViewMode}
        selectedLanguage={selectedLanguage}
        availableLanguages={availableLanguages}
        onLanguageChange={onLanguageChange}
        pvSymbol={pvSymbol}
        hasSegments={!!segments}
        hasRawParagraphs={!!rawParagraphs}
        hasPropositions={propositions.length > 0}
        hasTopics={Object.keys(topics).length > 0}
        isLoggedIn={isLoggedIn}
        experimentalAccess={experimentalAccess}
        checking={checking}
        stage={stage}
        starting={starting}
        kalturaId={kalturaId}
        videoStatus={video.status}
        onTranscribe={() => handleTranscribe()}
        onSchedule={handleSchedule}
        onShare={handleShare}
        onDownloadDocx={downloadDocx}
        onDownloadExcel={downloadExcel}
        onDownloadTxt={downloadTxt}
        onDownloadSrt={downloadSrt}
        onDownloadVtt={downloadVtt}
        onDownloadJson={downloadJson}
        onCopyToClipboard={copyToClipboard}
      />

      {/* Permanent provenance note for automatic transcripts, styled like the
          panel's other notification bubbles (FlaggedTranscriptBanner, the
          no-transcript hint) but in the neutral register since it is not an
          exceptional state. Scoped like the FlaggedTranscriptBanner: hidden in
          the PV view, where the content actually is the official record. */}
      {viewMode !== "pv" &&
        (segments || (rawParagraphs && rawParagraphs.length > 0)) && (
          <div className="mt-2 mb-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
            <p className={cn(typography.body, "text-muted-foreground")}>
              {t.rich("transcriptDisclaimer", {
                aboutLink: (chunks) => (
                  <Link
                    href="/about"
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          </div>
        )}

      {checking && stage === "idle" && (
        // No spinner: show the same shape the Suspense fallback uses so the
        // transition from "panel mounted, still checking" to "panel has
        // transcript" doesn't look like a different kind of loading state.
        <TranscriptSkeleton />
      )}

      {stage === "scheduled" && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-2 w-2 animate-pulse rounded-full bg-muted-foreground/60" />
          <span>{t("queuedForTranscription")}</span>
        </div>
      )}

      {/* Processed, but the recording contained no transcribable speech
          (silence-dominated feeds). Neutral info state, not an error; the
          toolbar's Generate button stays available for a re-run once WebTV
          trims the recording. Junk content and internal reasons are never
          shown. */}
      {stage === "no_content" && viewMode !== "pv" && (
        <div className="mt-2 rounded-lg border border-border bg-muted/30 px-5 py-6">
          <p className="mb-1 text-sm font-medium text-foreground">
            {t("noContentTitle")}
          </p>
          <p className="text-sm text-muted-foreground">{t("noContentHint")}</p>
        </div>
      )}

      {isLoading && !starting && <StageProgress currentStage={stage} />}

      {stage === "error" && (
        <StageProgress
          currentStage={stage}
          errorMessage={errorMessage || undefined}
          onRetry={handleRetry}
        />
      )}

      {flagged && viewMode !== "pv" && (
        <FlaggedTranscriptBanner
          sourceDurationMs={sourceDurationMs}
          alignedDurationMs={alignedDurationMs}
          isLoggedIn={isLoggedIn}
          pendingStage={pendingRetranscribeStage}
          starting={retranscribeStarting}
          error={retranscribeError}
          onRetranscribe={handleRetranscribe}
        />
      )}

      {experimentalAccess &&
        viewMode === "analysis" &&
        propositions.length > 0 && (
          <AnalysisView
            propositions={propositions}
            statements={statements}
            speakerMappings={speakerMappings}
            countryNames={countryNames}
            onJumpToTimestamp={(ms) => seekToTimestamp(ms / 1000)}
          />
        )}

      {experimentalAccess &&
        viewMode === "analysis" &&
        propositions.length === 0 &&
        stage === "completed" && (
          <div className="mt-8 flex flex-col items-center gap-4 text-center">
            <BarChart3 className="h-10 w-10 text-muted-foreground/50" />
            <div>
              <p className="text-sm font-medium">{t("noAnalysisYet")}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("noAnalysisBody")}
              </p>
            </div>
            <button
              onClick={handleRunAnalysis}
              disabled={analyzingPropositions}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {analyzingPropositions ? (
                <span className="flex items-center gap-2">
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  {t("analyzing")}
                </span>
              ) : (
                t("runAnalysis")
              )}
            </button>
          </div>
        )}

      {viewMode === "pv" && pvSymbol && (
        <PVPanel
          pvSymbol={pvSymbol}
          language={selectedLanguage}
          player={player}
          kalturaId={kalturaId}
          onSpeakersChange={handlePvSpeakersChange}
        />
      )}

      {viewMode === "transcript" && segments && (
        <TranscriptView
          segments={segments}
          statements={statements}
          speakerMappings={speakerMappings}
          countryNames={countryNames}
          topics={topics}
          activeSegmentIndex={activeSegmentIndex}
          activeStatementIndex={activeStatementIndex}
          activeParagraphIndex={activeParagraphIndex}
          activeSentenceIndex={activeSentenceIndex}
          activeWordIndex={activeWordIndex}
          selectedTopic={selectedTopic}
          topicCollapsed={topicCollapsed}
          onSeek={seekToTimestamp}
          getAnchorUrl={anchorUrl}
          flashSegmentIndex={flashSegmentIndex}
        />
      )}

      {!segments && rawParagraphs && rawParagraphs.length > 0 && (
        <RawTranscriptView
          rawParagraphs={rawParagraphs}
          onSeek={seekToTimestamp}
        />
      )}

      {!segments &&
        !rawParagraphs &&
        stage === "idle" &&
        !checking &&
        viewMode !== "pv" && (
          <div className="mt-2 rounded-lg border border-border bg-muted/30 px-5 py-6">
            {video.status === "live" || video.status === "scheduled" ? (
              <>
                <p className="mb-1 text-sm font-medium text-foreground">
                  {t("noTranscriptYet")}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t.rich("noTranscriptHintPending", {
                    strong: (chunks) => (
                      <span className="font-medium">{chunks}</span>
                    ),
                  })}
                </p>
              </>
            ) : (
              <>
                <p className="mb-1 text-sm font-medium text-foreground">
                  {t("noTranscriptYet")}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t("noTranscriptHintFinished")}
                </p>
              </>
            )}
          </div>
        )}
    </div>
  );
}
