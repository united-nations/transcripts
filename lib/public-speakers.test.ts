import { describe, expect, it } from "vitest";
import { publicSpeakerInfo, publicSpeakerMapping } from "./public-speakers";
import { formatSpeakerInfo } from "./speakers";
import {
  buildSpeakerSegments,
  formatSpeakerText,
  formatTranscriptAsPlainText,
  formatTimecode,
} from "./transcript-formatting";
import { filterOffRecord } from "./off-record";
import type { SpeakerMapping } from "./db";

const mapping: SpeakerMapping = {
  "0": {
    name: "Alice",
    affiliation: "FRA",
    group: null,
    function: "Representative",
  },
  "1": {
    name: "Alice",
    affiliation: "FRA",
    group: null,
    function: "Representative",
  },
  "2": {
    name: "Bob",
    affiliation: "FRA",
    group: null,
    function: "Representative",
  },
  "3": {
    name: "Private person",
    affiliation: null,
    group: null,
    function: null,
    is_off_record: true,
  },
};
const statements = Object.keys(mapping).map((_, i) => ({
  start: i * 1000,
  end: (i + 1) * 1000,
  paragraphs: [
    {
      start: i * 1000,
      end: (i + 1) * 1000,
      sentences: [
        {
          text: i === 3 ? "Private remarks" : "Thank you, Alice.",
          start: i * 1000,
          end: (i + 1) * 1000,
        },
      ],
    },
  ],
}));

describe("public speaker attribution", () => {
  it("allowlists fields and omits inferred names and generic roles", () => {
    expect(publicSpeakerInfo(mapping["3"])).toEqual({
      affiliation: null,
      group: null,
      function: null,
    });
    expect(
      formatSpeakerInfo(mapping["0"], new Map([["FRA", "France"]])),
    ).toEqual({
      affiliation: "FRA",
      affiliation_full: "France",
      group: null,
      function: null,
    });
    expect(
      publicSpeakerInfo({ ...mapping["0"], function: "Chair" }).function,
    ).toBe("Chair");
  });

  it("preserves turn boundaries after filtering without exposing names or off-record content", () => {
    const visible = filterOffRecord(statements, mapping);
    const projected = publicSpeakerMapping(
      visible.speakerMappings,
      visible.statements.length,
    );
    expect(JSON.stringify(projected)).not.toMatch(
      /Alice|Bob|Private|is_off_record/,
    );
    const segments = buildSpeakerSegments(visible.statements, projected);
    expect(segments.map((s) => s.statementIndices)).toEqual([[0, 1], [2]]);
    expect(segments.map((s) => s.statementIndices)).toEqual(
      buildSpeakerSegments(visible.statements, visible.speakerMappings).map(
        (s) => s.statementIndices,
      ),
    );
    const text = formatTranscriptAsPlainText(
      segments,
      visible.statements,
      (i) => formatSpeakerText(i, projected, new Map([["FRA", "France"]])),
      formatTimecode,
    );
    expect(text).toContain("France [0:00]:");
    expect(text).toContain("France [0:02]:");
    expect(text).toContain("Thank you, Alice.");
    expect(text).not.toMatch(/Bob|Private/);
    expect(mapping["0"].name).toBe("Alice");
  });

  it("preserves missing mappings and name-only speaker boundaries", () => {
    const namesOnly = {
      "1": { ...mapping["0"], affiliation: null },
      "2": { ...mapping["2"], affiliation: null },
    };
    const projected = publicSpeakerMapping(namesOnly, 4);
    expect(
      buildSpeakerSegments(statements, projected).map(
        (s) => s.statementIndices,
      ),
    ).toEqual([[0], [1], [2], [3]]);
    expect(formatSpeakerText(1, projected, new Map())).toBe("Speaker 2");
  });
});
