import type { RunEvent, RunStatus, TurnSource } from "../run/protocol";

/**
 * The durable agent contracts: the vocabulary the Phase 10 driver, transcript
 * and telemetry all share.
 *
 * Pure module. No storage, no D1, no provider, no `ai` import. Everything here
 * is a type, a constant, or a total function over strings and numbers, so the
 * shapes can be asserted without a binding and reused by Task 3's driver
 * without dragging the model in.
 *
 * The stable IDs below are the plan's ID table, in code. They exist because
 * alarm delivery is at-least-once and a provider message id can change on a
 * retry of the same logical generation: every durable row a retry might write
 * twice is keyed by a value THIS side computes, never by anything the provider
 * hands back.
 */

// --- driver and generation state -------------------------------------------

/**
 * What the run's model driver is doing. This is private recovery state; it is
 * NOT the public `RunStatus` a dashboard renders, and it is deliberately not
 * mirrored into D1 — a replicated lock is a split brain waiting to happen.
 */
export const DRIVER_PHASES = ["idle", "scheduled", "running", "failed"] as const;

export type DriverPhase = (typeof DRIVER_PHASES)[number];

/**
 * A generation is one wake-to-settlement unit of model work. `superseded`
 * deliberately does NOT appear: superseding describes one stream attempt whose
 * final was overtaken by a late steer, and that generation keeps running so its
 * Code Mode effect scope and transcript stay coherent (invariant 14).
 */
export const GENERATION_STATES = [
  "scheduled",
  "running",
  "completed",
  "failed",
  "refused",
  "budget_exhausted",
] as const;

export type GenerationState = (typeof GENERATION_STATES)[number];

export const TERMINAL_GENERATION_STATES = [
  "completed",
  "failed",
  "refused",
  "budget_exhausted",
] as const;

export function isTerminalGenerationState(state: GenerationState): boolean {
  return (TERMINAL_GENERATION_STATES as readonly string[]).includes(state);
}

/**
 * Why a terminal failure happened, in terms of what may legally wake it again.
 * Persisted with every failure so `appendTurn()` can refuse to let an ordinary
 * message bypass a spend ceiling or resume an ambiguous external mutation.
 */
export const RESUME_POLICIES = [
  "retryable",
  "requires_input",
  "requires_operator_config",
  "requires_reconciliation",
] as const;

export type ResumePolicy = (typeof RESUME_POLICIES)[number];

/**
 * The two policies an ordinary trusted turn may resume by allocating a new
 * generation. The other two are deliberately absent:
 *
 *  - `requires_operator_config` covers a run spend cap or a missing secret. A
 *    customer typing "any update?" must not restart spending.
 *  - `requires_reconciliation` covers an ambiguous external effect. Replaying
 *    into it could send a second customer message for the same intent.
 */
export const INPUT_RESUMABLE_POLICIES = ["retryable", "requires_input"] as const;

export function isInputResumablePolicy(policy: ResumePolicy | null): boolean {
  return policy !== null && (INPUT_RESUMABLE_POLICIES as readonly string[]).includes(policy);
}

/**
 * THE ONLY `requires_operator_config` FAILURES A CONFIGURATION CHANGE CAN UNDO.
 *
 * `ModelCompositionError` codes come in two kinds, and the difference decides
 * whether a dead run can ever come back:
 *
 *  - ABSENT: the setting was not there at all. Listed here. This is the state of
 *    every deployment between "the code shipped" and "the operator created the
 *    private AI Gateway", and it is a ONE-WAY transition — supplying the setting
 *    is the operator action the plan's resume table calls for (plan line 655:
 *    "explicit operator/config reset, never ordinary input"). Nothing was billed
 *    when it failed: `createProductionModelFactory` throws before any provider,
 *    any tool and any customer-visible byte.
 *  - PRESENT BUT WRONG: `invalid_gateway_url`, `unpriced_model`. Deliberately
 *    NOT here. Presence is all a cheap check can see, so a run revived on a
 *    malformed value would fail again on the same value, every wake, forever.
 *
 * Kept here rather than in `model.ts` on purpose: `session.ts` and `do.ts` need
 * this list, and importing `model.ts` from either would put `@ai-sdk/anthropic`
 * into a module graph that has no business evaluating it (see the note on
 * `productionContinuation` in `ports.ts`).
 *
 * `agent-ports.test.ts` > "pins the absent-configuration codes, in both
 * directions, against the real composer" is what keeps that separation honest.
 * It blanks each required setting in turn, calls the REAL
 * `createProductionModelFactory`, and asserts BOTH directions: every code it
 * throws is in this list, and the set of codes it throws EQUALS this list. So
 * adding an unreachable entry here fails, deleting a reachable one fails, and a
 * newly required setting that fails with an unlisted code fails. It does not
 * pin the PRESENT-BUT-WRONG codes below — those are excluded by construction,
 * and the `it.each` exclusion cases cover their behaviour instead.
 */
export const ABSENT_MODEL_CONFIGURATION_CODES = [
  "missing_anthropic_key",
  "missing_gateway_url",
  "missing_gateway_token",
] as const;

export function isAbsentConfigurationCode(code: string | null): boolean {
  return code !== null && (ABSENT_MODEL_CONFIGURATION_CODES as readonly string[]).includes(code);
}

/**
 * THE CLOSED SET OF TERMINAL FAILURES A STRANDED INPUT MAY WAKE BY ITSELF.
 *
 * The hole this exists for. A trusted turn that commits WHILE a generation is
 * answering does not allocate anything — `scheduleInput` sees `running` and
 * joins the live generation, which will absorb it at its next `prepareStep`. If
 * that generation then dies terminally instead of taking another step, the input
 * is durable, above `settled_through_seq`, and owned by nobody: the driver reads
 * `failed`, and `nextAlarmAt` only ever schedules model work for `scheduled` or
 * `running`. The same message sent one millisecond LATER allocates a new
 * generation through `scheduleInput` and is answered normally. Plan line 470
 * ("generation has settled" -> "create a new generation/turn ID") describes the
 * later message; this list is what makes the earlier one behave identically.
 *
 * Why a closed list rather than "any `requires_input` failure". Waking resets
 * `attempt` and `retry_count` to zero, so a failure that the pending input
 * ITSELF causes would be re-entered with a full budget, forever. Two guards stop
 * that, and both are required:
 *
 *  - the code must be here, meaning the failure is provably not a verdict on the
 *    pending input — the generation never saw it;
 *  - `pending_through_seq` must exceed the dead generation's
 *    `included_through_seq`, meaning there is genuinely input it never read.
 *    A successor takes that input at its first `prepareStep`, which lifts its
 *    included cursor as far as ONE `listPendingInputTurns` page reaches — the
 *    default is `EVENT_PAGE_DEFAULT`, 200 turns (`session.ts:1244`,
 *    `session.ts:136`), and `prepareTurn` passes no override (`loop.ts:465`).
 *    At or below 200 pending turns that lands exactly on the pending cursor and
 *    a second identical failure has nothing left to wake on. Above it the cursor
 *    lands on the 200th turn instead, the guard still sees `pending > included`,
 *    and one more successor is allocated: the chain is ceil(N/200), not one. Not
 *    a spin — each of those laps reads 200 turns no earlier generation ever saw
 *    and makes a real provider call for them. Either way the length is bounded
 *    by arriving input, not by a counter.
 *
 * Deliberately ABSENT, each for a reason that would otherwise be a spin:
 *
 *  - every `malformed_history` code (`context_limit:*`, `empty_history`,
 *    `readable_reasoning`, `malformed_response:*`). NOT because the cursor is
 *    late: `appendInputMessages` lifts it at `loop.ts:474`, ahead of BOTH the
 *    `context_limit` halt (`loop.ts:492`) and the `empty_history` halt
 *    (`loop.ts:508`), and the other two are decided after the stream. The reason
 *    is that the condition survives the wake. These are the input-caused ones —
 *    an unusable turn is still unusable and an oversized history is still
 *    oversized on the next generation, which reaches the identical halt — so the
 *    lap buys nothing, where every code below buys a real provider call on
 *    evidence nobody had yet. The second guard cannot be leaned on to end it
 *    either, because the cursor lift is capped at one page (above): past 200
 *    pending turns each lap re-enters a guaranteed failure with `attempt` and
 *    `retry_count` reset to zero.
 *  - `driver_attempts_exhausted`. Its whole meaning is "the crash budget is
 *    gone"; handing it a fresh one on the strength of a message that arrived
 *    during the crashing is how a transient outage becomes an unbounded spend.
 *  - anything settling `requires_operator_config` or `requires_reconciliation`.
 *    Those never reach here — the policy check is the outer gate — and they are
 *    the two the plan reserves for an explicit human action (plan line 655).
 */
export const UNSEEN_INPUT_WAKE_CODES = [
  // A refusal is a verdict on the context the generation SENT, and the pending
  // input was not in it. A steer is the documented remedy (`REFUSAL_RESUME_POLICY`).
  "provider_refusal",
  "provider_refusal_mid_stream",
  // The step ceiling is per generation. A successor gets a fresh budget and the
  // evidence the customer just added, which is the only thing that helps.
  "step_limit",
  // An abort that found nothing pending at the moment it was read. If input has
  // landed since, it is owed an answer exactly as a post-cancel message would be.
  "run_cancelled",
] as const;

export function wakesOnUnseenInput(code: string | null): boolean {
  return code !== null && (UNSEEN_INPUT_WAKE_CODES as readonly string[]).includes(code);
}

/**
 * Turn provenance that may wake the loop. This is about who the turn came from,
 * never about what it says — there is no topic test anywhere in Phase 10.
 * `agent` and `system` are absent on purpose: the loop's own output must not
 * re-wake it, or one answer becomes an infinite conversation with itself.
 */
export const WAKE_TURN_SOURCES = ["triage", "customer", "human_steer", "approval"] as const;

export function isWakeSource(source: TurnSource): boolean {
  return (WAKE_TURN_SOURCES as readonly string[]).includes(source);
}

// --- stable identity --------------------------------------------------------

/** `gen:{uuid}`, allocated inside the input transaction, before any async call. */
export function newGenerationId(): string {
  return `gen:${crypto.randomUUID()}`;
}

/**
 * The agent turn id, which doubles as the Code Mode effect scope
 * (`scope.turnId`). Derived from the generation so every continuation and
 * crash-retry of one generation replays into the SAME Phase 09 effect ledger
 * rows instead of re-sending a customer message.
 */
export function agentTurnIdFor(generationId: string): string {
  return `agent:${generationId}`;
}

/** The final assistant turn, appended exactly once per settled generation. */
export function finalTurnIdFor(generationId: string): string {
  return `agent:${generationId}:final`;
}

export function invocationIdFor(generationId: string, attempt: number): string {
  return `invoke:${generationId}:${attempt}`;
}

export function stepIdFor(generationId: string, globalStep: number): string {
  return `step:${generationId}:${globalStep}`;
}

export function streamIdFor(generationId: string, attempt: number): string {
  return `stream:${generationId}:${attempt}`;
}

export function assistantUpdateIdFor(
  generationId: string,
  attempt: number,
  batchSeq: number,
): string {
  return `assistant:${generationId}:${attempt}:${batchSeq}`;
}

export function usageRowIdFor(
  generationId: string,
  attempt: number,
  globalStep: number,
): string {
  return `usage:${generationId}:${attempt}:${globalStep}`;
}

export function memoryOutboxIdFor(runId: string, generationId: string): string {
  return `memory:${runId}:${generationId}`;
}

export function capabilityCallIdFor(outerToolCallId: string, capabilitySeq: number): string {
  return `cap:${outerToolCallId}:${capabilitySeq}`;
}

// --- the claim fence --------------------------------------------------------

/**
 * The token every state-changing agent call must present.
 *
 * `claimEpoch` is a per-object monotonic counter bumped on every claim and
 * reclaim. A claimant whose lease expired and whose work was taken over holds
 * an epoch lower than the driver's, so its transcript writes, assistant events,
 * capability starts and finalization are all refused (invariant 10).
 *
 * The one deliberate exception is attempt-scoped usage: see
 * `recordStepUsage()` in `run/session.ts`. Billed money must not vanish just
 * because the claim moved on.
 */
export type ClaimFence = {
  generationId: string;
  claimEpoch: number;
};

/**
 * The claim lease lives in `agent/limits.ts` with the phase's other reviewed
 * numbers (`CLAIM_LEASE_MS`). It was briefly duplicated here at a value that
 * disagreed with the reviewed one, which is the failure mode a single limits
 * home exists to prevent: two constants, one of them quietly wrong.
 */

// --- records ----------------------------------------------------------------

export type DriverState = {
  phase: DriverPhase;
  /** Highest RunEvent seq of a trusted input that may need model work. */
  pendingThroughSeq: number;
  /** Highest input seq already settled (or the schema-v2 activation watermark). */
  settledThroughSeq: number;
  generationId: string | null;
  agentTurnId: string | null;
  /**
   * How many times this generation has been CLAIMED. Monotonic, and never
   * reset while the generation lives, because it is part of the stable identity
   * of everything a claim writes: `stream:{gen}:{attempt}`,
   * `assistant:{gen}:{attempt}:{batch}`, `usage:{gen}:{attempt}:{step}`. Reuse
   * a number here and two different provider streams collide on one id.
   *
   * It is therefore NOT a retry budget: an ordinary steer mid-answer continues
   * the generation and costs a claim. See `retryCount`.
   */
  attempt: number;
  /**
   * How many times this generation has been RESCHEDULED after a failure.
   *
   * This is the number the attempt ceiling bounds. Kept apart from `attempt`
   * because they answer different questions — "how many streams has this
   * generation had" versus "how much of its crash budget is gone" — and a
   * single counter for both means a customer who steers twice loses the run to
   * the next transient blip.
   */
  retryCount: number;
  claimEpoch: number;
  leaseExpiresAt: number | null;
  lastHeartbeatAt: number | null;
  /**
   * The earliest wall-clock time a `scheduled` generation may be claimed.
   *
   * Zero for fresh input, which is the whole point: a retry backoff must delay
   * the retry and nothing else, so a customer message arriving during a backoff
   * resets this to zero and is answered immediately.
   */
  nextAttemptAt: number;
  resumePolicy: ResumePolicy | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  updatedAt: number;
};

export type GenerationRecord = {
  id: string;
  agentTurnId: string;
  state: GenerationState;
  firstInputSeq: number;
  includedThroughSeq: number;
  settledThroughSeq: number | null;
  attemptCount: number;
  stepCount: number;
  costNanoUsd: number;
  memoryProjectionState: MemoryProjectionState;
  startedAt: number | null;
  finishedAt: number | null;
  resumePolicy: ResumePolicy | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  /**
   * The approval this generation parked on, or null. On the ERROR-FREE
   * terminal fields on purpose: a pause is a successful settle that is waiting
   * for a human, not a failure, so it must not occupy `lastErrorCode` where an
   * operator report would render it as something having gone wrong.
   */
  pausedApprovalId: string | null;
  createdAt: number;
  updatedAt: number;
};

export const MEMORY_PROJECTION_STATES = ["none", "pending", "projected", "failed"] as const;

export type MemoryProjectionState = (typeof MEMORY_PROJECTION_STATES)[number];

/**
 * Everything a claimed attempt needs, captured synchronously at claim time.
 * The driver must not re-read driver state after its first `await`: what it
 * reads then may already belong to a newer claimant.
 */
export type ClaimSnapshot = {
  fence: ClaimFence;
  generationId: string;
  agentTurnId: string;
  /** Claim number. Part of stable write identity; never a budget. */
  attempt: number;
  /** Retries already spent by this generation. What the attempt ceiling reads. */
  retryCount: number;
  firstInputSeq: number;
  includedThroughSeq: number;
  pendingThroughSeq: number;
  stepCount: number;
  costNanoUsd: number;
  leaseExpiresAt: number;
};

// --- outcomes ---------------------------------------------------------------

/**
 * What appending a turn did to the loop. Explicit rather than inferable: a
 * caller must never have to diff driver state before and after to work out
 * whether it just scheduled model work.
 */
export type InputScheduling =
  | { outcome: "not_input" }
  | { outcome: "duplicate"; generationId: string | null }
  | { outcome: "allocated"; generationId: string; agentTurnId: string; eventSeq: number }
  | { outcome: "joined"; generationId: string; agentTurnId: string; eventSeq: number }
  | { outcome: "blocked"; policy: ResumePolicy; eventSeq: number };

export type ClaimOutcome =
  | { outcome: "claimed"; claim: ClaimSnapshot }
  | { outcome: "already_running"; generationId: string; leaseExpiresAt: number }
  /**
   * Scheduled, but inside a retry backoff. A separate outcome from
   * `nothing_scheduled` because the caller must re-arm its alarm for
   * `nextAttemptAt` — treating it as "nothing to do" is how a retryable failure
   * turns into a run that never resumes.
   */
  | { outcome: "backoff"; generationId: string; nextAttemptAt: number }
  | { outcome: "nothing_scheduled"; phase: DriverPhase };

export type HeartbeatOutcome =
  | { outcome: "renewed"; leaseExpiresAt: number }
  | { outcome: "stale_claim" };

export type ClaimCheckOutcome = { outcome: "current" } | { outcome: "stale_claim" };

export type InputMessagesOutcome =
  | { outcome: "inserted"; inserted: number; skipped: number; includedThroughSeq: number }
  | { outcome: "noop"; includedThroughSeq: number }
  | { outcome: "stale_claim" };

export type StepCheckpointOutcome =
  | { outcome: "checkpointed"; inserted: number }
  | { outcome: "already_checkpointed" }
  | { outcome: "stale_claim" };

export type UsageOutcome = { outcome: "recorded" | "duplicate"; id: string };

export type AssistantUpdateOutcome =
  | { outcome: "appended" | "replayed"; event: RunEvent }
  | { outcome: "stale_claim" };

/** Any claim-fenced append to the replayable event stream. */
export type FencedAppendOutcome = AssistantUpdateOutcome;

/**
 * How the driver wants to end this attempt. `retry` is a crash/continuation
 * attempt of the SAME generation, not a hidden provider retry (invariant 27).
 *
 * `paused` is Phase 11's approval gate and is deliberately a REQUEST rather
 * than an instruction: the attempt reports the approval it opened, and
 * `finalizeGeneration` re-reads the local `approval_state` record inside its
 * own transaction before parking anything. A continuation that escalated and
 * then withdrew, or whose approval a human resolved while it was finishing,
 * settles `completed` — the decision belongs to the one epoch-fenced
 * transaction that owns every other transition, not to the reporter.
 */
export type FinalizeRequest =
  | { kind: "completed" }
  | { kind: "paused"; approvalId: string }
  | {
      kind: "failed";
      state: "failed" | "refused" | "budget_exhausted";
      resumePolicy: ResumePolicy;
      errorCode: string;
      errorMessage?: string;
    }
  | {
      kind: "retry";
      errorCode: string;
      errorMessage?: string;
      /** Backoff before the generation may be claimed again. Defaults to none. */
      retryAfterMs?: number;
    };

export type FinalizeOutcome =
  | {
      outcome: "settled";
      generationId: string;
      generationState: GenerationState;
      /**
       * `scheduled` means this generation settled TERMINALLY and a successor was
       * allocated for input it never saw (`UNSEEN_INPUT_WAKE_CODES`). The public
       * status must follow the driver, not the generation: the run is working.
       */
      driverPhase: "idle" | "failed" | "scheduled";
      settledThroughSeq: number;
      /** Present only with `driverPhase: "scheduled"`. */
      successorGenerationId?: string;
      /**
       * The approval this generation parked on, when the finalize latched a
       * pause. Present only with `driverPhase: "idle"`, because a parked run
       * has nothing scheduled and nothing to reclaim — it wakes solely through
       * `appendTurn({source:"approval"})`.
       *
       * It exists because the PUBLIC status of a paused settle is
       * `awaiting_approval` rather than `idle`, and the session layer
       * deliberately does not set public status (see `finalizeGeneration`'s
       * header). Without this field the driver would have to re-read the
       * generation row to discover what it just committed.
       */
      pausedApprovalId?: string;
    }
  | {
      outcome: "continued";
      generationId: string;
      pendingThroughSeq: number;
      includedThroughSeq: number;
    }
  | {
      outcome: "rescheduled";
      generationId: string;
      attempt: number;
      retryCount: number;
      nextAttemptAt: number;
    }
  | { outcome: "already_settled"; generationId: string; generationState: GenerationState }
  | { outcome: "stale_claim" };

// --- telemetry --------------------------------------------------------------

/**
 * Every token class Fable cost needs, as non-negative integers. Cost itself is
 * nano-USD (invariant 29): floating dollars accumulate error across thousands
 * of steps and cannot be summed exactly in SQL.
 */
export type NormalizedUsage = {
  inputTokens: number;
  noCacheTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

/**
 * One billed model step.
 *
 * There is deliberately no prompt, completion, message, reasoning or raw
 * provider body field anywhere in this type. Telemetry answers "what did this
 * cost and why did it stop", never "what was said" (invariants 18 and 39).
 */
export type StepUsageInput = {
  generationId: string;
  agentTurnId: string;
  attempt: number;
  globalStep: number;
  provider: string;
  model: string;
  providerRequestId?: string | null;
  gatewayLogId?: string | null;
  usage: NormalizedUsage;
  costNanoUsd: number;
  latencyMs: number;
  finishReason?: string | null;
  rawFinishReason?: string | null;
  errorCode?: string | null;
};

export type StepUsageRecord = StepUsageInput & {
  id: string;
  providerRequestId: string | null;
  gatewayLogId: string | null;
  finishReason: string | null;
  rawFinishReason: string | null;
  errorCode: string | null;
  d1ProjectedAt: number | null;
  createdAt: number;
};

// --- run-index projection ---------------------------------------------------

export const PROJECTION_JOB_KINDS = [
  "run_index",
  "d1_usage",
  "memory_outbox",
  /**
   * One approval card, projected from the local `approval_state` row into D1
   * so the dashboard can list it. Deliberately the SAME machinery as every
   * other kind — the same table, the same claim, the same alarm dispatcher —
   * rather than a second projection path with its own retry semantics to keep
   * correct.
   */
  "approval_card",
] as const;

export type ProjectionJobKind = (typeof PROJECTION_JOB_KINDS)[number];

export const PROJECTION_JOB_STATES = ["pending", "claimed", "completed", "failed"] as const;

export type ProjectionJobState = (typeof PROJECTION_JOB_STATES)[number];

export type ProjectionJob = {
  id: string;
  kind: ProjectionJobKind;
  sourceId: string;
  state: ProjectionJobState;
  claimToken: string | null;
  leaseExpiresAt: number | null;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * One immutable bundled snapshot of everything D1's run index shows. Bundled on
 * purpose: projecting status and summary separately lets two async writes land
 * out of order and leave the list showing a new status beside an old summary.
 */
export type RunIndexRevision = {
  revision: number;
  status: RunStatus;
  summary: string | null;
  updatedAt: number;
};

export type ProjectionClaimOutcome =
  | { outcome: "claimed"; job: ProjectionJob; claimToken: string }
  | { outcome: "none" };

export type ProjectionCompleteOutcome =
  | { outcome: "completed" }
  | { outcome: "stale_claim" }
  | { outcome: "unknown" };
