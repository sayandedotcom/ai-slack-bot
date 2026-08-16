/**
 * D1 projection from the Think hooks.
 *
 * The agent's own SQLite is the system of record; D1 `runs` is a projection.
 * Invariant 32: apply a projection only when the sequence INCREASES, and never
 * let a D1 failure force another billed provider call.
 *
 * Both exported functions therefore have the same two-phase shape, in this
 * order and no other:
 *
 *   1. write the local row — synchronous DO SQLite, cannot fail on the network;
 *   2. attempt D1, and swallow its failure, leaving the local row marked
 *      un-projected for a later drain.
 *
 * A `throw` out of either one would come straight back through `onStepFinish`
 * into Think's turn, and the turn's recovery is another model call — which is
 * billed exactly like the first. So a D1 outage costs a stale dashboard row,
 * never a second charge.
 */

import { costNanoUsd, isPricedModel } from "../agent/cost";
import type { NormalizedUsage, StepUsageRecord } from "../agent/contracts";
import { normalizeUsage, projectStepUsageToD1 } from "../agent/usage";
import { getRunByKey, projectRunIndex, type RunRecord } from "./repository";
import type { RunStatus } from "./protocol";
import type { Env } from "../index";
import type { RunAgent } from "./agent";

/**
 * The only provider this chassis has. Task 8 pins Fable 5 through AI Gateway
 * and there is deliberately no direct-Anthropic fallback, so the column is a
 * constant rather than something read back out of a response the model shaped.
 */
const PROVIDER = "anthropic";

/** One projection attempt: where the run got to, and how far along. */
export type ProjectionInput = {
  /**
   * Monotonic per-run sequence. A value at or below the stored
   * `projection_seq` is dropped — out-of-order alarm deliveries are normal.
   */
  seq: number;
  status: RunStatus;
  /** Optional one-line summary for the dashboard's run list. */
  summary?: string;
};

/** One step's billed usage, as the provider reported it. */
export type UsageInput = {
  /**
   * Unique identity for this step, so the D1 insert is idempotent under a
   * retried alarm (`INSERT OR IGNORE` on the step key).
   */
  stepId: string;
  /** The model id that was billed. A name, never a credential. */
  model: string;
  /**
   * The RAW provider usage bag. Deliberately `unknown`: it goes through
   * `normalizeUsage` from `src/agent/usage.ts` rather than being trusted to
   * hold a shape this module would have to keep in sync with the SDK.
   */
  usage: unknown;
};

/* ------------------------------------------------------------- local rows -- */

/**
 * One DDL pass per live instance. `CREATE TABLE IF NOT EXISTS` is idempotent,
 * but it is still a write, and `onStepFinish` runs on every step of every turn.
 *
 * Keyed on the instance and not on a module boolean: a hibernated object comes
 * back as a new instance against the same storage, and the DDL must run again
 * for it while a second run's object in the same isolate gets its own.
 */
const SCHEMA_READY = new WeakSet<RunAgent>();

function ensureProjectionSchema(agent: RunAgent): void {
  if (SCHEMA_READY.has(agent)) return;

  // The local record of "the run reached this state at this sequence". `seq` is
  // the primary key so a redelivered alarm rewrites its own row instead of
  // growing the table, and `d1_applied` names the rows a drain still owes D1.
  agent.sql`
    CREATE TABLE IF NOT EXISTS run_projection_steps (
      seq         INTEGER PRIMARY KEY,
      status      TEXT NOT NULL,
      summary     TEXT,
      recorded_at INTEGER NOT NULL,
      d1_applied  INTEGER NOT NULL DEFAULT 0
    )
  `;

  // The local record that money was spent. This is the authoritative one —
  // `agent_model_calls` in D1 is its queryable projection and is allowed to lag.
  // Ids, counts, cost and a safe error code only: there is nowhere here to put a
  // prompt, a completion or a credential (invariants 18 and 39).
  agent.sql`
    CREATE TABLE IF NOT EXISTS run_step_usage (
      id                 TEXT PRIMARY KEY,
      step_id            TEXT NOT NULL,
      model              TEXT NOT NULL,
      provider           TEXT NOT NULL,
      input_tokens       INTEGER NOT NULL,
      no_cache_tokens    INTEGER NOT NULL,
      cache_read_tokens  INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      output_tokens      INTEGER NOT NULL,
      reasoning_tokens   INTEGER NOT NULL,
      total_tokens       INTEGER NOT NULL,
      cost_nano_usd      INTEGER NOT NULL,
      error_code         TEXT,
      created_at         INTEGER NOT NULL,
      d1_projected_at    INTEGER
    )
  `;

  SCHEMA_READY.add(agent);
}

/**
 * The run index binding, off an agent whose `env` is `protected`.
 *
 * `DurableObject.env` is protected and `RunAgent` deliberately does not widen
 * it — Wave B fills stub bodies and never edits `src/run/agent.ts`. The cast
 * names the ONE binding this module reads rather than widening the agent to
 * `any`, so a rename of `DB` still fails the compiler here.
 */
function runIndexDb(agent: RunAgent): D1Database {
  return (agent as unknown as { env: Env }).env.DB;
}

/**
 * The D1 `runs` row this Durable Object is the session for.
 *
 * Resolved through the run KEY, which is this object's name, because the public
 * `runs.id` is a separate UUID for a Slack run and string-building one from the
 * key would name a row that does not exist. A missing row is not an error: the
 * agent owns the session, and its work must not fail because the index lags or
 * because a test drove the object without seeding one.
 */
async function resolveRun(db: D1Database, key: string): Promise<RunRecord | null> {
  try {
    return await getRunByKey(db, key);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- projection -- */

/** Advance the D1 `runs` projection for this run, if the sequence increased. */
export async function projectTurn(agent: RunAgent, input: ProjectionInput): Promise<void> {
  ensureProjectionSchema(agent);

  const seq = Math.trunc(input.seq);
  const summary = input.summary ?? null;
  const recordedAt = Date.now();

  // LOCAL FIRST. Invariant 32 — this line is the enforcement point, and the
  // D1 call below is deliberately everything that comes after it.
  agent.sql`
    INSERT INTO run_projection_steps (seq, status, summary, recorded_at, d1_applied)
    VALUES (${seq}, ${input.status}, ${summary}, ${recordedAt}, 0)
    ON CONFLICT(seq) DO UPDATE SET
      status      = excluded.status,
      summary     = excluded.summary,
      recorded_at = excluded.recorded_at
  `;

  const db = runIndexDb(agent);
  const run = await resolveRun(db, agent.name);
  if (!run) return;

  try {
    const { applied } = await projectRunIndex(db, run.id, seq, {
      status: input.status,
      // `projectRunIndex` writes status, summary and recency TOGETHER, so a
      // caller with no summary must re-send the stored one. Passing `null`
      // would erase the dashboard's summary on every step of every turn, which
      // is exactly the kind of wrong-but-plausible write that throws nothing.
      summary: input.summary ?? run.summary,
      updatedAt: recordedAt,
    });
    if (applied) {
      agent.sql`UPDATE run_projection_steps SET d1_applied = 1 WHERE seq = ${seq}`;
    }
  } catch {
    // Deliberately swallowed, and deliberately not logged with the error's own
    // text: the local row stays `d1_applied = 0`, which is the durable record
    // that D1 still owes this revision. See the header — throwing here buys a
    // second billed model call and nothing else.
  }
}

/* ------------------------------------------------------------------ usage -- */

/**
 * Flatten the AI SDK's usage bag into the shape `normalizeUsage` reads.
 *
 * `ai@7`'s `LanguageModelUsage` is flat at the top (`inputTokens`,
 * `outputTokens`, `totalTokens`) but nests the classes that are priced
 * differently inside `inputTokenDetails` / `outputTokenDetails`. Handing the
 * bag over unflattened normalizes every cache class to zero, and
 * `costNanoUsd` then charges those tokens as unclassified input at the full
 * input rate — a bill that is wrong by up to 10x with nothing thrown anywhere.
 *
 * The detail keys (`noCacheTokens`, `cacheReadTokens`, `cacheWriteTokens`,
 * `reasoningTokens`) do not collide with the top-level ones, so the merge is
 * unambiguous, and a provider that reports the flat shape already passes
 * through untouched.
 */
function flattenUsage(raw: unknown): Record<string, unknown> {
  const bag = asBag(raw);
  return { ...bag, ...asBag(bag.inputTokenDetails), ...asBag(bag.outputTokenDetails) };
}

function asBag(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * What one step cost, in integer nano-USD (invariant 29).
 *
 * The rate table and the counting rule both live in `src/agent/cost.ts` and are
 * not restated here. An unpriced model records zero with a named error code
 * rather than throwing: losing the token counts would lose the only local
 * record that the provider was called at all, and inventing a rate would report
 * a confident number that is wrong by an unknown factor.
 */
function priceStep(
  model: string,
  usage: NormalizedUsage,
): { costNanoUsd: number; errorCode: string | null } {
  if (!isPricedModel(model)) return { costNanoUsd: 0, errorCode: "unknown_model_price" };
  const { totalNanoUsd } = costNanoUsd({ modelId: model, usage });
  // Integer by construction — every rate and every count is an integer — and
  // clamped anyway, because both columns are `INTEGER NOT NULL CHECK (>= 0)`
  // and a float here would be stored as one.
  return { costNanoUsd: Math.max(0, Math.trunc(totalNanoUsd)), errorCode: null };
}

/** Record one step's tokens and cost, in integer nano-USD. */
export async function recordUsage(agent: RunAgent, input: UsageInput): Promise<void> {
  ensureProjectionSchema(agent);

  const usage = normalizeUsage(flattenUsage(input.usage));
  const { costNanoUsd: cost, errorCode } = priceStep(input.model, usage);
  const id = `usage:${input.stepId}`;
  const createdAt = Date.now();

  // LOCAL FIRST, same reason as `projectTurn`. `INSERT OR IGNORE` on the step
  // key so a retried alarm cannot bill the same step twice.
  agent.sql`
    INSERT OR IGNORE INTO run_step_usage
      (id, step_id, model, provider, input_tokens, no_cache_tokens, cache_read_tokens,
       cache_write_tokens, output_tokens, reasoning_tokens, total_tokens, cost_nano_usd,
       error_code, created_at, d1_projected_at)
    VALUES
      (${id}, ${input.stepId}, ${input.model}, ${PROVIDER}, ${usage.inputTokens},
       ${usage.noCacheTokens}, ${usage.cacheReadTokens}, ${usage.cacheWriteTokens},
       ${usage.outputTokens}, ${usage.reasoningTokens}, ${usage.totalTokens}, ${cost},
       ${errorCode}, ${createdAt}, NULL)
  `;

  const db = runIndexDb(agent);
  const run = await resolveRun(db, agent.name);
  if (!run) return;

  const record: StepUsageRecord = {
    id,
    // Think has no generation/attempt/step-index numbering of its own: the
    // provider response id IS the step's identity here, and the retry the
    // legacy chassis counted is Think's, not ours to number.
    // TODO(Task 8): the turn's real id, from the Think session's turn record.
    generationId: input.stepId,
    agentTurnId: input.stepId,
    attempt: 0,
    globalStep: 0,
    provider: PROVIDER,
    model: input.model,
    providerRequestId: null,
    gatewayLogId: null,
    usage,
    costNanoUsd: cost,
    latencyMs: 0,
    finishReason: null,
    rawFinishReason: null,
    errorCode,
    d1ProjectedAt: null,
    createdAt,
  };

  try {
    // The one INSERT statement for `agent_model_calls`, reused rather than
    // restated — a second copy of that column list is a schema change waiting
    // to be applied to only one of them.
    await projectStepUsageToD1(db, run.id, record);
    agent.sql`UPDATE run_step_usage SET d1_projected_at = ${Date.now()} WHERE id = ${id}`;
  } catch {
    // Same contract as above: the local row keeps `d1_projected_at = NULL` and
    // the money stays recorded where it was recorded first.
  }
}
