#!/usr/bin/env tsx
// Read exported container JSONL logs, never production credentials or a live DB.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "Usage: pnpm exec tsx scripts/upstream-report.ts [logs.jsonl] [--since=ISO] [--until=ISO]\nOmit the file to read stdin. Defaults to the last seven days. Accepts plain log lines or JSONL Log_s/message envelopes.",
    );
    process.exit(0);
  }
  const option = (name: string) =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const until = option("until") ? Date.parse(option("until")!) : Date.now();
  const since = option("since")
    ? Date.parse(option("since")!)
    : until - 7 * 86400_000;
  if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until)
    throw new Error("Invalid report time range");
  const file = args.find((arg) => !arg.startsWith("--"));
  const groups = new Map<string, Record<string, number>>();
  const fingerprints = new Map<string, { at: number; hash: string }[]>();
  let first = Infinity,
    last = -Infinity;
  const lines = createInterface({
    input: file ? createReadStream(file) : process.stdin,
    crlfDelay: Infinity,
  });
  for await (let line of lines) {
    try {
      const envelope = JSON.parse(line);
      if (typeof envelope.Log_s === "string") line = envelope.Log_s;
      else if (typeof envelope.message === "string") line = envelope.message;
    } catch {
      /* A timestamp or container prefix may precede the JSON. */
    }
    const start = line.indexOf('{"type":"upstream"');
    if (start < 0) continue;
    try {
      const e = JSON.parse(line.slice(start));
      const at = Date.parse(e.at);
      if (!Number.isFinite(at) || at < since || at >= until) continue;
      first = Math.min(first, at);
      last = Math.max(last, at);
      const row = groups.get(e.purpose) ?? {};
      row[e.event] = (row[e.event] ?? 0) + 1;
      if (e.event === "network") {
        row.bytes = (row.bytes ?? 0) + (e.bytes ?? 0);
        row.failures =
          (row.failures ?? 0) +
          Number(e.failed === true || e.status >= 400 || e.status === 0);
        row[`http_${e.status}`] = (row[`http_${e.status}`] ?? 0) + 1;
      }
      if (e.event === "content") {
        const key = `${e.purpose}:${e.key}`;
        const observations = fingerprints.get(key) ?? [];
        const observedAt = Date.parse(e.observedAt);
        if (
          Number.isFinite(observedAt) &&
          observedAt >= since &&
          observedAt < until
        ) {
          observations.push({ at: observedAt, hash: e.fingerprint });
        }
        fingerprints.set(key, observations);
      }
      groups.set(e.purpose, row);
    } catch {
      /* Ignore unrelated or truncated log records. */
    }
  }
  for (const [key, observations] of fingerprints) {
    observations.sort((a, b) => a.at - b.at);
    const samples = observations.filter(
      (sample, index) =>
        index === 0 ||
        sample.at !== observations[index - 1].at ||
        sample.hash !== observations[index - 1].hash,
    );
    const row = groups.get(key.split(":")[0])!;
    for (let i = 1; i < samples.length; i++) {
      row.contentComparisons = (row.contentComparisons ?? 0) + 1;
      row.contentChanges =
        (row.contentChanges ?? 0) +
        Number(samples[i].hash !== samples[i - 1].hash);
    }
  }
  console.log(
    JSON.stringify(
      {
        requestedWindow: {
          since: new Date(since).toISOString(),
          until: new Date(until).toISOString(),
        },
        observedWindow: Number.isFinite(first)
          ? {
              first: new Date(first).toISOString(),
              last: new Date(last).toISOString(),
            }
          : null,
        note: "Network includes every retry; cache hits and coalescing are separate. Content changes compare distinct source snapshots, ordered by fetch time; repeated cached observations are deduplicated. This does not detect every upstream edit. Incomplete/duplicate exports and replica disagreement affect counts.",
        totalNetworkRequests: [...groups.values()].reduce(
          (sum, row) => sum + (row.network ?? 0),
          0,
        ),
        purposes: Object.fromEntries(
          [...groups].sort().map(([purpose, counts]) => [
            purpose,
            {
              ...counts,
              requestsPerDay: Number(
                ((counts.network ?? 0) / ((until - since) / 86400_000)).toFixed(
                  2,
                ),
              ),
              requestsPerHour: Number(
                ((counts.network ?? 0) / ((until - since) / 3600_000)).toFixed(
                  2,
                ),
              ),
              cacheHitFraction: counts.cache_lookup
                ? (counts.cache_hit ?? 0) / counts.cache_lookup
                : null,
            },
          ]),
        ),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
