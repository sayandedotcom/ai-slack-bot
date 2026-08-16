/**
 * The run session on the Project Think chassis.
 *
 * `Think` extends the Agents SDK `Agent`, which is a SQLite Durable Object, so
 * this class owns the agentic loop, tree-structured session storage, durable
 * turns, stream resumption and hibernation. D1 `runs` stays a projection. See
 * spec decision D2.
 *
 * ONE model-facing tool, `run_code`. Everything the model can reach — eleven
 * capability namespaces, their credentials, the loader, the executor — lives
 * behind it as typed RPC inside a Worker Loader isolate. That is what makes
 * "the model cannot reach a credential" structural rather than a policy.
 */

import { callable } from "agents";
import { Think } from "@cloudflare/think";
import type {
  PrepareStepContext,
  Session,
  StepConfig,
  StepContext,
  ThinkModel,
} from "@cloudflare/think";
import { createExecuteRuntime } from "@cloudflare/think/tools/execute";
import type { CodemodeConnector } from "@cloudflare/codemode";
import type { PrepareStepResult, Tool, ToolSet } from "ai";
import type { Env } from "../index";
import { makeCapabilityDependencies } from "../agent/dependencies";
import { newCodeExecution } from "../codemode/bindings/shared";
import { buildConnectors } from "../codemode/connectors";
import {
  alwaysFresh,
  PRODUCTION_LIMITS,
  validateScope,
  type CapabilityAuditSink,
  type CodeModeScope,
} from "../codemode/contracts";
import { renderCapabilityDeclarations } from "../codemode/dts";
import { makeGuardedExecutor } from "../codemode/executor";
import { guardLoader } from "../codemode/guarded-loader";
import { buildNamespaces } from "../codemode/registry";
import { RULES } from "../codemode/rules";
import type { ApprovalPort } from "../approval/contracts";
import {
  ensureApprovalSchema,
  escalate,
  pendingApprovals,
  resolveApproval,
  type Approval,
  type EscalateInput,
  type ResolveInput,
  type ResolveResult,
} from "./agent-approvals";
import { firefighterSystemBlocks, withFirefighterContext } from "./agent-prompt";
import {
  projectTurn,
  recordUsage,
  type ProjectionInput,
  type UsageInput,
} from "./agent-projection";
import { drainSteers, ensureSteerSchema, queueSteer } from "./agent-steering";
import { assertRunKey, runOriginOf } from "./keys";

/**
 * What `run_code` hands back. Structurally the codemode runtime's
 * `ProxyToolOutput`, restated locally so this module does not depend on a
 * package type that is not part of its public surface.
 */
export type RunCodeOutput =
  | { status: "completed"; executionId: string; result: unknown; logs?: string[] }
  | { status: "paused"; executionId: string; pending: unknown[] }
  | { status: "error"; executionId: string; error: string; logs?: string[] };

/** Accepts and drops every event. Mirrors `tool.ts`'s sink of the same name. */
function discardingSink(): CapabilityAuditSink {
  return {
    async started() {},
    async completed() {},
    async failed() {},
  };
}

export class RunAgent extends Think<Env> {
  /**
   * Invariant 5 and invariant 38: `run_code` is the only tool the model sees,
   * and every capability behind it goes through the write guard. Left at their
   * defaults, Think merges a workspace `bash` tool, HTTP fetch tools and every
   * connected MCP server's tools into the same tool map — none of which the
   * guard, the effect ledger or the audit chokepoint would ever see. See spec
   * decisions D8 and D3.
   *
   * `includeMcpTools` is the only one of the three that has to be a field
   * rather than a `beforeTurn` override: tool conversion happens BEFORE
   * `beforeTurn`, so `activeTools: []` there does not suppress the merge
   * (verified fact 12).
   */
  workspaceBash = false;
  fetchTools = false as const;
  includeMcpTools = false;

  /**
   * The built tool, cached for the lifetime of the instance.
   *
   * `getTools()` runs at the top of every turn, and `createExecuteRuntime`
   * builds a fresh codemode runtime handle and a fresh connector set each time
   * it is called. Rebuilding per turn would give every turn its own call
   * budget and its own audit stream while `agent.codemode` silently changed
   * identity underneath any callable holding the old one.
   */
  #runCode: Tool | undefined;

  /** The connector set behind the cached tool — the sandbox's whole surface. */
  #connectorSet: CodemodeConnector[] | undefined;

  /**
   * The id of the currently open, unsettled approval.
   *
   * Held here rather than read from storage because `ApprovalPort
   * .openApprovalId()` is synchronous by contract: the finalize latch that
   * decides whether a run parks must not wait on a database to answer it.
   */
  #openApprovalId: string | null = null;

  override async onStart(props?: Record<string, unknown>): Promise<void> {
    await super.onStart(props);
    // Idempotent by contract — this runs on every wake, not just the first.
    ensureApprovalSchema(this);
    ensureSteerSchema(this);
  }

  getModel(): ThinkModel {
    // Task 8 replaces this with Fable 5 through AI Gateway. Throwing rather
    // than defaulting to a Workers AI model is deliberate: a silent fallback
    // provider would answer a customer in the wrong voice, from the wrong
    // model, with no error anywhere.
    throw new Error("model_not_configured");
  }

  getTools(): { run_code: Tool } {
    return { run_code: this.#executeTool() };
  }

  override configureSession(session: Session): Session | Promise<Session> {
    return withFirefighterContext(session, this);
  }

  override async beforeStep(ctx: PrepareStepContext): Promise<StepConfig> {
    // Steers are spliced per STEP, not per turn: `messageConcurrency` governs
    // overlapping user submits only, and a human correcting a run mid-answer
    // must reach the very next model call (verified fact 13, invariants 12-13).
    const messages = await drainSteers(this, ctx.messages);
    // An ARRAY of system blocks, not a joined string — that is what carries the
    // two Anthropic cache breakpoints through to the provider.
    //
    // Typed against the AI SDK's own `PrepareStepResult` and then widened,
    // because Think's `StepConfig` is `Omit<PrepareStepResult<TOOLS>, "model">`
    // and `PrepareStepResult` is a union ENDING IN `undefined` — `keyof` a
    // union is its COMMON keys, so the Omit collapses to `{}` and every real
    // field reads as an excess property. Think forwards the object verbatim to
    // `streamText({ prepareStep })`, so the SDK type is the accurate one; the
    // widening is to Think's declaration, not away from a check.
    const config: NonNullable<PrepareStepResult<ToolSet>> = {
      instructions: firefighterSystemBlocks(this),
      messages,
    };
    return config as StepConfig;
  }

  override async onStepFinish(ctx: StepContext): Promise<void> {
    // Usage first, then the projection: the billed row is the only local record
    // that money was spent, and a D1 projection failure must never cost it.
    await recordUsage(this, {
      stepId: ctx.response.id,
      model: ctx.response.modelId,
      usage: ctx.usage,
    });
    await projectTurn(this, {
      seq: ctx.response.timestamp.getTime(),
      status: "live",
    });
  }

  /* ------------------------------------------------------------ steering -- */

  /**
   * Text a human typed at a run that is already mid-turn.
   *
   * `@callable` so the dashboard reaches it over the Agents SDK's own RPC
   * rather than a bespoke WebSocket frame.
   */
  @callable({ description: "Steer this run with a human instruction." })
  async steer(text: string): Promise<{ queued: number }> {
    return queueSteer(this, text);
  }

  /* ----------------------------------------------------------- approvals -- */

  async escalate(input: EscalateInput): Promise<{ approvalId: string }> {
    const opened = await escalate(this, input);
    this.#openApprovalId = opened.approvalId;
    return opened;
  }

  async resolveApproval(input: ResolveInput): Promise<ResolveResult> {
    const outcome = await resolveApproval(this, input);
    if (outcome.status !== "not_found" && this.#openApprovalId === input.approvalId) {
      this.#openApprovalId = null;
    }
    return outcome;
  }

  async pendingApprovalsForRun(opts?: { includeResolved?: boolean }): Promise<Approval[]> {
    return pendingApprovals(this, opts);
  }

  /**
   * The port the capability layer escalates through.
   *
   * Built here rather than in `agent-approvals.ts` because the synchronous
   * `openApprovalId()` reads this instance's field, and because a capability
   * must never be handed the agent itself.
   */
  #approvalPort(): ApprovalPort {
    return {
      open: async (input) => this.escalate(input),
      openApprovalId: () => this.#openApprovalId,
      // TODO(Task 9): a real retraction. Reporting `withdrawn: true` without
      // one would claim a card was pulled that a human can still see, so this
      // reports the opposite — the decision path is authoritative and the
      // capability learns nothing was retracted.
      withdraw: async () => ({ withdrawn: false, decision: "rejected" as const }),
    };
  }

  /* ---------------------------------------------------------- code mode -- */

  #executeTool(): Tool {
    if (this.#runCode) return this.#runCode;

    const limits = PRODUCTION_LIMITS;
    // The guarded loader forces the project compat date, `globalOutbound:
    // null`, an empty env, no tails and clamped cpu/subrequests; the guarded
    // executor adds the parent-side wall-clock race. `createExecuteRuntime`'s
    // own `timeout` and `globalOutbound` options are IGNORED once `executor` is
    // supplied (verified fact 3), which is exactly why both must live in ours.
    // See spec decision D5.
    const executor = makeGuardedExecutor(
      guardLoader(this.env.LOADER, limits),
      limits,
      () => Date.now(),
    );

    const connectors = this.#connectors();
    const { tool } = createExecuteRuntime(this, {
      connectors,
      // `executor` MUST be in the OVERRIDES argument, not merged into a single
      // options object with the agent: `isAgent(source)` is `"env" in source &&
      // !("executor" in source) && !("loader" in source)`, so an options-object
      // call takes the non-agent path and never assigns `agent.codemode`
      // (verified fact 4a).
      executor,
      // NOT optional, and not implied by `workspaceBash = false`.
      // `createExecuteRuntime` merges `{...optionsFromAgent(agent),
      // ...overrides}`, and `optionsFromAgent` sets `state:
      // createWorkspaceStateBackend(agent.workspace)` — `Think.workspace` is a
      // non-optional property that DEFAULTS to a real DO-SQLite Workspace — and
      // `browser: env.BROWSER`. Omitting these two ships a `state.*` filesystem
      // (and, the day BROWSER is bound, a `cdp.*` live browser) to the model
      // behind the write guard's back, with no error anywhere. Verified fact
      // 3a; invariants 5 and 38; spec decision D8.
      state: undefined,
      browser: undefined,
      description: this.#description(),
      name: "run_code",
    });

    this.#connectorSet = connectors;
    this.#runCode = tool;
    return tool;
  }

  /**
   * The trust envelope for this run, derived from the Durable Object's name.
   *
   * `this.name` is the run key minted by `src/run/keys.ts` — the only place a
   * run key is built — and it is re-validated here rather than trusted, so a
   * corrupted name refuses before any capability exists.
   */
  #scope(): CodeModeScope {
    const key = assertRunKey(this.name);
    const origin = runOriginOf(key);
    const rest = key.slice(origin.length + 1);

    const slackThread =
      origin === "slack"
        ? { channelId: rest.slice(0, rest.indexOf(":")), threadTs: rest.slice(rest.indexOf(":") + 1) }
        : null;

    return validateScope({
      // A chat run's key IS its public `runs.id`. A Slack run's is not — its
      // public id is a separate UUID resolved through D1 — so this carries the
      // key and the D1 lookups downstream find no row and REFUSE. That is the
      // fail-closed direction, and Task 12's `wakeRun()` façade is where the
      // real id is resolved and pinned.
      // TODO(Task 12): resolve the Slack run's public UUID through D1.
      runId: rest,
      // TODO(Task 8): the turn's real id, from the Think session's turn record.
      turnId: crypto.randomUUID(),
      origin,
      // A SNAPSHOT, and deliberately the pessimistic one. Nothing authorizes a
      // write from this field — `write-guard.ts` re-reads the D1 `runs` row
      // immediately before every external write, precisely so an operator
      // flipping a run to shadow mid-run stops the NEXT write. Seeding it
      // `true` means a reader that ignored that rule still fails closed.
      // TODO(Task 12): carry the composed-at value from the D1 `runs` row.
      shadow: true,
      // TODO(Task 12): the channel policy's customer, never turn metadata.
      customerSlug: null,
      // TODO(Task 8): the on-duty engineer, via `makeUserTokenSource(env)`.
      actor: null,
      slackThread,
    });
  }

  /**
   * The eleven capability namespaces, as connectors, for this run.
   *
   * ONE set per tool construction rather than one per execution — the codemode
   * runtime binds its connectors when the tool is built, not when code runs —
   * so the call budget and the audit stream are per RUN here where the legacy
   * chassis scoped them per `run_code` call.
   * TODO(Task 11): per-execution audit, so a capability event names the
   * `run_code` call it happened under.
   */
  #connectors(): CodemodeConnector[] {
    const scope = this.#scope();
    const clock = () => Date.now();
    return buildConnectors(
      this.ctx,
      scope,
      makeCapabilityDependencies(this.env, scope, clock, this.#approvalPort()),
      PRODUCTION_LIMITS,
      newCodeExecution({
        outerToolCallId: "run_code",
        audit: discardingSink(),
        guard: alwaysFresh(),
        limits: PRODUCTION_LIMITS,
        clock,
      }),
      this.env,
    );
  }

  /**
   * The tool description: the rules, then the generated declarations.
   *
   * Invariant 24 — this is the declarations' ONLY home. They are not in the
   * system prompt, and `firefighterSystemBlocks` must never add them.
   */
  #description(): string {
    // `{{maxCodeChars}}` is substituted FIRST, so nothing in the generated
    // declarations can be read as a placeholder. The cap is RENDERED from the
    // same `limits.maxCodeChars` the schema enforces, never typed into prose.
    return RULES.replace("{{maxCodeChars}}", String(PRODUCTION_LIMITS.maxCodeChars)).replace(
      "{{types}}",
      renderCapabilityDeclarations(this.#declarationOnlyRegistry()),
    );
  }

  /**
   * Schema-only. Its capability closures are never invoked: nothing but
   * `renderCapabilityDeclarations` touches this registry, and it is
   * deliberately NOT the set handed to the runtime. Rendering needs the input
   * and output schemas, which do not vary by execution — but the closures
   * around them hold execution state, so reusing the live connectors' registry
   * would merge two executions' budgets. Mirrors `src/codemode/tool.ts`.
   *
   * Its execution's audit sink DROPS everything, so a refactor that
   * accidentally executed through it would record nothing and fail loudly in
   * the audit assertions rather than quietly succeed.
   */
  #declarationOnlyRegistry() {
    const scope = this.#scope();
    const clock = () => Date.now();
    return buildNamespaces(
      scope,
      makeCapabilityDependencies(this.env, scope, clock, this.#approvalPort()),
      PRODUCTION_LIMITS,
      newCodeExecution({
        outerToolCallId: "declarations-only",
        audit: discardingSink(),
        guard: alwaysFresh(),
        limits: PRODUCTION_LIMITS,
        clock,
      }),
    );
  }

  /* -------------------------------------------------------- test surface -- */

  /** The model's whole tool map, by name. Invariant 5 in one assertion. */
  async toolNames(): Promise<string[]> {
    return Object.keys(this.getTools());
  }

  /**
   * Every namespace the sandbox exposes.
   *
   * Read off the connector set the runtime was actually built from, not off a
   * list this class hopes it passed — `state` and `cdp` are added by
   * `createExecuteRuntime` itself, so only the built set can prove they are
   * absent (verified fact 3a).
   */
  async connectorNames(): Promise<string[]> {
    this.#executeTool();
    return (this.#connectorSet ?? []).map((connector) => connector.name());
  }

  /**
   * Run model-authored code end to end.
   *
   * Goes through the tool's own `execute`, and therefore through the codemode
   * runtime facet: `facets.get` is LAZY, so a keys-only check passes against a
   * broken facet class and only a real execution proves the chassis works
   * (verified fact 4b).
   */
  async executeForTest(code: string): Promise<RunCodeOutput> {
    const tool = this.#executeTool();
    const execute = tool.execute;
    if (execute === undefined) throw new Error("run_code_has_no_execute");
    const output = await execute(
      { code },
      { toolCallId: `test_${crypto.randomUUID()}`, messages: [], context: undefined },
    );
    return output as RunCodeOutput;
  }

  /** Task 11's projection, reachable without a live turn. */
  async projectForTest(input: ProjectionInput): Promise<void> {
    return projectTurn(this, input);
  }

  /** Task 11's usage row, reachable without a live turn. */
  async recordUsageForTest(input: UsageInput): Promise<void> {
    return recordUsage(this, input);
  }
}
