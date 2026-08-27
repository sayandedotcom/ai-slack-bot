/**
 * The fixed rules of the run chassis, as values.
 *
 * Everything here is decided before a run exists and cannot vary with one: the
 * single tool's name, the tool allowance, the two bounds, the shape of durable
 * state, and the two invariants that are enforced as functions rather than as
 * prose. Nothing in this module reads `env`, D1, or a live agent — which is
 * what lets the invariant guards be asserted directly by a test.
 *
 * `RunAgent` is the only production consumer; it re-states none of this.
 */
import type { TurnConfig } from "@cloudflare/think";

import type { RunChannelId } from "./agent-channels";
import type { RunStatus } from "./protocol";

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
