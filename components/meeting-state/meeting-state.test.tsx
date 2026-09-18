import { useEffect } from "react";
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MeetingStateProvider, useMeetingState } from "./meeting-state";
import type { TranscriptionPanelData } from "../transcription-panel";

vi.mock("next-intl", () => ({ useLocale: () => "en" }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

let meeting: ReturnType<typeof useMeetingState>;
function Probe() {
  const state = useMeetingState();
  useEffect(() => {
    meeting = state;
  }, [state]);
  return (
    <>
      <span data-testid="state">
        {state.selectedTopic ?? "none"}:{String(state.topicCollapsed)}:
        {state.initialSeekSeconds}
      </span>
      <button onClick={() => state.setSelectedTopic("nuclear_risk")}>
        Select
      </button>
      <button onClick={() => state.setTopicCollapsed(false)}>Expand</button>
      <button onClick={() => state.setSelectedTopic(null)}>Clear</button>
    </>
  );
}
function Page() {
  return (
    <MeetingStateProvider kalturaId="test">
      <Probe />
    </MeetingStateProvider>
  );
}
const data = {
  checking: false,
  statements: [],
  topics: {
    nuclear_risk: {
      key: "nuclear_risk",
      label: "Nuclear risk",
      description: "",
    },
  },
} as unknown as TranscriptionPanelData;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  window.history.replaceState(null, "", "/en/sc/1");
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ languages: [] }) }),
  );
});

it("restores topic, mode and clock seek while transcript data loads", async () => {
  window.history.replaceState(
    null,
    "",
    "?topic=nuclear_risk&topicMode=all&t=4:15:59",
  );
  render(<Page />);
  expect(screen.getByTestId("state").textContent).toBe(
    "nuclear_risk:false:15359",
  );
  act(() => meeting.setPanelData(data));
  expect(meeting.selectedTopic).toBe("nuclear_risk");
  const player = { currentTime: 0, play: vi.fn() };
  act(() => meeting.setPlayer(player));
  await waitFor(() => expect(player.currentTime).toBe(15359));
});

it("updates filters atomically, preserves other parameters and follows URL navigation", () => {
  window.history.replaceState(
    null,
    "",
    "?lang=fr&view=transcript&t=3:50#statement",
  );
  const { rerender } = render(<Page />);
  fireEvent.click(screen.getByText("Select"));
  rerender(<Page />);
  expect(meeting.selectedTopic).toBe("nuclear_risk");
  fireEvent.click(screen.getByText("Expand"));
  rerender(<Page />);
  expect(window.location.search).toContain("topicMode=all");
  expect(meeting.topicCollapsed).toBe(false);
  fireEvent.click(screen.getByText("Clear"));
  rerender(<Page />);
  expect(window.location.search).toBe("?lang=fr&view=transcript&t=3:50");
  expect(window.location.hash).toBe("#statement");
  window.history.replaceState(null, "", "?topic=nuclear_risk");
  rerender(<Page />);
  expect(meeting.selectedTopic).toBe("nuclear_risk");
  expect(meeting.topicCollapsed).toBe(true);
});

it("ignores unknown topics only once data is available", () => {
  window.history.replaceState(null, "", "?topic=unknown");
  render(<Page />);
  expect(meeting.selectedTopic).toBe("unknown");
  act(() => meeting.setPanelData(data));
  expect(meeting.selectedTopic).toBeNull();
});
