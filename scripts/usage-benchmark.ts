#!/usr/bin/env tsx
import "../lib/load-env";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { pool, q } from "../lib/db";
import {
  getAnalysisModel,
  getAnalysisModelMini,
} from "../lib/providers/models";
import { PROVIDER_PRICING } from "../lib/providers/pricing";

const sinceArg = process.argv.find((arg) => arg.startsWith("--since="));
const since = sinceArg ? sinceArg.slice("--since=".length).trim() : null;

if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error("Invalid --since format. Use YYYY-MM-DD.");
  process.exit(1);
}

function openaiPricing(model: string) {
  const p = PROVIDER_PRICING[`openai/${model}`];
  if (!p || p.kind !== "tokens")
    throw new Error(`No token pricing for openai/${model}`);
  return p;
}

function assumedModelForStage(stage: string): string {
  return stage === "tagging_sentences"
    ? getAnalysisModelMini()
    : getAnalysisModel();
}

type MetadataRow = {
  body: string | null;
  date: string | null;
  duration: string | null;
};

function parseDurationHours(duration: string | null): number {
  if (!duration) return 0;
  const m = duration.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (!m) return 0;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  return hours + minutes / 60 + seconds / 3600;
}

async function loadHoursPerDayByBody(): Promise<Map<string, number>> {
  const filePath = path.join(process.cwd(), "analysis", "video-metadata.json");
  const raw = await readFile(filePath, "utf8");
  const rows = JSON.parse(raw) as MetadataRow[];

  const hoursByDateBody = new Map<string, number>();
  for (const row of rows) {
    const bodyKey = row.body ?? "NaN";
    const dateKey = row.date ?? "NaN";
    const key = `${dateKey}||${bodyKey}`;
    const next =
      (hoursByDateBody.get(key) ?? 0) + parseDurationHours(row.duration);
    hoursByDateBody.set(key, next);
  }

  const bodyAgg = new Map<string, { total: number; days: number }>();
  for (const [dateBody, hours] of hoursByDateBody.entries()) {
    const body = dateBody.split("||")[1];
    const current = bodyAgg.get(body) ?? { total: 0, days: 0 };
    current.total += hours;
    current.days += 1;
    bodyAgg.set(body, current);
  }

  const hoursPerDayByBody = new Map<string, number>();
  for (const [body, agg] of bodyAgg.entries()) {
    const avg = agg.days > 0 ? agg.total / agg.days : 0;
    hoursPerDayByBody.set(body, avg);
  }
  return hoursPerDayByBody;
}

async function run() {
  const sincePredicate = since ? `AND created_at >= $1` : "";
  const queryArgs = since ? [since] : [];

  const overallResult = await pool.query({
    text: `
      WITH transcription_per_transcript AS (
        SELECT
          transcript_id,
          MAX(usage_hours) AS usage_hours,
          MAX(usage_seconds) AS usage_seconds
        FROM processing_usage_events
        WHERE provider IN ('gemini', 'assemblyai', 'azure-openai', 'alibaba')
          AND usage_hours IS NOT NULL
          ${sincePredicate}
        GROUP BY transcript_id
      ),
      openai_per_transcript AS (
        SELECT
          transcript_id,
          SUM(COALESCE(input_tokens, 0)) AS input_tokens,
          SUM(COALESCE(output_tokens, 0)) AS output_tokens,
          SUM(COALESCE(reasoning_tokens, 0)) AS reasoning_tokens,
          SUM(COALESCE(cached_input_tokens, 0)) AS cached_input_tokens,
          SUM(COALESCE(total_tokens, 0)) AS total_tokens
        FROM processing_usage_events
        WHERE provider = 'openai'
          AND status = 'success'
          ${sincePredicate}
        GROUP BY transcript_id
      ),
      matched AS (
        SELECT
          a.transcript_id,
          a.usage_hours,
          a.usage_seconds,
          COALESCE(o.input_tokens, 0) AS input_tokens,
          COALESCE(o.output_tokens, 0) AS output_tokens,
          COALESCE(o.reasoning_tokens, 0) AS reasoning_tokens,
          COALESCE(o.cached_input_tokens, 0) AS cached_input_tokens,
          COALESCE(o.total_tokens, 0) AS total_tokens
        FROM transcription_per_transcript a
        LEFT JOIN openai_per_transcript o ON o.transcript_id = a.transcript_id
        WHERE a.usage_hours > 0
          AND COALESCE(o.total_tokens, 0) > 0
      )
      SELECT
        COUNT(*) AS transcripts,
        COALESCE(SUM(usage_hours), 0) AS total_hours,
        COALESCE(SUM(usage_seconds), 0) AS total_seconds,
        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(reasoning_tokens), 0) AS total_reasoning_tokens,
        COALESCE(SUM(cached_input_tokens), 0) AS total_cached_input_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        CASE WHEN COALESCE(SUM(usage_hours), 0) > 0 THEN COALESCE(SUM(input_tokens), 0) / SUM(usage_hours) ELSE 0 END AS input_tokens_per_hour,
        CASE WHEN COALESCE(SUM(usage_hours), 0) > 0 THEN COALESCE(SUM(output_tokens), 0) / SUM(usage_hours) ELSE 0 END AS output_tokens_per_hour,
        CASE WHEN COALESCE(SUM(usage_hours), 0) > 0 THEN COALESCE(SUM(reasoning_tokens), 0) / SUM(usage_hours) ELSE 0 END AS reasoning_tokens_per_hour,
        CASE WHEN COALESCE(SUM(usage_hours), 0) > 0 THEN COALESCE(SUM(cached_input_tokens), 0) / SUM(usage_hours) ELSE 0 END AS cached_input_tokens_per_hour,
        CASE WHEN COALESCE(SUM(usage_hours), 0) > 0 THEN COALESCE(SUM(total_tokens), 0) / SUM(usage_hours) ELSE 0 END AS total_tokens_per_hour
      FROM matched
    `,
    values: queryArgs,
  });

  const row = overallResult.rows[0];
  const transcripts = Number(row?.transcripts ?? 0);

  if (transcripts === 0) {
    if (since) {
      console.log(`No benchmarkable transcripts found since ${since}.`);
    } else {
      console.log("No benchmarkable transcripts found.");
    }
    return;
  }

  const summary = {
    transcripts,
    total_hours: Number(Number(row.total_hours).toFixed(6)),
    total_seconds: Number(row.total_seconds),
    total_input_tokens: Number(row.total_input_tokens),
    total_output_tokens: Number(row.total_output_tokens),
    total_reasoning_tokens: Number(row.total_reasoning_tokens),
    total_cached_input_tokens: Number(row.total_cached_input_tokens),
    total_tokens: Number(row.total_tokens),
    input_tokens_per_hour: Number(Number(row.input_tokens_per_hour).toFixed(2)),
    output_tokens_per_hour: Number(
      Number(row.output_tokens_per_hour).toFixed(2),
    ),
    reasoning_tokens_per_hour: Number(
      Number(row.reasoning_tokens_per_hour).toFixed(2),
    ),
    cached_input_tokens_per_hour: Number(
      Number(row.cached_input_tokens_per_hour).toFixed(2),
    ),
    total_tokens_per_hour: Number(Number(row.total_tokens_per_hour).toFixed(2)),
  };

  console.log("Cross-transcript token/hour benchmark");
  if (since) {
    console.log(`Window: events since ${since}`);
  }
  console.table([summary]);

  const stageResult = await pool.query({
    text: `
      WITH transcription_per_transcript AS (
        SELECT
          transcript_id,
          MAX(usage_hours) AS usage_hours
        FROM processing_usage_events
        WHERE provider IN ('gemini', 'assemblyai', 'azure-openai', 'alibaba')
          AND usage_hours IS NOT NULL
          ${sincePredicate}
        GROUP BY transcript_id
      ),
      openai_per_transcript AS (
        SELECT
          transcript_id,
          SUM(COALESCE(total_tokens, 0)) AS total_tokens
        FROM processing_usage_events
        WHERE provider = 'openai'
          AND status = 'success'
          ${sincePredicate}
        GROUP BY transcript_id
      ),
      eligible_transcripts AS (
        SELECT a.transcript_id, a.usage_hours
        FROM transcription_per_transcript a
        LEFT JOIN openai_per_transcript o ON o.transcript_id = a.transcript_id
        WHERE a.usage_hours > 0
          AND COALESCE(o.total_tokens, 0) > 0
      ),
      total_hours AS (
        SELECT COALESCE(SUM(usage_hours), 0) AS hours
        FROM eligible_transcripts
      ),
      openai_by_stage AS (
        SELECT
          e.stage,
          e.transcript_id,
          SUM(COALESCE(e.input_tokens, 0)) AS input_tokens,
          SUM(COALESCE(e.output_tokens, 0)) AS output_tokens,
          SUM(COALESCE(e.reasoning_tokens, 0)) AS reasoning_tokens,
          SUM(COALESCE(e.cached_input_tokens, 0)) AS cached_input_tokens,
          SUM(COALESCE((e.pricing_meta->>'cache_write_input_tokens')::numeric, 0)) AS cache_write_input_tokens,
          SUM(COALESCE(e.total_tokens, 0)) AS total_tokens
        FROM processing_usage_events e
        INNER JOIN eligible_transcripts a ON a.transcript_id = e.transcript_id
        WHERE e.provider = 'openai'
          AND e.status = 'success'
          ${sincePredicate}
        GROUP BY e.stage, e.transcript_id
      )
      SELECT
        s.stage,
        COUNT(DISTINCT s.transcript_id) AS transcripts,
        COALESCE(SUM(s.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(s.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(s.reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(SUM(s.total_tokens), 0) AS total_tokens,
        CASE WHEN t.hours > 0 THEN COALESCE(SUM(s.input_tokens), 0) / t.hours ELSE 0 END AS input_tokens_per_hour,
        CASE WHEN t.hours > 0 THEN COALESCE(SUM(s.output_tokens), 0) / t.hours ELSE 0 END AS output_tokens_per_hour,
        CASE WHEN t.hours > 0 THEN COALESCE(SUM(s.reasoning_tokens), 0) / t.hours ELSE 0 END AS reasoning_tokens_per_hour,
        CASE WHEN t.hours > 0 THEN COALESCE(SUM(s.cached_input_tokens), 0) / t.hours ELSE 0 END AS cached_input_tokens_per_hour,
        CASE WHEN t.hours > 0 THEN COALESCE(SUM(s.cache_write_input_tokens), 0) / t.hours ELSE 0 END AS cache_write_input_tokens_per_hour,
        CASE WHEN t.hours > 0 THEN COALESCE(SUM(s.total_tokens), 0) / t.hours ELSE 0 END AS total_tokens_per_hour
      FROM openai_by_stage s
      CROSS JOIN total_hours t
      GROUP BY s.stage, t.hours
      ORDER BY total_tokens_per_hour DESC
    `,
    values: queryArgs,
  });

  console.log(
    "\nOpenAI stage breakdown (tokens/hour over same total transcribed hours)",
  );
  const stageRows = stageResult.rows.map((stage) => ({
    stage: stage.stage,
    transcripts: Number(stage.transcripts),
    input_tokens: Number(stage.input_tokens),
    output_tokens: Number(stage.output_tokens),
    reasoning_tokens: Number(stage.reasoning_tokens),
    total_tokens: Number(stage.total_tokens),
    input_tokens_per_hour: Number(
      Number(stage.input_tokens_per_hour).toFixed(2),
    ),
    output_tokens_per_hour: Number(
      Number(stage.output_tokens_per_hour).toFixed(2),
    ),
    reasoning_tokens_per_hour: Number(
      Number(stage.reasoning_tokens_per_hour).toFixed(2),
    ),
    cache_write_input_tokens_per_hour: Number(
      stage.cache_write_input_tokens_per_hour,
    ),
    cached_input_tokens_per_hour: Number(
      Number(stage.cached_input_tokens_per_hour).toFixed(2),
    ),
    total_tokens_per_hour: Number(
      Number(stage.total_tokens_per_hour).toFixed(2),
    ),
  }));
  console.table(stageRows);

  console.log(
    "Projection uses short-context rates and observed token counts; model token usage and long-context request premiums may differ.",
  );
  let openaiCostPerHour = 0;
  const projectedRows = stageRows.map((stage) => {
    const model = assumedModelForStage(String(stage.stage));
    const pricing = openaiPricing(model);
    const uncachedInput = Math.max(
      0,
      stage.input_tokens_per_hour -
        stage.cached_input_tokens_per_hour -
        stage.cache_write_input_tokens_per_hour,
    );
    const hourlyCost =
      (uncachedInput * pricing.inputPerM) / 1_000_000 +
      (stage.cached_input_tokens_per_hour *
        (pricing.cachedInputPerM ?? pricing.inputPerM)) /
        1_000_000 +
      (stage.cache_write_input_tokens_per_hour *
        (pricing.cacheWriteInputPerM ?? pricing.inputPerM)) /
        1_000_000 +
      (stage.output_tokens_per_hour * pricing.outputPerM) / 1_000_000;
    openaiCostPerHour += hourlyCost;
    return {
      stage: stage.stage,
      assumed_model: model,
      input_tokens_per_hour: stage.input_tokens_per_hour,
      cached_input_tokens_per_hour: stage.cached_input_tokens_per_hour,
      cache_write_input_tokens_per_hour:
        stage.cache_write_input_tokens_per_hour,
      output_tokens_per_hour: stage.output_tokens_per_hour,
      hourly_cost_usd: Number(hourlyCost.toFixed(4)),
    };
  });

  console.log(
    "\nOpenAI projected hourly cost by stage (assumed future model mapping)",
  );
  console.table(projectedRows);

  const perVideoResult = await pool.query({
    text: `
      WITH transcription_per_transcript AS (
        SELECT
          transcript_id,
          MAX(usage_hours) AS usage_hours,
          MAX(usage_seconds) AS usage_seconds
        FROM processing_usage_events
        WHERE provider IN ('gemini', 'assemblyai', 'azure-openai', 'alibaba')
          AND usage_hours IS NOT NULL
          ${sincePredicate}
        GROUP BY transcript_id
      ),
      openai_per_transcript AS (
        SELECT
          transcript_id,
          SUM(COALESCE(input_tokens, 0)) AS input_tokens,
          SUM(COALESCE(output_tokens, 0)) AS output_tokens,
          SUM(COALESCE(reasoning_tokens, 0)) AS reasoning_tokens,
          SUM(COALESCE(cached_input_tokens, 0)) AS cached_input_tokens,
          SUM(COALESCE(total_tokens, 0)) AS total_tokens
        FROM processing_usage_events
        WHERE provider = 'openai'
          AND status = 'success'
          ${sincePredicate}
        GROUP BY transcript_id
      )
      SELECT
        a.transcript_id,
        COALESCE(t.entry_id, '') AS entry_id,
        a.usage_hours,
        a.usage_seconds,
        COALESCE(o.input_tokens, 0) AS input_tokens,
        COALESCE(o.output_tokens, 0) AS output_tokens,
        COALESCE(o.reasoning_tokens, 0) AS reasoning_tokens,
        COALESCE(o.cached_input_tokens, 0) AS cached_input_tokens,
        COALESCE(o.total_tokens, 0) AS total_tokens,
        CASE WHEN a.usage_hours > 0 THEN COALESCE(o.input_tokens, 0) / a.usage_hours ELSE 0 END AS input_tokens_per_hour,
        CASE WHEN a.usage_hours > 0 THEN COALESCE(o.output_tokens, 0) / a.usage_hours ELSE 0 END AS output_tokens_per_hour,
        CASE WHEN a.usage_hours > 0 THEN COALESCE(o.reasoning_tokens, 0) / a.usage_hours ELSE 0 END AS reasoning_tokens_per_hour,
        CASE WHEN a.usage_hours > 0 THEN COALESCE(o.cached_input_tokens, 0) / a.usage_hours ELSE 0 END AS cached_input_tokens_per_hour,
        CASE WHEN a.usage_hours > 0 THEN COALESCE(o.total_tokens, 0) / a.usage_hours ELSE 0 END AS total_tokens_per_hour
      FROM transcription_per_transcript a
      LEFT JOIN openai_per_transcript o ON o.transcript_id = a.transcript_id
      LEFT JOIN transcripts t ON t.transcript_id = a.transcript_id
      WHERE a.usage_hours > 0
      ORDER BY total_tokens_per_hour DESC
    `,
    values: queryArgs,
  });

  console.log("\nPer-video variation (no stage breakdown)");
  console.table(
    perVideoResult.rows.map((video) => ({
      transcript_id: video.transcript_id,
      entry_id: video.entry_id,
      usage_hours: Number(Number(video.usage_hours).toFixed(6)),
      usage_seconds: Number(video.usage_seconds),
      input_tokens: Number(video.input_tokens),
      output_tokens: Number(video.output_tokens),
      reasoning_tokens: Number(video.reasoning_tokens),
      cached_input_tokens: Number(video.cached_input_tokens),
      total_tokens: Number(video.total_tokens),
      input_tokens_per_hour: Number(
        Number(video.input_tokens_per_hour).toFixed(2),
      ),
      output_tokens_per_hour: Number(
        Number(video.output_tokens_per_hour).toFixed(2),
      ),
      reasoning_tokens_per_hour: Number(
        Number(video.reasoning_tokens_per_hour).toFixed(2),
      ),
      cached_input_tokens_per_hour: Number(
        Number(video.cached_input_tokens_per_hour).toFixed(2),
      ),
      total_tokens_per_hour: Number(
        Number(video.total_tokens_per_hour).toFixed(2),
      ),
    })),
  );

  let hoursPerDayByBody: Map<string, number>;
  try {
    hoursPerDayByBody = await loadHoursPerDayByBody();
  } catch (error) {
    console.warn(
      `\nSkipping yearly cost estimate: failed to read analysis/video-metadata.json (${error instanceof Error ? error.message : error})`,
    );
    return;
  }

  const yearlyRows: Array<{
    body: string;
    hours_per_day: number;
    openai_cost_per_day: number;
    openai_cost_per_year: number;
  }> = [];

  for (const [body, hoursPerDay] of hoursPerDayByBody.entries()) {
    const openaiCostDay = hoursPerDay * openaiCostPerHour;
    yearlyRows.push({
      body,
      hours_per_day: Number(hoursPerDay.toFixed(2)),
      openai_cost_per_day: Number(openaiCostDay.toFixed(2)),
      openai_cost_per_year: Number((openaiCostDay * 365).toFixed(2)),
    });
  }

  yearlyRows.sort((a, b) => a.body.localeCompare(b.body));

  const totals = yearlyRows.reduce(
    (acc, rowBody) => {
      acc.hours_per_day += rowBody.hours_per_day;
      acc.openai_cost_per_day += rowBody.openai_cost_per_day;
      acc.openai_cost_per_year += rowBody.openai_cost_per_year;
      return acc;
    },
    {
      body: "Total",
      hours_per_day: 0,
      openai_cost_per_day: 0,
      openai_cost_per_year: 0,
    },
  );

  yearlyRows.push({
    ...totals,
    hours_per_day: Number(totals.hours_per_day.toFixed(2)),
    openai_cost_per_day: Number(totals.openai_cost_per_day.toFixed(2)),
    openai_cost_per_year: Number(totals.openai_cost_per_year.toFixed(2)),
  });

  console.log(
    "\nYearly cost estimate by body (metadata average hours/day + assumed stage-to-model mapping)",
  );
  console.table(yearlyRows);
}

run().catch((error) => {
  console.error("usage-benchmark failed:", error);
  process.exit(1);
});
