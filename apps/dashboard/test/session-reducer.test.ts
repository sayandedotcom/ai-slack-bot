import { describe, expect, it } from "vitest";

import {
  initialSession,
  reduceSession,
  withPendingSteer,
  type RunEvent,
  type RunServerMessage,
  type SessionState,
  type ToolCallView,
} from "../src/runs/session-reducer";

/** Fold a whole scripted transcript, the way the socket hook will. */
function play(messages: RunServerMessage[], from: SessionState = initialSession()): SessionState {
  return messages.reduce(reduceSession, from);
}

function turnEvent(seq: number, id: string, content: string): RunEvent {
  return {
    seq,
    type: "turn",
    turn: {
      id,
      role: "user",
      source: "customer",
      content,
      metadata: null,
      createdAt: 1_000 + seq,
    },
  };
}

function toolEvent(
  seq: number,
  callId: string,
  state: "running" | "completed" | "failed",
  extra: { output?: unknown; error?: string; input?: unknown } = {},
): RunEvent {
  return {
    seq,
    type: "tool_call",
    update: {
      id: `tc-${seq}`,
      callId,
      name: "search_docs",
      state,
      createdAt: 2_000 + seq,
      ...extra,
    },
  };
}

function assistantEvent(
  seq: number,
  state: "started" | "streaming" | "completed" | "superseded" | "aborted" | "failed",
  extra: { delta?: string; error?: string; generationId?: string } = {},
): RunEvent {
  const { generationId = "gen-1", ...rest } = extra;
  return {
    seq,
    type: "assistant_update",
    update: { id: `au-${seq}`, generationId, attempt: 1, state, createdAt: 3_000 + seq, ...rest },
  };
}

/** Narrowing helper: asserts the item at `index` is a tool call and returns it. */
function toolCallAt(state: SessionState, index: number): ToolCallView {
  const item = state.items[index];
  if (item?.kind !== "tool_call") throw new Error(`items[${index}] is not a tool_call`);
  return item.call;
}

function statusEvent(seq: number, previous: "live" | "idle", next: "live" | "idle"): RunEvent {
  return { seq, type: "status", previousStatus: previous, status: next, createdAt: 4_000 + seq };
}

describe("initialSession", () => {
  it("starts empty with a cursor below every real seq", () => {
    const state = initialSession();
    expect(state.items).toEqual([]);
    expect(state.status).toBeNull();
    expect(state.cursor).toBe(0);
    expect(state.pendingSteers.size).toBe(0);
    expect(state.lastError).toBeNull();
  });
});

describe("sync", () => {
  it("seeds items, cursor and status", () => {
    const state = play([
      {
        type: "sync",
        events: [turnEvent(1, "t1", "hello"), statusEvent(2, "idle", "live")],
        cursor: 2,
        complete: true,
        status: "live",
      },
    ]);

    expect(state.cursor).toBe(2);
    expect(state.status).toBe("live");
    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toEqual({
      kind: "turn",
      turn: { id: "t1", role: "user", source: "customer", content: "hello", createdAt: 1_001 },
    });
    expect(state.items[1]).toMatchObject({ kind: "status", status: "live" });
  });

  it("replaces items wholesale on a reconnect sync and never duplicates", () => {
    const first = play([
      { type: "sync", events: [turnEvent(1, "t1", "a")], cursor: 1, complete: true, status: "live" },
      { type: "event", event: turnEvent(2, "t2", "b") },
    ]);
    expect(first.items).toHaveLength(2);

    const reconnected = reduceSession(first, {
      type: "sync",
      events: [turnEvent(1, "t1", "a"), turnEvent(2, "t2", "b"), turnEvent(3, "t3", "c")],
      cursor: 3,
      complete: true,
      status: "live",
    });

    expect(reconnected.items).toHaveLength(3);
    expect(reconnected.items.map((i) => (i.kind === "turn" ? i.turn.id : i.kind))).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
    expect(reconnected.cursor).toBe(3);
  });

  it("does not mutate the previous state", () => {
    const before = play([
      { type: "sync", events: [turnEvent(1, "t1", "a")], cursor: 1, complete: true, status: "live" },
    ]);
    const snapshot = before.items.slice();
    reduceSession(before, { type: "event", event: turnEvent(2, "t2", "b") });
    expect(before.items).toEqual(snapshot);
  });
});

describe("live events", () => {
  it("appends a live turn and advances the cursor", () => {
    const state = play([
      { type: "sync", events: [], cursor: 0, complete: true, status: "live" },
      { type: "event", event: turnEvent(1, "t1", "hi") },
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.cursor).toBe(1);
  });

  it("drops an event whose seq is at or below the cursor", () => {
    const base = play([
      { type: "sync", events: [], cursor: 0, complete: true, status: "live" },
      { type: "event", event: turnEvent(1, "t1", "hi") },
      { type: "event", event: turnEvent(2, "t2", "there") },
    ]);

    const replayed = play(
      [
        { type: "event", event: turnEvent(1, "t1", "hi") },
        { type: "event", event: turnEvent(2, "t2", "there") },
      ],
      base,
    );

    expect(replayed).toEqual(base);
    expect(replayed.items).toHaveLength(2);
    expect(replayed.cursor).toBe(2);
  });

  it("keeps the same state object for a duplicate frame", () => {
    const base = play([
      { type: "sync", events: [], cursor: 5, complete: true, status: "live" },
    ]);
    expect(reduceSession(base, { type: "event", event: turnEvent(5, "t5", "old") })).toBe(base);
  });

  it("updates status and appends a status item", () => {
    const state = play([
      { type: "sync", events: [], cursor: 0, complete: true, status: "idle" },
      { type: "event", event: statusEvent(1, "idle", "live") },
    ]);
    expect(state.status).toBe("live");
    expect(state.items).toEqual([
      { kind: "status", previousStatus: "idle", status: "live", createdAt: 4_001 },
    ]);
  });
});

describe("tool calls", () => {
  it("appends a running call then merges the completion into the same item", () => {
    const state = play([
      { type: "sync", events: [], cursor: 0, complete: true, status: "live" },
      { type: "event", event: toolEvent(1, "call-a", "running", { input: { q: "x" } }) },
      { type: "event", event: toolEvent(2, "call-a", "completed", { output: { hits: 3 } }) },
    ]);

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toEqual({
      kind: "tool_call",
      call: {
        callId: "call-a",
        name: "search_docs",
        state: "completed",
        input: { q: "x" },
        output: { hits: 3 },
        startedAt: 2_001,
        endedAt: 2_002,
      },
    });
  });

  it("keeps distinct callIds as separate items and records failures", () => {
    const state = play([
      { type: "sync", events: [], cursor: 0, complete: true, status: "live" },
      { type: "event", event: toolEvent(1, "call-a", "running") },
      { type: "event", event: toolEvent(2, "call-b", "running") },
      { type: "event", event: toolEvent(3, "call-b", "failed", { error: "timeout" }) },
    ]);

    expect(state.items).toHaveLength(2);
    expect(toolCallAt(state, 1)).toMatchObject({
      callId: "call-b",
      state: "failed",
      error: "timeout",
      endedAt: 2_003,
    });
    expect(toolCallAt(state, 0).state).toBe("running");
  });
});

describe("assistant lifecycle", () => {
  it("opens a draft, concatenates deltas, and clears on completed without a synthetic turn", () => {
    const opened = play([
      { type: "sync", events: [], cursor: 0, complete: true, status: "live" },
      { type: "event", event: assistantEvent(1, "started") },
      { type: "event", event: assistantEvent(2, "streaming", { delta: "Hel" }) },
      { type: "event", event: assistantEvent(3, "streaming", { delta: "lo!" }) },
    ]);
    expect(opened.items).toEqual([{ kind: "draft", generationId: "gen-1", text: "Hello!" }]);

    const done = reduceSession(opened, { type: "event", event: assistantEvent(4, "completed") });
    expect(done.items).toEqual([]);
    expect(done.lastError).toBeNull();

    // The real turn arrives separately; the reducer must not have invented one.
    const withTurn = reduceSession(done, { type: "event", event: turnEvent(5, "t5", "Hello!") });
    expect(withTurn.items).toHaveLength(1);
  });

  it("clears the draft on superseded with no error surfaced", () => {
    const state = play([
      { type: "sync", events: [], cursor: 0, complete: true, status: "live" },
      { type: "event", event: assistantEvent(1, "started") },
      { type: "event", event: assistantEvent(2, "streaming", { delta: "partial" }) },
      { type: "event", event: assistantEvent(3, "superseded") },
    ]);
    expect(state.items).toEqual([]);
    expect(state.lastError).toBeNull();

    // A fresh generation starts cleanly afterwards.
    const next = reduceSession(state, {
      type: "event",
      event: assistantEvent(4, "started", { generationId: "gen-2" }),
    });
    expect(next.items).toEqual([{ kind: "draft", generationId: "gen-2", text: "" }]);
  });

  it("clears the draft on aborted without an error", () => {
    const state = play([
      { type: "sync", events: [], cursor: 0, complete: true, status: "live" },
      { type: "event", event: assistantEvent(1, "started") },
      { type: "event", event: assistantEvent(2, "aborted") },
    ]);
    expect(state.items).toEqual([]);
    expect(state.lastError).toBeNull();
  });

  it("clears the draft and sets lastError on failed", () => {
    const state = play([
      { type: "sync", events: [], cursor: 0, complete: true, status: "live" },
      { type: "event", event: assistantEvent(1, "started") },
      { type: "event", event: assistantEvent(2, "streaming", { delta: "x" }) },
      { type: "event", event: assistantEvent(3, "failed", { error: "model exploded" }) },
    ]);
    expect(state.items).toEqual([]);
    expect(state.lastError).toEqual({ code: "assistant_failed", message: "model exploded" });
  });

  it("keeps the draft last when other events land mid-stream", () => {
    const state = play([
      { type: "sync", events: [], cursor: 0, complete: true, status: "live" },
      { type: "event", event: assistantEvent(1, "started") },
      { type: "event", event: assistantEvent(2, "streaming", { delta: "think" }) },
      { type: "event", event: toolEvent(3, "call-a", "running") },
      { type: "event", event: turnEvent(4, "t4", "steer!") },
      { type: "event", event: statusEvent(5, "live", "idle") },
    ]);

    expect(state.items.map((i) => i.kind)).toEqual(["tool_call", "turn", "status", "draft"]);
    expect(state.items.at(-1)).toEqual({ kind: "draft", generationId: "gen-1", text: "think" });
  });

  it("drops the draft when a sync replaces the transcript", () => {
    const state = play([
      { type: "sync", events: [], cursor: 0, complete: true, status: "live" },
      { type: "event", event: assistantEvent(1, "started") },
      { type: "event", event: assistantEvent(2, "streaming", { delta: "half" }) },
      { type: "sync", events: [turnEvent(1, "t1", "a")], cursor: 3, complete: true, status: "live" },
    ]);
    expect(state.items.map((i) => i.kind)).toEqual(["turn"]);
  });
});

describe("steers", () => {
  it("registers an optimistic steer and deletes it on ack", () => {
    const pending = withPendingSteer(initialSession(), "req-1", "please escalate");
    expect(pending.pendingSteers.get("req-1")).toBe("please escalate");
    expect(initialSession().pendingSteers.size).toBe(0);

    const withTwo = withPendingSteer(pending, "req-2", "and page ops");
    const acked = reduceSession(withTwo, { type: "ack", requestId: "req-1", seq: 9 });

    expect(acked.pendingSteers.has("req-1")).toBe(false);
    expect(acked.pendingSteers.get("req-2")).toBe("and page ops");
    // ack carries a seq but must not advance the cursor: it is not an event.
    expect(acked.cursor).toBe(0);
    // The original map is untouched.
    expect(withTwo.pendingSteers.has("req-1")).toBe(true);
  });

  it("ignores an ack for an unknown requestId", () => {
    const pending = withPendingSteer(initialSession(), "req-1", "hi");
    const acked = reduceSession(pending, { type: "ack", requestId: "nope", seq: 1 });
    expect(acked.pendingSteers.get("req-1")).toBe("hi");
  });
});

describe("error messages", () => {
  it("sets lastError and clears the matching pending steer", () => {
    const pending = withPendingSteer(initialSession(), "req-1", "hi");
    const state = reduceSession(pending, {
      type: "error",
      code: "rate_limited",
      message: "slow down",
      requestId: "req-1",
    });

    expect(state.lastError).toEqual({ code: "rate_limited", message: "slow down" });
    expect(state.pendingSteers.has("req-1")).toBe(false);
  });

  it("sets lastError without a requestId and leaves steers alone", () => {
    const pending = withPendingSteer(initialSession(), "req-1", "hi");
    const state = reduceSession(pending, { type: "error", code: "boom", message: "bad" });
    expect(state.lastError).toEqual({ code: "boom", message: "bad" });
    expect(state.pendingSteers.get("req-1")).toBe("hi");
  });

  it("a later sync clears a stale error", () => {
    const errored = reduceSession(initialSession(), {
      type: "error",
      code: "boom",
      message: "bad",
    });
    const resynced = reduceSession(errored, {
      type: "sync",
      events: [],
      cursor: 0,
      complete: true,
      status: "live",
    });
    expect(resynced.lastError).toBeNull();
  });
});
