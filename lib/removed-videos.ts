import {
  fetchKalturaEntryStatuses,
  KALTURA_STATUS_DELETED,
} from "./kaltura-helpers";
import {
  getRemovalCandidates,
  type RemovalScope,
  markVideoRemoved,
  clearVideoRemoved,
} from "./db";
import { fetchAssetPage } from "./un-api";

// ── Shared removal core ──────────────────────────────────────────────────────
// One vocabulary and one writer, reused by both detectors: the lazy check on
// the detail-page render and the periodic reaper. Each keeps its own fetching
// (single vs batched) but funnels the verdict through `applyRemoval`.

/** Upstream liveness for one source. `unknown` = ambiguous → never act. */
export type Liveness = "gone" | "live" | "unknown";

/** WebTV asset-page HTTP status → liveness. Only an explicit 404 is "gone". */
export function classifyWebtv(status: number): Liveness {
  if (status === 404) return "gone";
  if (status >= 200 && status < 300) return "live";
  return "unknown"; // 403/5xx, or 0 for a network error
}

/** Kaltura entry status → liveness. `undefined` = entry not returned. */
export function classifyKaltura(status: number | undefined): Liveness {
  if (status === KALTURA_STATUS_DELETED) return "gone";
  if (status === undefined) return "unknown";
  return "live";
}

/** Probe a single asset's WebTV liveness (used by the reaper, one GET/asset). */
export async function probeWebtvLiveness(assetId: string): Promise<Liveness> {
  const { status } = await fetchAssetPage(assetId);
  return classifyWebtv(status);
}

/**
 * The single writer of removal state. Applies each source's verdict to its own
 * column via `markVideoRemoved`/`clearVideoRemoved`, so the two sources never
 * race. `unknown` verdicts (and omitted sources) are left untouched. Returns
 * what changed, preferring `removed` over `restored` when both moved.
 */
export async function applyRemoval(
  assetId: string,
  signals: { webtv?: Liveness; kaltura?: Liveness },
): Promise<"removed" | "restored" | "noop"> {
  let removed = false;
  let restored = false;

  if (signals.kaltura === "gone") {
    await markVideoRemoved(assetId, "kaltura");
    removed = true;
  } else if (signals.kaltura === "live") {
    if (await clearVideoRemoved(assetId, "kaltura")) restored = true;
  }

  if (signals.webtv === "gone") {
    await markVideoRemoved(assetId, "webtv");
    removed = true;
  } else if (signals.webtv === "live") {
    if (await clearVideoRemoved(assetId, "webtv")) restored = true;
  }

  return removed ? "removed" : restored ? "restored" : "noop";
}

export interface ReapRemovedOptions {
  /** Write changes. When false, computes counts without mutating. */
  apply: boolean;
  /** Only consider rows seen in the last N days. Default 30. */
  lookbackDays?: number;
  /** Today is checked hourly; other recent records once daily. */
  scope?: RemovalScope;
  /** Kaltura idIn batch size. Default 100. */
  batch?: number;
  /** Concurrent WebTV asset-page GETs. Default 8. */
  concurrency?: number;
  onChange?: (assetId: string, removed: boolean) => void;
}

export interface ReapRemovedResult {
  candidates: number;
  removed: number;
  restored: number;
  errors: number;
  /** True if the WebTV circuit breaker tripped and WebTV verdicts were skipped. */
  webtvAborted: boolean;
}

// Circuit breaker: if this fraction (or more) of the WebTV pages we got a
// definite answer for came back 404, assume WebTV is having a bad day and skip
// applying WebTV removals this run rather than hide a chunk of the archive.
const WEBTV_ABORT_FRACTION = 0.5;
// ...but only once we've sampled enough to trust the ratio.
const WEBTV_ABORT_MIN_SAMPLE = 20;

/** Run `fn` over `items` with at most `limit` in flight; preserves order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Reconcile recent videos with BOTH removal sources and soft-disable any whose
 * Kaltura entry is DELETED (status 3) or whose WebTV asset page 404s
 * (unpublished). Also clears each source's flag on previously-removed rows whose
 * upstream is live again (per-source false-positive recovery).
 *
 * Safe by construction: only toggles the two source columns via `applyRemoval`;
 * never deletes a row or touches a transcript. Idempotent. Acts only on explicit
 * signals (DELETED / 404), never on ambiguous ones (403/5xx/network, or an entry
 * the Kaltura batch didn't return). A WebTV-wide 404 spike trips the circuit
 * breaker and WebTV verdicts are skipped for the run.
 */
export async function reapRemovedVideos(
  opts: ReapRemovedOptions,
): Promise<ReapRemovedResult> {
  const {
    apply,
    lookbackDays = 30,
    scope = "all",
    batch = 100,
    concurrency = 8,
    onChange,
  } = opts;
  const rows = await getRemovalCandidates(lookbackDays, scope);

  const result: ReapRemovedResult = {
    candidates: rows.length,
    removed: 0,
    restored: 0,
    errors: 0,
    webtvAborted: false,
  };
  if (rows.length === 0) return result;

  // 1. Kaltura statuses, batched (cheap: one API call per `batch` entries).
  const kalturaStatus = new Map<string, number>();
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    try {
      const statuses = await fetchKalturaEntryStatuses(
        slice.map((r) => r.entry_id),
      );
      for (const [id, s] of statuses) kalturaStatus.set(id, s);
    } catch {
      result.errors += slice.length; // batch failed → those stay "unknown"
    }
  }

  // 2. WebTV liveness, one GET per asset, bounded concurrency.
  const webtv = await mapLimit(rows, concurrency, (row) =>
    fetchAssetPage(row.asset_id, { fresh: true }).then(({ status }) => status),
  );

  // 3. Circuit breaker over the definite (404 or 2xx) WebTV answers.
  let definite = 0;
  let gone = 0;
  for (const status of webtv) {
    const verdict = classifyWebtv(status);
    if (verdict === "unknown") continue;
    definite++;
    if (verdict === "gone") gone++;
  }
  if (
    definite >= WEBTV_ABORT_MIN_SAMPLE &&
    gone / definite >= WEBTV_ABORT_FRACTION
  ) {
    result.webtvAborted = true;
    console.warn(
      `[reap] WebTV circuit breaker: ${gone}/${definite} candidates 404 — ` +
        `skipping WebTV verdicts this run (Kaltura still applied)`,
    );
  }

  // 4. Apply both verdicts per candidate.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const kaltura = classifyKaltura(kalturaStatus.get(row.entry_id));
    const webtvVerdict = result.webtvAborted
      ? "unknown"
      : classifyWebtv(webtv[i]);
    if (kaltura === "unknown" && webtvVerdict === "unknown") continue;

    const changed = apply
      ? await applyRemoval(row.asset_id, {
          kaltura,
          webtv: webtvVerdict,
        })
      : predictRemoval(row, { kaltura, webtv: webtvVerdict });

    if (changed === "removed") {
      result.removed++;
      onChange?.(row.asset_id, true);
    } else if (changed === "restored") {
      result.restored++;
      onChange?.(row.asset_id, false);
    }
  }

  return result;
}

/**
 * Dry-run equivalent of applyRemoval: what would change, without writing. Kept
 * in lock-step with applyRemoval's decision logic (exported for tests).
 */
export function predictRemoval(
  row: { kaltura_deleted_at: Date | null; webtv_unpublished_at: Date | null },
  signals: { kaltura: Liveness; webtv: Liveness },
): "removed" | "restored" | "noop" {
  const wouldRemove =
    (signals.kaltura === "gone" && row.kaltura_deleted_at === null) ||
    (signals.webtv === "gone" && row.webtv_unpublished_at === null);
  const wouldRestore =
    (signals.kaltura === "live" && row.kaltura_deleted_at !== null) ||
    (signals.webtv === "live" && row.webtv_unpublished_at !== null);
  return wouldRemove ? "removed" : wouldRestore ? "restored" : "noop";
}
