import type { ModelMessage, SystemModelMessage } from "ai";
import {
  renderStablePolicy,
  renderVoiceExamples,
  STABLE_PREFIX_CACHE_OPTIONS,
} from "./policy";
import { renderTrustedContext, type TrustedContext } from "./context";
import { renderEngineerVoice, type EngineerVoice } from "./voice";

export {
  ANTHROPIC_PROVIDER_OPTIONS,
  renderStablePolicy,
  renderVoiceExamples,
  STABLE_POLICY_SECTIONS,
  STABLE_PREFIX_CACHE_OPTIONS,
  VOICE_EXAMPLES,
  VOICE_EXAMPLE_MAX_BYTES,
  VOICE_EXAMPLE_MAX_COUNT,
  type PromptSection,
} from "./policy";
export {
  renderTrustedContext,
  resolveTrustedContext,
  type PendingApproval,
  type RunCoordinates,
  type TrustedContext,
  type TrustedContextOutcome,
  type TrustedContextRefusal,
} from "./context";
export {
  ENGINEER_VOICE_MAX_COUNT,
  ENGINEER_VOICE_MAX_TOTAL_CHARS,
  ENGINEER_VOICE_MIN_USABLE,
  ENGINEER_VOICE_SAMPLE_MAX_CHARS,
  renderEngineerVoice,
  resolveEngineerVoice,
  type EngineerVoice,
} from "./voice";
export {
  decodeUntrustedEvidence,
  encodeUntrustedEvidence,
  EVIDENCE_ENVELOPE_VERSION,
  isLegacySystemAuthorityTurn,
  PromptAuthorityError,
  toInputModelMessage,
  type UntrustedEvidence,
} from "./evidence";

/**
 * The prompt, assembled. One function, one order, one place to read it.
 *
 * THE ORDER IS THE DELIVERABLE:
 *
 *   1. stable system policy        (never varies)
 *   2. stable voice examples       (never varies, cache mark)
 *  2b. engineer voice, if any      (shift-stable, its OWN cache mark)
 *   3. dynamic trusted context     (varies per run)
 *   4. untrusted model messages    (messages, chronological, all role user/…)
 *
 * TWO CACHE BREAKPOINTS, ON PURPOSE. Anthropic allows four; this uses two, and
 * they have different lifetimes:
 *
 *  - The mark on block 2 ends the BUILD-STABLE prefix. It is byte-identical on
 *    every request this build ever makes, so it survives shift boundaries and
 *    rotations, and a cold engineer with no samples costs nothing.
 *  - The mark on block 2b ends the SHIFT-STABLE prefix. Block 2b changes exactly
 *    once every three days, at the boundary, and is frozen between them (see
 *    `voice.ts` — the freeze is a SQL bound, not a memo). Every request within
 *    one shift reuses it.
 *
 * Block 2b is OMITTED entirely when it renders empty, which keeps the two-block
 * layout and its single mark exactly as it was before this existed. It is never
 * emitted as an empty system block: a zero-length block is a byte-stable way to
 * spend a breakpoint on nothing.
 *
 * Two independent reasons, and both would be broken by concatenating 1-3 into
 * one string:
 *
 *  - **Caching.** Anthropic reuses a stable PREFIX. Blocks 1, 2 and 2b are byte-
 *    identical across every request that can reuse them, so they can be reused;
 *    block 3 changes per run and must come after them. One concatenated string
 *    changes whenever block 3 does, and nothing is ever reused (invariant 26).
 *  - **Authority.** Blocks 1-3 are things the host wrote. Block 2b is host-
 *    written framing around QUOTED sample text — the engineer's own past
 *    messages, JSON-stringified so they read as data, exactly as the static
 *    examples in block 2 are. Nothing untrusted gains authority by sitting here. Everything in
 *    `messages` is something the host RECEIVED. Keeping them in different fields
 *    with different roles is what makes that boundary structural rather than
 *    typographic.
 *
 * The `ai` package's `Instructions` type is
 * `string | SystemModelMessage | SystemModelMessage[]`; this returns the array
 * form so the three blocks stay three blocks all the way to the provider.
 *
 * Note honestly: this layout is a necessary condition for prompt caching, not
 * evidence of it. Only a deployed request reporting `cacheReadTokens > 0` proves
 * the provider accepted the boundary, and that proof is deferred.
 */
export type AgentPrompt = {
  instructions: SystemModelMessage[];
  messages: ModelMessage[];
};

export function buildAgentPrompt(input: {
  context: TrustedContext;
  /** Chronological, oldest first. Already normalized; never turns. */
  messages: ModelMessage[];
  /**
   * The on-duty engineer's own writing, resolved as of THIS SHIFT'S START.
   *
   * Optional, and its absence means "no such block" rather than "an empty one":
   * a caller with no D1 handle (a composer test, a prompt snapshot) gets exactly
   * the layout that shipped before this existed. `resolveEngineerVoice` is the
   * only thing that should ever produce this value — a caller assembling one by
   * hand from live data would be re-introducing the mid-shift churn the freeze
   * exists to prevent.
   */
  voice?: EngineerVoice | null;
}): AgentPrompt {
  // Rendered ONCE. It is empty below the usable floor, and an empty block is
  // dropped rather than emitted: see the note about spending a breakpoint on
  // nothing, above.
  const engineerVoice = input.voice == null ? "" : renderEngineerVoice(input.voice);

  const instructions: SystemModelMessage[] = [
    { role: "system", content: renderStablePolicy() },
    {
      role: "system",
      content: renderVoiceExamples(),
      // The end of the BUILD-stable prefix. Deliberately on the last block that
      // is byte-identical for the lifetime of this deployment.
      providerOptions: STABLE_PREFIX_CACHE_OPTIONS,
    },
    ...(engineerVoice === ""
      ? []
      : [
          {
            role: "system" as const,
            content: engineerVoice,
            // The end of the SHIFT-stable prefix, and the second of Anthropic's
            // four breakpoints. Safe to mark only because the block is frozen
            // for the whole shift; marking anything that could change
            // mid-request-stream pays the write multiplier for nothing.
            providerOptions: STABLE_PREFIX_CACHE_OPTIONS,
          },
        ]),
    { role: "system", content: renderTrustedContext(input.context) },
  ];

  // Copied, not aliased. A caller that later mutates its own array must not be
  // able to reach into a prompt that has already been handed to the provider.
  return { instructions, messages: [...input.messages] };
}

/**
 * The section order, as data, so a test can assert it without matching prose.
 *
 * `engineer_voice` is listed even though the block is absent when it renders
 * empty: this is the ORDER, which is fixed, not a manifest of one request.
 */
export const PROMPT_SECTION_ORDER = [
  "stable_policy",
  "stable_voice_examples",
  "engineer_voice",
  "dynamic_trusted_context",
  "untrusted_model_messages",
] as const;
