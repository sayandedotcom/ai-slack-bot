import type { Env } from "../index";
import type { ResolutionNotifier } from "../api/approvals";
import { runStubForKey } from "../run/keys";
import { getRunById } from "../run/repository";

/**
 * THE WIRING between the dashboard's decision and the run it belongs to: the
 * `ResolutionNotifier` the approvals API declares, backed by the owning
 * RunDO's `resolveApproval` RPC.
 *
 * Its own file, and a small one, because it is the only place in the system
 * where an HTTP request turns into a Durable Object call for approval state.
 * Until this existed, an unwired notifier and a dead DO were indistinguishable
 * — both produce `resolutionDelivered: false` — so the absence of this
 * composition would have looked exactly like the failure it is supposed to
 * repair.
 *
 * `runId -> key -> stub`, never `runId -> stub`. The Durable Object name is
 * the run's origin key, which is deliberately not the public `runs.id` a
 * browser sees (invariant 10); D1 is what maps one to the other, and
 * `runStubForKey` re-validates the key before it names an object.
 */
export function makeRunDoResolutionNotifier(env: Env): ResolutionNotifier {
  return {
    async notify(input) {
      const run = await getRunById(env.DB, input.runId);
      if (run === null) {
        // A decided approval whose run is not in the index. Not deliverable
        // and not repairable by retrying, but reported as undelivered rather
        // than thrown: the caller must not have a human's committed decision
        // turned into a failed request (invariant 9).
        return { applied: false };
      }
      return runStubForKey(env.RUNS, run.key).resolveApproval({
        approvalId: input.approvalId,
        decision: input.decision,
        outboundText: input.outboundText,
        rejectReason: input.rejectReason,
        decidedBy: input.decidedBy,
      });
    },
  };
}
