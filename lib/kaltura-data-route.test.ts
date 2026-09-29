import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { VideoRecord } from "@/lib/db";

const mocks = vi.hoisted(() => ({
  getVideoByKalturaId: vi.fn(),
  getTranscriptByKalturaId: vi.fn(),
  getVideoMetadata: vi.fn(),
  getSpeakerMapping: vi.fn(),
}));

vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  ...mocks,
}));

vi.mock("@/lib/get-base-url", () => ({
  getBaseUrl: vi.fn(async () => "https://transcripts.un.org"),
}));

vi.mock("@/lib/un-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/un-api")>()),
  getVideoMetadata: mocks.getVideoMetadata,
}));

import { GET } from "@/app/api/data/[locale]/[format]/[...path]/route";

describe("Kaltura public data route", () => {
  beforeEach(() => {
    mocks.getVideoByKalturaId.mockResolvedValue({
      asset_id: "k1h/k1hrmtg9f4",
      entry_id: "1_yuo0w3j6",
      kaltura_id: "1_hrmtg9f4",
      title: "Meeting",
      clean_title: "Meeting",
      date: "2026-08-29",
      scheduled_time: new Date("2026-08-29T14:00:00Z"),
      duration: 3600,
      url: "https://webtv.un.org/en/asset/k1h/k1hrmtg9f4",
      body: "Security Council",
      category: "Security Council",
      event_code: null,
      event_type: null,
      session_number: null,
      pv_symbol: "S/PV.10001",
      pv_part: 1,
      pv_available: null,
      pv_checked_at: null,
      removed_at: null,
      last_seen: "2026-08-29",
      created_at: new Date("2026-08-29T14:00:00Z"),
      updated_at: new Date("2026-08-29T14:00:00Z"),
      i18n: {},
    } satisfies VideoRecord);
    mocks.getTranscriptByKalturaId.mockResolvedValue(null);
  });

  it("reuses the meeting JSON response for a stable player ID", async () => {
    const response = await GET(
      new NextRequest(
        "https://transcripts.un.org/api/data/en/json/kaltura/1_hrmtg9f4",
      ),
      {
        params: Promise.resolve({
          locale: "en",
          format: "json",
          path: ["kaltura", "1_hrmtg9f4"],
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const payload = await response.json();
    expect(mocks.getVideoMetadata).not.toHaveBeenCalled();
    expect(payload.metadata).toEqual({
      summary: null,
      description: null,
      categories: [],
      geographic_subject: [],
      subject_topical: [],
      corporate_name: [],
      speaker_affiliation: [],
      related_documents: [],
    });
    expect(payload).toMatchObject({
      url: "https://transcripts.un.org/en/sc/10001",
      video: {
        id: "k1h/k1hrmtg9f4",
        kaltura_id: "1_hrmtg9f4",
        slug: "sc/10001",
      },
      transcript: null,
    });
  });

  it.each(["json", "text"])(
    "omits inferred names and off-record remarks from public %s",
    async (format) => {
      mocks.getTranscriptByKalturaId.mockResolvedValue({
        transcript_id: "t1",
        language_code: "en",
        transcription_status: "completed",
        source_duration_ms: 3000,
        aligned_duration_ms: 3000,
        content: {
          statements: ["Thank you, Alice.", "Private remarks"].map(
            (text, i) => ({
              start: i * 1000,
              end: (i + 1) * 1000,
              paragraphs: [
                {
                  start: i * 1000,
                  end: (i + 1) * 1000,
                  sentences: [{ text, start: i * 1000, end: (i + 1) * 1000 }],
                },
              ],
            }),
          ),
        },
      });
      mocks.getSpeakerMapping.mockResolvedValue({
        "0": {
          name: "Unreliable inference",
          affiliation: "FRA",
          group: null,
          function: "Representative",
        },
        "1": {
          name: "Private person",
          affiliation: null,
          group: null,
          function: null,
          is_off_record: true,
        },
      });
      const response = await GET(
        new NextRequest(
          `https://transcripts.un.org/api/data/en/${format}/kaltura/1_hrmtg9f4`,
        ),
        {
          params: Promise.resolve({
            locale: "en",
            format,
            path: ["kaltura", "1_hrmtg9f4"],
          }),
        },
      );
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toMatch(
        /Unreliable inference|Private|Representative|is_off_record/,
      );
      expect(body).toContain("Thank you, Alice.");
      if (format === "json") {
        const data = JSON.parse(body).transcript.data;
        expect(data).toHaveLength(1);
        expect(data[0].speaker).toEqual({
          affiliation: "FRA",
          affiliation_full: "France",
          group: null,
          function: null,
        });
      } else {
        expect(body).toContain("France [0:00]:");
      }
    },
  );

  it("rejects malformed player IDs without querying the database", async () => {
    mocks.getVideoByKalturaId.mockClear();
    const response = await GET(
      new NextRequest(
        "https://transcripts.un.org/api/data/en/json/kaltura/nope",
      ),
      {
        params: Promise.resolve({
          locale: "en",
          format: "json",
          path: ["kaltura", "nope"],
        }),
      },
    );
    expect(response.status).toBe(404);
    expect(mocks.getVideoByKalturaId).not.toHaveBeenCalled();
  });
});
