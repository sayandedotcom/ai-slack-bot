/**
 * The run session reducer: folds the socket's `RunServerMessage` stream into the
 * flat, render-ready item list the transcript components draw. Pure and
 * immutable — no I/O, no timers, no mutation of the state handed in — so the
 * whole protocol's ordering behaviour is testable as data in / data out.
 */

/* ------------------------------------------------------------------ *
 * Protocol types.
 *
 * Mirrored verbatim from `apps/worker/src/run/protocol.ts`, which is the
 * authority. The dashboard does not depend on the worker package, so these are
 * copied rather than imported; keep them in step with that file.
 * ------------------------------------------------------------------ */

/** The reducer never inspects payloads, so an opaque alias is enough here. */
type JsonValue = unknown;
type JsonObject = Record<string, unknown>;

export type RunStatus = "live" | "awaiting_approval" | "idle" | "done" | "failed";
type TurnRole = "system" | "user" | "assistant";
type TurnSource = "triage" | "customer" | "human_steer" | "approval" | "agent" | "system";
type RunTurn = {
  id: string;
  role: TurnRole;
  source: TurnSource;
  content: string;
  metadata: JsonObject | null;
  createdAt: number;
};
export type ToolCallState = "running" | "completed" | "failed";
type ToolCallUpdate = {
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
export type AssistantUpdateState =
  | "started"
  | "streaming"
  | "completed"
  | "superseded"
  | "aborted"
  | "failed";
type AssistantUpdate = {
  id: string;
  generationId: string;
  attempt: number;
  state: AssistantUpdateState;
  delta?: string;
  error?: string;
  createdAt: number;
};
export type RunEvent =
  | { seq: number; type: "turn"; turn: RunTurn }
  | { seq: number; type: "tool_call"; update: ToolCallUpdate }
  | { seq: number; type: "assistant_update"; update: AssistantUpdate }
  | { seq: number; type: "status"; previousStatus: RunStatus; status: RunStatus; createdAt: number };
export type RunClientMessage = { type: "steer"; requestId: string; content: string };
export type RunServerMessage =
  | { type: "sync"; events: RunEvent[]; cursor: number; complete: boolean; status: RunStatus | null }
  | { type: "event"; event: RunEvent }
  | { type: "ack"; requestId: string; seq: number }
  | { type: "error"; code: string; message: string; requestId?: string };

/* ------------------------------------------------------------------ *
 * View model.
 * ------------------------------------------------------------------ */

export type ToolCallView = {
  callId: string;
  name: string;
  state: ToolCallState;
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt: number;
  endedAt: number | null;
};

export type SessionItem =
  | {
      kind: "turn";
      turn: { id: string; role: string; source: string; content: string; createdAt: number };
    }
  | { kind: "tool_call"; call: ToolCallView }
  | { kind: "status"; status: RunStatus; previousStatus: RunStatus; createdAt: number }
  /** At most one, and always the last item — see `appendItem`. */
  | { kind: "draft"; generationId: string; text: string };

export type SessionState = {
  items: SessionItem[];
  status: RunStatus | null;
  cursor: number;
  /** requestId -> steer text, held until the server acks or errors it. */
  pendingSteers: Map<string, string>;
  lastError: { code: string; message: string } | null;
};

export function initialSession(): SessionState {
  return { items: [], status: null, cursor: 0, pendingSteers: new Map(), lastError: null };
}

/**
 * Registers a steer the user just sent so the composer can show it as in-flight
 * before the server confirms. Lives here to keep `pendingSteers` mutation out of
 * the components; the matching `ack` (or `error`) removes it.
 */
export function withPendingSteer(
  state: SessionState,
  requestId: string,
  content: string,
): SessionState {
  const pendingSteers = new Map(state.pendingSteers);
  pendingSteers.set(requestId, content);
  return { ...state, pendingSteers };
}

/**
 * Appends while preserving the draft-last invariant: a streaming assistant draft
 * is the live tail of the transcript, so any concrete item that lands while it is
 * open is spliced in *before* it rather than after.
 */
function appendItem(items: SessionItem[], item: SessionItem): SessionItem[] {
  const last = items[items.length - 1];
  if (last?.kind === "draft") {
    return [...items.slice(0, -1), item, last];
  }
  return [...items, item];
}

function withoutDraft(items: SessionItem[]): SessionItem[] {
  const last = items[items.length - 1];
  return last?.kind === "draft" ? items.slice(0, -1) : items;
}

function toTurnItem(turn: RunTurn): SessionItem {
  return {
    kind: "turn",
    turn: {
      id: turn.id,
      role: turn.role,
      source: turn.source,
      content: turn.content,
      createdAt: turn.createdAt,
    },
  };
}

function applyToolCall(items: SessionItem[], update: ToolCallUpdate): SessionItem[] {
  const index = items.findIndex(
    (item) => item.kind === "tool_call" && item.call.callId === update.callId,
  );
  if (index === -1) {
    const call: ToolCallView = {
      callId: update.callId,
      name: update.name,
      state: update.state,
      ...(update.input === undefined ? {} : { input: update.input }),
      ...(update.output === undefined ? {} : { output: update.output }),
      ...(update.error === undefined ? {} : { error: update.error }),
      startedAt: update.createdAt,
      endedAt: update.state === "running" ? null : update.createdAt,
    };
    return appendItem(items, { kind: "tool_call", call });
  }

  // A call is one item across its whole life: later frames merge into the
  // existing entry so a completion never appends a second row. Fields absent
  // from the update (a completion usually omits `input`) keep their old value.
  const existing = items[index] as { kind: "tool_call"; call: ToolCallView };
  const merged: ToolCallView = {
    ...existing.call,
    name: update.name,
    state: update.state,
    ...(update.input === undefined ? {} : { input: update.input }),
    ...(update.output === undefined ? {} : { output: update.output }),
    ...(update.error === undefined ? {} : { error: update.error }),
    endedAt: update.state === "running" ? existing.call.endedAt : update.createdAt,
  };
  const next = items.slice();
  next[index] = { kind: "tool_call", call: merged };
  return next;
}

function applyAssistantUpdate(state: SessionState, update: AssistantUpdate): SessionState {
  const base = withoutDraft(state.items);
  const last = state.items[state.items.length - 1];
  const draft = last?.kind === "draft" ? last : null;

  switch (update.state) {
    case "started":
      return { ...state, items: [...base, { kind: "draft", generationId: update.generationId, text: "" }] };
    case "streaming": {
      const text = (draft?.generationId === update.generationId ? draft.text : "") + (update.delta ?? "");
      return { ...state, items: [...base, { kind: "draft", generationId: update.generationId, text }] };
    }
    case "completed":
      // No synthetic turn: the finished message arrives as its own `turn` event,
      // so inventing one here would render it twice.
      return { ...state, items: base };
    case "superseded":
      // Not a failure. A late steer supersedes an in-flight final; the generation
      // continues, so we drop the stale buffer and wait for the next `started`.
      return { ...state, items: base };
    case "aborted":
      return { ...state, items: base };
    case "failed":
      return {
        ...state,
        items: base,
        lastError: { code: "assistant_failed", message: update.error ?? "The assistant failed." },
      };
  }
}

function applyEvent(state: SessionState, event: RunEvent): SessionState {
  switch (event.type) {
    case "turn":
      return { ...state, items: appendItem(state.items, toTurnItem(event.turn)) };
    case "tool_call":
      return { ...state, items: applyToolCall(state.items, event.update) };
    case "assistant_update":
      return applyAssistantUpdate(state, event.update);
    case "status":
      return {
        ...state,
        status: event.status,
        items: appendItem(state.items, {
          kind: "status",
          status: event.status,
          previousStatus: event.previousStatus,
          createdAt: event.createdAt,
        }),
      };
  }
}

export function reduceSession(state: SessionState, message: RunServerMessage): SessionState {
  switch (message.type) {
    case "sync": {
      // A sync is the authoritative transcript, including on reconnect: rebuild
      // from scratch rather than merging, which is what makes replayed events
      // impossible to duplicate. Any open draft dies with the old list, and a
      // stale error is cleared because the connection is healthy again.
      const seeded = message.events.reduce(applyEvent, {
        ...state,
        items: [],
        status: message.status,
        lastError: null,
      });
      return { ...seeded, status: message.status, cursor: message.cursor };
    }
    case "event": {
      // Dedupe by seq: the server replays from a cursor after a reconnect, so
      // anything at or below what we have already applied is a duplicate.
      // Returning `state` itself keeps referential equality for React.
      if (message.event.seq <= state.cursor) return state;
      const next = applyEvent(state, message.event);
      return { ...next, cursor: message.event.seq };
    }
    case "ack": {
      // The ack's `seq` labels the turn the server created; it is not an applied
      // event on this stream, so the cursor stays where it is.
      if (!state.pendingSteers.has(message.requestId)) return state;
      const pendingSteers = new Map(state.pendingSteers);
      pendingSteers.delete(message.requestId);
      return { ...state, pendingSteers };
    }
    case "error": {
      // An error naming a requestId settles that steer: it will never be acked,
      // so releasing it stops the composer showing it as in-flight forever.
      const pendingSteers =
        message.requestId !== undefined && state.pendingSteers.has(message.requestId)
          ? new Map(
              [...state.pendingSteers].filter(([requestId]) => requestId !== message.requestId),
            )
          : state.pendingSteers;
      return { ...state, pendingSteers, lastError: { code: message.code, message: message.message } };
    }
  }
}
