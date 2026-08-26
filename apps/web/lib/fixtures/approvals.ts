import type {
  ApprovalDetail,
  DecideAction,
  DecideResult,
  Decision,
  OpenApproval,
} from "../api/approvals";

/**
 * Demo approvals are the one fixture that has to be MUTABLE: the queue is the
 * only surface on the dashboard a human acts on, and a demo where clicking
 * Approve changes nothing demonstrates the opposite of the point.
 *
 * The store lives at module scope and resets on reload, which is the right
 * lifetime — nothing here is durable and nothing here is shared.
 */

const now = Date.now();

type DemoRow = OpenApproval & { decision: Decision };

const rows: DemoRow[] = [
  {
    id: "apr-8f21c05e",
    runId: "a1c9e7d4-32b8-4f10-95aa-7c2e5b8d0446",
    draft:
      "You don't need to duplicate anything — add a language variant on the funnel itself: Editor → Settings → Languages → add \"DE\". Existing traffic keeps its stats; the variant inherits the funnel's steps and you translate per step. Two-minute walkthrough attached.",
    why: "Tells the customer how a feature behaves and attaches a recording. If the inheritance detail is wrong they will build on it, so it should be signed off.",
    channelId: "C0LINGUA",
    threadTs: "1787734021.000400",
    createdAt: now - 190_000,
    decision: "pending",
  },
  {
    id: "apr-2b74d9a1",
    runId: "5f3b1c22-9d41-4a7e-8b02-1d6c4f0a91e3",
    draft:
      "We've reproduced the Android tap failure — it's a WebView regression in yesterday's release, not something on your side. A fix is in review now and we'll confirm here once it's out.",
    why: "Commits to shipping a fix and dates it implicitly. That is a promise on the team's behalf, so a human decides it.",
    channelId: "C0PULSEFIT",
    threadTs: "1787735880.000900",
    createdAt: now - 42_000,
    decision: "pending",
  },
];

export function listDemoApprovals(): OpenApproval[] {
  return rows
    .filter((row) => row.decision === "pending")
    .map(({ decision: _decision, ...card }) => card);
}

/**
 * The detail read. In demo mode a decided card names its decider, which is the
 * one thing the worker's 409 body cannot tell a losing card — this is what
 * makes "Zurab approved this before you" reachable in a demo at all.
 */
export function getDemoApproval(id: string): ApprovalDetail {
  const row = rows.find((candidate) => candidate.id === id);
  const base: DemoRow = row ?? {
    ...(rows[0] as DemoRow),
    id,
    decision: "withdrawn",
  };
  const decided = base.decision !== "pending";
  const { decision, ...card } = base;

  return {
    ...card,
    updatedAt: decided ? Date.now() : base.createdAt,
    decision,
    decidedBy: decided ? "zurab@zellify.app" : null,
    decidedAt: decided ? Date.now() : null,
    editedText: null,
    rejectReason: null,
    delivery: decided ? "sent" : "none",
  };
}

/**
 * Mirrors the worker's CAS: the first decision on a row wins and every later
 * one answers 409 with the decision that won. Deciding the same card twice in
 * a demo is exactly how an operator discovers that rule exists.
 */
export function decideDemoApproval(id: string, action: DecideAction): DecideResult {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) {
    return { result: "already_decided", decision: "withdrawn", decidedBy: null };
  }

  if (row.decision !== "pending") {
    return { result: "already_decided", decision: row.decision, decidedBy: null };
  }

  const decision: Decision =
    action.action === "approve" ? "approved" : action.action === "edit" ? "edited" : "rejected";
  row.decision = decision;
  return { result: "decided", decision };
}
