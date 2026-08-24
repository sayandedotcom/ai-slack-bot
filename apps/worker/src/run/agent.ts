/**
 * The run chassis: one Durable Object per run, on `@cloudflare/think`.
 *
 * Think supplies the session store, turn admission (`runTurn`), compaction, the
 * `cf_agent_chat_*` client protocol and the lifecycle hooks. This class supplies
 * the policy: exactly one tool the model may call, a model built through AI
 * Gateway, and — in later tasks — the prompt, the spend ceiling, the freshness
 * guard, the projection and steering.
 *
 * The DO's NAME is the private run key (`slack:{channel}:{thread_ts}` or
 * `chat:{uuid}`), built only by `src/run/keys.ts`. The public `runs.id` is a
 * separate UUID resolved through D1. Nothing here may hand the name to a client.
 */
import { Think } from "@cloudflare/think";
import { createExecuteRuntime } from "@cloudflare/think/tools/execute";
import type { LanguageModel, Tool, ToolSet } from "ai";

import type { ApprovalPort } from "../approval/contracts";
import { renderCapabilityDeclarations } from "../capabilities/dts";
import {
  alwaysFresh,
  newCodeExecution,
  PRODUCTION_LIMITS,
} from "../capabilities/execution";
import { makeGuardedExecutor } from "../capabilities/executor";
import { guardLoader } from "../capabilities/guarded-loader";
import {
  type BindingContext,
  buildConnectors,
  buildNamespaces,
  NAMESPACE_FACTORIES,
} from "../capabilities/registry";
import { CapabilityError } from "../gateways/errors";
import type { Env } from "../index";
import { productionDependencies } from "./dependencies";
import { resolveRunScope } from "./scope";

/** The one outer tool. Named in the prompt, the tests and the README. */
export const RUN_CODE_TOOL = "run_code";

/**
 * Approval's real port lands in Task 20. Refusing with a readable code is the
 * honest placeholder: the namespace is declared so the model's API is stable,
 * and calling it says plainly that it is not available rather than pretending
 * to succeed.
 */
function notYetWiredApprovalPort(): ApprovalPort {
  const refuse = () => {
    throw new CapabilityError(
      "capability_unavailable",
      "approval is not wired on this build yet.",
    );
  };
  return {
    open: async () => refuse(),
    openApprovalId: () => null,
    withdraw: async () => refuse(),
  };
}

/**
 * A context good enough to render schemas and descriptions, and nothing else.
 *
 * Every gateway throws: rendering reads schemas, so if this ever reached a
 * vendor it should fail loudly rather than make a call while composing a
 * prompt. Same discipline as the declaration generator.
 */
function declarationNamespaces() {
  const refuse = (name: string) =>
    new Proxy({} as Record<string, unknown>, {
      get: (_t, method) => () => {
        throw new CapabilityError(
          "invalid_context",
          `rendering declarations must not call ${name}.${String(method)}`,
        );
      },
    });

  return buildNamespaces({
    scope: {
      runId: "render",
      turnId: "render",
      origin: "chat",
      shadow: false,
      customerSlug: null,
      slackThread: null,
      actor: null,
    },
    deps: {
      db: refuse("db") as never,
      slack: refuse("slack") as never,
      memory: refuse("memory") as never,
      linear: refuse("linear") as never,
      supabase: refuse("supabase") as never,
      langsmith: refuse("langsmith") as never,
      betterstack: refuse("betterstack") as never,
      files: refuse("files") as never,
      approval: notYetWiredApprovalPort(),
      sandbox: refuse("sandbox") as never,
      github: refuse("github") as never,
      clock: () => 0,
    },
    limits: PRODUCTION_LIMITS,
    execution: newCodeExecution({
      outerToolCallId: "render",
      audit: { async started() {}, async completed() {}, async failed() {} },
      guard: alwaysFresh(),
      limits: PRODUCTION_LIMITS,
      clock: () => 0,
    }),
  });
}

/** The model-facing API. Invariant 24: this is its ONE home. */
function runCodeDescription(): string {
  return [
    "Write and run TypeScript against the typed capability namespaces below.",
    "The code runs in an isolated Worker with no network access of its own:",
    "every effect it has goes through one of these calls.",
    "",
    renderCapabilityDeclarations(declarationNamespaces()),
  ].join("\n");
}

export class RunAgent extends Think<Env> {
  /**
   * The DO name is the private run key. The browser addresses runs by their
   * public UUID and the Worker resolves the key server-side, so the name must
   * never cross to a client — but `agents` sends it as a `cf_agent_identity`
   * frame on every connect unless this is off (agents/dist/index.js:951-964).
   */
  static options = { sendIdentityOnConnect: false };

  // --- tool suppression ---------------------------------------------------
  //
  // These narrow the merged map but cannot empty it: `createWorkspaceTools` is
  // called unconditionally (think.js:2628) and always returns seven file tools.
  // `beforeTurn`'s `activeTools` below is the actual control over what the
  // model can call.
  override workspaceBash = false;
  override fetchTools = false as const;
  /**
   * Integrations reach the model as Code Mode connectors, never as MCP tools.
   * Left true, Think would call `mcp.getAITools()` and merge the result into
   * every turn, which would put un-effect-classified tools past the write guard.
   */
  override includeMcpTools = false;
  override sendReasoning = false;
  override messageConcurrency = "queue" as const;

  #model: LanguageModel | null = null;
  #runCode: Tool | undefined;
  #cachedRunId: string | undefined;
  #cachedTurnId: string | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // blockConcurrencyWhile rather than onStart: an approval resolution arrives
    // as a direct RPC, and onStart does not gate that entry path.
    ctx.blockConcurrencyWhile(async () => {
      const { buildModel } = await import("./model");
      this.#model = buildModel(env);

      // The BindingContext is per EXECUTION, not per agent — the call budget,
      // the citation cache, the customer references and the audit stream all
      // belong to one `run_code` call. `#executionContext` builds a fresh one
      // each time the tool runs; this construction exists only so the tool and
      // its facet exist before the first turn.
      // `state` and `browser` MUST be passed explicitly, even as undefined.
      // createExecuteTool derives `state` from this.workspace and `browser`
      // from env.BROWSER via optionsFromAgent, merged as
      // `{...optionsFromAgent(agent), ...overrides}` — so omitting them ships
      // a filesystem (and a browser) to the model as `state.*` / `cdp.*`.
      // `workspaceBash = false` does NOT prevent this; it only drops `bash`.
      const { tool } = createExecuteRuntime(this, {
        name: RUN_CODE_TOOL,
        state: undefined,
        browser: undefined,
        executor: makeGuardedExecutor(
          guardLoader(env.LOADER, PRODUCTION_LIMITS),
          PRODUCTION_LIMITS,
          () => Date.now(),
        ),
        // A PROVIDER, not a context: the connectors rebuild each namespace
        // against a fresh BindingContext on every call, so no two executions
        // share a call budget, an audit stream or a customer reference map.
        connectors: buildConnectors(ctx, env, () => this.#bindingContext()),
        // Invariant 24: the generated declarations have ONE home, and it is
        // the tool description. They are guidance, not a boundary — the
        // sandbox runs JavaScript and nothing stops model code calling a
        // method the types forbid. The boundary is the Zod parse.
        // Rendered from the schemas, which do not vary by run.
        description: runCodeDescription(),
      });
      this.#runCode = tool;
    });
  }

  override getModel(): LanguageModel {
    if (this.#model === null) {
      throw new Error("model construction is disabled (AGENT_MODEL_DISABLED)");
    }
    return this.#model;
  }

  override getTools(): ToolSet {
    if (this.#runCode === undefined) {
      throw new Error("run_code tool is not built");
    }
    return { [RUN_CODE_TOOL]: this.#runCode };
  }

  override beforeTurn() {
    // Invariant 5, as it is actually enforceable on this chassis: the provider
    // is handed exactly one tool. Think forwards `activeTools` to streamText
    // (think.js:2729), so the seven workspace tools are never described to the
    // model even though they exist in the merged map.
    return { activeTools: [RUN_CODE_TOOL] };
  }

  // --- test surface -------------------------------------------------------
  //
  // These exist so the tool boundary can be asserted from outside. They are
  // reads; none of them mutates the run.

  /** The capability namespaces reachable inside run_code. Test surface. */
  async connectorNames(): Promise<string[]> {
    return NAMESPACE_FACTORIES.map((factory) => factory.name);
  }

  /** The merged map Think would assemble for a turn. */
  async toolNames(): Promise<string[]> {
    const { createWorkspaceTools } = await import("@cloudflare/think/tools/workspace");
    return Object.keys({
      ...createWorkspaceTools(this.workspace, { bash: this.workspaceBash }),
      ...this.getTools(),
      ...(await this.session.tools()),
    });
  }

  /** What beforeTurn permits the model to call. */
  async activeToolsForTest(): Promise<string[]> {
    return this.beforeTurn().activeTools;
  }

  /**
   * Proves the Code Mode facet is a real Durable Object namespace rather than a
   * LoopbackServiceStub. `facets.get` is lazy, so only a call into it can tell.
   */
  async codemodeReady(): Promise<boolean> {
    await this.codemode?.executions(1);
    return true;
  }

  /**
   * The capability surface for one execution.
   *
   * Approval is not wired yet — Task 20 builds the real port. Until then the
   * namespace is DECLARED (so the model sees a stable API and the .d.ts does
   * not churn) and refuses at call time with a code the model can read, which
   * is the same shape every other unusable-in-this-context capability takes.
   */
  async #bindingContext(outerToolCallId = crypto.randomUUID()): Promise<BindingContext> {
    const scope = await resolveRunScope(this.env, this.#runId(), this.#turnId());
    return {
      scope,
      deps: productionDependencies(this.env, scope, notYetWiredApprovalPort()),
      limits: PRODUCTION_LIMITS,
      execution: newCodeExecution({
        outerToolCallId,
        audit: { async started() {}, async completed() {}, async failed() {} },
        guard: alwaysFresh(),
        limits: PRODUCTION_LIMITS,
        clock: () => Date.now(),
      }),
    };
  }

  /**
   * The public run id. Resolved from D1 by key rather than parsed out of the
   * DO name: the name is the private key and the two are deliberately
   * different values.
   */
  #runId(): string {
    if (this.#cachedRunId === undefined) {
      throw new CapabilityError("invalid_context", "this agent has no resolved run id yet");
    }
    return this.#cachedRunId;
  }

  #turnId(): string {
    return this.#cachedTurnId ?? "boot";
  }

  /** Pins the identity opt-out above against an SDK default change. */
  async sendsIdentityOnConnect(): Promise<boolean> {
    return (this.constructor as typeof RunAgent).options.sendIdentityOnConnect;
  }
}
