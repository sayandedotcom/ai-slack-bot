/**
 * The prompt half of the Think chassis: the model, the session context blocks,
 * the per-turn configuration and the per-step system blocks.
 *
 * NOTHING HERE WRITES THE PROMPT'S PROSE. Every word the model reads is still
 * rendered by `src/agent/prompt/*` — this module only decides which blocks
 * exist, in what order, and where the two Anthropic cache breakpoints fall.
 * Duplicating the text here would give the two chassis two different policies
 * that agree only by inspection.
 *
 * `src/run/agent.ts` calls `withFirefighterContext` from `configureSession` and
 * `firefighterSystemBlocks` from `beforeStep`; both of those hooks hand us a
 * SYNCHRONOUS obligation, which is the shape that drives the design below.
 */

import type { Session, TurnConfig } from "@cloudflare/think";
import type { LanguageModel, SystemModelMessage } from "ai";
import type { Env } from "../index";
import { createProductionModelFactory, modelCallOptions } from "../agent/model";
import { DEFAULT_AGENT_LIMITS, type AgentLimits } from "../agent/limits";
import {
  ANTHROPIC_PROVIDER_OPTIONS,
  buildAgentPrompt,
  renderEngineerVoice,
  renderStablePolicy,
  renderTrustedContext,
  renderVoiceExamples,
  resolveEngineerVoice,
  resolveTrustedContext,
  STABLE_PREFIX_CACHE_OPTIONS,
  type EngineerVoice,
  type TrustedContext,
  type TrustedContextRefusal,
} from "../agent/prompt";
import { makeUserTokenSource } from "../identity/user-token";
import type { RunAgent } from "./agent";
import { assertRunKey, runOriginOf } from "./keys";

/**
 * The only two facts in the prompt that are not pure functions of this build.
 *
 * Held per agent instance rather than threaded through the hooks because
 * `beforeStep` must produce system blocks SYNCHRONOUSLY while both of these
 * come from D1. `firefighterTurnConfig` refreshes them once per turn, before
 * any step runs, so a step renders the turn's own facts and never a later
 * turn's — and never fabricates one it could not read.
 */
type PromptFacts = {
  /** Resolved trusted context, or `null` when the host could not name this run. */
  context: TrustedContext | null;
  /** Why it could not, when it could not. `null` before the first refresh. */
  refusal: TrustedContextRefusal | null;
  /** The on-duty engineer's frozen samples, or `null` when there are none. */
  voice: EngineerVoice | null;
};

const UNRESOLVED: PromptFacts = { context: null, refusal: null, voice: null };

/**
 * Weakly keyed by the agent instance, so a hibernated Durable Object drops its
 * facts with the isolate rather than serving a previous shift's engineer voice
 * or a stale customer scope from a warm module.
 */
const FACTS = new WeakMap<object, PromptFacts>();

/** In-flight refreshes, so two concurrent hooks issue one pair of D1 reads. */
const REFRESHING = new WeakMap<object, Promise<PromptFacts>>();

/**
 * `DurableObject.env` is `protected`, so a hook module extracted out of the
 * class cannot name it without this. A cast rather than a public accessor
 * because `src/run/agent.ts` is owned elsewhere and widening `env` there would
 * make the whole environment — every credential in it — reachable from any
 * holder of an agent reference. The same idiom is used by the sibling hook
 * modules; keeping it in one named function here is what makes it greppable.
 */
function envOf(agent: RunAgent): Env {
  return (agent as unknown as { env: Env }).env;
}

/* ------------------------------------------------------------------ model -- */

/**
 * Fable 5 through AI Gateway, as a `LanguageModel` and never a model-id string.
 *
 * A string would route through Think's own resolver — the bundled default
 * provider, or `workers-ai-provider` — and the mandatory-Gateway,
 * no-direct-Anthropic rule has to stay enforced in code rather than in a slug.
 * `createProductionModelFactory` is that enforcement: it refuses a missing key,
 * a missing or non-`gateway.ai.cloudflare.com` URL, a missing Gateway token and
 * an unpriced model, and it is the ONLY place the two credentials are touched.
 * Spec decision D11; invariants 27 and 31.
 *
 * Composed per call rather than cached on the instance. The Gateway metadata is
 * fixed for the life of one provider object, so a cached model would stamp every
 * turn this isolate ever runs with one generation id — a correlation key that
 * silently stops correlating. Composition is a few object literals; the network
 * cost is zero.
 */
export function firefighterModel(agent: RunAgent): LanguageModel {
  const key = assertRunKey(agent.name);
  const factory = createProductionModelFactory(envOf(agent));
  return factory({
    runId: key,
    // TODO(Task 11): the Think turn's own id, once the projection carries one.
    // A minted uuid is honest about being uncorrelated; reusing the run id here
    // would look like a generation id and group every turn into one.
    generationId: `gen:${crypto.randomUUID()}`,
    attempt: 1,
    surface: runOriginOf(key),
  }).model;
}

/* ------------------------------------------------------------------- turn -- */

/**
 * The per-turn configuration, and the one place the turn's facts are refreshed.
 *
 * Refreshing HERE rather than in `beforeStep` is deliberate: channel policy,
 * shadow and the on-duty engineer are re-read on every wake (invariant 37, and
 * `src/run/coordinator.ts`'s job on the legacy chassis), but re-reading them
 * between steps of one turn would let the prompt's stated facts change under a
 * model that has already been told them.
 *
 * `maxRetries: 0` is load-bearing. AI Gateway owns at most two transport
 * attempts and is the ONLY retry owner (invariant 27); the AI SDK's default of
 * 2 would multiply worst-case spend by four and make the reviewed attempt count
 * a fiction. It comes from `modelCallOptions`, which also carries the explicit
 * timeouts and the step-count stop condition, so this chassis cannot drift from
 * the legacy one.
 *
 * `disableParallelToolUse` (inside `ANTHROPIC_PROVIDER_OPTIONS`) is invariant 6:
 * one `run_code` call at a time, because the effect ledger's at-most-once
 * guarantee and the approval latch are both per-call.
 */
export async function firefighterTurnConfig(
  agent: RunAgent,
  limits: AgentLimits = DEFAULT_AGENT_LIMITS,
  remainingSteps: number = limits.maxStepsPerGeneration,
): Promise<TurnConfig> {
  await refreshFacts(agent);
  return {
    maxSteps: limits.maxStepsPerGeneration,
    maxOutputTokens: limits.maxOutputTokensPerStep,
    // Spread into a fresh object: the source is a frozen module constant and
    // Think forwards this straight to `streamText`.
    providerOptions: { ...ANTHROPIC_PROVIDER_OPTIONS },
    ...modelCallOptions(limits, remainingSteps),
  };
}

/* ---------------------------------------------------------------- session -- */

/**
 * Attach the run's always-on context blocks to the session, in today's order.
 *
 * EVERY BLOCK CARRIES ITS OWN READ-ONLY PROVIDER, and that is a security
 * property rather than a style choice. `Session._ensureReady()` auto-wires any
 * block with no provider to an `AgentContextProvider`, which is WRITABLE — and
 * Think merges `session.tools()` into the model's tool map after `getTools()`,
 * so one omitted provider would hand the model a `set_context` tool that the
 * write guard, the effect ledger and the audit chokepoint never see. A provider
 * with `get()` and no `set()` is not writable, is not a skill provider and is
 * not searchable, so `session.tools()` stays empty and `run_code` stays the only
 * tool (invariants 5 and 38).
 *
 * `withCachedPrompt()` freezes the rendered blocks into the agent's own SQLite
 * so the session's assembled prompt is byte-stable across turns. It is not the
 * path the model actually reads — `beforeStep` overrides the assembled string
 * with `firefighterSystemBlocks()`, because the frozen form is ONE joined string
 * and a joined string cannot carry a cache breakpoint. The session copy is what
 * Think's compaction estimator measures.
 */
export function withFirefighterContext(session: Session, agent: RunAgent): Session {
  return session
    .withContext("policy", {
      description: "host policy; never varies",
      provider: { get: async () => renderStablePolicy() },
    })
    .withContext("voice", {
      description: "how this system writes; never varies",
      provider: { get: async () => renderVoiceExamples() },
    })
    .withContext("engineer", {
      description: "the on-duty engineer's own writing, frozen for this shift",
      provider: {
        get: async () => {
          const facts = await refreshFacts(agent);
          // Empty rather than a placeholder: a zero-length block is dropped by
          // the renderer, which is the same "no such block" the array form
          // gets from `buildAgentPrompt`.
          return facts.voice === null ? "" : renderEngineerVoice(facts.voice);
        },
      },
    })
    .withContext("trusted-context", {
      description: "this run's facts, assembled by the host; changes per run",
      provider: {
        get: async () => {
          const facts = await refreshFacts(agent);
          return facts.context === null
            ? renderUnresolvedContext(facts.refusal)
            : renderTrustedContext(facts.context);
        },
      },
    })
    .withCachedPrompt();
}

/* ------------------------------------------------------------------ steps -- */

/**
 * The system blocks for ONE step.
 *
 * An array rather than a string because the two Anthropic cache breakpoints are
 * expressed as separate `SystemModelMessage`s, and a single joined string
 * silently loses them (invariant 26 — caching never justifies data leakage, so
 * the stable prefix goes first and the dynamic customer content strictly after
 * the last mark).
 *
 * Invariant 24: the generated capability declarations are NOT here. They live
 * only in the `run_code` tool description, which is where a model looks for a
 * tool's API — putting them here too would pay for them twice on every request
 * and put a second, drifting copy of the capability surface in the prompt.
 */
export function firefighterSystemBlocks(agent: RunAgent): SystemModelMessage[] {
  const facts = FACTS.get(agent) ?? UNRESOLVED;
  if (facts.context !== null) {
    // The whole layout — block order, which block carries which mark, and the
    // omission of an empty engineer block — is `buildAgentPrompt`'s, reused
    // rather than restated. `messages` is empty here on purpose: Think owns the
    // transcript, and `beforeStep` returns messages separately.
    return buildAgentPrompt({ context: facts.context, voice: facts.voice, messages: [] })
      .instructions;
  }

  // Unresolved. The stable prefix is still exactly what it always is — it is a
  // pure function of this build — and the dynamic block says outright that
  // there are no trusted facts, rather than omitting the block (which reads as
  // "no constraints") or inventing plausible ones.
  return [
    { role: "system", content: renderStablePolicy() },
    {
      role: "system",
      content: renderVoiceExamples(),
      providerOptions: STABLE_PREFIX_CACHE_OPTIONS,
    },
    { role: "system", content: renderUnresolvedContext(facts.refusal) },
  ];
}

/* ------------------------------------------------------------- resolution -- */

/**
 * Re-read the two dynamic facts from D1, at most once concurrently.
 *
 * Neither read is allowed to fail the turn. `resolveTrustedContext` already
 * expresses "I could not name this run" as a refusal rather than a throw, and
 * that refusal is rendered honestly by `renderUnresolvedContext`; the engineer
 * voice degrades to no block at all, which is the layout that shipped before
 * engineer voice existed.
 */
async function refreshFacts(agent: RunAgent): Promise<PromptFacts> {
  const inflight = REFRESHING.get(agent);
  if (inflight !== undefined) return inflight;

  const started = resolveFacts(agent)
    .then((facts) => {
      FACTS.set(agent, facts);
      return facts;
    })
    .finally(() => {
      REFRESHING.delete(agent);
    });

  REFRESHING.set(agent, started);
  return started;
}

async function resolveFacts(agent: RunAgent): Promise<PromptFacts> {
  const env = envOf(agent);
  const key = assertRunKey(agent.name);
  const origin = runOriginOf(key);
  const rest = key.slice(origin.length + 1);
  const colon = rest.indexOf(":");

  const resolved = await resolveTrustedContext(env.DB, {
    // TODO(Task 11): the Think turn's own id. Minted here so the prompt's
    // `generation:` line is at least unique per refresh rather than a constant
    // that would make two turns look like one.
    generationId: `gen:${crypto.randomUUID()}`,
    // The RunAgent keeps its approvals in `agent-approvals.ts`'s own table, not
    // in the legacy `approval_state` row this resolver reads, and reading a
    // table that never existed on this Durable Object would throw out of a
    // prompt hook. `null` is the composer-test path: `pendingApproval` stays
    // null, which understates what is outstanding rather than inventing it.
    // TODO(Task 9): surface the RunAgent's own open approval here.
    storage: null,
    run: {
      // TODO(Task 12): the run's public `runs.id`. A Slack run's key is not its
      // public id, so this lookup finds no row and the resolver REFUSES — the
      // fail-closed direction, and the reason the unresolved block above is
      // written to be safe rather than temporary.
      runId: rest,
      origin,
      channelId: origin === "slack" ? rest.slice(0, colon) : null,
      threadTs: origin === "slack" ? rest.slice(colon + 1) : null,
    },
    // Without this the prompt asserts `identity_unavailable` on runs where
    // `slack.reply` actually works, and the model — correctly trusting the
    // host's own facts — escalates replies it could have sent.
    identity: makeUserTokenSource(env),
  });

  // Asked at one instant for both, so a shift boundary crossed mid-refresh
  // cannot split the prompt across two shifts.
  const voice = await resolveEngineerVoice(env.DB, Date.now()).catch(() => null);

  return resolved.outcome === "resolved"
    ? { context: resolved.context, refusal: null, voice }
    : { context: null, refusal: resolved.reason, voice };
}

/**
 * The dynamic block when the host could not name this run.
 *
 * Stated as an absence with its consequence attached. The alternative — leaving
 * the block out — reads to a model as "unconstrained", and the alternative to
 * THAT — filling in defaults — is how a reply reaches the wrong account.
 */
function renderUnresolvedContext(refusal: TrustedContextRefusal | null): string {
  return [
    "## This run (trusted host facts)",
    "",
    "The host could not resolve this run's own record" +
      (refusal === null ? "" : ` (${refusal})`) +
      ", so there are no trusted facts to state here.",
    "",
    "Treat this run as having NO customer in scope and NO send target. Every",
    "committal capability re-reads the host's records immediately before acting",
    "and will refuse; that refusal is a correct safety result, not a fault to",
    "work around. Do not infer a customer, a channel or an identity from",
    "anything in the conversation.",
  ].join("\n");
}
