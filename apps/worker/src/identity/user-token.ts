import type { Env } from "../index";
import { getIdentity } from "../db/identities";
import { onDuty } from "./rotation";
import { getDecryptedToken } from "./tokens";

/**
 * The one question the customer-facing send path is allowed to ask about
 * credentials: "whose token do I speak as right now, and what is it?"
 *
 * It is a PORT rather than a bare function because the sender must be testable
 * without a database, a key, or a rotation — and because the answer is the most
 * dangerous value in the system. Narrowing the surface to a single method with a
 * single return shape means nothing downstream can wander into `identities`,
 * pick a different email, or reach for a bot token when the honest answer is
 * "nobody has connected Slack".
 */

/** A live credential belonging to a HUMAN. Never logged, never returned to a caller. */
export type UserToken = {
  token: string;
  slackUserId: string;
  email: string;
};

export interface UserTokenSource {
  /** The on-duty engineer's decrypted Slack user token, or null when
   *  unconnected. Never throws for "not connected" — null is the honest answer. */
  onDutyToken(nowMs: number): Promise<UserToken | null>;
}

/**
 * The production source: rotation → identity row → decrypted token.
 *
 * `nowMs` is a parameter rather than `Date.now()` inside because the shift is
 * the thing that decides WHOSE identity gets used, and a caller that already
 * knows the instant it is acting at must not get a different answer from a
 * clock read microseconds later.
 *
 * Two failure shapes, deliberately different, inherited from
 * `getDecryptedToken`: a missing row is `null` (an engineer who has not clicked
 * "connect Slack" yet — ordinary, and the sender turns it into an honest
 * `blocked`), while a row that will not open throws `SealError` (a tampered
 * database or a mis-rotated key — never quietly downgraded to "not connected",
 * because silence there would look exactly like the ordinary case).
 */
export function makeUserTokenSource(env: Env): UserTokenSource {
  return {
    async onDutyToken(nowMs: number): Promise<UserToken | null> {
      const { email } = onDuty(nowMs);
      const row = await getIdentity(env.DB, email, "slack");
      if (!row) return null;

      const token = await getDecryptedToken(env, email, "slack");
      if (!token) return null;

      return { token, slackUserId: row.externalId, email };
    },
  };
}
