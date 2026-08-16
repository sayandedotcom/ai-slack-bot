import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/index";
import { runsApi, runsWs } from "../src/api/runs";
import { createRunFromChat, wakeRun } from "../src/run/chassis";
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
