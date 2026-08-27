/**
 * THE REAL `ApprovalPort`: the D1 card, the run's parked flag, and the two
 * follow-ups a fresh card owes a human.
 *
 * This replaces the placeholder that refused with `capability_unavailable`.
 * Three properties are the reason it is a port rather than inline code in the
 * namespace:
 *
 *  - `openApprovalId()` is SYNCHRONOUS and side-effect free, because the
 *    capability layer's `approval_already_open` refusal has to happen host-side
 *    before any effect-ledger row exists. On this chassis that read is
 *    `this.state.openApprovalId`, which is durable and already in memory.
 *  - `open()` never chooses a destination. The channel and thread come from the
 *    run's own pinned scope, snapshotted by the caller; a capability that let
 *    the model name a channel would be a way to escalate into a conversation
 *    this run was never scoped to.
 *  - `withdraw()` LOSES HONESTLY. If a human decided first, their decision
 *    comes back instead of a withdrawal — the old stub reported success
 *    unconditionally, which told the model a message had been retracted when it
 *    may already have gone to the customer (defects 4–6).
 *
 * Nothing here reaches for the wall clock: `now()` is an input, because every
 * timestamp this writes is compared against one a caller already fixed.
 */

import type { Env } from "../index";
import { updateNudge } from "../notify/nudge";
import { CapabilityError } from "../gateways/errors";
import type { ApprovalDecision, ApprovalPort } from "./contracts";
import { getApproval, insertApproval, withdrawApproval } from "./repository";

export type ApprovalPortInput = {
  db: D1Database;
  /** For the withdrawal's nudge edit, which needs the bot token and config. */
  env: Env;
  runId: string;
  /**
   * The turn that is escalating, recorded on the card so a reader can join the
   * decision back to the work that asked for it.
   */
  generationId: string;
  /**
   * The run's PINNED Slack scope, from the D1 `runs` row. Never from the model,
   * a tool argument or a turn's metadata.
   */
  slackThread: { channelId: string; threadTs: string } | null;
  /**
   * The run's shadow flag as of this execution. Snapshotted onto the card so a
   * later delivery can fail closed even if the live row cannot be read; the
   * delivery path ORs it with a fresh read rather than trusting it alone.
   */
  shadow: boolean;
  now: () => number;
  /** `this.state.openApprovalId` — a durable read, not a D1 one. */
  openApprovalId: () => string | null;
  /**
   * The last approval this run opened, decided or not. Consulted only when
   * nothing is open, to tell a redelivered withdrawal apart from one that lost
   * a race to a human.
   */
  lastApprovalId: () => string | null;
  /** Park or unpark the run. The one writer of `state.openApprovalId`. */
  setOpenApproval: (approvalId: string | null) => Promise<void>;
  /**
   * Ask the engineer, and give up waiting eventually. Both are scheduled in the
   * Durable Object rather than awaited here: a Slack call on the tool-call path
   * would put an eight-second timeout inside the model's own `run_code`
   * execution, and the human does not need the DM until the run actually parks.
   */
  scheduleNudge: (approvalId: string) => Promise<void>;
  scheduleExpiry: (approvalId: string) => Promise<void>;
};

export function makeApprovalPort(input: ApprovalPortInput): ApprovalPort {
  const { db } = input;

  return {
    async open({ draft, why }) {
      if (input.slackThread === null) {
        // Approval gates SLACK REPLIES ONLY (global constraint). A chat run has
        // no customer thread to reply in, so there is nothing a human could
        // approve. Refused here rather than discovered later, which would leave
        // a run parked on a card that can never exist.
        throw new CapabilityError(
          "slack_context_required",
          "this run has no customer Slack thread, so there is no reply for a human to approve. Answer here instead."
        );
      }

      const approvalId = `apr:${crypto.randomUUID()}`;
      const now = input.now();

      // THE DATABASE IS THE GUARD, not the namespace's pre-check. One open card
      // per run is `idx_approvals_one_open`, a partial unique index, and this
      // maps its violation to the same code the host-side check raises — so a
      // second escalate racing the first is refused by the constraint even when
      // both read `openApprovalId() === null`.
      const inserted = await insertApproval(db, {
        id: approvalId,
        runId: input.runId,
        generationId: input.generationId,
        draft,
        why,
        channelId: input.slackThread.channelId,
        threadTs: input.slackThread.threadTs,
        shadow: input.shadow,
        now,
      });
      if (inserted === "duplicate_open") {
        throw new CapabilityError(
          "approval_already_open",
          "an approval is already open for this run. Withdraw it first, or wait for the human decision, before escalating again."
        );
      }

      // THE CARD COMMITS BEFORE THE RUN PARKS, and the order is load-bearing in
      // that direction only. A crash between the two leaves a card a human can
      // decide on and a run that is not yet parked — which the resolution
      // unparks anyway. The reverse would park a run on a card that does not
      // exist, and nothing could ever unpark it.
      await input.setOpenApproval(approvalId);
      await input.scheduleNudge(approvalId);
      await input.scheduleExpiry(approvalId);

      return { approvalId };
    },

    openApprovalId() {
      return input.openApprovalId();
    },

    async withdraw() {
      const approvalId = input.openApprovalId();
      if (approvalId === null) {
        // NOTHING OPEN — and there are two ways to get here, which the model
        // must not be told the same thing about.
        //
        // The capability layer refuses a withdraw with no open approval before
        // this port is ever called, so reaching this line means the flag moved
        // between that check and this call: the model's program awaited
        // something and a human's decision was carried in meanwhile. Reporting
        // a withdrawal then would be a lie about a message that may already
        // have gone to the customer. The other way is a genuine redelivery of a
        // withdrawal that already succeeded, and `withdrawn: true` is the
        // truthful answer for that one. The D1 row tells them apart.
        return settledDecision(db, input.lastApprovalId());
      }

      // LOCAL FIRST, D1 SECOND. The run is unparked before the CAS so a D1
      // failure cannot leave a run parked on a card the model has already been
      // told it retracted; the card left behind is `pending`, which the human
      // can still decide and the resolution path still unparks.
      const now = input.now();
      await input.setOpenApproval(null);

      const result = await withdrawApproval(db, approvalId, now);
      if (
        result.result === "already_decided" &&
        result.row.decision !== "pending" &&
        result.row.decision !== "withdrawn"
      ) {
        // A HUMAN GOT THERE FIRST. Their decision wins and comes back to the
        // model instead of a withdrawal. The run stays UNPARKED: the decision's
        // own resolution turn is what carries it in, and re-parking here would
        // race that turn for the right to be last.
        return { withdrawn: false, decision: result.row.decision };
      }

      // EVERY REMAINING RESULT IS A COMPLETED WITHDRAWAL and they share one
      // answer. `not_found` lands here correctly — a card that was never
      // written is a withdrawal that is already complete — and so does a row
      // already `withdrawn`, which is a redelivery of this very call.
      //
      // THE ENGINEER'S NUDGE, IF ONE WENT OUT, NOW POINTS AT A CARD NOBODY CAN
      // ACT ON. Rewriting it is best-effort in the strong sense: `updateNudge`
      // never throws and makes no Slack call when no nudge was recorded, so a
      // Slack outage cannot turn a completed withdrawal into a failed
      // capability call.
      const withdrawn = await getApproval(db, approvalId);
      if (withdrawn !== null) await updateNudge(input.env, withdrawn);

      return { withdrawn: true };
    },
  };
}

/**
 * What to tell a caller that found nothing open to withdraw: the human's
 * decision if one landed, else a plain withdrawal.
 *
 * `withdrawn`, a missing row and a missing id all mean the same thing — this
 * run has no outstanding approval and nothing was sent — which is the same
 * answer a redelivered withdrawal gets. So does a still-`pending` row: the flag
 * was cleared without the card being settled, which is the documented hole a D1
 * failure leaves behind, and the model has genuinely retracted as far as this
 * run is concerned.
 */
async function settledDecision(
  db: D1Database,
  approvalId: string | null
): Promise<
  | { withdrawn: true }
  | {
      withdrawn: false;
      decision: Exclude<ApprovalDecision, "pending" | "withdrawn">;
    }
> {
  if (approvalId === null) return { withdrawn: true };
  const row = await getApproval(db, approvalId);
  if (
    row === null ||
    row.decision === "pending" ||
    row.decision === "withdrawn"
  ) {
    return { withdrawn: true };
  }
  return { withdrawn: false, decision: row.decision };
}
