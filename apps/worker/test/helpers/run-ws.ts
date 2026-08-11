import { env } from "cloudflare:test";
import { expect } from "vitest";
import { chatRunKey, runStubForKey } from "../../src/run/keys";
import { createOrGetRun } from "../../src/run/repository";
import type { RunEvent, RunServerMessage, RunTurnInput } from "../../src/run/protocol";

/**
 * Shared harness for the run WebSocket suites.
 *
 * Lives in helpers/, not in a test file: importing across test files re-runs
 * the imported file's suites inside the importer.
 *
 * Storage is shared across cases and files in this pool, so `freshRun()` mints
 * its own key every time and no assertion depends on an absolute seq. See
 * docs/superpowers/plans/phase-08-notes.md.
 */

export async function freshRun() {
  const key = chatRunKey(crypto.randomUUID());
  const record = await createOrGetRun(env.DB, {
    key,
    origin: "chat",
    channelId: null,
    threadTs: null,
  });
  const stub = runStubForKey(env.RUNS, key);
  await stub.initialize({
    runId: record.id,
    key,
    origin: "chat",
    channelId: null,
    threadTs: null,
  });
  return { key, runId: record.id, stub };
}

export type Socket = { ws: WebSocket; inbox: RunServerMessage[] };

export async function connect(stub: DurableObjectStub, since?: number): Promise<Socket> {
  const query = since === undefined ? "" : `?since=${since}`;
  const res = await stub.fetch(`https://run/ws${query}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);

  const ws = res.webSocket!;
  const inbox: RunServerMessage[] = [];
  ws.addEventListener("message", (event) => {
    inbox.push(JSON.parse(event.data as string) as RunServerMessage);
  });
  ws.accept();
  return { ws, inbox };
}

export async function waitFor(
  socket: Socket,
  match: (m: RunServerMessage) => boolean,
  timeoutMs = 2_000,
): Promise<RunServerMessage> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = socket.inbox.find(match);
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(`no match; inbox was ${JSON.stringify(socket.inbox)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Drains the initial backlog and returns the cursor the server settled on. */
export async function syncedCursor(socket: Socket): Promise<number> {
  const done = await waitFor(socket, (m) => m.type === "sync" && m.complete);
  return (done as Extract<RunServerMessage, { type: "sync" }>).cursor;
}

export function syncedEvents(socket: Socket): RunEvent[] {
  return socket.inbox.flatMap((m) => (m.type === "sync" ? m.events : []));
}

export function turn(id: string, content = "look at the logs"): RunTurnInput {
  return { id, role: "user", source: "human_steer", content };
}
