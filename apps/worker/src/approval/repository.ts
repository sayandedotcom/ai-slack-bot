import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { orm } from "../db/client";
import type { ApprovalsRow } from "../db/schema";
import { approvals } from "../db/tables";
import {
  type ApprovalDecision,
  type ApprovalDelivery,
  type ApprovalRow,
  type DecisionInput,
  validateDecisionInput,
} from "./contracts";

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

/**
 * Exactly the columns `ApprovalRowDb` names — note `delivery_error` is not one.
 * A projection stated as a column map rather than `SELECT *`, so a column added
 * to the table does not silently start travelling to every reader.
 */
const APPROVAL_COLUMNS = {
  id: approvals.id,
  run_id: approvals.run_id,
  generation_id: approvals.generation_id,
  draft: approvals.draft,
  why: approvals.why,
  channel_id: approvals.channel_id,
  thread_ts: approvals.thread_ts,
  shadow: approvals.shadow,
  decision: approvals.decision,
  decided_by: approvals.decided_by,
  decided_at: approvals.decided_at,
  edited_text: approvals.edited_text,
  reject_reason: approvals.reject_reason,
  delivery: approvals.delivery,
  created_at: approvals.created_at,
  updated_at: approvals.updated_at,
  nudged_at: approvals.nudged_at,
  nudge_channel_id: approvals.nudge_channel_id,
  nudge_ts: approvals.nudge_ts,
} as const;

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
 * Does this thrown value carry the one-open violation ANYWHERE in its cause
 * chain?
 *
 * The chain is why this is a function rather than one `.includes()`. D1 raises
 * `UNIQUE constraint failed: approvals.run_id`; Drizzle catches that and
 * rethrows a `DrizzleQueryError` whose own message is `Failed query: insert
 * into "approvals" ...` with the original hung off `cause` — and workerd adds a
 * `D1_ERROR:` wrapper of its own in between. Matching only the top-level
 * message therefore stopped seeing the violation the moment the statement moved
 * to the query builder, which is exactly how it was found: two repository tests
 * and one port test went red together, reporting a raw throw where they
 * expected `duplicate_open`.
 *
 * Walking the chain is the fix, and it is strictly more robust than what it
 * replaces: it matches whether the driver wraps, double-wraps, or stops
 * wrapping. The depth bound is a cycle guard, not a limit anyone should need.
 */
function isOneOpenViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 8; depth++) {
    if (e instanceof Error) {
      if (e.message.includes(ONE_OPEN_INDEX_ERROR)) return true;
      e = e.cause;
      continue;
    }
    return false;
  }
  return false;
}

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
    await orm(db)
      .insert(approvals)
      .values({
        id: card.id,
        run_id: card.runId,
        generation_id: card.generationId,
        kind: "slack_reply",
        draft: card.draft,
        why: card.why,
        channel_id: card.channelId,
        thread_ts: card.threadTs,
        shadow: card.shadow ? 1 : 0,
        decision: "pending",
        delivery: "none",
        created_at: card.now,
        updated_at: card.now,
      })
      .run();
    return "created";
  } catch (err) {
    if (isOneOpenViolation(err)) {
      return "duplicate_open";
    }
    throw err;
  }
}

export async function getApproval(
  db: D1Database,
  id: string
): Promise<ApprovalRow | null> {
  const row = await orm(db)
    .select(APPROVAL_COLUMNS)
    .from(approvals)
    .where(eq(approvals.id, id))
    .get();
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

  const d = orm(db);
  // Still ONE `db.batch()`, and therefore still one implicit transaction: the
  // Drizzle D1 driver calls `client.batch(...)` with the built statements.
  //
  // The winner is now decided by `RETURNING` rather than by `meta.changes`.
  // The two are the same claim for an update keyed on the primary key — a row
  // comes back exactly when the WHERE matched — and `RETURNING` is the form
  // that survives the batch's result mapping without depending on the driver
  // passing `meta` through.
  const [updated, selected] = await d.batch([
    d
      .update(approvals)
      .set({
        decision,
        decided_by: decidedBy,
        decided_at: now,
        edited_text: editedText,
        reject_reason: rejectReason,
        updated_at: now,
      })
      .where(and(eq(approvals.id, id), eq(approvals.decision, "pending")))
      .returning({ id: approvals.id }),
    d.select(APPROVAL_COLUMNS).from(approvals).where(eq(approvals.id, id)),
  ]);

  const row = selected[0];
  if (!row) {
    return { result: "not_found" };
  }
  if (updated.length > 0) {
    return { result: "decided", row: toRow(row) };
  }
  return { result: "already_decided", row: toRow(row) };
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
  const d = orm(db);
  const [updated, selected] = await d.batch([
    d
      .update(approvals)
      .set({ decision: "withdrawn", updated_at: now })
      .where(and(eq(approvals.id, id), eq(approvals.decision, "pending")))
      .returning({ id: approvals.id }),
    d.select(APPROVAL_COLUMNS).from(approvals).where(eq(approvals.id, id)),
  ]);

  const row = selected[0];
  if (!row) {
    return { result: "not_found" };
  }
  if (updated.length > 0) {
    return { result: "withdrawn" };
  }
  return { result: "already_decided", row: toRow(row) };
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
  const result = await orm(db)
    .update(approvals)
    .set({ delivery: to, delivery_error: error, updated_at: now })
    .where(and(eq(approvals.id, id), inArray(approvals.delivery, from)))
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
  await orm(db)
    .update(approvals)
    .set({ resolution_delivered_at: now })
    .where(eq(approvals.id, id))
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
  const results = await orm(db)
    .select(APPROVAL_COLUMNS)
    .from(approvals)
    .where(eq(approvals.decision, "pending"))
    .orderBy(asc(approvals.created_at))
    .limit(limit)
    .all();
  return results.map(toRow);
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
  const result = await orm(db)
    .update(approvals)
    .set({ nudged_at: now })
    .where(and(eq(approvals.id, id), isNull(approvals.nudged_at)))
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
  await orm(db)
    .update(approvals)
    .set({ nudge_channel_id: channelId, nudge_ts: ts })
    .where(eq(approvals.id, id))
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
  await orm(db)
    .update(approvals)
    .set({ nudged_at: null })
    .where(eq(approvals.id, id))
    .run();
}

/** Every approval a run has raised, oldest first — the inspector's history. D1 only. */
export async function listByRun(
  db: D1Database,
  runId: string
): Promise<ApprovalRow[]> {
  const results = await orm(db)
    .select(APPROVAL_COLUMNS)
    .from(approvals)
    .where(eq(approvals.run_id, runId))
    .orderBy(asc(approvals.created_at))
    .all();
  return results.map(toRow);
}

/**
 * Decided (approved/edited/rejected/withdrawn) cards whose last change is
 * inside the window, newest first. `updated_at`, not `decided_at`: a withdrawn
 * card has no decider and no `decided_at`, but it did leave the queue.
 */
export async function listDecided(
  db: D1Database,
  sinceMs: number,
  limit = 50
): Promise<ApprovalRow[]> {
  const results = await orm(db)
    .select(APPROVAL_COLUMNS)
    .from(approvals)
    .where(
      and(
        ne(approvals.decision, "pending"),
        sql`${approvals.updated_at} >= ${sinceMs}`
      )
    )
    .orderBy(desc(approvals.updated_at))
    .limit(limit)
    .all();
  return results.map(toRow);
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
  const results = await orm(db)
    .select(APPROVAL_COLUMNS)
    .from(approvals)
    .where(
      and(
        inArray(approvals.decision, ["approved", "edited", "rejected"]),
        isNull(approvals.resolution_delivered_at)
      )
    )
    .orderBy(asc(approvals.decided_at))
    .limit(limit)
    .all();
  return results.map(toRow);
}
