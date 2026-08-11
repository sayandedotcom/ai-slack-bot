/**
 * The one session shape. Slack-woken runs and human-typed Chat runs use these
 * types identically — see spec §5 and the Phase 08 plan's "one inbox" invariant.
 *
 * Deliberately NO type/category anywhere in this file. A run is a run; the only
 * thing recorded about where a turn came from is `TurnSource`, which the model
 * reads for context and nothing branches on.
 *
 * Pure module: no D1, no Durable Object, no I/O. Everything here is testable
 * without a binding.
 */

export const RUN_STATUSES = [
  "live",
  "awaiting_approval",
  "idle",
  "done",
  "failed",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * The statuses that mean a run still owns its Slack thread. `findOwnedSlackRun`
 * queries by exactly this set, so a later message in the thread reaches the
 * agent instead of triage. `done` and `failed` are absent on purpose: they
 * release the thread back to triage, which may then reopen the same run.
 */
export const ACTIVE_RUN_STATUSES = ["live", "awaiting_approval", "idle"] as const;

export type ActiveRunStatus = (typeof ACTIVE_RUN_STATUSES)[number];

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value);
}

/**
 * Legal state changes. `done -> live` and `failed -> live` are intentional: a
 * Slack thread owns one durable session for its lifetime, so a new actionable
 * message reopens the same object rather than forking a second one behind a
 * fake message-scoped key.
 */
const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  live: ["awaiting_approval", "idle", "done", "failed"],
  awaiting_approval: ["live", "idle", "done", "failed"],
  idle: ["live", "done", "failed"],
  done: ["live"],
  failed: ["live"],
};

export type TransitionResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: string };

/**
 * `changed: false` is the idempotent same-state case. Callers must not append a
 * status event for it — a re-delivered queue message setting `live -> live`
 * would otherwise burn a `seq` and show up as a phantom event in every tab.
 */
export function evaluateTransition(from: RunStatus, to: RunStatus): TransitionResult {
  if (!isRunStatus(from)) return { ok: false, reason: `unknown current status: ${String(from)}` };
  if (!isRunStatus(to)) return { ok: false, reason: `unknown target status: ${String(to)}` };
  if (from === to) return { ok: true, changed: false };
  if (TRANSITIONS[from].includes(to)) return { ok: true, changed: true };
  return { ok: false, reason: `illegal transition ${from} -> ${to}` };
}

// --- turns -----------------------------------------------------------------

export type TurnRole = "system" | "user" | "assistant";

/**
 * Where a turn entered the session. This is context for the model, not a
 * classification: nothing in the run layer branches on it.
 */
export type TurnSource =
  | "triage"
  | "customer"
  | "human_steer"
  | "approval"
  | "agent"
  | "system";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type RunTurnInput = {
  /** Caller-stable idempotency key. See the stable-ID table in the plan. */
  id: string;
  role: TurnRole;
  source: TurnSource;
  content: string;
  /** Slack event id, permalink, approval id — whatever the origin needs later. */
  metadata?: JsonObject;
  createdAt?: number;
};

export type RunTurn = {
  id: string;
  role: TurnRole;
  source: TurnSource;
  content: string;
  metadata: JsonObject | null;
  createdAt: number;
};

// --- tool calls ------------------------------------------------------------

export type ToolCallState = "running" | "completed" | "failed";

export type ToolCallUpdateInput = {
  /** Idempotency key: `tool:{call_id}:{provider_sequence}`. */
  id: string;
  callId: string;
  name: string;
  state: ToolCallState;
  input?: JsonValue;
  output?: JsonValue;
  error?: string;
  delta?: string;
  createdAt?: number;
};

export type ToolCallUpdate = {
  id: string;
  callId: string;
  name: string;
  state: ToolCallState;
  input?: JsonValue;
  output?: JsonValue;
  error?: string;
  delta?: string;
  createdAt: number;
};

// --- stream ----------------------------------------------------------------

export type RunEvent =
  | { seq: number; type: "turn"; turn: RunTurn }
  | { seq: number; type: "tool_call"; update: ToolCallUpdate }
  | {
      seq: number;
      type: "status";
      previousStatus: RunStatus;
      status: RunStatus;
      createdAt: number;
    };

export type RunClientMessage = {
  type: "steer";
  requestId: string;
  content: string;
};

export type RunServerMessage =
  | {
      type: "sync";
      events: RunEvent[];
      cursor: number;
      complete: boolean;
      status: RunStatus | null;
    }
  | { type: "event"; event: RunEvent }
  | { type: "ack"; requestId: string; seq: number }
  | { type: "error"; code: string; message: string; requestId?: string };

// --- client message parsing ------------------------------------------------

/** Generous for a human typing into a run, small enough to bound one event. */
export const STEER_MAX_CONTENT = 16_000;

export type ParseResult =
  | { ok: true; message: RunClientMessage }
  | { ok: false; code: string; message: string };

/**
 * Fields the server owns. A browser sending any of them is not a client we want
 * to be lenient with — accepting and ignoring them invites a later refactor to
 * start reading them. Reject loudly instead.
 */
const SERVER_OWNED_FIELDS = ["role", "source", "id", "seq", "createdAt", "metadata"] as const;

function reject(code: string, message: string): ParseResult {
  return { ok: false, code, message };
}

export function parseClientMessage(raw: string | ArrayBuffer): ParseResult {
  if (typeof raw !== "string") {
    return reject("unsupported_binary", "binary frames are not accepted");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return reject("invalid_json", "message was not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return reject("invalid_shape", "message must be a JSON object");
  }

  const body = parsed as Record<string, unknown>;

  if (body.type !== "steer") {
    return reject("unknown_type", `unsupported message type: ${String(body.type)}`);
  }

  for (const field of SERVER_OWNED_FIELDS) {
    if (field in body) {
      return reject("server_owned_field", `${field} is assigned by the server`);
    }
  }

  if (typeof body.requestId !== "string" || body.requestId.length === 0) {
    return reject("invalid_request_id", "requestId must be a non-empty string");
  }

  if (typeof body.content !== "string") {
    return reject("invalid_content", "content must be a string");
  }

  const content = body.content.trim();
  if (content.length === 0) {
    return reject("empty_content", "content must not be blank");
  }
  if (content.length > STEER_MAX_CONTENT) {
    return reject("content_too_long", `content exceeds ${STEER_MAX_CONTENT} characters`);
  }

  return { ok: true, message: { type: "steer", requestId: body.requestId, content } };
}
