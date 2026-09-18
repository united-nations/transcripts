"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useLocale } from "next-intl";
import { useSearchParams } from "next/navigation";
import type {
  LanguageOption,
  TranscriptionPanelData,
} from "@/components/transcription-panel";
import { parseTimestamp } from "@/lib/timestamp-url";
import { setUrlParam, setUrlParams } from "@/lib/url-params";

/**
 * State shared between the meeting page's chrome (VideoPageClient: language
 * switcher, topic sidebar, video player) and the transcript panel that lives
 * inside its Suspense slot. Moved into Context — not prop-drilled — because
 * the panel is now rendered by a server component sibling of VideoPageClient,
 * not its child, so callbacks/props can't reach across the boundary.
 *
 * State that's UI-local to a single component (video docking, back-link,
 * panel-internal stage/error/etc.) stays in that component's useState.
 */
interface PlayerHandle {
  currentTime: number;
  play: () => void;
}

interface MeetingState {
  /** Audio language the user is currently viewing. Defaults to URL locale. */
  selectedLanguage: string;
  setSelectedLanguage: Dispatch<SetStateAction<string>>;

  /** User-initiated audio-language change. Same as setSelectedLanguage but
   *  also reflects the choice in the `?lang=` URL param (omitted when it
   *  matches the page locale, so a plain shared link stays clean). Use this
   *  for explicit picks in the switcher; the internal availability fallback
   *  keeps using the raw setter so an automatic swap never writes the URL. */
  selectLanguage: (code: string) => void;

  /** Language tracks the Kaltura entry exposes + their transcription status. */
  availableLanguages: LanguageOption[];
  setAvailableLanguages: Dispatch<SetStateAction<LanguageOption[]>>;

  /** Topic filter chip — null means "all topics". */
  selectedTopic: string | null;
  setSelectedTopic: Dispatch<SetStateAction<string | null>>;

  /** Whether to show only topic matches or all content with highlights. */
  topicCollapsed: boolean;
  setTopicCollapsed: Dispatch<SetStateAction<boolean>>;

  /** Live snapshot of the panel's derived data (segments, topics, etc.) —
   *  the sidebar's speaker/topic widgets read from this. */
  panelData: TranscriptionPanelData | null;
  setPanelData: Dispatch<SetStateAction<TranscriptionPanelData | null>>;

  /** The Kaltura player handle, once ready. Used by the panel for seeks
   *  and by the playback-tracking hook for time-driven highlight. */
  player: PlayerHandle | undefined;
  setPlayer: Dispatch<SetStateAction<PlayerHandle | undefined>>;

  /** Timestamp deeplink target (`?t=<seconds or clock>`), or null. Read once on
   *  mount; the panel uses it to flash the statement the link points at. */
  initialSeekSeconds: number | null;

  /** Refetch the available-languages list from /api/languages. The panel
   *  fires this after a successful transcribe POST so a brand-new track
   *  shows up in the chrome's language switcher without a page reload. */
  refreshLanguages: () => void;
}

const MeetingStateContext = createContext<MeetingState | null>(null);

export function useMeetingState(): MeetingState {
  const ctx = useContext(MeetingStateContext);
  if (!ctx) {
    throw new Error(
      "useMeetingState must be used within <MeetingStateProvider>",
    );
  }
  return ctx;
}

interface MeetingStateProviderProps {
  /** Kaltura entry id for the meeting. Stable for the lifetime of the page;
   *  the provider keeps it for refreshLanguages without re-reading from props. */
  kalturaId: string;
  children: ReactNode;
}

export function MeetingStateProvider({
  kalturaId,
  children,
}: MeetingStateProviderProps) {
  // Default to the URL locale — same language the user picked for the site
  // is the natural first guess for what they want to read/listen to. An
  // explicit `?lang=` param (the user previously picked a different audio
  // track and shared/reloaded the link) wins over the locale default. If the
  // chosen language isn't actually available for this meeting, a fallback
  // effect below swaps it to floor / first-available.
  const uiLocale = useLocale();
  const searchParams = useSearchParams();
  // Read the param once for the initial state; subsequent changes flow through
  // selectLanguage, which writes the URL back. (Effect deps intentionally omit
  // searchParams so a back/forward isn't wired up here — the toggle is
  // replaceState, so there are no lang entries in history to navigate anyway.)
  const [selectedLanguage, setSelectedLanguage] = useState<string>(
    () => searchParams.get("lang") || uiLocale,
  );
  const [availableLanguages, setAvailableLanguages] = useState<
    LanguageOption[]
  >([]);

  const [panelData, setPanelData] = useState<TranscriptionPanelData | null>(
    null,
  );
  const [player, setPlayer] = useState<PlayerHandle | undefined>();

  // URL is the source of truth, including browser back/forward navigation.
  // Wait for the panel before deciding whether a requested key exists.
  const requestedTopic = searchParams.get("topic") || null;
  const topicsReady =
    panelData && !panelData.checking && panelData.statements !== null;
  const selectedTopic =
    requestedTopic &&
    (!topicsReady || Object.hasOwn(panelData.topics, requestedTopic))
      ? requestedTopic
      : null;
  const topicCollapsed =
    !selectedTopic || searchParams.get("topicMode") !== "all";
  const setSelectedTopic = useCallback<Dispatch<SetStateAction<string | null>>>(
    (value) => {
      const topic = typeof value === "function" ? value(selectedTopic) : value;
      setUrlParams({ topic: topic || undefined, topicMode: undefined });
    },
    [selectedTopic],
  );
  const setTopicCollapsed = useCallback<Dispatch<SetStateAction<boolean>>>(
    (value) => {
      const collapsed =
        typeof value === "function" ? value(topicCollapsed) : value;
      setUrlParam("topicMode", collapsed ? undefined : "all");
    },
    [topicCollapsed],
  );

  // Timestamp deeplink: `?t=<seconds or clock>` positions the player (paused —
  // browsers block unmuted autoplay without a gesture, and seek-paused is the
  // less jarring landing anyway) at that moment once the player is ready.
  // Read once, like `?lang=`; the app never writes `t` back to the URL — the
  // per-statement copy-link buttons compose it explicitly, so the address bar
  // doesn't drift to a random moment (see TranscriptView).
  const [initialSeekSeconds] = useState<number | null>(() =>
    parseTimestamp(searchParams.get("t")),
  );
  const initialSeekDone = useRef(false);
  useEffect(() => {
    if (!player || initialSeekSeconds === null || initialSeekDone.current)
      return;
    initialSeekDone.current = true;
    try {
      player.currentTime = initialSeekSeconds;
    } catch {
      // Best-effort — a deeplink that fails to seek still shows the meeting.
    }
  }, [player, initialSeekSeconds]);

  const refreshLanguages = useCallback(() => {
    fetch(`/api/languages?kalturaId=${encodeURIComponent(kalturaId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.languages) setAvailableLanguages(data.languages);
      })
      .catch(() => {
        // Best-effort — chrome retains the previous list on failure.
      });
  }, [kalturaId]);

  // Kick off the initial language fetch on mount. Effect runs once per
  // kalturaId, mirroring the previous behavior in VideoPageClient.
  useEffect(() => {
    refreshLanguages();
  }, [refreshLanguages]);

  // Once we know what's actually available for this meeting, validate that
  // `selectedLanguage` is one of the available codes. If not, fall back:
  //   UI locale → floor (original audio) → first available track.
  // Only fires when availableLanguages updates and the selection is invalid,
  // so a user's manual pick of an available language is never overridden.
  useEffect(() => {
    if (availableLanguages.length === 0) return;
    const currentIsAvailable = availableLanguages.some(
      (l) => l.code === selectedLanguage && l.available,
    );
    if (currentIsAvailable) return;
    const floor = availableLanguages.find(
      (l) => l.code === "floor" && l.available,
    );
    const firstAvailable = availableLanguages.find((l) => l.available);
    const fallback = floor?.code ?? firstAvailable?.code;
    if (fallback && fallback !== selectedLanguage) {
      setSelectedLanguage(fallback);
    }
  }, [availableLanguages, selectedLanguage]);

  // Explicit user pick from the language switcher: update state AND reflect it
  // in `?lang=`, dropping the param when the pick matches the page locale (the
  // default) so links stay clean. The availability fallback above deliberately
  // does NOT go through here — an automatic swap must not write the URL.
  const selectLanguage = useCallback(
    (code: string) => {
      setSelectedLanguage(code);
      setUrlParam("lang", code === uiLocale ? undefined : code);
    },
    [uiLocale],
  );

  const value = useMemo<MeetingState>(
    () => ({
      selectedLanguage,
      setSelectedLanguage,
      selectLanguage,
      availableLanguages,
      setAvailableLanguages,
      selectedTopic,
      setSelectedTopic,
      topicCollapsed,
      setTopicCollapsed,
      panelData,
      setPanelData,
      player,
      setPlayer,
      initialSeekSeconds,
      refreshLanguages,
    }),
    [
      selectedLanguage,
      selectLanguage,
      availableLanguages,
      selectedTopic,
      setSelectedTopic,
      topicCollapsed,
      setTopicCollapsed,
      panelData,
      player,
      initialSeekSeconds,
      refreshLanguages,
    ],
  );

  return (
    <MeetingStateContext.Provider value={value}>
      {children}
    </MeetingStateContext.Provider>
  );
}
