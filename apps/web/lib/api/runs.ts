import { fixture, getJson, isDemo } from "./client";
import { demoRuns, demoUsageTotals } from "../fixtures/runs";

export type RunStatus = "live" | "awaiting_approval" | "idle" | "done" | "failed";

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
};

export async function getRuns(limit = 50): Promise<RunSummary[]> {
  if (isDemo()) return fixture(demoRuns);
  const body = await getJson<{ runs: RunSummary[] }>(`/api/runs?limit=${limit}`);
  return body.runs;
}

/**
 * One run by its public id.
 *
 * `GET /api/runs/:id` is D1-only on the Worker — rendering a run must not wake
 * it — and returns `publicRun`, which omits the Durable Object key. The
 * dashboard addresses runs by UUID and the Worker resolves the key server-side
 * (invariant 10), so this shape is a narrower `RunSummary`: the join columns
 * `channelName` and `customerSlug` belong to the list query and are absent
 * here.
 */
export type RunDetail = Omit<RunSummary, "channelName" | "customerSlug"> & {
  threadTs: string | null;
};

export async function getRun(id: string): Promise<RunDetail> {
  if (isDemo()) {
    const run = demoRuns.find((candidate) => candidate.id === id) ?? demoRuns[0]!;
    return fixture({ ...run, id, threadTs: null });
  }
  const body = await getJson<{ run: RunDetail }>(`/api/runs/${encodeURIComponent(id)}`);
  return body.run;
}

/**
 * The total is a decimal string all the way from the ledger, and it is returned
 * untouched. `Number()` here would silently round money.
 */
export async function getRunUsageTotal(id: string): Promise<string> {
  if (isDemo()) return fixture(demoUsageTotals[id] ?? "0.0000");
  const body = await getJson<{ totalCostUsd: string }>(
    `/api/runs/${encodeURIComponent(id)}/usage`,
  );
  return body.totalCostUsd;
}
