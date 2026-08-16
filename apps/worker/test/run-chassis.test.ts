import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/index";
import { runsApi, runsWs } from "../src/api/runs";
import type { RunAgent } from "../src/run/agent";
import { createRunFromChat, resolveChassis, RunChassisError, wakeRun } from "../src/run/chassis";
import { routeSlackMessageToOwnedRun } from "../src/run/coordinator";
import { getRunByKey } from "../src/run/repository";

/**
 * A FRESH key per case. Pool storage is shared across tests and files (no
 * `isolatedStorage`), so a reused key would carry another case's submissions —
 * and this suite's whole subject is whether a submission is a repeat.
 */
function freshSlackKey(): string {
  const channel = `C${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  const micros = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  return `slack:${channel}:${Math.floor(Date.now() / 1000)}.${micros}`;
}

describe("wakeRun", () => {
  it("does not start a second turn for a repeated Slack event id", async () => {
    const think: Env = { ...env, RUN_CHASSIS: "think" };
    const key = freshSlackKey();
    const eventId = `Ev${crypto.randomUUID()}`;

    // The one genuinely new behaviour of the Think chassis: idempotency moves
    // from the hand-rolled turn id inside `RunDO.appendTurn` onto the durable
    // submission row keyed by `idempotencyKey` (verified fact 10). A Slack
    // `event_id` redelivered by the queue must be admitted exactly once —
    // twice would answer the same customer message twice.
    const first = await wakeRun(think, key, "opening prompt", { idempotencyKey: eventId });
    const second = await wakeRun(think, key, "opening prompt", { idempotencyKey: eventId });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
  });
});

/** The channel a Slack key names, so a policy row can be seeded for it. */
function channelOf(slackKey: string): string {
  return slackKey.split(":")[1];
}

async function seedChannel(slackKey: string, mode: "observe" | "live"): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, 'acme', ?)",
  )
    .bind(channelOf(slackKey), `ext-${channelOf(slackKey).toLowerCase()}`, mode)
    .run();
}

async function setChannelMode(slackKey: string, mode: "observe" | "live"): Promise<void> {
  await env.DB.prepare("UPDATE channels SET mode = ? WHERE channel_id = ?")
    .bind(mode, channelOf(slackKey))
    .run();
}

/** The Think session that owns `key` — the object a wake has to land in. */
function agentFor(key: string) {
  return getAgentByName<Env, RunAgent>(env.RUN_AGENTS, key);
}

/**
 * The idempotency token of every durable submission the Think session holds.
 *
 * This is the Think chassis's "turns" — `RunDO.turns()` has no counterpart here,
 * and `cf_think_submissions` is the durable record of what was admitted. Reading
 * the tokens rather than just the count means a test can say WHICH wake landed,
 * which is the difference between "one turn" and "the right one turn".
 */
async function submissionKeys(key: string): Promise<string[]> {
  // Narrowed the same way `SubmitOnlyAgent` in `src/run/chassis.ts` is, and for
  // a neighbouring reason: `ThinkSubmissionInspection` carries a
  // `Record<string, unknown>` field, so the Durable Object stub's RPC return
  // mapping collapses `listSubmissions` to `never` at the type level even though
  // the call is exactly right at runtime. This restates the one field read here.
  const agent = (await agentFor(key)) as unknown as {
    listSubmissions(options?: { limit?: number }): Promise<{ idempotencyKey?: string }[]>;
  };
  const submissions = await agent.listSubmissions({ limit: 50 });
  return submissions.map((submission) => submission.idempotencyKey ?? "(none)").sort();
}

async function runRowCount(key: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM runs WHERE "key" = ?')
    .bind(key)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** `slack:{channel}:{thread_ts}` split back out, for the owned-thread cases. */
function slackPartsOf(slackKey: string): { channelId: string; threadTs: string } {
  const [, channelId, threadTs] = slackKey.split(":");
  return { channelId, threadTs };
}

describe("wakeRun on the think chassis", () => {
  /**
   * THE SILENT FAILURE THIS CATCHES, and it is two failures wearing one shape.
   *
   * Before Task 14 the think branch went straight to `runTurn` and never
   * touched D1, so a Slack run on this chassis had NO `runs` row: nothing for
   * the write guard to read, nothing for `/agents/*` to resolve an id to,
   * nothing for the projection to update. Both directions of that are silent —
   * an `observe` channel looks fine because the guard happens to fail closed on
   * the missing row, and a `live` channel looks fine right up until the run
   * cannot be addressed.
   *
   * So both modes are asserted here. Shadow alone would also pass if the code
   * simply hardcoded `mustShadow: true`, which would be safe and useless; the
   * `live` half is what proves the policy is actually read.
   */
  it("creates the D1 run row under the channel policy before it wakes", async () => {
    const think: Env = { ...env, RUN_CHASSIS: "think" };
    const observed = freshSlackKey();
    const live = freshSlackKey();
    await seedChannel(observed, "observe");
    await seedChannel(live, "live");

    await wakeRun(think, observed, "opening prompt", {
      idempotencyKey: `Ev${crypto.randomUUID()}`,
    });
    await wakeRun(think, live, "opening prompt", { idempotencyKey: `Ev${crypto.randomUUID()}` });

    const shadowed = await getRunByKey(env.DB, observed);
    expect(shadowed?.origin).toBe("slack");
    expect(shadowed?.channelId).toBe(channelOf(observed));
    // The flag the shared write guard re-reads before every `external_write`.
    // `true` here IS "this run cannot post".
    expect(shadowed?.shadow).toBe(true);

    const acting = await getRunByKey(env.DB, live);
    expect(acting?.shadow).toBe(false);
  });

  /**
   * `POST /api/runs { firstMessage }` used to reach `RunDO` on both chassis, so
   * under `think` the opening message landed in a session the dashboard was not
   * connected to and was never answered — no error, no event, just silence.
   *
   * The proof that it now lands on the Think session is its idempotency: a
   * second wake carrying the SAME `steer:{requestId}` token is refused, which
   * can only happen if the first one created the submission row.
   */
  it("routes a chat run's opening message to the session the chassis selects", async () => {
    const think: Env = { ...env, RUN_CHASSIS: "think" };
    const requestId = crypto.randomUUID();

    const run = await createRunFromChat(think, { firstMessage: "hello", requestId });
    expect(run.origin).toBe("chat");
    expect(await getRunByKey(env.DB, run.key)).not.toBeNull();

    const repeat = await wakeRun(think, run.key, "hello", {
      idempotencyKey: `steer:${requestId}`,
    });
    expect(repeat.accepted).toBe(false);
  });

  /**
   * The counting half of the idempotency story. The case at the top of this file
   * asserts the `accepted` FLAGS; this one asserts the two durable records those
   * flags are supposed to be describing — one D1 `runs` row and one submission —
   * because a chassis that returned `accepted: false` while still admitting the
   * work would satisfy the flag assertion and answer the customer twice.
   */
  it("creates exactly one run row and one opening submission, and a queue replay adds neither", async () => {
    const think: Env = { ...env, RUN_CHASSIS: "think" };
    const key = freshSlackKey();
    await seedChannel(key, "observe");
    const eventId = `Ev${crypto.randomUUID()}`;

    await wakeRun(think, key, "opening prompt", { idempotencyKey: eventId });
    expect(await runRowCount(key)).toBe(1);
    expect(await submissionKeys(key)).toEqual([eventId]);

    // The queue is at-least-once; this is the redelivery.
    await wakeRun(think, key, "opening prompt", { idempotencyKey: eventId });
    expect(await runRowCount(key)).toBe(1);
    expect(await submissionKeys(key)).toEqual([eventId]);
  });

  /**
   * Two deliveries of the same wake, in flight at once — the shape the ingest
   * queue produces on a retried batch. `INSERT OR IGNORE` and the submission
   * table's idempotency read are both meant to make this converge; the failure
   * it guards is two `runs` rows for one thread, which would give the thread two
   * public ids and let the write guard read the wrong one.
   */
  it("converges on one run and one submission when two wakes race", async () => {
    const think: Env = { ...env, RUN_CHASSIS: "think" };
    const key = freshSlackKey();
    await seedChannel(key, "live");
    const eventId = `Ev${crypto.randomUUID()}`;

    const [a, b] = await Promise.all([
      wakeRun(think, key, "prompt", { idempotencyKey: eventId }),
      wakeRun(think, key, "prompt", { idempotencyKey: eventId }),
    ]);

    // Exactly one of the two admitted the work — never both, never neither.
    expect([a.accepted, b.accepted].filter(Boolean)).toHaveLength(1);
    expect(await runRowCount(key)).toBe(1);
    expect(await submissionKeys(key)).toEqual([eventId]);
  });

  /**
   * A `done` run releases its Slack thread back to triage, which may wake it
   * again. That second wake must reach the SAME session: forking a fresh
   * message-scoped object would drop everything the first incident established
   * and re-ask the customer questions it already has answers to.
   */
  it("reopens a finished thread on the same agent and keeps its earlier submissions", async () => {
    const think: Env = { ...env, RUN_CHASSIS: "think" };
    const key = freshSlackKey();
    await seedChannel(key, "live");
    const first = `Ev${crypto.randomUUID()}`;
    const second = `Ev${crypto.randomUUID()}`;

    await wakeRun(think, key, "first", { idempotencyKey: first });
    const created = await getRunByKey(env.DB, key);
    await env.DB.prepare('UPDATE runs SET status = ? WHERE "key" = ?').bind("done", key).run();

    await wakeRun(think, key, "second", { idempotencyKey: second });

    // Same public id, so the dashboard URL and every `run_id` foreign key that
    // already names this incident still resolve to it.
    expect((await getRunByKey(env.DB, key))?.id).toBe(created?.id);
    expect(await runRowCount(key)).toBe(1);
    // History is continuous, not restarted.
    expect(await submissionKeys(key)).toEqual([first, second].sort());
  });

  /**
   * INVARIANT 37, across two wakes rather than within one.
   *
   * The `observe` -> shadow / `live` -> no shadow reading is already asserted by
   * "creates the D1 run row under the channel policy before it wakes" above.
   * What that case cannot see is the DIRECTION: the ratchet only means anything
   * if a downgrade catches an existing unshadowed run, and if flipping the
   * channel back does not hand that run its authority again. `wakeSlackRun`'s
   * legacy equivalent is covered in `run-shadow-ratchet.test.ts`; the Think
   * chassis re-reads the policy through its own call site in `chassis.ts`, so
   * the property has to be proven there too or only one chassis has it.
   */
  it("shadows an existing run when its channel is downgraded, and never clears the flag again", async () => {
    const think: Env = { ...env, RUN_CHASSIS: "think" };
    const key = freshSlackKey();
    await seedChannel(key, "live");

    await wakeRun(think, key, "first", { idempotencyKey: `Ev${crypto.randomUUID()}` });
    expect((await getRunByKey(env.DB, key))?.shadow).toBe(false);

    await setChannelMode(key, "observe");
    await wakeRun(think, key, "second", { idempotencyKey: `Ev${crypto.randomUUID()}` });
    expect((await getRunByKey(env.DB, key))?.shadow).toBe(true);

    // Somebody flips the channel back. Promoting a drafting run to an acting one
    // is a reviewed action with its own authority; it is not a side effect of a
    // channel edit that a later Slack event happens to observe.
    await setChannelMode(key, "live");
    await wakeRun(think, key, "third", { idempotencyKey: `Ev${crypto.randomUUID()}` });
    expect((await getRunByKey(env.DB, key))?.shadow).toBe(true);
  });

  /**
   * "Fail closed" has two different meanings on this path and only one of them
   * is a refusal, so both are pinned here.
   *
   * An UNMAPPED CHANNEL is a resolvable policy — `getChannelPolicy` answers
   * `known: false`, `canPost` is false, and the run is created SHADOWED. It does
   * not throw, and it must not: the run still ingests, still reasons, still
   * evaluates; it simply cannot emit. Asserting a throw here would be asserting
   * the wrong closure.
   *
   * An UNREADABLE POLICY is the refusal. `chassis.ts` does the row-and-ratchet
   * work before the submit precisely so an unresolvable policy can never become
   * a woken run, and there is deliberately no catch that proceeds with a
   * default. The proof is negative on both records: no `runs` row and no
   * submission, i.e. nothing scheduled that no row says is shadowed.
   */
  it("shadows an unmapped channel but refuses outright when the policy cannot be read", async () => {
    const think: Env = { ...env, RUN_CHASSIS: "think" };

    const unmapped = freshSlackKey(); // deliberately absent from `channels`
    await wakeRun(think, unmapped, "prompt", { idempotencyKey: `Ev${crypto.randomUUID()}` });
    expect((await getRunByKey(env.DB, unmapped))?.shadow).toBe(true);

    const blind: Env = {
      ...think,
      DB: {
        prepare() {
          throw new Error("d1 unavailable");
        },
      } as unknown as D1Database,
    };
    const key = freshSlackKey();
    await seedChannel(key, "live");

    await expect(
      wakeRun(blind, key, "prompt", { idempotencyKey: `Ev${crypto.randomUUID()}` }),
    ).rejects.toThrow();

    expect(await getRunByKey(env.DB, key)).toBeNull();
    expect(await submissionKeys(key)).toEqual([]);
  });
});

/**
 * `RUN_CHASSIS` arrives from a config file at runtime and is typed `string`, so
 * the single read site in `src/run/chassis.ts` is the only thing standing
 * between a typo and a run executing on a session implementation the operator
 * did not choose.
 */
describe("an unrecognised RUN_CHASSIS", () => {
  it("throws rather than falling back to the legacy chassis", async () => {
    const typo: Env = { ...env, RUN_CHASSIS: "Think" };
    const key = freshSlackKey();
    await seedChannel(key, "live");

    expect(() => resolveChassis(typo)).toThrow(RunChassisError);
    await expect(
      wakeRun(typo, key, "prompt", { idempotencyKey: `Ev${crypto.randomUUID()}` }),
    ).rejects.toThrow(RunChassisError);

    // THE LOAD-BEARING HALF. A silent fallback to legacy would have created this
    // row on its way into `RunDO`, and every assertion above would still pass.
    expect(await getRunByKey(env.DB, key)).toBeNull();

    // And the value is never echoed back (invariant 39 applied uniformly: no
    // configured value is quoted, secret-shaped or not).
    const message = await wakeRun(typo, key, "prompt", { idempotencyKey: "Ev" }).then(
      () => "resolved",
      (error: unknown) => String(error),
    );
    expect(message).toContain("RUN_CHASSIS");
    expect(message).not.toContain("Think");
  });
});

describe("the legacy branch of wakeRun", () => {
  /**
   * Chat runs are created and continued by `src/api/runs.ts` against `RunDO`
   * directly and have never gone through a wake. Refusing by NAME is the point:
   * inventing a second chat-creation path inside the wake would be a code path
   * no caller exercises and no test would keep honest.
   */
  it("refuses a chat key by name instead of inventing a second chat path", async () => {
    const legacy: Env = { ...env, RUN_CHASSIS: "legacy" };
    const key = `chat:${crypto.randomUUID()}`;

    const outcome = await wakeRun(legacy, key, "hello", { idempotencyKey: "steer:r-1" }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(RunChassisError);
    expect(String(outcome)).toContain("slack runs only");
    expect(await getRunByKey(env.DB, key)).toBeNull();
  });
});

/**
 * A later message in a thread a run already owns. Continuation bypasses TRIAGE
 * — the model is not asked a second time whether the thread is worth answering —
 * but it must not bypass the SESSION: on the Think chassis the object that owes
 * the customer an answer is the `RunAgent`, and a reply committed anywhere else
 * is a message nothing will ever read.
 */
describe("an owned thread on the think chassis", () => {
  /**
   * KNOWN DEFECT, see TEST-FINDINGS.md.
   *
   * `src/index.ts` wires `routeToOwnedRun` straight to
   * `routeSlackMessageToOwnedRun`, which is `RunDO`-shaped end to end
   * (`ensureSlackRunUnderPolicy` -> `runStubForKey(env.RUNS, ...)` ->
   * `RunDO.appendTurn`). It does not go through `src/run/chassis.ts` and never
   * reads `RUN_CHASSIS`. So under `RUN_CHASSIS=think` a customer's follow-up in
   * a live thread is committed to an empty legacy Durable Object while the
   * `RunAgent` that owns the incident is never woken — the exact silent wrong
   * answer the chassis facade exists to prevent, and the same shape that was
   * fixed for `POST /api/runs` and for the triage wake.
   *
   * `it.fails` rather than a fix: `src/` belongs to the drill terminal.
   */
  it.fails("absorbs a thread reply into the owning RunAgent with no model call", async () => {
    const think: Env = { ...env, RUN_CHASSIS: "think" };
    const key = freshSlackKey();
    await seedChannel(key, "live");
    const { channelId, threadTs } = slackPartsOf(key);
    const opening = `Ev${crypto.randomUUID()}`;
    const reply = `Ev${crypto.randomUUID()}`;

    await wakeRun(think, key, "opening prompt", { idempotencyKey: opening });

    const routed = await routeSlackMessageToOwnedRun(think, {
      eventId: reply,
      channelId,
      ts: threadTs,
      threadTs,
      text: "still broken, any update?",
      userId: "U1",
      permalink: "https://slack.com/archives/C1/p2",
    });

    // Committed, and committed WHERE THE RUN IS. `routed === true` alone is not
    // enough — that is exactly what the legacy path returns while writing into
    // the wrong object.
    expect(routed).toBe(true);
    expect(await submissionKeys(key)).toHaveLength(2);
  });

  /**
   * The other direction, and it holds today because ownership is a D1 status
   * question rather than a session question: `findOwnedSlackRun` counts only
   * `live | awaiting_approval | idle`. A `done` run releases the thread so
   * triage can judge the new message on its merits — and may then reopen this
   * same run through its key.
   */
  it("does not claim a thread whose run is done, on either chassis", async () => {
    const think: Env = { ...env, RUN_CHASSIS: "think" };
    const key = freshSlackKey();
    await seedChannel(key, "live");
    const { channelId, threadTs } = slackPartsOf(key);

    await wakeRun(think, key, "opening prompt", { idempotencyKey: `Ev${crypto.randomUUID()}` });
    await env.DB.prepare('UPDATE runs SET status = ? WHERE "key" = ?').bind("done", key).run();

    const routed = await routeSlackMessageToOwnedRun(think, {
      eventId: `Ev${crypto.randomUUID()}`,
      channelId,
      ts: threadTs,
      threadTs,
      text: "one more thing",
      userId: "U1",
      permalink: null,
    });

    expect(routed).toBe(false);
  });
});

/**
 * INVARIANT 10, at the one boundary where it can actually be broken: the
 * response body. A chat run mints two uuids — the public `runs.id` the browser
 * gets, and the private `chat:{uuid}` key that is the `idFromName()` input — and
 * the whole value of the split is that a browser can never hand us a Durable
 * Object name.
 */
describe("createRunFromChat on the think chassis", () => {
  it("mints a public id distinct from the private key, and never returns the key to the client", async () => {
    const think: Env = { ...env, RUN_CHASSIS: "think" };

    const created = await createRunFromChat(think, {
      firstMessage: "what happened with pulsefit last week?",
      requestId: crypto.randomUUID(),
    });
    expect(created.key.startsWith("chat:")).toBe(true);
    // Two uuids, not one value used twice.
    expect(created.key).not.toContain(created.id);

    // The client's actual view of the same run. `publicRun()` omits `key`, so
    // this is a whole-body assertion rather than a key-list one: a future field
    // that leaked the key under another name would still fail here.
    const response = await runsApi.fetch(
      new Request("http://x/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ firstMessage: "hello", requestId: crypto.randomUUID() }),
      }),
      think,
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { run: { id: string; origin: string } };
    expect(body.run.origin).toBe("chat");

    const row = await env.DB.prepare('SELECT "key" FROM runs WHERE id = ?')
      .bind(body.run.id)
      .first<{ key: string }>();
    const privateUuid = String(row?.key).slice("chat:".length);
    expect(privateUuid).not.toBe(body.run.id);
    expect(JSON.stringify(body)).not.toContain(privateUuid);

    // ...and the list route, which is the other place a run crosses to the
    // browser, does not carry it either.
    const list = await runsApi.fetch(new Request("http://x/runs?limit=50"), think);
    expect(JSON.stringify(await list.json())).not.toContain(privateUuid);
  });
});

/**
 * Phase 25, gap 6. The three legacy-only routes must refuse on the Think
 * chassis rather than answer from the wrong session.
 *
 * Driven against the exported Hono apps rather than `SELF`, because the whole
 * subject is a non-default `RUN_CHASSIS` and the pool's `SELF` is bound to the
 * pool env. The paths are the sub-app's own — `runsApi` is mounted at `/api`
 * and `runsWs` at `/ws` by `src/index.ts`.
 *
 * The run is REAL. A bogus id would 404 either way and prove nothing; using a
 * run that exists is what shows the answer is "this route is not part of this
 * deployment" rather than "no such run". The `code` assertion is the
 * load-bearing half of each case.
 */
describe("legacy-only run routes on the think chassis", () => {
  it("refuse the snapshot, the steer and the socket by name", async () => {
    const think: Env = { ...env, RUN_CHASSIS: "think" };

    // Created on LEGACY on purpose: this is exactly the dangerous shape — a run
    // whose session is `RunDO` while the deployment now says think. The routes
    // must still refuse, because a deployment runs one chassis, not one per run.
    const run = await createRunFromChat(env as Env, { firstMessage: "hello" });

    const snapshot = await runsApi.fetch(new Request(`http://x/runs/${run.id}`), think);
    const steer = await runsApi.fetch(
      new Request(`http://x/runs/${run.id}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: crypto.randomUUID(), content: "steer me" }),
      }),
      think,
    );
    const socket = await runsWs.fetch(new Request(`http://x/run/${run.id}`), think);

    for (const response of [snapshot, steer, socket]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "chassis_not_active" });
    }
  });

  it("still serves the snapshot on the legacy chassis", async () => {
    // The other half of the guard: it must not have turned these routes off.
    const run = await createRunFromChat(env as Env, { firstMessage: "hello" });
    const response = await runsApi.fetch(new Request(`http://x/runs/${run.id}`), env as Env);
    expect(response.status).toBe(200);
  });
});
