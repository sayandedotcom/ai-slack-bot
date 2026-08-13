import {
  safeErrorText,
  type AgentProjectionRunner,
  type ClaimedProjectionJob,
  type ProjectionOutcome,
} from "../agent/driver";
import { readApprovalState, readState } from "../run/session";
import { getRunById } from "../run/repository";
import { insertApproval } from "./repository";

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

        // `duplicate_open` IS SUCCESS. Alarm delivery is at-least-once and a
        // generation retries: the same card is projected twice whenever an
        // attempt commits the D1 insert and dies before the job is retired.
        // The partial unique index refusing the second insert means the card
        // this job exists to create is already there — treating that as an
        // error would retry a job that can only ever fail, until its budget is
        // gone, on a run that is correctly parked.
        void result;
        return { outcome: "delivered" };
      } catch (error) {
        // Everything else — a D1 outage, a network failure — is genuinely
        // transient and goes back through the job's own bounded backoff.
        return { outcome: "retry", error: safeErrorText(error, "the approval card failed to project") };
      }
    },
  };
}
