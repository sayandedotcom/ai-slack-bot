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

/**
 * The complement of `ACTIVE_RUN_STATUSES`, named because Phase 18 has to act on
 * it: a run reaching one of these destroys its container, and the sweeper reads
 * exactly this set out of D1 to find the orphans. Spelling it once means adding
 * a sixth status can only ever put it in one list or the other, rather than
 * leaving it silently in neither.
 */
export const TERMINAL_RUN_STATUSES = ["done", "failed"] as const;

export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export function isTerminalRunStatus(status: RunStatus): status is TerminalRunStatus {
  return (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

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

/**
 * JSON payloads the run layer stores without inspecting: Slack metadata, tool
 * arguments, tool results.
 *
 * Depth-bounded on purpose, squeezed between two constraints that a
 * self-referential type cannot satisfy at once:
 *
 *  - a recursive `JsonValue = ... | JsonValue[] | { [k: string]: JsonValue }`
 *    makes workerd's RPC serializer type machinery exceed TypeScript's
 *    instantiation limit the moment it crosses a Durable Object stub —
 *    `TS2589: Type instantiation is excessively deep and possibly infinite`;
 *  - `unknown` escapes that, but fails workerd's `Rpc.Serializable` constraint,
 *    which silently collapses the whole RPC return type to `never`.
 *
 * Four levels covers every payload this phase stores, and it is finite. Both
 * failures are invisible to the test suite — vitest strips types — so only
 * `pnpm typecheck` catches a regression here.
 */
type JsonScalar = string | number | boolean | null;
type JsonDepth1 = JsonScalar | JsonScalar[] | { [key: string]: JsonScalar };
type JsonDepth2 = JsonDepth1 | JsonDepth1[] | { [key: string]: JsonDepth1 };
type JsonDepth3 = JsonDepth2 | JsonDepth2[] | { [key: string]: JsonDepth2 };

export type JsonValue = JsonDepth3;

export type JsonObject = { [key: string]: JsonDepth2 };

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

// --- assistant updates -----------------------------------------------------

/**
 * The life of ONE streamed assistant answer within one generation attempt.
 *
 * `superseded` is not a failure: it is what a late steer does to an in-flight
 * final. The generation continues, so the client drops its draft buffer and
 * waits for the next `started` rather than showing an error.
 */
export const ASSISTANT_UPDATE_STATES = [
  "started",
  "streaming",
  "completed",
  "superseded",
  "aborted",
  "failed",
] as const;

export type AssistantUpdateState = (typeof ASSISTANT_UPDATE_STATES)[number];

export function isAssistantUpdateState(value: unknown): value is AssistantUpdateState {
  return (
    typeof value === "string" && (ASSISTANT_UPDATE_STATES as readonly string[]).includes(value)
  );
}

/**
 * Flush threshold for accumulated text. 250 ms OR this many characters,
 * whichever comes first — one SQLite row per token would turn a single answer
 * into thousands of durable writes and thousands of socket frames (invariant 20).
 */
export const ASSISTANT_FLUSH_CHARS = 512;
export const ASSISTANT_FLUSH_MS = 250;

/**
 * Hard caps applied when the update is persisted. The flush threshold above is
 * the intent; these are the defence against a caller that batched badly or an
 * error string carrying a whole provider body into the replay log.
 */
export const ASSISTANT_DELTA_MAX = 8_192;
export const ASSISTANT_ERROR_MAX = 512;

/**
 * What the driver hands to the session. The batch `id` is NOT here: it is
 * derived server-side from generation/attempt/batchSeq, which is what makes an
 * at-least-once alarm replay return the original event instead of appending a
 * second copy of the same text.
 *
 * There is no `reasoning`, no `thinking`, no provider payload and no open
 * metadata bag — by construction, not by filtering. Reasoning never reaches a
 * RunEvent, a log, D1 or Zep (invariant 18).
 */
export type AssistantUpdateInput = {
  generationId: string;
  attempt: number;
  batchSeq: number;
  state: AssistantUpdateState;
  delta?: string;
  error?: string;
  createdAt?: number;
};

export type AssistantUpdate = {
  id: string;
  generationId: string;
  attempt: number;
  state: AssistantUpdateState;
  delta?: string;
  error?: string;
  createdAt: number;
};

// --- stream ----------------------------------------------------------------

export type RunEvent =
  | { seq: number; type: "turn"; turn: RunTurn }
  | { seq: number; type: "tool_call"; update: ToolCallUpdate }
  | { seq: number; type: "assistant_update"; update: AssistantUpdate }
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
