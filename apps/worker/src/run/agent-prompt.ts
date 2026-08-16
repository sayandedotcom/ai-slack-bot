/**
 * The prompt half of the Think chassis: session context blocks and the
 * per-step system blocks.
 *
 * STUB — every export here has its final signature and a safe default body.
 * Task 8 fills the bodies in and must not change the signatures, because
 * `src/run/agent.ts` already calls both from their real hooks
 * (`configureSession` and `beforeStep`) and Wave B does not edit that file.
 */

import type { Session } from "@cloudflare/think";
import type { SystemModelMessage } from "ai";
import type { RunAgent } from "./agent";

/**
 * Attach the run's always-on context blocks to the session.
 *
 * Called once per wake from `RunAgent.configureSession`. The default returns
 * the session untouched, which is the honest no-op: a run with no context
 * blocks still works, it just has no memory recall in its prompt.
 */
// TODO(Task 8): withContext blocks + withCachedPrompt, reusing src/agent/prompt/*.
export function withFirefighterContext(session: Session, _agent: RunAgent): Session {
  return session;
}

/**
 * The system blocks for ONE step.
 *
 * An array rather than a string because the two Anthropic cache breakpoints
 * are expressed as separate `SystemModelMessage`s — a single joined string
 * silently loses them. Invariant 24: the generated capability declarations are
 * NOT among these blocks; they live only in the `run_code` tool description.
 */
// TODO(Task 8): render the real persona/policy/context blocks with cache control.
export function firefighterSystemBlocks(_agent: RunAgent): SystemModelMessage[] {
  return [];
}
