/**
 * The one host-side gate on capabilities that leave this system.
 *
 * Two properties matter more than the code:
 *
 *  - IT RE-READS D1 AT CALL TIME. `scope.shadow` is a snapshot taken when the
 *    turn started and is deliberately not consulted; an operator flipping a run
 *    to shadow mid-run has to stop the NEXT write, and a guard that trusted the
 *    snapshot would fail silently because the snapshot is usually correct.
 *  - IT FAILS CLOSED. A missing `runs` row refuses, a channel absent from the
 *    `channels` table refuses. An unconfirmable run is not a permitted one.
 *
 * Only `external_write` is gated. `read` touches nothing; `control_write` is
 * this run's own approval state, which a shadow run must still be able to use
 * (a shadow run drafts and escalates, it just never sends); `sandbox_write`
 * acts on a container that holds no write credentials and can reach nobody.
 */
import { canPost, getChannelPolicy } from "../db/channels";
import { CapabilityError } from "../gateways/errors";
import type { RunScope } from "../gateways/scope";
import { getRunById } from "../run/repository";
import type { CapabilityEffect } from "./define";

export type WriteGuardDeps = { db: D1Database };

/**
 * Two D1 reads, taken immediately before the write.
 *
 * Order is deliberate: the channel check first, because "this channel is not
 * postable" is the more useful refusal for a model to read, and it is true
 * regardless of the run's shadow flag.
 */
export async function assertExternalWritePermitted(
  deps: WriteGuardDeps,
  scope: RunScope
): Promise<void> {
  if (scope.origin === "slack") {
    if (scope.slackThread === null) {
      throw new CapabilityError(
        "slack_context_required",
        "this run has no Slack thread to write to"
      );
    }
    const policy = await getChannelPolicy(deps.db, scope.slackThread.channelId);
    if (!canPost(policy)) {
      // Covers observe, internal, and absent-from-the-table alike. `canPost`
      // requires `known && mode === "live"`, so the fail-closed case needs no
      // separate branch here.
      throw new CapabilityError(
        "channel_read_only",
        "this channel is not postable"
      );
    }
  }

  const record = await getRunById(deps.db, scope.runId);
  if (record === null || record.shadow) {
    throw new CapabilityError(
      "shadow_write_denied",
      "this run may not write to the outside world"
    );
  }
}

export async function assertEffectPermitted(
  deps: WriteGuardDeps,
  scope: RunScope,
  effect: CapabilityEffect
): Promise<void> {
  if (effect !== "external_write") return;
  await assertExternalWritePermitted(deps, scope);
}
