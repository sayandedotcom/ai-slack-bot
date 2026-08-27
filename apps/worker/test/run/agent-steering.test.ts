import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

import {
  consumeSteers,
  pendingSteers,
  queueSteer,
  type SqlTag,
  steerMessageText,
  steerText,
} from "../../src/run/agent-steering";
import { chatRunKey } from "../../src/run/keys";
import { createOrGetRun } from "../../src/run/repository";

async function boundRun() {
  const key = chatRunKey(crypto.randomUUID());
  const run = await createOrGetRun(env.DB, {
    key,
    origin: "chat",
    channelId: null,
    threadTs: null,
  });
  const stub = await getAgentByName(env.RUN_AGENTS, key);
  await stub.bindRun({ runId: run.id, channel: "web" });
  return { run, stub };
}

/** An in-memory stand-in for `Agent.sql`, good enough for the table helpers. */
function fakeSql(): SqlTag {
  const rows = new Map<
    string,
    { request_id: string; text: string; created_at: number }
  >();
  return ((
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ) => {
    const query = strings.join("?").replace(/\s+/g, " ").trim();
    if (query.startsWith("CREATE TABLE")) return [];
    if (query.startsWith("INSERT OR IGNORE INTO pending_steers")) {
      const [requestId, text, createdAt] = values as [string, string, number];
      if (!rows.has(requestId))
        rows.set(requestId, {
          request_id: requestId,
          text,
          created_at: createdAt,
        });
      return [];
    }
    if (query.startsWith("DELETE FROM pending_steers")) {
      rows.clear();
      return [];
    }
    if (query.startsWith("SELECT request_id")) {
      return [...rows.values()].sort(
        (a, b) =>
          a.created_at - b.created_at ||
          a.request_id.localeCompare(b.request_id)
      );
    }
    throw new Error(`unexpected query: ${query}`);
  }) as SqlTag;
}

describe("the steer table", () => {
  it("keeps the first text when a request id is re-sent", () => {
    // A reconnecting tab re-sends. Overwriting would silently change what a
    // human asked for.
    const sql = fakeSql();
    queueSteer(sql, {
      requestId: "req-1",
      text: "check the exporter",
      createdAt: 1,
    });
    queueSteer(sql, {
      requestId: "req-1",
      text: "something else",
      createdAt: 2,
    });
    expect(pendingSteers(sql)).toEqual([
      { requestId: "req-1", text: "check the exporter", createdAt: 1 },
    ]);
  });

  it("drains everything once, oldest first", () => {
    const sql = fakeSql();
    queueSteer(sql, { requestId: "b", text: "second", createdAt: 2 });
    queueSteer(sql, { requestId: "a", text: "first", createdAt: 1 });

    expect(consumeSteers(sql).map((row) => row.text)).toEqual([
      "first",
      "second",
    ]);
    // Read-then-delete in one synchronous call: nothing can interleave, so no
    // steer is delivered twice or dropped.
    expect(consumeSteers(sql)).toEqual([]);
  });

  it("refuses whitespace, so a mis-fired keystroke cannot wake a run", () => {
    expect(() => steerText("   ")).toThrow(/a steer needs text/);
    expect(steerText("  look again  ")).toBe("look again");
  });

  it("frames a steer as the operator speaking, not the customer", () => {
    // The model has to tell an instruction from its own operator apart from
    // evidence about the conversation.
    const text = steerMessageText({
      requestId: "r",
      text: "stop and ask them",
      createdAt: 1,
    });
    expect(text).toContain("engineer watching this run");
    expect(text).toContain("not a customer message");
    expect(text).toContain("stop and ask them");
  });
});

describe("steering a run", () => {
  it("queues rather than waking while a turn is running", async () => {
    const { stub } = await boundRun();
    await stub.setStatus("live");

    expect(await stub.steer("look at the 04:12 deploy", "req-a")).toEqual({
      queued: true,
      woke: false,
    });
    expect((await stub.pendingSteersForTest()).map((row) => row.text)).toEqual([
      "look at the 04:12 deploy",
    ]);
  });

  it("steers once when one request id is sent twice", async () => {
    const { stub } = await boundRun();
    await stub.setStatus("live");

    await stub.steer("first", "req-b");
    expect(await stub.steer("first", "req-b")).toEqual({
      queued: false,
      woke: false,
    });
    expect(await stub.pendingSteersForTest()).toHaveLength(1);
  });

  it("stores a steer on a parked run instead of surfacing it", async () => {
    // Defect 13: a new instruction reaching the model while a human still has
    // the previous reply open for decision is what the pause exists to prevent.
    const { stub } = await boundRun();
    await stub.setOpenApproval("apr:5");

    expect(await stub.steer("actually tell them no", "req-c")).toEqual({
      queued: true,
      woke: false,
    });
    expect(await stub.pendingSteersForTest()).toHaveLength(1);
  });

  it("wakes an idle run instead of queueing", async () => {
    // The submit IS the wake: there is no separate "start the run" call, and a
    // second one would be a second way to begin a turn.
    //
    // The submit runs from a zero-delay schedule rather than inline, because
    // `runTurn` called inside a Durable Object RPC deadlocks — even unawaited —
    // and every caller of `steer` reaches it as an RPC.
    //
    // NOTHING IS ASSERTED AFTER THIS. The scheduled turn starts immediately and
    // the test pool binds AGENT_MODEL_DISABLED, so the turn cannot complete and
    // the object stops answering RPC. That is a harness limit, not a defect in
    // steering: a turn with no model behind it is not a state production can be
    // in. The wake path's own behaviour is Task 19's to cover, against a model
    // seam it can control.
    const { stub } = await boundRun();
    expect(await stub.steer("have another look", "req-e")).toEqual({
      queued: false,
      woke: true,
    });
  });
});
