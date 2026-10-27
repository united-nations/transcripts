import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";

let dir: string | undefined;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

it.each([
  ["an inserted gap", "asetpts=PTS+gte(T\\,2)/TB", 5, 4],
  ["accumulated small gaps", "asetpts=PTS*1.25", 5, 3.75],
  ["continuous audio", "anull", 4, 3],
])(
  "preserves playback timing for %s in the audio sent to STT",
  async (_label, timestamps, expectedDuration, expectedMarkerStart) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "speech-timeline-"));
    const source = path.join(dir, "source.m4a");
    const uploaded = path.join(dir, "uploaded.mp3");
    // A brief tone at sample-clock second 3 stands in for later speech. Checking
    // its position catches conversions that just append silence at the end.
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc=if(between(t\\,3\\,3.2)\\,0.5*sin(2*PI*440*t)\\,0):s=48000:d=4",
      "-af",
      timestamps,
      "-c:a",
      "aac",
      source,
    ]);
    vi.stubEnv("AZURE_SPEECH_ENDPOINT", "https://speech.example");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, options) => {
        const audio = options.body.get("audio") as Blob;
        fs.writeFileSync(uploaded, Buffer.from(await audio.arrayBuffer()));
        return new Response(JSON.stringify({ phrases: [] }));
      }),
    );
    const { azureLlmSpeech } = await import("./azure-llm-speech");
    const result = await azureLlmSpeech.transcribe("unused", {
      audioFilePath: source,
      language: "en",
    });
    const duration = Number(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          uploaded,
        ],
        { encoding: "utf8" },
      ).trim(),
    );
    expect(duration).toBeCloseTo(expectedDuration, 0);
    expect(result.durationMs).toBeCloseTo(duration * 1000, 0);
    const sampleRate = 8000;
    const pcm = execFileSync("ffmpeg", [
      "-v",
      "error",
      "-i",
      uploaded,
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "-f",
      "s16le",
      "pipe:1",
    ]);
    let markerStart: number | undefined;
    for (let offset = 0; offset < pcm.length; offset += 2) {
      if (Math.abs(pcm.readInt16LE(offset)) > 3000) {
        markerStart = offset / 2 / sampleRate;
        break;
      }
    }
    expect(markerStart).toBeDefined();
    // async=1 corrects accumulated timestamp error once it exceeds 0.1s.
    expect(Math.abs(markerStart! - expectedMarkerStart)).toBeLessThan(0.12);
  },
  20_000,
);
