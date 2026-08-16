import type { CodemodeConnector } from "@cloudflare/codemode";
import type { Env } from "../../index";
import type { CodeExecution } from "../bindings/shared";
import type { CodeModeLimits, CodeModeScope } from "../contracts";
import type { CapabilityDependencies } from "../gateways";
import { buildNamespaces, type CapabilityProvider } from "../registry";
import { FirefighterConnector, type CapabilityNamespace } from "./base";

/**
 * Adapt one registry provider to the shape the connector takes.
 *
 * Not a no-op, and deliberately explicit rather than a whole-object cast. Two
 * differences have to be decided here rather than by structural luck:
 *
 *  - `CapabilityProvider.tools` is typed as the package's bare
 *    `ToolDescriptor`, which knows nothing about effects, while
 *    `CapabilityNamespace` requires `effect` on every one. The narrowing is
 *    sound because `buildNamespaces` runs `assertClassified` over the whole
 *    array before returning it, and that throws on any descriptor not stamped
 *    by `auditedCapability` — so by the time a provider reaches this function,
 *    every method demonstrably carries the brand the effect field belongs to.
 *    The cast asserts what construction has already proven; it is not a
 *    promise about descriptors this function has not seen.
 *  - `CapabilityProvider.types` is NOT `CapabilityNamespace.instructions`.
 *    `types` is the hand-written declaration override (the `files` namespace
 *    needs one because `z.instanceof(Uint8Array)` has no JSON Schema), and it
 *    belongs to declaration rendering, not to the model-facing guidance a
 *    connector carries. Mapping one onto the other would put a `.d.ts` block
 *    into the connector's instructions. It is dropped here on purpose.
 */
function toNamespace(provider: CapabilityProvider): CapabilityNamespace {
  return {
    name: provider.name,
    tools: provider.tools as CapabilityNamespace["tools"],
  };
}

/**
 * The eleven capability namespaces as codemode connectors, for ONE execution.
 *
 * Both chassis call `buildNamespaces`, so the capability code the model
 * actually reaches — the Zod parse, the audit chokepoint, the write guard, the
 * effect ledger, the budget — is the same code object on either path. Only the
 * presentation differs: the legacy chassis hands the descriptors to
 * `runCode`'s resolver, this one wraps each namespace in a connector.
 *
 * Declaration order is preserved and is load-bearing: it is the order
 * `PHASE_09_NAMESPACES` freezes, which is the order the committed
 * `capabilities.d.ts` renders in and therefore the order the model reads its
 * API in. `map` keeps it; nothing here may sort or filter.
 *
 * The same one-execution rule that governs `buildNamespaces` governs this:
 * call it once per `run_code` execution and never reuse the result. The
 * connectors close over the execution's budget, citation cache and audit
 * stream, so two executions sharing one array would merge all three.
 *
 * `env` is a parameter rather than something read off `deps` on purpose:
 * `CapabilityDependencies` deliberately never carries the Worker `env` (see
 * its doc comment — providers get gateways, never bindings), while
 * `CodemodeConnector` extends `WorkerEntrypoint` and its constructor requires
 * one. Passing it here keeps that boundary where it was instead of widening
 * the dependency bag to smuggle bindings into the binding modules.
 */
export function buildConnectors(
  ctx: DurableObjectState | ExecutionContext,
  scope: CodeModeScope,
  deps: CapabilityDependencies,
  limits: CodeModeLimits,
  execution: CodeExecution,
  env: Env,
): CodemodeConnector[] {
  return buildNamespaces(scope, deps, limits, execution).map(
    (provider) => new FirefighterConnector(ctx, env, toNamespace(provider)),
  );
}
