import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AccessIdentity,
  AccessJwtError,
  type AccessVerifier,
} from "../../src/access/jwt";
import {
  installIdentityApiPorts,
  resetIdentityApiPorts,
} from "../../src/api/identity";
import { getCounters } from "../../src/db/counters";

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

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM events_seen"),
    env.DB.prepare("DELETE FROM messages"),
    // Once `triaged` is a real count, decisions written by triage-consumer.test.ts
    // (created_at = Date.now(), which lands inside these windows) would leak in.
    env.DB.prepare("DELETE FROM triage_decisions"),
    env.DB.prepare("DELETE FROM approvals"),
    env.DB.prepare("DELETE FROM runs"),
  ]);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO events_seen VALUES (?, ?, ?, ?)").bind(
      "e1",
      "C1",
      "ingested",
      NOW
    ),
    env.DB.prepare("INSERT INTO events_seen VALUES (?, ?, ?, ?)").bind(
      "e2",
      "C1",
      "dropped_dm",
      NOW
    ),
    env.DB.prepare("INSERT INTO events_seen VALUES (?, ?, ?, ?)").bind(
      "e3",
      "C1",
      "dropped_bot",
      NOW
    ),
    // yesterday — must not be counted
    env.DB.prepare("INSERT INTO events_seen VALUES (?, ?, ?, ?)").bind(
      "e4",
      "C1",
      "ingested",
      NOW - DAY - 1
    ),
  ]);
});

/** A minimal `runs` row, just enough to satisfy `approvals.run_id`'s FK. */
async function seedRun(id: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, summary, created_at, updated_at)
     VALUES (?, ?, 'slack', 'C1', '1720000000.000100', 'live', 0, NULL, 1, 1)`
  )
    .bind(id, `slack:C1:${id}`)
    .run();
}

/** A minimal `approvals` row, shaped like `escalate` mints one. */
async function seedApproval(input: {
  id: string;
  runId: string;
  createdAt: number;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO approvals
       (id, run_id, generation_id, kind, draft, why, channel_id, thread_ts, created_at, updated_at)
     VALUES (?, ?, 'gen:1', 'slack_reply', 'draft', 'why', 'C1', '1720000000.000100', ?, ?)`
  )
    .bind(input.id, input.runId, input.createdAt, input.createdAt)
    .run();
}

describe("getCounters", () => {
  it("counts heard as every envelope seen in the window", async () => {
    const c = await getCounters(env.DB, NOW - DAY);
    expect(c.heard).toBe(3);
  });

  it("counts ingested as the subset that survived the drop rules", async () => {
    const c = await getCounters(env.DB, NOW - DAY);
    expect(c.ingested).toBe(1);
  });

  it("excludes events outside the window", async () => {
    const c = await getCounters(env.DB, NOW - 1000);
    expect(c.heard).toBe(3);
  });

  it("returns zero for counters later phases populate", async () => {
    const c = await getCounters(env.DB, NOW - DAY);
    expect(c.triaged).toBe(0);
    expect(c.escalated).toBe(0);
  });

  it("counts approvals rows created within the window, one per row regardless of decision", async () => {
    // Distinct runs: the partial unique index allows only one OPEN approval per
    // run, and this test is about the counter's window, not that constraint.
    await seedRun("run1");
    await seedRun("run2");
    await seedRun("run3");
    await seedApproval({ id: "apr:1", runId: "run1", createdAt: NOW });
    await seedApproval({ id: "apr:2", runId: "run2", createdAt: NOW });
    // yesterday — must not be counted
    await seedApproval({
      id: "apr:3",
      runId: "run3",
      createdAt: NOW - DAY - 1,
    });

    const c = await getCounters(env.DB, NOW - DAY);
    expect(c.escalated).toBe(2);
  });

  it("counts triage decisions within the window", async () => {
    await env.DB.prepare(
      `INSERT INTO triage_decisions (event_id, wake, why, opening_prompt, model, cost_usd, latency_ms, created_at)
       VALUES ('EvT1', 1, 'q', 'p', 'claude-haiku-4-5', 0.0003, 400, 5000),
              ('EvT2', 0, 'banter', '', 'claude-haiku-4-5', 0.0002, 300, 1000)`
    ).run();
    const counters = await getCounters(env.DB, 2000);
    expect(counters.triaged).toBe(1); // only EvT1 is inside the window
  });

  it("counts woken as the triage decisions that said wake, and dropped as the rest", async () => {
    await env.DB.prepare(
      `INSERT INTO triage_decisions (event_id, wake, why, opening_prompt, model, cost_usd, latency_ms, created_at)
       VALUES ('EvW1', 1, 'q', 'p', 'claude-haiku-4-5', 0.0003, 400, ?),
              ('EvW2', 0, 'banter', '', 'claude-haiku-4-5', 0.0002, 300, ?),
              ('EvW3', 0, 'banter', '', 'claude-haiku-4-5', 0.0002, 300, ?)`
    )
      .bind(NOW, NOW, NOW)
      .run();
    const c = await getCounters(env.DB, NOW - DAY);
    expect(c.triaged).toBe(3);
    expect(c.woken).toBe(1);
    expect(c.dropped).toBe(2);
  });

  it("returns all zeros for an empty window without throwing", async () => {
    const c = await getCounters(env.DB, NOW + DAY);
    expect(c).toEqual({
      heard: 0,
      ingested: 0,
      triaged: 0,
      woken: 0,
      dropped: 0,
      escalated: 0,
    });
  });
});

describe("GET /api/counters", () => {
  beforeEach(() => {
    resetIdentityApiPorts();
    installIdentityApiPorts({ verifier: fakeVerifier() });
  });

  const read = (query = "") =>
    SELF.fetch(`https://example.com/api/counters${query}`, {
      headers: { "Cf-Access-Jwt-Assertion": "ronit@zellify.app" },
    });

  it("serves the six counters as json, defaulting to a 24h window", async () => {
    const res = await read();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counters: Record<string, number>;
      since: number;
      window: string;
    };
    expect(Object.keys(body.counters).sort()).toEqual([
      "dropped",
      "escalated",
      "heard",
      "ingested",
      "triaged",
      "woken",
    ]);
    expect(body.window).toBe("24h");
    expect(Date.now() - body.since).toBeGreaterThan(86_400_000 - 5_000);
  });

  it("accepts window=7d", async () => {
    const res = await read("?window=7d");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { since: number; window: string };
    expect(body.window).toBe("7d");
    expect(Date.now() - body.since).toBeGreaterThan(7 * 86_400_000 - 5_000);
  });

  it("refuses an unknown window", async () => {
    const res = await read("?window=1y");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      "invalid_window"
    );
  });

  it("is gated like every other dashboard read", async () => {
    const res = await SELF.fetch("https://example.com/api/counters");
    expect(res.status).toBe(401);
  });
});
