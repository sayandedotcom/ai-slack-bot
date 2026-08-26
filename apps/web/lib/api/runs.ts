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
