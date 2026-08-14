/**
 * The runs half of the dashboard's network surface. Everything goes through
 * `getJson` from `../lib/api` — or the local `postJson` below, which repeats
 * that module's error discipline rather than widening it, because a POST is
 * the only shape `lib/api` does not need to know about.
 */

import { ApiError, getJson } from "../lib/api";

export type RunStatus = "live" | "awaiting_approval" | "idle" | "done" | "failed";

/**
 * A row in the runs list. The worker's `listRuns` joins the channel and
 * customer names for display, and deliberately omits `threadTs` — a list row
 * never needs to address a Slack thread, only the detail view does.
 */
export type RunSummary = {
  id: string;
  origin: string;
  status: RunStatus;
  shadow: boolean;
  summary: string | null;
  channelId: string | null;
  channelName: string | null;
  customerSlug: string | null;
  createdAt: number;
  updatedAt: number;
};

/** The run as the detail endpoint returns it: carries `threadTs`, no joined names. */
export type RunDetail = {
  id: string;
  origin: string;
  status: RunStatus;
  shadow: boolean;
  summary: string | null;
  channelId: string | null;
  threadTs: string | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * The snapshot reshaped into the same message the live socket sends, so the
 * session reducer has exactly one input shape to fold and cannot drift between
 * "loaded from HTTP" and "streamed".
 */
export type RunSync = {
  type: "sync";
  events: unknown[];
  cursor: number;
  complete: boolean;
  status: RunStatus | null;
};

/**
 * POST a relative JSON endpoint. Mirrors `getJson`: the thrown `ApiError`
 * names the path and never the response body, and the request is same-origin
 * so no credential can be sent anywhere else.
 */
export async function postJson<T>(path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
  } catch {
    // Status 0: there was no HTTP response at all.
    throw new ApiError(0, "unavailable", path);
  }

  // Creating a turn answers 201, so the gate is `ok`, not an equality on 200.
  if (!response.ok) {
    const kind =
      response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" : "unavailable";
    throw new ApiError(response.status, kind, path);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(response.status, "unavailable", path);
  }
}

export async function fetchRuns(limit = 50): Promise<RunSummary[]> {
  const body = await getJson<{ runs: RunSummary[] }>(`/api/runs?limit=${limit}`);
  return body.runs;
}

export async function fetchRunSnapshot(
  id: string,
  since?: number,
): Promise<{ run: RunDetail; sync: RunSync }> {
  const path =
    since === undefined
      ? `/api/runs/${encodeURIComponent(id)}`
      : `/api/runs/${encodeURIComponent(id)}?since=${since}`;
  const body = await getJson<{
    run: RunDetail;
    events: unknown[];
    cursor: number;
    complete: boolean;
  }>(path);
  return {
    run: body.run,
    sync: {
      type: "sync",
      events: body.events,
      cursor: body.cursor,
      complete: body.complete,
      status: body.run.status,
    },
  };
}

export async function postSteer(
  id: string,
  requestId: string,
  content: string,
): Promise<{ seq: number; appended: boolean }> {
  // Exactly these two keys: `requestId` is the idempotency key the worker
  // dedupes on, and anything extra would be an unaudited field on a write.
  return postJson<{ seq: number; appended: boolean }>(`/api/runs/${encodeURIComponent(id)}/turns`, {
    requestId,
    content,
  });
}

/**
 * The total is a decimal string all the way from the ledger. It is returned
 * untouched — `Number()` here would silently round money.
 */
export async function fetchRunUsageTotal(id: string): Promise<string> {
  const body = await getJson<{ totalCostUsd: string }>(`/api/runs/${encodeURIComponent(id)}/usage`);
  return body.totalCostUsd;
}
