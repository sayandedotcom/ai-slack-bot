import type { RunSummary } from "../api/runs";

const now = Date.now();
const minutes = (n: number) => now - n * 60_000;

/**
 * Five runs covering every status the list can render, plus one shadow run and
 * one started from the chat surface rather than from Slack. The summaries are
 * the customer's own words, because that is what the worker stores.
 */
export const demoRuns: RunSummary[] = [
  {
    id: "5f3b1c22-9d41-4a7e-8b02-1d6c4f0a91e3",
    origin: "slack",
    status: "live",
    shadow: false,
    summary:
      "checkout button does nothing on Android since yesterday — the drop is visible in our numbers, this is urgent for us",
    channelId: "C0PULSEFIT",
    channelName: "zellify-pulsefit",
    customerSlug: "pulsefit",
    createdAt: minutes(14),
    updatedAt: minutes(12),
    costUsd: "0.4127",
    turns: 3,
    openApprovalId: null,
  },
  {
    id: "a1c9e7d4-32b8-4f10-95aa-7c2e5b8d0446",
    origin: "slack",
    status: "awaiting_approval",
    shadow: false,
    summary:
      "how do we add a second language variant to the same funnel without duplicating the whole thing?",
    channelId: "C0LINGUA",
    channelName: "zellify-lingua",
    customerSlug: "lingua",
    createdAt: minutes(29),
    updatedAt: minutes(26),
    costUsd: "0.1893",
    turns: 2,
    // The one open card in `fixtures/approvals.ts` — kept in sync by hand,
    // there being only one place that fixture's id is minted.
    openApprovalId: "apr-8f21c05e",
  },
  {
    id: "7b2d5a90-6e1f-4c33-a8d7-90f1b3e6c258",
    origin: "slack",
    status: "done",
    shadow: false,
    summary:
      "small ask — a button to copy the funnel ID from the dashboard would save us a dozen clicks a day",
    channelId: "C0MACROSNAP",
    channelName: "zellify-macrosnap",
    customerSlug: "macrosnap",
    createdAt: minutes(74),
    updatedAt: minutes(61),
    costUsd: "0.9042",
    turns: 5,
    openApprovalId: null,
  },
  {
    id: "c4e8f107-5a23-4b96-8e15-2d7a9c0b4f36",
    origin: "slack",
    status: "idle",
    shadow: true,
    summary:
      "we want price A/B testing per country, with local currencies — this is big for our Q4 push",
    channelId: "C0DRIFTWEAR",
    channelName: "zellify-driftwear",
    customerSlug: "driftwear",
    createdAt: minutes(196),
    updatedAt: minutes(181),
    costUsd: "0.2255",
    turns: 1,
    openApprovalId: null,
  },
  {
    // The run `/chat` resolves to in demo mode, so the transcript fixture and
    // this row tell the same story. Kept in the list rather than hidden: a run
    // opened from the dashboard is the same object as one opened from chat, and
    // the list is where that becomes visible.
    id: "b8d41f62-0c37-4a1e-9d55-3e6f2a8c7014",
    origin: "chat",
    status: "done",
    shadow: false,
    summary:
      "did PulseFit complain about checkout before this week? what did we do back then?",
    channelId: null,
    channelName: null,
    customerSlug: null,
    createdAt: minutes(21),
    updatedAt: minutes(17),
    costUsd: "0.1204",
    turns: 2,
    openApprovalId: null,
  },
  {
    id: "e0a6b3f8-1d74-49c5-b2e9-6f4c8a105d72",
    origin: "chat",
    status: "failed",
    shadow: false,
    summary: null,
    channelId: null,
    channelName: null,
    customerSlug: null,
    createdAt: minutes(310),
    updatedAt: minutes(308),
    costUsd: "0.0310",
    turns: 1,
    openApprovalId: null,
  },
];

/** Decimal strings, exactly as the ledger stores them. Never parsed as numbers. */
export const demoUsageTotals: Record<string, string> = {
  "5f3b1c22-9d41-4a7e-8b02-1d6c4f0a91e3": "0.4127",
  "a1c9e7d4-32b8-4f10-95aa-7c2e5b8d0446": "0.1893",
  "7b2d5a90-6e1f-4c33-a8d7-90f1b3e6c258": "0.9042",
  "c4e8f107-5a23-4b96-8e15-2d7a9c0b4f36": "0.2255",
  "b8d41f62-0c37-4a1e-9d55-3e6f2a8c7014": "0.1204",
  "e0a6b3f8-1d74-49c5-b2e9-6f4c8a105d72": "0.0310",
};
