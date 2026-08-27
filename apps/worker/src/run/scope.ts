/**
 * Building the trust envelope every vendor call runs inside.
 *
 * Each field of `RunScope` has exactly one trusted source, and none of them is
 * anything the model wrote. See the type's own doc comment in
 * `src/gateways/scope.ts` for the table; this module is the resolver.
 *
 * The two rules that have been gotten wrong before, restated because this is
 * where they are enforced:
 *
 *  - a MISSING `runs` row refuses rather than defaulting `shadow` to false. An
 *    unconfirmable run is not a permitted one.
 *  - `customerSlug` comes from the channel policy, never from turn metadata,
 *    tool arguments or model text. An unknown channel yields null, which makes
 *    customer-scoped reads refuse rather than silently widening.
 */
import { getChannelPolicy } from "../db/channels";
import { CapabilityError } from "../gateways/errors";
import type { RunScope } from "../gateways/scope";
import { resolveSpeaker } from "../identity/speaker";
import type { Env } from "../index";
import { getRunById } from "./repository";

export async function resolveRunScope(
  env: Env,
  runId: string,
  turnId: string
): Promise<RunScope> {
  const run = await getRunById(env.DB, runId);
  if (run === null) {
    throw new CapabilityError(
      "invalid_context",
      "this run has no record, so it cannot act"
    );
  }

  const slackThread =
    run.channelId !== null && run.threadTs !== null
      ? { channelId: run.channelId, threadTs: run.threadTs }
      : null;

  const customerSlug =
    slackThread === null
      ? null
      : ((await getChannelPolicy(env.DB, slackThread.channelId))
          .customer_slug ?? null);

  // The speaker rule, not a rotation: the approver if they clicked and have
  // connected Slack, else the first roster entry who has. Nobody connected
  // means no actor, and every customer-facing write then refuses.
  const speaker = await resolveSpeaker(env.DB, "slack");

  return {
    runId: run.id,
    turnId,
    origin: run.origin,
    // A snapshot for diagnostics. NOT an authorization — the write guard
    // re-reads this row at call time, because an operator flipping a run to
    // shadow mid-run has to stop the next write.
    shadow: run.shadow,
    customerSlug,
    slackThread,
    actor:
      speaker === null
        ? null
        : {
            engineerEmail: speaker.email,
            slackUserId: speaker.externalId ?? null,
          },
  };
}
