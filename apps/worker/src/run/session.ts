import {
  evaluateTransition,
  isRunStatus,
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
 * Called from the constructor on every instantiation, including after
 * hibernation. `IF NOT EXISTS` makes re-entry free.
 *
 * `stream_events.seq` is a plain INTEGER PRIMARY KEY — a rowid alias. Nothing
 * ever deletes from this table, so it is monotonic without AUTOINCREMENT, which
 * would need SQLite's internal sqlite_sequence table. Verified by spike; see
 * phase-08-notes.md.
 */
export function ensureSchema(storage: DurableObjectStorage): void {
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

  storage.sql.exec(
    `INSERT INTO run_state
       (singleton, run_id, run_key, origin, channel_id, thread_ts, status, summary, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, 'live', NULL, ?, ?)`,
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

  return storage.transactionSync(() => {
    const existing = storage.sql
      .exec<{ event_seq: number }>("SELECT event_seq FROM turns WHERE id = ?", input.id)
      .toArray();
    if (existing.length > 0) {
      // Queue retry or browser retry. Return the original event so the caller
      // can broadcast by the same seq; the socket cursor suppresses the dupe.
      return { appended: false, event: eventAt(storage, existing[0].event_seq) };
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

    return { appended: true, event };
  });
}

export function listTurns(storage: DurableObjectStorage, limit = EVENT_PAGE_DEFAULT): RunTurn[] {
  const size = Math.min(Math.max(1, Math.floor(limit)), EVENT_PAGE_MAX);
  return storage.sql
    .exec<{
      id: string;
      role: RunTurn["role"];
      source: RunTurn["source"];
      content: string;
      metadata_json: string | null;
      created_at: number;
    }>(
      `SELECT id, role, source, content, metadata_json, created_at
       FROM turns ORDER BY event_seq ASC LIMIT ?`,
      size,
    )
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

  return storage.transactionSync(() => {
    const existing = storage.sql
      .exec<{ event_seq: number }>("SELECT event_seq FROM tool_updates WHERE id = ?", input.id)
      .toArray();
    if (existing.length > 0) {
      return { appended: false, event: eventAt(storage, existing[0].event_seq) };
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

    return { appended: true, event };
  });
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
    const seq = nextSeq(storage);
    const event: RunEvent = {
      seq,
      type: "status",
      previousStatus: state.status,
      status,
      createdAt: now,
    };
    writeEvent(storage, event, now);
    storage.sql.exec(
      "UPDATE run_state SET status = ?, updated_at = ? WHERE singleton = 1",
      status,
      now,
    );
    return { changed: true, status, event };
  });
}

export function setSummary(storage: DurableObjectStorage, summary: string, now = Date.now()): void {
  requireState(storage);
  storage.sql.exec(
    "UPDATE run_state SET summary = ?, updated_at = ? WHERE singleton = 1",
    summary,
    now,
  );
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
