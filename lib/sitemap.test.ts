import { afterEach, expect, it, vi } from "vitest";
vi.mock("./db", () => ({ getSitemapMeetingLanguages: vi.fn() }));
vi.mock("./get-base-url", () => ({
  getBaseUrl: async () => "https://transcripts.un.org",
}));
import { getSitemapMeetingLanguages } from "./db";
import sitemap from "../app/sitemap";
import { MEETING_HTML_UPDATED_AT } from "./meeting-freshness";

afterEach(() => vi.restoreAllMocks());
it("keeps truthful, stable dates for HTML and text across unordered transcript versions", async () => {
  const row = {
    asset_id: "asset",
    pv_symbol: "S/PV.1",
    pv_part: 1,
    languageCode: "en",
  };
  vi.mocked(getSitemapMeetingLanguages).mockResolvedValue([
    { ...row, lastModified: new Date("2026-10-16") },
    { ...row, lastModified: new Date("2026-10-15") },
    { ...row, languageCode: "fr", lastModified: new Date("2026-10-29") },
  ]);
  const first = await sitemap();
  const find = (path: string) =>
    first.find((entry) => entry.url.endsWith(path));
  expect(find("/en/sc/1")?.lastModified).toEqual(MEETING_HTML_UPDATED_AT);
  expect(find("/en/sc/1.txt")?.lastModified).toEqual(new Date("2026-10-16"));
  expect(find("/fr/sc/1")?.lastModified).toEqual(new Date("2026-10-29"));
  expect(find("/en/about")?.lastModified).toBeUndefined();
  expect(find("/en/sc/1")?.alternates?.languages).not.toHaveProperty("es");
  expect(first.filter((entry) => entry.url.endsWith("/en/sc/1"))).toHaveLength(
    1,
  );
  expect(await sitemap()).toEqual(first);
});
