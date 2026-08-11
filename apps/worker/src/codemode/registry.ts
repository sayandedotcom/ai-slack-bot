import type { ToolDescriptor, ToolDescriptors } from "@cloudflare/codemode/ai";
import type { z } from "zod";
import type { JsonObject } from "../run/protocol";
import {
  newCallCounter,
  withCapabilityAudit,
  type CallCounter,
} from "./bindings/shared";
import type {
  CapabilityAuditSink,
  CodeModeLimits,
  CodeModeScope,
} from "./contracts";
import { CapabilityError } from "./errors";
import type { CapabilityDependencies } from "./gateways";

import { makeSlackTools } from "./bindings/slack";
import { makeMemoryTools } from "./bindings/memory";
import { makeLinearTools } from "./bindings/linear";
import { makeSupabaseTools } from "./bindings/supabase";
import { makeLangSmithTools } from "./bindings/langsmith";
import { makeBetterStackTools } from "./bindings/betterstack";
import { FILES_DECLARATIONS, makeFilesTools } from "./bindings/files";

/**
 * The Phase 09 namespace order, frozen.
 *
 * Order is not cosmetic: it is the order declarations are rendered in, so a
 * reshuffle produces a diff in the committed `.d.ts` and in the model's
 * context. Later phases append; they do not reorder.
 */
export const PHASE_09_NAMESPACES = [
  "slack",
  "memory",
  "linear",
  "supabase",
  "langsmith",
  "betterstack",
  "files",
] as const;

export type CapabilityProvider = {
  name: string;
  tools: ToolDescriptors;
  /**
   * Declarations to use instead of the generated ones.
   *
   * An escape hatch with exactly one legitimate cause: a schema JSON Schema
   * cannot express. `generateTypes` degrades such an input to `unknown` for the
   * WHOLE capability, silently — see the files namespace. Anything else should
   * be generated, and the `= unknown` test is what keeps that honest.
   */
  types?: string;
};
export type CapabilityRegistry = CapabilityProvider[];

/** Everything a binding module needs. Never the Worker `env`. */
export type BindingContext = {
  scope: CodeModeScope;
  deps: CapabilityDependencies;
  limits: CodeModeLimits;
  audit: CapabilityAuditSink;
  counter: CallCounter;
};

/* ------------------------------------------------------------- validation -- */

/**
 * Name the offending paths and rules, never the offending values. The model
 * needs to know *which field* is wrong; echoing what it sent would put
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

/**
 * The single place input validation is attached.
 *
 * It parses with its own schema rather than relying on the resolver, because
 * `@cloudflare/codemode` exports **two** `resolveProvider`s and only the `/ai`
 * one validates — the base one in `dist/resolve.js` says so in a comment, and
 * `runCode` lives in the entry that exports the non-validating variant.
 * Correctness must not depend on which import line a future refactor picks.
 *
 * Note what is deliberately absent: `needsApproval`. The package's resolver
 * silently DROPS any tool carrying it, so an annotation added here would make
 * a capability vanish with no error. Approval is a model decision in Phase 11,
 * never a tool annotation.
 */
export function defineCapability<I, O>(spec: {
  description: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  run: (input: I) => Promise<O>;
}): ToolDescriptor {
  return {
    description: spec.description,
    inputSchema: spec.input,
    // Without an outputSchema the generated return type is `unknown`, which
    // teaches the model nothing and makes every result need a cast.
    outputSchema: spec.output,
    execute: async (raw: unknown): Promise<unknown> => {
      const parsed = spec.input.safeParse(raw);
      if (!parsed.success) {
        throw new CapabilityError("invalid_input", formatZodIssues(parsed.error));
      }
      return spec.run(parsed.data);
    },
  };
}

function auditArgs(input: unknown): JsonObject | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  return input as JsonObject;
}

/**
 * `defineCapability` plus the audit and budget chokepoint. Every capability in
 * every namespace goes through this, which is what makes the per-execution call
 * budget a property of the execution rather than of one provider.
 */
export function auditedCapability<I, O>(
  ctx: BindingContext,
  namespace: string,
  method: string,
  spec: {
    description: string;
    input: z.ZodType<I>;
    output: z.ZodType<O>;
    run: (input: I) => Promise<O>;
  },
): ToolDescriptor {
  return defineCapability({
    description: spec.description,
    input: spec.input,
    output: spec.output,
    run: (input: I) =>
      withCapabilityAudit(
        { audit: ctx.audit, clock: ctx.deps.clock },
        ctx.scope,
        ctx.counter,
        namespace,
        method,
        () => spec.run(input),
        auditArgs(input),
      ),
  });
}

/* --------------------------------------------------------------- registry -- */

/**
 * Assemble the capability surface for one execution.
 *
 * The same namespaces are always present, whatever the run looks like. A
 * registry that varied by run would leak the host's classification of the run
 * into the model's context, and Phase 07 deliberately emits no ticket type for
 * exactly that reason. Where a run's context makes a capability unusable —
 * a Chat run has no Slack thread — the capability is still declared and
 * refuses at call time with a code the model can read.
 */
export function buildRegistry(
  scope: CodeModeScope,
  deps: CapabilityDependencies,
  limits: CodeModeLimits,
  audit: CapabilityAuditSink,
): CapabilityRegistry {
  // One counter per execution, shared across every namespace.
  const ctx: BindingContext = {
    scope,
    deps,
    limits,
    audit,
    counter: newCallCounter(limits),
  };

  return [
    { name: "slack", tools: makeSlackTools(ctx) },
    { name: "memory", tools: makeMemoryTools(ctx) },
    { name: "linear", tools: makeLinearTools(ctx) },
    { name: "supabase", tools: makeSupabaseTools(ctx) },
    { name: "langsmith", tools: makeLangSmithTools(ctx) },
    { name: "betterstack", tools: makeBetterStackTools(ctx) },
    { name: "files", tools: makeFilesTools(ctx), types: FILES_DECLARATIONS },
  ];
}
