import { UPSTREAM_USER_AGENT } from "./upstream-identity";
import { updateVideoEntryId } from "./db";
import {
  extractKalturaId,
  KALTURA_PARTNER_ID,
  KALTURA_WIDGET_ID,
} from "./kaltura";

/**
 * Low-level Kaltura lookup: resolve a Kaltura player ID to its canonical
 * entry ID (following any `redirectFromEntryId` indirection). No caching.
 * Shared by `resolveEntryId` here and `scripts/sync-videos.ts`.
 */
export async function resolveEntryIdFromKaltura(
  kalturaId: string,
): Promise<string | null> {
  try {
    const response = await fetch(
      "https://cdnapisec.kaltura.com/api_v3/service/multirequest",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": UPSTREAM_USER_AGENT,
        },
        body: JSON.stringify({
          "1": {
            service: "session",
            action: "startWidgetSession",
            widgetId: KALTURA_WIDGET_ID,
          },
          "2": {
            service: "baseEntry",
            action: "list",
            ks: "{1:result:ks}",
            filter: { redirectFromEntryId: kalturaId },
            responseProfile: { type: 1, fields: "id" },
          },
          apiVersion: "3.3.0",
          format: 1,
          ks: "",
          clientTag: "html5:v3.17.30",
          partnerId: KALTURA_PARTNER_ID,
        }),
      },
    );

    if (!response.ok) {
      console.warn(`Kaltura API failed: ${response.status}`);
      return null;
    }

    const data = await response.json();
    return data[1]?.objects?.[0]?.id || null;
  } catch (error) {
    console.error("Failed to resolve entry ID:", error);
    return null;
  }
}

/**
 * Fetch durations (in seconds) for a batch of Kaltura entry IDs via
 * `baseEntry.list` — the same source the player uses. Entries that are
 * missing or report no duration are simply absent from the returned map.
 * Throws on a non-OK HTTP response so callers can treat the batch as failed.
 */
export async function fetchKalturaDurations(
  entryIds: string[],
): Promise<Map<string, number>> {
  if (entryIds.length === 0) return new Map();
  const response = await fetch(
    "https://cdnapisec.kaltura.com/api_v3/service/multirequest",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UPSTREAM_USER_AGENT,
      },
      body: JSON.stringify({
        "1": {
          service: "session",
          action: "startWidgetSession",
          widgetId: KALTURA_WIDGET_ID,
        },
        "2": {
          service: "baseEntry",
          action: "list",
          ks: "{1:result:ks}",
          filter: { idIn: entryIds.join(",") },
          responseProfile: { type: 1, fields: "id,duration" },
          pager: { pageSize: 500 },
        },
        apiVersion: "3.3.0",
        format: 1,
        ks: "",
        clientTag: "html5:v3.17.30",
        partnerId: KALTURA_PARTNER_ID,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Kaltura API failed: ${response.status}`);
  }
  const data = await response.json();
  const objects: Array<{ id: string; duration?: number }> =
    data?.[1]?.objects ?? [];
  const out = new Map<string, number>();
  for (const o of objects) {
    if (typeof o.duration === "number" && o.duration > 0) {
      out.set(o.id, o.duration);
    }
  }
  return out;
}

/** Kaltura entry status: 3 = DELETED (the player shows "Video has been removed"). */
export const KALTURA_STATUS_DELETED = 3;

/**
 * Fetch the entry `status` for a batch of Kaltura entry IDs via
 * `baseEntry.list`. Deleted entries are still returned by the API (with
 * `status === 3`), which is exactly the signal we need to detect removals.
 * Entries the API doesn't return at all are simply absent from the map.
 * Throws on a non-OK HTTP response so callers can treat the batch as failed.
 */
export async function fetchKalturaEntryStatuses(
  entryIds: string[],
): Promise<Map<string, number>> {
  if (entryIds.length === 0) return new Map();
  const response = await fetch(
    "https://cdnapisec.kaltura.com/api_v3/service/multirequest",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UPSTREAM_USER_AGENT,
      },
      body: JSON.stringify({
        "1": {
          service: "session",
          action: "startWidgetSession",
          widgetId: KALTURA_WIDGET_ID,
        },
        "2": {
          service: "baseEntry",
          action: "list",
          ks: "{1:result:ks}",
          // `statusIn` is required: baseEntry.list defaults to excluding DELETED
          // (status 3) entries, which are exactly the ones we need to detect.
          filter: {
            idIn: entryIds.join(","),
            statusIn: "-2,-1,0,1,2,3,4,5,6,7",
          },
          responseProfile: { type: 1, fields: "id,status" },
          pager: { pageSize: 500 },
        },
        apiVersion: "3.3.0",
        format: 1,
        ks: "",
        clientTag: "html5:v3.17.30",
        partnerId: KALTURA_PARTNER_ID,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Kaltura API failed: ${response.status}`);
  }
  const data = await response.json();
  const objects: Array<{ id: string; status?: number }> =
    data?.[1]?.objects ?? [];
  const out = new Map<string, number>();
  for (const o of objects) {
    if (typeof o.status === "number") out.set(o.id, o.status);
  }
  return out;
}

/**
 * Resolves an asset ID or Kaltura ID to an entry ID.
 * If cachedEntryId is provided (already stored in DB), returns it immediately.
 * Only calls Kaltura API when the entry ID is unknown.
 */
export async function resolveEntryId(
  assetId: string,
  cachedEntryId?: string | null,
): Promise<string | null> {
  // Use cached value if available — avoids unnecessary Kaltura API calls
  if (cachedEntryId) return cachedEntryId;

  // Step 1: Extract Kaltura ID from asset ID
  const kalturaId = extractKalturaId(assetId);
  if (!kalturaId) {
    console.warn(`Could not extract Kaltura ID from: ${assetId}`);
    return null;
  }

  // Step 2: Call Kaltura API to resolve (handles redirects)
  const entryId = await resolveEntryIdFromKaltura(kalturaId);

  // Step 3: Save resolved entry_id back to cache for next time
  if (entryId) {
    try {
      await updateVideoEntryId(assetId, entryId);
    } catch (error) {
      console.warn("Failed to cache entry ID:", error);
    }
  }

  return entryId;
}
