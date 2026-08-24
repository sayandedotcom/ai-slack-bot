import { CodemodeConnector, type ConnectorTools } from "@cloudflare/codemode";

import { CapabilityError } from "../gateways/errors";
import type { Env } from "../index";
import type { ClassifiedTool } from "./define";
import { toJsonSchema } from "./schema";

/** One capability namespace as the connector layer sees it. */
export type CapabilityNamespace = {
  name: string;
  instructions?: string;
  tools: Record<string, ClassifiedTool>;
};

/**
 * A namespace that has not been bound to an execution yet.
 *
 * The indirection exists because `CodemodeConnector.resolvedTools()` caches
 * `tools()` per connector INSTANCE (`#toolsPromise ??=`), while a
 * BindingContext belongs to ONE `run_code` execution — its call budget, audit
 * stream, citation cache and customer references must not be shared with the
 * next execution. So the connector holds a factory plus a provider and rebuilds
 * the namespace against a fresh context inside every `execute`.
 *
 * Schemas and descriptions do not vary by run, so the cached `tools()` may
 * render them from whichever context it happens to get.
 */
export type CapabilityNamespaceFactory<Ctx> = {
  name: string;
  instructions?: string;
  build: (ctx: Ctx) => Record<string, ClassifiedTool>;
};

/**
 * The project's only `CodemodeConnector`.
 *
 * Everything security-relevant already lives inside the tool's `run` — the Zod
 * parse, `withCapabilityAudit`, `assertEffectPermitted`, the effect ledger, the
 * per-execution budget, the redaction — because `auditedCapability` wired it
 * there. This class deliberately re-implements none of it. Its whole job is to
 * present those tools to the codemode runtime in the shape the runtime needs,
 * and it must not become a second place where policy lives.
 *
 * `requiresApproval` is never set, on any tool. Approval is a model decision
 * routed through the `approval` namespace with host-owned state, because the
 * runtime's approve path takes only an `executionId` and therefore cannot carry
 * the text a human edited in the dashboard. Setting it would also collide with
 * `replay: "reexecute"`, which `describe()` rejects. See spec decision R5/D4.
 */
export class FirefighterConnector<Ctx = unknown> extends CodemodeConnector<Env> {
  readonly #factory: CapabilityNamespaceFactory<Ctx>;
  readonly #getContext: () => Promise<Ctx>;

  constructor(
    ctx: DurableObjectState | ExecutionContext,
    env: Env,
    factory: CapabilityNamespaceFactory<Ctx>,
    /**
     * Called once per `execute` to obtain the CURRENT execution's context.
     * Never memoised here — that is the whole point.
     */
    getContext: () => Promise<Ctx>,
  ) {
    super(ctx, env);
    this.#factory = factory;
    this.#getContext = getContext;
  }

  name(): string {
    return this.#factory.name;
  }

  protected override instructions(): string | undefined {
    return this.#factory.instructions;
  }

  protected override async tools(): Promise<ConnectorTools> {
    // Rendered once and cached by the base class. Schemas and descriptions are
    // properties of the namespace, not of the run, so any context renders them.
    const rendered = this.#factory.build(await this.#getContext());

    const out: ConnectorTools = {};
    for (const [method] of Object.entries(rendered)) {
      const tool = rendered[method] as (typeof rendered)[string];
      out[method] = {
        description: tool.description,
        // JSON Schema, NEVER the Zod instance. `toolInputSchema` in the
        // connector base accepts anything with a `type`, `properties` or `$ref`
        // key — and a Zod v4 schema has `.type === "object"`, so a raw Zod
        // schema PASSES that check and is used verbatim as JSON Schema. It has
        // no `.properties`, so the model-facing type degrades to `unknown` and
        // the description is dropped, with no error anywhere.
        inputSchema: toJsonSchema(tool.input),
        outputSchema: tool.output ? toJsonSchema(tool.output) : undefined,
        // Raw, unvalidated args by design: the tool's own Zod parse inside
        // `defineCapability` is the runtime boundary, and it is the one that
        // produces the `invalid_input` the model knows how to read.
        execute: async (args: unknown): Promise<unknown> => {
          // A FRESH context per call, so two executions never share a budget,
          // an audit stream or a set of customer references.
          const live = this.#factory.build(await this.#getContext())[method];
          if (!live?.run) {
            // Unreachable through `auditedCapability`, which always attaches
            // one. Loud rather than silent: a tool with no `run` would
            // otherwise be a declared capability that returns `undefined` and
            // looks like a successful no-op.
            throw new CapabilityError(
              "invalid_context",
              `${this.#factory.name}.${method} has no execute implementation.`,
            );
          }
          return live.run(args);
        },
      };
    }
    return out;
  }
}
