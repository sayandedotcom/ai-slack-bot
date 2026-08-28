import { env, SELF } from "cloudflare:test";
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

const MEMBER = "marcus@zellify.app";

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

async function seedRun(id: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, summary, created_at, updated_at)
     VALUES (?, ?, 'chat', NULL, NULL, 'done', 0, NULL, 1, 1)`
  )
    .bind(id, `chat:${id}`)
    .run();
}

async function seedEffect(input: {
  runId: string;
  turnId: string;
  namespace: string;
  method: string;
  state: string;
  safeResult: unknown;
  createdAt: number;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO codemode_effects
       (effect_key, run_id, turn_id, namespace, method, args_hash, state, safe_result_json, safe_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      input.runId,
      input.turnId,
      input.namespace,
      input.method,
      `hash-${crypto.randomUUID()}`,
      input.state,
      input.safeResult === null ? null : JSON.stringify(input.safeResult),
      input.createdAt,
      input.createdAt
    )
    .run();
}

beforeEach(() => {
  resetIdentityApiPorts();
  installIdentityApiPorts({ verifier: fakeVerifier() });
});
afterEach(() => resetIdentityApiPorts());

const read = (runId: string, token = MEMBER) =>
  SELF.fetch(`https://firefighter.test/api/runs/${runId}/effects`, {
    headers: { "Cf-Access-Jwt-Assertion": token },
  });

describe("GET /api/runs/:id/effects", () => {
  it("lists a run's effects newest first with the parsed safe result", async () => {
    const runId = crypto.randomUUID();
    await seedRun(runId);
    await seedEffect({
      runId,
      turnId: "turn:1",
      namespace: "slack",
      method: "post",
      state: "completed",
      safeResult: { ts: "1.2", permalink: "https://slack.example/p/1" },
      createdAt: 1_000,
    });
    await seedEffect({
      runId,
      turnId: "turn:2",
      namespace: "github",
      method: "openPullRequest",
      state: "completed",
      safeResult: {
        html_url: "https://github.com/Zellify/web2app-rebuild/pull/9",
      },
      createdAt: 2_000,
    });

    const res = await read(runId);
    expect(res.status).toBe(200);
    const body = await res.json<{ effects: Record<string, unknown>[] }>();
    expect(body.effects.map((e) => e.method)).toEqual([
      "openPullRequest",
      "post",
    ]);
    expect(body.effects[1]).toEqual({
      turnId: "turn:1",
      namespace: "slack",
      method: "post",
      state: "completed",
      safeResult: { ts: "1.2", permalink: "https://slack.example/p/1" },
      safeError: null,
      createdAt: 1_000,
    });
  });

  it("never exposes the args hash or the effect key", async () => {
    const runId = crypto.randomUUID();
    await seedRun(runId);
    await seedEffect({
      runId,
      turnId: "t",
      namespace: "linear",
      method: "createIssue",
      state: "in_doubt",
      safeResult: null,
      createdAt: 1,
    });
    const text = await (await read(runId)).text();
    expect(text).not.toContain("hash-");
    expect(text).not.toContain("effect_key");
    expect(text).not.toContain("args");
  });

  it("404s an unknown run and 401s without a token", async () => {
    expect((await read("nope")).status).toBe(404);
    expect(
      (await SELF.fetch("https://firefighter.test/api/runs/x/effects")).status
    ).toBe(401);
  });
});
