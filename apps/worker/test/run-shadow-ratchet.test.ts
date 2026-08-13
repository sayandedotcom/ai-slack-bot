import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  routeSlackMessageToOwnedRun,
  wakeSlackRun,
  type SlackRunMessage,
} from "../src/run/coordinator";
import { runStubForKey, slackRunKey } from "../src/run/keys";
import { getRunByKey } from "../src/run/repository";
import { handleTriageBatch } from "../src/triage/consumer";
import type { TriageJob } from "../src/triage/consumer";

/**
 * THE SHADOW RATCHET (invariant 37).
 *
 * An `observe` channel may auto-wake, and the loop it creates is the IDENTICAL
 * loop — same driver, same generation, same transcript — with `shadow = 1`. The
 * shared host write guard then makes it draft and evaluate with no external
 * effect. What must never happen is the other direction: an observing run
 * acquiring the authority to act.
 *
 * The mechanism is deliberately asymmetric, and the asymmetry is the proof.
 * `createOrGetRunUnderPolicy` contains exactly one statement that touches
 * `shadow` after creation and it can only ever set it to 1. There is NO code
 * path anywhere in this Worker that clears the flag — not redelivery, not
 * owned-thread continuation, not a steer, not an alarm, not a promotion
 * endpoint, because none exists in this phase. So "observe cannot become
 * unshadowed implicitly" is not a rule the tests below police; it is a
 * statement about which statements exist.
 *
 * Model work is parked in this pool (`AGENT_MODEL_DISABLED` is set for the
 * whole suite in vitest.config.ts — absence of Gateway settings no longer
 * parks anything, it fails), so every
 * assertion below reads the D1 row at a point where the generation is scheduled
 * and has never been claimed. "Shadow was set before scheduling" is therefore
 * literal: no model or tool work has run at all.
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
  await env.DB.prepare("DELETE FROM messages").run();
  await env.DB.prepare("DELETE FROM triage_decisions").run();
});

async function channel(channelId: string, name: string, mode: string, slug: string | null = "pulsefit") {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, ?, ?)",
  )
    .bind(channelId, name, slug, mode)
    .run();
}

async function setMode(channelId: string, mode: string) {
  await env.DB.prepare("UPDATE channels SET mode = ? WHERE channel_id = ?").bind(mode, channelId).run();
}

async function wake(channelId: string, eventId = "Ev1") {
  return wakeSlackRun(env, {
    eventId,
    channelId,
    threadTs,
    openingPrompt: "Customer reports checkout failing at payment.",
  });
}

/** One run, one input turn, one generation — whatever the shadow decision was. */
async function loopShape(key: string) {
  const stub = runStubForKey(env.RUNS, key);
  const turns = await stub.turns();
  const driver = await stub.driver();
  return {
    inputTurns: turns.filter((turn) => turn.role === "user").length,
    phase: driver.phase,
    generationId: driver.generationId,
  };
}

describe("a waking triage decision under the current channel policy", () => {
  it("creates an unshadowed loop for a live customer channel", async () => {
    await channel("C0LIVE0001", "pulsefit-eng", "live");
    const run = await wake("C0LIVE0001");

    expect(run.shadow).toBe(false);
    expect(run.status).toBe("live");
    expect(await loopShape(run.key)).toMatchObject({ inputTurns: 1, phase: "scheduled" });
  });

  it("creates the IDENTICAL loop for an observe channel, only shadowed", async () => {
    await channel("C0LIVE0001", "pulsefit-eng", "live");
    await channel("C0OBSRV001", "pulsefit-observe", "observe");

    const live = await wake("C0LIVE0001", "EvLive");
    const liveThread = threadTs;
    threadTs = freshThreadTs();
    const observed = await wake("C0OBSRV001", "EvObs");

    expect(live.shadow).toBe(false);
    expect(observed.shadow).toBe(true);

    // Same shape. An observe channel is not a different pipeline; it is the same
    // pipeline with every external effect denied at the write guard.
    const liveShape = await loopShape(slackRunKey("C0LIVE0001", liveThread));
    const observedShape = await loopShape(observed.key);
    expect(observedShape.inputTurns).toBe(liveShape.inputTurns);
    expect(observedShape.phase).toBe(liveShape.phase);
    expect(observedShape.generationId).not.toBeNull();
  });

  it("shadows an internal channel and an unmapped channel alike", async () => {
    await channel("C0INTRNL01", "firefighter-internal", "internal", null);
    const internal = await wake("C0INTRNL01", "EvInt");
    expect(internal.shadow).toBe(true);

    threadTs = freshThreadTs();
    // Absent from `channels` entirely. Fail closed: an unmapped channel is not
    // a permitted one, and `getChannelPolicy` already reports it as observe.
    const unknown = await wake("C0UNKNOWN1", "EvUnknown");
    expect(unknown.shadow).toBe(true);
  });

  it("leaves #test-firedrill unshadowed, because it is a reviewed live row", async () => {
    await channel("C0DRILL001", "test-firedrill", "live", "firefighter");
    const run = await wake("C0DRILL001");

    // The ungated path is a D1 policy row, not a name check in code. Nothing in
    // the Worker special-cases the string "test-firedrill".
    expect(run.shadow).toBe(false);
  });
});

describe("regression fixture (a): an old unshadowed run whose channel was downgraded", () => {
  /**
   * The run predates the downgrade and its D1 row still says `shadow = 0`. The
   * customer sends a follow-up in the thread the run owns, which bypasses
   * triage entirely — Phase 08's owned-thread continuation.
   *
   * It must NOT bypass policy. The current mode is re-read on this path and the
   * ratchet applied before the append that allocates the generation, so the
   * continuation is a shadow draft.
   */
  it("shadows on the next message, before the generation is scheduled", async () => {
    await channel("C0PULSE001", "pulsefit-eng", "live");
    const created = await wake("C0PULSE001");
    expect(created.shadow).toBe(false);

    await setMode("C0PULSE001", "observe");

    const message: SlackRunMessage = {
      eventId: "Ev2",
      channelId: "C0PULSE001",
      ts: freshThreadTs(),
      threadTs,
      text: "still broken, any update?",
      userId: "U1",
      permalink: "https://slack.com/archives/C1/p2",
    };
    expect(await routeSlackMessageToOwnedRun(env, message)).toBe(true);

    const after = await getRunByKey(env.DB, created.key);
    expect(after?.shadow).toBe(true);

    // The message was not dropped, and the loop continued: shadow changes the
    // run's authority, never whether the customer is heard (invariant 13).
    const shape = await loopShape(created.key);
    expect(shape.inputTurns).toBe(2);
    expect(shape.phase).toBe("scheduled");
  });

  it("cannot regain unshadowed authority when the channel goes live again", async () => {
    await channel("C0PULSE001", "pulsefit-eng", "observe");
    const created = await wake("C0PULSE001");
    expect(created.shadow).toBe(true);

    // Somebody flips the channel back. There is deliberately no operation that
    // clears the flag on an existing run, so the run stays a draft; promoting
    // it is a reviewed action with its own authority, not a side effect of a
    // channel edit that a later message happens to observe.
    await setMode("C0PULSE001", "live");
    await routeSlackMessageToOwnedRun(env, {
      eventId: "Ev3",
      channelId: "C0PULSE001",
      ts: freshThreadTs(),
      threadTs,
      text: "ping",
      userId: "U1",
      permalink: null,
    });

    expect((await getRunByKey(env.DB, created.key))?.shadow).toBe(true);
  });
});

describe("regression fixture (b): a stored wake decision replayed after a downgrade", () => {
  /**
   * The queue is at-least-once and `triageOne` replays a stored `wake = 1`
   * decision whenever it sees the event again. The decision was made while the
   * channel was `live`; by the time it is redelivered the channel is `observe`.
   *
   * The replay re-resolves the CURRENT policy, so it cannot carry the authority
   * the decision was recorded under. And it stays one run, one turn, one
   * generation: the opening turn's id is `triage:{event_id}`, so the second
   * delivery is an idempotent no-op that still heals a lost `setAlarm()`.
   */
  it("keeps one run, one turn and one generation, and shadows the replay", async () => {
    await channel("C0PULSE001", "pulsefit-eng", "live");

    const first = await wake("C0PULSE001", "EvReplay");
    expect(first.shadow).toBe(false);
    const before = await loopShape(first.key);

    await setMode("C0PULSE001", "observe");
    const replayed = await wake("C0PULSE001", "EvReplay");

    expect(replayed.id).toBe(first.id);
    expect(replayed.shadow).toBe(true);

    const after = await loopShape(first.key);
    expect(after.inputTurns).toBe(1);
    expect(after.generationId).toBe(before.generationId);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE \"key\" = ?")
      .bind(first.key)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("replays through the triage consumer without asking the model again", async () => {
    await channel("C0PULSE001", "pulsefit-eng", "live");
    const ts = freshThreadTs();
    await env.DB.prepare(
      `INSERT INTO messages (event_id, channel_id, ts, thread_ts, user_id, text, permalink, received_at)
       VALUES ('EvC', 'C0PULSE001', ?, NULL, 'U1', 'checkout is failing', 'https://slack/p', 0)`,
    )
      .bind(ts)
      .run();
    await env.DB.prepare(
      `INSERT INTO triage_decisions (event_id, wake, why, opening_prompt, model, cost_usd, latency_ms, created_at)
       VALUES ('EvC', 1, 'actionable', 'Customer reports checkout failing.', 'claude-haiku-4-5', 0, 1, 0)`,
    ).run();

    await setMode("C0PULSE001", "observe");

    let triageCalls = 0;
    await handleTriageBatch(
      {
        queue: "firefighter-triage",
        messages: [{ body: { event_id: "EvC" }, ack: () => {}, retry: () => {} }],
      } as unknown as MessageBatch<TriageJob>,
      env,
      {
        triage: async () => {
          triageCalls += 1;
          throw new Error("the model must not be called for a stored decision");
        },
        memory: {
          ensureGraph: async () => {},
          addEpisode: async () => ({ episodeUuid: "e" }),
          addMessage: async () => ({ episodeUuid: "e" }),
          search: async () => [],
        },
        wakeRun: async (input) => {
          await wakeSlackRun(env, input);
        },
      },
    );

    expect(triageCalls).toBe(0);
    const run = await getRunByKey(env.DB, slackRunKey("C0PULSE001", ts));
    expect(run?.shadow).toBe(true);
  });
});

describe("what never reaches the main model at all", () => {
  it("creates no run for a banal wake:false decision", async () => {
    await channel("C0PULSE001", "pulsefit-eng", "live");
    const ts = freshThreadTs();
    await env.DB.prepare(
      `INSERT INTO messages (event_id, channel_id, ts, thread_ts, user_id, text, permalink, received_at)
       VALUES ('EvB', 'C0PULSE001', ?, NULL, 'U1', 'thanks!', NULL, 0)`,
    )
      .bind(ts)
      .run();
    await env.DB.prepare(
      `INSERT INTO triage_decisions (event_id, wake, why, opening_prompt, model, cost_usd, latency_ms, created_at)
       VALUES ('EvB', 0, 'banal', '', 'claude-haiku-4-5', 0, 1, 0)`,
    ).run();

    let woke = 0;
    await handleTriageBatch(
      {
        queue: "firefighter-triage",
        messages: [{ body: { event_id: "EvB" }, ack: () => {}, retry: () => {} }],
      } as unknown as MessageBatch<TriageJob>,
      env,
      {
        triage: async () => {
          throw new Error("not reached");
        },
        memory: {
          ensureGraph: async () => {},
          addEpisode: async () => ({ episodeUuid: "e" }),
          addMessage: async () => ({ episodeUuid: "e" }),
          search: async () => [],
        },
        wakeRun: async () => {
          woke += 1;
        },
      },
    );

    expect(woke).toBe(0);
    const { results } = await env.DB.prepare("SELECT id FROM runs").all();
    expect(results ?? []).toHaveLength(0);
  });

  it("does not even triage an internal channel or an unmapped one", async () => {
    await channel("C0INTRNL01", "firefighter-internal", "internal", null);
    const ts = freshThreadTs();
    await env.DB.prepare(
      `INSERT INTO messages (event_id, channel_id, ts, thread_ts, user_id, text, permalink, received_at)
       VALUES ('EvI', 'C0INTRNL01', ?, NULL, 'U1', 'deploying now', NULL, 0)`,
    )
      .bind(ts)
      .run();

    let triageCalls = 0;
    let woke = 0;
    await handleTriageBatch(
      {
        queue: "firefighter-triage",
        messages: [{ body: { event_id: "EvI" }, ack: () => {}, retry: () => {} }],
      } as unknown as MessageBatch<TriageJob>,
      env,
      {
        triage: async () => {
          triageCalls += 1;
          throw new Error("not reached");
        },
        memory: {
          ensureGraph: async () => {},
          addEpisode: async () => ({ episodeUuid: "e" }),
          addMessage: async () => ({ episodeUuid: "e" }),
          search: async () => [],
        },
        wakeRun: async () => {
          woke += 1;
        },
      },
    );

    expect(triageCalls).toBe(0);
    expect(woke).toBe(0);
  });
});
