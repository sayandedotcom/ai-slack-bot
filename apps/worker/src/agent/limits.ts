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
