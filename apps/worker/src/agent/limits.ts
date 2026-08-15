/**
 * The phase's reviewed limits, in one place.
 *
 * Pure constants and total functions. Nothing here reads storage, the network
 * or a binding, so a test can import a single number without dragging the
 * driver — and, more importantly, so there is exactly one file to open when a
 * number turns out to be wrong in production.
 *
 * These are starting values, not sacred numbers. Task 3 needs only the four
 * that bound the alarm; the provider-facing ones (step ceiling, output tokens,
 * chunk timeouts, spend caps) arrive with the model in Tasks 5-7 and belong
 * here too.
 */

// --- driver and alarm -------------------------------------------------------

/**
 * How long a claim owns the run before another alarm may reclaim it.
 *
 * 150 seconds, which exceeds the reviewed 90-second provider step and the
 * 30-second outer tool wait with renewal margin. Shorter would let a healthy
 * but slow step look like a crash and hand the run to a second claimant while
 * the first is still streaming; longer would leave a genuinely dead attempt
 * holding the run for minutes.
 */
export const CLAIM_LEASE_MS = 150_000;

/**
 * Crash/continuation attempts per generation.
 *
 * These are DRIVER attempts — a whole claimed attempt died or reported a
 * retryable failure — not hidden provider retries. AI Gateway owns transport
 * retries and the AI SDK's own retry count is zero (invariant 27).
 */
export const DRIVER_MAX_ATTEMPTS = 3;

/**
 * Wall time one claimed continuation may occupy, well under the platform's
 * 15-minute alarm ceiling. The driver hands this to the continuation as an
 * absolute deadline and also enforces it itself, because a port that ignores
 * its deadline must not be able to walk the alarm into the ceiling.
 */
export const CONTINUATION_TOTAL_MS = 8 * 60_000;

/** The platform ceiling the loop must always exit before. Documentation, and a test's upper bound. */
export const ALARM_WALL_CEILING_MS = 15 * 60_000;

/**
 * Backoff before re-claiming a generation whose attempt failed retryably.
 *
 * Exponential from 2 seconds, capped, and — crucially — bounded by
 * `DRIVER_MAX_ATTEMPTS`, so this sequence is never walked far. The cap matters
 * anyway: an unbounded doubling would eventually schedule an alarm past the
 * point where anybody is still waiting for the answer.
 */
export const DRIVER_RETRY_BASE_MS = 2_000;
export const DRIVER_RETRY_MAX_MS = 30_000;

export function driverRetryBackoffMs(attempt: number): number {
  const step = Math.max(1, Math.floor(attempt));
  return Math.min(DRIVER_RETRY_BASE_MS * 2 ** (step - 1), DRIVER_RETRY_MAX_MS);
}

/**
 * Backoff for a projection job that could not be delivered.
 *
 * Longer and flatter than the driver's: a D1 or Zep outage is measured in
 * minutes, and retrying an unreachable vendor every two seconds only burns
 * alarms. The conversational loop is never delayed by this — the alarm claims
 * model work first (see `nextAlarmAt`), so a vendor outage cannot starve a
 * customer's answer.
 */
export const PROJECTION_RETRY_BASE_MS = 15_000;
export const PROJECTION_RETRY_MAX_MS = 5 * 60_000;

export function projectionRetryBackoffMs(attempts: number): number {
  const step = Math.max(1, Math.floor(attempts));
  return Math.min(PROJECTION_RETRY_BASE_MS * 2 ** (step - 1), PROJECTION_RETRY_MAX_MS);
}

/** How long a claimed projection job is owned before another pass may reclaim it. */
export const PROJECTION_LEASE_MS = 30_000;

// --- the provider call ------------------------------------------------------

/**
 * Steps one unsettled generation may take before the loop stops asking.
 *
 * Was ten, on the reasoning that one Code Mode call aggregates many reads, so
 * ten unconverged turns meant looping, not working. Phase 18 broke that
 * premise: a cold container boot is 2–4 minutes of legitimate waiting, and a
 * generation that polls it spends steps on turns that do almost nothing —
 * observed live (run 317111cd) dying at the ceiling mid-install with a healthy
 * machine underneath.
 *
 * Forty is not a loosened belt, it is the same judgement re-run against what a
 * generation now DOES. The arithmetic behind the old twenty-four still holds
 * for its own era: boot long-polls ~14s per call (sandbox/gateway.ts), so a
 * 3-minute cold boot costs ~13 poll steps, plus "a realistic 5–8 steps of
 * actual work". That second term was written when the work WAS exec-and-diff.
 *
 * Phase 20 made it a ship loop, and the tail is now edit, format, diff,
 * findIssue, record, poll the recording, openPR, checkPR, reply — twelve to
 * fourteen, not five to eight. The old model's own sum therefore lands at
 * 13 + 14 = 27, past the number it justified. Measured, not guessed:
 *
 *     c03a93bf  22 steps  $1.45  succeeded, opened PR #1506   <- two to spare
 *     5e012530  24 steps  $1.63  FAILED at the ceiling        <- one extra call
 *     854fd8a3  24 steps  $1.01  finished exactly at the wall
 *
 * A two-step margin on the one run that has ever completed the loop is not a
 * margin. The run that failed differed only by resolving one pre-existing
 * Linear issue and deleting a slightly larger block.
 *
 * Forty also makes the two ceilings agree for the first time. At the ~$0.068
 * per step these runs actually bill, forty steps is ~$2.70 — comfortably under
 * the $5.00 generation cap below, whose own docstring has always claimed to buy
 * "roughly 40 full-size steps". The step ceiling and the spend cap were never
 * aligned; a generation could not reach the cap's stated intent because it ran
 * out of turns first. Now the spend caps are genuinely the binding authority
 * (invariant 28) rather than a number the step ceiling made unreachable, and a
 * loop still stops — an expensive one sooner.
 */
export const MAX_STEPS_PER_GENERATION = 40;

/**
 * Output tokens one step may produce, before the pre-step spend guard clamps
 * it further.
 *
 * Fable 5's provider maximum is 128k. Accepting that as the application
 * maximum would mean a single runaway step could spend $6.40 of a $2.00
 * generation cap before anybody reads a usage row, because usage is only known
 * after the response. 8,192 keeps the worst single step at roughly $0.41.
 */
export const MAX_OUTPUT_TOKENS_PER_STEP = 8_192;

/** Provider step timeout. Bounds a cold or wedged provider call. */
export const PROVIDER_STEP_TIMEOUT_MS = 90_000;

/** No first chunk by here and the stream is failing, not thinking. */
export const FIRST_CHUNK_TIMEOUT_MS = 30_000;

/** A stream that stops mid-answer is detected here rather than at the wall. */
export const INTER_CHUNK_TIMEOUT_MS = 45_000;

/**
 * Outer tool wall, above Phase 09's own 20-second execution cap so the inner
 * limit is the one that reports a legible timeout to the model.
 */
export const OUTER_TOOL_TIMEOUT_MS = 30_000;

// --- spend ------------------------------------------------------------------

/** One US dollar in nano-USD. Integer units only (invariant 29). */
export const NANO_USD_PER_USD = 1_000_000_000;

/**
 * What one generation may spend: $5.00.
 *
 * RAISED FROM $2.00 ON 2026-08-15, and the reason is the guard's arithmetic
 * rather than the price of the work. `evaluateSpendGuard` does not compare the
 * cap against what a step WILL cost; it refuses unless the cap can absorb a
 * deliberately pessimistic RESERVATION:
 *
 *     promptBytes / 2  x  max(input, cacheWrite5m, cacheWrite1h)  x  attempts
 *
 * Every one of those three factors rounds against the run. At step 11 of the
 * first live ship-loop drill that came to $1.96 reserved for a step that
 * actually cost $0.13 — a ~15x over-reservation — because the estimate prices
 * a 28k-token prompt at the $20/Mtok one-hour cache-WRITE rate while 89% of it
 * was a $1/Mtok cache READ. The run died with $1.19 of its $2.00 unspent, one
 * tool call short of opening its pull request, having already written the fix,
 * formatted it, captured the diff and filed the issue.
 *
 * So the old value never bought the "roughly 40 full-size steps" its own
 * docstring claimed: it refused at eleven. $5.00 restores the headroom that
 * sentence always described. Real spend is unchanged (~$1 for a full drill) —
 * this raises what may be RESERVED, not what is billed.
 *
 * The principled fix is to teach the reservation about cache reads, which is a
 * change to a safety guard and wants its own review rather than a mid-drill
 * edit. Until then the run cap below is the real bound, and it is untouched.
 */
export const GENERATION_SPEND_CAP_NANO_USD = 5 * NANO_USD_PER_USD;

/**
 * What one run may spend across every generation: $10.00.
 *
 * The generation cap alone cannot catch a run that is steered twenty times;
 * this one can.
 */
export const RUN_SPEND_CAP_NANO_USD = 10 * NANO_USD_PER_USD;

// --- the gateway ------------------------------------------------------------

/**
 * Transport attempts AI Gateway may make for one provider call.
 *
 * Two, and AI Gateway is the ONLY retry owner: the AI SDK's `maxRetries` is
 * zero and driver retries are crash/continuation attempts (invariant 27).
 * Every attempt can be billed, so the pre-step guard multiplies its worst-case
 * exposure by exactly this number.
 */
export const GATEWAY_MAX_ATTEMPTS = 2;

/** Explicit retry delay, so a Gateway dashboard default cannot change policy. */
export const GATEWAY_RETRY_DELAY_MS = 250;

/** Explicit backoff strategy, for the same reason. */
export const GATEWAY_BACKOFF = "exponential" as const;

/**
 * Explicit per-request Gateway timeout, below the provider step timeout so the
 * Gateway gives up first and the SDK's step timeout stays a backstop.
 */
export const GATEWAY_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The one bundle the model path reads, so a test can inject smaller numbers
 * without reaching for module mocks.
 */
export type AgentLimits = {
  maxStepsPerGeneration: number;
  maxOutputTokensPerStep: number;
  continuationMs: number;
  stepMs: number;
  firstChunkMs: number;
  chunkMs: number;
  toolMs: number;
  generationSpendCapNanoUsd: number;
  runSpendCapNanoUsd: number;
  gatewayMaxAttempts: number;
  gatewayRetryDelayMs: number;
  gatewayRequestTimeoutMs: number;
};

export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  maxStepsPerGeneration: MAX_STEPS_PER_GENERATION,
  maxOutputTokensPerStep: MAX_OUTPUT_TOKENS_PER_STEP,
  continuationMs: CONTINUATION_TOTAL_MS,
  stepMs: PROVIDER_STEP_TIMEOUT_MS,
  firstChunkMs: FIRST_CHUNK_TIMEOUT_MS,
  chunkMs: INTER_CHUNK_TIMEOUT_MS,
  toolMs: OUTER_TOOL_TIMEOUT_MS,
  generationSpendCapNanoUsd: GENERATION_SPEND_CAP_NANO_USD,
  runSpendCapNanoUsd: RUN_SPEND_CAP_NANO_USD,
  gatewayMaxAttempts: GATEWAY_MAX_ATTEMPTS,
  gatewayRetryDelayMs: GATEWAY_RETRY_DELAY_MS,
  gatewayRequestTimeoutMs: GATEWAY_REQUEST_TIMEOUT_MS,
};
