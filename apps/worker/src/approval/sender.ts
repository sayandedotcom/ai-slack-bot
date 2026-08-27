/**
 * Sending an approved reply, as a fire-fighter — the approver when they have
 * connected Slack, the default speaker otherwise (src/identity/speaker.ts).
 *
 * A port with one method and, in Phase 11, one production implementation that
 * refuses. The seam exists now rather than later because the RESOLUTION path
 * is the thing being built — the RunDO has to have somewhere to hand the
 * approved text — and because a test needs a way to drive `sent` and
 * `in_doubt` outcomes that no code in this checkout can actually produce.
 *
 * Phase 13 adds the real implementation below the refusing one; both stay,
 * because the refusing sender is still what a deployment without identities
 * gets, and what several tests drive.
 */

import type { UserTokenSource } from "../identity/user-token";

export type ApprovalSendResult =
  /** It went out. `ts` is the Slack message timestamp. */
  | { result: "sent"; ts: string }
  /** It will never go out under this deployment's configuration. TERMINAL. */
  | { result: "blocked"; reason: string }
  /** The attempt's outcome is UNKNOWN. A human reconciles; nothing retries. */
  | { result: "in_doubt"; reason: string };

export interface ApprovalSender {
  /**
   * Send the approved/edited text to the run's pinned thread AS a fire-fighter
   * (`decidedBy` if connected, else the default speaker).
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
    /**
     * Who decided the approval, if anyone did. The sender speaks as this
     * person when they have connected Slack — the human who signed off is the
     * name on the message — and as the default speaker otherwise. `null` for
     * a delivery with no human decision behind it.
     */
    decidedBy: string | null;
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
 * Customer-facing speech carries a human's name. Phase 12 resolves the speaker
 * and their encrypted user token; until it does, there is nobody to
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

/** No fire-fighter has connected a Slack account. Configuration, not error. */
export const NOT_CONNECTED = "no fire-fighter has connected Slack";

/**
 * The only thing we are entitled to say when the request's fate is unknown: it
 * MAY have reached the customer. Never retried, never called a failure.
 */
export const OUTCOME_UNKNOWN = "send attempted; outcome unknown";

/** Slack's error vocabulary is snake_case codes; anything else is not one. */
const SLACK_ERROR_CODE = /^[a-z0-9_]{1,64}$/;

const POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";

type PostMessageResponse = { ok?: unknown; ts?: unknown; error?: unknown };

/**
 * THE PHASE 13 PRODUCTION SENDER: `chat.postMessage` under the ON-DUTY
 * ENGINEER'S OWN user token, into the run's pinned thread.
 *
 * Still no bot-token fallback — a source that returns null is an honest
 * `blocked`, not an excuse to speak as the app. The whole point of the identity
 * work is that a customer-facing sentence carries a human's name.
 *
 * The outcome mapping is about what a HUMAN will do next, not about HTTP:
 *
 * - `ok:true` → `sent`, carrying Slack's `ts` so the thread can be found again.
 * - `ok:false` → `blocked`. Slack answered; the message definitively did not go
 *   out (`invalid_auth`, `channel_not_found`, …). Terminal, and safe to say so.
 * - a thrown request, or a 200 that is not JSON (a proxy page, a captive
 *   portal) → `in_doubt`. The request may well have been delivered and only the
 *   response lost. Claiming failure there risks a duplicate reply to a customer;
 *   claiming success risks silence. So we claim neither and a human reconciles.
 *
 * A `SealError` from the source is NOT caught: corrupt ciphertext or a
 * mis-rotated key must stay loud rather than be laundered into `in_doubt`.
 *
 * No reason this function returns is ever derived from the token, and Slack's
 * `error` is admitted only if it matches Slack's own code shape — so an upstream
 * that echoed a credential back at us still cannot get it into a stored reason.
 */
export function makeUserTokenSender(
  source: UserTokenSource,
  fetchImpl?: typeof fetch
): ApprovalSender {
  return {
    async send(input): Promise<ApprovalSendResult> {
      const credential = await source.speakerToken(input.decidedBy);
      if (!credential) return { result: "blocked", reason: NOT_CONNECTED };

      let body: PostMessageResponse;
      try {
        const doFetch = fetchImpl ?? fetch;
        const response = await doFetch(POST_MESSAGE_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential.token}`,
            "content-type": "application/json; charset=utf-8",
          },
          // The approved text goes out byte-exact: no prefix, no signature, no
          // "sent by" footer. A human signed off on these exact characters.
          body: JSON.stringify({
            channel: input.channelId,
            thread_ts: input.threadTs,
            text: input.text,
          }),
        });
        body = (await response.json()) as PostMessageResponse;
      } catch {
        // Deliberately swallows the thrown value: it can carry request detail,
        // and nothing in it changes what we are able to claim.
        return { result: "in_doubt", reason: OUTCOME_UNKNOWN };
      }

      if (body?.ok === true && typeof body.ts === "string") {
        return { result: "sent", ts: body.ts };
      }
      if (body?.ok === false) {
        const error = body.error;
        return {
          result: "blocked",
          reason:
            typeof error === "string" && SLACK_ERROR_CODE.test(error)
              ? error
              : "slack refused the send",
        };
      }
      // Well-formed JSON that is neither — an unrecognised shape says nothing
      // about delivery, so it is in doubt like any other unreadable answer.
      return { result: "in_doubt", reason: OUTCOME_UNKNOWN };
    },
  };
}
