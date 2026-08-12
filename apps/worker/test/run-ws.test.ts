import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  connect,
  freshRun,
  syncedCursor,
  syncedEvents,
  turn,
  waitFor,
} from "./helpers/run-ws";
import type { RunServerMessage } from "../src/run/protocol";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM runs").run();
});

describe("upgrade contract", () => {
  it("refuses a plain HTTP request with 426", async () => {
    const { stub } = await freshRun();
    const res = await stub.fetch("https://run/ws");
    expect(res.status).toBe(426);
    expect((await res.json<{ code: string }>()).code).toBe("upgrade_required");
  });

  it("refuses a non-GET request", async () => {
    const { stub } = await freshRun();
    const res = await stub.fetch("https://run/ws", { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("cannot see a non-GET method on an upgrade, and that is workerd's doing", async () => {
    const { stub } = await freshRun();
    // workerd normalises a WebSocket upgrade to GET before the object sees it,
    // so the method guard is unreachable for upgrade requests. Asserted rather
    // than assumed, because the guard reads as if it covers this case.
    const res = await stub.fetch("https://run/ws", {
      method: "POST",
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(101);

    // Accept and close, or workerd logs a destroyed-pipe exception on teardown.
    res.webSocket!.accept();
    res.webSocket!.close();
  });

  it.each(["-1", "abc", "1.5", ""])("returns a structured 400 for since=%j", async (since) => {
    const { stub } = await freshRun();
    const res = await stub.fetch(`https://run/ws?since=${since}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ code: string }>()).code).toBe("invalid_since");
  });

  it("reports the run status on the sync frame", async () => {
    const { stub } = await freshRun();
    // A run reaches awaiting_approval from live, and a run is only live once
    // something scheduled work on it.
    await stub.setStatus("live");
    await stub.setStatus("awaiting_approval");

    const socket = await connect(stub);
    const frame = (await waitFor(socket, (m) => m.type === "sync")) as Extract<
      RunServerMessage,
      { type: "sync" }
    >;
    expect(frame.status).toBe("awaiting_approval");
  });
});

describe("cursor replay", () => {
  it("replays only events after the client cursor", async () => {
    const { stub } = await freshRun();
    const a = await stub.appendTurn(turn("t-1"));
    const b = await stub.appendTurn(turn("t-2"));
    const c = await stub.appendTurn(turn("t-3"));

    const socket = await connect(stub, a.event.seq);
    await syncedCursor(socket);

    // The first turn also committed the idle -> live status event, so the
    // replay is everything above the cursor, not only the later turns.
    const seqs = syncedEvents(socket).map((e) => e.seq);
    expect(seqs.every((seq) => seq > a.event.seq)).toBe(true);
    expect(seqs).toContain(b.event.seq);
    expect(seqs).toContain(c.event.seq);
  });

  it("returns an empty complete sync when the client is current", async () => {
    const { stub } = await freshRun();
    await stub.appendTurn(turn("t-1"));
    const current = await stub.cursor();

    const socket = await connect(stub, current);
    expect(await syncedCursor(socket)).toBe(current);
    expect(syncedEvents(socket)).toEqual([]);
  });

  it("clamps a cursor from the future instead of muting the run", async () => {
    const { stub } = await freshRun();
    await stub.appendTurn(turn("t-1"));
    const current = await stub.cursor();

    // Without the clamp the attachment would hold a lastSeq no event ever
    // exceeds, and #broadcast would skip this client forever.
    const socket = await connect(stub, current + 10_000);
    expect(await syncedCursor(socket)).toBe(current);
  });

  it("replays the whole run from since=0", async () => {
    const { stub } = await freshRun();
    const a = await stub.appendTurn(turn("t-1"));
    const b = await stub.appendTurn(turn("t-2"));

    const socket = await connect(stub);
    await syncedCursor(socket);

    const replayed = syncedEvents(socket).map((e) => e.seq);
    expect(replayed).toEqual([...replayed].sort((x, y) => x - y));
    expect(replayed).toContain(a.event.seq);
    expect(replayed).toContain(b.event.seq);
  });

  it("includes turn, tool and status events in one ordered stream", async () => {
    const { stub } = await freshRun();
    await stub.appendTurn(turn("t-1"));
    await stub.appendToolCallUpdate({
      id: "tool:c1:0",
      callId: "c1",
      name: "code",
      state: "running",
      input: { source: "x" },
    });
    await stub.setStatus("awaiting_approval");

    const socket = await connect(stub);
    await syncedCursor(socket);

    // The second status is the explicit awaiting_approval; the first is the
    // live transition the input turn committed with itself.
    const events = syncedEvents(socket);
    expect(events.map((e) => e.type)).toEqual(["turn", "status", "tool_call", "status"]);
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((x, y) => x - y));
  });
});

describe("chunked backlog", () => {
  it("sends strictly ordered unique seqs across multiple frames", async () => {
    const { stub } = await freshRun();

    // SYNC_CHUNK is 200; 205 events forces a second frame.
    for (let i = 0; i < 205; i++) {
      await stub.appendTurn(turn(`t-${i}`));
    }

    const socket = await connect(stub);
    const cursor = await syncedCursor(socket);

    const frames = socket.inbox.filter((m) => m.type === "sync");
    expect(frames.length).toBeGreaterThan(1);

    // Exactly one terminal frame, and it is the last one.
    const completes = frames.filter(
      (m) => (m as Extract<RunServerMessage, { type: "sync" }>).complete,
    );
    expect(completes).toHaveLength(1);
    expect(frames[frames.length - 1]).toBe(completes[0]);

    // 205 turns plus the live status the first one committed.
    const seqs = syncedEvents(socket).map((e) => e.seq);
    expect(seqs).toHaveLength(206);
    expect(new Set(seqs).size).toBe(206);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(cursor).toBe(seqs[seqs.length - 1]);
  }, 30_000);
});
