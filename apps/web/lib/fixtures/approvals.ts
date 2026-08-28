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
    .map((row): OpenApproval => {
      // Spread-and-drop rather than destructuring the field away: an unused
      // binding is exactly the thing lint is right to complain about.
      const card = { ...row } as Partial<DemoRow>;
      delete card.decision;
      return card as OpenApproval;
    });
}

/** One row's `DemoRow` widened to the full `ApprovalDetail` card `getDemoApproval` returns. */
function toDetail(row: DemoRow): ApprovalDetail {
  return getDemoApproval(row.id);
}

/** Every card — open or decided — that belongs to one run. */
export function listDemoApprovalsForRun(runId: string): ApprovalDetail[] {
  return rows.filter((row) => row.runId === runId).map(toDetail);
}

/**
 * Two static decided cards, so the "decided" section of a demo is never
 * empty even before anyone has clicked Approve/Reject on the mutable rows
 * above — plus whichever of those rows a click has since resolved.
 */
const staticDecided: ApprovalDetail[] = [
  {
    id: "apr-6c40f813",
    runId: "7b2d5a90-6e1f-4c33-a8d7-90f1b3e6c258",
    draft:
      "Added a copy-funnel-ID button next to the funnel name in the dashboard header — it's live now, no action needed on your side.",
    why: "Tells the customer a change already shipped. Low risk, but it is still speech under the fire-fighter's name.",
    channelId: "C0MACROSNAP",
    threadTs: "1787729400.000100",
    createdAt: now - 2 * 60 * 60 * 1000,
    updatedAt: now - 2 * 60 * 60 * 1000,
    decision: "approved",
    decidedBy: "ronit@zellify.app",
    decidedAt: now - 2 * 60 * 60 * 1000,
    editedText: null,
    rejectReason: null,
    delivery: "sent",
  },
  {
    id: "apr-1a9e2f66",
    runId: "c4e8f107-5a23-4b96-8e15-2d7a9c0b4f36",
    draft:
      "We can turn on per-country price A/B testing this sprint, but local currencies would push it into next sprint — want the split now or the currencies with it?",
    why: "Sets an expectation about scope and timing for a Q4-priority ask; the customer should hear it from a human, not the agent's first draft.",
    channelId: "C0DRIFTWEAR",
    threadTs: "1787660100.000200",
    createdAt: now - 5 * 60 * 60 * 1000,
    updatedAt: now - 5 * 60 * 60 * 1000,
    decision: "rejected",
    decidedBy: "zurab@zellify.app",
    decidedAt: now - 5 * 60 * 60 * 1000,
    editedText: null,
    rejectReason:
      "Too soon to commit to a split — let's see the pricing model draft first.",
    delivery: "none",
  },
];

/** Every demo card that has left `pending`, plus the two static ones above. */
export function listDemoDecided(): ApprovalDetail[] {
  const fromRows = rows
    .filter((row) => row.decision !== "pending")
    .map(toDetail);
  return [...fromRows, ...staticDecided];
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
export function decideDemoApproval(
  id: string,
  action: DecideAction
): DecideResult {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) {
    return {
      result: "already_decided",
      decision: "withdrawn",
      decidedBy: null,
    };
  }

  if (row.decision !== "pending") {
    return {
      result: "already_decided",
      decision: row.decision,
      decidedBy: null,
    };
  }

  const decision: Decision =
    action.action === "approve"
      ? "approved"
      : action.action === "edit"
        ? "edited"
        : "rejected";
  row.decision = decision;
  return { result: "decided", decision };
}
