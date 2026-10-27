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
  ["an inserted gap", "asetpts=PTS+gte(T\\,2)/TB"],
  ["accumulated small gaps", "asetpts=PTS*1.25"],
])(
  "preserves %s in the audio sent to STT",
  async (_label, timestamps) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "speech-timeline-"));
    const source = path.join(dir, "source.m4a");
    const uploaded = path.join(dir, "uploaded.mp3");
    // Four seconds of samples on a five-second playback timeline. Plain MP3
    // conversion collapses either kind of gap, shifting later speech.
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=4",
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
    expect(duration).toBeCloseTo(5, 0);
    expect(result.durationMs).toBeCloseTo(duration * 1000, 0);
  },
  20_000,
);
