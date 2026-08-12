import type {
  ClaimSnapshot,
  DriverState,
  FinalizeRequest,
  ProjectionJob,
  ProjectionJobKind,
  ResumePolicy,
} from "./contracts";
import { CLAIM_LEASE_MS, CONTINUATION_TOTAL_MS, DRIVER_MAX_ATTEMPTS } from "./limits";

/**
 * The driver's ports and its scheduling arithmetic.
 *
 * Pure module: no storage, no D1, no `ai` import, no provider. It defines WHAT
 * the alarm hands to the model loop and what it accepts back, and it computes
 * WHEN the single alarm slot should next fire — nothing else. That separation
 * is the whole point of Task 3: durable scheduling and crash recovery are
 * proved here against a fake continuation, so the model loop that arrives in
 * Task 7 inherits a correct scheduler instead of debugging one through a
 * provider.
 */

// --- the model continuation port --------------------------------------------

/**
 * Everything one claimed attempt is allowed to know, captured synchronously at
 * claim time.
 *
 * It is a snapshot, not a handle. The continuation must not re-read driver
 * state after its first `await`: what it would read then may already belong to
 * a newer claimant, and acting on it is exactly the split-brain the claim fence
 * exists to prevent. Everything it writes goes through a fenced session call
 * that re-checks `fence` at commit time.
 */
export type ClaimedGeneration = ClaimSnapshot & {
  runId: string;
  /**
   * Absolute wall-clock time this continuation must be finished by. Below the
   * platform's 15-minute alarm ceiling, so a continuation that respects it can
   * always settle or hand back a retry rather than being killed mid-step.
   */
  deadlineAt: number;
};

/**
 * How a continuation ended. Deliberately one-to-one with `FinalizeRequest` and
 * deliberately explicit: a port that returned `void` would force the driver to
 * infer what happened by re-reading state it is not allowed to trust.
 *
 * There is no `paused`/`awaiting_approval` member. That state is reserved for
 * Phase 11 and adding it here "for later" is how it gets set by accident.
 */
export type ContinuationOutcome =
  | { outcome: "completed" }
  | {
      outcome: "failed";
      state: "failed" | "refused" | "budget_exhausted";
      resumePolicy: ResumePolicy;
      errorCode: string;
      errorMessage?: string;
    }
  | { outcome: "retry"; errorCode: string; errorMessage?: string };

export interface AgentContinuation {
  run(snapshot: ClaimedGeneration): Promise<ContinuationOutcome>;
}

// --- the projection port -----------------------------------------------------

export type ClaimedProjectionJob = {
  job: ProjectionJob;
  claimToken: string;
  runId: string;
};

/**
 * `dropped` is not a quiet success. It is for work that can never be delivered
 * because its source row is gone — a revision that was coalesced away, a usage
 * row from a deleted generation — and retrying it forever would keep an alarm
 * armed on a job that has no content.
 */
export type ProjectionOutcome =
  | { outcome: "delivered" }
  | { outcome: "retry"; error?: string; backoffMs?: number }
  | { outcome: "dropped"; reason: string };

export interface AgentProjectionRunner {
  run(job: ClaimedProjectionJob): Promise<ProjectionOutcome>;
}

// --- limits and clock --------------------------------------------------------

export type DriverLimits = {
  claimLeaseMs: number;
  maxAttempts: number;
  continuationTotalMs: number;
};

export const DEFAULT_DRIVER_LIMITS: DriverLimits = {
  claimLeaseMs: CLAIM_LEASE_MS,
  maxAttempts: DRIVER_MAX_ATTEMPTS,
  continuationTotalMs: CONTINUATION_TOTAL_MS,
};

/**
 * What a RunDO drives its loop with.
 *
 * `continuation: null` is Phase 10's honest production value: no model exists
 * yet, so model work is claimed by nobody and simply waits. That is a deliberate
 * park, not a silent drop — the generation stays `scheduled`, the input stays
 * above the settled watermark, and the first alarm after Task 7 wires the real
 * loop picks it up exactly where it was left.
 */
export type RunPorts = {
  continuation: AgentContinuation | null;
  projections: Partial<Record<ProjectionJobKind, AgentProjectionRunner>>;
  limits: DriverLimits;
  /** Injected so a test can advance time past a lease without sleeping for it. */
  now: () => number;
};

export function defaultRunPorts(): RunPorts {
  return {
    continuation: null,
    projections: {},
    limits: DEFAULT_DRIVER_LIMITS,
    now: () => Date.now(),
  };
}

/**
 * The wiring seam a Durable Object constructor can reach.
 *
 * A Durable Object cannot be handed a continuation over RPC — a port is a live
 * object with promises in it, not a serializable value — and it must be usable
 * from the CONSTRUCTOR, which is where crash recovery runs. So the registry is
 * module scope, populated at module load: Task 7's production wiring calls
 * `installRunPorts({ continuation: realLoop })` once, and a test installs a fake
 * scoped to the single run key it minted.
 *
 * Per-key overrides exist for that scoping reason. Objects in one isolate share
 * this module, so an unscoped test fake would also be handed to every other run
 * in the same runtime.
 */
const KEYED_PORTS = new Map<string, Partial<RunPorts>>();
let GLOBAL_PORTS: Partial<RunPorts> = {};

export function installRunPorts(ports: Partial<RunPorts>, options: { runKey?: string } = {}): void {
  if (options.runKey === undefined) {
    GLOBAL_PORTS = { ...GLOBAL_PORTS, ...ports };
    return;
  }
  KEYED_PORTS.set(options.runKey, { ...(KEYED_PORTS.get(options.runKey) ?? {}), ...ports });
}

export function resetRunPorts(): void {
  KEYED_PORTS.clear();
  GLOBAL_PORTS = {};
}

export function resolveRunPorts(runKey: string | null): RunPorts {
  const keyed = runKey === null ? undefined : KEYED_PORTS.get(runKey);
  return { ...defaultRunPorts(), ...GLOBAL_PORTS, ...(keyed ?? {}) };
}

// --- scheduling arithmetic ---------------------------------------------------

/**
 * When the single alarm slot should next fire.
 *
 * One Durable Object has ONE alarm. Model work, run-index projection, D1 usage
 * projection and memory-outbox delivery all compete for it, so the rule is:
 * store every due time locally and arm the EARLIEST. Priority between them is
 * not expressed here — it is expressed at dispatch, where the alarm claims
 * model work first. Doing it the other way round (arming only the highest
 * priority item) is what lets a busy loop starve delivery, and arming only the
 * soonest without a dispatch priority is what lets a backed-off vendor job
 * delay a customer's answer.
 *
 * Returns null when nothing is due at all, which is the state an idle object
 * must be able to reach: an alarm that always re-arms is an object that never
 * hibernates.
 */
export function nextAlarmAt(input: {
  driver: Pick<DriverState, "phase" | "leaseExpiresAt" | "nextAttemptAt">;
  projectionDueAt: number | null;
  /** False while no continuation is wired: model work is parked, not scheduled. */
  modelEnabled: boolean;
  now: number;
}): number | null {
  const { driver, now } = input;
  const candidates: number[] = [];

  if (input.modelEnabled) {
    if (driver.phase === "scheduled") {
      // Fresh input carries `nextAttemptAt = 0`, so it is due immediately even
      // when the previous attempt had walked the backoff out to seconds. A
      // retry backoff must delay a retry, never the customer's next message.
      candidates.push(Math.max(now, driver.nextAttemptAt));
    } else if (driver.phase === "running") {
      // A live lease is not work to do; it is work to RECLAIM once it expires.
      // Arming for that moment is what turns a crashed attempt into a bounded
      // outage instead of a run that waits for a message that never comes.
      candidates.push(driver.leaseExpiresAt ?? now);
    }
  }

  if (input.projectionDueAt !== null) candidates.push(input.projectionDueAt);
  if (candidates.length === 0) return null;
  return Math.max(now, Math.min(...candidates));
}

/**
 * Turn what the continuation reported into what the session must commit,
 * enforcing the attempt ceiling on the way through.
 *
 * The ceiling lives here rather than inside the port for the obvious reason: a
 * continuation that has just crashed is not the component to be trusted with
 * deciding whether it may crash again.
 *
 * An exhausted retry budget becomes a terminal `failed` with `requires_input`.
 * Not `retryable`: that policy means "bounded driver backoff while attempts
 * remain", and none do. Not `requires_operator_config` either — nothing about
 * repeated infrastructure failure says a human must change a setting before the
 * run may spend again, and locking a customer thread behind an operator action
 * for a transient outage is worse than letting the next trusted message start a
 * fresh generation with a fresh effect scope.
 */
export function toFinalizeRequest(
  outcome: ContinuationOutcome,
  claim: Pick<ClaimSnapshot, "attempt">,
  limits: DriverLimits,
): FinalizeRequest {
  if (outcome.outcome === "completed") return { kind: "completed" };
  if (outcome.outcome === "failed") {
    return {
      kind: "failed",
      state: outcome.state,
      resumePolicy: outcome.resumePolicy,
      errorCode: outcome.errorCode,
      ...(outcome.errorMessage === undefined ? {} : { errorMessage: outcome.errorMessage }),
    };
  }

  if (claim.attempt >= limits.maxAttempts) {
    return {
      kind: "failed",
      state: "failed",
      resumePolicy: "requires_input",
      errorCode: "driver_attempts_exhausted",
      errorMessage: `${outcome.errorCode}: ${outcome.errorMessage ?? "no detail"} (attempt ${claim.attempt} of ${limits.maxAttempts})`,
    };
  }
  return {
    kind: "retry",
    errorCode: outcome.errorCode,
    ...(outcome.errorMessage === undefined ? {} : { errorMessage: outcome.errorMessage }),
  };
}

/**
 * What a thrown continuation becomes.
 *
 * A crash is retryable by definition — nobody reported a policy, so the driver
 * must not invent `requires_operator_config` or `requires_reconciliation` from
 * an exception. Message only, never the stack: a stack from a capability can
 * carry a URL with a token in it, and this string is persisted and shown.
 */
export function crashOutcome(error: unknown): ContinuationOutcome {
  return {
    outcome: "retry",
    errorCode: "continuation_crashed",
    errorMessage: safeErrorText(error, "the continuation threw"),
  };
}

export function deadlineOutcome(): ContinuationOutcome {
  return {
    outcome: "retry",
    errorCode: "continuation_deadline",
    errorMessage: "the continuation did not finish inside its wall-time budget",
  };
}

export function safeErrorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}
