import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  appendToolCallUpdate,
  appendTurn,
  initializeSession,
  latestSeq,
  listEvents,
  listToolCalls,
  listTurns,
  readState,
  setStatus,
  snapshot,
  EVENT_PAGE_MAX,
  type RunDescriptor,
} from "../src/run/session";
import { chatRunKey } from "../src/run/keys";
import type { RunStatus, RunTurnInput } from "../src/run/protocol";

/**
 * There is no isolatedStorage in vitest-pool-workers 0.21 — storage carries
 * across cases AND files (proved by the Task 0 spike, see phase-08-notes.md).
 * Every case therefore mints its own key, and nothing asserts an absolute seq.
 */
function freshRun() {
  const runId = crypto.randomUUID();
  const key = chatRunKey(crypto.randomUUID());
  const stub = env.RUNS.get(env.RUNS.idFromName(key));
  const descriptor: RunDescriptor = {
    runId,
    key,
    origin: "chat",
    channelId: null,
    threadTs: null,
  };
  return { runId, key, stub, descriptor };
}

/** Runs `fn` against the object's own storage. `instance.ctx` is protected. */
function inRun<T>(
  stub: DurableObjectStub,
  fn: (storage: DurableObjectStorage) => T,
): Promise<T> {
  return runInDurableObject(stub, (_instance, state) => fn(state.storage));
}

function turn(id: string, overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    id,
    role: "user",
    source: "human_steer",
    content: "check the staging deploy",
    ...overrides,
  };
}

describe("initialization", () => {
  it("stores the descriptor and starts live", async () => {
    const { stub, descriptor } = freshRun();
    const state = await inRun(stub, (s) => initializeSession(s, descriptor, 1_000));

    expect(state.runId).toBe(descriptor.runId);
    expect(state.key).toBe(descriptor.key);
    expect(state.origin).toBe("chat");
    expect(state.status).toBe("live");
    expect(state.summary).toBeNull();
    expect(state.createdAt).toBe(1_000);
  });

  it("is idempotent for the same descriptor", async () => {
    const { stub, descriptor } = freshRun();
    const first = await inRun(stub, (s) => initializeSession(s, descriptor, 1_000));
    const second = await inRun(stub, (s) => initializeSession(s, descriptor, 9_999));

    expect(second).toEqual(first);
    expect(second.createdAt).toBe(1_000);
  });

  it("refuses a different run pointed at the same object", async () => {
    const { stub, descriptor } = freshRun();
    await inRun(stub, (s) => initializeSession(s, descriptor, 1_000));

    // Two runs sharing one Durable Object would interleave their turns. That is
    // a routing bug, so it fails loudly rather than overwriting.
    await expect(
      inRun(stub, (s) =>
        initializeSession(s, { ...descriptor, runId: crypto.randomUUID() }, 2_000),
      ),
    ).rejects.toThrow();

    await expect(
      inRun(stub, (s) =>
        initializeSession(s, { ...descriptor, key: chatRunKey(crypto.randomUUID()) }, 2_000),
      ),
    ).rejects.toThrow();
  });

  it("reports no state before initialization", async () => {
    const { stub } = freshRun();
    expect(await inRun(stub, (s) => readState(s))).toBeNull();
  });

  it("refuses session mutations before initialization", async () => {
    const { stub } = freshRun();
    // An anonymous session could never be matched back to a D1 row or a thread.
    await expect(inRun(stub, (s) => appendTurn(s, turn("t-1")))).rejects.toThrow();
    await expect(inRun(stub, (s) => setStatus(s, "idle"))).rejects.toThrow();
  });
});

describe("the one inbox", () => {
  it("accepts every source through the same method, in order", async () => {
    const { stub, descriptor } = freshRun();

    const events = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      return [
        appendTurn(s, turn("triage:E1", { role: "system", source: "triage" }), 1_001),
        appendTurn(s, turn("slack:E2", { source: "customer" }), 1_002),
        appendTurn(s, turn("steer:R1", { source: "human_steer" }), 1_003),
        appendTurn(s, turn("approval:A1:1", { source: "approval" }), 1_004),
        appendTurn(s, turn("agent:M1", { role: "assistant", source: "agent" }), 1_005),
      ];
    });

    expect(events.every((e) => e.appended)).toBe(true);

    const seqs = events.map((e) => e.event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    const turns = await inRun(stub, (s) => listTurns(s));
    expect(turns.map((t) => t.source)).toEqual([
      "triage",
      "customer",
      "human_steer",
      "approval",
      "agent",
    ]);
    // One common shape — no source-specific columns anywhere.
    for (const t of turns) {
      expect(Object.keys(t).sort()).toEqual(
        ["content", "createdAt", "id", "metadata", "role", "source"].sort(),
      );
    }
  });

  it("keeps metadata as structured json", async () => {
    const { stub, descriptor } = freshRun();
    const stored = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      appendTurn(
        s,
        turn("slack:E1", {
          source: "customer",
          metadata: { permalink: "https://slack.com/archives/C1/p1", eventId: "E1" },
        }),
        1_001,
      );
      return listTurns(s);
    });

    expect(stored[0].metadata).toEqual({
      permalink: "https://slack.com/archives/C1/p1",
      eventId: "E1",
    });
  });
});

describe("idempotency and atomicity", () => {
  it("returns the original event when a turn id repeats", async () => {
    const { stub, descriptor } = freshRun();
    const { first, second, turnCount, eventCount } = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      const first = appendTurn(s, turn("slack:E1", { source: "customer" }), 1_001);
      const second = appendTurn(s, turn("slack:E1", { source: "customer" }), 1_002);
      return {
        first,
        second,
        turnCount: listTurns(s).length,
        eventCount: listEvents(s, 0, EVENT_PAGE_MAX).length,
      };
    });

    expect(first.appended).toBe(true);
    expect(second.appended).toBe(false);
    expect(second.event).toEqual(first.event);
    expect(turnCount).toBe(1);
    expect(eventCount).toBe(1);
  });

  it("gives two distinct turns consecutive seq values", async () => {
    const { stub, descriptor } = freshRun();
    const [a, b] = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      return [appendTurn(s, turn("t-a"), 1_001), appendTurn(s, turn("t-b"), 1_002)];
    });

    expect(b.event.seq).toBe(a.event.seq + 1);
  });

  it("writes neither table for an invalid turn", async () => {
    const { stub, descriptor } = freshRun();
    const counts = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      const attempts = [
        () => appendTurn(s, turn("", {}), 1_001),
        () => appendTurn(s, turn("t-blank", { content: "   " }), 1_001),
        () => appendTurn(s, turn("t-role", { role: "root" as never }), 1_001),
        () => appendTurn(s, turn("t-source", { source: "bug" as never }), 1_001),
      ];
      let thrown = 0;
      for (const attempt of attempts) {
        try {
          attempt();
        } catch {
          thrown += 1;
        }
      }
      return {
        thrown,
        turns: listTurns(s).length,
        events: listEvents(s, 0, EVENT_PAGE_MAX).length,
      };
    });

    expect(counts.thrown).toBe(4);
    expect(counts.turns).toBe(0);
    expect(counts.events).toBe(0);
  });

  it("commits a tool update and its stream event together", async () => {
    const { stub, descriptor } = freshRun();
    const result = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      const appended = appendToolCallUpdate(
        s,
        {
          id: "tool:c1:0",
          callId: "c1",
          name: "code",
          state: "running",
          input: { source: "await slack.post()" },
        },
        1_001,
      );
      return {
        appended,
        events: listEvents(s, 0, EVENT_PAGE_MAX),
        calls: listToolCalls(s),
      };
    });

    expect(result.appended.appended).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe("tool_call");
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].state).toBe("running");
  });

  it("does not append a second delta for a repeated update id", async () => {
    const { stub, descriptor } = freshRun();
    const counts = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      const update = {
        id: "tool:c1:0",
        callId: "c1",
        name: "code",
        state: "running" as const,
        delta: "step one",
      };
      const first = appendToolCallUpdate(s, update, 1_001);
      const second = appendToolCallUpdate(s, update, 1_002);
      return { first, second, events: listEvents(s, 0, EVENT_PAGE_MAX).length };
    });

    expect(counts.second.appended).toBe(false);
    expect(counts.second.event).toEqual(counts.first.event);
    expect(counts.events).toBe(1);
  });

  it("preserves the original input when a completion carries only output", async () => {
    const { stub, descriptor } = freshRun();
    const call = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      appendToolCallUpdate(
        s,
        { id: "tool:c1:0", callId: "c1", name: "code", state: "running", input: { source: "x" } },
        1_001,
      );
      appendToolCallUpdate(
        s,
        { id: "tool:c1:1", callId: "c1", name: "code", state: "completed", output: { ok: true } },
        1_002,
      );
      return listToolCalls(s)[0];
    });

    expect(call.state).toBe("completed");
    expect(call.input).toEqual({ source: "x" });
    expect(call.output).toEqual({ ok: true });
    expect(call.error).toBeNull();
  });

  it("records a failure without discarding the input", async () => {
    const { stub, descriptor } = freshRun();
    const call = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      appendToolCallUpdate(
        s,
        { id: "tool:c2:0", callId: "c2", name: "code", state: "running", input: { source: "y" } },
        1_001,
      );
      appendToolCallUpdate(
        s,
        { id: "tool:c2:1", callId: "c2", name: "code", state: "failed", error: "ChannelReadOnly" },
        1_002,
      );
      return listToolCalls(s)[0];
    });

    expect(call.state).toBe("failed");
    expect(call.input).toEqual({ source: "y" });
    expect(call.error).toBe("ChannelReadOnly");
  });
});

describe("status", () => {
  const allowed: Array<[RunStatus, RunStatus]> = [
    ["live", "awaiting_approval"],
    ["live", "idle"],
    ["live", "done"],
    ["live", "failed"],
    ["idle", "live"],
    ["done", "live"],
    ["failed", "live"],
  ];

  it.each(allowed)("appends exactly one event for %s -> %s", async (from, to) => {
    const { stub, descriptor } = freshRun();
    const result = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      if (from !== "live") setStatus(s, from, 1_001);
      const before = latestSeq(s);
      const outcome = setStatus(s, to, 1_002);
      return { outcome, appended: latestSeq(s) - before, state: readState(s) };
    });

    expect(result.outcome.changed).toBe(true);
    expect(result.appended).toBe(1);
    expect(result.state?.status).toBe(to);
    expect(result.outcome.event).toMatchObject({
      type: "status",
      previousStatus: from,
      status: to,
    });
  });

  it("rejects a forbidden transition and appends nothing", async () => {
    const { stub, descriptor } = freshRun();
    const seqBefore = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      setStatus(s, "done", 1_001);
      return latestSeq(s);
    });

    await expect(inRun(stub, (s) => setStatus(s, "idle", 1_002))).rejects.toThrow();
    expect(await inRun(stub, (s) => latestSeq(s))).toBe(seqBefore);
  });

  it("is idempotent and eventless for the same state", async () => {
    const { stub, descriptor } = freshRun();
    const result = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      const before = latestSeq(s);
      const outcome = setStatus(s, "live", 1_001);
      return { outcome, appended: latestSeq(s) - before };
    });

    expect(result.outcome.changed).toBe(false);
    expect(result.outcome.event).toBeNull();
    expect(result.appended).toBe(0);
  });
});

describe("bounded reads", () => {
  it("clamps a negative afterSeq and an oversized limit", async () => {
    const { stub, descriptor } = freshRun();
    const events = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      appendTurn(s, turn("t-a"), 1_001);
      appendTurn(s, turn("t-b"), 1_002);
      return listEvents(s, -50, 10_000);
    });

    expect(events).toHaveLength(2);
  });

  it("honours a small limit and reports the snapshot as incomplete", async () => {
    const { stub, descriptor } = freshRun();
    const snap = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      appendTurn(s, turn("t-a"), 1_001);
      appendTurn(s, turn("t-b"), 1_002);
      appendTurn(s, turn("t-c"), 1_003);
      return snapshot(s, 0, 2);
    });

    expect(snap.events).toHaveLength(2);
    expect(snap.complete).toBe(false);
    expect(snap.cursor).toBe(snap.events[1].seq);
  });

  it("reports complete once the cursor reaches the tail", async () => {
    const { stub, descriptor } = freshRun();
    const snap = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      appendTurn(s, turn("t-a"), 1_001);
      return snapshot(s, 0, 100);
    });

    expect(snap.complete).toBe(true);
    expect(snap.state?.status).toBe("live");
  });

  it("returns only events after the cursor", async () => {
    const { stub, descriptor } = freshRun();
    const { first, tail } = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      const first = appendTurn(s, turn("t-a"), 1_001);
      appendTurn(s, turn("t-b"), 1_002);
      appendTurn(s, turn("t-c"), 1_003);
      return { first, tail: listEvents(s, first.event.seq, 100) };
    });

    expect(tail).toHaveLength(2);
    expect(tail.every((e) => e.seq > first.event.seq)).toBe(true);
  });
});

describe("durability across eviction", () => {
  it("keeps state, turns, tool calls and the cursor", async () => {
    const { stub, descriptor } = freshRun();

    const before = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      appendTurn(s, turn("t-a", { source: "triage", role: "system" }), 1_001);
      appendToolCallUpdate(
        s,
        { id: "tool:c1:0", callId: "c1", name: "code", state: "running", input: { source: "x" } },
        1_002,
      );
      setStatus(s, "awaiting_approval", 1_003);
      return {
        state: readState(s),
        turns: listTurns(s),
        calls: listToolCalls(s),
        cursor: latestSeq(s),
      };
    });

    // Destroys the instance. Anything held only in memory is gone.
    await evictDurableObject(stub);

    const after = await inRun(stub, (s) => ({
      state: readState(s),
      turns: listTurns(s),
      calls: listToolCalls(s),
      cursor: latestSeq(s),
    }));

    expect(after).toEqual(before);
    expect(after.state?.status).toBe("awaiting_approval");
  });

  it("continues the seq sequence after re-entry rather than restarting", async () => {
    const { stub, descriptor } = freshRun();
    const before = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      return appendTurn(s, turn("t-a"), 1_001).event.seq;
    });

    await evictDurableObject(stub);

    const after = await inRun(stub, (s) => appendTurn(s, turn("t-b"), 1_002).event.seq);
    expect(after).toBe(before + 1);
  });
});
