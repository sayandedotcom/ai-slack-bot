import { SELF, env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { UIMessage } from "ai";

import { AccessJwtError, type AccessIdentity, type AccessVerifier } from "../src/access/jwt";
import { installIdentityApiPorts, resetIdentityApiPorts } from "../src/api/identity";
import { CHAT_FIRST_MESSAGE_MAX_CHARS } from "../src/api/runs";
import { installTestModel, resetTestModel } from "../src/run/model";
import { getRunById } from "../src/run/repository";
import { cannedModel } from "./helpers/canned-model";
import { waitFor } from "./helpers/wait";

const FIREFIGHTER = "ronit@zellify.app";
const VIEWER = "marcus@zellify.app";
const OUTSIDER = "someone@example.com";

function fakeVerifier(): AccessVerifier {
  return {
    async verify(jwt: string): Promise<AccessIdentity> {
      if (!jwt) throw new AccessJwtError("missing", "no token was supplied");
      if (!jwt.includes("@")) throw new AccessJwtError("malformed", "not an email-shaped token");
      return { email: jwt };
    },
  };
}

function create(body: unknown, token: string): Promise<Response> {
  return SELF.fetch("https://firefighter.test/api/runs", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": token, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function read(runId: string, token: string): Promise<Response> {
  return SELF.fetch(`https://firefighter.test/api/runs/${runId}`, {
    headers: { "Cf-Access-Jwt-Assertion": token },
  });
}

function messagesOf(stub: { getMessages(): Promise<UIMessage[]> }): Promise<UIMessage[]> {
  return stub.getMessages();
}

async function stubFor(runId: string) {
  const run = await getRunById(env.DB, runId);
  return getAgentByName(env.RUN_AGENTS, run?.key ?? "");
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

describe("starting a chat run", () => {
  it("creates one run and answers with the public id alone", async () => {
    const res = await create(
      { firstMessage: "why is the pulsefit exporter stuck?", clientRequestId: crypto.randomUUID() },
      FIREFIGHTER,
    );
    expect(res.status).toBe(201);

    const body = await res.json<{ id: string }>();
    const run = await getRunById(env.DB, body.id);
    expect(run).not.toBeNull();
    expect(run?.origin).toBe("chat");
    // The `chat:{uuid}` key names the Durable Object and never leaves the
    // Worker (invariant 10).
    expect(JSON.stringify(body)).not.toContain(run?.key ?? "never");
    expect(Object.keys(body)).toEqual(["id"]);
  });

  it("submits the first message as the run's opening turn", async () => {
    const res = await create(
      { firstMessage: "the exporter is stuck", clientRequestId: crypto.randomUUID() },
      FIREFIGHTER,
    );
    const { id } = await res.json<{ id: string }>();
    const stub = await stubFor(id);

    const opening = await waitFor("the opening turn", async () => {
      const messages = await messagesOf(stub);
      return messages.length > 0 ? messages : null;
    });
    expect(opening[0].role).toBe("user");
  });

  it("resolves a retried create to the same run, not a second one", async () => {
    // A client that never saw the first response re-sends. Without this, every
    // retry would leave a half-empty run in the dashboard list; the turn-level
    // idempotency key cannot help, because it dedupes INSIDE a run that has
    // already been created.
    const clientRequestId = crypto.randomUUID();
    const first = await create({ firstMessage: "same question", clientRequestId }, FIREFIGHTER);
    const second = await create({ firstMessage: "same question", clientRequestId }, FIREFIGHTER);

    const a = await first.json<{ id: string }>();
    const b = await second.json<{ id: string }>();
    expect(b.id).toBe(a.id);

    const stub = await stubFor(a.id);
    await waitFor("the opening turn", async () => {
      const messages = await messagesOf(stub);
      return messages.length > 0 ? messages : null;
    });
    const asked = (await messagesOf(stub)).filter((message) => message.role === "user");
    expect(asked).toHaveLength(1);
  });

  it("does not let two people collide on one request id", async () => {
    // The derived key covers the ACTOR as well, so a client id two people
    // happen to share cannot put them in one conversation.
    const clientRequestId = crypto.randomUUID();
    const mine = await create({ firstMessage: "mine", clientRequestId }, FIREFIGHTER);
    const theirs = await create({ firstMessage: "theirs", clientRequestId }, VIEWER);

    expect((await mine.json<{ id: string }>()).id).not.toBe(
      (await theirs.json<{ id: string }>()).id,
    );
  });

  it("lets a viewer open one — a chat run says nothing under anyone's name", async () => {
    expect((await create({ firstMessage: "a question" }, VIEWER)).status).toBe(201);
  });

  it("refuses an unverifiable token and an outsider", async () => {
    expect((await create({ firstMessage: "hi" }, "")).status).toBe(401);
    expect((await create({ firstMessage: "hi" }, OUTSIDER)).status).toBe(403);
  });

  it("refuses a body it cannot use, before anything is written", async () => {
    for (const body of [
      "not json",
      {},
      { firstMessage: "" },
      { firstMessage: "   " },
      { firstMessage: 7 },
      { firstMessage: "x".repeat(CHAT_FIRST_MESSAGE_MAX_CHARS + 1) },
      { firstMessage: "ok", clientRequestId: 7 },
      { firstMessage: "ok", clientRequestId: "" },
    ]) {
      const res = await create(body, FIREFIGHTER);
      expect(res.status).toBe(422);
      expect((await res.json<{ code: string }>()).code).toBe("invalid_body");
    }
  });
});

describe("reading one run", () => {
  it("returns the public shape, with no key in it", async () => {
    const created = await create({ firstMessage: "a question" }, FIREFIGHTER);
    const { id } = await created.json<{ id: string }>();

    const res = await read(id, FIREFIGHTER);
    expect(res.status).toBe(200);
    const body = await res.json<{ run: Record<string, unknown> }>();
    expect(body.run).toMatchObject({ id, origin: "chat", shadow: false });
    expect(body.run).not.toHaveProperty("key");
    const run = await getRunById(env.DB, id);
    expect(JSON.stringify(body)).not.toContain(run?.key ?? "never");
  });

  it("404s an id no run has", async () => {
    expect((await read(crypto.randomUUID(), FIREFIGHTER)).status).toBe(404);
  });

  it("404s a raw run key, because a key is not an id", async () => {
    const created = await create({ firstMessage: "a question" }, FIREFIGHTER);
    const { id } = await created.json<{ id: string }>();
    const run = await getRunById(env.DB, id);
    expect((await read(encodeURIComponent(run?.key ?? "x"), FIREFIGHTER)).status).toBe(404);
  });

  it("is gated the same way", async () => {
    const created = await create({ firstMessage: "a question" }, FIREFIGHTER);
    const { id } = await created.json<{ id: string }>();
    expect((await read(id, "")).status).toBe(401);
    expect((await read(id, OUTSIDER)).status).toBe(403);
  });
});
