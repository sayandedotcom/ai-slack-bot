import { CapabilityError } from "../codemode/errors";
import type { Env } from "../index";
import { updateNudge } from "../notify/nudge";
import {
  enqueueProjectionJob,
  latestApprovalState,
  openApproval,
  putApprovalState,
  resolveApprovalState,
} from "../run/session";
import type { ApprovalPort } from "./contracts";
import { getApproval, withdrawApproval } from "./repository";

/**
 * THE REAL `ApprovalPort`: the RunDO's local approval record, plus the D1 card
 * projected from it.
 *
 * This replaces Task 3's execution-local stand-in wholesale. That stand-in
 * remembered an approval for the length of one `run_code` execution and forgot
 * it afterwards, which made `escalate` a no-op the finalize latch could never
 * see; it existed only because the storage this file writes to did not exist
 * yet (RunDO schema v6, `approval_state`).
 *
 * Two properties are the reason this is a port at all:
 *
 *  - `open` NEVER BLOCKS (invariant 2). It writes one local row and enqueues a
 *    projection job — both synchronous, both durable, neither touching D1 or
 *    the network — and returns. The isolate cannot park a run; the pause
 *    latches at generation finalize, from the row this wrote.
 *  - `openApprovalId` is SYNCHRONOUS and side-effect free, because the
 *    capability layer's `approval_already_open` refusal has to happen
 *    host-side before any effect-ledger row exists, and because finalize reads
 *    the same state from inside a `transactionSync`.
 */
export type ApprovalPortInput = {
  storage: DurableObjectStorage;
  db: D1Database;
  runId: string;
  /**
   * The generation that is escalating. Recorded on the local row so the D1
   * card can name it even if this generation later crashes before its own
   * finalize — see `applyV6`.
   */
  generationId: string;
  /**
   * The run's PINNED Slack scope, from `run_state`. Never from the model, a
   * tool argument or a turn's metadata: a capability that let the model name a
   * channel would be a way to escalate into a conversation this run was never
   * scoped to.
   */
  slackThread: { channelId: string; threadTs: string } | null;
  now: () => number;
  /**
   * For the withdrawal's nudge edit (`updateNudge`), which needs the bot token
   * and the nudge configuration.
   *
   * REQUIRED, deliberately, even though nothing in `open` or `openApprovalId`
   * reads it. Optional, a construction site that forgot it would compile, and
   * the only symptom would be a withdrawn card whose engineer DM still shows a
   * live "Review" button — indistinguishable from the world before this
   * existed, in production and in CI alike. A missing input that silently
   * disables a feature has to be a type error or it is nothing.
   */
  env: Env;
};

export function makeApprovalPort(input: ApprovalPortInput): ApprovalPort {
  const { storage, db } = input;

  return {
    async open({ draft, why }) {
      if (input.slackThread === null) {
        // Approval gates SLACK REPLIES ONLY (global constraint). A Chat run has
        // no customer thread to reply in, so there is nothing a human could
        // approve — refused here rather than discovered by the projector, which
        // would leave a run parked on a card that can never exist.
        throw new CapabilityError(
          "slack_context_required",
          "this run has no customer Slack thread, so there is no reply for a human to approve. Answer here instead.",
        );
      }

      const approvalId = `apr:${crypto.randomUUID()}`;
      const now = input.now();

      // One transaction: a crash between the record and its projection job
      // would leave an approval that parks the run but never reaches the
      // dashboard — a run nobody can unpark, which is the worst state this
      // whole feature can reach.
      storage.transactionSync(() => {
        putApprovalState(storage, {
          approvalId,
          generationId: input.generationId,
          draft,
          why,
          now,
        });
        enqueueProjectionJob(storage, "approval_card", approvalId, now);
      });

      return { approvalId };
    },

    openApprovalId() {
      return openApproval(storage)?.approvalId ?? null;
    },

    async withdraw() {
      const open = openApproval(storage);
      if (open === null) {
        // NOTHING OPEN — and there are two ways to get here, which the model
        // must not be told the same thing about.
        //
        // The capability layer refuses a withdraw with no open approval before
        // this port is ever called, so reaching this line means the row moved
        // between that check and this call: the model's program awaited
        // something, and a human's decision was carried in meanwhile. Reporting
        // a withdrawal then would be a lie about a message that may already
        // have gone to the customer.
        //
        // The other way is a genuine redelivery of a withdrawal that already
        // succeeded, and `withdrawn: true` is the truthful answer for that one.
        // The D1 row tells them apart.
        return await settledDecision(db, latestApprovalState(storage)?.approvalId ?? null);
      }

      // LOCAL FIRST, D1 SECOND, and the order is load-bearing. The projector
      // re-reads this row before inserting, so resolving it here is what stops
      // a card being created for an approval that no longer exists. Doing the
      // D1 CAS first would leave a window where the projector inserts a card
      // that the just-completed withdrawal can no longer reach.
      const now = input.now();
      resolveApprovalState(storage, open.approvalId, "resolved", now);

      const result = await withdrawApproval(db, open.approvalId, now);
      if (
        result.result === "already_decided"
        && result.row.decision !== "pending"
        && result.row.decision !== "withdrawn"
      ) {
        // A HUMAN GOT THERE FIRST. The decision wins (invariant 5) and comes
        // back to the model instead of a withdrawal.
        //
        // THE LOCAL ROW IS LEFT SETTLED — it must not be put back into the open
        // set, and this is the subtlest decision in the file.
        //
        // The tempting move is to reopen it (`resolved -> resolving`) so the
        // run stays parked until the resolution turn carries the decision in.
        // That reopen can strand the run forever. `resolveApproval` settles the
        // local row and THEN commits the turn; a withdraw racing it can land
        // after that settle, and its reopen would then be the last write. The
        // resolution has already retired its repair key
        // (`resolution_delivered_at`) and its turn id is already present, so
        // nothing re-settles the row — and the next finalize parks a run whose
        // decision has already been delivered, with nothing left to unpark it.
        //
        // Leaving it settled is safe in the other direction, because the
        // decision's delivery does not depend on this row at all: the PATCH
        // notifies the DO, and the sweeper re-drives any notification that
        // failed, both keyed on D1. The worst case is a generation that settles
        // `completed` instead of `paused` a moment before the resolution turn
        // arrives and wakes a new one — a run that resumes early WITH the
        // decision in its transcript, rather than a run nobody can restart.
        return { withdrawn: false, decision: result.row.decision };
      }
      // EVERY REMAINING RESULT IS A COMPLETED WITHDRAWAL, and they share one
      // answer. `not_found` lands here correctly: the card had not been
      // projected yet, so the withdrawal is complete the moment the local row
      // is resolved and the projector drops the job. So does a row already
      // `withdrawn` — a redelivery of this very call.
      //
      // THE ENGINEER'S NUDGE, IF ONE WENT OUT, NOW POINTS AT A CARD NOBODY CAN
      // ACT ON. Rewriting it is best-effort in the strong sense — `updateNudge`
      // never throws and makes no Slack call when no nudge message was recorded
      // — so a Slack outage cannot turn a completed withdrawal into a failed
      // capability call. The row is re-read because `withdrawApproval` reports
      // only that it moved: this read is what supplies the recorded
      // channel/`ts`, and it happens only on this path, the one that withdrew.
      const withdrawn = await getApproval(db, open.approvalId);
      if (withdrawn !== null) await updateNudge(input.env, withdrawn);

      return { withdrawn: true };
    },
  };
}

/**
 * What to tell a caller that found nothing open to withdraw: the human's
 * decision if one landed, else a plain withdrawal.
 *
 * The D1 row is asked rather than the local record because the local record
 * says only "settled", not "settled by whom". `withdrawn`, a missing row and a
 * missing id all mean the same thing here — this run has no outstanding
 * approval and nothing was sent — which is `withdrawn: true`, the same answer a
 * redelivered withdrawal gets. So does a still-`pending` row: that is the
 * documented hole where a D1 outage left the card behind after the local record
 * was already settled, and the model has genuinely retracted as far as this run
 * is concerned.
 */
async function settledDecision(
  db: D1Database,
  approvalId: string | null,
): Promise<Awaited<ReturnType<ApprovalPort["withdraw"]>>> {
  if (approvalId === null) return { withdrawn: true };
  const row = await getApproval(db, approvalId);
  if (row === null || row.decision === "pending" || row.decision === "withdrawn") {
    return { withdrawn: true };
  }
  return { withdrawn: false, decision: row.decision };
}
