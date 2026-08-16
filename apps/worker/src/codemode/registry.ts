import type { ToolDescriptor, ToolDescriptors } from "@cloudflare/codemode/ai";
import type { z } from "zod";
import type { JsonObject } from "../run/protocol";
import { withCapabilityAudit, type CodeExecution } from "./bindings/shared";
import type { CodeModeLimits, CodeModeScope } from "./contracts";
import type { EffectDeps } from "./effects";
import { CapabilityError } from "./errors";
import type { CapabilityDependencies } from "./gateways";
import {
  assertEffectPermitted,
  isCapabilityEffect,
  type CapabilityEffect,
} from "./write-guard";

import { makeSlackTools } from "./bindings/slack";
import { makeMemoryTools } from "./bindings/memory";
import { makeLinearTools } from "./bindings/linear";
import { makeSupabaseTools } from "./bindings/supabase";
import { makeLangSmithTools } from "./bindings/langsmith";
import { makeBetterStackTools } from "./bindings/betterstack";
import { FILES_DECLARATIONS, makeFilesTools } from "./bindings/files";
import { makeApprovalTools } from "./bindings/approval";
import { makeSandboxTools } from "./bindings/sandbox";
import { makeBrowserTools } from "./bindings/browser";
import { makeGithubTools } from "./bindings/github";

/**
 * Re-exported so the connector layer can type a namespace's tools without
 * reaching into `@cloudflare/codemode/ai` itself. One import site for the
 * package's descriptor shape keeps a version bump a one-file change.
 */
export type { ToolDescriptor };

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
  // Phase 11's addition. Appended, not inserted — the name stays
  // `PHASE_09_NAMESPACES` because it is the frozen ORDER's identity, not a
  // claim about which phase last touched it.
  "approval",
  // Phase 18's. Appended for the same reason: inserting it anywhere else would
  // rewrite every later block of the committed `.d.ts` for no gain.
  "sandbox",
  // Phase 19's tenth. Same reason again — a real browser and its recording
  // are a distinct model-facing surface from a shell, even though both run on
  // the `sandbox` gateway's one container.
  "browser",
  // Phase 20's eleventh and last: opening the pull request itself. Appended
  // for the same reason every entry above it was — inserting it earlier would
  // rewrite every later block of the committed `.d.ts` for no gain, and this
  // namespace's job (compiling the monorepo's PR conventions) only makes
  // sense once a diff, a proof recording and a linked issue already exist.
  "github",
] as const;

/**
 * Proof that a descriptor was built by `auditedCapability`.
 *
 * Module-private and unexported, so it cannot be stamped from anywhere else in
 * the codebase — which is the entire point. The `effect` field alone is a
 * LABEL: a hand-rolled descriptor could carry `effect: "external_write"` and
 * still run with no budget, no audit and no write guard, because those come
 * from the wrapper rather than from the string. Checking the brand checks the
 * WIRING, which is what the registry actually needs to know.
 */
const AUDITED = Symbol("firefighter.auditedCapability");

/**
 * A tool descriptor that carries its effect classification and its provenance.
 *
 * Both ride on the descriptor rather than in a parallel table because a
 * parallel table is a second thing to update: a new method would compile, run,
 * and simply not appear in the map. `@cloudflare/codemode`'s resolver reads
 * `description`, `inputSchema`, `outputSchema` and `execute` and ignores the
 * rest, so both are inert on the wire and never reach the model. The brand is
 * a symbol, so it is also invisible to `Object.entries` and `JSON.stringify`.
 */
export type ClassifiedTool = ToolDescriptor & {
  effect: CapabilityEffect;
  [AUDITED]: true;
};

/**
 * The effect of a tool that genuinely went through the chokepoint.
 *
 * Returns null for an unbranded descriptor even when it carries a valid-looking
 * `effect`, because an unbranded descriptor has not been through the guard no
 * matter what it claims about itself.
 */
export function capabilityEffectOf(tool: ToolDescriptor): CapabilityEffect | null {
  const candidate = tool as Partial<ClassifiedTool>;
  if (candidate[AUDITED] !== true) return null;
  return isCapabilityEffect(candidate.effect) ? candidate.effect : null;
}

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
  /** The state of the ONE `run_code` execution these bindings serve. */
  execution: CodeExecution;
};

/**
 * The ledger's view of one execution.
 *
 * A helper rather than three hand-written literals, because the field that is
 * easiest to forget is `signal` — and a mutator that silently keeps waiting
 * after the caller gave up is exactly the case Step 5 exists to bound.
 */
export function effectDeps(ctx: BindingContext): EffectDeps {
  return {
    db: ctx.deps.db,
    clock: ctx.deps.clock,
    signal: ctx.execution.abortSignal,
  };
}

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
  /**
   * REQUIRED, with no default. See `CapabilityEffect` — omitting it is a
   * compile error here and a construction failure in `buildRegistry`, because
   * the alternative is a capability that quietly skips the write guard.
   */
  effect: CapabilityEffect;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  run: (input: I) => Promise<O>;
}): ToolDescriptor & { effect: CapabilityEffect } {
  return {
    effect: spec.effect,
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
 * `defineCapability` plus the audit/budget chokepoint plus the write guard.
 * Every capability in every namespace goes through this, which is what makes
 * the per-execution call budget a property of the execution rather than of one
 * provider — and what makes the write policy a property of the effect class
 * rather than of whichever adapter remembered to check.
 *
 * The guard runs INSIDE `withCapabilityAudit`, as the first thing in the
 * capability body. That placement is deliberate on both sides:
 *
 *  - inside, so a refusal is counted against the budget and leaves a `started`
 *    and a `failed` record. "The model kept trying to post from a shadow run"
 *    is exactly what an operator needs to be able to see, and a refusal that
 *    leaves no trace is indistinguishable from a call that never happened;
 *  - first, so the D1 policy reads happen immediately before the vendor call
 *    and after the freshness check, not once at composition time.
 */
export function auditedCapability<I, O>(
  ctx: BindingContext,
  namespace: string,
  method: string,
  spec: {
    description: string;
    effect: CapabilityEffect;
    input: z.ZodType<I>;
    output: z.ZodType<O>;
    run: (input: I) => Promise<O>;
  },
): ClassifiedTool {
  return {
    // Stamped HERE and nowhere else: this is the only function that attaches
    // the budget, the audit stream and the write guard, so it is the only one
    // entitled to certify that a descriptor has them. `defineCapability` alone
    // attaches validation and a label, which is not the same claim.
    [AUDITED]: true,
    ...defineCapability({
      description: spec.description,
      effect: spec.effect,
      input: spec.input,
      output: spec.output,
      run: (input: I) =>
        withCapabilityAudit(
          ctx.execution,
          ctx.scope,
          namespace,
          method,
          async () => {
            await assertEffectPermitted(ctx.deps, ctx.scope, spec.effect);
            return spec.run(input);
          },
          auditArgs(input),
        ),
    }),
  };
}

/* --------------------------------------------------------------- registry -- */

/**
 * Assemble the capability surface for ONE execution.
 *
 * The same namespaces are always present, whatever the run looks like. A
 * registry that varied by run would leak the host's classification of the run
 * into the model's context, and Phase 07 deliberately emits no ticket type for
 * exactly that reason. Where a run's context makes a capability unusable —
 * a Chat run has no Slack thread — the capability is still declared and
 * refuses at call time with a code the model can read.
 *
 * Call this once per `run_code` execution and never reuse the result. The
 * closures it returns capture the execution: its call budget, its citation
 * cache, its customer references, its audit stream. Handing one registry to two
 * executions merges all four, which is the defect Phase 10 Task 1 repaired —
 * `execution` is a required argument rather than something built in here so
 * that reusing one is a thing you have to write down.
 */
export function buildNamespaces(
  scope: CodeModeScope,
  deps: CapabilityDependencies,
  limits: CodeModeLimits,
  execution: CodeExecution,
): CapabilityRegistry {
  const ctx: BindingContext = { scope, deps, limits, execution };

  return assertClassified([
    { name: "slack", tools: makeSlackTools(ctx) },
    { name: "memory", tools: makeMemoryTools(ctx) },
    { name: "linear", tools: makeLinearTools(ctx) },
    { name: "supabase", tools: makeSupabaseTools(ctx) },
    { name: "langsmith", tools: makeLangSmithTools(ctx) },
    { name: "betterstack", tools: makeBetterStackTools(ctx) },
    { name: "files", tools: makeFilesTools(ctx), types: FILES_DECLARATIONS },
    { name: "approval", tools: makeApprovalTools(ctx) },
    { name: "sandbox", tools: makeSandboxTools(ctx) },
    { name: "browser", tools: makeBrowserTools(ctx) },
    { name: "github", tools: makeGithubTools(ctx) },
  ]);
}

/**
 * The old name, unchanged.
 *
 * Phase 25 gave this function a second consumer — `buildConnectors`, which
 * wraps each namespace in a `FirefighterConnector` for the Think chassis — so
 * "registry" stopped being the only thing it builds. The alias exists so that
 * renaming the concept costs zero call-site churn while both chassis are
 * alive; the legacy chassis keeps calling `buildRegistry` and gets the exact
 * same function object.
 */
export const buildRegistry = buildNamespaces;

/**
 * Refuse to build a registry containing an unclassified method.
 *
 * The compile-time half of this rule — `effect` being a required field on
 * `auditedCapability` — only binds capabilities that go through
 * `auditedCapability`. A future namespace could hand `buildRegistry` a bare
 * `ToolDescriptor` object literal and typecheck cleanly, because
 * `ToolDescriptors` is the package's type and knows nothing about effects.
 * That capability would then run with no budget, no audit and no write guard.
 *
 * So the rule is also enforced at construction, on the real registry, where a
 * bare descriptor cannot hide. What is checked is the BRAND, not the label: a
 * hand-rolled descriptor that helpfully declares `effect: "external_write"`
 * still has no guard attached, because the guard comes from the wrapper and not
 * from the string. Only `auditedCapability` can stamp the brand, and it is the
 * function that attaches the guard.
 *
 * Throwing rather than defaulting is the whole point: the reviewed failure mode
 * for "somebody forgot" is a loud crash on the first `run_code` call, never a
 * Linear issue filed by a shadow run.
 */
export function assertClassified(registry: CapabilityRegistry): CapabilityRegistry {
  for (const provider of registry) {
    for (const [method, tool] of Object.entries(provider.tools)) {
      if (capabilityEffectOf(tool) === null) {
        throw new CapabilityError(
          "invalid_context",
          `${provider.name}.${method} was not built by auditedCapability with an effect classification, so it has no budget, no audit and no write guard. Define it with auditedCapability(ctx, namespace, method, { effect: "read" | "external_write" | "control_write" | "sandbox_write", … }).`,
        );
      }
    }
  }
  return registry;
}
