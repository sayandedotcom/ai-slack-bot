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
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { Think } from "@cloudflare/think";
import { createExecuteRuntime } from "@cloudflare/think/tools/execute";
import type { LanguageModel, Tool, ToolSet } from "ai";

import type { Env } from "../index";
import { BootProbeConnector } from "./boot-probe";

/** The one outer tool. Named in the prompt, the tests and the README. */
export const RUN_CODE_TOOL = "run_code";

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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // blockConcurrencyWhile rather than onStart: an approval resolution arrives
    // as a direct RPC, and onStart does not gate that entry path.
    ctx.blockConcurrencyWhile(async () => {
      const { buildModel } = await import("./model");
      this.#model = buildModel(env);

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
        executor: new DynamicWorkerExecutor({ loader: env.LOADER }),
        // TEMPORARY: Task 8 replaces this with the real capability
        // connectors. createExecuteTool throws on an empty connector list, and
        // the facet check below is worth having now — see ./boot-probe.ts.
        connectors: [new BootProbeConnector(ctx, env)],
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

  /** Pins the identity opt-out above against an SDK default change. */
  async sendsIdentityOnConnect(): Promise<boolean> {
    return (this.constructor as typeof RunAgent).options.sendIdentityOnConnect;
  }
}
