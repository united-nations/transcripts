import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  extractMetadataFromTitle,
  cleanTitle,
  calculateStatus,
  decodeEventCode,
  videoToRecord,
  parseVideoMetadata,
  stripTags,
  type Video,
} from "@/lib/un-api";

interface VideoFixture {
  id: string;
  title: string;
  category: string;
  date: string;
  duration: string;
  scheduledTime: string | null;
  expected: {
    eventCode: string | null;
    eventType: string | null;
    body: string | null;
    sessionNumber: string | null;
    cleanTitle: string;
    pvSymbol: string | null;
    statusWhenFinished: "finished" | "live" | "scheduled";
  };
}

const fixtures: VideoFixture[] = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "videos.sample.json"), "utf8"),
);

describe("title metadata extraction (real UN video titles)", () => {
  it("has a diverse sample", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(20);
    const bodies = new Set(fixtures.map((f) => f.expected.body));
    // Several distinct bodies + the no-body (event) case.
    expect(bodies.size).toBeGreaterThanOrEqual(8);
  });

  it.each(fixtures)("reproduces stored metadata for $title", (fx) => {
    const meta = extractMetadataFromTitle(fx.title, fx.category);
    expect(meta).toEqual({
      eventCode: fx.expected.eventCode,
      eventType: fx.expected.eventType,
      body: fx.expected.body,
      sessionNumber: fx.expected.sessionNumber,
    });
    expect(cleanTitle(fx.title, meta)).toBe(fx.expected.cleanTitle);
  });
});

describe("videoToRecord (real rows)", () => {
  function toVideo(fx: VideoFixture): Video {
    return {
      id: fx.id,
      url: `https://webtv.un.org/en/asset/${fx.id}`,
      title: fx.title,
      cleanTitle: fx.expected.cleanTitle,
      category: fx.category,
      duration: fx.duration,
      date: fx.date,
      scheduledTime: fx.scheduledTime,
      status: "finished",
      eventCode: fx.expected.eventCode,
      eventType: fx.expected.eventType,
      body: fx.expected.body,
      sessionNumber: fx.expected.sessionNumber,
      pvSymbol: fx.expected.pvSymbol,
      pvPart: null,
      pvAvailable: false,
      slug: "",
      hasTranscript: false,
      hasTranscriptInLocale: false,
      i18n: {},
    };
  }

  it.each(fixtures)("derives pv_symbol, kaltura_id, duration for $id", (fx) => {
    const rec = videoToRecord(toVideo(fx));
    expect(rec.pv_symbol).toBe(fx.expected.pvSymbol);
    expect(rec.asset_id).toBe(fx.id);
    expect(rec.kaltura_id).toMatch(/^1_[a-z0-9]+$/i);
    // Duration "HH:MM:SS" → seconds.
    if (fx.duration.includes(":")) {
      const [h, m, s] = fx.duration.split(":").map(Number);
      expect(rec.duration).toBe(h * 3600 + m * 60 + s);
    }
  });
});

describe("calculateStatus", () => {
  it("is 'finished' with no scheduled time", () => {
    expect(calculateStatus(null, "01:00:00")).toBe("finished");
  });

  it("is 'scheduled' before start and 'finished' well after end", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const longAgo = new Date(Date.now() - 30 * 60 * 60 * 1000);
    expect(calculateStatus(future, "01:00:00")).toBe("scheduled");
    expect(calculateStatus(longAgo, "01:00:00")).toBe("finished");
  });

  it("is 'live' while within the meeting window", () => {
    const startedAgo = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
    expect(calculateStatus(startedAgo, "02:00:00")).toBe("live");
  });
});

describe("decodeEventCode", () => {
  it("maps known prefixes and falls back for unknown", () => {
    expect(decodeEventCode("GO16")).toBe("Global Occasion");
    expect(decodeEventCode("EM07")).toBe("Event - Ministerial");
    expect(decodeEventCode("ZZ99")).toBe("Event ZZ99");
  });
});

const webtvFixture = (name: string) =>
  readFileSync(
    join(__dirname, "__fixtures__", "webtv", `${name}.html`),
    "utf8",
  );

describe("parseVideoMetadata (real WebTV asset markup)", () => {
  it("extracts related documents whose anchors carry attributes after href", () => {
    // Regression: the old regex required `<a href="...">` with the closing
    // bracket right after the href, so `target="_blank"` made every asset
    // return zero related documents.
    const { relatedDocuments } = parseVideoMetadata(webtvFixture("c24"));

    expect(relatedDocuments).toEqual([
      {
        title: "Special Committee on Decolonization website",
        url: "https://www.un.org/dppa/decolonization/en/c24/about",
      },
      {
        title: "Organization of Work",
        url: "https://docs.un.org/A/AC.109/2026/L.2/Rev.1",
      },
    ]);
  });

  it("keeps block boundaries in the description instead of running them together", () => {
    const { description } = parseVideoMetadata(webtvFixture("hlpf"));

    // The two leading <li> items must not fuse into one sentence.
    expect(description).not.toContain("Production Patterns SDG 9");
    expect(description).toContain("Production Patterns\nSDG 9");
    expect(description).toContain("SDG 6 - Ensure availability");
  });

  it("reads the full category path, topical subjects and corporate name", () => {
    const metadata = parseVideoMetadata(webtvFixture("c24"));

    expect(metadata.categories).toEqual([
      "Meetings & Events",
      "General Assembly",
      "Subsidiary organs of the General Assembly",
      "Special Committee on Decolonization (C-24)",
      "2026 Session",
    ]);
    expect(metadata.subjectTopical).toEqual([
      "DECOLONIZATION",
      "NON-SELF-GOVERNING TERRITORIES",
      "SOVEREIGNTY",
    ]);
    expect(metadata.corporateName).toEqual([
      "SPECIAL COMMITTEE ON DECOLONIZATION - C24",
    ]);
    expect(metadata.summary).toMatch(/^The Special Committee on the Situation/);
  });

  it("returns empty metadata for an asset with no metadata block", () => {
    const html = webtvFixture("no-metadata");
    const metadata = parseVideoMetadata(html);

    expect(metadata.summary).toBeNull();
    expect(metadata.description).toBeNull();
    expect(metadata.categories).toEqual([]);
    expect(metadata.relatedDocuments).toEqual([]);
    expect(metadata.subjectTopical).toEqual([]);

    // getVideoMetadata distinguishes this from markup drift by the absence of
    // any `field__label`; keep that assumption honest.
    expect(html).not.toContain("field__label");
  });
});

describe("stripTags", () => {
  it("strips ordinary tags from real markup", () => {
    expect(stripTags("<p>Security <strong>Council</strong></p>")).toBe(
      "Security Council",
    );
  });

  it("leaves tag-free text untouched", () => {
    expect(stripTags("Human Rights Council, 58th session")).toBe(
      "Human Rights Council, 58th session",
    );
  });

  it("leaves no complete tag in the output, even for nested/malformed markup", () => {
    // The security invariant CodeQL wants (js/incomplete-multi-character-
    // sanitization): after stripping, nothing matching `<…>` may remain — so a
    // tag can't be reconstructed by the removal of an inner one. (Dangling `<`
    // or `>` without a partner is not a tag and may remain.)
    for (const input of [
      "<scr<x>ipt>alert(1)</scr<x>ipt>",
      "<<div>script>evil</<div>script>",
      "a<b<c>d>e",
      "<img src=x onerror=alert(1)>",
    ]) {
      expect(stripTags(input)).not.toMatch(/<[^>]*>/);
    }
  });
});
