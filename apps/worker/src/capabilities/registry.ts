/**
 * The capability surface for ONE `run_code` execution.
 *
 * `auditedCapability` is the chokepoint: it is the only function that attaches
 * the per-execution budget, the audit stream and the write guard, so it is the
 * only one entitled to stamp a tool as classified. Everything else here is
 * assembly.
 */
import type { CodemodeConnector } from "@cloudflare/codemode";

import type { CapabilityDependencies } from "../gateways/ports";
import type { RunScope } from "../gateways/scope";
import type { Env } from "../index";
import { FirefighterConnector, type CapabilityNamespace } from "./connector";
import {
  assertClassified,
  type CapabilityEffect,
  type CapabilitySpec,
  type ClassifiedTool,
  defineCapability,
} from "./define";
import type { EffectDeps } from "./effects";
import { type CapabilityLimits, type CodeExecution, withCapabilityAudit } from "./execution";
import { assertEffectPermitted } from "./write-guard";

import { makeSlackTools } from "./namespaces/slack";

/**
 * The namespace order, frozen.
 *
 * Order is not cosmetic: it is the order declarations are rendered in, so a
 * reshuffle produces a diff in the committed `.d.ts` and in the model's
 * context. Later work appends; it does not reorder.
 */
export const CAPABILITY_NAMESPACES = [
  "slack",
  "memory",
  "linear",
  "supabase",
  "langsmith",
  "betterstack",
  "files",
  "approval",
  "sandbox",
  "browser",
  "github",
] as const;

export type CapabilityNamespaceName = (typeof CAPABILITY_NAMESPACES)[number];

/** Everything a namespace module needs. Never the Worker `env`. */
export type BindingContext = {
  scope: RunScope;
  deps: CapabilityDependencies;
  limits: CapabilityLimits;
  /** The state of the ONE `run_code` execution these namespaces serve. */
  execution: CodeExecution;
};

/**
 * The ledger's view of one execution.
 *
 * A helper rather than three hand-written literals, because the field easiest
 * to forget is `signal` — and a mutator that silently keeps waiting after the
 * caller gave up is exactly what the abort budget exists to bound.
 */
export function effectDeps(ctx: BindingContext): EffectDeps {
  return {
    db: ctx.deps.db,
    clock: ctx.deps.clock,
    signal: ctx.execution.abortSignal,
  };
}

/**
 * `defineCapability` plus the audit/budget chokepoint plus the write guard.
 *
 * The guard runs INSIDE `withCapabilityAudit`, as the first thing in the
 * capability body. That placement is deliberate on both sides:
 *
 *  - inside, so a refusal is counted against the budget and leaves a `started`
 *    and a `failed` record. "The model kept trying to post from a shadow run"
 *    is exactly what an operator needs to see, and a refusal that leaves no
 *    trace is indistinguishable from a call that never happened;
 *  - first, so the D1 policy reads happen immediately before the vendor call
 *    and after the freshness check, not once at composition time.
 */
export function auditedCapability<I, O>(
  ctx: BindingContext,
  namespace: string,
  method: string,
  spec: CapabilitySpec<I, O>,
): ClassifiedTool {
  return defineCapability({
    ...spec,
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
  });
}

function auditArgs(input: unknown): Record<string, unknown> | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
}

/**
 * Assemble the namespaces for ONE execution.
 *
 * The same namespaces are always present, whatever the run looks like. A
 * surface that varied by run would leak the host's classification of the run
 * into the model's context, and triage deliberately emits no ticket type for
 * exactly that reason. Where a run's context makes a capability unusable — a
 * Chat run has no Slack thread — the capability is still declared and refuses
 * at call time with a code the model can read.
 *
 * Call once per `run_code` execution and never reuse the result. The closures
 * capture the execution: its call budget, its citation cache, its customer
 * references, its audit stream. Handing one set to two executions merges all
 * four, so `execution` is a required argument rather than something built here.
 */
export function buildNamespaces(ctx: BindingContext): CapabilityNamespace[] {
  const namespaces: CapabilityNamespace[] = [{ name: "slack", tools: makeSlackTools(ctx) }];

  for (const namespace of namespaces) {
    // Checks the BRAND, not the label. A hand-rolled tool that helpfully
    // declares effect: "external_write" still has no guard attached, because
    // the guard comes from the wrapper and not from the string.
    assertClassified(namespace.name, namespace.tools);
  }
  return namespaces;
}

/**
 * The namespaces as codemode connectors, for ONE execution.
 *
 * Declaration order is preserved and load-bearing: it is the order
 * `CAPABILITY_NAMESPACES` freezes, which is the order the committed
 * `capabilities.d.ts` renders in and therefore the order the model reads its
 * API in. Nothing here may sort or filter.
 *
 * `env` is a parameter rather than something read off `deps` on purpose:
 * `CapabilityDependencies` deliberately never carries the Worker `env` — a
 * namespace that wanted a credential would have to widen that type first, in a
 * diff — while `CodemodeConnector` extends `WorkerEntrypoint` and its
 * constructor requires one.
 */
export function buildConnectors(
  doCtx: DurableObjectState | ExecutionContext,
  env: Env,
  ctx: BindingContext,
): CodemodeConnector[] {
  return buildNamespaces(ctx).map((ns) => new FirefighterConnector(doCtx, env, ns));
}

export type { CapabilityEffect };
