import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("./db", () => ({
  getTranscriptById: vi.fn(),
  getVideoByKalturaId: vi.fn(),
}));
vi.mock("./speakers", () => ({ getSpeakerMapping: vi.fn() }));
vi.mock("./indexnow", () => ({
  automaticIndexNowEnabled: vi.fn(() => true),
  INDEXNOW_ORIGIN: "https://transcripts.un.org",
  submitIndexNow: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
import { getTranscriptById, getVideoByKalturaId } from "./db";
import { getSpeakerMapping } from "./speakers";
import { automaticIndexNowEnabled, submitIndexNow } from "./indexnow";
import { notifyIndexNowByTranscriptId } from "./indexnow-transcript";

const transcript = {
  transcript_id: "test",
  kaltura_id: "player",
  language_code: "fr",
  suppressed_at: null,
  transcription_status: "completed",
  content: { statements: [{ start: 0, end: 1000, paragraphs: [] }] },
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(automaticIndexNowEnabled).mockReturnValue(true);
  vi.mocked(getTranscriptById).mockResolvedValue(transcript as never);
  vi.mocked(getVideoByKalturaId).mockResolvedValue({
    asset_id: "k1a/k1abc",
    pv_symbol: "S/PV.123",
    pv_part: 2,
    removed_at: null,
  } as never);
  vi.mocked(getSpeakerMapping).mockResolvedValue({});
  vi.mocked(submitIndexNow).mockResolvedValue(3);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("announces only the completed transcript's locale and canonical part", async () => {
  await notifyIndexNowByTranscriptId("test");
  expect(submitIndexNow).toHaveBeenCalledWith([
    "https://transcripts.un.org/fr/sc/123/2",
    "https://transcripts.un.org/fr/sc/123/2.txt",
    "https://transcripts.un.org/fr/sc/123/2.json",
  ]);
});
it("never turns a delivery failure into a failed transcript", async () => {
  vi.mocked(submitIndexNow).mockRejectedValue(new Error("unavailable"));
  await expect(notifyIndexNowByTranscriptId("test")).resolves.toBeUndefined();
});
it("does no database or network work when automatic delivery is disabled", async () => {
  vi.mocked(automaticIndexNowEnabled).mockReturnValue(false);
  await notifyIndexNowByTranscriptId("test");
  expect(getTranscriptById).not.toHaveBeenCalled();
  expect(submitIndexNow).not.toHaveBeenCalled();
});
it.each([
  { suppressed_at: new Date() },
  { language_code: "floor" },
  { transcription_status: "identifying_speakers" },
  { content: { statements: [] } },
])("skips a transcript that is not public: %j", async (overrides) => {
  vi.mocked(getTranscriptById).mockResolvedValue({
    ...transcript,
    ...overrides,
  } as never);
  await notifyIndexNowByTranscriptId("test");
  expect(submitIndexNow).not.toHaveBeenCalled();
});
it("does not announce off-record-only or removed content", async () => {
  vi.mocked(getSpeakerMapping).mockResolvedValue({
    "0": {
      name: null,
      function: null,
      affiliation: null,
      group: null,
      is_off_record: true,
    },
  });
  await notifyIndexNowByTranscriptId("test");
  expect(submitIndexNow).not.toHaveBeenCalled();
  vi.mocked(getSpeakerMapping).mockResolvedValue({});
  vi.mocked(getVideoByKalturaId).mockResolvedValue({
    removed_at: new Date(),
  } as never);
  await notifyIndexNowByTranscriptId("test");
  expect(submitIndexNow).not.toHaveBeenCalled();
});
