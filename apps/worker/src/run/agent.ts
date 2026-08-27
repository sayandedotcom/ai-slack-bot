/**
 * The run chassis: one Durable Object per run, on `@cloudflare/think`.
 *
 * Think supplies the session store, turn admission (`runTurn`), compaction, the
 * `cf_agent_chat_*` client protocol and the lifecycle hooks. This class supplies
 * the policy: exactly one tool the model may call, a model built through AI
 * Gateway, the prompt, the spend ceiling, the freshness guard, the projection
 * and steering.
 *
 * The DO's NAME is the private run key (`slack:{channel}:{thread_ts}` or
 * `chat:{uuid}`), built only by `src/run/keys.ts`. The public `runs.id` is a
 * separate UUID resolved through D1. Nothing here may hand the name to a client.
 */
import {
  defaultContextOverflowClassifier,
  Think,
  type ChatErrorContext,
  type ChatRecoveryConfig,
  type ChatResponseResult,
  type PrepareStepContext,
  type Session,
  type StepConfig,
  type StepContext,
  type ToolCallContext,
  type ToolCallDecision,
  type TurnConfig,
  type TurnContext,
} from "@cloudflare/think";
import { createExecuteRuntime } from "@cloudflare/think/tools/execute";
import { callable, type Connection, type ConnectionContext } from "agents";
import type { ContextProvider } from "agents/experimental/memory/session";
import type {
  LanguageModel,
  ModelMessage,
  PrepareStepResult,
  Tool,
  ToolSet,
} from "ai";

import type { ApprovalPort } from "../approval/contracts";
import { makeApprovalPort } from "../approval/port";
import { getApproval } from "../approval/repository";
import {
  type AgentExecutionGuard,
  newCodeExecution,
  PRODUCTION_LIMITS,
  staleGeneration,
} from "../capabilities/execution";
import { makeGuardedExecutor } from "../capabilities/executor";
import { guardLoader } from "../capabilities/guarded-loader";
import {
  type BindingContext,
  buildConnectors,
  NAMESPACE_FACTORIES,
} from "../capabilities/registry";
import { CapabilityError } from "../gateways/errors";
import type { RunScope } from "../gateways/scope";
import type { Env } from "../index";
import { redact } from "../redact";
import {
  askedFrom,
  enqueueTurnEpisode,
  episodeOutcomeFor,
  makeTurnAuditSink,
  makeTurnProvenanceSink,
  messageText,
  newTurnRecord,
  type TurnRecord,
} from "./agent-memory";
import { sendNudge } from "../notify/nudge";
import {
  makeSandboxLifecycle,
  sandboxContainersAvailable,
} from "../sandbox/lifecycle";
import {
  channelForOrigin,
  MAX_STEPS_PER_TURN,
  RUN_CHANNELS,
  type RunChannelId,
} from "./agent-channels";
import { runOriginOf } from "./keys";
import { identityFromRequest, isBlockedClientFrame } from "./transport";
import {
  ANTHROPIC_PROVIDER_OPTIONS,
  composeInstructions,
  configureRunSession,
  type PendingApprovalFacts,
  type RecalledFact,
  type ThreadMessage,
  turnInstructions,
} from "./agent-prompt";
import { projectStatus, recordUsage } from "./agent-projection";
import {
  costBreakdown,
  FABLE_5_MODEL_ID,
  MIN_USEFUL_OUTPUT_TOKENS,
  normalizeUsage,
  spendCeilingFrom,
  spendDecision,
  spendStopWhen,
  spentNanoUsd,
  worstCaseStepNanoUsd,
} from "./agent-spend";
import {
  consumeSteers,
  pendingSteers,
  queueSteer,
  type SqlTag,
  type SteerRow,
  steerMessageText,
  steerText,
} from "./agent-steering";
import {
  renderEngineerVoice,
  resolveEngineerVoice,
  voiceWindowIndex,
} from "./agent-voice";
import { productionDependencies } from "./dependencies";
import { isRunStatus, isTerminalRunStatus, type RunStatus } from "./protocol";
import { getRunById, getRunByKey, readRunUsage } from "./repository";
import { resolveRunScope } from "./scope";

/** The one outer tool. Named in the prompt, the tests and the README. */
export const RUN_CODE_TOOL = "run_code";

/**
 * What `beforeTurn` permits the model to call.
 *
 * Invariant 5, as it is actually enforceable on this chassis. The MERGED tool
 * map can never be one entry — `think.js:2628` calls `createWorkspaceTools`
 * unconditionally and it always returns seven file tools — so the control is
 * `activeTools`, which Think forwards to `streamText` (`think.js:2729`).
 */
export const ACTIVE_TOOLS = [RUN_CODE_TOOL];

/**
 * How much of a failure reason reaches every dashboard tab.
 *
 * Bounded as well as scrubbed: a provider error body can be kilobytes of
 * echoed request, and `redact` removes credential SHAPES, not volume.
 */
export const CHAT_ERROR_MAX_CHARS = 300;

/**
 * The telemetry settings for one turn, and the cast they need.
 *
 * MEASURED TRAP: `TurnConfig.telemetry` is typed as `streamText`'s
 * `experimental_telemetry`, which on `ai` 7 is `TelemetryOptions` — and that
 * type has NO `metadata`; v7 replaced it with `runtimeContext`. But Think reads
 * `settings.metadata` at runtime (`think.js:2569`), spreads it into the
 * runtime context it builds, and only then deletes the key from the options it
 * forwards. So `metadata` is the shape Think honours and the type does not
 * describe, and a cast is the honest way to say that rather than a silently
 * dropped field.
 *
 * `agentId` is the reason any of this is stamped. Think's default is
 * `this.name` — the PRIVATE run key — which would put
 * `slack:{channel}:{thread_ts}` into a third-party trace store for every
 * customer conversation, breaking invariant 10 somewhere nobody greps. Caller
 * metadata is merged last, so naming the public id here replaces it.
 */
export function turnTelemetry(ids: {
  runId: string;
  turnId: string;
}): TurnConfig["telemetry"] {
  return {
    functionId: "run-agent",
    metadata: { agentId: ids.runId, runId: ids.runId, turnId: ids.turnId },
  } as TurnConfig["telemetry"];
}

/**
 * Invariant 17: readable chain-of-thought must never reach an event, a log, a
 * D1 row, or Zep.
 *
 * `agent-prompt.ts` asks for `thinking: { display: "omitted" }`, so the provider
 * returns SIGNED thinking blocks with an empty text field — enough to replay a
 * tool-use turn, and nothing to read. This is the check that the setting is
 * actually in force: readable text in a reasoning part means the option was
 * dropped somewhere between here and the provider, and every downstream sink
 * that touches this turn would then be storing customer-derived reasoning.
 *
 * Thrown rather than logged, because there is no safe way to continue: the
 * block is already in the transcript by the time this runs, and the turn has to
 * end so nothing else picks it up.
 */
export function assertThinkingOmitted(
  reasoning: ReadonlyArray<unknown> | undefined
): void {
  for (const part of reasoning ?? []) {
    // `unknown` rather than the SDK's ReasoningPart union: a reasoning FILE part
    // has no `text` at all, and narrowing to the union here would have to be
    // updated every time the SDK adds an arm. The question asked is the same for
    // every arm — is there readable text on it.
    const text = (part as { text?: unknown } | null)?.text;
    if (typeof text === "string" && text.trim() !== "") {
      throw new Error(
        "readable thinking reached the transcript: provider options must keep thinking display omitted (invariant 17)"
      );
    }
  }
}

/**
 * How long a run waits for a human before it stops waiting.
 *
 * A REVIEWED DEFAULT, not a vendor constant. An escalation nobody answers must
 * not park a run forever: the thread would stay owned by a session that will
 * never speak again, and every later customer message would be absorbed into
 * silence. Six hours is long enough to cover a meeting or a handover and short
 * enough that a stranded thread is released the same day.
 */
export const APPROVAL_TTL_SECONDS = 6 * 60 * 60;

/**
 * Run-scoped state that must survive hibernation.
 *
 * `this.state` is SQLite-backed and broadcast to every connection on
 * `setState`, which is exactly what the dashboard's live view wants. An
 * in-memory private field is neither: it dies on the next eviction and the
 * constructor re-runs. `this.configure()` — which the Think docs describe —
 * does not exist on 0.15.1. Found by the 2026-08-24 docs audit.
 *
 * Nothing sensitive may live here, because every field reaches every connected
 * browser. The run id is already public (it is in the dashboard URL); the
 * private run key, the customer slug and the actor's email are not, and are
 * deliberately absent.
 *
 * D1 `runs` stays the system of record; this is the live mirror.
 */
/**
 * The approval id off a scheduled payload, or null.
 *
 * Validated rather than trusted: a schedule row round-trips through JSON in DO
 * SQLite and can outlive a deploy, so one written by an older build is a thing
 * to drop rather than to crash on.
 */
function readApprovalId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const raw = (payload as { approvalId?: unknown }).approvalId;
  return typeof raw === "string" && raw !== "" ? raw : null;
}

export type RunAgentState = {
  /** The public runs.id, bound by the wake path from the D1 row keyed by this.name. */
  runId: string | null;
  /** The turn currently being served. Null when idle. */
  turnId: string | null;
  status: RunStatus;
  openApprovalId: string | null;
  /**
   * The last approval this run opened, decided or not, and never cleared.
   *
   * `openApprovalId` alone cannot answer a withdraw that arrives just after a
   * human decided: the resolution clears the flag, and a port with nothing open
   * would report a clean withdrawal for a message that may already have gone to
   * the customer. This is what lets it look the decision up instead.
   */
  lastApprovalId: string | null;
  /** Which surface this run speaks on. Decides the delivery label. */
  channel: RunChannelId;
  /** Bumped by every submit; a turn whose revision is older is stale. */
  inputRevision: number;
};

export class RunAgent extends Think<Env, RunAgentState> {
  override initialState: RunAgentState = {
    runId: null,
    turnId: null,
    status: "idle",
    openApprovalId: null,
    lastApprovalId: null,
    channel: "web",
    inputRevision: 0,
  };

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
  /**
   * No stall watchdog. It measures the gap between UI-stream chunks, which
   * INCLUDES server-side tool execution, and one `run_code` call can legitimately
   * spend twenty seconds in a container. A watchdog here would kill exactly the
   * turns that are working.
   */
  override chatStreamStallTimeoutMs = 0;

  // --- tracing ------------------------------------------------------------
  //
  // Think already emits GenAI OTLP spans through `wrapAISDK`, and Workers
  // export OTLP, so the agent's own traces are the SDK's rather than a
  // hand-written writer's. These two flags are the whole payload policy, and
  // they are not symmetric on purpose.
  //
  // `storeTools` is on: a `run_code` span carries the model-authored program
  // and what the capabilities answered, which is the single most useful thing
  // in a trace when a run goes wrong — and it is OUR code and OUR results, not
  // a customer's words.
  //
  // `storeMessages` is OFF, and it is all-or-nothing (`think.js:2827` passes
  // both straight to `wrapAISDK`). A `chat` span with messages on it would put
  // the customer's Slack thread, the triage briefing and every recalled memory
  // into a third-party trace store, verbatim and undredacted — there is no
  // per-field switch to keep. Token counts, finish reasons, latencies and the
  // tool payloads survive; the conversation does not.
  override storeTools = true;
  override storeMessages = false;

  #model: LanguageModel | null = null;
  #runCode: Tool | undefined;
  /**
   * Which UTC day the engineer-voice block was rendered for.
   *
   * Written by the provider itself, so it records what is actually in the frozen
   * prompt rather than what a caller believed. `beforeTurn` compares it to today
   * and refreshes when they differ — the block is frozen for a day precisely so
   * this is the only moment it can change.
   */
  #voiceWindow: number | null = null;
  /** What `beforeTurn` assembled, so `beforeStep` can append rather than replace. */
  #turnInstructions = "";
  /** The input revision this turn is answering. Null until a turn starts. */
  #turnRevision: number | null = null;
  /**
   * Which recovery attempt this turn is on.
   *
   * A re-run after an interruption is a DISTINCT billed call, not a replay of
   * the first one, so it must not collide with it on the usage table's unique
   * index. Set from Think's own recovery context in `chatRecovery`.
   */
  #recoveryAttempt = 0;
  /** Whether any step of this turn came back a refusal. Reset per turn. */
  #refusalSeen = false;
  /** Whether the spend preflight took the tools away. Reset per turn. */
  #budgetExhausted = false;
  /**
   * What this turn will leave in memory: what it was asked, what it did, and
   * the host-produced ids its reads returned. Rebuilt per turn — an episode is
   * a record of ONE turn, and carrying actions across would attribute work to
   * the turn that happened to finish after it.
   */
  #turn: TurnRecord = newTurnRecord();

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
        executor: makeGuardedExecutor(
          guardLoader(env.LOADER, PRODUCTION_LIMITS),
          PRODUCTION_LIMITS,
          () => Date.now()
        ),
        // A PROVIDER keyed by execution id: the connector memoises one context
        // per `run_code` execution, so a call budget, an audit stream and a
        // customer-reference map belong to one execution and no two share them.
        connectors: buildConnectors(ctx, env, (executionId) =>
          this.#bindingContext(executionId)
        ),
        // NO `description`, deliberately. A custom one is returned verbatim and
        // DISCARDS Code Mode's own workflow and rules text — including the
        // `codemode.search` / `codemode.describe` discovery instructions the
        // model needs to find a method (`codemode/dist/index.js:1629`).
        //
        // The obvious replacement, `connectorHints`, is NOT reachable here:
        // Think's `createExecuteRuntime` has no such option and derives hints
        // only for the namespaces it wires itself — `tools`, `state`, `cdp`
        // (`think/dist/tools/execute.js:113`), all of which this agent passes
        // as undefined. The per-namespace hints therefore live in
        // CAPABILITY_RULES_BLOCK, where they cost the same tokens and are
        // stable across turns. Verified 2026-08-27.
      });
      this.#runCode = tool;
    });
  }

  /** Whether this wake has already put the frame filter in front of Think's. */
  #framesFiltered = false;

  /**
   * Drop the frames a browser must not be able to send, in front of the handler
   * that would act on them.
   *
   * INSTALLED IN `onStart`, NOT THE CONSTRUCTOR, and the difference is the
   * whole control. Think installs its own protocol `onMessage` wrapper from
   * `_setupProtocolHandlers()` (`think.js:1036`), which runs DURING `onStart` —
   * after every constructor in the chain. A filter wrapped around
   * `this.onMessage` in the constructor therefore sits UNDERNEATH Think's and
   * never sees a protocol frame at all: Think handles `chat-request` and
   * returns without delegating. Measured, not assumed — a chat-request frame
   * started a real turn with the filter in the constructor.
   *
   * This override runs at `think.js:1039`, three lines after that setup, so
   * wrapping here puts it outermost. It is re-applied per wake because Think
   * re-installs its wrapper per wake; the flag stops a second `onStart` on one
   * object from nesting it twice.
   */
  #filterClientFrames(): void {
    if (this.#framesFiltered) return;
    this.#framesFiltered = true;
    const deliver = this.onMessage.bind(this);
    this.onMessage = async (connection, message) => {
      if (isBlockedClientFrame(message)) return;
      return deliver(connection, message);
    };
  }

  /**
   * EVERY connection is readonly, with no exception and no per-viewer branch.
   *
   * `this.state` carries the run id, the status and the parked-approval flag,
   * and a client state frame REPLACES it wholesale. A browser writing
   * `openApprovalId: null` would unpark a run a human still has open for
   * decision; one writing `runId` would point the object's projections and
   * usage rows at another customer's run. Nothing a browser does needs to write
   * this state, so nothing may.
   *
   * It gates state frames ONLY (`agents/dist/index.js:865`), which is why the
   * frame filter in the constructor exists beside it rather than instead of it.
   */
  override shouldConnectionBeReadonly(): boolean {
    return true;
  }

  /**
   * Who is watching, from the header the agent route stamped.
   *
   * Recorded on the CONNECTION rather than on `this.state`: it is one viewer's
   * own email, it must not be broadcast to the other tabs watching the same
   * run, and it must not survive the socket. The route deletes any inbound copy
   * before setting its own, because nothing on this side can verify an identity
   * that has already crossed a Durable Object boundary.
   */
  override async onConnect(
    connection: Connection,
    ctx: ConnectionContext
  ): Promise<void> {
    connection.setState({ email: identityFromRequest(ctx.request) });
  }

  /**
   * Resolve this object's own public run id, on every wake.
   *
   * The DO's NAME is the private run key and the public `runs.id` is a separate
   * UUID (invariant 10), so the agent cannot derive one from the other — it has
   * to ask D1. `bindRun` is the explicit half, called by whoever woke the run;
   * this is the self-healing half, and it is what makes a run reachable through
   * a path that never went through a wake: a dashboard socket, an approval
   * resolution, a scheduled callback after an eviction.
   *
   * `this.configure()` — which the Think docs describe — DOES NOT EXIST on
   * 0.15.1 (2026-08-24 docs audit). `this.state` is the durable carrier.
   *
   * Best effort, deliberately. A throw out of `onStart` is terminal: partyserver
   * resets its init state and the next request re-runs the same failing start,
   * so a D1 blip would make the object permanently unreachable rather than
   * temporarily unbound. `#runId()` refuses honestly while it is null.
   */
  override async onStart(): Promise<void> {
    this.#filterClientFrames();

    if (this.state.runId !== null) return;
    try {
      const run = await getRunByKey(this.env.DB, this.name);
      if (run === null) return;
      await this.bindRun({
        runId: run.id,
        channel: channelForOrigin(runOriginOf(run.key)),
      });
    } catch (err) {
      console.warn(
        "run id not resolved on start",
        err instanceof Error ? err.message : err
      );
    }
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

  /**
   * The static half of the prompt, as get-only context blocks.
   *
   * Get-only is what keeps the tool surface closed: a block with no provider
   * auto-wires a writable one and Session adds `set_context` to every turn.
   */
  override configureSession(session: Session): Session {
    return configureRunSession(session).withContext("engineer_voice", {
      provider: this.#engineerVoiceProvider(),
    });
  }

  override configureChannels() {
    return RUN_CHANNELS;
  }

  /**
   * Everything that varies per turn, in the one hook that runs per turn.
   *
   * `instructions` REPLACES the assembled system prompt rather than extending
   * it (`think.js:2678`), so this appends to `ctx.system` — returning the
   * per-turn text alone would silently drop every context block and Think's own
   * capability preamble.
   */
  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig> {
    await this.#refreshVoiceIfDayChanged();
    await this.#adoptTurnId();

    // The turn's own record starts here, and `asked` is read HERE rather than
    // at the end: `this.messages` ends with this turn's user message now, and
    // by `onChatResponse` the assistant's reply is on the end of it.
    this.#turn = newTurnRecord();
    this.#turn.asked = askedFrom(this.messages);
    this.#budgetExhausted = false;

    const scope = await resolveRunScope(
      this.env,
      this.#runId(),
      this.#turnId()
    );
    const perTurn = turnInstructions({
      scope,
      thread: this.#turnThread(),
      recall: this.#turnRecall(),
      pendingApproval: await this.#pendingApproval(),
    });

    // Cached because `beforeStep` can only REPLACE the instructions, never
    // extend them, and the preflight below has to append a note to whatever
    // this turn actually assembled.
    this.#turnInstructions = composeInstructions(ctx.system, perTurn);

    // Snapshot the revision this turn is answering. Read from the turn's own
    // metadata when it has one — that value is persisted on the user message,
    // so a RECOVERED turn re-resolves the revision it was actually started for
    // rather than the current one — and from durable state otherwise.
    this.#turnRevision = this.#metadataRevision() ?? this.state.inputRevision;

    return {
      instructions: this.#turnInstructions,
      activeTools: ACTIVE_TOOLS,
      providerOptions: ANTHROPIC_PROVIDER_OPTIONS,
      sendReasoning: false,
      // Think's default is 10, which is low for a repro-and-fix run. The money
      // is the binding authority (invariant 28); this is the belt.
      maxSteps: MAX_STEPS_PER_TURN,
      stopWhen: spendStopWhen(FABLE_5_MODEL_ID, this.#spendCeiling()),
      // `agentId` is OVERRIDDEN, and that is the point of stamping this at
      // all. Think's default is `this.name` (`think.js:2548`) — the PRIVATE
      // run key — which would put `slack:{channel}:{thread_ts}` in the trace
      // store for every customer conversation, breaking invariant 10 in a
      // third-party system nobody greps. Caller metadata is merged last, so
      // naming the public id here replaces it.
      telemetry: turnTelemetry({
        runId: this.state.runId ?? "unbound",
        turnId: this.#turnId(),
      }),
    };
  }

  /**
   * The spend PREFLIGHT: take the tools away before a step that would cross the
   * ceiling, so the model writes its final text instead of buying another
   * round-trip it cannot pay for.
   *
   * This is not the enforcement point — `beforeStep` cannot end a turn, because
   * `StepConfig` has no stop. `beforeTurn`'s `stopWhen` is. This is the part
   * that makes the ending useful rather than abrupt.
   */
  override async beforeStep(
    ctx: PrepareStepContext
  ): Promise<StepConfig | void> {
    // Steers first: a human's instruction should reach the model even on the
    // step that turns out to be the last affordable one.
    const spliced = this.#spliceSteers(ctx.messages);

    const decision = spendDecision({
      spentNanoUsd: spentNanoUsd(FABLE_5_MODEL_ID, ctx.steps),
      ceilingNanoUsd: this.#spendCeiling(),
      // The prompt this step would send, charged at the worst input rate. Only
      // a minimum useful output allowance is reserved: the question is whether
      // there is room for a closing message, not for another full step.
      estimateNanoUsd: worstCaseStepNanoUsd({
        modelId: FABLE_5_MODEL_ID,
        promptBytes: JSON.stringify(ctx.messages).length,
        maxOutputTokens: MIN_USEFUL_OUTPUT_TOKENS,
      }),
    });

    // `StepConfig` is `Omit<PrepareStepResult, "model">` over a union ending in
    // `undefined`, so it type-collapses on a bare object literal. Build the
    // checked shape first, then widen on the way out.
    if (decision.allow) {
      if (spliced === null) return;
      const withSteers: PrepareStepResult<ToolSet> = { messages: spliced };
      return withSteers;
    }

    this.#budgetExhausted = true;
    const config: PrepareStepResult<ToolSet> = {
      ...(spliced === null ? {} : { messages: spliced }),
      activeTools: [],
      instructions: [
        this.#turnInstructions,
        "## Budget",
        "",
        "This turn has spent what it is allowed to spend, so the capability tool is",
        "no longer available. Write your closing message now: say what you found,",
        "what you verified, and what you did not get to. Do not describe work you",
        "did not do.",
        "",
        `Host record: ${decision.reason}.`,
      ].join("\n"),
    };
    return config;
  }

  /** The turn spend ceiling, from the environment, with the reviewed default. */
  #spendCeiling(): number {
    return spendCeilingFrom(this.env.RUN_SPEND_CEILING_NANO_USD);
  }

  /**
   * The last host code before a tool executes.
   *
   * Two refusals, and they are deliberately different SHAPES:
   *
   *  - a run parked on a human decision gets `block`, whose `reason` reaches the
   *    model as the tool result. It is a state, not a failure: the right thing
   *    for the model to do is stop and wait, and a reason it can read says so.
   *  - a superseded turn gets `substitute`, an OBJECT with an `error` field
   *    rather than a thrown error. `stale_generation` is the same code the
   *    capability layer raises, so the model sees one vocabulary whether the
   *    supersession is caught here or three calls into a `run_code` block.
   */
  override async beforeToolCall(
    _ctx: ToolCallContext
  ): Promise<ToolCallDecision | void> {
    if (this.state.openApprovalId !== null) {
      return {
        action: "block",
        reason:
          "This run is paused on a human approval. Wait for the decision; it will reach you as a new turn.",
      };
    }
    if (this.#isStale()) {
      return {
        action: "substitute",
        output: {
          error: "stale_generation",
          message:
            "A newer message arrived while you were working. Stop, re-read the thread, and answer what was actually asked.",
        },
      };
    }
  }

  /**
   * Whether this turn has been superseded.
   *
   * Every submit bumps `state.inputRevision`; a turn answering an older one is
   * working from input somebody has already replaced. Null means no turn has
   * started, which is never stale.
   */
  #isStale(): boolean {
    if (this.#turnRevision === null) return false;
    return this.#turnRevision < this.state.inputRevision;
  }

  /**
   * The same comparison, one layer deeper.
   *
   * `beforeToolCall` catches a superseded turn between tool calls, which is not
   * enough: one `run_code` block can spend ten seconds making twenty capability
   * calls, and without this it would run the whole plan against input that has
   * been replaced. This makes it stop at the NEXT capability call.
   */
  #freshnessGuard(): AgentExecutionGuard {
    return {
      assertFresh: async () => {
        if (this.#isStale()) throw staleGeneration();
      },
    };
  }

  /**
   * Adopt the turn id the submission stamped, so everything this turn writes is
   * attributable to it.
   *
   * Every entry point mints one id and passes it as both the submission's
   * `idempotencyKey` and its `turnId` metadata, so a redelivery that is refused
   * as a duplicate was never given a second identity. It reaches the run scope,
   * the usage rows and the capability audit from here.
   *
   * Falls back to keeping whatever is set: a turn started by a path that
   * stamped nothing is still a turn, and "boot" is a truthful label for one
   * nobody named.
   */
  async #adoptTurnId(): Promise<void> {
    const turnId = this.#metadataTurnId();
    if (turnId === null || this.state.turnId === turnId) return;
    this.setState({ ...this.state, turnId });
  }

  /** The turn id stamped on this turn's user message, if it carries one. */
  #metadataTurnId(): string | null {
    const raw = this.activeTurnMetadata?.turnId;
    return typeof raw === "string" && raw !== "" ? raw : null;
  }

  /** The revision stamped on this turn's user message, if it carries one. */
  #metadataRevision(): number | null {
    const raw = this.activeTurnMetadata?.inputRevision;
    return typeof raw === "number" && Number.isInteger(raw) && raw >= 0
      ? raw
      : null;
  }

  /**
   * Bind this object to its public run id.
   *
   * The DO name is the private key and the public id is a separate UUID, so the
   * agent cannot derive one from the other — the wake path resolves the D1 row
   * and calls this. Idempotent, and it refuses a REBIND: two different run ids
   * on one key means the D1 index and the session disagree about which
   * conversation this is, and picking either would be a guess.
   */
  async bindRun(input: {
    runId: string;
    channel: RunChannelId;
  }): Promise<void> {
    const current = this.state.runId;
    if (current !== null && current !== input.runId) {
      throw new CapabilityError(
        "invalid_context",
        "this run key is already bound to a different run id"
      );
    }
    if (current === input.runId && this.state.channel === input.channel) return;
    this.setState({
      ...this.state,
      runId: input.runId,
      channel: input.channel,
    });
  }

  /**
   * One completed model step: what it cost, and that the run is alive.
   *
   * ORDER MATTERS, and it is invariant 32's. The usage row is written FIRST and
   * neither write may throw: a D1 outage that propagated into the loop would
   * abort the turn, and the retry would re-buy every step already paid for. A
   * projection that does not land is a stale dashboard; a projection that
   * throws is a second bill.
   */
  override async onStepEnd(ctx: StepContext): Promise<void> {
    await this.#recordStepUsage(ctx);

    // A REFUSAL IS NOT AN ERROR, and that is the whole problem with it.
    // `@ai-sdk/anthropic` maps Anthropic's `stop_reason: refusal` to
    // `finishReason: "content-filter"` — an ordinary finish, HTTP 200, visible
    // only here and in onChatResponse. Left unread, the run would report
    // success with no answer in it. Invariant 30 says surface it; invariant 31
    // says do not retry it on another model.
    if (ctx.finishReason === "content-filter") this.#refusalSeen = true;

    // Invariant 17. Thrown, deliberately: a throw here rejects the step, which
    // ends the turn as an error, and recording the usage first means the step
    // that was billed is still accounted for.
    assertThinkingOmitted(ctx.reasoning);

    await this.setStatus("live");
  }

  /**
   * How a turn ended, and what the run becomes.
   *
   * `completed` does NOT mean idle. A run that escalated is parked on a human,
   * and reporting it idle is what let a waiting approval look finished (defect
   * 3). A refusal is `failed` even though the provider called it a clean stop.
   * `done` is never set here: releasing the Slack thread is an explicit close,
   * not something a turn ending does on its own.
   */
  override async onChatResponse(result: ChatResponseResult): Promise<void> {
    const terminal: RunStatus =
      result.status !== "completed"
        ? "failed"
        : this.#refusalSeen
          ? "failed"
          : this.state.openApprovalId !== null
            ? "awaiting_approval"
            : "idle";

    // The episode is written BEFORE the flags are reset, because it reads
    // them, and before the status projection, because a memory failure must
    // never change what the run reports. It cannot throw into this hook.
    await this.#rememberTurn(result, terminal);

    this.#refusalSeen = false;
    this.#budgetExhausted = false;
    this.#turnRevision = null;
    this.#recoveryAttempt = 0;
    // The turn is over, so the id it stamped on scopes and usage rows is over
    // with it. Left set, the next path that reaches `#turnId()` without a turn
    // — an approval expiry, a projection — would attribute itself to a turn
    // that has already finished.
    if (this.state.turnId !== null)
      this.setState({ ...this.state, turnId: null });
    await this.setStatus(terminal);
    if (isTerminalRunStatus(terminal)) await this.#teardownSandbox();
  }

  /**
   * One bounded episode per finished turn, into the memory outbox.
   *
   * `Agent.queue()` is deliberately NOT used: the D1 outbox already owns
   * cross-DO durability and has a one-minute cron sweep behind it, and a second
   * durable queue for the same job would be two protocols that only work if
   * there is one.
   *
   * NOTHING HERE MAY FAIL THE TURN. The customer's answer was durable and
   * broadcast before this ran; memory lag is an operational warning, not an
   * incident (invariant 32 applied to Zep). Every failure is caught and named.
   */
  async #rememberTurn(
    result: ChatResponseResult,
    terminal: RunStatus
  ): Promise<void> {
    const runId = this.state.runId;
    if (runId === null) return;

    try {
      const run = await getRunById(this.env.DB, runId);
      if (run === null) return;
      await enqueueTurnEpisode(this.env, {
        runId,
        turnId: this.#turnId(),
        origin: run.origin,
        channelId: run.channelId,
        outcome: episodeOutcomeFor({
          status: terminal,
          refused: this.#refusalSeen,
          budgetExhausted: this.#budgetExhausted,
        }),
        record: this.#turn,
        // The SELECTED final assistant text, handed over by the hook. Never a
        // stream delta: deltas have no route into this module at all.
        draft: messageText(result.message as never),
        now: Date.now(),
      });
    } catch (err) {
      console.warn(
        "run episode not enqueued",
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * What every dashboard tab sees when a turn fails.
   *
   * `onChatError`'s RETURN VALUE is broadcast as the client-visible error text
   * (`think.js:2405-2411`), so returning the provider's body would put an
   * upstream payload — headers, request echoes, whatever the vendor included —
   * in front of everyone watching. Scrubbed by `redact` and bounded.
   */
  override onChatError(error: unknown, _ctx?: ChatErrorContext): unknown {
    const raw = error instanceof Error ? error.message : String(error);
    return `The turn failed: ${redact(raw).slice(0, CHAT_ERROR_MAX_CHARS)}`;
  }

  /**
   * Interruption recovery is Think's, not ours — `chatRecovery` is on by
   * default and wraps every turn in a fiber with keepalive. What is configured
   * here is the two ends it leaves to the host: a budget predicate, and what a
   * run becomes when recovery gives up.
   *
   * A config assigned during `onStart()` is read as the built-in defaults by the
   * time recovery decides. This is a field initializer, which runs in the
   * constructor, so it is in place before any turn.
   */
  override chatRecovery: ChatRecoveryConfig = {
    shouldKeepRecovering: async (ctx) => {
      // Also the only place the attempt number is observable, and the usage
      // table needs it: a re-run is a distinct billed call, not a replay.
      this.#recoveryAttempt = ctx.attempt;
      return this.#underSpendCeiling();
    },
    onExhausted: async () => {
      await this.setStatus("failed");
      await this.#teardownSandbox();
    },
  };

  /** Compact and retry once when the provider says the context is full. */
  override contextOverflow = { reactive: true };
  override classifyChatError = defaultContextOverflowClassifier;

  /**
   * An operator stop. Aborts the turn in flight; the run stays where it is
   * rather than being marked failed, because a human stopping a run is not the
   * run failing.
   */
  @callable()
  async cancel(): Promise<void> {
    this.cancelAllChats();
  }

  /**
   * Whether this run has money left, read from what it has actually been billed.
   *
   * Deliberately D1 rather than the in-turn step usage: recovery re-runs span
   * turns, and the question "has this run spent enough already" is only
   * answerable from the durable record.
   */
  async #underSpendCeiling(): Promise<boolean> {
    const ceiling = this.#spendCeiling();
    if (ceiling <= 0) return true;
    const runId = this.state.runId;
    if (runId === null) return true;
    try {
      const spent = (await readRunUsage(this.env.DB, runId)).reduce(
        (total, row) => total + row.costNanoUsd,
        0
      );
      return spent < ceiling;
    } catch {
      // A D1 read failing must not decide to stop recovering a turn somebody is
      // waiting on. The turn's own stopWhen still bounds it.
      return true;
    }
  }

  /**
   * Destroy this run's container.
   *
   * Best effort by design: a container that will not die must not turn a
   * finished run into a failed one, and the Worker's cron sweep collects
   * whatever this misses.
   */
  async #teardownSandbox(): Promise<void> {
    const runId = this.state.runId;
    if (runId === null || !sandboxContainersAvailable(this.env)) return;
    try {
      await makeSandboxLifecycle(this.env).teardown(runId);
    } catch (err) {
      console.warn(
        "sandbox teardown failed",
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Move the run's status.
   *
   * Written in two places at once, deliberately: `this.state` so every
   * connected dashboard tab sees it immediately, and — through the in-DO queue,
   * which is ordered and retried — D1, so a list view that never wakes this
   * object agrees. The Worker's cron sweep is the cross-DO backstop for a
   * projection that never lands at all.
   */
  async setStatus(to: RunStatus): Promise<void> {
    if (this.state.status === to) return;
    this.setState({ ...this.state, status: to });
    await this.queue(
      "applyStatusProjection",
      { to, at: Date.now() },
      { retry: { maxAttempts: 5 } }
    );
  }

  /**
   * The queued projection's callback. Public because `queue()` resolves it by
   * name off the instance.
   *
   * Validates the payload rather than trusting it: it round-trips through JSON
   * in DO SQLite and can outlive a deploy, so a row written by an older build is
   * a thing to drop rather than to crash on.
   */
  async applyStatusProjection(payload: unknown): Promise<void> {
    if (typeof payload !== "object" || payload === null) return;
    const { to, at } = payload as { to?: unknown; at?: unknown };
    if (!isRunStatus(to)) return;
    const runId = this.state.runId;
    if (runId === null) return;
    const outcome = await projectStatus(
      this.env.DB,
      runId,
      to,
      typeof at === "number" ? at : Date.now()
    );
    if (
      !outcome.applied &&
      outcome.reason !== undefined &&
      outcome.reason !== "same_status"
    ) {
      // Named, not swallowed. An illegal transition reaching here means the DO
      // and the index disagree about what this run is, which is worth seeing.
      console.warn(`run projection not applied: ${outcome.reason}`);
    }
  }

  async #recordStepUsage(ctx: StepContext): Promise<void> {
    const runId = this.state.runId;
    if (runId === null) return;
    const usage = normalizeUsage(ctx.usage);
    const modelId = ctx.model?.modelId ?? FABLE_5_MODEL_ID;

    try {
      await recordUsage(this.env.DB, {
        runId,
        // The AI SDK's own id for the generation this step belongs to, which is
        // what the unique index is keyed on together with attempt and step.
        generationId: ctx.callId,
        agentTurnId: this.#turnId(),
        attempt: this.#recoveryAttempt,
        stepIndex: ctx.stepNumber,
        provider: ctx.model?.provider ?? "anthropic",
        model: modelId,
        // Metadata, never an idempotency key: it changes on a retry of the same
        // logical step.
        providerRequestId: ctx.response?.id ?? null,
        gatewayLogId: ctx.response?.headers?.["cf-aig-log-id"] ?? null,
        inputTokens: usage.inputTokens,
        noCacheTokens: usage.noCacheTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        totalTokens: usage.totalTokens,
        costNanoUsd: costBreakdown({
          modelId,
          usage,
          // A pre-output refusal comes back HTTP 200 and Anthropic does not
          // bill it. The tokens are still recorded; the money is not.
          billing: ctx.finishReason === "content-filter" ? "none" : "normal",
        }).totalNanoUsd,
        latencyMs: Math.max(0, Math.round(ctx.performance?.stepTimeMs ?? 0)),
        finishReason: ctx.finishReason ?? null,
        rawFinishReason: ctx.rawFinishReason ?? null,
        errorCode: null,
        createdAt: Date.now(),
      });
    } catch (err) {
      // Never into the loop. See the ordering note on onStepEnd.
      console.error(
        "usage row not recorded",
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Record that new input arrived, and return the revision a submit must stamp.
   *
   * Every entry point that adds a user message goes through here — the wake path
   * (Task 19) and `steer` — because the revision is what makes supersession
   * detectable at all: a turn answering revision N is stale the moment N+1
   * exists, and `beforeToolCall` and the capability guard both read that.
   */
  async noteInput(): Promise<number> {
    const inputRevision = this.state.inputRevision + 1;
    this.setState({ ...this.state, inputRevision });
    return inputRevision;
  }

  /**
   * A human typing into a run.
   *
   * IDEMPOTENT BY `requestId`, and it has to be: the SDK gives a `@callable` no
   * idempotency of its own, and a browser tab re-sends after a reconnect. The
   * check is against the session tree, where `addMessages` is idempotent by
   * message id, plus the queued-steer table for the mid-turn case.
   *
   * `mode: "submit"` and never `mode: "wait"`. A wait from inside the object
   * blocks on the turn queue that this very call is trying to add to.
   */
  @callable()
  async steer(
    text: string,
    requestId: string
  ): Promise<{ queued: boolean; woke: boolean }> {
    const body = steerText(text);
    const messageId = `steer:${requestId}`;
    if (this.#alreadySteered(messageId, requestId))
      return { queued: false, woke: false };

    // Parked, or a turn already running: store it. In the parked case that is
    // the whole point — surfacing a new instruction while a human still has the
    // previous reply open for decision is what the pause exists to prevent, so
    // it waits for the resolution turn to drain it.
    if (this.state.openApprovalId !== null || this.state.status === "live") {
      queueSteer(this.sql.bind(this) as SqlTag, {
        requestId,
        text: body,
        createdAt: Date.now(),
      });
      return { queued: true, woke: false };
    }

    // Idle: the submit IS the wake. There is no separate "start the run" call,
    // and adding one would be a second way to begin a turn.
    //
    // THROUGH `schedule(0, …)`, NEVER DIRECTLY. `runTurn` called from inside a
    // Durable Object RPC method deadlocks — even unawaited — and this method is
    // reached as one from every caller it has. The zero-delay schedule runs the
    // submit from the alarm instead, which is outside the RPC's invocation.
    // `noteInput` is NOT called here, and that is not a style choice.
    // `setState` throws "Connection is readonly" when it runs inside a
    // connection-scoped invocation (`agents/dist/index.js:1133`), and every
    // caller of this method reaches it as `@callable` RPC over a socket this
    // agent marks readonly. The scheduled callback runs from the alarm, outside
    // any connection, which is also the more honest place to mint the revision:
    // it belongs to the turn that actually starts.
    await this.schedule(0, "startSteerTurn", { messageId, text: body });
    return { queued: false, woke: true };
  }

  /**
   * The scheduled half of `steer`. Public because `schedule()` resolves the
   * callback by name off the instance.
   *
   * The `idempotencyKey` and the message id are both the steer's request id, so
   * a duplicate that somehow reaches here is refused by the submission queue
   * rather than starting a second turn.
   */
  async startSteerTurn(payload: unknown): Promise<void> {
    if (typeof payload !== "object" || payload === null) return;
    const { messageId, text } = payload as {
      messageId?: unknown;
      text?: unknown;
    };
    if (typeof messageId !== "string" || typeof text !== "string") return;

    const inputRevision = await this.noteInput();

    await this.runTurn({
      mode: "submit",
      input: [
        {
          id: messageId,
          role: "user",
          parts: [
            {
              type: "text",
              text: steerMessageText({
                requestId: messageId,
                text,
                createdAt: Date.now(),
              }),
            },
          ],
        },
      ],
      idempotencyKey: messageId,
      channel: this.state.channel,
      metadata: { inputRevision, turnId: messageId },
    });
  }

  /** What is waiting to be spliced into the running turn. Test surface. */
  async pendingSteersForTest(): Promise<SteerRow[]> {
    return pendingSteers(this.sql.bind(this) as SqlTag);
  }

  /**
   * Has this exact steer already been taken?
   *
   * Two places to look, because a steer lives in one or the other depending on
   * which state the run was in when it arrived.
   */
  #alreadySteered(messageId: string, requestId: string): boolean {
    if (this.messages.some((message) => message.id === messageId)) return true;
    return pendingSteers(this.sql.bind(this) as SqlTag).some(
      (row) => row.requestId === requestId
    );
  }

  /**
   * Drain the queued steers into the step about to run.
   *
   * Returns null when there is nothing to splice, so `beforeStep` can leave the
   * messages alone rather than handing back an identical copy.
   *
   * Nothing is drained while the run is parked: the steers stay in the table
   * until the approval resolves and the resolution turn picks them up.
   */
  #spliceSteers(messages: readonly ModelMessage[]): ModelMessage[] | null {
    if (this.state.openApprovalId !== null) return null;
    const steers = consumeSteers(this.sql.bind(this) as SqlTag);
    if (steers.length === 0) return null;
    return [
      ...messages,
      ...steers.map(
        (row): ModelMessage => ({
          role: "user",
          content: steerMessageText(row),
        })
      ),
    ];
  }

  /**
   * Park or unpark the run on a human decision.
   *
   * Called by the approval port when `approval.escalate` opens a card (Task 20)
   * and by the resolution notifier when a human decides (Task 21). It is the one
   * writer of `openApprovalId`, which `beforeToolCall` reads to block work and
   * `beforeTurn` reads to tell the model what is already pending.
   */
  async setOpenApproval(approvalId: string | null): Promise<void> {
    if (this.state.openApprovalId === approvalId) return;
    this.setState({
      ...this.state,
      openApprovalId: approvalId,
      // Never cleared. `withdraw` consults it when nothing is open, to tell a
      // redelivered withdrawal apart from one that lost a race to a human.
      lastApprovalId: approvalId ?? this.state.lastApprovalId,
    });
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
    const { createWorkspaceTools } = await import(
      "@cloudflare/think/tools/workspace"
    );
    return Object.keys({
      ...createWorkspaceTools(this.workspace, { bash: this.workspaceBash }),
      ...this.getTools(),
      ...(await this.session.tools()),
    });
  }

  /** What beforeTurn permits the model to call. */
  async activeToolsForTest(): Promise<string[]> {
    return ACTIVE_TOOLS;
  }

  /** The frozen system prompt, as the model would receive it. Test surface. */
  async systemPromptForTest(): Promise<string> {
    return this.session.freezeSystemPrompt();
  }

  /**
   * Run the per-turn hook against a synthetic context and return the parts that
   * survive RPC. `TurnConfig` carries functions (`stopWhen`), so it cannot cross
   * a stub itself.
   */
  async beforeTurnForTest(
    assembledSystem = ""
  ): Promise<{
    instructions: string;
    activeTools: string[];
    maxSteps: number;
  }> {
    const config = await this.beforeTurn({
      system: assembledSystem,
    } as TurnContext);
    return {
      instructions: config.instructions ?? "",
      activeTools: [...(config.activeTools ?? [])],
      maxSteps: config.maxSteps ?? 0,
    };
  }

  /**
   * Run `onStepEnd` and report how it ended.
   *
   * A throw crossing an RPC stub is logged by the runtime as an uncaught
   * exception even when the caller handles the rejection, which turns one
   * deliberate assertion into permanent suite noise. This keeps the throw inside
   * the object where it belongs.
   */
  async stepEndOutcomeForTest(ctx: unknown): Promise<string | null> {
    try {
      await this.onStepEnd(ctx as StepContext);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * The whole of this agent's trace policy, as one readable value.
   *
   * Span EMISSION is a deploy-side property — the OTLP destination is a
   * dashboard setting, not anything a Worker var or the test pool can reach —
   * so what a test can pin from in here is the policy that decides what those
   * spans carry. That is the half with the security content.
   */
  async tracingPolicyForTest(): Promise<{
    storeTools: boolean;
    storeMessages: boolean;
    telemetry: { functionId?: string; metadata?: Record<string, unknown> };
  }> {
    return {
      storeTools: this.storeTools,
      storeMessages: this.storeMessages,
      telemetry: turnTelemetry({
        runId: this.state.runId ?? "unbound",
        turnId: this.#turnId(),
      }) as { functionId?: string; metadata?: Record<string, unknown> },
    };
  }

  /**
   * Every table in this object's own SQLite that contains `needle`.
   *
   * ENUMERATED FROM `sqlite_master`, NEVER FROM A LIST OF NAMES. The tables
   * that matter here are not ours: Think creates the session tree, the
   * submission ledger, the chat fiber snapshots, the cached prompt store and
   * the stream chunk table, and the set changes when the SDK version does. A
   * sweep over names somebody wrote down by hand would keep passing after the
   * SDK added the table that leaks.
   *
   * A test surface, and only that — nothing in production calls it. It exists
   * because invariant 39 is a claim about storage nobody can see from outside
   * the object, and a claim nothing checks is a claim that quietly stops being
   * true.
   */
  async sweepForCanaryForTest(needle: string): Promise<string[]> {
    // `ctx.storage.sql.exec` and NOT the `this.sql` tag. The tag binds every
    // interpolation as a PARAMETER, and SQLite has no bind slot for an
    // identifier — `FROM "${name}"` would run `FROM "?"`. A table name is not a
    // value, so it has to be concatenated, which is why the shape is checked
    // first even though sqlite_master is the only source it has.
    const raw = this.ctx.storage.sql;
    const tables = [
      ...raw.exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC"
      ),
    ];

    const hits: string[] = [];
    for (const { name } of tables) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      try {
        const rows = [...raw.exec(`SELECT * FROM "${name}"`)];
        if (rows.some((row) => JSON.stringify(row).includes(needle)))
          hits.push(name);
      } catch {
        // `_cf_KV` refuses direct SQL with SQLITE_AUTH: it is the key-value
        // surface the runtime reserves, and `this.state` lives in it. Skipped
        // here and swept below through the API that IS allowed to read it, so
        // the hole is covered rather than excused.
        hits.push(...(await this.#sweepKeyValue(needle, name)));
      }
    }
    return hits;
  }

  /**
   * The half of durable storage SQL cannot reach: the key-value surface, which
   * is where `this.state` and every scheduled callback's payload live.
   */
  async #sweepKeyValue(needle: string, label: string): Promise<string[]> {
    const stored = await this.ctx.storage.list();
    const values = [...stored.values(), this.state];
    return values.some((value) =>
      JSON.stringify(value ?? null).includes(needle)
    )
      ? [label]
      : [];
  }

  /**
   * The Code Mode audit trail as the runtime holds it: the model-authored
   * program, every capability call's arguments, and every logged result.
   */
  async codemodeAuditForTest(): Promise<string> {
    const executions = (await this.codemode?.executions(50)) ?? [];
    return JSON.stringify(executions);
  }

  /** The durable run state, for assertions that would otherwise need a socket. */
  async runStateForTest(): Promise<RunAgentState> {
    return { ...this.state };
  }

  /** What `beforeToolCall` would decide for the run as it stands. */
  async toolCallDecisionForTest(): Promise<ToolCallDecision | undefined> {
    return (await this.beforeToolCall({} as ToolCallContext)) ?? undefined;
  }

  /**
   * What the capability pipeline's freshness guard would answer for the run as
   * it stands: the refusal code, or null when the turn is still current.
   */
  async freshnessForTest(): Promise<string | null> {
    try {
      await this.#freshnessGuard().assertFresh();
      return null;
    } catch (err) {
      return err instanceof CapabilityError ? err.code : "unknown";
    }
  }

  /** The per-turn instructions for the run as it stands. Test surface. */
  async turnInstructionsForTest(): Promise<string> {
    const scope = await resolveRunScope(
      this.env,
      this.#runId(),
      this.#turnId()
    );
    return turnInstructions({
      scope,
      thread: this.#turnThread(),
      recall: this.#turnRecall(),
      pendingApproval: await this.#pendingApproval(),
    });
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
   * The approval port is built HERE rather than in `dependencies.ts` because it
   * is the only capability that reads and writes this object's own durable
   * state. Everything it needs from the run — the pinned thread, the shadow
   * flag, the turn that is escalating — comes from the host-resolved scope, and
   * nothing on it can be chosen by the model.
   */
  async #bindingContext(outerToolCallId: string): Promise<BindingContext> {
    const scope = await resolveRunScope(
      this.env,
      this.#runId(),
      this.#turnId()
    );
    return {
      scope,
      deps: productionDependencies(this.env, scope, this.#approvalPort(scope)),
      limits: PRODUCTION_LIMITS,
      execution: newCodeExecution({
        outerToolCallId,
        // The audit is what "what it did" in the turn's episode is made of:
        // capability NAMES and stable error CODES, never a result body.
        audit: makeTurnAuditSink(this.#turn),
        guard: this.#freshnessGuard(),
        limits: PRODUCTION_LIMITS,
        clock: () => Date.now(),
        // Where a trusted read registers the host-produced ids it RETURNED, so
        // a later claim can be traced back to a real message.
        provenance: makeTurnProvenanceSink(this.#turn),
      }),
    };
  }

  #approvalPort(scope: RunScope): ApprovalPort {
    return makeApprovalPort({
      db: this.env.DB,
      env: this.env,
      runId: scope.runId,
      generationId: scope.turnId,
      slackThread: scope.slackThread,
      shadow: scope.shadow,
      now: () => Date.now(),
      openApprovalId: () => this.state.openApprovalId,
      lastApprovalId: () => this.state.lastApprovalId,
      setOpenApproval: (approvalId) => this.setOpenApproval(approvalId),
      // Both are scheduled rather than awaited: a Slack call on the tool-call
      // path would put an eight-second timeout inside the model's own run_code
      // execution, and the alarm cannot run until this turn ends — which is
      // exactly when the human needs the DM, because that is when the run
      // actually parks.
      scheduleNudge: async (approvalId) => {
        await this.schedule(0, "nudgeApproval", { approvalId });
      },
      scheduleExpiry: async (approvalId) => {
        await this.schedule(APPROVAL_TTL_SECONDS, "approvalExpired", {
          approvalId,
        });
      },
    });
  }

  /**
   * Ask the engineer. Public because `schedule()` resolves the callback by name
   * off the instance.
   *
   * Best effort by design: `sendNudge` claims the row's one nudge slot by CAS
   * and hands it back on failure, and the Worker's one-minute sweep re-attempts
   * every pending card that has sat unnudged. A Slack outage delays the DM; it
   * does not lose the approval.
   */
  async nudgeApproval(payload: unknown): Promise<void> {
    const approvalId = readApprovalId(payload);
    if (approvalId === null) return;
    try {
      const card = await getApproval(this.env.DB, approvalId);
      if (card === null || card.decision !== "pending") return;
      await sendNudge(this.env, card);
    } catch (err) {
      console.warn(
        "approval nudge failed",
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * The run stops waiting.
   *
   * It does NOT decide for the human — nothing here writes `approved` or
   * `rejected`. It withdraws the escalation, which loses gracefully to a
   * decision that landed first, and fails the run.
   *
   * `failed` rather than `idle`, and that is the point: a failed run releases
   * its Slack thread, and triage's abandoned-thread override reads exactly that
   * status to re-wake a thread whose run died. So a customer who follows up
   * after a timeout is answered instead of reasoned into silence — which is the
   * live failure that override exists for.
   */
  async approvalExpired(payload: unknown): Promise<void> {
    const approvalId = readApprovalId(payload);
    if (approvalId === null || this.state.openApprovalId !== approvalId) return;

    const scope = await resolveRunScope(
      this.env,
      this.#runId(),
      this.#turnId()
    );
    const outcome = await this.#approvalPort(scope).withdraw();
    if (!outcome.withdrawn) {
      // A human decided in the race. Their resolution turn carries the decision
      // in and unparks the run; there is nothing here to fail.
      return;
    }
    await this.setStatus("failed");
    await this.#teardownSandbox();
  }

  /**
   * The engineer-voice block: a get-only provider that records which UTC day it
   * rendered, so `beforeTurn` can tell when the freeze has expired.
   */
  #engineerVoiceProvider(): ContextProvider {
    return {
      get: async () => {
        const now = Date.now();
        this.#voiceWindow = voiceWindowIndex(now);
        return renderEngineerVoice(
          await resolveEngineerVoice(this.env.DB, now)
        );
      },
    };
  }

  /**
   * Re-render the frozen prompt when the UTC day turns over.
   *
   * The whole point of the freeze is that this is the only moment the block may
   * change; without the refresh a long-lived isolate would serve yesterday's
   * samples indefinitely.
   */
  async #refreshVoiceIfDayChanged(): Promise<void> {
    const today = voiceWindowIndex(Date.now());
    if (this.#voiceWindow === null || this.#voiceWindow === today) return;
    await this.session.refreshSystemPrompt();
  }

  /**
   * The public run id, from durable state. Bound by the wake path from the D1
   * row whose key is `this.name`; the name is the private key and the two are
   * deliberately different values.
   */
  #runId(): string {
    const runId = this.state.runId;
    if (runId === null) {
      throw new CapabilityError(
        "invalid_context",
        "this run has not been woken yet"
      );
    }
    return runId;
  }

  #turnId(): string {
    return this.state.turnId ?? "boot";
  }

  /**
   * The thread this turn was woken on, from the turn's own metadata.
   *
   * Turn metadata is the SDK's recovery-safe, server-only carrier: reserved keys
   * on client-supplied messages are stripped at intake, and the value is
   * persisted on the user message so a recovered turn re-resolves it. Read
   * defensively anyway — it crosses a durable boundary, so a row written by an
   * older build is a thing to ignore rather than to crash on.
   */
  #turnThread(): ThreadMessage[] {
    const raw = this.activeTurnMetadata?.thread;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.text !== "string" || typeof record.ts !== "string")
        return [];
      return [
        {
          ts: record.ts,
          userId: typeof record.userId === "string" ? record.userId : null,
          text: record.text,
          permalink:
            typeof record.permalink === "string" ? record.permalink : null,
        },
      ];
    });
  }

  #turnRecall(): RecalledFact[] {
    const raw = this.activeTurnMetadata?.recall;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.fact !== "string") return [];
      return [
        {
          fact: record.fact,
          citation:
            typeof record.citation === "string" ? record.citation : null,
        },
      ];
    });
  }

  /**
   * The approval this run is parked on, read from the host's record.
   *
   * The id comes from durable state and the content from D1, so a model that
   * rewrote its own draft in the transcript cannot change what it is told is
   * pending. A missing row means the projection has not landed; naming the id
   * alone is still better than saying nothing, because "do not escalate twice"
   * is the instruction that matters.
   */
  async #pendingApproval(): Promise<PendingApprovalFacts | null> {
    const approvalId = this.state.openApprovalId;
    if (approvalId === null) return null;
    const row = await getApproval(this.env.DB, approvalId);
    if (row === null) return { approvalId, draft: "" };
    return { approvalId, draft: row.draft, why: row.why };
  }

  /** Pins the identity opt-out above against an SDK default change. */
  async sendsIdentityOnConnect(): Promise<boolean> {
    return (this.constructor as typeof RunAgent).options.sendIdentityOnConnect;
  }
}

/** Re-exported so the wake path names one thing. */
export { channelForOrigin };
