import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { chatRunKey, runStubForKey, slackRunKey } from "../src/run/keys";
import { createOrGetRun, getRunById } from "../src/run/repository";
import type { RunDescriptor } from "../src/run/session";
import type { RunTurnInput } from "../src/run/protocol";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM runs").run();
});

/**
 * Each case mints its own key — storage is shared across cases and files in
 * this pool. See phase-08-notes.md.
 */
async function freshRun(origin: "chat" | "slack" = "chat") {
  const descriptor: RunDescriptor =
    origin === "chat"
      ? {
          runId: "",
          key: chatRunKey(crypto.randomUUID()),
          origin: "chat",
          channelId: null,
          threadTs: null,
        }
      : (() => {
          const threadTs = `17200${Math.floor(Math.random() * 90_000 + 10_000)}.123456`;
          return {
            runId: "",
            key: slackRunKey("C1", threadTs),
            origin: "slack" as const,
            channelId: "C1",
            threadTs,
          };
        })();

  const record = await createOrGetRun(env.DB, {
    key: descriptor.key,
    origin: descriptor.origin,
    channelId: descriptor.channelId,
    threadTs: descriptor.threadTs,
  });
  descriptor.runId = record.id;

  const stub = runStubForKey(env.RUNS, descriptor.key);
  await stub.initialize(descriptor);
  return { descriptor, record, stub };
}

function turn(id: string): RunTurnInput {
  return { id, role: "user", source: "human_steer", content: "look at the logs" };
}

describe("namespace identity", () => {
  it("resolves the same key to the same object", async () => {
    const { descriptor, stub } = await freshRun();
    await stub.appendTurn(turn("t-a"));

    const again = runStubForKey(env.RUNS, descriptor.key);
    const state = await again.state();
    expect(state?.runId).toBe(descriptor.runId);
    expect((await again.turns()).map((t) => t.id)).toEqual(["t-a"]);
  });

  it("resolves a slack thread and a chat run to different objects", async () => {
    const slack = await freshRun("slack");
    const chat = await freshRun("chat");

    await slack.stub.appendTurn(turn("t-slack"));

    expect((await chat.stub.turns())).toHaveLength(0);
    expect((await slack.stub.turns())).toHaveLength(1);
  });

  it("gives a root message and its reply the same object", async () => {
    const threadTs = "1720000000.123456";
    const key = slackRunKey("C1", threadTs);
    const record = await createOrGetRun(env.DB, {
      key,
      origin: "slack",
      channelId: "C1",
      threadTs,
    });

    const fromRoot = runStubForKey(env.RUNS, key);
    await fromRoot.initialize({
      runId: record.id,
      key,
      origin: "slack",
      channelId: "C1",
      threadTs,
    });
    await fromRoot.appendTurn(turn("triage:E1"));

    // A reply canonicalises to the same thread_ts, so it builds the same key.
    const fromReply = runStubForKey(env.RUNS, slackRunKey("C1", threadTs));
    expect((await fromReply.turns()).map((t) => t.id)).toEqual(["triage:E1"]);
  });
});

describe("rpc surface", () => {
  it("returns structured-clone-safe values across the boundary", async () => {
    const { stub } = await freshRun();
    const result = await stub.appendTurn({
      id: "t-meta",
      role: "user",
      source: "customer",
      content: "hi",
      metadata: { nested: { permalink: "https://slack.com/x" }, list: [1, 2, 3] },
    });

    expect(result.appended).toBe(true);
    expect(result.event.type).toBe("turn");
    // Survives the RPC hop unchanged.
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("reports appended:false for a replayed id without a second event", async () => {
    const { stub } = await freshRun();
    const first = await stub.appendTurn(turn("slack:E1"));
    // The first input also committed the idle -> live status event, so the
    // cursor is past the turn already; what matters is that the REPLAY adds
    // nothing to it.
    const afterFirst = await stub.cursor();
    const second = await stub.appendTurn(turn("slack:E1"));

    expect(second.appended).toBe(false);
    expect(second.event.seq).toBe(first.event.seq);
    expect(await stub.cursor()).toBe(afterFirst);
  });

  it("schedules one generation for the first input and reuses it for a duplicate", async () => {
    const { stub } = await freshRun();
    const first = await stub.appendTurn(turn("slack:E1"));
    const replay = await stub.appendTurn(turn("slack:E1"));

    expect(first.scheduling.outcome).toBe("allocated");
    expect(replay.scheduling).toEqual({
      outcome: "duplicate",
      generationId: first.scheduling.outcome === "allocated" ? first.scheduling.generationId : null,
    });
    expect((await stub.state())?.status).toBe("live");
  });

  it("streams tool updates through the same object", async () => {
    const { stub } = await freshRun();
    await stub.appendToolCallUpdate({
      id: "tool:c1:0",
      callId: "c1",
      name: "code",
      state: "running",
      input: { source: "await memory.search()" },
    });
    await stub.appendToolCallUpdate({
      id: "tool:c1:1",
      callId: "c1",
      name: "code",
      state: "completed",
      output: { facts: 3 },
    });

    const calls = await stub.toolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].state).toBe("completed");
    expect(calls[0].input).toEqual({ source: "await memory.search()" });
  });

  it("refuses an illegal transition without changing state", async () => {
    const { stub } = await freshRun();
    await stub.setStatus("done");

    const refused = await stub.setStatus("idle");
    expect(refused.ok).toBe(false);
    expect(refused.status).toBe("done");
    expect((await stub.state())?.status).toBe("done");
  });

  it("reports an idempotent same-state change as eventless", async () => {
    const { stub } = await freshRun();
    const same = await stub.setStatus("idle");
    expect(same).toMatchObject({ ok: true, changed: false, event: null });
  });
});

describe("d1 index is kept in step", () => {
  it("moves updated_at after a committed turn", async () => {
    const { stub, record } = await freshRun();
    const before = await getRunById(env.DB, record.id);

    await stub.appendTurn({ ...turn("t-a"), createdAt: (before?.updatedAt ?? 0) + 60_000 });
    await stub.flushProjections();

    const after = await getRunById(env.DB, record.id);
    expect(after!.updatedAt).toBeGreaterThan(before!.updatedAt);
  });

  it("repairs the index on a retry that appended nothing", async () => {
    const { stub, record } = await freshRun();
    const created = await getRunById(env.DB, record.id);
    const at = created!.updatedAt + 60_000;

    await stub.appendTurn({ ...turn("slack:E1"), createdAt: at });
    await stub.flushProjections();

    // Simulate the first attempt having failed after committing the event:
    // rewind the index, then let the queue retry.
    await env.DB.prepare("UPDATE runs SET updated_at = ? WHERE id = ?")
      .bind(created!.updatedAt, record.id)
      .run();

    const replay = await stub.appendTurn({ ...turn("slack:E1"), createdAt: at });
    expect(replay.appended).toBe(false);
    await stub.flushProjections();

    const repaired = await getRunById(env.DB, record.id);
    expect(repaired!.updatedAt).toBe(at);
  });

  it("writes a status change to both stores through one call", async () => {
    const { stub, record } = await freshRun();
    // awaiting_approval is reached from live: a run parks on an approval while
    // it is working, never straight out of idle.
    await stub.setStatus("live");
    await stub.setStatus("awaiting_approval");

    // Local state is durable immediately; D1 is a projection the call does not
    // await, so the index catches up through the projector.
    expect((await stub.state())?.status).toBe("awaiting_approval");
    await stub.flushProjections();
    expect((await getRunById(env.DB, record.id))?.status).toBe("awaiting_approval");
  });

  it("does not await d1 on the local event path", async () => {
    const { stub, record } = await freshRun();
    // A D1 outage is simulated by removing the index row entirely: every write
    // below still has to commit, broadcast and return.
    await env.DB.prepare("DELETE FROM runs WHERE id = ?").bind(record.id).run();

    await expect(stub.appendTurn(turn("t-outage"))).resolves.toMatchObject({ appended: true });
    await expect(stub.setStatus("awaiting_approval")).resolves.toMatchObject({ ok: true });
    await expect(stub.setSummary("still working")).resolves.toMatchObject({ changed: true });
    expect((await stub.state())?.summary).toBe("still working");
  });

  it("does not fail a mutation when the index row is missing", async () => {
    const { stub } = await freshRun();
    await env.DB.prepare("DELETE FROM runs").run();

    // The DO owns the session; a lagging or deleted index must not break it.
    await expect(stub.appendTurn(turn("t-orphan"))).resolves.toMatchObject({ appended: true });
  });
});

describe("eviction", () => {
  it("returns the same state, turns, tool calls and cursor afterwards", async () => {
    const { stub, descriptor } = await freshRun();
    await stub.appendTurn(turn("t-a"));
    await stub.appendToolCallUpdate({
      id: "tool:c1:0",
      callId: "c1",
      name: "code",
      state: "running",
      input: { source: "x" },
    });
    await stub.setStatus("awaiting_approval");

    const before = {
      state: await stub.state(),
      turns: await stub.turns(),
      calls: await stub.toolCalls(),
      cursor: await stub.cursor(),
    };

    await evictDurableObject(stub);

    const after = {
      state: await stub.state(),
      turns: await stub.turns(),
      calls: await stub.toolCalls(),
      cursor: await stub.cursor(),
    };

    expect(after).toEqual(before);
    expect(after.state?.runId).toBe(descriptor.runId);
  });

  it("has no in-memory state to lose", async () => {
    const { stub } = await freshRun();
    await stub.appendTurn(turn("t-a"));
    await evictDurableObject(stub);

    // The constructor re-ran; schema setup is idempotent and nothing else is
    // required for correctness.
    const next = await stub.appendTurn(turn("t-b"));
    expect(next.appended).toBe(true);
    expect((await stub.turns()).map((t) => t.id)).toEqual(["t-a", "t-b"]);
  });

  it("keeps the constructor free of timers and outbound sockets", async () => {
    const { stub } = await freshRun();
    // A run with no activity must not hold itself open. There is no alarm and
    // nothing scheduled, so an idle object can hibernate.
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBeNull();
  });
});
