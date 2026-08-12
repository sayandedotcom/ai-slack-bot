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
  attempt: number;
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
  attempt: number;
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
 */
export type FinalizeRequest =
  | { kind: "completed" }
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
      driverPhase: "idle" | "failed";
      settledThroughSeq: number;
    }
  | {
      outcome: "continued";
      generationId: string;
      pendingThroughSeq: number;
      includedThroughSeq: number;
    }
  | { outcome: "rescheduled"; generationId: string; attempt: number; nextAttemptAt: number }
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

export const PROJECTION_JOB_KINDS = ["run_index", "d1_usage", "memory_outbox"] as const;

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
