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
  TurnConfig,
  TurnContext,
} from "@cloudflare/think";
import { createExecuteRuntime } from "@cloudflare/think/tools/execute";
import type { CodemodeConnector } from "@cloudflare/codemode";
import type { PrepareStepResult, Tool, ToolSet } from "ai";
import type { Env } from "../index";
import { makeCapabilityDependencies } from "../agent/dependencies";
import { getChannelPolicy } from "../db/channels";
import { makeUserTokenSource } from "../identity/user-token";
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
import { CapabilityError } from "../codemode/errors";
import { makeGuardedExecutor } from "../codemode/executor";
import { guardLoader } from "../codemode/guarded-loader";
import { buildNamespaces } from "../codemode/registry";
import { RULES } from "../codemode/rules";
import type { ApprovalPort } from "../approval/contracts";
import { getRunByKey } from "./repository";
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
import {
  firefighterModel,
  firefighterSystemBlocks,
  firefighterTurnConfig,
  primeModelModule,
  withFirefighterContext,
} from "./agent-prompt";
import {
  projectTurn,
  recordUsage,
  type ProjectionInput,
  type UsageInput,
} from "./agent-projection";
import { drainSteers, ensureSteerSchema, queueSteer } from "./agent-steering";
import { assertRunKey, runOriginOf, type RunOrigin } from "./keys";

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

/* ----------------------------------------------------------- run facts -- */

/**
 * The half of the trust envelope that only D1 can answer.
 *
 * Every field has exactly one source and none of them is the conversation,
 * exactly as `src/agent/dependencies.ts` documents for the legacy chassis:
 * the public run id and `shadow` come from the D1 `runs` row, `customerSlug`
 * from the channel policy (invariant 35), the Slack coordinates from the run
 * key, and `actor` from the on-duty rotation.
 */
type RunFacts = {
  /** The public `runs.id` UUID. NEVER the Durable Object name. */
  runId: string;
  origin: RunOrigin;
  shadow: boolean;
  customerSlug: string | null;
  slackThread: { channelId: string; threadTs: string } | null;
  actor: { engineerEmail: string; slackUserId: string | null } | null;
};

/**
 * Resolve this run against the run index, or REFUSE by returning null.
 *
 * Through the run KEY — this object's name, the only string `src/run/keys.ts`
 * ever mints — because a Slack run's public `runs.id` is a separate UUID and
 * string-building one from the key would name a row that does not exist
 * (invariant 10).
 *
 * NULL IS A REFUSAL, NOT A DEFAULT, and every caller treats it as one. A run
 * that cannot be confirmed has no provable customer and no provable shadow
 * flag; guessing either is how one customer's thread reads another customer's
 * data, so the scope is never built and no capability ever exists. This is the
 * same fail-closed direction `resolveCodeModeScope` takes on the legacy
 * chassis, and the same one `resolveTrustedContext` takes for the prompt.
 */
async function resolveRunFacts(env: Env, name: string): Promise<RunFacts | null> {
  const key = assertRunKey(name);
  const origin = runOriginOf(key);
  const rest = key.slice(origin.length + 1);
  const colon = rest.indexOf(":");
  const slackThread =
    origin === "slack"
      ? { channelId: rest.slice(0, colon), threadTs: rest.slice(colon + 1) }
      : null;

  const run = await getRunByKey(env.DB, key);
  if (run === null) return null;
  // Two opinions about what kind of run this is, or about which thread it
  // owns. One of them is wrong and picking between them would choose a
  // customer scope on a coin flip, so neither is used.
  if (run.origin !== origin) return null;
  if (
    slackThread !== null &&
    (run.channelId !== slackThread.channelId || run.threadTs !== slackThread.threadTs)
  ) {
    return null;
  }

  // From the channel policy and from nothing else — never turn metadata, never
  // a tool argument, never model prose. An unmapped channel yields `null`,
  // which makes every customer-scoped capability refuse with
  // `customer_scope_required` rather than silently widening; chat has no
  // channel and therefore no ambient customer at all.
  const policy = run.channelId === null ? null : await getChannelPolicy(env.DB, run.channelId);

  // Asked ONLY of a run that could actually speak — a Slack run with a pinned
  // thread that is not shadowed — for the blast-radius reason spelled out in
  // `dependencies.ts`: one corrupt identity row must not take out chat runs,
  // shadow runs and read-only investigations that were never going to reply.
  // The token is discarded here; the scope carries FACTS about the human, and
  // the credential is re-resolved at the last trusted moment inside the
  // gateway (invariant 39).
  const mayReply = slackThread !== null && !run.shadow;
  const onDuty = mayReply ? await makeUserTokenSource(env).onDutyToken(Date.now()) : null;

  return {
    runId: run.id,
    origin,
    shadow: run.shadow,
    customerSlug: policy?.customer_slug ?? null,
    slackThread,
    actor:
      onDuty === null
        ? null
        : { engineerEmail: onDuty.email, slackUserId: onDuty.slackUserId },
  };
}

function unconfirmedRun(): CapabilityError {
  return new CapabilityError(
    "invalid_context",
    "this run could not be confirmed against the run index, so no work was started.",
  );
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

  /**
   * The trust envelope for this run — ONE object for the life of the instance.
   *
   * `undefined` means the run could not be confirmed against D1, and every
   * reader of it refuses. It is deliberately not seeded with a pessimistic
   * placeholder: a placeholder scope is a scope, and the point of the refusal
   * is that no capability exists at all.
   *
   * ONE OBJECT, RE-STAMPED IN PLACE, and that is load-bearing rather than an
   * optimisation. `makeCapabilityDependencies` and `buildNamespaces` capture
   * this reference when the `run_code` tool is built — once per instance, see
   * `#runCode` — and every consumer that matters (`write-guard.ts`,
   * `effects.ts`, `bindings/shared.ts`, `bindings/slack.ts`) reads
   * `ctx.scope.<field>` at CALL time. Re-stamping the same object is therefore
   * how a later turn's `turnId`, and a re-read policy, reach a tool that was
   * built during an earlier turn. Replacing the object would not: the captured
   * reference would keep serving the first turn's facts forever.
   *
   * `runId` is the one field that may never move — `makeSandboxGateway` reads
   * it EAGERLY at dependency-build time — so `#refreshScope` refuses rather
   * than re-stamping if it ever resolves differently.
   */
  #scopeRef: CodeModeScope | undefined;

  /**
   * Load the model composer before this object can be handed any work.
   *
   * `src/agent/model.ts` is reached through a dynamic import (see the long
   * comment on `primeModelModule` in `agent-prompt.ts`) so that the Slack
   * webhook's cold start — and every other path through this single Worker
   * that never runs a Think turn — does not pay to evaluate it. `getModel()`
   * is synchronous by Think's contract and runs BEFORE `beforeTurn`, so the
   * load has to be finished before any turn starts.
   *
   * `blockConcurrencyWhile` in the constructor is the only place that is true
   * for every entry path at once: RPC, `fetch`, WebSocket and alarm are all
   * held until it settles. `onStart()` would cover the alarm and fetch paths
   * but is not a guarantee for a direct RPC, and a turn re-entered from an
   * approval arrives as exactly that.
   *
   * The run's own D1 facts are resolved in the same block, and for the same
   * reason. `#scope()` has to answer SYNCHRONOUSLY — Think calls `getTools()`
   * synchronously, and it calls it BEFORE `beforeTurn` (`think.js:2637` vs
   * `:2670`), so a fact first read in a turn hook is a turn too late for the
   * tool that turn is assembling. One indexed D1 read per Durable Object wake
   * is the price of the scope being real rather than a placeholder.
   *
   * A failure here does NOT abort the object: a rejected
   * `blockConcurrencyWhile` discards the Durable Object and takes every
   * in-flight caller with it. It leaves `#scopeRef` undefined instead, which
   * is the refusal — loud at the first `getTools()`, and silent for the RPCs
   * (steering, approvals, projection) that never needed a capability.
   */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      await primeModelModule();
      try {
        await this.#refreshScope();
      } catch {
        // Deliberately swallowed, deliberately not logged with the error's own
        // text. `#scopeRef` stays undefined and `#scope()` refuses; see above.
      }
    });
  }

  override async onStart(props?: Record<string, unknown>): Promise<void> {
    await super.onStart(props);
    // Idempotent by contract — this runs on every wake, not just the first.
    ensureApprovalSchema(this);
    ensureSteerSchema(this);
    this.#ensureTurnIdentitySchema();
    // A second chance for a run whose index row was written after this
    // instance was constructed. Same swallow, same refusal if it fails.
    try {
      await this.#refreshScope();
    } catch {
      /* refusal is the stored state; see the constructor */
    }
  }

  getModel(): ThinkModel {
    // A LanguageModel, never a model-id string. A string would be resolved by
    // Think's own resolver (workers-ai-provider / Gateway defaults); the
    // mandatory-Gateway, no-direct-Anthropic rule has to stay enforced in our
    // code. Composed per call rather than cached: Gateway metadata is fixed
    // for the life of one provider object, so a cached model would stamp every
    // turn with one generation id. See spec decision D11 and invariant 27.
    return firefighterModel(this);
  }

  /**
   * Per-turn assembly: the run's dynamic facts are refreshed from D1 here,
   * once per turn rather than once per step, and this is where the channel
   * policy and shadow ratchet are re-read (invariant 37).
   *
   * `maxRetries: 0`, the explicit timeouts and `stopWhen` all come from
   * `src/agent/model.ts`'s `modelCallOptions` — AI Gateway owns transport
   * retries, the SDK owns none (invariant 27).
   */
  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig> {
    // Allocated BEFORE any provider I/O and before any capability can run —
    // invariant 7 asks for exactly that, and this hook is the last point in a
    // turn that is still true. It re-reads the run's D1 facts on the way
    // through (invariant 37), and it REFUSES the turn if they have stopped
    // resolving, which is the same answer the legacy chassis gives when its
    // per-generation scope build cannot confirm the run.
    await this.#refreshScope(await this.#turnIdFor(ctx));
    return firefighterTurnConfig(this);
  }

  /**
   * Re-enter the agentic loop after a human resolved an approval.
   *
   * A scheduled callback rather than a direct call from `resolveApproval`,
   * because that runs inside a DO RPC and the turn queue cannot drain until it
   * returns — calling `runTurn` there deadlocks even unawaited. See the long
   * comment at the `schedule` call in `agent-approvals.ts`.
   *
   * `mode: "submit"` keyed on the approval id: a redelivered resolution or a
   * repair-sweep retry is `accepted: false`, never a second turn carrying the
   * same decision twice.
   */
  async reenterAfterApproval(payload: {
    input: string;
    idempotencyKey: string;
  }): Promise<void> {
    await this.runTurn({
      mode: "submit",
      input: payload.input,
      idempotencyKey: payload.idempotencyKey,
    });
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
      //
      // Not closable from here. A retraction is a CAS out of `pending` on the
      // agent's own `approvals` table, plus the dashboard card and the nudge
      // it already projected — all three of which `agent-approvals.ts` owns
      // and none of which it exports a path to. Reaching around it from this
      // class would give the approval state machine a second writer, which is
      // the one property that makes its decide-exactly-once CAS mean anything.
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
   * The trust envelope for this run, or a REFUSAL.
   *
   * Synchronous because it has to be: `getTools()` is synchronous and runs
   * before `beforeTurn`, so the D1 half of the envelope is resolved on the
   * paths that CAN wait (the constructor, `onStart`, `beforeTurn`) and read
   * back here.
   *
   * Throwing rather than composing a placeholder is the whole point. A scope
   * with a null customer and a key-shaped run id is still a scope: it builds
   * eleven capabilities, and every one of them then has to be trusted to
   * notice. An unconfirmed run gets no capabilities at all.
   */
  #scope(): CodeModeScope {
    const scope = this.#scopeRef;
    if (scope === undefined) throw unconfirmedRun();
    return scope;
  }

  /**
   * Re-read the run's D1 facts and stamp them into the one scope object.
   *
   * `turnId` is passed in rather than resolved here because its rules are
   * about the TURN (invariants 7 and 8) while everything else here is about
   * the RUN. Omitting it keeps whatever the current turn identity is.
   */
  async #refreshScope(turnId?: string): Promise<void> {
    const facts = await resolveRunFacts(this.env, this.name);
    if (facts === null) {
      // Forget any envelope we may already be holding. A row that has stopped
      // resolving is not a row we may keep acting on the memory of.
      this.#scopeRef = undefined;
      throw unconfirmedRun();
    }

    // `validateScope` rather than an object literal, for the reason
    // `resolveCodeModeScope` gives: it is strict at every level, so a field
    // this method forgets, mistypes or widens is a thrown `invalid_context`
    // here rather than a surprise three layers down.
    const next = validateScope({
      runId: facts.runId,
      turnId: turnId ?? this.#currentTurnId(),
      origin: facts.origin,
      // A SNAPSHOT, and never an authorization. `write-guard.ts` re-reads the
      // D1 `runs` row immediately before every external write, precisely so an
      // operator flipping a run to shadow mid-run stops the NEXT write.
      shadow: facts.shadow,
      customerSlug: facts.customerSlug,
      slackThread: facts.slackThread,
      actor: facts.actor,
    });

    const current = this.#scopeRef;
    if (current === undefined) {
      this.#scopeRef = next;
      return;
    }
    // The identity of the run cannot change under a tool that has already
    // captured it — `makeSandboxGateway` copied `runId` out at build time, so
    // a moved id would leave the sandbox pinned to the old run while every
    // other capability moved. Refuse instead.
    if (current.runId !== next.runId) {
      this.#scopeRef = undefined;
      throw unconfirmedRun();
    }
    Object.assign(current, next);
  }

  /* ----------------------------------------------------- turn identity -- */

  /**
   * The at-most-once key's turn half, durable across instances.
   *
   * One row, rewritten at each turn admission. It is in the agent's own SQLite
   * rather than in a field because a field is lost at hibernation, and a
   * continuation that came back with a NEW id would let `codemode_effects`
   * replay an effect the previous instance had already performed.
   */
  #ensureTurnIdentitySchema(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS run_turn_identity (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        turn_id    TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
  }

  /** The turn identity in force, minting and persisting one if there is none. */
  #currentTurnId(): string {
    this.#ensureTurnIdentitySchema();
    const [row] = this.sql<{ turn_id: string }>`
      SELECT turn_id FROM run_turn_identity WHERE id = 1
    `;
    return row?.turn_id ?? this.#persistTurnId(`turn:${crypto.randomUUID()}`);
  }

  #persistTurnId(turnId: string): string {
    this.#ensureTurnIdentitySchema();
    this.sql`
      INSERT INTO run_turn_identity (id, turn_id, updated_at)
      VALUES (1, ${turnId}, ${Date.now()})
      ON CONFLICT(id) DO UPDATE SET
        turn_id    = excluded.turn_id,
        updated_at = excluded.updated_at
    `;
    return turnId;
  }

  /**
   * The turn identity for the turn that is about to start.
   *
   * INVARIANT 7 — one unsettled generation keeps one id. A continuation is the
   * same settled input still being answered, so it reuses the stored id; and
   * because the id is stored rather than held in a field, a continuation that
   * arrives after hibernation reuses it too.
   *
   * INVARIANT 8 — a later settled input gets a new one, so deliberately
   * repeating an action in a later turn is not deduplicated away.
   *
   * The id is the RUNNING SUBMISSION's, when there is exactly one. That is the
   * only durable per-input identity Think exposes: `cf_think_submissions`
   * keeps `request_id` on the row, so a submission that is re-executed after a
   * crash comes back with the same id and the effect ledger recognises the
   * retry rather than performing the write twice. `TurnContext` carries no id
   * of its own (`think.js` mints the request id per call and never surfaces
   * it), so a turn with no submission behind it — a `mode: "wait"` turn, a
   * dashboard socket turn — falls back to a fresh uuid. That uuid is stored
   * like any other, so continuations and hibernation are covered; what it
   * cannot survive is that turn being RE-EXECUTED from the top, which arrives
   * as a non-continuation and mints a new id, so an effect it had already
   * performed would not be recognised as a replay. RESIDUAL, recorded rather
   * than papered over: every production wake goes through `wakeRun()`'s
   * `mode: "submit"`, which is the submission path.
   *
   * More than one running submission is not a shape Think produces (the drain
   * takes one row at a time), and if it ever happened, guessing which one this
   * turn belongs to could hand two different inputs the SAME key and drop a
   * real effect as a duplicate. A fresh id risks a visible repeat instead of a
   * silent loss, so that is the one it takes.
   */
  async #turnIdFor(ctx: TurnContext): Promise<string> {
    if (ctx.continuation) return this.#currentTurnId();
    const running = await this.listSubmissions({ status: "running", limit: 2 });
    const submission = running.length === 1 ? running[0] : undefined;
    const id =
      submission === undefined
        ? `turn:${crypto.randomUUID()}`
        : `turn:${submission.requestId ?? submission.submissionId}`;
    return this.#persistTurnId(id);
  }

  /**
   * The eleven capability namespaces, as connectors, for this run.
   *
   * ONE set per tool construction rather than one per execution — the codemode
   * runtime binds its connectors when the tool is built, not when code runs —
   * so the call budget and the audit stream are per RUN here where the legacy
   * chassis scoped them per `run_code` call.
   *
   * THE AUDIT SINK STILL DISCARDS, and that is a missing destination rather
   * than a missing wire. `auditSinkFactory` (src/agent/audit.ts) is real and
   * ready, but it writes `ToolCallUpdateInput`s through a `ToolUpdateWriter`,
   * and the only implementation of that is `appendAgentToolCallUpdate` in
   * `src/run/session.ts` — RunDO's claim-fenced `tool_updates` stream, which
   * this chassis does not have and must not reach into (Think owns the
   * transcript here). Nested `cap:*` events therefore have nowhere to land
   * until Task 11 gives the Think chassis its own replayable tool-update
   * stream; inventing a private table for them here would put the audit trail
   * somewhere no reader knows to look.
   * TODO(Task 11): a Think-side tool-update stream, then a per-execution sink
   * built on it so a capability event names the `run_code` call it happened
   * under.
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

  /**
   * The model's whole tool map, by name. Invariant 5 in one assertion.
   *
   * `getTools()` alone is NOT that map, and the difference is a real hole
   * rather than a technicality. Think assembles the turn's tools as
   * `{...workspaceTools, ...fetchToolSet, ...getTools(), ...actionTools,
   * ...extensionTools, ...session.tools(), ...skillTools, ...mcpTools,
   * ...clientTools}` (`think.js:2636-2652`) — six of those sources land AFTER
   * `getTools()`. The one that can fill itself in without anyone asking is
   * `session.tools()`: a context block declared with no provider is auto-wired
   * to a WRITABLE provider, which contributes a `set_context` tool. That tool
   * would reach the model having never passed the write guard, the effect
   * ledger, or the audit chokepoint — invariants 5 and 38 — and a check that
   * reads `getTools()` would report everything fine.
   *
   * So this reads the sources that our configuration can still populate.
   * `workspaceBash`/`fetchTools`/`includeMcpTools` are off as fields, and we
   * register no extensions, skills or client tools.
   */
  async toolNames(): Promise<string[]> {
    return [
      ...Object.keys(this.getTools()),
      ...Object.keys(await this.session.tools()),
      ...Object.keys(this.getActions?.() ?? {}),
    ].sort();
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

  /**
   * The system blocks one step would carry, reachable without a live turn.
   *
   * Both hooks, in the order a turn runs them: `firefighterTurnConfig` is what
   * `beforeTurn` refreshes the run's facts through, and `firefighterSystemBlocks`
   * is what `beforeStep` renders from them. A test that called only the second
   * would render the UNRESOLVED block every time and prove nothing.
   */
  async promptBlocksForTest(): Promise<string[]> {
    await firefighterTurnConfig(this);
    return firefighterSystemBlocks(this).map((block) => String(block.content));
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
