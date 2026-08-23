/**
 * The trusted envelope every vendor call runs inside.
 *
 * Resolved once, host-side, from sources a model cannot influence: the run's
 * D1 row, the channel policy, and the speaker rule. It is passed to a gateway
 * as an argument and is never handed to model-authored code, so nothing the
 * model writes can widen a customer scope, redirect a Slack reply, or claim an
 * identity.
 *
 * Each field has exactly one trusted source:
 *
 * | field                  | trusted source            | row missing            |
 * | ---------------------- | ------------------------- | ---------------------- |
 * | runId, origin          | the D1 `runs` row         | caller cannot build it |
 * | slackThread            | the D1 `runs` row         | (as above)             |
 * | shadow                 | the D1 `runs` row         | REFUSE (fail closed)   |
 * | customerSlug           | the D1 channel policy     | null (no customer)     |
 * | actor                  | speaker rule + identities | null (nobody to speak) |
 *
 * Two properties are worth stating separately, because both have been gotten
 * wrong here before:
 *
 *  - `shadow` is a D1 read, and a missing `runs` row must REFUSE rather than
 *    default to `false`. An unconfirmable run is not a permitted one.
 *  - `customerSlug` comes from the channel policy, never from turn metadata,
 *    tool arguments, or model text. An unknown channel yields `null`, which
 *    makes customer-scoped reads refuse rather than silently widening.
 */
export type RunScope = {
  runId: string;
  turnId: string;
  origin: "slack" | "chat";
  /**
   * The run's shadow flag AS OF RESOLUTION. A snapshot, carried for
   * diagnostics — deliberately NOT an authorization.
   *
   * Do not add a consumer that authorizes a write from this field. An operator
   * flipping a run to shadow mid-run must stop the NEXT write, so the check
   * that gates an external write has to re-read the D1 `runs` row at call
   * time. A reader that trusted this value would fail silently, because the
   * snapshot is usually correct.
   */
  shadow: boolean;
  customerSlug: string | null;
  slackThread: {
    channelId: string;
    threadTs: string;
  } | null;
  actor: {
    engineerEmail: string;
    slackUserId: string | null;
  } | null;
};
