import {
  validateDecisionInput,
  type ApprovalDecision,
  type ApprovalDelivery,
  type ApprovalRow,
  type DecisionInput,
} from "./contracts";
import type { ApprovalsRow } from "../db/schema";

/**
 * D1-only operations on `approvals` (`migrations/0007_approvals.sql`). D1 is
 * the system of record for approval decision and delivery state — unlike the
 * run index, this is not a queryable projection of something else in this
 * table's own right; see the migration file's header comment.
 */

export type NewApprovalCard = {
  /** `apr:{uuid}`, minted DO-side. Never generated here. */
  id: string;
  runId: string;
  generationId: string;
  draft: string;
  why: string;
  channelId: string;
  threadTs: string;
  shadow: boolean;
  /**
   * `created_at`/`updated_at` for the new row, minted by the CALLER.
   * `insertApproval` never reaches for the wall clock itself — every other
   * mutating function in this file takes `now` as a required parameter, and
   * the capability port that calls this one (a later task) is tested against
   * a controlled clock. A defaulted `Date.now()` here would be exactly the
   * kind of hidden nondeterminism that surfaces as flakiness downstream.
   */
  now: number;
};

export type DecideApprovalResult =
  | { result: "decided"; row: ApprovalRow }
  | { result: "already_decided"; row: ApprovalRow }
  | { result: "not_found" };

export type WithdrawApprovalResult =
  | { result: "withdrawn" }
  | { result: "already_decided"; row: ApprovalRow }
  | { result: "not_found" };

/** Exactly the columns `COLUMNS` selects — note `delivery_error` is not one. */
type ApprovalRowDb = Pick<
  ApprovalsRow,
  | "id"
  | "run_id"
  | "generation_id"
  | "draft"
  | "why"
  | "channel_id"
  | "thread_ts"
  | "shadow"
  | "decision"
  | "decided_by"
  | "decided_at"
  | "edited_text"
  | "reject_reason"
  | "delivery"
  | "created_at"
  | "updated_at"
  | "nudged_at"
  | "nudge_channel_id"
  | "nudge_ts"
>;

const COLUMNS = `id, run_id, generation_id, draft, why, channel_id, thread_ts, shadow,
  decision, decided_by, decided_at, edited_text, reject_reason, delivery, created_at, updated_at,
  nudged_at, nudge_channel_id, nudge_ts`;

function toRow(db: ApprovalRowDb): ApprovalRow {
  return {
    id: db.id,
    runId: db.run_id,
    generationId: db.generation_id,
    draft: db.draft,
    why: db.why,
    channelId: db.channel_id,
    threadTs: db.thread_ts,
    shadow: db.shadow === 1,
    decision: db.decision,
    decidedBy: db.decided_by,
    decidedAt: db.decided_at,
    editedText: db.edited_text,
    rejectReason: db.reject_reason,
    delivery: db.delivery,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
    nudgedAt: db.nudged_at,
    nudgeChannelId: db.nudge_channel_id,
    nudgeTs: db.nudge_ts,
  };
}

/**
 * The exact substring D1 (SQLite, through workerd) puts in a thrown error's
 * message on the `idx_approvals_one_open` UNIQUE constraint violation,
 * established empirically against the real pool while implementing this
 * file — see `phase-11-notes.md`'s "Invented / assumed APIs" table for the
 * recorded value.
 *
 * D1 names the violation by COLUMN, not by index name — "UNIQUE constraint
 * failed: approvals.run_id" — even though the constraint is a partial
 * UNIQUE INDEX and `run_id` alone is not unique. `approvals` has exactly one
 * unique index on `run_id` (`idx_approvals_one_open`), so this text
 * unambiguously identifies it; a different column's future unique
 * constraint would produce different text and correctly NOT match here. Any
 * other failure (a bad `run_id` foreign key, an unknown `kind`, a CHECK
 * violation, ...) has different message text and propagates unchanged.
 */
const ONE_OPEN_INDEX_ERROR = "UNIQUE constraint failed: approvals.run_id";

/**
 * Insert a new approval card. `id` is minted DO-side and only ever accepted
 * here, never generated — see `NewApprovalCard.id`'s doc comment.
 *
 * Invariant 4 (one unsettled approval per run) is enforced by
 * `idx_approvals_one_open`, a database constraint, not application logic:
 * this function does not pre-check for an open row, it attempts the insert
 * and maps the specific unique-index violation to `duplicate_open`. Any
 * other failure (a bad `run_id` foreign key, an unknown `kind`, ...)
 * propagates unchanged — this function must not misreport an unrelated
 * constraint failure as a duplicate-open.
 */
export async function insertApproval(
  db: D1Database,
  card: NewApprovalCard
): Promise<"created" | "duplicate_open"> {
  try {
    await db
      .prepare(
        `INSERT INTO approvals
           (id, run_id, generation_id, kind, draft, why, channel_id, thread_ts, shadow,
            decision, delivery, created_at, updated_at)
         VALUES (?, ?, ?, 'slack_reply', ?, ?, ?, ?, ?, 'pending', 'none', ?, ?)`
      )
      .bind(
        card.id,
        card.runId,
        card.generationId,
        card.draft,
        card.why,
        card.channelId,
        card.threadTs,
        card.shadow ? 1 : 0,
        card.now,
        card.now
      )
      .run();
    return "created";
  } catch (err) {
    if (err instanceof Error && err.message.includes(ONE_OPEN_INDEX_ERROR)) {
      return "duplicate_open";
    }
    throw err;
  }
}

export async function getApproval(
  db: D1Database,
  id: string
): Promise<ApprovalRow | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM approvals WHERE id = ?`)
    .bind(id)
    .first<ApprovalRowDb>();
  return row ? toRow(row) : null;
}

/**
 * CAS the decision from `pending` to whatever `input` resolves to. `input`
 * is validated BEFORE any D1 statement runs — an invalid edit/reject throws
 * `DecisionInputError` and leaves the row (if any) completely untouched.
 *
 * The CAS itself is one `db.batch()`: a conditional UPDATE whose WHERE
 * includes `decision = 'pending'`, then a SELECT of the current row. D1
 * runs a batch as a single implicit transaction, so there is no window
 * between the UPDATE and the read-back in which a second caller's UPDATE
 * could land. Branching on `meta.changes` after the fact — rather than
 * trying to read-then-write — is what makes exactly one of two concurrent
 * callers see `changes: 1`; approved -> rejected and every other illegal
 * pair is consequently unreachable BY CONSTRUCTION, not by a guard this
 * function has to remember to add.
 */
export async function decideApproval(
  db: D1Database,
  id: string,
  input: DecisionInput,
  decidedBy: string,
  now: number
): Promise<DecideApprovalResult> {
  validateDecisionInput(input);

  const decision: ApprovalDecision =
    input.action === "approve"
      ? "approved"
      : input.action === "edit"
        ? "edited"
        : "rejected";
  const editedText = input.action === "edit" ? input.text : null;
  const rejectReason = input.action === "reject" ? input.reason : null;

  const [updateResult, selectResult] = await db.batch<ApprovalRowDb>([
    db
      .prepare(
        `UPDATE approvals SET
           decision = ?, decided_by = ?, decided_at = ?,
           edited_text = ?, reject_reason = ?, updated_at = ?
         WHERE id = ? AND decision = 'pending'`
      )
      .bind(decision, decidedBy, now, editedText, rejectReason, now, id),
    db.prepare(`SELECT ${COLUMNS} FROM approvals WHERE id = ?`).bind(id),
  ]);

  const selected = selectResult.results?.[0];
  if (!selected) {
    return { result: "not_found" };
  }
  if ((updateResult.meta.changes ?? 0) > 0) {
    return { result: "decided", row: toRow(selected) };
  }
  return { result: "already_decided", row: toRow(selected) };
}

/**
 * The DO's own withdrawal, e.g. because the customer's newest message made
 * the draft moot. Loses gracefully to a human decision that already landed:
 * a decided row is returned as `already_decided` with the winning row,
 * exactly like `decideApproval`'s loser branch, and is never overwritten.
 */
export async function withdrawApproval(
  db: D1Database,
  id: string,
  now: number
): Promise<WithdrawApprovalResult> {
  const [updateResult, selectResult] = await db.batch<ApprovalRowDb>([
    db
      .prepare(
        `UPDATE approvals SET decision = 'withdrawn', updated_at = ? WHERE id = ? AND decision = 'pending'`
      )
      .bind(now, id),
    db.prepare(`SELECT ${COLUMNS} FROM approvals WHERE id = ?`).bind(id),
  ]);

  const selected = selectResult.results?.[0];
  if (!selected) {
    return { result: "not_found" };
  }
  if ((updateResult.meta.changes ?? 0) > 0) {
    return { result: "withdrawn" };
  }
  return { result: "already_decided", row: toRow(selected) };
}

/**
 * Move `delivery` from one of `from` to `to`, only if the row is currently
 * in one of those states — a CAS on the delivery sub-machine, independent of
 * the decision sub-machine (invariant 5: delivery failure never rewrites
 * what the human chose). Returns whether the move actually happened, so a
 * caller racing another writer of delivery state can tell a no-op apart
 * from a genuine transition.
 */
export async function setDelivery(
  db: D1Database,
  id: string,
  from: ApprovalDelivery[],
  to: ApprovalDelivery,
  error: string | null,
  now: number
): Promise<boolean> {
  if (from.length === 0) return false;
  const placeholders = from.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `UPDATE approvals SET delivery = ?, delivery_error = ?, updated_at = ?
       WHERE id = ? AND delivery IN (${placeholders})`
    )
    .bind(to, error, now, id, ...from)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Mark that the resolution turn (`appendTurn({source:"approval"})`) has
 * reached the DO for this decided row — invariant 9's repair key.
 * Idempotent: calling it again just moves the timestamp forward, which is
 * harmless because `listUndeliveredResolutions` only ever looks for `NULL`.
 */
export async function markResolutionDelivered(
  db: D1Database,
  id: string,
  now: number
): Promise<void> {
  await db
    .prepare(`UPDATE approvals SET resolution_delivered_at = ? WHERE id = ?`)
    .bind(now, id)
    .run();
}

/**
 * The dashboard's open queue: `GET /api/approvals?state=open`. Reads never
 * wake a DO (invariant 7) — this is the whole of that read.
 */
export async function listOpen(
  db: D1Database,
  limit = 50
): Promise<ApprovalRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM approvals WHERE decision = 'pending' ORDER BY created_at ASC LIMIT ?`
    )
    .bind(limit)
    .all<ApprovalRowDb>();
  return (results ?? []).map(toRow);
}

/**
 * The once-only CAS for the Slack nudge DM (Phase 13): exactly one caller
 * ever sees `true` for a given row, no matter how many concurrent or
 * repeated sends race for it. One conditional UPDATE — `WHERE ... AND
 * nudged_at IS NULL` — branching on `meta.changes` after the fact, same
 * pattern as `decideApproval`'s CAS: there is no read-then-write window for
 * a second caller to land in.
 */
export async function claimNudge(
  db: D1Database,
  id: string,
  now: number
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE approvals SET nudged_at = ? WHERE id = ? AND nudged_at IS NULL`
    )
    .bind(now, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Records the channel/ts of the nudge DM that was actually sent, once
 * `claimNudge` has already won the slot. Not itself a CAS — the claim above
 * is what makes this call happen at most once per row.
 */
export async function recordNudgeMessage(
  db: D1Database,
  id: string,
  channelId: string,
  ts: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE approvals SET nudge_channel_id = ?, nudge_ts = ? WHERE id = ?`
    )
    .bind(channelId, ts, id)
    .run();
}

/**
 * Hand the nudge slot back after a send that did not happen.
 *
 * The counterpart to `claimNudge`, and the reason the claim can be taken
 * before the Slack call rather than after it: a failed attempt puts the row
 * straight back on `idx_approvals_unnudged` for the sweeper, so the once-only
 * guarantee costs nothing in deliverability. Unconditional — only the caller
 * that won the claim ever reaches it.
 */
export async function releaseNudge(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(`UPDATE approvals SET nudged_at = NULL WHERE id = ?`)
    .bind(id)
    .run();
}

/**
 * The repair key for invariant 9: decided rows whose resolution turn has not
 * yet reached the DO, for the one-minute `scheduled()` sweeper to re-drive.
 * A `pending` row has nothing to resolve yet and is correctly excluded.
 */
export async function listUndeliveredResolutions(
  db: D1Database,
  limit: number
): Promise<ApprovalRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM approvals
       WHERE decision IN ('approved', 'edited', 'rejected') AND resolution_delivered_at IS NULL
       ORDER BY decided_at ASC
       LIMIT ?`
    )
    .bind(limit)
    .all<ApprovalRowDb>();
  return (results ?? []).map(toRow);
}
