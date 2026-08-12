import type { ModelMessage, SystemModelMessage } from "ai";
import {
  renderStablePolicy,
  renderVoiceExamples,
  STABLE_PREFIX_CACHE_OPTIONS,
} from "./policy";
import { renderTrustedContext, type TrustedContext } from "./context";

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
  type RunCoordinates,
  type TrustedContext,
  type TrustedContextOutcome,
  type TrustedContextRefusal,
} from "./context";
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
 *   1. stable system policy        (instructions[0], never varies)
 *   2. stable voice examples       (instructions[1], never varies, cache mark)
 *   3. dynamic trusted context     (instructions[2], varies per run)
 *   4. untrusted model messages    (messages, chronological, all role user/…)
 *
 * Two independent reasons, and both would be broken by concatenating 1-3 into
 * one string:
 *
 *  - **Caching.** Anthropic reuses a stable PREFIX. Blocks 1 and 2 are byte-
 *    identical on every request in this build, so they can be reused; block 3
 *    changes per run and must come after them. One concatenated string changes
 *    whenever block 3 does, and nothing is ever reused (invariant 26).
 *  - **Authority.** Blocks 1-3 are things the host wrote. Everything in
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
}): AgentPrompt {
  const instructions: SystemModelMessage[] = [
    { role: "system", content: renderStablePolicy() },
    {
      role: "system",
      content: renderVoiceExamples(),
      // The end of the cacheable prefix. Deliberately on the last STABLE block.
      providerOptions: STABLE_PREFIX_CACHE_OPTIONS,
    },
    { role: "system", content: renderTrustedContext(input.context) },
  ];

  // Copied, not aliased. A caller that later mutates its own array must not be
  // able to reach into a prompt that has already been handed to the provider.
  return { instructions, messages: [...input.messages] };
}

/** The section order, as data, so a test can assert it without matching prose. */
export const PROMPT_SECTION_ORDER = [
  "stable_policy",
  "stable_voice_examples",
  "dynamic_trusted_context",
  "untrusted_model_messages",
] as const;
