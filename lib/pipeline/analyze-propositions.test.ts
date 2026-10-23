import type { AzureOpenAI } from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeakerMapping } from "@/lib/speakers";
import type { StatementWithSentences } from "./shared";

vi.mock("@/lib/usage-tracking", () => ({
  trackOpenAIChatCompletion: vi.fn(),
  UsageOperations: { analyzePropositions: "analyze_propositions" },
  UsageStages: { analyzingPropositions: "analyzing_propositions" },
}));
import { trackOpenAIChatCompletion } from "@/lib/usage-tracking";
import { analyzePropositions } from "./analyze-propositions";

function statement(...paragraphs: string[]): StatementWithSentences {
  return {
    start: 0,
    end: 100,
    paragraphs: paragraphs.map((text) => ({
      start: 0,
      end: 100,
      sentences: [{ text, start: 0, end: 100 }],
    })),
  };
}

describe("proposition source alignment", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses final statement indices for grouped and split speeches, prompts and evidence", async () => {
    // Two original chair paragraphs have been grouped into statement 0.
    // A later mixed NGO/government paragraph has been split into statements 1 and 2.
    const statements = [
      statement(
        "The meeting is open.",
        "I give the floor to Human Rights Now.",
      ),
      statement("We call for the release of peaceful critics."),
      statement("Our government disagrees with these allegations."),
    ];
    const speakers: SpeakerMapping = {
      "0": { name: null, function: "Chair", affiliation: null, group: null },
      "1": {
        name: null,
        function: "Representative",
        affiliation: "Human Rights Now",
        group: null,
      },
      "2": {
        name: null,
        function: "Representative",
        affiliation: "KHM",
        group: null,
      },
    };
    const evidence = [
      {
        stakeholder: "Human Rights Now",
        statementIndex: 1,
        quote: "We call for the release of peaceful critics.",
      },
      {
        stakeholder: "KHM",
        statementIndex: 2,
        quote: "Our government disagrees with these allegations.",
      },
      // A quote that exists, but only in a different statement, must be rejected.
      {
        stakeholder: "KHM",
        statementIndex: 2,
        quote: "We call for the release of peaceful critics.",
      },
    ];
    vi.mocked(trackOpenAIChatCompletion).mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              propositions: [
                {
                  key: "release-critics",
                  title: "Release critics",
                  statement: "Release peaceful critics.",
                  positions: [
                    {
                      stance: "support",
                      stakeholders: ["Human Rights Now", "KHM"],
                      summary: "Positions.",
                      evidence,
                    },
                  ],
                },
              ],
            }),
          },
        },
      ],
    } as never);

    const result = await analyzePropositions(
      statements,
      speakers,
      {} as AzureOpenAI,
    );
    const call = vi.mocked(trackOpenAIChatCompletion).mock.calls[0][0];
    const prompt = String(call.request.messages[1].content);
    expect(prompt).toContain("[1] (Human Rights Now) We call for the release");
    expect(prompt).toContain("[2] (KHM) Our government disagrees");
    expect(prompt).not.toContain("I give the floor");
    expect(result[0].positions[0].evidence).toEqual(evidence.slice(0, 2));
  });

  it("omits off-record statements without shifting evidence indices", async () => {
    const statements = [
      statement("Private off-record discussion."),
      statement("We support the proposal."),
      statement("We also support the proposal."),
    ];
    const base = { name: null, function: null, group: null };
    const speakers: SpeakerMapping = {
      "0": { ...base, affiliation: "Private", is_off_record: true },
      "1": { ...base, affiliation: "USA" },
      "2": { ...base, affiliation: "FRA" },
    };
    vi.mocked(trackOpenAIChatCompletion).mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              propositions: [
                {
                  key: "proposal",
                  title: "Proposal",
                  statement: "Adopt the proposal.",
                  positions: [
                    {
                      stance: "support",
                      stakeholders: ["USA"],
                      summary: "Supports.",
                      evidence: [
                        {
                          stakeholder: "USA",
                          statementIndex: 1,
                          quote: "We support the proposal.",
                        },
                        {
                          stakeholder: "Private",
                          statementIndex: 0,
                          quote: "Private off-record discussion.",
                        },
                      ],
                    },
                  ],
                },
              ],
            }),
          },
        },
      ],
    } as never);
    const result = await analyzePropositions(
      statements,
      speakers,
      {} as AzureOpenAI,
    );
    const prompt = String(
      vi.mocked(trackOpenAIChatCompletion).mock.calls[0][0].request.messages[1]
        .content,
    );
    expect(prompt).not.toContain("Private off-record");
    expect(prompt).toContain("[1] (USA)");
    expect(prompt).toContain("[2] (FRA)");
    expect(result[0].positions[0].evidence).toEqual([
      {
        stakeholder: "USA",
        statementIndex: 1,
        quote: "We support the proposal.",
      },
    ]);
  });
});
