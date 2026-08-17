import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetRunPorts } from "../src/agent/driver";
import {
  ENGINEER_VOICE_FREEZE_GRACE_MS,
  renderStablePolicy,
  renderVoiceExamples,
} from "../src/agent/prompt";
import { ENGINEER_VOICE_WINDOW_MS } from "../src/agent/prompt/voice";
import { FIREFIGHTERS } from "../src/access/roster";
import { upsertIdentity } from "../src/db/identities";
import { FakeClock } from "./helpers/agent-driver";
import { customerTurn, freshLoopRun, mockModel, textStep, toolStep } from "./helpers/agent-loop";

/**
 * THE PRODUCTION PATH for the engineer-voice block.
 *
 * `test/prompt-voice.test.ts` proves the resolver and the renderer. None of that
 * proves the block reaches a request — and for one commit it did not: `loop.ts`
 * called `buildAgentPrompt({ context, messages })` with no voice at all, so the
 * feature was inert in production while every unit test stayed green. That is
 * the gap this file exists to close, and it can only be closed by driving the
 * real assembly.
 *
 * So these cases run the REAL continuation (`makeAgentContinuation`, the same
 * function the driver installs) against a mock provider, and read the system
 * blocks off the options each provider invocation was actually built with.
 *
 * WHY THIS IS A SEPARATE FILE FROM THE UNIT SUITE. Two reasons, both learned the
 * hard way:
 *
 *  - The unit suite calls `vi.resetModules()` to get an empty per-isolate voice
 *    cache. That resets the whole module registry, and a Durable Object holding
 *    run ports from the pre-reset graph then never runs a continuation at all —
 *    the alarm dispatches and nothing happens. The two techniques cannot share a
 *    file.
 *  - The cache here is real and is NOT defeated. Every case therefore runs on
 *    its OWN UTC day, `ENGINEER_VOICE_WINDOW_MS` apart, so one case's resolved
 *    voice can never be served to the next. That the cache is sticky across a
 *    case is the point of the feature, so it is worked with rather than
 *    switched off.
 *
 * HARNESS: no `isolatedStorage` in this pool. Rows are seeded with ids this file
 * owns and cleaned by prefix. Every Slack identity row is cleared before each
 * case: any connected fire-fighter is a candidate speaker now
 * (`src/identity/speaker.ts`), so a row another suite left behind would change
 * whose voice is sampled.
 */

const SLACK_ID = "U-VOICE-LOOP-ENGINEER";
const HEADING = "How the engineer whose name is on the reply actually writes";
/** The speaker once connected: last in the roster, so position is not what makes it work. */
const ENGINEER = FIREFIGHTERS[FIREFIGHTERS.length - 1]!;

/** The system blocks of one provider invocation, in order. */
function systemBlocks(callOptions: unknown): string[] {
  const prompt = (callOptions as { prompt?: { role: string; content: unknown }[] }).prompt ?? [];
  return prompt
    .filter((message) => message.role === "system")
    .map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
}

/**
 * A clock `daysAhead` UTC days from now, and that day's window start.
 *
 * Near wall time rather than pinned years out, because the same clock arms this
 * pool's real alarms. Distinct per case so each gets its own cache key; see the
 * file comment.
 */
function loopFixture(daysAhead: number) {
  const clock = new FakeClock(Date.now() + 3_600_000 + daysAhead * ENGINEER_VOICE_WINDOW_MS);
  const windowStartMs = Math.floor(clock.now() / ENGINEER_VOICE_WINDOW_MS) * ENGINEER_VOICE_WINDOW_MS;
  return { clock, windowStartMs };
}

async function seedMessages(windowStartMs: number, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const eventId = `voiceloop-${windowStartMs}-${i}`;
    // Behind the FROZEN BOUND, which sits `ENGINEER_VOICE_FREEZE_GRACE_MS`
    // before the boundary rather than on it. Seeding inside the grace window
    // would exclude every row and turn the positive cases into vacuous ones.
    const receivedAt = windowStartMs - ENGINEER_VOICE_FREEZE_GRACE_MS - 1_000 - i;
    await env.DB.prepare(
      `INSERT OR REPLACE INTO events_seen (event_id, channel_id, outcome, received_at)
       VALUES (?, 'C-VOICE-LOOP', 'ingested', ?)`,
    )
      .bind(eventId, receivedAt)
      .run();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO messages
         (event_id, channel_id, ts, thread_ts, user_id, text, subtype, permalink, customer_slug, received_at)
       VALUES (?, 'C-VOICE-LOOP', ?, NULL, ?, ?, NULL, NULL, 'voicetest', ?)`,
    )
      .bind(
        eventId,
        `${Math.floor(receivedAt / 1000)}.000100`,
        SLACK_ID,
        `a real message the engineer typed to a customer, number ${i}`,
        receivedAt,
      )
      .run();
  }
}

async function connect(email: string): Promise<void> {
  await upsertIdentity(
    env.DB,
    {
      email,
      provider: "slack",
      externalId: SLACK_ID,
      scopes: "chat:write",
      tokenCiphertext: "sealed-not-read-here",
      connectedAt: 1,
    },
    1,
  );
}

/** Run one turn through the real continuation; return each call's system blocks. */
async function runTurn(input: { clock: FakeClock; steps: 1 | 2 }): Promise<string[][]> {
  const calls: string[][] = [];
  const harness = await freshLoopRun({
    clock: input.clock,
    model: mockModel(
      input.steps === 1
        ? [textStep({ chunks: ["done."] })]
        : [
            toolStep({ toolCallId: "call_1", code: "async () => ({ ok: true })" }),
            textStep({ chunks: ["done."] }),
          ],
    ),
    onModelCall: (callOptions) => calls.push(systemBlocks(callOptions)),
  });
  await harness.stub.appendTurn(customerTurn("t1"));
  await harness.alarm();
  return calls;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM messages WHERE event_id LIKE 'voiceloop-%'").run();
  await env.DB.prepare("DELETE FROM events_seen WHERE event_id LIKE 'voiceloop-%'").run();
  await env.DB.prepare("DELETE FROM identities WHERE provider = 'slack'").run();
});

afterEach(() => {
  resetRunPorts();
});

describe("the assembled request the provider actually receives", () => {
  it("carries the engineer voice block when the engineer has enough samples", async () => {
    const { clock, windowStartMs } = loopFixture(0);
    await connect(ENGINEER);
    await seedMessages(windowStartMs, 6);

    const calls = await runTurn({ clock, steps: 1 });

    expect(calls).toHaveLength(1);
    const blocks = calls[0]!;
    // Four blocks: policy, static contrasts, engineer voice, trusted context.
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toBe(renderStablePolicy());
    expect(blocks[1]).toBe(renderVoiceExamples());
    expect(blocks[2]).toContain(HEADING);
    expect(blocks[2]).toContain("number 0");
    // Before the dynamic block, not inside it.
    expect(blocks[3]).not.toContain(HEADING);
  });

  /**
   * The block is frozen, so every step of a multi-step generation carries the
   * same bytes. `prepareTurn` re-resolves before each step; a resolve that
   * ignored the freeze, or a cache keyed on anything that moves within a day,
   * would show up right here as two different prefixes in one generation.
   */
  it("carries the same bytes on every step of one generation", async () => {
    const { clock, windowStartMs } = loopFixture(1);
    await connect(ENGINEER);
    await seedMessages(windowStartMs, 6);

    const calls = await runTurn({ clock, steps: 2 });

    expect(calls).toHaveLength(2);
    expect(calls[0]![2]).toContain(HEADING);
    expect(calls[1]![2]).toBe(calls[0]![2]);
  });

  /**
   * Below the usable floor the request must be byte-identical to the shape that
   * shipped before Phase 21: three system blocks, the last of them the dynamic
   * trusted context. An empty block emitted rather than omitted would show up as
   * a fourth entry, and would have spent one of four cache breakpoints on
   * nothing.
   */
  it("is byte-identical to the pre-Phase-21 shape below the usable floor", async () => {
    const { clock, windowStartMs } = loopFixture(2);
    await connect(ENGINEER);
    await seedMessages(windowStartMs, 4);

    const calls = await runTurn({ clock, steps: 1 });

    expect(calls).toHaveLength(1);
    const blocks = calls[0]!;
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toBe(renderStablePolicy());
    expect(blocks[1]).toBe(renderVoiceExamples());
    expect(blocks.some((block) => block.includes(HEADING))).toBe(false);
  });

  it("is byte-identical to the pre-Phase-21 shape when no fire-fighter has connected", async () => {
    const { clock, windowStartMs } = loopFixture(3);
    // `beforeEach` cleared every Slack row, so there is no speaker at all: the
    // block is empty for the same reason it would be with rows for someone
    // else's `external_id` — nothing selects the messages seeded below.
    await seedMessages(windowStartMs, 10);

    const calls = await runTurn({ clock, steps: 1 });

    expect(calls).toHaveLength(1);
    const blocks = calls[0]!;
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toBe(renderStablePolicy());
    expect(blocks[1]).toBe(renderVoiceExamples());
    expect(blocks.some((block) => block.includes(HEADING))).toBe(false);
  });
});
