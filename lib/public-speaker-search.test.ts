import { beforeEach, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("pg", () => ({
  Pool: class {
    query = query;
    on = vi.fn();
  },
}));
import { getStatementMatches, queryVideos } from "./db";

const speaker = {
  name: "Inferred person",
  affiliation: "FRA",
  group: null,
  function: "Representative",
  is_off_record: false,
};
const expected = { affiliation: "FRA", group: null, function: null };
beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

it("removes names from meeting statement search results", async () => {
  query.mockResolvedValueOnce({
    rows: [
      {
        transcript_id: "t1",
        statement_idx: 0,
        start_s: 0,
        text: "Peace",
        speaker,
        total: "1",
      },
    ],
  });
  const result = await getStatementMatches("a1", "en", "peace");
  expect(result.hits[0].speaker).toEqual(expected);
  expect(result.hits[0].text).toBe("Peace");
});

it("removes names from feed search summaries used by the website and public JSON", async () => {
  query.mockResolvedValueOnce({
    rows: [
      {
        asset_id: "a1",
        content_match_count: 1,
        content_hits: [
          {
            transcriptId: "t1",
            statementIdx: 0,
            startSeconds: 0,
            text: "Peace",
            speaker,
          },
        ],
      },
    ],
  });
  query.mockResolvedValueOnce({ rows: [{ total: "1", stmt_total: "1" }] });
  const result = await queryVideos({
    q: "peace",
    contentSearch: { language: "en" },
  });
  expect(result.contentMatches?.a1.hits[0].speaker).toEqual(expected);
});
