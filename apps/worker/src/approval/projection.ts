import {
  safeErrorText,
  type AgentProjectionRunner,
  type ClaimedProjectionJob,
  type ProjectionOutcome,
} from "../agent/driver";
import { readApprovalState, readState } from "../run/session";
import { getRunById } from "../run/repository";
import { getApproval, insertApproval } from "./repository";

/**
 * The `approval_card` projection: one local `approval_state` row becomes one
 * D1 `approvals` card the dashboard can list.
 *
 * A new KIND on the existing projection machinery, not a new mechanism. It
 * uses `agent_projection_jobs`, the existing claim/lease/backoff, and the
 * existing alarm dispatcher — the same route `run_index`, `d1_usage` and
 * `memory_outbox` take. A second projection path would be a second set of
 * retry semantics to keep correct, on the one projection whose failure leaves
 * a run parked with nothing for a human to decide.
 *
 * Everything it needs about the destination comes from HOST state — the run's
 * own `run_state` row for the channel and thread, the D1 `runs` row for
 * `shadow` — and nothing from the model (invariant 10). `shadow` is read at
 * delivery rather than snapshotted at escalation time so an observing run's
 * card is honestly labelled by the same source the sender will re-check.
 */
export function makeApprovalCardRunner(input: {
  storage: DurableObjectStorage;
  db: D1Database;
}): AgentProjectionRunner {
  const { storage, db } = input;

  return {
    async run(job: ClaimedProjectionJob): Promise<ProjectionOutcome> {
      const approvalId = job.job.sourceId;
      const local = readApprovalState(storage, approvalId);

      // `dropped`, not `retry`. Both of these are work that can never be
      // delivered, and retrying forever would keep an alarm armed on a job
      // with no content: the row is gone, or the model withdrew the approval
      // before the first projection pass ever ran, in which case creating the
      // card now would put a decision in front of a human that nothing is
      // waiting on.
      if (local === null) {
        return { outcome: "dropped", reason: "no local approval_state row" };
      }
      if (local.state !== "open") {
        return { outcome: "dropped", reason: `approval is ${local.state}, not open` };
      }

      const state = readState(storage);
      if (state === null || state.channelId === null || state.threadTs === null) {
        return { outcome: "dropped", reason: "the run has no pinned Slack thread" };
      }

      try {
        const run = await getRunById(db, job.runId);
        if (run === null) {
          // The card's `run_id` is a foreign key. Inserting against a run row
          // that is not there fails the constraint every time, so this is not
          // something a retry can heal.
          return { outcome: "dropped", reason: "the run is not in the D1 index" };
        }

        const result = await insertApproval(db, {
          id: approvalId,
          runId: job.runId,
          generationId: local.generationId,
          draft: local.draft,
          why: local.why,
          channelId: state.channelId,
          threadTs: state.threadTs,
          shadow: run.shadow,
          now: local.createdAt,
        });

        if (result === "created") return { outcome: "delivered" };

        // `duplicate_open` IS SUCCESS — but only once we know the collision is
        // THIS card. Alarm delivery is at-least-once and a generation retries,
        // so the ordinary case is a redelivery of a card that is already there,
        // and retrying that until the job's budget is gone would strand a run
        // that is correctly parked.
        //
        // The check is not ceremony, because `idx_approvals_one_open` is on
        // `run_id`, NOT on `id`: it refuses ANY unsettled card on this run. The
        // reachable path is a `withdraw` whose local write landed and whose D1
        // CAS then failed in an outage — the old row stays `pending` while the
        // local slot is free, the model escalates again, and this insert
        // collides with the OLD card. Retiring the job there would park the run
        // on an approval the dashboard has no card for: a run nobody can
        // unpark, which is the one outcome this whole feature must not reach.
        // So: retry, visibly, and let the D1 outage clear or a human see it.
        const existing = await getApproval(db, approvalId);
        if (existing !== null) return { outcome: "delivered" };
        return {
          outcome: "retry",
          error: `another unsettled approval already holds run ${job.runId}; this card was not created`,
        };
      } catch (error) {
        // Everything else — a D1 outage, a network failure — is genuinely
        // transient and goes back through the job's own bounded backoff.
        return { outcome: "retry", error: safeErrorText(error, "the approval card failed to project") };
      }
    },
  };
}
