/**
 * D1 projection from the Think hooks.
 *
 * STUB — both exports here have their final signatures and safe default
 * bodies. Task 11 fills the bodies in and must not change the signatures,
 * because `src/run/agent.ts` already calls both from `onStepFinish` and Wave B
 * does not edit that file.
 *
 * The agent's own SQLite is the system of record; D1 `runs` is a projection.
 * Invariant 32: apply a projection only when the sequence INCREASES, and never
 * let a D1 failure force another billed provider call.
 */

import type { RunStatus } from "./protocol";
import type { RunAgent } from "./agent";

/** One projection attempt: where the run got to, and how far along. */
export type ProjectionInput = {
  /**
   * Monotonic per-run sequence. A value at or below the stored
   * `projection_seq` is dropped — out-of-order alarm deliveries are normal.
   */
  seq: number;
  status: RunStatus;
  /** Optional one-line summary for the dashboard's run list. */
  summary?: string;
};

/** One step's billed usage, as the provider reported it. */
export type UsageInput = {
  /**
   * Unique identity for this step, so the D1 insert is idempotent under a
   * retried alarm (`INSERT OR IGNORE` on the step key).
   */
  stepId: string;
  /** The model id that was billed. A name, never a credential. */
  model: string;
  /**
   * The RAW provider usage bag. Deliberately `unknown`: Task 11 runs it
   * through `normalizeUsage` from `src/agent/usage.ts` rather than trusting a
   * shape this module would have to keep in sync with the SDK.
   */
  usage: unknown;
};

/** Advance the D1 `runs` projection for this run, if the sequence increased. */
// TODO(Task 11): local step row first, then the guarded D1 update via src/run/repository.ts.
export function projectTurn(_agent: RunAgent, _input: ProjectionInput): Promise<void> {
  return Promise.resolve();
}

/** Record one step's tokens and cost, in integer nano-USD. */
// TODO(Task 11): normalizeUsage + the cost maths already in src/agent/usage.ts.
export function recordUsage(_agent: RunAgent, _input: UsageInput): Promise<void> {
  return Promise.resolve();
}
