import type { Tool } from "ai";
import type { Env } from "../index";
import { BETTERSTACK_UPTIME_ENDPOINT, makeBetterStackReader } from "../betterstack/client";
import { getChannelPolicy, type ChannelPolicy } from "../db/channels";
import { makeArtifactPublisher } from "../files/r2";
import { makeLangSmithReader } from "../langsmith/client";
import { makeLinearGateway } from "../linear/client";
import type { MemoryStore } from "../memory/store";
import { ZepMemory } from "../memory/zep";
import { getRunById } from "../run/repository";
import type { RunState } from "../run/session";
import { makeSlackGateway } from "../slack/gateway";
import { PRODUCTION_ALLOWLIST } from "../supabase/allowlist";
import { makeSupabaseReader } from "../supabase/reader";
import {
  PRODUCTION_LIMITS,
  validateScope,
  type AgentExecutionGuard,
  type CapabilityAuditSink,
  type CodeModeLimits,
  type CodeModeScope,
} from "../codemode/contracts";
import { CapabilityError } from "../codemode/errors";
import type { CapabilityDependencies } from "../codemode/gateways";
import {
  makeRunCodeTool,
  type CodeExecutionContext,
  type CodeModeOutput,
} from "../codemode/tool";

/**
 * The ONE place `Env` becomes capability ports.
 *
 * Everything credential-shaped stops here. A binding module receives
 * `CapabilityDependencies` — seven narrow interfaces and a clock — and has no
 * type-level way to reach a token even by accident; adding one would mean
 * widening `CapabilityDependencies` in a diff somebody has to sign off. The
 * Worker Loader isolate receives less still: `globalOutbound: null` and an
 * empty application env, so a credential cannot cross that boundary because
 * none is on the other side of it to begin with.
 *
 * The fixed values in this file — the Linear team, the LangSmith project, the
 * Supabase origin, the Better Stack collections, the R2 bucket — are pins, not
 * defaults. Each of the underlying credentials is broader than the thing it is
 * pointed at (`LINEAR_API_KEY` reaches every team in the workspace), so the pin
 * IS the boundary. None of them may ever come from a caller, a model, or a
 * request.
 */

/* ------------------------------------------------------------------ scope -- */

/**
 * Where each field of the trust envelope comes from, and what a missing row
 * means. This table is the security contract of the whole task:
 *
 * | field                  | trusted source            | row missing            |
 * | ---------------------- | ------------------------- | ---------------------- |
 * | runId, origin, channel | RunDO `run_state`         | caller cannot build it |
 * | threadTs               | RunDO `run_state`         | (as above)             |
 * | turnId                 | persisted `agent_turn_id` | caller must supply     |
 * | shadow                 | D1 `runs` row             | REFUSE (fail closed)   |
 * | customerSlug           | D1 channel policy         | null (no customer)     |
 * | actor                  | null in Phase 10          | n/a                    |
 *
 * Two properties are worth stating separately, because both have already been
 * gotten wrong somewhere in this codebase's history:
 *
 *  - `shadow` is NOT on `RunState`. A check written against the run descriptor
 *    reads `undefined`, which is falsy, and an observing run posts to a real
 *    customer. It is a D1 read, and a missing `runs` row REFUSES rather than
 *    defaulting to `false` — an unconfirmable run is not a permitted one, and
 *    refusing here means the failure happens before any model or tool work.
 *
 *  - `customerSlug` comes from the channel policy, never from turn metadata,
 *    tool arguments, or model text. An unknown channel yields `null`, which
 *    makes customer-scoped reads refuse with `customer_scope_required` rather
 *    than silently widening. For Chat there is no channel at all, so it is
 *    `null` by construction and the customer arrives — if at all — through
 *    `memory.findCustomers`.
 *
 * `origin` deserves the same emphasis. It is read from `run_state`, which the
 * coordinator wrote from the run key when the session was created. A turn
 * claiming `origin: "chat"`, a tool argument claiming it, or a model asserting
 * it in prose all reach a different part of the system entirely and cannot
 * touch this field — which is what makes Chat-only discovery meaningful.
 */
export async function resolveCodeModeScope(
  db: D1Database,
  state: RunState,
  turnId: string,
): Promise<CodeModeScope> {
  const run = await getRunById(db, state.runId);
  if (run === null) {
    // Fail closed, and fail EARLY: before the prompt is built, before a
    // provider is called, before a single capability exists. The alternative is
    // discovering mid-answer that we cannot tell whether this run may act.
    throw new CapabilityError(
      "invalid_context",
      "this run could not be confirmed against the run index, so no work was started.",
    );
  }

  const policy: ChannelPolicy | null =
    state.channelId === null ? null : await getChannelPolicy(db, state.channelId);

  // `validateScope` rather than an object literal: it is strict at every level,
  // so a field this function forgets, mistypes, or accidentally widens is a
  // thrown `invalid_context` here rather than a surprise three layers down.
  return validateScope({
    runId: state.runId,
    turnId,
    origin: state.origin,
    shadow: run.shadow,
    customerSlug: policy?.customer_slug ?? null,
    slackThread:
      state.origin === "slack" && state.channelId !== null && state.threadTs !== null
        ? { channelId: state.channelId, threadTs: state.threadTs }
        : null,
    // Phase 12 resolves the on-duty engineer and their decrypted user token
    // together. Until then there is no identity, and `slack.reply` refuses with
    // `identity_unavailable` rather than speaking to a customer as a bot.
    actor: null,
  });
}

/* ----------------------------------------------------------- dependencies -- */

/**
 * Hide a class instance behind a closure that exposes only its methods.
 *
 * Every other port in this file is already a closure, so its credential is
 * genuinely unreachable through the object graph. `ZepMemory` is the one class:
 * `private client` is a TypeScript annotation, not a runtime boundary, so
 * `deps.memory.client._options.apiKey` reads a live key off the object the
 * capability layer holds. Model-authored code cannot get there — the isolate
 * only ever sees RPC stubs — but "a binding module cannot reach a credential"
 * is supposed to be a structural claim about this layer, and one enumerable
 * property was quietly making it a claim about discipline instead.
 *
 * Three named methods, nothing else. The instance survives only in this
 * closure's scope, which is the same shape every other adapter here already has.
 */
function closeOver(store: MemoryStore): MemoryStore {
  return {
    ensureGraph: (graphId) => store.ensureGraph(graphId),
    addMessage: (graphId, data) => store.addMessage(graphId, data),
    search: (graphId, query, limit) => store.search(graphId, query, limit),
  };
}

/**
 * Build the seven Phase 09 ports plus the clock and the D1 handle.
 *
 * Scope-dependent ports (Slack, Supabase) take the trust envelope so their
 * reads are pinned to this run; the rest are pinned by configuration. Nothing
 * here reads a request, a header, or a model argument.
 */
export function makeCapabilityDependencies(
  env: Env,
  scope: CodeModeScope,
  clock: () => number = () => Date.now(),
): CapabilityDependencies {
  return {
    db: env.DB,
    slack: makeSlackGateway(env.DB, scope),
    memory: closeOver(new ZepMemory(env.ZEP_API_KEY)),
    linear: makeLinearGateway({
      apiKey: env.LINEAR_API_KEY,
      teamId: env.LINEAR_TEAM_ID,
      teamName: env.LINEAR_TEAM_NAME,
    }),
    supabase: makeSupabaseReader(
      {
        url: env.SUPABASE_URL,
        key: env.SUPABASE_KEY,
        allowlist: PRODUCTION_ALLOWLIST,
      },
      scope,
    ),
    langsmith: makeLangSmithReader(
      {
        endpoint: env.LANGSMITH_ENDPOINT,
        apiKey: env.LANGSMITH_API_KEY,
        projectId: env.LANGSMITH_PROJECT_ID,
        projectName: env.LANGSMITH_PROJECT_NAME,
      },
      clock,
    ),
    betterstack: makeBetterStackReader(
      {
        sqlEndpoint: env.BETTERSTACK_SQL_ENDPOINT,
        sqlUsername: env.BETTERSTACK_SQL_USERNAME,
        sqlPassword: env.BETTERSTACK_SQL_PASSWORD,
        // Comma-separated in configuration so a reviewer sees the whole
        // allowlist in one line of the diff. The model never names one.
        logCollections: env.BETTERSTACK_LOG_SOURCE_IDS.split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0),
        uptimeToken: env.BETTERSTACK_UPTIME_TOKEN,
        uptimeEndpoint: BETTERSTACK_UPTIME_ENDPOINT,
      },
      clock,
    ),
    files: makeArtifactPublisher({
      bucket: env.ARTIFACTS,
      baseUrl: env.ARTIFACTS_BASE_URL,
    }),
    clock,
  };
}

/* -------------------------------------------------------------- the tool -- */

export type RunCodeToolInput = {
  env: Env;
  /** The RunDO's own `run_state` row. The only accepted source of run identity. */
  state: RunState;
  /** The persisted `agent_turn_id`, allocated before any provider I/O. */
  turnId: string;
  auditForExecution(context: CodeExecutionContext): CapabilityAuditSink;
  guard: AgentExecutionGuard;
  limits?: CodeModeLimits;
  clock?: () => number;
};

/**
 * The single production entry point: a `run_code` tool bound to one run.
 *
 * Returns exactly one `Tool`. The seven namespaces are NOT outer tools and
 * never appear in the model's tool map (invariant 5) — they exist only as RPC
 * capabilities inside the isolate, described once in this tool's description
 * (invariant 24).
 *
 * Awaited because scope resolution is two D1 reads, and both of them are
 * refusals waiting to happen. Doing them here rather than lazily inside the
 * first capability call is what makes "an unresolvable row fails closed before
 * model/tool work" true rather than aspirational.
 */
export async function makeRunCodeToolForRun(
  input: RunCodeToolInput,
): Promise<Tool<{ code: string }, CodeModeOutput>> {
  const clock = input.clock ?? (() => Date.now());
  const scope = await resolveCodeModeScope(input.env.DB, input.state, input.turnId);

  return makeRunCodeTool({
    scope,
    deps: makeCapabilityDependencies(input.env, scope, clock),
    limits: input.limits ?? PRODUCTION_LIMITS,
    auditForExecution: input.auditForExecution,
    guard: input.guard,
    loader: input.env.LOADER,
  });
}

/**
 * The model's entire tool map, for one run.
 *
 * A named helper rather than an inline literal at the Task 7 call site, so
 * "exactly one outer tool" has one home and one test rather than being a
 * property of whichever file assembles the `generateText` call.
 */
export async function makeAgentTools(
  input: RunCodeToolInput,
): Promise<{ run_code: Tool<{ code: string }, CodeModeOutput> }> {
  return { run_code: await makeRunCodeToolForRun(input) };
}
