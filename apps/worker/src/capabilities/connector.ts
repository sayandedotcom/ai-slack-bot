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
  readonly #getContext: (executionId: string) => Promise<Ctx>;
  /**
   * One context per EXECUTION, not per call and not per connector instance.
   *
   * codemode passes `{ executionId }` as the second argument of `execute`
   * (`dist/index.js:1586`). Every capability call inside one `run_code`
   * execution must see the same context — the same call budget (charged
   * before the host call, so the 41st never reaches Slack), the same audit
   * stream, and the same customer-reference map (a reference minted by
   * `memory.findCustomers` must resolve in the `slack.searchMessages` that
   * follows it). Before this map existed the context was rebuilt per call,
   * and neither property held. Found by the 2026-08-24 docs audit.
   */
  readonly #contexts = new Map<string, Promise<Ctx>>();

  constructor(
    ctx: DurableObjectState | ExecutionContext,
    env: Env,
    factory: CapabilityNamespaceFactory<Ctx>,
    /** Builds the context for ONE execution. Called at most once per execution. */
    getContext: (executionId: string) => Promise<Ctx>,
  ) {
    super(ctx, env);
    this.#factory = factory;
    this.#getContext = getContext;
  }

  #contextFor(executionId: string): Promise<Ctx> {
    let pending = this.#contexts.get(executionId);
    if (pending === undefined) {
      pending = this.#getContext(executionId);
      this.#contexts.set(executionId, pending);
    }
    return pending;
  }

  /**
   * Terminal teardown, keyed by execution.
   *
   * `disposeExecution` and NOT `onPassEnd`: a pass ends when a run pauses for
   * approval too, and a per-execution budget must survive that pause — a
   * resumed run getting a fresh 40 calls would defeat the ceiling. This project
   * never sets `requiresApproval`, so today the two coincide; the distinction
   * is kept because the base class draws it and a future pause would find it.
   *
   * Idempotent by construction (`Map.delete`), which the base class requires:
   * it may fire twice for one execution (a completed run later rolled back).
   */
  override async disposeExecution(executionId: string): Promise<void> {
    this.#contexts.delete(executionId);
  }

  name(): string {
    return this.#factory.name;
  }

  protected override instructions(): string | undefined {
    return this.#factory.instructions;
  }

  protected override async tools(): Promise<ConnectorTools> {
    // Rendered once and cached by the base class. Schemas and descriptions are
    // properties of the namespace, not of the run, so a throwaway context
    // renders them. Nothing is ever CALLED on it.
    const rendered = this.#factory.build(await this.#getContext("render"));

    const out: ConnectorTools = {};
    for (const [method] of Object.entries(rendered)) {
      const tool = rendered[method] as (typeof rendered)[string];
      out[method] = {
        description: tool.description,
        // EVERY READ IS EPHEMERAL, and the rule is the effect classification
        // rather than a per-method judgement.
        //
        // `cm_log` stores a call's args AND its result verbatim, durably, for
        // the runtime's replay to return on a resume pass. A read's result is
        // the one thing in this system that is unbounded and entirely made of
        // other people's data — a whole Slack thread, a page of production
        // logs, a set of Supabase rows — so logging it would put customer bytes
        // in a store nothing else in this codebase redacts or bounds
        // (invariant 39), and would do it for every read the model ever makes.
        //
        // `reexecute` re-runs the call on a resume instead of replaying a
        // stored result, which is exactly right for a `read`: the
        // classification already means idempotent, and after an approval pause
        // fresh data is the better answer anyway. Writes stay logged, because
        // re-executing one would do it twice.
        ...(tool.effect === "read" ? { replay: "reexecute" as const } : {}),
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
        execute: async (args: unknown, callCtx?: { executionId?: string }): Promise<unknown> => {
          // The execution's ONE context. A missing id means the call did not
          // come through the runtime; refuse rather than silently give it a
          // private budget.
          const executionId = callCtx?.executionId;
          if (typeof executionId !== "string" || executionId.length === 0) {
            throw new CapabilityError(
              "invalid_context",
              `${this.#factory.name}.${method} was called outside a codemode execution.`,
            );
          }
          const live = this.#factory.build(await this.#contextFor(executionId))[method];
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
