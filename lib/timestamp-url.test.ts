import { describe, expect, it } from "vitest";
import {
  formatTimestamp,
  parseTimestamp,
  serializeMeetingParams,
} from "./timestamp-url";

describe("timestamp URLs", () => {
  it.each([
    ["230", 230],
    ["3:50", 230],
    ["4:15:59", 15359],
    ["0:00", 0],
    ["0", 0],
    ["90.9", 90],
    ["90:00", 5400],
  ])("parses %s", (value, seconds) => {
    expect(parseTimestamp(value)).toBe(seconds);
  });
  it.each([
    null,
    "",
    "-1",
    "NaN",
    "Infinity",
    "3:60",
    "4:60:00",
    "3:5",
    "1:2:3:4",
    "90s",
    "0x10",
    "9007199254740992",
  ])("ignores invalid %s", (value) => {
    expect(parseTimestamp(value)).toBeNull();
  });
  it.each([
    [0, "0:00"],
    [230, "3:50"],
    [15359, "4:15:59"],
    [3599.1, "1:00:00"],
    [230.1, "3:51"],
  ])("formats %s", (seconds, value) => {
    expect(formatTimestamp(seconds)).toBe(value);
    expect(parseTimestamp(value)).toBe(Math.ceil(seconds));
  });
  it("preserves escaping except for timestamp colons", () => {
    const params = new URLSearchParams({
      topic: "risk & peace",
      t: "3:50",
      lang: "fr",
    });
    expect(serializeMeetingParams(params)).toBe(
      "topic=risk+%26+peace&t=3:50&lang=fr",
    );
  });
});
