import { CapabilityError } from "../codemode/errors";
import {
  enqueueProjectionJob,
  openApproval,
  putApprovalState,
  resolveApprovalState,
} from "../run/session";
import type { ApprovalPort } from "./contracts";
import { withdrawApproval } from "./repository";

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
        // The capability layer refuses this before reaching the port, so this
        // is the redelivery case: nothing open means nothing to retract, and
        // reporting a withdrawal is the truthful answer for a caller whose
        // first attempt already succeeded.
        return { withdrawn: true };
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
        // A human got there first. The decision wins (invariant 5), so the
        // local row goes back to unsettled: the run must stay parked until the
        // resolution turn carries that decision in.
        storage.sql.exec(
          "UPDATE approval_state SET state = 'resolving', updated_at = ? WHERE approval_id = ?",
          now,
          open.approvalId,
        );
        return { withdrawn: false, decision: result.row.decision };
      }
      // `not_found` lands here too, and correctly: the card had not been
      // projected yet, so the withdrawal is complete the moment the local row
      // is resolved and the projector drops the job. So does a row already
      // `withdrawn` — a redelivery of this very call.
      return { withdrawn: true };
    },
  };
}
