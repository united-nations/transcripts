import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { AuthUser } from "./auth/service";
import type { Transcript } from "./db";

vi.mock("./auth/service", () => ({ getCurrentUser: vi.fn() }));
vi.mock("./db", () => ({
  getTranscriptById: vi.fn(),
  getTranscriptByKalturaId: vi.fn(),
  getActiveTranscriptByKalturaId: vi.fn(),
  getPendingTranscriptByKalturaId: vi.fn(),
  getSpeakerMapping: vi.fn().mockResolvedValue({}),
  isTranscriptFlagged: vi.fn().mockReturnValue(false),
  claimAnalysis: vi.fn().mockResolvedValue(true),
  releaseAnalysis: vi.fn(),
  updateTranscriptContent: vi.fn(),
}));
vi.mock("./speakers", () => ({ getSpeakerMapping: vi.fn() }));
vi.mock("./transcription", () => ({
  pollTranscription: vi.fn(),
  submitTranscription: vi.fn(),
}));
vi.mock("./pipeline", () => ({ analyzePropositions: vi.fn() }));
vi.mock("openai", () => ({ AzureOpenAI: class {} }));
vi.mock("./worker-identity", () => ({ currentWorkerId: () => "test-worker" }));
vi.mock("./rate-limit", () => ({
  enforceUserDailyLimit: vi.fn(),
  enforceGlobalDailyLimit: vi.fn(),
}));

import { getCurrentUser } from "./auth/service";
import {
  getTranscriptById,
  getTranscriptByKalturaId,
  getActiveTranscriptByKalturaId,
  claimAnalysis,
  getSpeakerMapping as getDbSpeakerMapping,
} from "./db";
import { getSpeakerMapping } from "./speakers";
import { pollTranscription } from "./transcription";
import { analyzePropositions } from "./pipeline";
import { buildTranscriptPayload } from "./transcript-payload";
import { GET as poll } from "@/app/api/transcripts/[id]/route";
import { GET as check } from "@/app/api/transcripts/check/route";
import { POST as cachedPost } from "@/app/api/transcripts/route";
import { POST as runAnalysis } from "@/app/api/transcripts/[id]/analysis/route";

const propositions = [{ key: "private-analysis" }];
const transcript = {
  transcript_id: "t1",
  kaltura_id: "k1",
  language_code: "en",
  transcription_status: "completed",
  analysis_status: "completed",
  content: {
    statements: [
      {
        start: 0,
        end: 1000,
        paragraphs: [
          {
            start: 0,
            end: 1000,
            sentences: [{ text: "Public transcript", start: 0, end: 1000 }],
          },
        ],
      },
    ],
    raw_paragraphs: [
      { text: "Public transcript" },
      { text: "Off-record remarks" },
    ],
    propositions,
  },
} as unknown as Transcript;
transcript.content.statements.push({
  start: 1000,
  end: 2000,
  paragraphs: [
    {
      start: 1000,
      end: 2000,
      sentences: [{ text: "Off-record remarks", start: 1000, end: 2000 }],
    },
  ],
});
const context = { params: Promise.resolve({ id: "t1" }) };
const accounts: [string, AuthUser | null][] = [
  ["anonymous", null],
  [
    "ordinary",
    {
      id: "u1",
      email: "ordinary@example.org",
      experimentalAccess: false,
      experimentalWaitlistAt: null,
    },
  ],
  [
    "experimental",
    {
      id: "u2",
      email: "experimental@example.org",
      experimentalAccess: true,
      experimentalWaitlistAt: null,
    },
  ],
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTranscriptById).mockResolvedValue(transcript);
  vi.mocked(getTranscriptByKalturaId).mockResolvedValue(transcript);
  vi.mocked(getActiveTranscriptByKalturaId).mockResolvedValue(transcript);
  const mapping = {
    "0": {
      name: "Inferred person",
      affiliation: "FRA",
      function: "Representative",
      group: null,
    },
    "1": {
      name: "Off-record person",
      affiliation: null,
      function: null,
      group: null,
      is_off_record: true,
    },
  };
  vi.mocked(getSpeakerMapping).mockResolvedValue(mapping);
  vi.mocked(getDbSpeakerMapping).mockResolvedValue(mapping);
  vi.mocked(pollTranscription).mockImplementation(async () => ({
    stage: "completed",
    statements: transcript.content.statements,
    propositions: transcript.content.propositions,
    raw_paragraphs: transcript.content.raw_paragraphs,
  }));
  vi.mocked(analyzePropositions).mockResolvedValue(
    transcript.content.propositions!,
  );
});

describe.each(accounts)("analysis access: %s", (_name, user) => {
  beforeEach(() => vi.mocked(getCurrentUser).mockResolvedValue(user));
  const allowed = !!user?.experimentalAccess;
  it("filters the shared SSR payload", async () => {
    const result = await buildTranscriptPayload(transcript, {
      experimentalAccess: allowed,
    });
    expect(result.propositions).toEqual(allowed ? propositions : []);
    expect(result.statements).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("Off-record");
    expect(result.speakerMappings["0"].name).toBe(
      allowed ? "Inferred person" : undefined,
    );
    expect(result.speakerMappings["0"].function).toBe(
      allowed ? "Representative" : null,
    );
  });
  it.each(["check", "cached POST", "poll"])(
    "filters %s responses while retaining public transcripts",
    async (route) => {
      const response =
        route === "check"
          ? await check(
              new NextRequest(
                "http://localhost/api/transcripts/check?kalturaId=k1",
              ),
            )
          : route === "cached POST"
            ? await cachedPost(
                new NextRequest("http://localhost/api/transcripts", {
                  method: "POST",
                  body: JSON.stringify({ kalturaId: "k1" }),
                }),
              )
            : await poll(
                new NextRequest("http://localhost/api/transcripts/t1"),
                context,
              );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.propositions).toEqual(allowed ? propositions : []);
      expect(body.statements).toHaveLength(1);
      expect(JSON.stringify(body)).not.toContain("Off-record");
      expect(body).not.toHaveProperty("raw_paragraphs");
      expect(body.speakerMappings["0"].name).toBe(
        allowed ? "Inferred person" : undefined,
      );
      expect(body.speakerMappings["0"].function).toBe(
        allowed ? "Representative" : null,
      );
      expect(response.headers.get("cache-control")).toContain("private");
      expect(response.headers.get("vary")).toContain("Cookie");
    },
  );
  it("authorizes execution before starting paid work", async () => {
    const response = await runAnalysis(
      new NextRequest("http://localhost/api/transcripts/t1/analysis", {
        method: "POST",
      }),
      context,
    );
    expect(response.status).toBe(allowed ? 200 : user ? 403 : 401);
    expect(claimAnalysis).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(analyzePropositions).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(getTranscriptById).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });
});

it("does not reuse an authorized polling body after access is revoked", async () => {
  vi.mocked(getCurrentUser).mockResolvedValue(accounts[2][1]);
  const authorized = await poll(
    new NextRequest("http://localhost/api/transcripts/t1"),
    context,
  );
  vi.mocked(getCurrentUser).mockResolvedValue(accounts[1][1]);
  const denied = await poll(
    new NextRequest("http://localhost/api/transcripts/t1", {
      headers: { "if-none-match": authorized.headers.get("etag")! },
    }),
    context,
  );
  expect(denied.status).toBe(200);
  const deniedBody = await denied.json();
  expect(deniedBody.propositions).toEqual([]);
  expect(JSON.stringify(deniedBody)).not.toContain("Inferred person");
  const unchanged = await poll(
    new NextRequest("http://localhost/api/transcripts/t1", {
      headers: { "if-none-match": denied.headers.get("etag")! },
    }),
    context,
  );
  expect(unchanged.status).toBe(304);
  expect(unchanged.headers.get("cache-control")).toContain("private");
  expect(unchanged.headers.get("vary")).toContain("Cookie");
});
