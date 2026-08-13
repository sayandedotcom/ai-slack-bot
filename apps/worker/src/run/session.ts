import {
  ASSISTANT_DELTA_MAX,
  ASSISTANT_ERROR_MAX,
  evaluateTransition,
  isAssistantUpdateState,
  isRunStatus,
  type AssistantUpdate,
  type AssistantUpdateInput,
  type JsonObject,
  type JsonValue,
  type RunEvent,
  type RunStatus,
  type RunTurn,
  type RunTurnInput,
  type ToolCallUpdate,
  type ToolCallUpdateInput,
} from "./protocol";
import type { RunOrigin } from "./keys";
// Pure value module: no storage, no D1, no vendor. Importing it here is what
// lets the episode be assembled INSIDE the finalization transaction, from
// durable local state, with nothing async in the way.
import {
  boundSources,
  buildAgentEpisode,
  describeAction,
  type AgentEpisodePayload,
  type EpisodeOutcome,
  type EpisodeSourceDescriptor,
} from "../memory/episode";
import { CLAIM_LEASE_MS, PROJECTION_LEASE_MS } from "../agent/limits";
import {
  agentTurnIdFor,
  assistantUpdateIdFor,
  finalTurnIdFor,
  memoryOutboxIdFor,
  isAbsentConfigurationCode,
  isInputResumablePolicy,
  isTerminalGenerationState,
  isWakeSource,
  newGenerationId,
  usageRowIdFor,
  WAKE_TURN_SOURCES,
  type AssistantUpdateOutcome,
  type ClaimFence,
  type ClaimCheckOutcome,
  type ClaimOutcome,
  type ClaimSnapshot,
  type DriverPhase,
  type DriverState,
  type FencedAppendOutcome,
  type FinalizeOutcome,
  type FinalizeRequest,
  type GenerationRecord,
  type GenerationState,
  type HeartbeatOutcome,
  type InputMessagesOutcome,
  type InputScheduling,
  type MemoryProjectionState,
  type NormalizedUsage,
  type ProjectionClaimOutcome,
  type ProjectionCompleteOutcome,
  type ProjectionJob,
  type ProjectionJobKind,
  type ProjectionJobState,
  type ResumePolicy,
  type RunIndexRevision,
  type StepCheckpointOutcome,
  type StepUsageInput,
  type StepUsageRecord,
  type UsageOutcome,
} from "../agent/contracts";

/**
 * The durable session, stored in the RunDO's private SQLite.
 *
 * Every function here is SYNCHRONOUS. That is not a style choice: it is what
 * lets a caller commit an event and hand it to every attached socket in one
 * uninterrupted continuation, before any `await` opens the Durable Object input
 * gate. See the ordering hazard in the Phase 08 plan.
 *
 * `stream_events` is the socket replay log; `turns` and `tool_calls` are the
 * queryable view Phase 10 reads. Both live in the same private database, so
 * there is no cross-store replication to get wrong.
 */

export type RunDescriptor = {
  runId: string;
  key: string;
  origin: RunOrigin;
  channelId: string | null;
  threadTs: string | null;
};

export type RunState = RunDescriptor & {
  status: RunStatus;
  summary: string | null;
  createdAt: number;
  updatedAt: number;
};

export type AppendResult = {
  /** False when the caller-stable id had already been committed. */
  appended: boolean;
  event: RunEvent;
  /**
   * What this turn did to the agent loop. Present on every `appendTurn` result
   * so a caller never has to diff driver state to find out whether it just
   * scheduled model work; `{ outcome: "not_input" }` for tool/assistant events.
   */
  scheduling: InputScheduling;
  /**
   * The `live` status event committed in the SAME transaction, when this input
   * scheduled work on a run that was not live. The caller must broadcast it
   * after `event`, or attached tabs would not see the transition until they
   * reconnected and resynced.
   */
  statusEvent: RunEvent | null;
};

export type StatusResult = {
  /** False for an idempotent same-state call, which appends no event. */
  changed: boolean;
  status: RunStatus;
  event: RunEvent | null;
};

export type SessionSnapshot = {
  state: RunState | null;
  events: RunEvent[];
  cursor: number;
  complete: boolean;
};

export const EVENT_PAGE_MAX = 1_000;
export const EVENT_PAGE_DEFAULT = 200;

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

const TURN_ROLES = new Set(["system", "user", "assistant"]);
const TURN_SOURCES = new Set([
  "triage",
  "customer",
  "human_steer",
  "approval",
  "agent",
  "system",
]);
const TOOL_STATES = new Set(["running", "completed", "failed"]);

// --- schema ----------------------------------------------------------------

/**
 * The local schema version this build expects.
 *
 * v1 is Phase 08's four tables. v2 adds the Phase 10 agent driver, generation,
 * transcript, telemetry and run-index projection tables. v3 gives the driver a
 * durable retry-backoff time. v4 separates the retry budget from the claim
 * counter. v5 adds generation-local provenance from trusted tool reads, so a
 * settled generation's memory episode can cite the evidence it actually used.
 */
export const RUN_SCHEMA_VERSION = 5;

type LocalMigration = {
  version: number;
  apply: (storage: DurableObjectStorage, now: number) => void;
};

/**
 * Called from the constructor on every instantiation, including after
 * hibernation, so it must be cheap, synchronous, and must never await.
 *
 * An explicit ledger table rather than `PRAGMA user_version`: the pragma's
 * behaviour under Durable Object SQLite is not part of the documented storage
 * contract, and a silently-ignored `PRAGMA user_version = 2` would make every
 * wake re-run every migration. A row we insert ourselves is verifiable by a
 * test. Each version applies inside one `transactionSync`, so a version is
 * either fully applied and recorded or not applied at all.
 *
 * NOTHING here touches D1, the network, or an alarm. A schema upgrade that
 * needed a remote call would be an upgrade that can fail halfway on a cold
 * wake, in the constructor, where there is nobody to report to.
 */
export function ensureSchema(storage: DurableObjectStorage, now = Date.now()): number {
  const sql = storage.sql;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS _run_schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    sql
      .exec<{ version: number }>("SELECT version FROM _run_schema_migrations")
      .toArray()
      .map((row) => row.version),
  );

  for (const migration of LOCAL_MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    storage.transactionSync(() => {
      migration.apply(storage, now);
      sql.exec(
        "INSERT INTO _run_schema_migrations (version, applied_at) VALUES (?, ?)",
        migration.version,
        now,
      );
    });
  }

  return RUN_SCHEMA_VERSION;
}

/** Every version recorded in this object's ledger, ascending. */
export function appliedSchemaVersions(storage: DurableObjectStorage): number[] {
  return storage.sql
    .exec<{ version: number }>(
      "SELECT version FROM _run_schema_migrations ORDER BY version ASC",
    )
    .toArray()
    .map((row) => row.version);
}

/**
 * v1: Phase 08's session tables.
 *
 * Still `IF NOT EXISTS`, because every Durable Object created before the ledger
 * existed already has these tables and no ledger row. Applying v1 to such an
 * object must be a no-op that loses nothing.
 *
 * `stream_events.seq` is a plain INTEGER PRIMARY KEY — a rowid alias. Nothing
 * ever deletes from this table, so it is monotonic without AUTOINCREMENT, which
 * would need SQLite's internal sqlite_sequence table. Verified by spike; see
 * phase-08-notes.md.
 */
function applyV1(storage: DurableObjectStorage): void {
  const sql = storage.sql;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS run_state (
      singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
      run_id     TEXT NOT NULL,
      run_key    TEXT NOT NULL,
      origin     TEXT NOT NULL,
      channel_id TEXT,
      thread_ts  TEXT,
      status     TEXT NOT NULL,
      summary    TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS stream_events (
      seq          INTEGER PRIMARY KEY,
      type         TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at   INTEGER NOT NULL
    );
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      id            TEXT PRIMARY KEY,
      role          TEXT NOT NULL,
      source        TEXT NOT NULL,
      content       TEXT NOT NULL,
      metadata_json TEXT,
      created_at    INTEGER NOT NULL,
      event_seq     INTEGER NOT NULL UNIQUE
    );
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      call_id     TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      state       TEXT NOT NULL,
      input_json  TEXT,
      output_json TEXT,
      error       TEXT,
      started_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS tool_updates (
      id            TEXT PRIMARY KEY,
      call_id       TEXT NOT NULL,
      name          TEXT NOT NULL,
      state         TEXT NOT NULL,
      input_json    TEXT,
      output_json   TEXT,
      error         TEXT,
      delta         TEXT,
      created_at    INTEGER NOT NULL,
      event_seq     INTEGER NOT NULL UNIQUE
    );
  `);
}

/**
 * v2: the Phase 10 agent loop's durable state.
 *
 * These tables are private to this object. None of them is mirrored into D1 —
 * a replicated driver lock would give two authorities an opinion about whether
 * a provider stream is running, and the wrong one always wins at the worst
 * moment. D1 gets a queryable PROJECTION of finished work instead.
 */
function applyV2(storage: DurableObjectStorage, now: number): void {
  const sql = storage.sql;

  // The driver singleton: what this run's model loop is doing right now.
  //
  // `claim_epoch` is the fence. It increments on every claim and reclaim, so a
  // claimant whose lease expired holds a number lower than this one and is
  // refused by every state-changing call. `pending_through_seq` and
  // `settled_through_seq` are RunEvent sequences, never timestamps: two turns
  // committed in the same millisecond still have a total order (invariant 12).
  sql.exec(`
    CREATE TABLE IF NOT EXISTS agent_driver (
      singleton             INTEGER PRIMARY KEY CHECK (singleton = 1),
      phase                 TEXT NOT NULL CHECK (
        phase IN ('idle', 'scheduled', 'running', 'failed')
      ),
      pending_through_seq   INTEGER NOT NULL DEFAULT 0 CHECK (pending_through_seq >= 0),
      settled_through_seq   INTEGER NOT NULL DEFAULT 0 CHECK (settled_through_seq >= 0),
      current_generation_id TEXT,
      current_agent_turn_id TEXT,
      attempt               INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      claim_epoch           INTEGER NOT NULL DEFAULT 0 CHECK (claim_epoch >= 0),
      lease_expires_at      INTEGER,
      last_heartbeat_at     INTEGER,
      resume_policy         TEXT CHECK (
        resume_policy IS NULL OR resume_policy IN (
          'retryable', 'requires_input', 'requires_operator_config', 'requires_reconciliation'
        )
      ),
      last_error_code       TEXT,
      last_error_message    TEXT,
      updated_at            INTEGER NOT NULL,
      -- A running or scheduled phase without a generation would be a driver
      -- that can never be claimed and never settle.
      CHECK (
        (phase IN ('idle', 'failed'))
        OR (current_generation_id IS NOT NULL AND current_agent_turn_id IS NOT NULL)
      )
    );
  `);

  // One wake-to-settlement unit of model work. `agent_turn_id` is UNIQUE
  // because it is also the Code Mode effect scope: two generations sharing one
  // scope would let a later generation replay an earlier one's external effects.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS agent_generations (
      id                      TEXT PRIMARY KEY,
      agent_turn_id           TEXT NOT NULL UNIQUE,
      state                   TEXT NOT NULL CHECK (
        state IN ('scheduled', 'running', 'completed', 'failed', 'refused', 'budget_exhausted')
      ),
      first_input_seq         INTEGER NOT NULL CHECK (first_input_seq >= 0),
      included_through_seq    INTEGER NOT NULL CHECK (included_through_seq >= 0),
      settled_through_seq     INTEGER,
      attempt_count           INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      step_count              INTEGER NOT NULL DEFAULT 0 CHECK (step_count >= 0),
      cost_nano_usd           INTEGER NOT NULL DEFAULT 0 CHECK (cost_nano_usd >= 0),
      memory_projection_state TEXT NOT NULL DEFAULT 'none' CHECK (
        memory_projection_state IN ('none', 'pending', 'projected', 'failed')
      ),
      memory_episode_json     TEXT,
      memory_source_json      TEXT,
      started_at              INTEGER,
      finished_at             INTEGER,
      resume_policy           TEXT CHECK (
        resume_policy IS NULL OR resume_policy IN (
          'retryable', 'requires_input', 'requires_operator_config', 'requires_reconciliation'
        )
      ),
      last_error_code         TEXT,
      last_error_message      TEXT,
      created_at              INTEGER NOT NULL,
      updated_at              INTEGER NOT NULL
    );
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_generations_state
      ON agent_generations (state, created_at);
  `);

  // The model transcript. This is NOT reconstructable from UI turns: a step's
  // assistant tool-call message and its tool-result message have no turn
  // representation at all, and dropping them would make a continuation resend
  // a tool call the model already made (invariant 16).
  //
  // `ordinal` is a rowid alias, so chronological order is insertion order and
  // survives equal timestamps.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS model_messages (
      ordinal          INTEGER PRIMARY KEY,
      generation_id    TEXT NOT NULL,
      attempt          INTEGER NOT NULL CHECK (attempt >= 0),
      global_step      INTEGER NOT NULL CHECK (global_step >= 0),
      message_index    INTEGER NOT NULL CHECK (message_index >= 0),
      kind             TEXT NOT NULL CHECK (kind IN ('input', 'response')),
      -- Set for an input message, NULL for a response message. The CHECK makes
      -- that structural rather than a convention a later caller can forget.
      source_event_seq INTEGER CHECK (source_event_seq IS NULL OR source_event_seq > 0),
      claim_epoch      INTEGER NOT NULL CHECK (claim_epoch >= 0),
      message_json     TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      CHECK (
        (kind = 'input'    AND source_event_seq IS NOT NULL)
        OR
        (kind = 'response' AND source_event_seq IS NULL)
      ),
      UNIQUE (generation_id, global_step, message_index, kind)
    );
  `);
  // Once-only input insertion, across every generation of this run.
  //
  // A plain UNIQUE(source_event_seq) column constraint would also work, because
  // SQLite treats NULLs as distinct and every response row is NULL there — but
  // that reads as an accident. The partial index says the intent out loud: at
  // most one transcript row per input RunEvent, ever, while responses are
  // unconstrained by it (invariant 13).
  sql.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_model_messages_source
      ON model_messages (source_event_seq) WHERE source_event_seq IS NOT NULL;
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_model_messages_generation
      ON model_messages (generation_id, ordinal);
  `);

  // Billed model steps. Deliberately NOT fenced by claim epoch: see
  // recordStepUsage(). No prompt, completion, reasoning or provider body.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS model_step_usage (
      id                  TEXT PRIMARY KEY,
      generation_id       TEXT NOT NULL,
      agent_turn_id       TEXT NOT NULL,
      attempt             INTEGER NOT NULL CHECK (attempt >= 0),
      global_step         INTEGER NOT NULL CHECK (global_step >= 0),
      provider            TEXT NOT NULL,
      model               TEXT NOT NULL,
      provider_request_id TEXT,
      gateway_log_id      TEXT,
      usage_json          TEXT NOT NULL,
      cost_nano_usd       INTEGER NOT NULL CHECK (cost_nano_usd >= 0),
      latency_ms          INTEGER NOT NULL CHECK (latency_ms >= 0),
      finish_reason       TEXT,
      raw_finish_reason   TEXT,
      error_code          TEXT,
      d1_projected_at     INTEGER,
      created_at          INTEGER NOT NULL,
      UNIQUE (generation_id, attempt, global_step)
    );
  `);
  // The pending-projection sweep. Partial, so it stays the size of the backlog
  // rather than the size of the run's whole billing history.
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_model_step_usage_pending
      ON model_step_usage (created_at) WHERE d1_projected_at IS NULL;
  `);

  // Durable work that must reach an external store. Separate state and backoff
  // from the driver on purpose: a Zep or D1 outage must not change whether the
  // conversational loop is running.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS agent_projection_jobs (
      id               TEXT PRIMARY KEY,
      kind             TEXT NOT NULL CHECK (kind IN ('run_index', 'd1_usage', 'memory_outbox')),
      source_id        TEXT NOT NULL,
      state            TEXT NOT NULL CHECK (
        state IN ('pending', 'claimed', 'completed', 'failed')
      ),
      claim_token      TEXT,
      lease_expires_at INTEGER,
      attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at  INTEGER NOT NULL,
      last_error       TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      UNIQUE (kind, source_id)
    );
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_projection_jobs_due
      ON agent_projection_jobs (state, next_attempt_at);
  `);

  // Immutable bundled snapshots of what D1's run index should show.
  //
  // `revision` is the separate monotonic counter the plan requires. It cannot
  // be stream_events.seq, because a summary change may emit no RunEvent at all,
  // and it cannot be a timestamp, because two updates in the same millisecond
  // would tie and let the loser overwrite the winner. Nothing ever deletes from
  // this table: like stream_events, that is what makes MAX(revision) + 1 a
  // sound allocator without AUTOINCREMENT.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS run_index_outbox (
      revision             INTEGER PRIMARY KEY,
      status               TEXT NOT NULL,
      summary              TEXT,
      projected_updated_at INTEGER NOT NULL,
      created_at           INTEGER NOT NULL
    );
  `);

  // Assistant batch id -> event seq. A key table, NOT a second payload store:
  // the update itself lives once, in stream_events, and replaying a stable
  // batch id returns that original sequence instead of appending a duplicate.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS assistant_batches (
      id            TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL,
      attempt       INTEGER NOT NULL CHECK (attempt >= 0),
      event_seq     INTEGER NOT NULL UNIQUE,
      created_at    INTEGER NOT NULL
    );
  `);

  // Pending-input reads scan turns by provenance and sequence.
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_turns_source_seq ON turns (source, event_seq);
  `);

  activateSchemaV2(storage, now);
}

/**
 * Schema-v2 activation, which is deliberately NON-REPLAYING.
 *
 * A Phase 08 object being upgraded already holds real turns, some of them from
 * a trusted source that would wake the loop under Phase 10 rules. If activation
 * left the driver's cursors at zero, the very first alarm after deploy would
 * treat every historical triage message in every historical run as new pending
 * input and start paying for model work on all of them at once.
 *
 * So the watermark is the latest EXISTING input event: everything already in
 * the log counts as settled, the driver starts idle, and only genuinely new
 * input after the deploy can schedule work — under the channel policy current
 * at that time. A deliberate backlog replay, if it is ever wanted, is a
 * separate operator-triggered tool that revalidates live/shadow policy.
 */
function activateSchemaV2(storage: DurableObjectStorage, now: number): void {
  const placeholders = WAKE_TURN_SOURCES.map(() => "?").join(", ");
  const watermark = storage.sql
    .exec<{ seq: number }>(
      `SELECT COALESCE(MAX(event_seq), 0) AS seq FROM turns WHERE source IN (${placeholders})`,
      ...WAKE_TURN_SOURCES,
    )
    .one().seq;

  storage.sql.exec(
    `INSERT INTO agent_driver
       (singleton, phase, pending_through_seq, settled_through_seq, attempt, claim_epoch, updated_at)
     VALUES (1, 'idle', ?, ?, 0, 0, ?)
     ON CONFLICT (singleton) DO NOTHING`,
    watermark,
    watermark,
    now,
  );

  // Phase 08 defaulted every session to `live`, but no model driver existed to
  // make that true. Public state joins the driver at idle.
  //
  // `updated_at` is deliberately untouched: an upgrade is not activity, and
  // bumping it would jump every historical run to the top of the dashboard's
  // recency list at deploy time. The matching D1 repair is a one-shot bulk
  // update in migration 0006, which fixes every historical row without waking
  // a single Durable Object.
  storage.sql.exec("UPDATE run_state SET status = 'idle' WHERE singleton = 1 AND status = 'live'");
}

/**
 * v3: when a `scheduled` generation may be claimed again.
 *
 * A separate column rather than overloading `lease_expires_at`, which already
 * means "who owns the run right now". Two meanings in one column is how a
 * backoff eventually gets read as ownership by the one caller that forgot.
 *
 * It has to be durable, not in-memory: the retry budget is spent across alarm
 * deliveries and object wakes, and a backoff that lived in a field would be
 * zero again after every hibernation — turning a bounded retry into a hot loop
 * against whatever is already failing.
 */
function applyV3(storage: DurableObjectStorage): void {
  storage.sql.exec(
    "ALTER TABLE agent_driver ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0",
  );
}

/**
 * v4: the retry budget, kept apart from the claim counter.
 *
 * `attempt` increments on every claim, and a claim is not a retry: a steer that
 * arrives mid-answer continues the same generation and costs a claim, as does a
 * lease reclaim. It also cannot be reset to make room, because it is part of
 * the stable identity of everything a claim writes — `stream:{gen}:{attempt}`,
 * `assistant:{gen}:{attempt}:{batch}`, `usage:{gen}:{attempt}:{step}`. Reusing
 * a number there would put two different provider streams on one id and make an
 * at-least-once replay return the wrong event.
 *
 * So the budget gets its own counter, incremented only where a failure is
 * actually rescheduled. Without it, a customer who steered twice would lose
 * their run to the next transient provider blip, having spent no retries at all.
 */
function applyV4(storage: DurableObjectStorage): void {
  storage.sql.exec(
    "ALTER TABLE agent_driver ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0",
  );
}

/**
 * v5: generation-local provenance from trusted tool reads.
 *
 * The subtle half of two-sided memory. A generation's episode must cite the
 * evidence the agent actually USED, and for a Chat question that evidence is
 * whatever `memory.recall`, `memory.cite` and `slack.searchMessages` RETURNED —
 * not the Chat prompt that triggered them. So the adapters register the ids
 * they handed back, here, as the read happens.
 *
 * `ref` is always a host-side identifier: a Zep episode UUID the store
 * returned, or a stored `messages.event_id`. Model-authored code cannot reach
 * this table, cannot name a ref, and never sees either identifier — episode
 * uuids stay host-side in `memory.recall`, and the search binding projects the
 * model-visible shape without the event id.
 *
 * The primary key makes registration idempotent, which matters because a
 * generation retries and re-reads: the same recall in attempt two adds no rows.
 */
function applyV5(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS agent_source_records (
      generation_id TEXT NOT NULL,
      kind          TEXT NOT NULL CHECK (
        kind IN ('run_turn', 'zep_episode', 'slack_message')
      ),
      ref           TEXT NOT NULL,
      turn_id       TEXT,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (generation_id, kind, ref)
    );
  `);
  storage.sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_source_records_generation
      ON agent_source_records (generation_id, created_at);
  `);
}

const LOCAL_MIGRATIONS: readonly LocalMigration[] = [
  { version: 1, apply: (storage) => applyV1(storage) },
  { version: 2, apply: (storage, now) => applyV2(storage, now) },
  { version: 3, apply: (storage) => applyV3(storage) },
  { version: 4, apply: (storage) => applyV4(storage) },
  { version: 5, apply: (storage) => applyV5(storage) },
];

// --- state -----------------------------------------------------------------

type StateRow = {
  run_id: string;
  run_key: string;
  origin: RunOrigin;
  channel_id: string | null;
  thread_ts: string | null;
  status: RunStatus;
  summary: string | null;
  created_at: number;
  updated_at: number;
};

export function readState(storage: DurableObjectStorage): RunState | null {
  const rows = storage.sql
    .exec<StateRow>(
      `SELECT run_id, run_key, origin, channel_id, thread_ts, status, summary, created_at, updated_at
       FROM run_state WHERE singleton = 1`,
    )
    .toArray();
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    runId: row.run_id,
    key: row.run_key,
    origin: row.origin,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    status: row.status,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Idempotent for the same descriptor. A DIFFERENT run id, key or origin aimed
 * at this object is a routing bug — two runs sharing one Durable Object would
 * interleave their turns — so it throws rather than overwriting.
 */
export function initializeSession(
  storage: DurableObjectStorage,
  descriptor: RunDescriptor,
  now = Date.now(),
): RunState {
  const existing = readState(storage);
  if (existing) {
    if (
      existing.runId !== descriptor.runId ||
      existing.key !== descriptor.key ||
      existing.origin !== descriptor.origin
    ) {
      throw new SessionError(
        `run already initialized as ${existing.key} (${existing.runId}); refusing ${descriptor.key} (${descriptor.runId})`,
      );
    }
    return existing;
  }

  // Every newly initialized session starts `idle`, for every origin.
  //
  // Phase 08 started them `live`, which described nothing: no loop existed, so
  // "live" only meant "a row was created". From Phase 10 on, `live` means the
  // agent has work scheduled, and that transition happens inside the input
  // transaction that schedules it — see `appendTurn()`. A run created by
  // `POST /api/runs` with no first message is genuinely idle, and must not
  // advertise a loop that will never wake.
  storage.sql.exec(
    `INSERT INTO run_state
       (singleton, run_id, run_key, origin, channel_id, thread_ts, status, summary, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, 'idle', NULL, ?, ?)`,
    descriptor.runId,
    descriptor.key,
    descriptor.origin,
    descriptor.channelId,
    descriptor.threadTs,
    now,
    now,
  );

  const created = readState(storage);
  if (!created) throw new SessionError("run_state vanished immediately after insert");
  return created;
}

function requireState(storage: DurableObjectStorage): RunState {
  const state = readState(storage);
  if (!state) {
    // Better a loud failure than an anonymous session that later cannot be
    // matched back to a D1 row or a Slack thread.
    throw new SessionError("run is not initialized");
  }
  return state;
}

// --- events ----------------------------------------------------------------

export function latestSeq(storage: DurableObjectStorage): number {
  return storage.sql
    .exec<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM stream_events")
    .one().seq;
}

function nextSeq(storage: DurableObjectStorage): number {
  return latestSeq(storage) + 1;
}

function writeEvent(storage: DurableObjectStorage, event: RunEvent, createdAt: number): void {
  storage.sql.exec(
    "INSERT INTO stream_events (seq, type, payload_json, created_at) VALUES (?, ?, ?, ?)",
    event.seq,
    event.type,
    JSON.stringify(event),
    createdAt,
  );
}

function eventAt(storage: DurableObjectStorage, seq: number): RunEvent {
  const rows = storage.sql
    .exec<{ payload_json: string }>("SELECT payload_json FROM stream_events WHERE seq = ?", seq)
    .toArray();
  if (rows.length === 0) throw new SessionError(`stream event ${seq} is missing`);
  return JSON.parse(rows[0].payload_json) as RunEvent;
}

/**
 * Bounded read. An unbounded `SELECT *` over a long run would cross RPC as one
 * unbounded value and, on the socket path, as one unbounded frame.
 */
export function listEvents(
  storage: DurableObjectStorage,
  afterSeq = 0,
  limit = EVENT_PAGE_DEFAULT,
): RunEvent[] {
  const after = Math.max(0, Math.floor(Number.isFinite(afterSeq) ? afterSeq : 0));
  const size = Math.min(Math.max(1, Math.floor(limit)), EVENT_PAGE_MAX);
  return storage.sql
    .exec<{ payload_json: string }>(
      "SELECT payload_json FROM stream_events WHERE seq > ? ORDER BY seq ASC LIMIT ?",
      after,
      size,
    )
    .toArray()
    .map((row) => JSON.parse(row.payload_json) as RunEvent);
}

export function snapshot(
  storage: DurableObjectStorage,
  afterSeq = 0,
  limit = EVENT_PAGE_DEFAULT,
): SessionSnapshot {
  const events = listEvents(storage, afterSeq, limit);
  const cursor = events.length > 0 ? events[events.length - 1].seq : Math.max(0, afterSeq);
  return {
    state: readState(storage),
    events,
    cursor,
    complete: cursor >= latestSeq(storage),
  };
}

// --- turns -----------------------------------------------------------------

function validateTurn(input: RunTurnInput): void {
  if (typeof input.id !== "string" || input.id.length === 0) {
    throw new SessionError("turn id must be a non-empty string");
  }
  if (!TURN_ROLES.has(input.role)) throw new SessionError(`unknown turn role: ${input.role}`);
  if (!TURN_SOURCES.has(input.source)) throw new SessionError(`unknown turn source: ${input.source}`);
  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    throw new SessionError("turn content must not be blank");
  }
}

/**
 * The ONE session mutation that injects conversational input. A triage opening,
 * a later customer message, dashboard steering and a Phase 11 approval outcome
 * all land here. There is deliberately no source-specific variant — that is how
 * a second, divergent inbox gets built by accident.
 */
export function appendTurn(
  storage: DurableObjectStorage,
  input: RunTurnInput,
  now = Date.now(),
): AppendResult {
  validateTurn(input);
  requireState(storage);

  return storage.transactionSync(() => writeTurn(storage, input, now));
}

/**
 * The turn writer, factored out of `appendTurn`'s transaction.
 *
 * Callers own the transaction. It exists because `finalizeAnswer` must append
 * the final assistant turn inside the SAME transaction as the settle, and
 * calling `appendTurn` from there would open a nested `transactionSync` whose
 * behaviour under Durable Object SQLite is not part of the documented contract.
 * One writer, two callers, one set of semantics.
 */
function writeTurn(
  storage: DurableObjectStorage,
  input: RunTurnInput,
  now: number,
): AppendResult {
  {
    const existing = storage.sql
      .exec<{ event_seq: number }>("SELECT event_seq FROM turns WHERE id = ?", input.id)
      .toArray();
    if (existing.length > 0) {
      // Queue retry or browser retry. Return the original event so the caller
      // can broadcast by the same seq; the socket cursor suppresses the dupe.
      //
      // The caller still calls setAlarm() afterwards, deliberately: the first
      // attempt may have committed this turn and then died before arming the
      // alarm, and a duplicate delivery is the only thing that will ever heal
      // that. Reporting the generation lets it do so without re-deriving state.
      const driver = readDriver(storage);
      return {
        appended: false,
        event: eventAt(storage, existing[0].event_seq),
        scheduling: { outcome: "duplicate", generationId: driver.generationId },
        statusEvent: null,
      };
    }

    const createdAt = input.createdAt ?? now;
    const turn: RunTurn = {
      id: input.id,
      role: input.role,
      source: input.source,
      content: input.content,
      metadata: input.metadata ?? null,
      createdAt,
    };
    const seq = nextSeq(storage);
    const event: RunEvent = { seq, type: "turn", turn };

    writeEvent(storage, event, createdAt);
    storage.sql.exec(
      `INSERT INTO turns (id, role, source, content, metadata_json, created_at, event_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      turn.id,
      turn.role,
      turn.source,
      turn.content,
      turn.metadata === null ? null : JSON.stringify(turn.metadata),
      createdAt,
      seq,
    );
    touchState(storage, createdAt);

    // Steps 2-5 of the plan's atomic input transaction. Still inside the same
    // synchronous transaction as the turn and its RunEvent, so a crash cannot
    // leave a committed customer message that nothing will ever answer.
    const scheduled = scheduleInput(storage, input, seq, createdAt);
    // The live transition already wrote a revision carrying this same bundle,
    // so only an input that changed no status needs one of its own.
    if (scheduled.statusEvent === null) writeRunIndexRevision(storage, createdAt);

    return {
      appended: true,
      event,
      scheduling: scheduled.scheduling,
      statusEvent: scheduled.statusEvent,
    };
  }
}

/**
 * The wake decision, evaluated on a turn that has just been committed.
 *
 * Provenance only. There is no test here on what the message says — no bug, no
 * question, no size — because that is exactly how a per-ticket-type pipeline
 * gets rebuilt one condition at a time (invariant 3).
 */
function scheduleInput(
  storage: DurableObjectStorage,
  input: RunTurnInput,
  seq: number,
  now: number,
): { scheduling: InputScheduling; statusEvent: RunEvent | null } {
  if (!isWakeSource(input.source)) {
    return { scheduling: { outcome: "not_input" }, statusEvent: null };
  }

  const driver = readDriver(storage);

  // An input is never dropped, even when it cannot legally wake the loop. It
  // is above the settled watermark from now on, so whatever eventually resumes
  // this run will include it (invariant 13).
  const pendingThroughSeq = Math.max(driver.pendingThroughSeq, seq);
  storage.sql.exec(
    "UPDATE agent_driver SET pending_through_seq = ?, updated_at = ? WHERE singleton = 1",
    pendingThroughSeq,
    now,
  );

  if (driver.phase === "scheduled" || driver.phase === "running") {
    // Already working. The same generation absorbs this input at its next step
    // or continuation; allocating a second one here would fork the transcript
    // and the Code Mode effect scope.
    //
    // The retry backoff is cleared. A backoff exists to space out attempts at
    // something that just failed, not to make a customer who typed a follow-up
    // wait for a timer; the attempt CEILING is what bounds the retry, and it is
    // untouched here.
    storage.sql.exec(
      "UPDATE agent_driver SET next_attempt_at = 0, updated_at = ? WHERE singleton = 1",
      now,
    );
    return {
      scheduling: {
        outcome: "joined",
        generationId: driver.generationId as string,
        agentTurnId: driver.agentTurnId as string,
        eventSeq: seq,
      },
      statusEvent: goLive(storage, now),
    };
  }

  if (driver.phase === "failed" && !isInputResumablePolicy(driver.resumePolicy)) {
    // A run spend ceiling or an ambiguous external effect. An ordinary message
    // must not restart spending or replay a mutation that may already have hit
    // a customer; only an explicit operator or reconciliation action can.
    return {
      scheduling: {
        outcome: "blocked",
        policy: driver.resumePolicy as ResumePolicy,
        eventSeq: seq,
      },
      statusEvent: null,
    };
  }

  // Idle, or a terminal failure this input may legally resume: allocate the
  // generation and its agent turn id NOW, before any asynchronous call, so
  // every retry and continuation of this work reuses the same effect scope
  // (invariant 7).
  const generationId = newGenerationId();
  const agentTurnId = agentTurnIdFor(generationId);

  storage.sql.exec(
    `INSERT INTO agent_generations
       (id, agent_turn_id, state, first_input_seq, included_through_seq, created_at, updated_at)
     VALUES (?, ?, 'scheduled', ?, ?, ?, ?)`,
    generationId,
    agentTurnId,
    seq,
    // What is already in the transcript. Anything above it is pending input.
    driver.settledThroughSeq,
    now,
    now,
  );
  storage.sql.exec(
    `UPDATE agent_driver SET
       phase = 'scheduled',
       current_generation_id = ?,
       current_agent_turn_id = ?,
       attempt = 0,
       retry_count = 0,
       lease_expires_at = NULL,
       last_heartbeat_at = NULL,
       next_attempt_at = 0,
       resume_policy = NULL,
       last_error_code = NULL,
       last_error_message = NULL,
       updated_at = ?
     WHERE singleton = 1`,
    generationId,
    agentTurnId,
    now,
  );

  return {
    scheduling: { outcome: "allocated", generationId, agentTurnId, eventSeq: seq },
    statusEvent: goLive(storage, now),
  };
}

export type OperatorConfigResume =
  | { outcome: "not_applicable" }
  | {
      outcome: "rescheduled";
      generationId: string;
      agentTurnId: string;
      /** The generation the missing configuration killed. Stays terminal. */
      failedGenerationId: string;
      statusEvent: RunEvent | null;
    };

/**
 * THE EXPLICIT CONFIG RESET, done by the only actor who can do it: the operator
 * who supplied the configuration.
 *
 * The problem this exists for. Wiring the production continuation up means a
 * deployment with no Gateway settings now CLAIMS a generation and fails
 * composition terminally as `requires_operator_config` (plan lines 965-966
 * require absence to fail). That policy is deliberately not input-resumable —
 * `isInputResumablePolicy`, and the gate in `scheduleInput` — so no customer
 * message and no human steer can revive the run. Without this function, every
 * run claimed between "the code deployed" and "the secret landed" is dead
 * FOREVER, including after the operator fixes it. The behaviour it replaced
 * (`continuation: null`) parked instead, and a parked run resumed the moment a
 * continuation existed.
 *
 * Plan line 655 says what may wake this policy: "explicit operator/config
 * reset, never ordinary input". Supplying the configuration IS that reset. So
 * the reset is not weakened here and no new resume policy is invented — the
 * failure stays terminal, stays `requires_operator_config`, and stays out of
 * reach of `appendTurn`. What changes is that the deployment which now HAS the
 * configuration picks the work back up.
 *
 * Every guard below is load-bearing:
 *
 *  - `configurationComplete` is the operator's action. While it is false this
 *    function does nothing at all, so an unconfigured deployment cannot loop.
 *  - `isAbsentConfigurationCode` is what makes it a one-way transition rather
 *    than a retry loop. Only ABSENT settings are revivable; a present-but-wrong
 *    `invalid_gateway_url` is not, because presence is all this check can see
 *    and a run revived on a malformed value would fail on it again every wake.
 *  - a `cost_limit` / `budget_exhausted` failure carries the same
 *    `requires_operator_config` policy and is NOT in that code list, so a run
 *    spend ceiling is untouched. Nothing here can restart spending that a cap
 *    stopped.
 *  - pending input must genuinely be owed. A revived generation with nothing to
 *    answer would re-run the model over a settled transcript for no reason.
 *
 * NO MONEY IS RE-DERIVED. `createProductionModelFactory` throws before any
 * provider request, before `makeAgentTools`, before a single billed token, so
 * the failed generation holds no usage rows and no effects. A FRESH generation
 * is allocated rather than the dead one revived, for two concrete reasons: the
 * failed one already froze its immutable episode and enqueued its memory-outbox
 * job (`finalizeGeneration`), which reviving would strand as a lie; and the
 * inputs it owed are still above `settled_through_seq`, which is precisely the
 * state `scheduleInput` allocates from. The dead generation stays terminal and
 * keeps naming the setting, so the operator record of what happened survives.
 */
export function resumeAfterOperatorConfig(
  storage: DurableObjectStorage,
  options: { configurationComplete: boolean },
  now = Date.now(),
): OperatorConfigResume {
  if (!options.configurationComplete) return { outcome: "not_applicable" };

  return storage.transactionSync(() => {
    const driver = readDriver(storage);
    if (driver.phase !== "failed") return { outcome: "not_applicable" };
    if (driver.resumePolicy !== "requires_operator_config") return { outcome: "not_applicable" };
    if (!isAbsentConfigurationCode(driver.lastErrorCode)) return { outcome: "not_applicable" };
    if (driver.generationId === null) return { outcome: "not_applicable" };
    if (driver.pendingThroughSeq <= driver.settledThroughSeq) return { outcome: "not_applicable" };

    const failedGenerationId = driver.generationId;
    const failed = readGeneration(storage, failedGenerationId);
    const generationId = newGenerationId();
    const agentTurnId = agentTurnIdFor(generationId);

    storage.sql.exec(
      `INSERT INTO agent_generations
         (id, agent_turn_id, state, first_input_seq, included_through_seq, created_at, updated_at)
       VALUES (?, ?, 'scheduled', ?, ?, ?, ?)`,
      generationId,
      agentTurnId,
      // The same first input the dead generation was allocated for, when it can
      // still be read. Nothing new arrived to move it.
      failed?.firstInputSeq ?? driver.settledThroughSeq + 1,
      driver.settledThroughSeq,
      now,
      now,
    );
    storage.sql.exec(
      `UPDATE agent_driver SET
         phase = 'scheduled',
         current_generation_id = ?,
         current_agent_turn_id = ?,
         attempt = 0,
         retry_count = 0,
         lease_expires_at = NULL,
         last_heartbeat_at = NULL,
         next_attempt_at = 0,
         resume_policy = NULL,
         last_error_code = NULL,
         last_error_message = NULL,
         updated_at = ?
       WHERE singleton = 1`,
      generationId,
      agentTurnId,
      now,
    );

    return {
      outcome: "rescheduled",
      generationId,
      agentTurnId,
      failedGenerationId,
      statusEvent: goLive(storage, now),
    };
  });
}

/**
 * The public `live` status event, appended in the SAME transaction as the input
 * that scheduled the work. Two separate calls would leave a window in which the
 * dashboard shows an idle run that already has a generation waiting.
 */
function goLive(storage: DurableObjectStorage, now: number): RunEvent | null {
  const state = readState(storage);
  if (!state || state.status === "live") return null;
  const verdict = evaluateTransition(state.status, "live");
  if (!verdict.ok || !verdict.changed) return null;
  return writeStatusEvent(storage, state.status, "live", now);
}

/**
 * Oldest-first page of turns. UNCHANGED Phase 08 behaviour, including the
 * surprise: with a limit it returns the OLDEST rows, so on a long run the
 * newest steer is not in it. Existing callers (`RunDO.turns()`, several tests)
 * read short runs and depend on this order, so it keeps it — the fix is the two
 * explicit functions below, not a silent reinterpretation of this one.
 */
export function listTurns(storage: DurableObjectStorage, limit = EVENT_PAGE_DEFAULT): RunTurn[] {
  const size = clampPage(limit);
  return readTurnRows(
    storage,
    `SELECT id, role, source, content, metadata_json, created_at
     FROM turns ORDER BY event_seq ASC LIMIT ?`,
    size,
  );
}

/**
 * Turns committed AFTER a RunEvent sequence, oldest first.
 *
 * This is how the loop reads its pending input: the driver holds the cursor it
 * has already put in the transcript and asks for what came after it. Ordering
 * is by `event_seq` and never by timestamp, so two turns committed in the same
 * millisecond still have one total order (invariant 12).
 */
export function listTurnsAfter(
  storage: DurableObjectStorage,
  afterEventSeq: number,
  limit = EVENT_PAGE_DEFAULT,
): RunTurn[] {
  const after = Math.max(0, Math.floor(Number.isFinite(afterEventSeq) ? afterEventSeq : 0));
  return readTurnRows(
    storage,
    `SELECT id, role, source, content, metadata_json, created_at
     FROM turns WHERE event_seq > ? ORDER BY event_seq ASC LIMIT ?`,
    after,
    clampPage(limit),
  );
}

/**
 * The NEWEST turns, returned oldest-first so they read as a conversation.
 *
 * The inner query orders descending to take the newest rows, then the outer one
 * flips them back. `listTurns(50)` on a 2,000-turn run returns the first fifty
 * messages — history the model has already seen and the customer's latest
 * message is not among them.
 */
export function listRecentTurns(
  storage: DurableObjectStorage,
  limit = EVENT_PAGE_DEFAULT,
): RunTurn[] {
  return readTurnRows(
    storage,
    `SELECT id, role, source, content, metadata_json, created_at FROM (
       SELECT id, role, source, content, metadata_json, created_at, event_seq
       FROM turns ORDER BY event_seq DESC LIMIT ?
     ) ORDER BY event_seq ASC`,
    clampPage(limit),
  );
}

/**
 * Pending trusted input after a cursor: what the loop still owes an answer to.
 * Agent and system turns are excluded here rather than by the caller, so the
 * loop's own output can never be mistaken for something to respond to.
 */
export function listPendingInputTurns(
  storage: DurableObjectStorage,
  afterEventSeq: number,
  limit = EVENT_PAGE_DEFAULT,
): RunTurn[] {
  const after = Math.max(0, Math.floor(Number.isFinite(afterEventSeq) ? afterEventSeq : 0));
  const placeholders = WAKE_TURN_SOURCES.map(() => "?").join(", ");
  return readTurnRows(
    storage,
    `SELECT id, role, source, content, metadata_json, created_at
     FROM turns WHERE event_seq > ? AND source IN (${placeholders})
     ORDER BY event_seq ASC LIMIT ?`,
    after,
    ...WAKE_TURN_SOURCES,
    clampPage(limit),
  );
}

/** The RunEvent seq a turn was committed at, for cursor bookkeeping. */
export function turnEventSeq(storage: DurableObjectStorage, turnId: string): number | null {
  const rows = storage.sql
    .exec<{ event_seq: number }>("SELECT event_seq FROM turns WHERE id = ?", turnId)
    .toArray();
  return rows.length > 0 ? rows[0].event_seq : null;
}

function clampPage(limit: number): number {
  return Math.min(Math.max(1, Math.floor(limit)), EVENT_PAGE_MAX);
}

function readTurnRows(
  storage: DurableObjectStorage,
  query: string,
  ...bindings: (string | number)[]
): RunTurn[] {
  return storage.sql
    .exec<{
      id: string;
      role: RunTurn["role"];
      source: RunTurn["source"];
      content: string;
      metadata_json: string | null;
      created_at: number;
    }>(query, ...bindings)
    .toArray()
    .map((row) => ({
      id: row.id,
      role: row.role,
      source: row.source,
      content: row.content,
      metadata: row.metadata_json === null ? null : (JSON.parse(row.metadata_json) as JsonObject),
      createdAt: row.created_at,
    }));
}

// --- tool calls ------------------------------------------------------------

function validateToolUpdate(input: ToolCallUpdateInput): void {
  if (typeof input.id !== "string" || input.id.length === 0) {
    throw new SessionError("tool update id must be a non-empty string");
  }
  if (typeof input.callId !== "string" || input.callId.length === 0) {
    throw new SessionError("tool update callId must be a non-empty string");
  }
  if (typeof input.name !== "string" || input.name.length === 0) {
    throw new SessionError("tool update name must be a non-empty string");
  }
  if (!TOOL_STATES.has(input.state)) throw new SessionError(`unknown tool state: ${input.state}`);
}

export function appendToolCallUpdate(
  storage: DurableObjectStorage,
  input: ToolCallUpdateInput,
  now = Date.now(),
): AppendResult {
  validateToolUpdate(input);
  requireState(storage);
  return storage.transactionSync(() => writeToolCallUpdate(storage, input, now));
}

/**
 * The same append, fenced to a claim.
 *
 * The agent loop must use THIS one. Outer `run_code` start/end updates and
 * nested `cap:*` audit events are conversational output; a claimant whose lease
 * expired and whose work was taken over must not be able to narrate into a run
 * that a successor now owns. A replay of an id that is already committed still
 * returns the original event, because that mutates nothing.
 */
export function appendAgentToolCallUpdate(
  storage: DurableObjectStorage,
  fence: ClaimFence,
  input: ToolCallUpdateInput,
  now = Date.now(),
): FencedAppendOutcome {
  validateToolUpdate(input);
  requireState(storage);

  return storage.transactionSync(() => {
    const existing = storage.sql
      .exec<{ event_seq: number }>("SELECT event_seq FROM tool_updates WHERE id = ?", input.id)
      .toArray();
    if (existing.length > 0) {
      return { outcome: "replayed", event: eventAt(storage, existing[0].event_seq) };
    }
    if (!isCurrentClaim(storage, fence)) return { outcome: "stale_claim" };

    const result = writeToolCallUpdate(storage, input, now);
    return { outcome: "appended", event: result.event };
  });
}

/** Shared writer. Callers own the transaction and any pre-checks. */
function writeToolCallUpdate(
  storage: DurableObjectStorage,
  input: ToolCallUpdateInput,
  now: number,
): AppendResult {
  const existing = storage.sql
    .exec<{ event_seq: number }>("SELECT event_seq FROM tool_updates WHERE id = ?", input.id)
    .toArray();
  if (existing.length > 0) {
    return {
      appended: false,
      event: eventAt(storage, existing[0].event_seq),
      scheduling: { outcome: "not_input" },
      statusEvent: null,
    };
  }

  const createdAt = input.createdAt ?? now;
  const update: ToolCallUpdate = {
    id: input.id,
    callId: input.callId,
    name: input.name,
    state: input.state,
    ...(input.input !== undefined ? { input: input.input } : {}),
    ...(input.output !== undefined ? { output: input.output } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.delta !== undefined ? { delta: input.delta } : {}),
    createdAt,
  };
  const seq = nextSeq(storage);
  const event: RunEvent = { seq, type: "tool_call", update };

  writeEvent(storage, event, createdAt);
  storage.sql.exec(
    `INSERT INTO tool_updates
       (id, call_id, name, state, input_json, output_json, error, delta, created_at, event_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    update.id,
    update.callId,
    update.name,
    update.state,
    jsonOrNull(update.input),
    jsonOrNull(update.output),
    update.error ?? null,
    update.delta ?? null,
    createdAt,
    seq,
  );

  // The materialized call. COALESCE keeps the ORIGINAL input when a later
  // completed/failed update carries only output — the dashboard still needs
  // to show what the tool was called with.
  storage.sql.exec(
    `INSERT INTO tool_calls
       (call_id, name, state, input_json, output_json, error, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(call_id) DO UPDATE SET
       state       = excluded.state,
       input_json  = COALESCE(tool_calls.input_json, excluded.input_json),
       output_json = COALESCE(excluded.output_json, tool_calls.output_json),
       error       = COALESCE(excluded.error, tool_calls.error),
       updated_at  = excluded.updated_at`,
    update.callId,
    update.name,
    update.state,
    jsonOrNull(update.input),
    jsonOrNull(update.output),
    update.error ?? null,
    createdAt,
    createdAt,
  );
  touchState(storage, createdAt);
  // Recency only, so it coalesces: a long tool run must not write one
  // run-index revision per progress update.
  touchRunIndex(storage, createdAt);

  return { appended: true, event, scheduling: { outcome: "not_input" }, statusEvent: null };
}

export type ToolCallRecord = {
  callId: string;
  name: string;
  state: ToolCallUpdate["state"];
  input: JsonValue | null;
  output: JsonValue | null;
  error: string | null;
  startedAt: number;
  updatedAt: number;
};

export function listToolCalls(storage: DurableObjectStorage): ToolCallRecord[] {
  return storage.sql
    .exec<{
      call_id: string;
      name: string;
      state: ToolCallUpdate["state"];
      input_json: string | null;
      output_json: string | null;
      error: string | null;
      started_at: number;
      updated_at: number;
    }>(
      `SELECT call_id, name, state, input_json, output_json, error, started_at, updated_at
       FROM tool_calls ORDER BY started_at ASC`,
    )
    .toArray()
    .map((row) => ({
      callId: row.call_id,
      name: row.name,
      state: row.state,
      input: row.input_json === null ? null : (JSON.parse(row.input_json) as JsonValue),
      output: row.output_json === null ? null : (JSON.parse(row.output_json) as JsonValue),
      error: row.error,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
    }));
}

// --- status ----------------------------------------------------------------

export function setStatus(
  storage: DurableObjectStorage,
  status: RunStatus,
  now = Date.now(),
): StatusResult {
  if (!isRunStatus(status)) throw new SessionError(`unknown status: ${String(status)}`);
  const state = requireState(storage);

  const verdict = evaluateTransition(state.status, status);
  if (!verdict.ok) throw new SessionError(verdict.reason);
  if (!verdict.changed) return { changed: false, status: state.status, event: null };

  return storage.transactionSync(() => {
    const event = writeStatusEvent(storage, state.status, status, now);
    return { changed: true, status, event };
  });
}

/** Commits the status change, its RunEvent and its run-index revision together. */
function writeStatusEvent(
  storage: DurableObjectStorage,
  previousStatus: RunStatus,
  status: RunStatus,
  now: number,
): RunEvent {
  const seq = nextSeq(storage);
  const event: RunEvent = { seq, type: "status", previousStatus, status, createdAt: now };
  writeEvent(storage, event, now);
  storage.sql.exec(
    "UPDATE run_state SET status = ?, updated_at = MAX(updated_at, ?) WHERE singleton = 1",
    status,
    now,
  );
  writeRunIndexRevision(storage, now);
  return event;
}

export type SummaryResult = {
  /** False when the summary already read exactly this. */
  changed: boolean;
  /** The run-index revision this change must be projected under, if any. */
  revision: number | null;
};

/**
 * The run list's one-line description of what is happening.
 *
 * Phase 08 wrote this to local storage and then called `touchRun()`, which only
 * moves `updated_at` — so the summary never reached D1 and the dashboard list
 * stayed blank forever. It now writes a run-index revision like any other
 * lifecycle change, and the projector carries status and summary across
 * together.
 */
export function setSummary(
  storage: DurableObjectStorage,
  summary: string,
  now = Date.now(),
): SummaryResult {
  const state = requireState(storage);
  if (state.summary === summary) return { changed: false, revision: null };

  return storage.transactionSync(() => {
    storage.sql.exec(
      "UPDATE run_state SET summary = ?, updated_at = MAX(updated_at, ?) WHERE singleton = 1",
      summary,
      now,
    );
    return { changed: true, revision: writeRunIndexRevision(storage, now) };
  });
}

// --- run-index projection ---------------------------------------------------

/**
 * How long recency-only activity coalesces into one run-index revision. The
 * dashboard's "updated 3s ago" does not need per-chunk precision, and a
 * streamed answer must not queue one D1 write per batch.
 */
export const RUN_INDEX_COALESCE_MS = 5_000;

/**
 * Allocate the next revision and record the FULL current index snapshot.
 *
 * Bundled on purpose: projecting status and summary through separate writes is
 * what lets a slow status update land after a fast summary update and leave the
 * list self-contradictory. One row, one revision, one conditional apply.
 */
function writeRunIndexRevision(storage: DurableObjectStorage, now: number): number | null {
  const state = readState(storage);
  // Nothing to project yet: the object exists but has no identity, so there is
  // no D1 row to point a revision at.
  if (!state) return null;

  const revision = storage.sql
    .exec<{ next: number }>(
      "SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM run_index_outbox",
    )
    .one().next;

  storage.sql.exec(
    `INSERT INTO run_index_outbox (revision, status, summary, projected_updated_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    revision,
    state.status,
    state.summary,
    state.updatedAt,
    now,
  );
  enqueueProjectionJob(storage, "run_index", String(revision), now);
  return revision;
}

/**
 * Recency-only projection, coalesced. Returns null when the newest revision
 * already says the same thing recently enough to stand in for this one.
 */
export function touchRunIndex(
  storage: DurableObjectStorage,
  now: number,
  coalesceWindowMs = RUN_INDEX_COALESCE_MS,
): number | null {
  const state = readState(storage);
  if (!state) return null;

  const latest = latestRunIndexRevision(storage);
  if (
    latest &&
    latest.status === state.status &&
    latest.summary === state.summary &&
    state.updatedAt - latest.updatedAt < coalesceWindowMs
  ) {
    return null;
  }
  return writeRunIndexRevision(storage, now);
}

type RunIndexRow = {
  revision: number;
  status: RunStatus;
  summary: string | null;
  projected_updated_at: number;
};

function toRunIndexRevision(row: RunIndexRow): RunIndexRevision {
  return {
    revision: row.revision,
    status: row.status,
    summary: row.summary,
    updatedAt: row.projected_updated_at,
  };
}

export function readRunIndexRevision(
  storage: DurableObjectStorage,
  revision: number,
): RunIndexRevision | null {
  const rows = storage.sql
    .exec<RunIndexRow>(
      `SELECT revision, status, summary, projected_updated_at FROM run_index_outbox
       WHERE revision = ?`,
      revision,
    )
    .toArray();
  return rows.length > 0 ? toRunIndexRevision(rows[0]) : null;
}

export function latestRunIndexRevision(storage: DurableObjectStorage): RunIndexRevision | null {
  const rows = storage.sql
    .exec<RunIndexRow>(
      `SELECT revision, status, summary, projected_updated_at FROM run_index_outbox
       ORDER BY revision DESC LIMIT 1`,
    )
    .toArray();
  return rows.length > 0 ? toRunIndexRevision(rows[0]) : null;
}

// --- projection jobs --------------------------------------------------------

/**
 * Idempotent: the same (kind, source) enqueued twice is one job.
 *
 * `dueAt` defaults to wall-clock time, NOT to `now`. The `now` a caller passes
 * is the event's timestamp, which may be a Slack `ts` or a replayed value from
 * minutes ago or minutes ahead; scheduling delivery by it would either fire in
 * the past or, worse, park a due job in the future where no drain would claim
 * it. Backoff callers pass their own explicit `dueAt`.
 */
export function enqueueProjectionJob(
  storage: DurableObjectStorage,
  kind: ProjectionJobKind,
  sourceId: string,
  now: number,
  dueAt = Date.now(),
): string {
  const id = `${kind}:${sourceId}`;
  storage.sql.exec(
    `INSERT INTO agent_projection_jobs
       (id, kind, source_id, state, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    id,
    kind,
    sourceId,
    dueAt,
    now,
    now,
  );
  return id;
}

type ProjectionJobRow = {
  id: string;
  kind: ProjectionJobKind;
  source_id: string;
  state: ProjectionJobState;
  claim_token: string | null;
  lease_expires_at: number | null;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

const PROJECTION_JOB_COLUMNS = `id, kind, source_id, state, claim_token, lease_expires_at,
  attempts, next_attempt_at, last_error, created_at, updated_at`;

function toProjectionJob(row: ProjectionJobRow): ProjectionJob {
  return {
    id: row.id,
    kind: row.kind,
    sourceId: row.source_id,
    state: row.state,
    claimToken: row.claim_token,
    leaseExpiresAt: row.lease_expires_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Take ownership of one due job.
 *
 * A projection claim has its own token, lease and backoff and NEVER touches the
 * conversational driver phase: a Zep or D1 outage must not be able to stop the
 * model loop, and a busy loop must not starve delivery.
 */
export function claimProjectionJob(
  storage: DurableObjectStorage,
  options: {
    /** One kind, or several. With several, the earliest due job across them wins. */
    kind?: ProjectionJobKind;
    kinds?: readonly ProjectionJobKind[];
    now?: number;
    leaseMs?: number;
  },
): ProjectionClaimOutcome {
  const now = options.now ?? Date.now();
  const leaseMs = options.leaseMs ?? PROJECTION_LEASE_MS;
  const kinds = projectionKindList(options);
  if (kinds.length === 0) return { outcome: "none" };
  const placeholders = kinds.map(() => "?").join(", ");

  return storage.transactionSync(() => {
    const rows = storage.sql
      .exec<ProjectionJobRow>(
        `SELECT ${PROJECTION_JOB_COLUMNS} FROM agent_projection_jobs
         WHERE kind IN (${placeholders}) AND next_attempt_at <= ?
           AND (
             state = 'pending'
             OR (state = 'claimed' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
           )
         ORDER BY next_attempt_at ASC, id ASC LIMIT 1`,
        ...kinds,
        now,
        now,
      )
      .toArray();
    if (rows.length === 0) return { outcome: "none" };

    const claimToken = crypto.randomUUID();
    storage.sql.exec(
      `UPDATE agent_projection_jobs SET
         state = 'claimed',
         claim_token = ?,
         lease_expires_at = ?,
         attempts = attempts + 1,
         updated_at = ?
       WHERE id = ?`,
      claimToken,
      now + leaseMs,
      now,
      rows[0].id,
    );
    return {
      outcome: "claimed",
      job: { ...toProjectionJob(rows[0]), state: "claimed", claimToken, attempts: rows[0].attempts + 1 },
      claimToken,
    };
  });
}

function projectionKindList(options: {
  kind?: ProjectionJobKind;
  kinds?: readonly ProjectionJobKind[];
}): ProjectionJobKind[] {
  const merged = new Set<ProjectionJobKind>(options.kinds ?? []);
  if (options.kind !== undefined) merged.add(options.kind);
  return [...merged];
}

/**
 * When the earliest of these kinds is next claimable, or null when none is
 * outstanding. This is the projection half of the single alarm slot's due-time
 * arithmetic (see `nextAlarmAt`).
 *
 * A `claimed` job counts at its LEASE EXPIRY, not its next attempt time: the
 * pass that claimed it may have died mid-delivery, and if nothing ever re-armed
 * for the expiry, the job would sit claimed forever with no alarm coming for
 * it. That is also what heals the microtask-ordering lost wakeup in the
 * best-effort `#kickProjection` drain — the durable job and this due time are
 * the guarantee, the kick is only an optimization.
 */
export function nextProjectionDueAt(
  storage: DurableObjectStorage,
  kinds: readonly ProjectionJobKind[],
): number | null {
  if (kinds.length === 0) return null;
  const placeholders = kinds.map(() => "?").join(", ");
  const row = storage.sql
    .exec<{ due: number | null }>(
      `SELECT MIN(
         CASE WHEN state = 'pending' THEN next_attempt_at
              ELSE MAX(next_attempt_at, COALESCE(lease_expires_at, next_attempt_at))
         END
       ) AS due
       FROM agent_projection_jobs
       WHERE kind IN (${placeholders}) AND state IN ('pending', 'claimed')`,
      ...kinds,
    )
    .one();
  return row.due;
}

/** Fenced to the claim token, so a timed-out claimant cannot retire a job a successor owns. */
export function completeProjectionJob(
  storage: DurableObjectStorage,
  input: { id: string; claimToken: string; now?: number },
): ProjectionCompleteOutcome {
  const now = input.now ?? Date.now();
  const written = storage.sql.exec(
    `UPDATE agent_projection_jobs SET
       state = 'completed', claim_token = NULL, lease_expires_at = NULL,
       last_error = NULL, updated_at = ?
     WHERE id = ? AND claim_token = ?`,
    now,
    input.id,
    input.claimToken,
  ).rowsWritten;
  if (written > 0) return { outcome: "completed" };

  const exists = storage.sql
    .exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM agent_projection_jobs WHERE id = ?",
      input.id,
    )
    .one().n;
  return exists > 0 ? { outcome: "stale_claim" } : { outcome: "unknown" };
}

export function retryProjectionJob(
  storage: DurableObjectStorage,
  input: { id: string; claimToken: string; backoffMs: number; error?: string; now?: number },
): ProjectionCompleteOutcome {
  const now = input.now ?? Date.now();
  const written = storage.sql.exec(
    `UPDATE agent_projection_jobs SET
       state = 'pending', claim_token = NULL, lease_expires_at = NULL,
       next_attempt_at = ?, last_error = ?, updated_at = ?
     WHERE id = ? AND claim_token = ?`,
    now + Math.max(0, Math.floor(input.backoffMs)),
    input.error ? input.error.slice(0, ASSISTANT_ERROR_MAX) : null,
    now,
    input.id,
    input.claimToken,
  ).rowsWritten;
  return written > 0 ? { outcome: "completed" } : { outcome: "stale_claim" };
}

/**
 * Retire pending run-index revisions that a newer pending revision already
 * covers, so a long D1 outage drains in one write instead of hundreds.
 *
 * Only `pending` rows, and only revisions STRICTLY BELOW the newest pending
 * one. A claimed job is somebody's in-flight work, and a newer revision is
 * never marked delivered because an older one is.
 */
export function coalesceSupersededRunIndexJobs(
  storage: DurableObjectStorage,
  now = Date.now(),
): { coalesced: number; targetRevision: number | null } {
  const target = storage.sql
    .exec<{ max: number | null }>(
      `SELECT MAX(CAST(source_id AS INTEGER)) AS max FROM agent_projection_jobs
       WHERE kind = 'run_index' AND state = 'pending'`,
    )
    .one().max;
  if (target === null) return { coalesced: 0, targetRevision: null };

  const coalesced = storage.sql.exec(
    `UPDATE agent_projection_jobs SET state = 'completed', claim_token = NULL, updated_at = ?
     WHERE kind = 'run_index' AND state = 'pending' AND CAST(source_id AS INTEGER) < ?`,
    now,
    target,
  ).rowsWritten;
  return { coalesced, targetRevision: target };
}

export function countPendingProjectionJobs(
  storage: DurableObjectStorage,
  kind: ProjectionJobKind,
): number {
  return storage.sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agent_projection_jobs
       WHERE kind = ? AND state IN ('pending', 'claimed')`,
      kind,
    )
    .one().n;
}

// --- agent driver -----------------------------------------------------------

type DriverRow = {
  phase: DriverPhase;
  pending_through_seq: number;
  settled_through_seq: number;
  current_generation_id: string | null;
  current_agent_turn_id: string | null;
  attempt: number;
  retry_count: number;
  claim_epoch: number;
  lease_expires_at: number | null;
  last_heartbeat_at: number | null;
  next_attempt_at: number;
  resume_policy: ResumePolicy | null;
  last_error_code: string | null;
  last_error_message: string | null;
  updated_at: number;
};

const DRIVER_COLUMNS = `phase, pending_through_seq, settled_through_seq, current_generation_id,
  current_agent_turn_id, attempt, retry_count, claim_epoch, lease_expires_at, last_heartbeat_at,
  next_attempt_at, resume_policy, last_error_code, last_error_message, updated_at`;

export function readDriver(storage: DurableObjectStorage): DriverState {
  const rows = storage.sql
    .exec<DriverRow>(`SELECT ${DRIVER_COLUMNS} FROM agent_driver WHERE singleton = 1`)
    .toArray();
  if (rows.length === 0) {
    // ensureSchema seeds this row, so its absence means the object is running
    // code that never applied schema v2. Failing loudly beats inventing a zero
    // watermark, which would treat the whole history as pending input.
    throw new SessionError("agent driver row is missing; schema v2 was not applied");
  }
  const row = rows[0];
  return {
    phase: row.phase,
    pendingThroughSeq: row.pending_through_seq,
    settledThroughSeq: row.settled_through_seq,
    generationId: row.current_generation_id,
    agentTurnId: row.current_agent_turn_id,
    attempt: row.attempt,
    retryCount: row.retry_count,
    claimEpoch: row.claim_epoch,
    leaseExpiresAt: row.lease_expires_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    nextAttemptAt: row.next_attempt_at,
    resumePolicy: row.resume_policy,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    updatedAt: row.updated_at,
  };
}

/** True when the loop owes an answer to input above the settled watermark. */
export function hasPendingInput(storage: DurableObjectStorage): boolean {
  const driver = readDriver(storage);
  return driver.pendingThroughSeq > driver.settledThroughSeq;
}

type GenerationRow = {
  id: string;
  agent_turn_id: string;
  state: GenerationState;
  first_input_seq: number;
  included_through_seq: number;
  settled_through_seq: number | null;
  attempt_count: number;
  step_count: number;
  cost_nano_usd: number;
  memory_projection_state: MemoryProjectionState;
  started_at: number | null;
  finished_at: number | null;
  resume_policy: ResumePolicy | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: number;
  updated_at: number;
};

const GENERATION_COLUMNS = `id, agent_turn_id, state, first_input_seq, included_through_seq,
  settled_through_seq, attempt_count, step_count, cost_nano_usd, memory_projection_state,
  started_at, finished_at, resume_policy, last_error_code, last_error_message,
  created_at, updated_at`;

function toGeneration(row: GenerationRow): GenerationRecord {
  return {
    id: row.id,
    agentTurnId: row.agent_turn_id,
    state: row.state,
    firstInputSeq: row.first_input_seq,
    includedThroughSeq: row.included_through_seq,
    settledThroughSeq: row.settled_through_seq,
    attemptCount: row.attempt_count,
    stepCount: row.step_count,
    costNanoUsd: row.cost_nano_usd,
    memoryProjectionState: row.memory_projection_state,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    resumePolicy: row.resume_policy,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function readGeneration(
  storage: DurableObjectStorage,
  generationId: string,
): GenerationRecord | null {
  const rows = storage.sql
    .exec<GenerationRow>(
      `SELECT ${GENERATION_COLUMNS} FROM agent_generations WHERE id = ?`,
      generationId,
    )
    .toArray();
  return rows.length > 0 ? toGeneration(rows[0]) : null;
}

/**
 * Is this claim still the current one?
 *
 * The `phase = 'running'` term matters as much as the epoch: after a settle the
 * epoch is untouched but the driver is idle, so a callback that arrives late
 * from the attempt that just finished is refused rather than appending to a
 * conversation that has already ended.
 */
function isCurrentClaim(storage: DurableObjectStorage, fence: ClaimFence): boolean {
  return (
    storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM agent_driver
         WHERE singleton = 1 AND phase = 'running'
           AND current_generation_id = ? AND claim_epoch = ?`,
        fence.generationId,
        fence.claimEpoch,
      )
      .one().n > 0
  );
}

/**
 * The guard every capability and callback calls before doing host work. Exposed
 * as an outcome rather than a boolean so a caller cannot accidentally treat
 * "unknown" as "fine".
 */
export function checkClaim(storage: DurableObjectStorage, fence: ClaimFence): ClaimCheckOutcome {
  return isCurrentClaim(storage, fence) ? { outcome: "current" } : { outcome: "stale_claim" };
}

/**
 * Take ownership of the scheduled generation, or reclaim one whose lease has
 * expired. This is the single-flight gate: a duplicate alarm, a concurrent kick
 * and a crash-recovery wake all arrive here, and only one of them leaves with a
 * claim (invariant 10).
 *
 * Synchronous from the first read to the last write, so there is no `await`
 * between "phase is scheduled" and "phase is running" for a second caller to
 * slip through.
 */
export function claimGeneration(
  storage: DurableObjectStorage,
  options: { now?: number; leaseMs?: number } = {},
): ClaimOutcome {
  const now = options.now ?? Date.now();
  const leaseMs = options.leaseMs ?? CLAIM_LEASE_MS;

  return storage.transactionSync(() => {
    const driver = readDriver(storage);
    if (driver.phase !== "scheduled" && driver.phase !== "running") {
      return { outcome: "nothing_scheduled", phase: driver.phase };
    }
    if (!driver.generationId || !driver.agentTurnId) {
      return { outcome: "nothing_scheduled", phase: driver.phase };
    }
    if (driver.phase === "running" && (driver.leaseExpiresAt ?? 0) > now) {
      // A live lease. The provider stream that holds it is still the only one.
      return {
        outcome: "already_running",
        generationId: driver.generationId,
        leaseExpiresAt: driver.leaseExpiresAt ?? 0,
      };
    }
    if (driver.phase === "scheduled" && driver.nextAttemptAt > now) {
      // Inside a retry backoff. The gate is HERE rather than in the alarm
      // because alarm delivery is at-least-once: a dispatcher-side check would
      // be bypassed by a redelivery, and the whole retry budget would be spent
      // in the milliseconds it takes to redeliver three times.
      return {
        outcome: "backoff",
        generationId: driver.generationId,
        nextAttemptAt: driver.nextAttemptAt,
      };
    }

    const attempt = driver.attempt + 1;
    const claimEpoch = driver.claimEpoch + 1;
    const leaseExpiresAt = now + leaseMs;

    storage.sql.exec(
      `UPDATE agent_driver SET
         phase = 'running', attempt = ?, claim_epoch = ?, lease_expires_at = ?,
         last_heartbeat_at = ?, next_attempt_at = 0, resume_policy = NULL,
         last_error_code = NULL, last_error_message = NULL, updated_at = ?
       WHERE singleton = 1`,
      attempt,
      claimEpoch,
      leaseExpiresAt,
      now,
      now,
    );
    storage.sql.exec(
      `UPDATE agent_generations SET
         state = 'running', attempt_count = attempt_count + 1,
         started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ?`,
      now,
      now,
      driver.generationId,
    );

    const generation = readGeneration(storage, driver.generationId);
    if (!generation) throw new SessionError(`generation ${driver.generationId} is missing`);

    const claim: ClaimSnapshot = {
      fence: { generationId: generation.id, claimEpoch },
      generationId: generation.id,
      agentTurnId: generation.agentTurnId,
      attempt,
      // Read, never incremented here. A claim is not a retry.
      retryCount: driver.retryCount,
      firstInputSeq: generation.firstInputSeq,
      includedThroughSeq: generation.includedThroughSeq,
      pendingThroughSeq: driver.pendingThroughSeq,
      stepCount: generation.stepCount,
      costNanoUsd: generation.costNanoUsd,
      leaseExpiresAt,
    };
    return { outcome: "claimed", claim };
  });
}

/**
 * Renew the lease mid-stream. Heartbeats exist so a long provider read does not
 * look like a crash; they are not model context and never become RunEvents
 * (invariant 22).
 */
export function heartbeat(
  storage: DurableObjectStorage,
  fence: ClaimFence,
  options: { now?: number; leaseMs?: number } = {},
): HeartbeatOutcome {
  const now = options.now ?? Date.now();
  const leaseMs = options.leaseMs ?? CLAIM_LEASE_MS;
  const leaseExpiresAt = now + leaseMs;

  return storage.transactionSync(() => {
    const written = storage.sql.exec(
      `UPDATE agent_driver SET lease_expires_at = ?, last_heartbeat_at = ?, updated_at = ?
       WHERE singleton = 1 AND phase = 'running'
         AND current_generation_id = ? AND claim_epoch = ?`,
      leaseExpiresAt,
      now,
      now,
      fence.generationId,
      fence.claimEpoch,
    ).rowsWritten;
    if (written === 0) return { outcome: "stale_claim" };

    // A heartbeat boundary is a good moment to let recency reach D1, since the
    // stream itself deliberately does not project per batch.
    touchRunIndex(storage, now);
    return { outcome: "renewed", leaseExpiresAt };
  });
}

// --- model transcript -------------------------------------------------------

export const TRANSCRIPT_PAGE_DEFAULT = 200;

export type InputMessageEntry = {
  /** The RunEvent seq of the turn this message renders. */
  sourceEventSeq: number;
  message: unknown;
};

export type TranscriptEntry = {
  ordinal: number;
  generationId: string;
  attempt: number;
  globalStep: number;
  kind: "input" | "response";
  sourceEventSeq: number | null;
  message: unknown;
};

/**
 * Put pending input into the transcript, exactly once each, and advance the
 * generation's included cursor in the same transaction.
 *
 * Once-only is enforced by the unique index on `source_event_seq`, not by the
 * caller remembering: an at-least-once alarm that re-renders the same turn
 * inserts nothing the second time, and the cursor still ends up in the right
 * place (invariant 13).
 */
export function appendInputMessages(
  storage: DurableObjectStorage,
  fence: ClaimFence,
  input: { globalStep: number; messages: InputMessageEntry[]; now?: number },
): InputMessagesOutcome {
  const now = input.now ?? Date.now();

  return storage.transactionSync(() => {
    if (!isCurrentClaim(storage, fence)) return { outcome: "stale_claim" };

    const generation = readGeneration(storage, fence.generationId);
    if (!generation) return { outcome: "stale_claim" };
    if (input.messages.length === 0) {
      return { outcome: "noop", includedThroughSeq: generation.includedThroughSeq };
    }

    // Input messages continue the step's existing indexes rather than restarting
    // at zero: a second batch of newly arrived turns at the same step must not
    // collide with the first batch and be silently dropped.
    const base = storage.sql
      .exec<{ next: number }>(
        `SELECT COALESCE(MAX(message_index), -1) + 1 AS next FROM model_messages
         WHERE generation_id = ? AND global_step = ? AND kind = 'input'`,
        fence.generationId,
        input.globalStep,
      )
      .one().next;

    const attempt = readDriver(storage).attempt;
    let inserted = 0;
    let includedThroughSeq = generation.includedThroughSeq;
    input.messages.forEach((entry, offset) => {
      if (!Number.isInteger(entry.sourceEventSeq) || entry.sourceEventSeq <= 0) {
        throw new SessionError("input message sourceEventSeq must be a positive integer");
      }
      const written = storage.sql.exec(
        `INSERT INTO model_messages
           (generation_id, attempt, global_step, message_index, kind, source_event_seq,
            claim_epoch, message_json, created_at)
         VALUES (?, ?, ?, ?, 'input', ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        fence.generationId,
        attempt,
        input.globalStep,
        base + offset,
        entry.sourceEventSeq,
        fence.claimEpoch,
        serializeMessage(entry.message),
        now,
      ).rowsWritten;
      if (written > 0) inserted += 1;
      includedThroughSeq = Math.max(includedThroughSeq, entry.sourceEventSeq);
    });

    storage.sql.exec(
      `UPDATE agent_generations SET included_through_seq = ?, updated_at = ? WHERE id = ?`,
      includedThroughSeq,
      now,
      fence.generationId,
    );

    return {
      outcome: "inserted",
      inserted,
      skipped: input.messages.length - inserted,
      includedThroughSeq,
    };
  });
}

/**
 * Persist the assistant/tool messages one completed step produced.
 *
 * Keyed by (generation, global step), so replaying a step after a crash between
 * the provider's response and this write is a no-op rather than a second copy
 * of the same tool call in the model's own history (invariant 9).
 */
export function checkpointStepMessages(
  storage: DurableObjectStorage,
  fence: ClaimFence,
  input: { globalStep: number; messages: unknown[]; now?: number },
): StepCheckpointOutcome {
  const now = input.now ?? Date.now();

  return storage.transactionSync(() => {
    if (!isCurrentClaim(storage, fence)) return { outcome: "stale_claim" };

    return writeStepMessages(storage, fence, input.globalStep, input.messages, now);
  });
}

/**
 * The step-checkpoint writer, factored out for the same reason `writeTurn` is:
 * `finalizeAnswer` must persist the terminal step's response messages inside
 * the one atomic transaction that also appends the final turn and settles the
 * generation. Callers own the transaction and the claim check.
 */
function writeStepMessages(
  storage: DurableObjectStorage,
  fence: ClaimFence,
  globalStep: number,
  messages: readonly unknown[],
  now: number,
): StepCheckpointOutcome {
  const already = storage.sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM model_messages
       WHERE generation_id = ? AND global_step = ? AND kind = 'response'`,
      fence.generationId,
      globalStep,
    )
    .one().n;
  if (already > 0) return { outcome: "already_checkpointed" };

  const attempt = readDriver(storage).attempt;
  messages.forEach((message, index) => {
    storage.sql.exec(
      `INSERT INTO model_messages
         (generation_id, attempt, global_step, message_index, kind, source_event_seq,
          claim_epoch, message_json, created_at)
       VALUES (?, ?, ?, ?, 'response', NULL, ?, ?, ?)`,
      fence.generationId,
      attempt,
      globalStep,
      index,
      fence.claimEpoch,
      serializeMessage(message),
      now,
    );
  });

  storage.sql.exec(
    `UPDATE agent_generations SET
       step_count = MAX(step_count, ?), updated_at = ?
     WHERE id = ?`,
    globalStep + 1,
    now,
    fence.generationId,
  );
  return { outcome: "checkpointed", inserted: messages.length };
}

/**
 * The model's own history, oldest first, bounded.
 *
 * Reads across generations on purpose: one Slack thread is one conversation,
 * and the second generation's model call needs what the first one said. The
 * inner descending query takes the NEWEST rows — the opposite mistake to
 * Phase 08's `listTurns`, which would feed the model the start of a long run
 * and none of its recent context.
 */
export function readModelTranscript(
  storage: DurableObjectStorage,
  limit = TRANSCRIPT_PAGE_DEFAULT,
): TranscriptEntry[] {
  const size = clampPage(limit);
  return storage.sql
    .exec<{
      ordinal: number;
      generation_id: string;
      attempt: number;
      global_step: number;
      kind: "input" | "response";
      source_event_seq: number | null;
      message_json: string;
    }>(
      `SELECT ordinal, generation_id, attempt, global_step, kind, source_event_seq, message_json
       FROM (
         SELECT ordinal, generation_id, attempt, global_step, kind, source_event_seq, message_json
         FROM model_messages ORDER BY ordinal DESC LIMIT ?
       ) ORDER BY ordinal ASC`,
      size,
    )
    .toArray()
    .map((row) => ({
      ordinal: row.ordinal,
      generationId: row.generation_id,
      attempt: row.attempt,
      globalStep: row.global_step,
      kind: row.kind,
      sourceEventSeq: row.source_event_seq,
      message: JSON.parse(row.message_json) as unknown,
    }));
}

function serializeMessage(message: unknown): string {
  const json = JSON.stringify(message);
  if (typeof json !== "string") {
    throw new SessionError("model message must be JSON-serializable");
  }
  return json;
}

// --- step usage -------------------------------------------------------------

/**
 * Record one billed model step, locally, first.
 *
 * THIS FUNCTION DELIBERATELY TAKES NO CLAIM FENCE.
 *
 * Everything else an expired claimant tries to do is refused: it cannot append
 * to the transcript, emit an assistant update, start a capability or settle the
 * generation. But if its provider request had already been billed when its
 * lease ran out, the money is spent whether or not the answer was used. Dropping
 * that row because the claim moved on would make the run's own cost ledger
 * quietly understate reality — and the run spend ceiling is enforced from this
 * ledger. So usage is attempt-scoped and idempotent, and it is the ONE thing a
 * stale claimant may still write (invariant 10).
 *
 * `(generation, attempt, step)` is the key, so a replay of the same step cannot
 * double its cost, while a genuinely different attempt is a distinct billed
 * call — because it was.
 */
export function recordStepUsage(
  storage: DurableObjectStorage,
  input: StepUsageInput,
  now = Date.now(),
): UsageOutcome {
  validateUsageInput(input);
  const id = usageRowIdFor(input.generationId, input.attempt, input.globalStep);

  return storage.transactionSync(() => {
    const written = storage.sql.exec(
      `INSERT INTO model_step_usage
         (id, generation_id, agent_turn_id, attempt, global_step, provider, model,
          provider_request_id, gateway_log_id, usage_json, cost_nano_usd, latency_ms,
          finish_reason, raw_finish_reason, error_code, d1_projected_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT DO NOTHING`,
      id,
      input.generationId,
      input.agentTurnId,
      input.attempt,
      input.globalStep,
      input.provider,
      input.model,
      input.providerRequestId ?? null,
      input.gatewayLogId ?? null,
      JSON.stringify(input.usage),
      input.costNanoUsd,
      input.latencyMs,
      input.finishReason ?? null,
      input.rawFinishReason ?? null,
      input.errorCode ?? null,
      now,
    ).rowsWritten;

    if (written === 0) return { outcome: "duplicate", id };

    // The generation's running total, for the run spend ceiling. Unconditional
    // on the claim for the same reason the row itself is.
    storage.sql.exec(
      `UPDATE agent_generations SET cost_nano_usd = cost_nano_usd + ?, updated_at = ? WHERE id = ?`,
      input.costNanoUsd,
      now,
      input.generationId,
    );
    enqueueProjectionJob(storage, "d1_usage", id, now);
    return { outcome: "recorded", id };
  });
}

function validateUsageInput(input: StepUsageInput): void {
  const integers: [string, number][] = [
    ["attempt", input.attempt],
    ["globalStep", input.globalStep],
    ["costNanoUsd", input.costNanoUsd],
    ["latencyMs", input.latencyMs],
    ["inputTokens", input.usage.inputTokens],
    ["noCacheTokens", input.usage.noCacheTokens],
    ["cacheReadTokens", input.usage.cacheReadTokens],
    ["cacheWriteTokens", input.usage.cacheWriteTokens],
    ["outputTokens", input.usage.outputTokens],
    ["reasoningTokens", input.usage.reasoningTokens],
    ["totalTokens", input.usage.totalTokens],
  ];
  for (const [name, value] of integers) {
    if (!Number.isInteger(value) || value < 0) {
      throw new SessionError(`${name} must be a non-negative integer`);
    }
  }
  if (input.provider.length === 0 || input.model.length === 0) {
    throw new SessionError("usage provider and model must be non-empty");
  }
}

type UsageRow = {
  id: string;
  generation_id: string;
  agent_turn_id: string;
  attempt: number;
  global_step: number;
  provider: string;
  model: string;
  provider_request_id: string | null;
  gateway_log_id: string | null;
  usage_json: string;
  cost_nano_usd: number;
  latency_ms: number;
  finish_reason: string | null;
  raw_finish_reason: string | null;
  error_code: string | null;
  d1_projected_at: number | null;
  created_at: number;
};

function toUsageRecord(row: UsageRow): StepUsageRecord {
  return {
    id: row.id,
    generationId: row.generation_id,
    agentTurnId: row.agent_turn_id,
    attempt: row.attempt,
    globalStep: row.global_step,
    provider: row.provider,
    model: row.model,
    providerRequestId: row.provider_request_id,
    gatewayLogId: row.gateway_log_id,
    usage: JSON.parse(row.usage_json) as NormalizedUsage,
    costNanoUsd: row.cost_nano_usd,
    latencyMs: row.latency_ms,
    finishReason: row.finish_reason,
    rawFinishReason: row.raw_finish_reason,
    errorCode: row.error_code,
    d1ProjectedAt: row.d1_projected_at,
    createdAt: row.created_at,
  };
}

const USAGE_COLUMNS = `id, generation_id, agent_turn_id, attempt, global_step, provider, model,
  provider_request_id, gateway_log_id, usage_json, cost_nano_usd, latency_ms, finish_reason,
  raw_finish_reason, error_code, d1_projected_at, created_at`;

/** Local rows D1 has not accepted yet. A D1 outage leaves them here, pending. */
export function listPendingUsageProjections(
  storage: DurableObjectStorage,
  limit = 50,
): StepUsageRecord[] {
  return storage.sql
    .exec<UsageRow>(
      `SELECT ${USAGE_COLUMNS} FROM model_step_usage
       WHERE d1_projected_at IS NULL ORDER BY created_at ASC, id ASC LIMIT ?`,
      clampPage(limit),
    )
    .toArray()
    .map(toUsageRecord);
}

export function readStepUsage(
  storage: DurableObjectStorage,
  id: string,
): StepUsageRecord | null {
  const rows = storage.sql
    .exec<UsageRow>(`SELECT ${USAGE_COLUMNS} FROM model_step_usage WHERE id = ?`, id)
    .toArray();
  return rows.length > 0 ? toUsageRecord(rows[0]) : null;
}

export function markUsageProjected(
  storage: DurableObjectStorage,
  id: string,
  at = Date.now(),
): { outcome: "marked" | "already_projected" | "unknown" } {
  const written = storage.sql.exec(
    "UPDATE model_step_usage SET d1_projected_at = ? WHERE id = ? AND d1_projected_at IS NULL",
    at,
    id,
  ).rowsWritten;
  if (written > 0) return { outcome: "marked" };

  const exists = storage.sql
    .exec<{ n: number }>("SELECT COUNT(*) AS n FROM model_step_usage WHERE id = ?", id)
    .one().n;
  return exists > 0 ? { outcome: "already_projected" } : { outcome: "unknown" };
}

/** Total local spend for this run, in nano-USD. The spend ceiling reads this. */
/**
 * How many model steps this run has completed, locally.
 *
 * The local row is the system of record (invariant 32): a step counted here has
 * been billed whether or not its D1 projection has landed yet, which is exactly
 * what the live snapshot should show while telemetry lags.
 */
export function countModelSteps(storage: DurableObjectStorage): number {
  return storage.sql
    .exec<{ steps: number }>("SELECT COUNT(*) AS steps FROM model_step_usage")
    .one().steps;
}

export function totalCostNanoUsd(storage: DurableObjectStorage): number {
  return storage.sql
    .exec<{ total: number }>(
      "SELECT COALESCE(SUM(cost_nano_usd), 0) AS total FROM model_step_usage",
    )
    .one().total;
}

// --- assistant updates ------------------------------------------------------

/**
 * Append one assistant batch to the replayable event stream.
 *
 * The batch id is derived here, from generation/attempt/batchSeq, never taken
 * from the caller or the provider: that is what makes an at-least-once retry
 * return the ORIGINAL sequence instead of showing the customer the same
 * sentence twice.
 *
 * The persisted update is rebuilt field by field, so a caller that happens to
 * hold a provider chunk with `reasoning`, `thinking` or a raw body on it cannot
 * leak any of that into the durable stream (invariant 18).
 */
export function appendAssistantUpdate(
  storage: DurableObjectStorage,
  fence: ClaimFence,
  input: AssistantUpdateInput,
  now = Date.now(),
): AssistantUpdateOutcome {
  validateAssistantUpdate(input);
  requireState(storage);

  const id = assistantUpdateIdFor(input.generationId, input.attempt, input.batchSeq);

  return storage.transactionSync(() => {
    const existing = storage.sql
      .exec<{ event_seq: number }>("SELECT event_seq FROM assistant_batches WHERE id = ?", id)
      .toArray();
    // Checked BEFORE the fence: a redelivered batch is answered with what was
    // already committed, whoever asks. It mutates nothing.
    if (existing.length > 0) {
      return { outcome: "replayed", event: eventAt(storage, existing[0].event_seq) };
    }

    if (input.generationId !== fence.generationId || !isCurrentClaim(storage, fence)) {
      return { outcome: "stale_claim" };
    }

    return { outcome: "appended", event: writeAssistantBatch(storage, input, now) };
  });
}

/**
 * The assistant-batch writer. Callers own the transaction, the replay check and
 * the claim check.
 *
 * Factored out so `finalizeAnswer` can flush the trailing partial delta and
 * append the terminal `completed` update inside the same transaction that
 * appends the final turn — which is what makes "the customer's draft is
 * replaced by exactly one durable turn" atomic rather than a sequence of
 * separate commits a crash can land in the middle of.
 */
function writeAssistantBatch(
  storage: DurableObjectStorage,
  input: AssistantUpdateInput,
  now: number,
): RunEvent {
  const createdAt = input.createdAt ?? now;
  const update: AssistantUpdate = {
    id: assistantUpdateIdFor(input.generationId, input.attempt, input.batchSeq),
    generationId: input.generationId,
    attempt: input.attempt,
    state: input.state,
    ...(input.delta !== undefined ? { delta: input.delta.slice(0, ASSISTANT_DELTA_MAX) } : {}),
    ...(input.error !== undefined ? { error: input.error.slice(0, ASSISTANT_ERROR_MAX) } : {}),
    createdAt,
  };
  const seq = nextSeq(storage);
  const event: RunEvent = { seq, type: "assistant_update", update };

  writeEvent(storage, event, createdAt);
  storage.sql.exec(
    `INSERT INTO assistant_batches (id, generation_id, attempt, event_seq, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    update.id,
    update.generationId,
    update.attempt,
    seq,
    createdAt,
  );
  touchState(storage, createdAt);
  // Coalesced, never one projection per batch.
  touchRunIndex(storage, createdAt);
  return event;
}

function validateAssistantUpdate(input: AssistantUpdateInput): void {
  if (typeof input.generationId !== "string" || input.generationId.length === 0) {
    throw new SessionError("assistant update generationId must be a non-empty string");
  }
  if (!Number.isInteger(input.attempt) || input.attempt < 0) {
    throw new SessionError("assistant update attempt must be a non-negative integer");
  }
  if (!Number.isInteger(input.batchSeq) || input.batchSeq < 0) {
    throw new SessionError("assistant update batchSeq must be a non-negative integer");
  }
  if (!isAssistantUpdateState(input.state)) {
    throw new SessionError(`unknown assistant update state: ${String(input.state)}`);
  }
  if (input.delta !== undefined && typeof input.delta !== "string") {
    throw new SessionError("assistant update delta must be a string");
  }
  if (input.error !== undefined && typeof input.error !== "string") {
    throw new SessionError("assistant update error must be a string");
  }
}

// --- settlement -------------------------------------------------------------

/**
 * End this attempt: settle it, continue it, or reschedule it — atomically.
 *
 * The continuation case is the interesting one. If trusted input arrived above
 * the generation's included cursor while the model was answering, the answer is
 * already out of date, so the SAME generation continues rather than settling.
 * Keeping the generation keeps its Code Mode effect scope and transcript
 * coherent; allocating a new one would let the run repeat an external effect
 * it has already performed (invariants 8 and 14).
 *
 * Public `RunStatus` is deliberately NOT changed here. Deciding what the
 * customer-visible state becomes after a settle belongs to the driver, which
 * knows whether it is going idle, awaiting approval or failing.
 */
export function finalizeGeneration(
  storage: DurableObjectStorage,
  fence: ClaimFence,
  request: FinalizeRequest,
  now = Date.now(),
): FinalizeOutcome {
  return storage.transactionSync(() => {
    const generation = readGeneration(storage, fence.generationId);
    if (!generation) return { outcome: "stale_claim" };

    // Checked before the fence so a redelivered finalize of work THIS claim
    // already settled reads as settled, not as a stale claimant.
    if (isTerminalGenerationState(generation.state)) {
      return {
        outcome: "already_settled",
        generationId: generation.id,
        generationState: generation.state,
      };
    }
    if (!isCurrentClaim(storage, fence)) return { outcome: "stale_claim" };

    const driver = readDriver(storage);

    if (request.kind === "retry") {
      // The backoff is persisted, not slept: this attempt is over, and the next
      // one belongs to whichever alarm delivery arrives after `nextAttemptAt`.
      const nextAttemptAt = now + Math.max(0, Math.floor(request.retryAfterMs ?? 0));
      // The ONLY place the retry budget is spent. Claims do not spend it, and a
      // continuation does not spend it, because neither is a failure.
      const retryCount = driver.retryCount + 1;
      storage.sql.exec(
        `UPDATE agent_generations SET state = 'scheduled', updated_at = ? WHERE id = ?`,
        now,
        generation.id,
      );
      storage.sql.exec(
        `UPDATE agent_driver SET
           phase = 'scheduled', lease_expires_at = NULL, next_attempt_at = ?,
           retry_count = ?, resume_policy = 'retryable', last_error_code = ?,
           last_error_message = ?, updated_at = ?
         WHERE singleton = 1`,
        nextAttemptAt,
        retryCount,
        request.errorCode,
        truncateError(request.errorMessage),
        now,
      );
      return {
        outcome: "rescheduled",
        generationId: generation.id,
        attempt: driver.attempt,
        retryCount,
        nextAttemptAt,
      };
    }

    if (request.kind === "failed") {
      // The settled watermark deliberately does NOT move. The inputs this
      // generation was answering are still unanswered, so whatever legally
      // resumes the run must see them again.
      storage.sql.exec(
        `UPDATE agent_generations SET
           state = ?, resume_policy = ?, last_error_code = ?, last_error_message = ?,
           finished_at = ?, updated_at = ?
         WHERE id = ?`,
        request.state,
        request.resumePolicy,
        request.errorCode,
        truncateError(request.errorMessage),
        now,
        now,
        generation.id,
      );
      storage.sql.exec(
        `UPDATE agent_driver SET
           phase = 'failed', lease_expires_at = NULL, next_attempt_at = 0, resume_policy = ?,
           last_error_code = ?, last_error_message = ?, updated_at = ?
         WHERE singleton = 1`,
        request.resumePolicy,
        request.errorCode,
        truncateError(request.errorMessage),
        now,
      );

      // A failure is memory too, and arguably the more valuable half: "we were
      // asked this, we tried these things, and it ended as `refused`" is what
      // stops the next run repeating a dead end. There is no draft, because no
      // answer was selected — an episode never carries partial delta text.
      //
      // Same immutable freeze and same outbox job as the success path, so a
      // failed generation reaches Zep by exactly the mechanism a completed one
      // does, with no second projector to keep correct.
      const state = readState(storage);
      const outcome = episodeOutcomeFor(request.state);
      if (state !== null && outcome !== null) {
        persistGenerationEpisode(
          storage,
          generation.id,
          buildGenerationEpisodePayload(storage, {
            runId: state.runId,
            generationId: generation.id,
            agentTurnId: generation.agentTurnId,
            outcome,
            draft: "",
          }),
          now,
        );
        enqueueProjectionJob(
          storage,
          "memory_outbox",
          memoryOutboxIdFor(state.runId, generation.id),
          now,
        );
      }

      return {
        outcome: "settled",
        generationId: generation.id,
        generationState: request.state,
        driverPhase: "failed",
        settledThroughSeq: driver.settledThroughSeq,
      };
    }

    if (driver.pendingThroughSeq > generation.includedThroughSeq) {
      storage.sql.exec(
        `UPDATE agent_generations SET state = 'scheduled', updated_at = ? WHERE id = ?`,
        now,
        generation.id,
      );
      storage.sql.exec(
        // A continuation is not a retry: the input that arrived mid-answer is
        // waiting NOW, so there is deliberately no backoff on this path.
        `UPDATE agent_driver SET
           phase = 'scheduled', lease_expires_at = NULL, next_attempt_at = 0, updated_at = ?
         WHERE singleton = 1`,
        now,
      );
      return {
        outcome: "continued",
        generationId: generation.id,
        pendingThroughSeq: driver.pendingThroughSeq,
        includedThroughSeq: generation.includedThroughSeq,
      };
    }

    const settledThroughSeq = Math.max(driver.settledThroughSeq, driver.pendingThroughSeq);
    storage.sql.exec(
      `UPDATE agent_generations SET
         state = 'completed', settled_through_seq = ?, finished_at = ?, updated_at = ?
       WHERE id = ?`,
      settledThroughSeq,
      now,
      now,
      generation.id,
    );
    storage.sql.exec(
      `UPDATE agent_driver SET
         phase = 'idle', settled_through_seq = ?, current_generation_id = NULL,
         current_agent_turn_id = NULL, attempt = 0, retry_count = 0,
         lease_expires_at = NULL, next_attempt_at = 0, resume_policy = NULL,
         last_error_code = NULL,
         last_error_message = NULL,
         updated_at = ?
       WHERE singleton = 1`,
      settledThroughSeq,
      now,
    );
    return {
      outcome: "settled",
      generationId: generation.id,
      generationState: "completed",
      driverPhase: "idle",
      settledThroughSeq,
    };
  });
}

/**
 * Everything a settled successful answer must commit, in ONE transaction.
 *
 * This is the plan's eight-step finalization, and the reason it is one function
 * rather than eight calls is the failure it exists to make impossible: a crash
 * between "the final turn is durable" and "the generation is settled" leaves a
 * run that answers the same message twice, and a crash the other way round
 * leaves a settled generation with no answer in it at all.
 *
 * Ordered exactly as the plan lists them:
 *
 *  1. flush the trailing assistant delta;
 *  2. persist the terminal step's response messages if not already checkpointed;
 *  3. compare pending and included input cursors — atomically, which is the whole
 *     point: a steer that commits before this transaction opens is seen, and one
 *     that commits after it closes is ordered after the final;
 *  4. append `agent:{generation}:final` once;
 *  5. append the completed assistant update;
 *  6. update the concise local run summary;
 *  7. set generation completed, driver idle and the public run status idle;
 *  8. persist the immutable local `run_index` and `memory_outbox` projection jobs.
 *
 * NOTHING here touches D1, Zep, the network or an alarm. The projection jobs
 * written by step 8 are durable local rows; the alarm projector reads them
 * AFTER this transaction has committed. That is what makes "a D1 or vendor
 * failure cannot roll back or re-bill a completed local answer" a structural
 * property rather than a promise: there is no external call inside the
 * transaction that could fail it, and the projector cannot reach back in.
 */
export type FinalizeAnswerInput = {
  attempt: number;
  /** The terminal answer text. Only the terminal step's text; never narration. */
  finalText: string;
  /** The concise local run summary for the dashboard list. */
  summary: string;
  /**
   * Slack origin: the final turn is INTERNAL run narration, not a customer
   * message. Customer output happens only through `slack.reply` (invariant 4),
   * so the harness must never send this text.
   */
  internalNarration: boolean;
  /** Trailing buffered delta, flushed as step 1. Omitted when the buffer is empty. */
  pendingDelta?: string;
  /** Batch sequence for the trailing delta. Ignored when `pendingDelta` is absent. */
  deltaBatchSeq: number;
  /** Batch sequence for the terminal (`completed`/`superseded`) update. */
  terminalBatchSeq: number;
  /** The terminal provider step's index and response messages, for step 2. */
  globalStep: number;
  responseMessages?: readonly unknown[];
  now?: number;
};

export type FinalizeAnswerOutcome =
  | {
      outcome: "finalized";
      events: RunEvent[];
      turnId: string;
      settledThroughSeq: number;
    }
  | {
      /**
       * Fresher trusted input exists. The final is NOT appended and the
       * generation is NOT settled: the same generation continues, which is what
       * keeps its Code Mode effect scope coherent (invariant 14).
       */
      outcome: "superseded";
      events: RunEvent[];
      pendingThroughSeq: number;
      includedThroughSeq: number;
    }
  | { outcome: "already_final"; events: RunEvent[]; turnId: string }
  | { outcome: "stale_claim" };

export function finalizeAnswer(
  storage: DurableObjectStorage,
  fence: ClaimFence,
  input: FinalizeAnswerInput,
): FinalizeAnswerOutcome {
  const now = input.now ?? Date.now();
  const state = requireState(storage);
  const turnId = finalTurnIdFor(fence.generationId);

  return storage.transactionSync(() => {
    const generation = readGeneration(storage, fence.generationId);
    if (!generation) return { outcome: "stale_claim" };

    // Checked before the fence: a redelivered finalization of an answer this
    // generation already committed is answered with what is there, whoever asks.
    if (isTerminalGenerationState(generation.state)) {
      return { outcome: "already_final", events: [], turnId };
    }
    if (!isCurrentClaim(storage, fence)) return { outcome: "stale_claim" };

    const events: RunEvent[] = [];

    // 1. Flush the trailing partial batch.
    if (input.pendingDelta !== undefined && input.pendingDelta.length > 0) {
      events.push(
        writeAssistantBatch(
          storage,
          {
            generationId: fence.generationId,
            attempt: input.attempt,
            batchSeq: input.deltaBatchSeq,
            state: "streaming",
            delta: input.pendingDelta,
            createdAt: now,
          },
          now,
        ),
      );
    }

    // 2. Persist the terminal step's response messages, if the step checkpoint
    //    did not already. Idempotent by (generation, step).
    if (input.responseMessages && input.responseMessages.length > 0) {
      writeStepMessages(storage, fence, input.globalStep, input.responseMessages, now);
    }

    // 3. The atomic cursor compare.
    const driver = readDriver(storage);
    const included = readGeneration(storage, fence.generationId)?.includedThroughSeq
      ?? generation.includedThroughSeq;
    if (driver.pendingThroughSeq > included) {
      events.push(
        writeAssistantBatch(
          storage,
          {
            generationId: fence.generationId,
            attempt: input.attempt,
            batchSeq: input.terminalBatchSeq,
            state: "superseded",
            createdAt: now,
          },
          now,
        ),
      );
      return {
        outcome: "superseded",
        events,
        pendingThroughSeq: driver.pendingThroughSeq,
        includedThroughSeq: included,
      };
    }

    // 4. The final turn, exactly once. Its id comes from the generation, never
    //    from a provider message id (invariant 21).
    const turnResult = writeTurn(
      storage,
      {
        id: turnId,
        role: "assistant",
        source: "agent",
        content: input.finalText,
        metadata: {
          generationId: fence.generationId,
          attempt: input.attempt,
          // The harness reads THIS, not the origin, so a future surface cannot
          // acquire send rights by being added to an enum.
          delivery: input.internalNarration ? "internal_narration" : "visible",
        },
        createdAt: now,
      },
      now,
    );
    events.push(turnResult.event);

    // 5. The terminal assistant update. The client replaces its draft buffer
    //    with the durable turn above.
    events.push(
      writeAssistantBatch(
        storage,
        {
          generationId: fence.generationId,
          attempt: input.attempt,
          batchSeq: input.terminalBatchSeq,
          state: "completed",
          createdAt: now,
        },
        now,
      ),
    );

    // 6. The concise local run summary.
    if (state.summary !== input.summary) {
      storage.sql.exec(
        "UPDATE run_state SET summary = ?, updated_at = MAX(updated_at, ?) WHERE singleton = 1",
        input.summary,
        now,
      );
    }

    // 7. Generation completed, driver idle, run idle. The public status moves
    //    here rather than in a follow-up call so the dashboard can never show a
    //    live run whose generation has already settled.
    const settledThroughSeq = Math.max(driver.settledThroughSeq, driver.pendingThroughSeq);
    storage.sql.exec(
      `UPDATE agent_generations SET
         state = 'completed', settled_through_seq = ?, memory_projection_state = 'pending',
         finished_at = ?, updated_at = ?
       WHERE id = ?`,
      settledThroughSeq,
      now,
      now,
      generation.id,
    );
    storage.sql.exec(
      `UPDATE agent_driver SET
         phase = 'idle', settled_through_seq = ?, current_generation_id = NULL,
         current_agent_turn_id = NULL, attempt = 0, retry_count = 0,
         lease_expires_at = NULL, next_attempt_at = 0, resume_policy = NULL,
         last_error_code = NULL, last_error_message = NULL, updated_at = ?
       WHERE singleton = 1`,
      settledThroughSeq,
      now,
    );

    const current = readState(storage);
    if (current && current.status !== "idle") {
      const verdict = evaluateTransition(current.status, "idle");
      if (verdict.ok && verdict.changed) {
        events.push(writeStatusEvent(storage, current.status, "idle", now));
      }
    }

    // 8. The immutable local projection jobs. `writeStatusEvent` already wrote a
    //    run-index revision when the status moved; a settle that changed no
    //    status still needs one, because the summary above did change.
    if (events[events.length - 1]?.type !== "status") writeRunIndexRevision(storage, now);

    // The immutable episode, frozen in the SAME transaction as the answer it
    // describes. Not in the projector: a projector reads state that has already
    // moved on, and an episode assembled after the fact would drift from the
    // answer the customer actually received.
    persistGenerationEpisode(
      storage,
      generation.id,
      buildGenerationEpisodePayload(storage, {
        runId: state.runId,
        generationId: generation.id,
        agentTurnId: generation.agentTurnId,
        outcome: "completed",
        // The SELECTED final draft — the same string that just became the
        // durable final turn. Never the delta buffer, and never narration
        // from an earlier step.
        draft: input.finalText,
      }),
      now,
    );
    enqueueProjectionJob(
      storage,
      "memory_outbox",
      memoryOutboxIdFor(state.runId, generation.id),
      now,
    );

    return { outcome: "finalized", events, turnId, settledThroughSeq };
  });
}

/* ------------------------------------------------- the agent's own memory -- */

/**
 * Register bounded trusted provenance from a tool read.
 *
 * Called by the capability layer, synchronously, as part of the read that
 * produced the ids. `INSERT OR IGNORE` because a generation retries: the same
 * `memory.recall` in attempt two must add nothing.
 */
export function recordGenerationSources(
  storage: DurableObjectStorage,
  generationId: string,
  sources: readonly EpisodeSourceDescriptor[],
  now = Date.now(),
): void {
  for (const source of boundSources(sources)) {
    storage.sql.exec(
      `INSERT OR IGNORE INTO agent_source_records (generation_id, kind, ref, turn_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      generationId,
      source.kind,
      source.ref,
      source.turnId ?? null,
      now,
    );
  }
}

export function listGenerationSources(
  storage: DurableObjectStorage,
  generationId: string,
): EpisodeSourceDescriptor[] {
  return storage.sql
    .exec<{ kind: EpisodeSourceDescriptor["kind"]; ref: string; turn_id: string | null }>(
      `SELECT kind, ref, turn_id FROM agent_source_records
        WHERE generation_id = ? ORDER BY created_at ASC, ref ASC`,
      generationId,
    )
    .toArray()
    .map((row) =>
      row.turn_id === null
        ? { kind: row.kind, ref: row.ref }
        : { kind: row.kind, ref: row.ref, turnId: row.turn_id },
    );
}

/** Escape the LIKE metacharacters in a value that is matched as a prefix. */
function escapeLikePrefix(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * What the agent was ASKED, from the input turns this generation actually
 * consumed — and, for each one that came from Slack, a source descriptor
 * pointing at the stored message.
 *
 * The join is through `model_messages`, not through a sequence range, because
 * that table records exactly which RunEvents entered the transcript. A steer
 * that arrived mid-answer and was included is in the ask; one that arrived
 * after the final and started a new generation is not.
 */
function readAsked(
  storage: DurableObjectStorage,
  generationId: string,
): { asked: string; sources: EpisodeSourceDescriptor[] } {
  const rows = storage.sql
    .exec<{ id: string; content: string; metadata_json: string | null }>(
      `SELECT t.id, t.content, t.metadata_json
         FROM model_messages mm JOIN turns t ON t.event_seq = mm.source_event_seq
        WHERE mm.generation_id = ? AND mm.kind = 'input'
        ORDER BY mm.source_event_seq ASC`,
      generationId,
    )
    .toArray();

  const parts: string[] = [];
  const sources: EpisodeSourceDescriptor[] = [];
  for (const row of rows) {
    parts.push(row.content);
    if (row.metadata_json === null) continue;
    let metadata: unknown;
    try {
      metadata = JSON.parse(row.metadata_json);
    } catch {
      continue;
    }
    if (metadata === null || typeof metadata !== "object") continue;
    const eventId = (metadata as Record<string, unknown>).eventId;
    // A Chat turn carries no `eventId`, so it contributes NO source — which is
    // the structural half of "a Chat question's own input is not accepted as
    // the source for facts learned from customer memory or search".
    if (typeof eventId === "string" && eventId.length > 0) {
      sources.push({ kind: "run_turn", ref: eventId, turnId: row.id });
    }
  }

  return { asked: parts.join("\n\n"), sources };
}

/**
 * What the agent DID, from the durable capability audit.
 *
 * Names and stable error CODES only. The audit's `output` column already holds
 * sizes rather than content, and even that is not read here — an episode records
 * that `supabase.query` happened, never what it returned (invariant 33).
 */
function readActions(storage: DurableObjectStorage, generationId: string): string[] {
  const rows = storage.sql
    .exec<{ name: string; state: string; error: string | null }>(
      `SELECT name, state, error FROM tool_updates
        WHERE id LIKE ? ESCAPE '\\' AND state IN ('completed', 'failed') AND name <> 'run_code'
        ORDER BY event_seq ASC`,
      `tool:${escapeLikePrefix(generationId)}:%`,
    )
    .toArray();

  return rows.map((row) =>
    describeAction({
      name: row.name,
      state: row.state === "failed" ? "failed" : "completed",
      // The wire form is `code: message` and the message half can be anything a
      // vendor wrote. Only the code — a stable token this system defines —
      // reaches memory.
      errorCode: row.error === null ? null : row.error.split(":", 1)[0],
    }),
  );
}

/**
 * The episode for one settled generation, assembled from durable local state.
 *
 * Built from tables rather than from whatever the continuation happened to be
 * holding, which is what makes it DETERMINISTIC: re-finalizing the same
 * generation reads the same rows and produces the same payload, so the outbox
 * row it is written into can be immutable.
 */
export function buildGenerationEpisodePayload(
  storage: DurableObjectStorage,
  input: {
    runId: string;
    generationId: string;
    agentTurnId: string;
    outcome: EpisodeOutcome;
    /** The SELECTED final draft. Empty for a generation that never produced one. */
    draft: string;
  },
): AgentEpisodePayload {
  const { asked, sources } = readAsked(storage, input.generationId);
  return buildAgentEpisode({
    runId: input.runId,
    agentTurnId: input.agentTurnId,
    outcome: input.outcome,
    asked,
    actions: readActions(storage, input.generationId),
    draft: input.draft,
    // TOOL READS FIRST, input turns second, and the order is load-bearing.
    //
    // `source_index` is assigned densely in this order and `cite()` takes the
    // lowest resolvable index, so whatever sits at index 0 becomes the
    // citation. Input turns first meant a Slack episode cited the customer's
    // own question — "why are exports empty?" — instead of the engineer's
    // message the answer was actually built on, because a Slack input turn
    // carries an `eventId` and therefore always resolved.
    //
    // That is the same failure the memory contract names for Chat, surviving on
    // the Slack surface. It was invisible in the Chat test precisely because a
    // Chat turn produces no descriptor to out-rank the evidence — which made
    // that guarantee accidental. This ordering makes it structural on both
    // surfaces: evidence outranks the question, always.
    //
    // Input turns are still recorded. They are what the agent was ANSWERING,
    // which is worth keeping as provenance; they are simply not the first
    // thing to cite when real evidence exists.
    sources: [...listGenerationSources(storage, input.generationId), ...sources],
  });
}

/**
 * Freeze the episode onto the generation, ONCE.
 *
 * `WHERE memory_episode_json IS NULL` is the immutability rule as a condition
 * rather than a convention. A re-finalization — a redelivered alarm, a crash
 * retry that reaches finalization twice — recomputes an identical payload and
 * writes nothing, and a Phase 11 approval edit that later reuses this outbox
 * cannot silently rewrite what Zep has already ingested.
 */
export function persistGenerationEpisode(
  storage: DurableObjectStorage,
  generationId: string,
  payload: AgentEpisodePayload,
  now: number,
): void {
  storage.sql.exec(
    `UPDATE agent_generations
        SET memory_episode_json = ?, memory_source_json = ?,
            memory_projection_state = 'pending', updated_at = ?
      WHERE id = ? AND memory_episode_json IS NULL`,
    JSON.stringify(payload.episode),
    JSON.stringify(payload.sources),
    now,
    generationId,
  );
}

export type GenerationMemory = {
  generationId: string;
  agentTurnId: string;
  episodeJson: string;
  sourceJson: string;
  state: MemoryProjectionState;
};

/** The frozen payload, for the projector that carries it to D1. */
export function readGenerationMemory(
  storage: DurableObjectStorage,
  generationId: string,
): GenerationMemory | null {
  const rows = storage.sql
    .exec<{
      id: string;
      agent_turn_id: string;
      memory_episode_json: string | null;
      memory_source_json: string | null;
      memory_projection_state: MemoryProjectionState;
    }>(
      `SELECT id, agent_turn_id, memory_episode_json, memory_source_json, memory_projection_state
         FROM agent_generations WHERE id = ?`,
      generationId,
    )
    .toArray();
  const row = rows[0];
  if (!row || row.memory_episode_json === null) return null;
  return {
    generationId: row.id,
    agentTurnId: row.agent_turn_id,
    episodeJson: row.memory_episode_json,
    sourceJson: row.memory_source_json ?? "[]",
    state: row.memory_projection_state,
  };
}

/**
 * Record that D1 has taken ownership of this generation's episode.
 *
 * "Projected" here means HANDED OFF, not ingested: the D1 outbox row exists and
 * the queue job has been sent. Whether Zep has the episode is the outbox row's
 * business, not this object's — and deliberately so, because a RunDO that
 * tracked vendor state would be a second authority over the same fact.
 */
export function markGenerationMemoryProjected(
  storage: DurableObjectStorage,
  generationId: string,
  now = Date.now(),
): void {
  storage.sql.exec(
    `UPDATE agent_generations SET memory_projection_state = 'projected', updated_at = ?
      WHERE id = ? AND memory_projection_state = 'pending'`,
    now,
    generationId,
  );
}

/** How a settled generation's state reads as an episode outcome. */
export function episodeOutcomeFor(state: GenerationState): EpisodeOutcome | null {
  switch (state) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "refused":
      return "refused";
    case "budget_exhausted":
      return "budget_exhausted";
    default:
      return null;
  }
}

function truncateError(message: string | undefined): string | null {
  return message === undefined ? null : message.slice(0, ASSISTANT_ERROR_MAX);
}

// --- helpers ---------------------------------------------------------------

function touchState(storage: DurableObjectStorage, at: number): void {
  storage.sql.exec(
    "UPDATE run_state SET updated_at = MAX(updated_at, ?) WHERE singleton = 1",
    at,
  );
}

function jsonOrNull(value: JsonValue | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}
