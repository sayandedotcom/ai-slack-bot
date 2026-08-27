import type { Env } from "../index";
import { resolveSpeaker } from "./speaker";
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
  /**
   * The speaker's decrypted Slack user token, or null when no fire-fighter has
   * connected Slack. `preferredEmail` is the human who decided an approval —
   * they speak if they have connected; otherwise the default speaker does (see
   * `src/identity/speaker.ts`). Never throws for "not connected" — null is the
   * honest answer.
   */
  speakerToken(preferredEmail?: string | null): Promise<UserToken | null>;
}

/**
 * The production source: speaker rule → identity row → decrypted token.
 *
 * No clock. The old `onDutyToken(nowMs)` took an instant because a rotation
 * decided WHOSE identity was used; the speaker rule is a function of who has
 * connected, so there is no instant to get wrong.
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
    async speakerToken(
      preferredEmail?: string | null
    ): Promise<UserToken | null> {
      const speaker = await resolveSpeaker(env.DB, "slack", preferredEmail);
      if (!speaker) return null;

      const token = await getDecryptedToken(env, speaker.email, "slack");
      if (!token) return null;

      return { token, slackUserId: speaker.externalId, email: speaker.email };
    },
  };
}
