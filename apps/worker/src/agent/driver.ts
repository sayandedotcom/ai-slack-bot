import type { Env } from "../index";
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
 * `paused` is Phase 11's approval gate, and the comment that used to stand
 * here — reserving the member and warning that adding it early is how it gets
 * set by accident — described a real hazard that the shape below is what
 * answers. Reporting `paused` does NOT park a run. It says only "this attempt
 * opened an approval", and `finalizeGeneration` re-reads the local
 * `approval_state` record inside its own epoch-fenced transaction before it
 * parks anything: a stale claimant is refused, a withdrawn approval settles
 * `completed`, and fresher input still continues the generation. The member
 * cannot be "set by accident" because setting it is not what decides.
 */
export type ContinuationOutcome =
  | { outcome: "completed" }
  | { outcome: "paused"; approvalId: string }
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

/**
 * How a continuation is OBTAINED, as opposed to what it does.
 *
 * The registry below is module scope, because a Durable Object cannot be handed
 * a live object over RPC and must be able to reach its ports from the
 * constructor. But a module-scope singleton `AgentContinuation` cannot work:
 * every real continuation needs THIS object's storage and THIS object's
 * bindings, and a singleton has a route to neither. Task 3's own fake had to be
 * handed storage through an `attach()` call from inside `runInDurableObject`
 * precisely because of that gap — a hack that only a test could perform, which
 * is a strong sign the seam was in the wrong place.
 *
 * A factory closes it with no change to the pinned `run(snapshot)` contract: the
 * continuation is still a plain object with one method, it is simply built by a
 * closure over the `(ctx, env)` the object already has.
 *
 * Called once per claimed attempt, not once per object, so nothing here needs to
 * survive eviction and nothing may be cached across claims.
 */
export type AgentContinuationFactory = (
  ctx: DurableObjectState,
  env: Env,
) => AgentContinuation;

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

/**
 * How a projection runner is OBTAINED, for exactly the reason the continuation
 * is a factory too.
 *
 * A projection runner is not a stateless function of its job. The memory-outbox
 * runner reads the frozen episode out of THIS object's storage and marks it
 * projected there; the usage runner reads THIS object's locally recorded step
 * rows. A module-scope singleton has a route to neither, so before this the
 * only thing that could install one was a test already holding a storage handle
 * from inside `runInDurableObject` — which is why Task 9's real runner had zero
 * production call sites.
 *
 * Built once per claimed job, like the continuation, so nothing survives
 * eviction and nothing is cached across claims.
 */
export type AgentProjectionRunnerFactory = (
  ctx: DurableObjectState,
  env: Env,
) => AgentProjectionRunner;

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
 * `continuation: null` parks model work: the generation stays `scheduled`, the
 * input stays above the settled watermark, and the first alarm after a
 * continuation is installed picks it up exactly where it was left. That is the
 * default because installing the real loop for every object in the runtime is a
 * surface-wiring decision (Task 10), not something a module import should do.
 */
export type RunPorts = {
  continuation: AgentContinuationFactory | null;
  projections: Partial<Record<ProjectionJobKind, AgentProjectionRunnerFactory>>;
  limits: DriverLimits;
  /** Injected so a test can advance time past a lease without sleeping for it. */
  now: () => number;
  /**
   * Whether THIS deployment's required model configuration is present, i.e.
   * `modelDisposition(env).status === "ready"`.
   *
   * It rides on the ports for the same reason `now` does: the RunDO needs it in
   * its CONSTRUCTOR, where the only decision that depends on it is made, and a
   * value read straight from `env` there would be unreachable from a test — the
   * pool's env is fixed and deliberately unconfigured. It is a plain boolean
   * rather than the whole report because the constructor needs exactly one bit
   * and must not acquire a reason to reach into the composer.
   *
   * `false` by default, and `false` is the safe direction: it only ever gates
   * `resumeAfterOperatorConfig`, so a wrong `false` leaves a config-failed run
   * exactly as dead as it was before this existed, while a wrong `true` would
   * reschedule work that immediately fails again for free.
   */
  modelConfigured: boolean;
};

export function defaultRunPorts(): RunPorts {
  return {
    continuation: null,
    projections: {},
    limits: DEFAULT_DRIVER_LIMITS,
    now: () => Date.now(),
    modelConfigured: false,
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
 *
 * There is deliberately no instance-level override any more. `RunDO` used to
 * carry an `installPorts()` method with no callers, which read as the escape
 * hatch for the storage problem the factory above actually solves — while being
 * structurally unable to solve it, because a Durable Object stub cannot be
 * handed a live port over RPC either. One seam, one place to look.
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
  /**
   * Whether a continuation is wired at all — the same predicate the operator
   * report calls `continuationInstalled`, and deliberately NOT "the model can
   * succeed". With no continuation there is nothing to dispatch to, so model
   * work is parked rather than scheduled; with one installed the work is
   * scheduled even on a deployment whose configuration is absent, because
   * failing loudly at composition is the point (plan lines 965-966).
   */
  continuationInstalled: boolean;
  now: number;
}): number | null {
  const { driver, now } = input;
  const candidates: number[] = [];

  if (input.continuationInstalled) {
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
 *
 * The budget read here is `retryCount`, NOT `attempt`. They are different
 * numbers on purpose: `attempt` counts claims, and an ordinary steer arriving
 * mid-answer continues the generation and costs one. Bounding on `attempt`
 * would mean a customer who steered twice had silently spent the whole crash
 * budget, so the next transient provider blip would terminate their run as
 * `driver_attempts_exhausted` having retried nothing at all.
 */
export function toFinalizeRequest(
  outcome: ContinuationOutcome,
  claim: Pick<ClaimSnapshot, "retryCount">,
  limits: DriverLimits,
): FinalizeRequest {
  if (outcome.outcome === "completed") return { kind: "completed" };
  // Carried through unchanged, and deliberately NOT bounded by the attempt
  // ceiling: a pause is a successful settle waiting on a human, so it spends no
  // retry budget and cannot exhaust one.
  if (outcome.outcome === "paused") {
    return { kind: "paused", approvalId: outcome.approvalId };
  }
  if (outcome.outcome === "failed") {
    return {
      kind: "failed",
      state: outcome.state,
      resumePolicy: outcome.resumePolicy,
      errorCode: outcome.errorCode,
      ...(outcome.errorMessage === undefined ? {} : { errorMessage: outcome.errorMessage }),
    };
  }

  // This attempt plus the retries already spent. `maxAttempts` of 3 means one
  // original attempt and two retries.
  const attemptsSpent = claim.retryCount + 1;
  if (attemptsSpent >= limits.maxAttempts) {
    return {
      kind: "failed",
      state: "failed",
      resumePolicy: "requires_input",
      errorCode: "driver_attempts_exhausted",
      errorMessage: `${outcome.errorCode}: ${outcome.errorMessage ?? "no detail"} (attempt ${attemptsSpent} of ${limits.maxAttempts})`,
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

/**
 * Did this attempt fail to consume input it was claimed to answer?
 *
 * The hazard is narrow and specific. `finalizeGeneration` continues a
 * generation whenever pending input sits above the included cursor, and a
 * continuation re-arms at once — correctly, because the customer is waiting. But
 * if a continuation reports `completed` having included NOTHING while input was
 * pending, that same rule re-arms immediately, forever, on a loop that makes no
 * progress and (with a real provider) bills for every lap.
 *
 * The test is both halves together:
 *
 *  - there WAS pending input above the included cursor when this attempt was
 *    claimed, so the attempt was obliged to consume some of it; and
 *  - the included cursor did not move.
 *
 * The first half is what keeps a legitimate case out of it. An attempt claimed
 * with nothing left to include — a crash retry whose predecessor already put the
 * input in the transcript — consumes nothing quite properly, and if a steer then
 * lands mid-answer the generation continues with no movement of its own. That is
 * progress by someone, and it is not this.
 *
 * A violation is treated as a retryable failure rather than a terminal one: it
 * goes through the same bounded backoff and the same ceiling as a crash, which
 * turns an unbounded hot loop into three spaced attempts and then a visible
 * failure.
 */
export function continuationMadeNoProgress(
  claim: Pick<ClaimSnapshot, "pendingThroughSeq" | "includedThroughSeq">,
  includedThroughSeqNow: number,
): boolean {
  return (
    claim.pendingThroughSeq > claim.includedThroughSeq &&
    includedThroughSeqNow <= claim.includedThroughSeq
  );
}

export function noProgressOutcome(): ContinuationOutcome {
  return {
    outcome: "retry",
    errorCode: "continuation_made_no_progress",
    errorMessage: "the continuation settled without including any of its pending input",
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
