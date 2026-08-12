import { env, evictDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  connect,
  freshRun,
  syncedCursor,
  turn,
  waitFor,
  type Socket,
} from "./helpers/run-ws";
import type { RunServerMessage } from "../src/run/protocol";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM runs").run();
});

type EventFrame = Extract<RunServerMessage, { type: "event" }>;

async function nextEvent(socket: Socket, seq: number): Promise<EventFrame> {
  return (await waitFor(
    socket,
    (m) => m.type === "event" && m.event.seq === seq,
  )) as EventFrame;
}

function deliveredSeqs(socket: Socket): number[] {
  return socket.inbox.filter((m) => m.type === "event").map((m) => (m as EventFrame).event.seq);
}

describe("live broadcast", () => {
  it("two tabs on one run see the same event and seq", async () => {
    const { stub } = await freshRun();
    const tabA = await connect(stub);
    const tabB = await connect(stub);
    await syncedCursor(tabA);
    await syncedCursor(tabB);

    const { event } = await stub.appendTurn(turn("t-shared", "same bytes"));

    const [fromA, fromB] = await Promise.all([
      nextEvent(tabA, event.seq),
      nextEvent(tabB, event.seq),
    ]);

    expect(fromA.event.seq).toBe(event.seq);
    // "byte-equivalent", not merely deep-equal: a per-socket transform that
    // reordered keys or injected a cursor would slip past toEqual.
    expect(JSON.stringify(fromA.event)).toBe(JSON.stringify(fromB.event));
  });

  it("does not replay an event the socket already got in its backlog", async () => {
    const { stub } = await freshRun();
    const first = await stub.appendTurn(turn("t-1"));

    const socket = await connect(stub);
    await syncedCursor(socket);

    const second = await stub.appendTurn(turn("t-2"));
    await nextEvent(socket, second.event.seq);

    // The backlog carried t-1; only t-2 may arrive as a live event.
    expect(deliveredSeqs(socket)).toEqual([second.event.seq]);
    expect(deliveredSeqs(socket)).not.toContain(first.event.seq);
  });

  it("delivers concurrent appends in seq order", async () => {
    const { stub } = await freshRun();
    const socket = await connect(stub);
    await syncedCursor(socket);

    // Both RPCs are in flight at once, and each awaits a D1 write after
    // committing. If the broadcast moved after that await, the higher seq could
    // land first, set the cursor, and the lower seq would be skipped forever.
    const [first, second] = await Promise.all([
      stub.appendTurn(turn("t-a")),
      stub.appendTurn(turn("t-b")),
    ]);

    const expected = [first.event.seq, second.event.seq].sort((x, y) => x - y);
    await nextEvent(socket, expected[1]);

    // The first input also broadcast its idle -> live status, so the stream is
    // a superset of the two turns; what must hold is that it is strictly
    // ascending and lost nothing.
    const delivered = deliveredSeqs(socket);
    expect(delivered).toEqual([...delivered].sort((x, y) => x - y));
    expect(new Set(delivered).size).toBe(delivered.length);
    expect(delivered).toContain(expected[0]);
    expect(delivered).toContain(expected[1]);
  });

  it("broadcasts tool updates and status changes too", async () => {
    const { stub } = await freshRun();
    // awaiting_approval is reached from live, and a run is live once something
    // scheduled work on it.
    await stub.setStatus("live");
    const socket = await connect(stub);
    await syncedCursor(socket);

    const tool = await stub.appendToolCallUpdate({
      id: "tool:c1:0",
      callId: "c1",
      name: "code",
      state: "running",
      input: { source: "x" },
    });
    const status = await stub.setStatus("awaiting_approval");

    await nextEvent(socket, status.ok ? status.event!.seq : -1);
    const types = socket.inbox
      .filter((m) => m.type === "event")
      .map((m) => (m as EventFrame).event.type);

    expect(types).toEqual(["tool_call", "status"]);
    expect(tool.appended).toBe(true);
  });

  it("keeps serving other tabs when one socket is closed", async () => {
    const { stub } = await freshRun();
    const alive = await connect(stub);
    const doomed = await connect(stub);
    await syncedCursor(alive);
    await syncedCursor(doomed);

    doomed.ws.close();

    const { event } = await stub.appendTurn(turn("t-after-close"));
    const seen = await nextEvent(alive, event.seq);
    expect(seen.event.seq).toBe(event.seq);
  });
});

describe("steering", () => {
  it("commits a steer and acks it with the committed seq", async () => {
    const { stub } = await freshRun();
    const socket = await connect(stub);
    await syncedCursor(socket);

    socket.ws.send(JSON.stringify({ type: "steer", requestId: "r-1", content: "try staging" }));

    const ack = (await waitFor(socket, (m) => m.type === "ack")) as Extract<
      RunServerMessage,
      { type: "ack" }
    >;
    expect(ack.requestId).toBe("r-1");

    const turns = await stub.turns();
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      id: "steer:r-1",
      role: "user",
      source: "human_steer",
      content: "try staging",
    });
    // The ack names the turn's own seq. The cursor is one further along,
    // because the same transaction also committed the idle -> live status.
    expect(ack.seq).toBe((await stub.cursor()) - 1);
    expect((await stub.state())?.status).toBe("live");
  });

  it("reaches every tab, not just the one that typed", async () => {
    const { stub } = await freshRun();
    const typing = await connect(stub);
    const watching = await connect(stub);
    await syncedCursor(typing);
    await syncedCursor(watching);

    typing.ws.send(JSON.stringify({ type: "steer", requestId: "r-1", content: "hello" }));

    const ack = (await waitFor(watching, (m) => m.type === "event")) as EventFrame;
    expect(ack.event.type).toBe("turn");
  });

  it("resumes a parked run", async () => {
    const { stub } = await freshRun();
    await stub.setStatus("awaiting_approval");

    const socket = await connect(stub);
    await syncedCursor(socket);
    socket.ws.send(JSON.stringify({ type: "steer", requestId: "r-1", content: "go ahead" }));
    await waitFor(socket, (m) => m.type === "ack");

    expect((await stub.state())?.status).toBe("live");
  });

  it("reopens a finished run rather than forking a second one", async () => {
    const { stub, runId } = await freshRun();
    await stub.setStatus("done");

    const socket = await connect(stub);
    await syncedCursor(socket);
    socket.ws.send(JSON.stringify({ type: "steer", requestId: "r-1", content: "one more thing" }));
    await waitFor(socket, (m) => m.type === "ack");

    const state = await stub.state();
    expect(state?.status).toBe("live");
    expect(state?.runId).toBe(runId);
  });

  it("is idempotent on requestId, so a retry does not double-steer", async () => {
    const { stub } = await freshRun();
    const socket = await connect(stub);
    await syncedCursor(socket);

    const frame = JSON.stringify({ type: "steer", requestId: "r-1", content: "once" });
    socket.ws.send(frame);
    await waitFor(socket, (m) => m.type === "ack");
    socket.ws.send(frame);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await stub.turns()).toHaveLength(1);
  });

  it.each([
    ["{not json", "invalid_json"],
    [JSON.stringify({ type: "ping" }), "unknown_type"],
    [JSON.stringify({ type: "steer", requestId: "r", content: "   " }), "empty_content"],
    [
      JSON.stringify({ type: "steer", requestId: "r", content: "x", source: "approval" }),
      "server_owned_field",
    ],
  ])("answers %j with an error frame and commits nothing", async (frame, code) => {
    const { stub } = await freshRun();
    const socket = await connect(stub);
    await syncedCursor(socket);

    socket.ws.send(frame);

    const error = (await waitFor(socket, (m) => m.type === "error")) as Extract<
      RunServerMessage,
      { type: "error" }
    >;
    expect(error.code).toBe(code);
    expect(await stub.turns()).toHaveLength(0);
  });

  it("does not broadcast a rejected steer to other tabs", async () => {
    const { stub } = await freshRun();
    const typing = await connect(stub);
    const watching = await connect(stub);
    await syncedCursor(typing);
    await syncedCursor(watching);

    typing.ws.send(JSON.stringify({ type: "steer", requestId: "r", content: "" }));
    await waitFor(typing, (m) => m.type === "error");

    expect(watching.inbox.filter((m) => m.type === "event")).toHaveLength(0);
  });
});

describe("hibernation", () => {
  it("resumes an attached socket after the instance is torn down", async () => {
    const { stub } = await freshRun();
    const socket = await connect(stub);
    const cursor = await syncedCursor(socket);

    // Destroys the instance. The socket hibernates rather than closing.
    await evictDurableObject(stub, { webSockets: "hibernate" });

    const { event } = await stub.appendTurn(turn("t-after-evict"));
    expect(event.seq).toBeGreaterThan(cursor);

    const live = await nextEvent(socket, event.seq);
    expect(live.event.seq).toBe(event.seq);
  });

  it("still accepts steering over a hibernated socket", async () => {
    const { stub } = await freshRun();
    const socket = await connect(stub);
    await syncedCursor(socket);

    await evictDurableObject(stub, { webSockets: "hibernate" });

    // Exercises webSocketMessage after constructor re-entry: the class handler
    // survives where an addEventListener would not have.
    socket.ws.send(JSON.stringify({ type: "steer", requestId: "r-1", content: "after wake" }));
    const ack = (await waitFor(socket, (m) => m.type === "ack")) as Extract<
      RunServerMessage,
      { type: "ack" }
    >;

    expect(ack.requestId).toBe("r-1");
    expect((await stub.turns()).map((t) => t.id)).toEqual(["steer:r-1"]);
  });

  it("keeps each socket's cursor across eviction", async () => {
    const { stub } = await freshRun();
    const early = await connect(stub);
    await syncedCursor(early);

    const first = await stub.appendTurn(turn("t-1"));
    await nextEvent(early, first.event.seq);

    await evictDurableObject(stub, { webSockets: "hibernate" });

    const second = await stub.appendTurn(turn("t-2"));
    await nextEvent(early, second.event.seq);

    // The attachment survived, so t-1 was not resent after the wake. The status
    // event between them is the live transition t-1 scheduled.
    const delivered = deliveredSeqs(early);
    expect(delivered).toEqual([...delivered].sort((x, y) => x - y));
    expect(new Set(delivered).size).toBe(delivered.length);
    expect(delivered[0]).toBe(first.event.seq);
    expect(delivered[delivered.length - 1]).toBe(second.event.seq);
  });
});

describe("auto response", () => {
  it("answers ping with pong without reaching the message handler", async () => {
    const { stub } = await freshRun();
    const res = await stub.fetch("https://run/ws", { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket!;

    const raw: string[] = [];
    ws.addEventListener("message", (event) => {
      raw.push(event.data as string);
    });
    ws.accept();

    ws.send("ping");

    const deadline = Date.now() + 2_000;
    while (!raw.includes("pong") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(raw).toContain("pong");
    // "ping" is not valid JSON; had it reached webSocketMessage it would have
    // produced an invalid_json error frame instead.
    expect(raw.some((m) => m.includes("invalid_json"))).toBe(false);
    ws.close();
  });
});
