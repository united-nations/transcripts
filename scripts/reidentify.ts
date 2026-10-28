#!/usr/bin/env tsx
import "../lib/load-env";
import { identifySpeakers, ParagraphInput } from "../lib/pipeline";
import { pool, q } from "../lib/db";
import { notifyIndexNowByTranscriptId } from "../lib/indexnow-transcript";
import { resolveEntryId as resolveEntryIdHelper } from "../lib/kaltura-helpers";

const usage = `Usage:
  pnpm reidentify -- <asset|entry-id>
  pnpm reidentify -- all`;

// npm consumes the `--` separator, pnpm forwards it verbatim. Drop it so the
// documented `pnpm reidentify -- <id>` form doesn't parse `--` as the target.
const parsedArg = process.argv.slice(2).find((arg) => arg !== "--");

if (!parsedArg) {
  console.error(usage);
  process.exit(1);
}

const rawArg: string = parsedArg;

type TranscriptRow = {
  transcript_id: string;
  entry_id: string;
  content: string;
};

const SINGLE_QUERY = `
  SELECT transcript_id, entry_id, content
  FROM webtv.transcripts
  WHERE entry_id = ?
    AND transcription_status = 'completed'
    AND start_time IS NULL
    AND end_time IS NULL
  ORDER BY updated_at DESC
  LIMIT 1
`;

const ALL_QUERY = `
  SELECT transcript_id, entry_id, content
  FROM webtv.transcripts
  WHERE transcription_status = 'completed'
    AND start_time IS NULL
    AND end_time IS NULL
  ORDER BY updated_at DESC
`;

async function resolveEntryId(input: string) {
  const decoded = decodeURIComponent(input.trim());
  if (!decoded) throw new Error("Empty id");

  // Use centralized helper that checks cache first
  const entryId = await resolveEntryIdHelper(decoded);
  if (!entryId) throw new Error(`Unable to resolve entry ID for: ${input}`);

  return entryId;
}

function parseParagraphs(row: TranscriptRow) {
  const content =
    typeof row.content === "string" ? JSON.parse(row.content) : row.content;
  // Try raw_paragraphs first (new schema), fall back to paragraphs (old schema)
  return (content?.raw_paragraphs ||
    content?.paragraphs ||
    []) as ParagraphInput[];
}

async function loadTargets(arg: string) {
  if (arg.toLowerCase() === "all") {
    const result = await pool.query(
      "SELECT DISTINCT entry_id FROM webtv.transcripts WHERE transcription_status = 'completed' AND start_time IS NULL AND end_time IS NULL",
    );
    return result.rows.map((row) => row.entry_id as string);
  }
  return [await resolveEntryId(arg)];
}

async function loadTranscripts(entryId: string) {
  const query = entryId === "*ALL*" ? ALL_QUERY : SINGLE_QUERY;
  const args = entryId === "*ALL*" ? [] : [entryId];
  const result = await pool.query(q(query, args));
  return result.rows.map((row) => ({
    transcript_id: row.transcript_id as string,
    entry_id: row.entry_id as string,
    content: row.content as string,
  }));
}

async function run() {
  const targets =
    rawArg.toLowerCase() === "all" ? ["*ALL*"] : await loadTargets(rawArg);

  console.log(`Loading transcripts...`);
  const allTranscripts = (
    await Promise.all(targets.map(loadTranscripts))
  ).flat();

  const toProcess = allTranscripts
    .map((row) => ({ row, paragraphs: parseParagraphs(row) }))
    .filter(({ row, paragraphs }) => {
      if (!paragraphs.length) {
        console.warn(`Skipping ${row.transcript_id}: no paragraphs`);
        return false;
      }
      return true;
    });

  const total = toProcess.length;
  console.log(`Processing ${total} transcript(s)...\n`);

  let completed = 0;
  const tasks = toProcess.map(async ({ row, paragraphs }) => {
    await identifySpeakers(paragraphs, row.transcript_id, undefined);
    await notifyIndexNowByTranscriptId(row.transcript_id);
    completed++;
    console.log(
      `[${completed}/${total}] ✓ Re-identified ${row.entry_id} (${row.transcript_id})`,
    );
  });

  await Promise.all(tasks);
  console.log(`\nDone. Updated ${total} transcript(s).`);
  process.exit(0);
}

run().catch((error) => {
  console.error("Reidentify failed:", error);
  process.exit(1);
});
