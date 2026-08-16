/**
 * The approval half of the Think chassis: the agent's own approval table,
 * escalation, and the human's approve / edit / reject decision.
 *
 * STUB — every export here has its final signature and a safe default body.
 * Task 9 fills the bodies in and must not change the signatures, because
 * `src/run/agent.ts` already calls all four from their real hooks and Wave B
 * does not edit that file.
 *
 * Approval stays HOST-owned rather than riding the codemode runtime's own
 * pause/approve flow: `CodemodeApproveOptions` is `{ executionId }` only, with
 * no way to substitute the edited text a human typed (verified fact 5, spec
 * decision D4). The edit path is the whole point of this module.
 */

import type { ApprovalDecision, ApprovalDelivery, DecisionInput } from "../approval/contracts";
import type { RunAgent } from "./agent";

/** What a capability asks for when it wants to say something to a customer. */
export type EscalateInput = {
  /** The exact text that would be sent, verbatim, if approved unedited. */
  draft: string;
  /** One line of why, for the dashboard card and the engineer's DM. */
  why: string;
};

/** One human decision on one open approval. */
export type ResolveInput = {
  approvalId: string;
  /** `approve` | `edit` (carries the replacement text) | `reject` (carries a reason). */
  decision: DecisionInput;
  /** The Access-verified engineer email that decided. Never model-supplied. */
  decidedBy: string;
  /** The decision instant, so the caller's clock is the one recorded. */
  decidedAt: number;
};

/**
 * The outcome of a decision, as a CAS result rather than a boolean.
 *
 * `already_resolved` is a normal outcome, not an error: two dashboard tabs, a
 * retried PATCH, and the cron repair sweep all race here, and the second one
 * through must learn what the first decided rather than overwrite it.
 */
export type ResolveResult =
  | { status: "resolved"; approval: Approval }
  | { status: "already_resolved"; approval: Approval }
  | { status: "not_found" };

/** One approval as the dashboard and the run both see it. */
export type Approval = {
  id: string;
  runId: string;
  draft: string;
  why: string;
  decision: ApprovalDecision;
  /** The text that was actually sent: the edit when edited, else the draft. */
  editedText: string | null;
  rejectReason: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
  delivery: ApprovalDelivery;
  createdAt: number;
};

/**
 * Create the agent's approval table if it is not there yet.
 *
 * Called from `RunAgent.onStart`, so it runs on every wake and must be
 * idempotent (`CREATE TABLE IF NOT EXISTS`).
 */
// TODO(Task 9): CREATE TABLE IF NOT EXISTS via agent.sql.
export function ensureApprovalSchema(_agent: RunAgent): void {}

/**
 * Open one approval for this run and return its id.
 *
 * Returns immediately — the pause latches later, at turn finalize — so a
 * capability that escalates does not block the rest of the model's program.
 */
// TODO(Task 9): local row + D1 projection + nudge, mirroring src/approval/port.ts.
export function escalate(_agent: RunAgent, _input: EscalateInput): Promise<{ approvalId: string }> {
  return Promise.resolve({ approvalId: crypto.randomUUID() });
}

/**
 * Apply a human decision, then re-enter the loop.
 *
 * The default reports `not_found`, which is the fail-closed answer: nothing
 * was recorded, so nothing may be claimed to have been sent.
 */
// TODO(Task 9): D1 compare-and-set, then send the edited text and resume the turn.
export function resolveApproval(_agent: RunAgent, _input: ResolveInput): Promise<ResolveResult> {
  return Promise.resolve({ status: "not_found" });
}

/** Every approval on this run — open ones by default. */
// TODO(Task 9): read the agent's approval table.
export function pendingApprovals(
  _agent: RunAgent,
  _opts?: { includeResolved?: boolean },
): Promise<Approval[]> {
  return Promise.resolve([]);
}
