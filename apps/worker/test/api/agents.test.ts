import { env, SELF } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type AccessIdentity,
  AccessJwtError,
  type AccessVerifier,
} from "../../src/access/jwt";
import {
  installIdentityApiPorts,
  resetIdentityApiPorts,
} from "../../src/api/identity";
import { chatRunKey } from "../../src/run/keys";
import { installTestModel, resetTestModel } from "../../src/run/model";
import { getRunById } from "../../src/run/repository";
import {
  AGENT_IDENTITY_HEADER,
  BLOCKED_CLIENT_FRAMES,
  isBlockedClientFrame,
} from "../../src/run/transport";
import { createRunFromChat } from "../../src/run/wake";
import { cannedModel } from "../helpers/canned-model";
import { waitFor } from "../helpers/wait";

const FIREFIGHTER = "ronit@zellify.app";
const VIEWER = "marcus@zellify.app";
const OUTSIDER = "someone@example.com";

/** The header value IS the identity: no signing, no JWKS, no network. */
function fakeVerifier(): AccessVerifier {
  return {
    async verify(jwt: string): Promise<AccessIdentity> {
      if (!jwt) throw new AccessJwtError("missing", "no token was supplied");
      if (!jwt.includes("@"))
        throw new AccessJwtError("malformed", "not an email-shaped token");
      return { email: jwt };
    },
  };
}

async function seedRun(): Promise<{ runId: string; key: string }> {
  const { runId } = await createRunFromChat(env, {});
  const run = await getRunById(env.DB, runId);
  if (run === null) throw new Error("the create wrote no run row");
  return { runId, key: run.key };
}

/**
 * The transcript, typed.
 *
 * `getAgentByName` without explicit type arguments widens the stub's methods to
 * `never`, and naming only the one method these cases read keeps the helper
 * honest about what it touches.
 */
function messagesOf(stub: {
  getMessages(): Promise<UIMessage[]>;
}): Promise<UIMessage[]> {
  return stub.getMessages();
}

function url(path: string): string {
  return `https://firefighter.test${path}`;
}

/**
 * Open the run socket through the Worker.
 *
 * A real upgrade, not a plain fetch: workerd normalises upgrades to GET and
 * Node's fetch forbids the Upgrade header outright, so a test that "checks the
 * route" with an ordinary request is checking a different code path than the
 * dashboard takes.
 */
async function connect(runId: string, token: string): Promise<Response> {
  return SELF.fetch(url(`/api/runs/${runId}/agent`), {
    headers: { Upgrade: "websocket", "Cf-Access-Jwt-Assertion": token },
  });
}

/** Every frame the server sends until it goes quiet, as raw strings. */
function drain(socket: WebSocket, quietMs = 120): Promise<string[]> {
  const frames: string[] = [];
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const settle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => resolve(frames), quietMs);
    };
    socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data === "string") frames.push(event.data);
      settle();
    });
    settle();
  });
}

beforeEach(() => {
  resetIdentityApiPorts();
  installIdentityApiPorts({ verifier: fakeVerifier() });
  installTestModel(cannedModel());
});
afterEach(() => {
  resetIdentityApiPorts();
  resetTestModel();
});

describe("addressing a run", () => {
  it("reaches the agent by its public id", async () => {
    const { runId } = await seedRun();
    const res = await connect(runId, FIREFIGHTER);
    expect(res.status).toBe(101);
    expect(res.webSocket).not.toBeNull();
    res.webSocket?.accept();
    res.webSocket?.close();
  });

  it("404s a raw run key in the URL, because a key is not an id", async () => {
    // The whole point of the id -> key resolution: a caller who guesses the
    // Durable Object's name cannot address it (invariant 10).
    const { key } = await seedRun();
    const res = await connect(encodeURIComponent(key), FIREFIGHTER);
    expect(res.status).toBe(404);
  });

  it("404s an id no run has", async () => {
    const res = await connect(crypto.randomUUID(), FIREFIGHTER);
    expect(res.status).toBe(404);
  });

  it("401s without a token and 403s an outsider, before D1 is read", async () => {
    const { runId } = await seedRun();
    expect((await connect(runId, "")).status).toBe(401);
    expect((await connect(runId, "garbage")).status).toBe(401);
    expect((await connect(runId, OUTSIDER)).status).toBe(403);
  });

  it("lets a viewer watch, because reads are for any of the seven", async () => {
    const { runId } = await seedRun();
    const res = await connect(runId, VIEWER);
    expect(res.status).toBe(101);
    res.webSocket?.accept();
    res.webSocket?.close();
  });
});

describe("the transcript read", () => {
  it("is gated by the same check as the socket", async () => {
    const { runId } = await seedRun();
    const path = `/api/runs/${runId}/agent/get-messages`;

    expect((await SELF.fetch(url(path))).status).toBe(401);
    expect(
      (
        await SELF.fetch(url(path), {
          headers: { "Cf-Access-Jwt-Assertion": OUTSIDER },
        })
      ).status
    ).toBe(403);

    const ok = await SELF.fetch(url(path), {
      headers: { "Cf-Access-Jwt-Assertion": FIREFIGHTER },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual([]);
  });

  it("never carries the run key", async () => {
    const { runId, key } = await seedRun();
    const res = await SELF.fetch(url(`/api/runs/${runId}/agent/get-messages`), {
      headers: { "Cf-Access-Jwt-Assertion": FIREFIGHTER },
    });
    expect(await res.text()).not.toContain(key);
  });
});

describe("what the socket says first", () => {
  it("sends no frame carrying the run key or an identity frame", async () => {
    // `sendIdentityOnConnect: false` is what suppresses `cf_agent_identity`,
    // whose payload is the instance NAME — which here is the private run key.
    const { runId, key } = await seedRun();
    const res = await connect(runId, FIREFIGHTER);
    const socket = res.webSocket;
    if (!socket) throw new Error("no socket");
    socket.accept();

    const frames = await drain(socket);
    socket.close();

    expect(frames.join("\n")).not.toContain(key);
    expect(frames.some((frame) => frame.includes("cf_agent_identity"))).toBe(
      false
    );
  });

  it("does send the run's live state, which is what the dashboard renders", async () => {
    const { runId } = await seedRun();
    const res = await connect(runId, FIREFIGHTER);
    const socket = res.webSocket;
    if (!socket) throw new Error("no socket");
    socket.accept();

    const frames = await drain(socket);
    socket.close();

    const state = frames
      .map((frame) => JSON.parse(frame) as { type?: string; state?: unknown })
      .find((frame) => frame.type === "cf_agent_state");
    expect(state?.state).toMatchObject({ runId, status: "idle" });
  });
});

describe("what a browser may not do", () => {
  async function open(runId: string) {
    const res = await connect(runId, FIREFIGHTER);
    const socket = res.webSocket;
    if (!socket) throw new Error("no socket");
    socket.accept();
    await drain(socket);
    return socket;
  }

  it("cannot start a turn with a chat-request frame", async () => {
    // Think honours this frame from any connection and readonly does not gate
    // it. `steer` is the only door, and it stamps an input revision.
    const { runId } = await seedRun();
    const stub = await getAgentByName(
      env.RUN_AGENTS,
      (await getRunById(env.DB, runId))?.key ?? ""
    );
    const socket = await open(runId);

    socket.send(
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: "req-1",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "m1",
                role: "user",
                parts: [{ type: "text", text: "do a thing" }],
              },
            ],
          }),
        },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    socket.close();

    expect(await messagesOf(stub)).toEqual([]);
    expect((await stub.runStateForTest()).inputRevision).toBe(0);
  });

  it("cannot wipe a customer conversation with a clear frame", async () => {
    const { runId } = await seedRun();
    const key = (await getRunById(env.DB, runId))?.key ?? "";
    const stub = await getAgentByName(env.RUN_AGENTS, key);
    await stub.steer("look at the exporter", "req-clear");
    await waitFor("the steer's turn", async () => {
      const messages = await messagesOf(stub);
      return messages.length > 0 ? messages : null;
    });

    const socket = await open(runId);
    socket.send(JSON.stringify({ type: "cf_agent_chat_clear" }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    socket.close();

    expect((await messagesOf(stub)).length).toBeGreaterThan(0);
  });

  it("cannot overwrite the run's durable state", async () => {
    // Unparking a run a human still has open for decision would be one frame.
    const { runId } = await seedRun();
    const stub = await getAgentByName(
      env.RUN_AGENTS,
      (await getRunById(env.DB, runId))?.key ?? ""
    );
    await stub.setOpenApproval("apr:held");

    const socket = await open(runId);
    socket.send(
      JSON.stringify({
        type: "cf_agent_state",
        state: { runId, openApprovalId: null },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    socket.close();

    expect((await stub.runStateForTest()).openApprovalId).toBe("apr:held");
  });
});

describe("what a browser may do", () => {
  it("steers once when one request id is sent twice", async () => {
    // The SDK gives a `@callable` no idempotency of its own and a reconnecting
    // tab re-sends, so the dedupe is the agent's.
    const { runId } = await seedRun();
    const stub = await getAgentByName(
      env.RUN_AGENTS,
      (await getRunById(env.DB, runId))?.key ?? ""
    );

    expect(await stub.steer("check the 04:12 deploy", "req-a")).toEqual({
      queued: false,
      woke: true,
    });
    await waitFor("the steer's turn", async () => {
      const messages = await messagesOf(stub);
      return messages.length > 0 ? messages : null;
    });
    expect(await stub.steer("check the 04:12 deploy", "req-a")).toEqual({
      queued: false,
      woke: false,
    });

    const steers = (await messagesOf(stub)).filter(
      (message) => message.role === "user"
    );
    expect(steers).toHaveLength(1);
  });
});

describe("the blocked-frame list", () => {
  it("names every frame Think acts on that is not steer", () => {
    expect([...BLOCKED_CLIENT_FRAMES].sort()).toEqual([
      "cf_agent_chat_clear",
      "cf_agent_chat_request_cancel",
      "cf_agent_tool_approval",
      "cf_agent_tool_result",
      "cf_agent_use_chat_request",
    ]);
  });

  it("passes through anything it cannot read, rather than claiming to have understood it", () => {
    expect(isBlockedClientFrame("not json")).toBe(false);
    expect(isBlockedClientFrame(new ArrayBuffer(4))).toBe(false);
    expect(
      isBlockedClientFrame(JSON.stringify({ type: "cf_agent_state" }))
    ).toBe(false);
    expect(
      isBlockedClientFrame(JSON.stringify({ type: "cf_agent_chat_clear" }))
    ).toBe(true);
  });

  it("names the identity header the route stamps", () => {
    expect(AGENT_IDENTITY_HEADER).toBe("x-firefighter-identity");
  });
});
