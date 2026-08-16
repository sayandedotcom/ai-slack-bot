import { SELF, createExecutionContext, env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/index";
import { runsApi } from "../src/api/runs";
import type { RunAgent } from "../src/run/agent";
import { createOrGetRun } from "../src/run/repository";

/**
 * Invariant 32, in one assertion.
 *
 * This is the failure with no error attached: a late projection carrying an
 * OLDER revision overwrites a newer one, and the dashboard shows a finished run
 * as failed — or a failed run as live — with nothing thrown, nothing logged and
 * a `runs` row that looks perfectly well-formed. Only the guard on
 * `projection_seq` catches it, and only a real out-of-order pair proves the
 * guard is bound the way it reads.
 */
describe("RunAgent D1 projection", () => {
  it("advances the projection only when the sequence increases", async () => {
    // A FRESH key per case: pool storage is shared across tests and files.
    const key = `chat:${crypto.randomUUID()}`;
    // The projection targets an existing `runs` row by id — a `WHERE id = ?`
    // that matches nothing is a silent no-op, so the row has to be seeded here.
    const run = await createOrGetRun(env.DB, {
      key,
      origin: "chat",
      channelId: null,
      threadTs: null,
    });

    const agent = await getAgentByName<Env, RunAgent>(env.RUN_AGENTS, key);
    await agent.projectForTest({ seq: 5, status: "live", summary: "five" });
    // Lower sequence, and every field it carries differs — so an unguarded
    // UPDATE would be visible in all three columns.
    await agent.projectForTest({ seq: 4, status: "failed", summary: "four" });

    const row = await env.DB.prepare(
      "SELECT status, summary, projection_seq FROM runs WHERE id = ?",
    )
      .bind(run.id)
      .first<{ status: string; summary: string | null; projection_seq: number }>();

    expect(row?.projection_seq).toBe(5);
    expect(row?.status).toBe("live");
    expect(row?.summary).toBe("five");
  });
});

/* ------------------------------------------------- the dashboard's list -- */

/**
 * The other end of the projection: what `GET /api/runs` shows.
 *
 * The legacy chassis pins this in `test/run-api.test.ts` § "run index
 * projection reaches the dashboard", against `RunDO.setSummary` +
 * `flushProjections`. Think has no such pair — `projectTurn` IS the bundle, and
 * `onStepFinish` is its only production caller — so none of that carries over
 * by inspection. Every case here seeds its own run and finds its own row by id:
 * pool storage is shared, so `runs` is never empty and the list length is never
 * an assertion.
 */

/** A fresh Think run: its own key, its own D1 row, its own agent. */
async function thinkRunFor() {
  const key = `chat:${crypto.randomUUID()}`;
  const record = await createOrGetRun(env.DB, {
    key,
    origin: "chat",
    channelId: null,
    threadTs: null,
  });
  const agent = await getAgentByName<Env, RunAgent>(env.RUN_AGENTS, key);
  return { key, runId: record.id, agent };
}

type ListedRun = {
  id: string;
  origin: string;
  status: string;
  shadow: boolean;
  summary: string | null;
  channelId: string | null;
  channelName: string | null;
  customerSlug: string | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * The list, at the maximum page size, as the dashboard asks for it.
 *
 * `limit=200` (`RUN_LIST_MAX_LIMIT`) rather than the default 50 because the
 * table carries every other file's rows; the row under test is the one just
 * projected, so `ORDER BY updated_at DESC` keeps it at the top of that page.
 */
async function listedRun(runId: string): Promise<ListedRun | undefined> {
  const res = await SELF.fetch("https://firefighter.test/api/runs?limit=200");
  expect(res.status).toBe(200);
  const body = await res.json<{ runs: ListedRun[] }>();
  return body.runs.find((run) => run.id === runId);
}

describe("Think run index projection reaches the dashboard", () => {
  it("shows the newest summary and status the agent projected", async () => {
    const { runId, agent } = await thinkRunFor();

    await agent.projectForTest({ seq: Date.now(), status: "live", summary: "first summary" });
    await agent.projectForTest({
      seq: Date.now() + 1,
      status: "awaiting_approval",
      summary: "waiting on the on-duty engineer",
    });

    const listed = await listedRun(runId);
    // Status and summary travel in ONE bundle: the Phase 08 failure this
    // replaces was a fresh status beside a stale summary, which reads as a
    // confident, wrong answer on the dashboard rather than as an error.
    expect(listed?.status).toBe("awaiting_approval");
    expect(listed?.summary).toBe("waiting on the on-duty engineer");
  });

  it("serves the list without touching a run durable object binding", async () => {
    const { runId, agent } = await thinkRunFor();
    await agent.projectForTest({ seq: Date.now(), status: "live", summary: "mid-incident" });

    // A TRIPWIRE ENV, not an inspection after the fact. `RUNS` and `RUN_AGENTS`
    // are recorded the moment the route so much as READS the binding off `env`
    // — earlier than `.get()`, earlier than `idFromName` — because that read is
    // the only thing that has to happen for a wake to become possible.
    //
    // Counting is the whole assertion: the route is left working, so a failure
    // here says "it woke an object", not "it broke". At fifty listed runs a
    // per-row wake is fifty objects instantiated to render one page, and it
    // costs nothing observable in a test that only checks the JSON.
    const touched: string[] = [];
    const watched = new Proxy(env as unknown as Record<string, unknown>, {
      get(target, prop, receiver) {
        if (prop === "RUNS" || prop === "RUN_AGENTS" || prop === "SANDBOX") {
          touched.push(String(prop));
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as Env;

    // The sub-app directly, because `SELF.fetch` runs against the deployed
    // Worker's own env and there is nowhere to hand it a watched one. Same
    // handler, same route — `runsApi` is mounted at `/api` in `src/index.ts`.
    const res = await runsApi.fetch(
      new Request("https://firefighter.test/runs?limit=200"),
      watched,
      createExecutionContext(),
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ runs: ListedRun[] }>();
    // A real list of a real run — otherwise "nothing woke" would also be true
    // of a 400.
    expect(body.runs.find((run) => run.id === runId)?.summary).toBe("mid-incident");
    expect(touched).toEqual([]);
  });

  it("keeps the newest bundle when two lifecycle changes race", async () => {
    const { runId, agent } = await thinkRunFor();
    const seq = Date.now();

    // Both in flight at once, with nothing awaited between them: which one
    // reaches D1 first is genuinely undecided. The list must show the newer
    // revision either way — the guard is on the revision, not on arrival order
    // and not on a timestamp two same-millisecond writes would tie on.
    await Promise.all([
      agent.projectForTest({ seq, status: "live", summary: "first summary" }),
      agent.projectForTest({ seq: seq + 1, status: "done", summary: "second summary" }),
    ]);

    const listed = await listedRun(runId);
    expect(listed?.status).toBe("done");
    expect(listed?.summary).toBe("second summary");

    // And the two bundles were never MIXED: `projection_seq` names exactly the
    // revision whose status and summary are on the row above.
    const row = await env.DB.prepare("SELECT projection_seq FROM runs WHERE id = ?")
      .bind(runId)
      .first<{ projection_seq: number }>();
    expect(row?.projection_seq).toBe(seq + 1);
  });

  it("never exposes a type or category field on a projected run", async () => {
    const { runId, agent } = await thinkRunFor();
    await agent.projectForTest({
      seq: Date.now(),
      status: "live",
      summary: "checkout is timing out for pulsefit",
    });

    const listed = await listedRun(runId);
    expect(listed).toBeDefined();

    // The hard rule from the spec, asserted on the SHAPE rather than by
    // grepping the body: triage emits `{ wake, why, opening_prompt }` and never
    // a ticket type, and nothing downstream branches on one. A `type` or
    // `category` reaching the browser is how a classification gets reintroduced
    // — first as a badge, then as something the loop reads back.
    expect(Object.keys(listed!).sort()).toEqual([
      "channelId",
      "channelName",
      "createdAt",
      "customerSlug",
      "id",
      "origin",
      "shadow",
      "status",
      "summary",
      "updatedAt",
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/"(type|category)":/);
  });
});
