/**
 * Sending an approved reply, as the on-duty engineer.
 *
 * A port with one method and, in Phase 11, one production implementation that
 * refuses. The seam exists now rather than later because the RESOLUTION path
 * is the thing being built — the RunDO has to have somewhere to hand the
 * approved text — and because a test needs a way to drive `sent` and
 * `in_doubt` outcomes that no code in this checkout can actually produce.
 */

export type ApprovalSendResult =
  /** It went out. `ts` is the Slack message timestamp. */
  | { result: "sent"; ts: string }
  /** It will never go out under this deployment's configuration. TERMINAL. */
  | { result: "blocked"; reason: string }
  /** The attempt's outcome is UNKNOWN. A human reconciles; nothing retries. */
  | { result: "in_doubt"; reason: string };

export interface ApprovalSender {
  /**
   * Send the approved/edited text to the run's pinned thread AS the on-duty
   * engineer.
   *
   * `channelId`/`threadTs` are re-derived by the CALLER from the run's own
   * state at delivery time (invariant 10). They are not on this input so that
   * an implementation can pick a destination — they are on it so that no
   * implementation ever has to, and so that the value a sender receives is
   * provably host state rather than the card's display snapshot or anything
   * the model said.
   */
  send(input: {
    runId: string;
    channelId: string;
    threadTs: string;
    text: string;
  }): Promise<ApprovalSendResult>;
}

/**
 * The one reason Phase 11 can ever block on, and it is a configuration fact
 * rather than an error: there is no engineer identity to speak as yet.
 */
export const IDENTITY_UNAVAILABLE = "identity_unavailable";

/**
 * THE PHASE 11 PRODUCTION SENDER. It refuses, every time.
 *
 * Customer-facing speech carries a human's name. Phase 12 resolves the on-duty
 * engineer and their encrypted user token; until it does, there is nobody to
 * send as — and there is NO BOT-TOKEN FALLBACK, ever. The bot token exists for
 * ingestion, permalinks and later nudges; using it here would mean the product
 * says something to a customer that no person said, which is the exact failure
 * the identity design exists to prevent. `src/slack/gateway.ts`'s `reply`
 * refuses for the same reason and with the same code.
 *
 * `blocked` is therefore TERMINAL in Phase 11, and the run STILL RESUMES on it.
 * That combination looks wrong until you price the alternative: a run parked
 * until a delivery that cannot happen before Phase 13 would strand every real
 * escalation for weeks, on a decision a human has already made. The decision is
 * a fact the moment it is written; whether the message went out is a separate
 * state machine, and the resolution turn says honestly that the approved draft
 * needs sending by hand.
 */
export function makeIdentityRefusingSender(): ApprovalSender {
  return {
    async send(): Promise<ApprovalSendResult> {
      return { result: "blocked", reason: IDENTITY_UNAVAILABLE };
    },
  };
}
