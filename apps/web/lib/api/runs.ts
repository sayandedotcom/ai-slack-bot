import { demoRuns, demoUsageTotals } from "../fixtures/runs";
import { fixture, getJson, isDemo } from "./client";
import { ApiError } from "./errors";

export type RunStatus =
  | "live"
  | "awaiting_approval"
  | "idle"
  | "done"
  | "failed";

/**
 * A row in the runs list. The worker's `listRuns` joins the channel and
 * customer names for display, and deliberately omits `threadTs` — a list row
 * never needs to address a Slack thread.
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
  /** A decimal string all the way from the ledger. Never `Number()`d. */
  costUsd: string;
  turns: number;
  openApprovalId: string | null;
};

export type RunListParams = {
  status?: RunStatus;
  origin?: "slack" | "chat";
  channelId?: string;
  shadow?: boolean;
  q?: string;
  cursor?: string;
  limit?: number;
};

export type RunPage = { runs: RunSummary[]; nextCursor: string | null };

/** Deterministic key order, so two components asking the same thing share one cache entry. */
export function runListQuery(params: RunListParams): string {
  const search = new URLSearchParams();
  if (params.status) search.set("status", params.status);
  if (params.origin) search.set("origin", params.origin);
  if (params.channelId) search.set("channelId", params.channelId);
  if (params.shadow !== undefined) search.set("shadow", String(params.shadow));
  if (params.q) search.set("q", params.q);
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  const s = search.toString();
  return s === "" ? "" : `?${s}`;
}

function matchesDemo(run: RunSummary, p: RunListParams): boolean {
  if (p.status && run.status !== p.status) return false;
  if (p.origin && run.origin !== p.origin) return false;
  if (p.channelId && run.channelId !== p.channelId) return false;
  if (p.shadow !== undefined && run.shadow !== p.shadow) return false;
  if (p.q) {
    const q = p.q.toLowerCase();
    const hay =
      `${run.summary ?? ""} ${run.channelName ?? ""} ${run.id}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export async function getRuns(params: RunListParams = {}): Promise<RunPage> {
  if (isDemo()) {
    return fixture({
      runs: demoRuns.filter((r) => matchesDemo(r, params)),
      nextCursor: null,
    });
  }
  return getJson<RunPage>(`/api/runs${runListQuery(params)}`);
}

/**
 * One run by its public id.
 *
 * `GET /api/runs/:id` is D1-only on the Worker — rendering a run must not wake
 * it — and returns `publicRun`, which omits the Durable Object key. The
 * dashboard addresses runs by UUID and the Worker resolves the key server-side
 * (invariant 10).
 *
 * Deliberately spelled out field-by-field rather than derived from
 * `RunSummary` (e.g. `Omit<RunSummary, ...>`): `publicRun` in
 * `apps/worker/src/api/runs.ts` returns exactly `id, origin, status, shadow,
 * summary, channelId, threadTs, createdAt, updatedAt` and nothing else. A
 * derived type would silently inherit any field `RunSummary` gains in the
 * future (as happened with `costUsd`, `turns` and `openApprovalId`, none of
 * which the detail endpoint returns) unless every future edit also remembers
 * to extend the `Omit`. This type has to be edited by hand only when the
 * Worker's own `publicRun` shape changes, which is the one time it should be.
 */
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

export async function getRun(id: string): Promise<RunDetail> {
  if (isDemo()) {
    // An unknown id borrows the first row rather than 404ing, so a pasted or
    // stale `/runs/<id>` still renders something in a demo. `demoRuns` is a
    // non-empty literal, but the index is narrowed rather than asserted —
    // an assertion here would outlive whoever next edits the fixture.
    const [first] = demoRuns;
    const run = demoRuns.find((candidate) => candidate.id === id) ?? first;
    if (run === undefined) throw new ApiError(404, "unavailable", "demo runs");
    return fixture({ ...run, id, threadTs: null });
  }
  const body = await getJson<{ run: RunDetail }>(
    `/api/runs/${encodeURIComponent(id)}`
  );
  return body.run;
}

/**
 * The total is a decimal string all the way from the ledger, and it is returned
 * untouched. `Number()` here would silently round money.
 */
export async function getRunUsageTotal(id: string): Promise<string> {
  if (isDemo()) return fixture(demoUsageTotals[id] ?? "0.0000");
  const body = await getJson<{ totalCostUsd: string }>(
    `/api/runs/${encodeURIComponent(id)}/usage`
  );
  return body.totalCostUsd;
}
