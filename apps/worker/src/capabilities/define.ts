/**
 * What a capability IS, and the brand that proves it was built here.
 *
 * Every model-reachable method in `src/capabilities/namespaces/` is created by
 * `defineCapability` (in practice through `auditedCapability`, which wraps it
 * with the audit, budget and write-guard pipeline). Two things make that a real
 * constraint rather than a convention:
 *
 *  - `effect` is REQUIRED and has no default. An unclassified capability is a
 *    policy hole, so the type system refuses one and the constructor
 *    double-checks at runtime.
 *  - the `AUDITED` brand is a module-private symbol. A tool object assembled by
 *    hand cannot forge it, which is what lets `assertClassified` be a check
 *    instead of a naming rule.
 */
import { z } from "zod";

import { CapabilityError } from "../gateways/errors";

/**
 * What a capability does to the world. The write guard reads this, and only
 * `external_write` is gated on channel policy and shadow — see `write-guard.ts`
 * for why the other three are not.
 */
export const CAPABILITY_EFFECTS = [
  /** Reads only. Never touches the effect ledger. */
  "read",
  /** Leaves this system: a Slack message, a Linear issue, a PR, a published file. */
  "external_write",
  /** Changes this run's own control state: an approval opened or withdrawn. */
  "control_write",
  /** Changes this run's container, which holds no write credentials. */
  "sandbox_write",
] as const;

export type CapabilityEffect = (typeof CAPABILITY_EFFECTS)[number];

export function isCapabilityEffect(value: unknown): value is CapabilityEffect {
  return typeof value === "string" && (CAPABILITY_EFFECTS as readonly string[]).includes(value);
}

/**
 * Module-private brand. Not exported, so `[AUDITED]: true` cannot be written
 * anywhere but this file.
 */
const AUDITED = Symbol("firefighter.auditedCapability");

export type CapabilitySpec<I, O> = {
  description: string;
  /** REQUIRED. No default, ever. */
  effect: CapabilityEffect;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  run: (input: I) => Promise<O>;
};

export type ClassifiedTool = {
  description: string;
  effect: CapabilityEffect;
  input: z.ZodType;
  output: z.ZodType;
  /** Parses its argument with `input` before calling the spec's `run`. */
  run: (input: unknown) => Promise<unknown>;
  readonly [AUDITED]: true;
};

/**
 * Name the offending paths and rules, never the offending values.
 *
 * The model needs to know WHICH field is wrong; echoing what it sent would put
 * arbitrary model output into an error string that also reaches the audit log.
 */
export function formatZodIssues(error: z.ZodError): string {
  const issues = error.issues
    .slice(0, 6)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.code}`;
    })
    .join("; ");
  return `the arguments are not valid (${issues})`;
}

export function defineCapability<I, O>(spec: CapabilitySpec<I, O>): ClassifiedTool {
  if (!isCapabilityEffect(spec.effect)) {
    // Reachable from JavaScript callers and from a bad cast, so it is a runtime
    // check and not only a type.
    throw new CapabilityError(
      "invalid_context",
      "capability declares no effect, or an unknown one",
    );
  }

  return {
    [AUDITED]: true,
    description: spec.description,
    effect: spec.effect,
    input: spec.input as z.ZodType,
    output: spec.output as z.ZodType,
    // The runtime parse lives here rather than in the connector: the connector
    // hands the model a JSON Schema for typing, but JSON Schema is not what
    // validates the call.
    run: async (input: unknown) => {
      const parsed = spec.input.safeParse(input);
      if (!parsed.success) {
        throw new CapabilityError("invalid_input", formatZodIssues(parsed.error));
      }
      return spec.run(parsed.data);
    },
  };
}

/** The effect of a tool built here, or null for anything that was not. */
export function capabilityEffectOf(tool: unknown): CapabilityEffect | null {
  if (typeof tool !== "object" || tool === null) return null;
  if ((tool as Record<symbol, unknown>)[AUDITED] !== true) return null;
  const effect = (tool as { effect?: unknown }).effect;
  return isCapabilityEffect(effect) ? effect : null;
}

/**
 * Throws unless every tool in the record went through `defineCapability`.
 *
 * The registry calls this on each namespace before returning it, so a binding
 * that hand-rolled a tool object — and therefore skipped the audit wrapper and
 * the write guard — fails at construction rather than at the first call.
 */
export function assertClassified(namespace: string, tools: Record<string, unknown>): void {
  for (const [method, tool] of Object.entries(tools)) {
    if (capabilityEffectOf(tool) === null) {
      throw new CapabilityError(
        "invalid_context",
        `capability ${namespace}.${method} is not classified`,
      );
    }
  }
}
