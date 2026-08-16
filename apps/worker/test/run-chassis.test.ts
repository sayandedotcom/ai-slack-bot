import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/index";
import { wakeRun } from "../src/run/chassis";

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
