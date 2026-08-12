import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createChatRun,
  routeSlackMessageToOwnedRun,
  wakeSlackRun,
  type SlackRunMessage,
} from "../src/run/coordinator";
import { runStubForKey, slackRunKey } from "../src/run/keys";
import { getRunByKey } from "../src/run/repository";

/**
 * Wiping D1 does NOT wipe Durable Object storage — there is no isolatedStorage
 * in this pool. A reused Slack key would keep its old run_state, get a fresh D1
 * uuid, and initialize would rightly refuse it. So every case gets its own
 * thread ts, which is the per-test-key rule from phase-08-notes.md.
 */
function freshThreadTs(): string {
  const seconds = 1_720_000_000 + Math.floor(Math.random() * 9_000_000);
  const micros = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  return `${seconds}.${micros}`;
}

let threadTs: string;

beforeEach(async () => {
  threadTs = freshThreadTs();
  await env.DB.prepare("DELETE FROM runs").run();
  await env.DB.prepare("DELETE FROM channels").run();
  await env.DB.prepare(
    "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES ('C1', 'pulsefit-eng', 'pulsefit', 'live')",
  ).run();
});

function slackMessage(overrides: Partial<SlackRunMessage> = {}): SlackRunMessage {
  return {
    eventId: "Ev1",
    channelId: "C1",
    ts: "1720000009.999999",
    threadTs,
    text: "any update on this?",
    userId: "U1",
    permalink: "https://slack.com/archives/C1/p1",
    ...overrides,
  };
}

describe("wakeSlackRun", () => {
  it("creates one run and one opening turn", async () => {
    const run = await wakeSlackRun(env, {
      eventId: "Ev1",
      channelId: "C1",
      threadTs,
      openingPrompt: "Customer asks about language variants.",
    });

    expect(run.origin).toBe("slack");
    expect(run.status).toBe("live");

    const stub = runStubForKey(env.RUNS, run.key);
    const turns = await stub.turns();
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ id: "triage:Ev1", role: "system", source: "triage" });
  });

  it("is idempotent, so a queue replay adds no second run or turn", async () => {
    const input = {
      eventId: "Ev1",
      channelId: "C1",
      threadTs,
      openingPrompt: "Customer asks about language variants.",
    };
    const first = await wakeSlackRun(env, input);
    const second = await wakeSlackRun(env, input);

    expect(second.id).toBe(first.id);
    expect(await runStubForKey(env.RUNS, first.key).turns()).toHaveLength(1);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs").first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("converges on one run when two wakes race", async () => {
    const input = {
      eventId: "Ev1",
      channelId: "C1",
      threadTs,
      openingPrompt: "prompt",
    };
    const [a, b] = await Promise.all([wakeSlackRun(env, input), wakeSlackRun(env, input)]);

    expect(b.id).toBe(a.id);
    expect(await runStubForKey(env.RUNS, a.key).turns()).toHaveLength(1);
  });

  it("reopens a finished thread on the same object and keeps its history", async () => {
    const first = await wakeSlackRun(env, {
      eventId: "Ev1",
      channelId: "C1",
      threadTs,
      openingPrompt: "first",
    });
    const stub = runStubForKey(env.RUNS, first.key);
    await stub.setStatus("done");

    const second = await wakeSlackRun(env, {
      eventId: "Ev2",
      channelId: "C1",
      threadTs,
      openingPrompt: "second",
    });

    expect(second.id).toBe(first.id);
    expect(second.status).toBe("live");
    // History is continuous, not restarted.
    expect((await stub.turns()).map((t) => t.id)).toEqual(["triage:Ev1", "triage:Ev2"]);
  });
});

describe("routeSlackMessageToOwnedRun", () => {
  it("returns false when no run owns the thread", async () => {
    expect(await routeSlackMessageToOwnedRun(env, slackMessage())).toBe(false);
  });

  it("commits the message as a customer turn and says so", async () => {
    const run = await wakeSlackRun(env, {
      eventId: "Ev0",
      channelId: "C1",
      threadTs,
      openingPrompt: "opening",
    });

    expect(await routeSlackMessageToOwnedRun(env, slackMessage())).toBe(true);

    const turns = await runStubForKey(env.RUNS, run.key).turns();
    expect(turns.map((t) => t.id)).toEqual(["triage:Ev0", "slack:Ev1"]);
    expect(turns[1]).toMatchObject({ role: "user", source: "customer" });
    expect(turns[1].metadata).toMatchObject({ permalink: "https://slack.com/archives/C1/p1" });
  });

  it("does not double-commit a redelivered message", async () => {
    const run = await wakeSlackRun(env, {
      eventId: "Ev0",
      channelId: "C1",
      threadTs,
      openingPrompt: "opening",
    });

    await routeSlackMessageToOwnedRun(env, slackMessage());
    await routeSlackMessageToOwnedRun(env, slackMessage());

    expect(await runStubForKey(env.RUNS, run.key).turns()).toHaveLength(2);
  });

  it("canonicalises a root message to its own ts", async () => {
    const ts = threadTs;
    await wakeSlackRun(env, {
      eventId: "Ev0",
      channelId: "C1",
      threadTs: ts,
      openingPrompt: "opening",
    });

    // A root message carries thread_ts = null and must still find the run.
    const routed = await routeSlackMessageToOwnedRun(
      env,
      slackMessage({ eventId: "Ev1", ts, threadTs: null }),
    );
    expect(routed).toBe(true);
  });

  it("wakes an interrupted run back to live", async () => {
    const run = await wakeSlackRun(env, {
      eventId: "Ev0",
      channelId: "C1",
      threadTs,
      openingPrompt: "opening",
    });
    const stub = runStubForKey(env.RUNS, run.key);
    await stub.setStatus("awaiting_approval");

    await routeSlackMessageToOwnedRun(env, slackMessage());

    expect((await stub.state())?.status).toBe("live");
  });

  it("does not claim a thread whose run is done", async () => {
    const run = await wakeSlackRun(env, {
      eventId: "Ev0",
      channelId: "C1",
      threadTs,
      openingPrompt: "opening",
    });
    await runStubForKey(env.RUNS, run.key).setStatus("done");

    // Triage must run again; it may then reopen this same run.
    expect(await routeSlackMessageToOwnedRun(env, slackMessage())).toBe(false);
  });
});

describe("createChatRun", () => {
  it("mints a public id distinct from the private key", async () => {
    const { run } = await createChatRun(env);
    expect(run.key.startsWith("chat:")).toBe(true);
    expect(run.key).not.toContain(run.id);
  });

  it("appends a first message through the same inbox", async () => {
    const { run, stub } = await createChatRun(env, {
      firstMessage: "what happened with pulsefit last week?",
      requestId: "r-1",
    });

    const turns = await stub.turns();
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ id: "steer:r-1", role: "user", source: "human_steer" });
    expect(run.origin).toBe("chat");
  });
});

describe("http api", () => {
  it("lists runs from d1", async () => {
    await wakeSlackRun(env, {
      eventId: "Ev1",
      channelId: "C1",
      threadTs,
      openingPrompt: "opening",
    });

    const res = await SELF.fetch("https://firefighter.test/api/runs");
    expect(res.status).toBe(200);

    const body = await res.json<{ runs: Array<Record<string, unknown>> }>();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].channelName).toBe("pulsefit-eng");
    expect(body.runs[0].customerSlug).toBe("pulsefit");
    // The origin key never crosses to the browser.
    expect(Object.keys(body.runs[0])).not.toContain("key");
  });

  it("returns an empty list rather than an error", async () => {
    const res = await SELF.fetch("https://firefighter.test/api/runs");
    expect(await res.json()).toEqual({ runs: [] });
  });

  it.each([
    ["status=running", "invalid_status"],
    ["limit=0", "invalid_limit"],
    ["limit=99999", "invalid_limit"],
    ["limit=abc", "invalid_limit"],
  ])("rejects ?%s", async (query, code) => {
    const res = await SELF.fetch(`https://firefighter.test/api/runs?${query}`);
    expect(res.status).toBe(400);
    expect((await res.json<{ code: string }>()).code).toBe(code);
  });

  it("creates a chat run with 201 and no key in the body", async () => {
    const res = await SELF.fetch("https://firefighter.test/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstMessage: "hello", requestId: "r-1" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json<{ run: Record<string, unknown> }>();
    expect(body.run.origin).toBe("chat");
    expect(Object.keys(body.run)).not.toContain("key");
  });

  it("rejects a blank first message", async () => {
    const res = await SELF.fetch("https://firefighter.test/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstMessage: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("reads one run with a bounded snapshot", async () => {
    const { run } = await createChatRun(env, { firstMessage: "hello", requestId: "r-1" });

    const res = await SELF.fetch(`https://firefighter.test/api/runs/${run.id}`);
    expect(res.status).toBe(200);

    const body = await res.json<{
      run: { id: string };
      events: Array<{ seq: number }>;
      complete: boolean;
    }>();
    expect(body.run.id).toBe(run.id);
    // The first message plus the idle -> live status its transaction committed.
    expect(body.events).toHaveLength(2);
    expect(body.complete).toBe(true);
  });

  it("404s an unknown run without creating an object", async () => {
    const res = await SELF.fetch(`https://firefighter.test/api/runs/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("steers over http with the same idempotency key as the socket", async () => {
    const { run, stub } = await createChatRun(env);

    const post = () =>
      SELF.fetch(`https://firefighter.test/api/runs/${run.id}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: "r-1", content: "try the other branch" }),
      });

    const first = await post();
    expect(first.status).toBe(201);
    const second = await post();

    expect((await second.json<{ appended: boolean }>()).appended).toBe(false);
    expect(await stub.turns()).toHaveLength(1);
  });

  it("refuses a client-supplied source over http too", async () => {
    const { run } = await createChatRun(env);
    const res = await SELF.fetch(`https://firefighter.test/api/runs/${run.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "r-1", content: "x", source: "approval" }),
    });

    expect(res.status).toBe(400);
    expect((await res.json<{ code: string }>()).code).toBe("server_owned_field");
  });

  it("rejects blank steering content", async () => {
    const { run } = await createChatRun(env);
    const res = await SELF.fetch(`https://firefighter.test/api/runs/${run.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "r-1", content: "   " }),
    });
    expect(res.status).toBe(400);
  });
});

describe("ws route", () => {
  it("upgrades a known run", async () => {
    const { run } = await createChatRun(env, { firstMessage: "hello", requestId: "r-1" });

    const res = await SELF.fetch(`https://firefighter.test/ws/run/${run.id}`, {
      headers: { Upgrade: "websocket" },
    });

    expect(res.status).toBe(101);
    res.webSocket!.accept();
    res.webSocket!.close();
  });

  it("404s an unknown run id", async () => {
    const res = await SELF.fetch(`https://firefighter.test/ws/run/${crypto.randomUUID()}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(404);
  });

  it("426s a non-websocket request to a real run", async () => {
    const { run } = await createChatRun(env);
    const res = await SELF.fetch(`https://firefighter.test/ws/run/${run.id}`);
    expect(res.status).toBe(426);
  });

  it("does not shadow the static asset catch-all", async () => {
    // /ws is mounted above the catch-all; everything else still falls through.
    const res = await SELF.fetch("https://firefighter.test/api/health");
    expect(res.status).toBe(200);
  });
});

describe("run index projection reaches the dashboard", () => {
  it("shows the newest summary and status in the list", async () => {
    const { run, stub } = await createChatRun(env, {
      firstMessage: "why is the deploy stuck?",
      requestId: "r-1",
    });

    await stub.setSummary("investigating the stuck deploy");
    await stub.flushProjections();

    const body = await (
      await SELF.fetch("https://firefighter.test/api/runs")
    ).json<{ runs: Array<{ id: string; status: string; summary: string | null }> }>();
    const listed = body.runs.find((r) => r.id === run.id);

    // Phase 08 wrote the summary locally and only touched updated_at in D1, so
    // this field was permanently null in the list.
    expect(listed?.summary).toBe("investigating the stuck deploy");
    // The first message scheduled work, so the run is live — and the bundled
    // projection carried both facts across together.
    expect(listed?.status).toBe("live");
  });

  it("keeps the newest bundle when two lifecycle changes race", async () => {
    const { run, stub } = await createChatRun(env, {
      firstMessage: "look at staging",
      requestId: "r-1",
    });

    // Two lifecycle changes with nothing awaited between them: the projector
    // must land the newest revision, not whichever D1 write returned last.
    await Promise.all([stub.setSummary("first summary"), stub.setStatus("awaiting_approval")]);
    await stub.setSummary("second summary");
    await stub.flushProjections();

    const body = await (
      await SELF.fetch("https://firefighter.test/api/runs")
    ).json<{ runs: Array<{ id: string; status: string; summary: string | null }> }>();
    const listed = body.runs.find((r) => r.id === run.id);

    expect(listed?.summary).toBe("second summary");
    expect(listed?.status).toBe("awaiting_approval");
  });

  it("reports idle for a run that has no scheduled work", async () => {
    const { run } = await createChatRun(env);

    const body = await (
      await SELF.fetch("https://firefighter.test/api/runs")
    ).json<{ runs: Array<{ id: string; status: string }> }>();

    // A created run is not a working run.
    expect(body.runs.find((r) => r.id === run.id)?.status).toBe("idle");
  });
});

describe("0006 repairs the phase 08 live default", () => {
  it("makes GET /api/runs show idle without waking a durable object", async () => {
    // A row exactly as Phase 08 left it: status 'live' with no driver anywhere.
    const legacyId = crypto.randomUUID();
    const legacyKey = slackRunKey("C1", freshThreadTs());
    await env.DB.prepare(
      `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, summary,
                         created_at, updated_at)
       VALUES (?, ?, 'slack', 'C1', '1720000000.000001', 'live', 0, NULL, 1, 1)`,
    )
      .bind(legacyId, legacyKey)
      .run();

    // The repair as shipped: the statement is taken from the migration file
    // itself, so this cannot pass against a rewritten one.
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0006"));
    expect(migration).toBeDefined();
    const repair = migration!.queries.find((query) => query.trim().startsWith("UPDATE runs"));
    expect(repair).toBeDefined();
    await env.DB.prepare(repair!).run();

    const body = await (
      await SELF.fetch("https://firefighter.test/api/runs")
    ).json<{ runs: Array<{ id: string; status: string }> }>();
    expect(body.runs.find((r) => r.id === legacyId)?.status).toBe("idle");

    // And nothing woke: the run's object was never instantiated, so it has no
    // storage at all — asking D1 is the whole point.
    const stub = runStubForKey(env.RUNS, legacyKey);
    expect(await stub.state()).toBeNull();
  });

  it("leaves statuses that were true alone", async () => {
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0006"))!;
    const repair = migration.queries.find((query) => query.trim().startsWith("UPDATE runs"))!;

    const ids: Record<string, string> = {};
    for (const status of ["awaiting_approval", "done", "failed"]) {
      const id = crypto.randomUUID();
      ids[status] = id;
      await env.DB.prepare(
        `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, summary,
                           created_at, updated_at)
         VALUES (?, ?, 'chat', NULL, NULL, ?, 0, NULL, 1, 1)`,
      )
        .bind(id, `chat:${id}`, status)
        .run();
    }
    await env.DB.prepare(repair).run();

    for (const [status, id] of Object.entries(ids)) {
      const row = await env.DB.prepare("SELECT status FROM runs WHERE id = ?")
        .bind(id)
        .first<{ status: string }>();
      expect(row?.status).toBe(status);
    }
  });
});

describe("no ticket type anywhere in the run layer", () => {
  it("never exposes a type or category field", async () => {
    const run = await wakeSlackRun(env, {
      eventId: "Ev1",
      channelId: "C1",
      threadTs,
      openingPrompt: "opening",
    });

    const listed = await (await SELF.fetch("https://firefighter.test/api/runs")).text();
    const detail = await (
      await SELF.fetch(`https://firefighter.test/api/runs/${run.id}`)
    ).text();

    for (const body of [listed, detail]) {
      expect(body).not.toMatch(/"(type|category)":\s*"(bug|feature|question)"/);
    }
    expect(await getRunByKey(env.DB, slackRunKey("C1", threadTs))).not.toBeNull();
  });
});
