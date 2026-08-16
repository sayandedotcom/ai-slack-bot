/**
 * Steering: text a human types at a run that is already mid-turn.
 *
 * STUB — every export here has its final signature and a safe default body.
 * Task 10 fills the bodies in and must not change the signatures, because
 * `src/run/agent.ts` already calls all three from their real hooks (`onStart`,
 * the `@callable steer`, and `beforeStep`) and Wave B does not edit that file.
 *
 * A queue plus a per-step splice rather than a plain `addMessages`, because
 * `messageConcurrency` governs only overlapping user SUBMITS — it does not
 * inject into a turn that is already running (verified fact 13, spec decision
 * D9). Invariants 12–13: steers splice in insertion order and drain exactly
 * once, so a steer is never shown to the model twice and never lost.
 */

import type { ModelMessage } from "ai";
import type { RunAgent } from "./agent";

/**
 * Create the pending-steer table if it is not there yet.
 *
 * Called from `RunAgent.onStart`, so it runs on every wake and must be
 * idempotent (`CREATE TABLE IF NOT EXISTS`).
 */
// TODO(Task 10): CREATE TABLE IF NOT EXISTS via agent.sql.
export function ensureSteerSchema(_agent: RunAgent): void {}

/**
 * Enqueue one steer. Returns the queue depth AFTER the insert, so a caller can
 * tell a first steer from a fourth without a second round trip.
 */
// TODO(Task 10): insert into the pending-steer table and return the depth.
export function queueSteer(_agent: RunAgent, _text: string): Promise<{ queued: number }> {
  return Promise.resolve({ queued: 0 });
}

/**
 * Splice every queued steer into this step's messages and mark them drained.
 *
 * Returns the messages the step should use. The default returns them
 * unchanged, which is the safe no-op: no steer is injected, and none is
 * silently consumed either.
 */
// TODO(Task 10): drain in insertion order, append as user messages, mark drained.
export function drainSteers(
  _agent: RunAgent,
  messages: ModelMessage[],
): Promise<ModelMessage[]> {
  return Promise.resolve(messages);
}
