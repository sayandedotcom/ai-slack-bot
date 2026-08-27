import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIREFIGHTERS } from "../../src/access/roster";
import type { ApprovalRow } from "../../src/approval/contracts";
import {
  claimNudge,
  decideApproval,
  getApproval,
  insertApproval,
  recordNudgeMessage,
  withdrawApproval,
} from "../../src/approval/repository";
import { upsertIdentity } from "../../src/db/identities";
import type { Env } from "../../src/index";
import { sendNudge, sweepNudges, updateNudge } from "../../src/notify/nudge";

/**
 * THE ENGINEER NUDGE — Phase 13 Task 4.
 *
 * Real D1 through the workerd pool, every Slack call through a stubbed
 * `fetch`. Two properties carry the file:
 *
 *  1. EXACTLY ONE nudge per approval, and the enforcement is the `claimNudge`
 *     CAS in the database — not a flag in an isolate that a crash forgets. A
 *     replayed projection must not DM a human twice.
 *  2. A nudge NEVER breaks the projection. The card is the thing a human
 *     decides from; a Slack outage may not turn a card that landed into a
 *     card that did not.
 */

const NOW = Date.parse("2026-08-14T12:00:00Z");
/**
 * Who gets the DM: the default speaker — the first fire-fighter in roster order
 * who has connected Slack (`src/identity/speaker.ts`). No shift, no clock, so
 * `NOW` only stamps the claim; it never decides the person. When nobody has
 * connected, the channel fallback names the first roster address in plain text.
 */
const SPEAKER = FIREFIGHTERS[0]!;
const CONNECTED = [SPEAKER];
const SLACK_USER = "U0NDUTY";
const FALLBACK = "C_FALLBACK";
const DM_CHANNEL = "D0PENED";

type Sent = {
  url: string;
  body: Record<string, unknown>;
  authorization: string | null;
};
let sent: Sent[] = [];

/** Stub every Slack call, answering per API method. */
function stubSlack(
  reply: (method: string, body: Record<string, unknown>) => unknown,
  status = 200
): void {
  sent = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const method = String(url).split("/").pop() ?? "";
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    sent.push({
      url: String(url),
      body,
      authorization: new Headers(init.headers).get("authorization"),
    });
    return new Response(JSON.stringify(reply(method, body)), { status });
  });
}

/**
 * Stub `fetch` with an arbitrary transport — a throw, a non-JSON body — for the
 * cases `stubSlack`'s reply shape cannot express.
 *
 * It clears `sent` for the same reason `stubSlack` does: that array is
 * module-level, so a case that installs its own `fetch` without resetting it
 * inherits the previous case's requests and any `expect(sent)` it later grows
 * would be reading another test's data.
 */
function stubTransport(impl: () => Promise<Response>): void {
  sent = [];
  vi.stubGlobal("fetch", impl);
}

const happySlack = (method: string): unknown =>
  method === "conversations.open"
    ? { ok: true, channel: { id: DM_CHANNEL } }
    : { ok: true, ts: "1723640000.000100" };

function testEnv(overrides: Record<string, string> = {}): Env {
  return {
    ...env,
    NUDGE_MODE: "dm",
    NUDGE_FALLBACK_CHANNEL_ID: FALLBACK,
    DASHBOARD_BASE_URL: "https://dash.example",
    ...overrides,
  } as unknown as Env;
}

async function seedRun(): Promise<string> {
  const runId = `run_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, created_at, updated_at)
     VALUES (?, ?, 'slack', 'C_CUST', '1720000000.000100', 'idle', 0, ?, ?)`
  )
    .bind(runId, `slack:${crypto.randomUUID()}`, NOW, NOW)
    .run();
  return runId;
}

/** A pending card in D1, returned as the row `sendNudge` takes. */
async function seedApproval(createdAt = NOW): Promise<ApprovalRow> {
  const runId = await seedRun();
  const id = `apr:${crypto.randomUUID()}`;
  await insertApproval(env.DB, {
    id,
    runId,
    generationId: `gen:${crypto.randomUUID()}`,
    draft: "We can refund the last invoice.",
    why: "customer asked for a refund, this is committal",
    channelId: "C_CUST",
    threadTs: "1720000000.000100",
    shadow: false,
    now: createdAt,
  });
  const row = await getApproval(env.DB, id);
  return row!;
}

/** A fire-fighter has connected Slack. No token is ever opened for a nudge. */
async function connectSpeaker(): Promise<void> {
  for (const email of CONNECTED) {
    await upsertIdentity(
      env.DB,
      {
        email,
        provider: "slack",
        externalId: SLACK_USER,
        scopes: "chat:write",
        tokenCiphertext: "sealed-opaque",
        connectedAt: NOW,
      },
      NOW
    );
  }
}

/**
 * Leave the shared D1 as we found it.
 *
 * This pool has no `isolatedStorage` (see `test/approval-repository.test.ts`'s
 * note), so rows written here outlive the file — and the two kinds this file
 * writes are exactly the two `sweepNudges` feeds on: a pending, unnudged
 * approval and an `identities` row for a fire-fighter. Left behind, they
 * would make `worker.scheduled()` in another suite open a REAL DM against
 * slack.com with the pool's fake bot token. Cleaning up in an `afterEach` (not
 * only a `beforeEach`) is what keeps that unreachable.
 */
async function cleanD1(): Promise<void> {
  await env.DB.prepare("DELETE FROM approvals").run();
  // Every Slack row, not only ours: any connected fire-fighter is a speaker
  // now, so a row another suite left behind would turn a fallback case into a
  // DM case.
  await env.DB.prepare("DELETE FROM identities WHERE provider = 'slack'").run();
}

beforeEach(cleanD1);

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await cleanD1();
});

describe("sendNudge", () => {
  it("skips without a single Slack call when the row is already claimed", async () => {
    const row = await seedApproval();
    expect(await claimNudge(env.DB, row.id, NOW)).toBe(true);
    await connectSpeaker();
    stubSlack(happySlack);

    expect(await sendNudge(testEnv(), row, NOW)).toBe("skipped");
    expect(sent).toEqual([]);
  });

  it("opens a DM with the speaker and posts the nudge blocks there", async () => {
    const row = await seedApproval();
    await connectSpeaker();
    stubSlack(happySlack);

    expect(await sendNudge(testEnv(), row, NOW)).toBe("sent");

    expect(sent.map((s) => s.url)).toEqual([
      "https://slack.com/api/conversations.open",
      "https://slack.com/api/chat.postMessage",
    ]);
    expect(sent[0]!.body).toMatchObject({ users: SLACK_USER });
    expect(sent[1]!.body.channel).toBe(DM_CHANNEL);
    expect(Array.isArray(sent[1]!.body.blocks)).toBe(true);
    expect(JSON.stringify(sent[1]!.body.blocks)).toContain(
      `https://dash.example/?approval=${row.id}`
    );
    // The nudge is a BOT-token DM to an engineer. It must never carry a
    // customer-send credential.
    expect(sent[1]!.authorization).toBe(`Bearer ${env.SLACK_BOT_TOKEN}`);

    const after = await getApproval(env.DB, row.id);
    expect(after?.nudgeChannelId).toBe(DM_CHANNEL);
    expect(after?.nudgeTs).toBe("1723640000.000100");
    expect(after?.nudgedAt).not.toBeNull();
  });

  it("falls back to the channel, naming the engineer by email, when nobody has connected", async () => {
    const row = await seedApproval();
    stubSlack(happySlack);

    expect(await sendNudge(testEnv(), row, NOW)).toBe("sent");

    expect(sent.map((s) => s.url)).toEqual([
      "https://slack.com/api/chat.postMessage",
    ]);
    expect(sent[0]!.body.channel).toBe(FALLBACK);
    const payload = JSON.stringify(sent[0]!.body);
    expect(payload).toContain(SPEAKER);
    // There is no user id to mention, so there must be no mention syntax at all.
    expect(payload).not.toContain("<@");

    // Once only: a second attempt loses the CAS and touches no network.
    sent = [];
    expect(await sendNudge(testEnv(), row, NOW)).toBe("skipped");
    expect(sent).toEqual([]);
  });

  it("posts straight to the fallback channel with an <@id> mention in channel mode", async () => {
    const row = await seedApproval();
    await connectSpeaker();
    stubSlack(happySlack);

    expect(await sendNudge(testEnv({ NUDGE_MODE: "channel" }), row, NOW)).toBe(
      "sent"
    );

    expect(sent.map((s) => s.url)).toEqual([
      "https://slack.com/api/chat.postMessage",
    ]);
    expect(sent[0]!.body.channel).toBe(FALLBACK);
    expect(JSON.stringify(sent[0]!.body)).toContain(`<@${SLACK_USER}>`);
  });

  it("unclaims the row when Slack refuses, so the sweeper can retry", async () => {
    const row = await seedApproval();
    await connectSpeaker();
    stubSlack((method) =>
      method === "conversations.open"
        ? { ok: true, channel: { id: DM_CHANNEL } }
        : { ok: false, error: "channel_not_found" }
    );

    expect(await sendNudge(testEnv(), row, NOW)).toBe("failed");

    const after = await getApproval(env.DB, row.id);
    expect(after?.nudgedAt).toBeNull();
    expect(after?.nudgeTs).toBeNull();
  });

  it("unclaims the row when the request throws", async () => {
    const row = await seedApproval();
    await connectSpeaker();
    stubTransport(async () => {
      throw new Error("network down");
    });

    expect(await sendNudge(testEnv(), row, NOW)).toBe("failed");
    expect((await getApproval(env.DB, row.id))?.nudgedAt).toBeNull();
  });

  it("keeps the claim when the DM lands but the bookkeeping write fails", async () => {
    const row = await seedApproval();
    await connectSpeaker();
    stubSlack(happySlack);
    // Only the `recordNudgeMessage` statement fails; the claim and every read
    // go through untouched.
    const realPrepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
      // `SET`, not a bare column match: `getApproval`'s SELECT list names the
      // same column and must keep working.
      if (query.includes("SET nudge_channel_id"))
        throw new Error("d1 write failed");
      return realPrepare(query);
    });

    // The human has already been DM'd, so this is a SEND — and releasing the
    // claim here would page them a second time from the sweeper.
    expect(await sendNudge(testEnv(), row, NOW)).toBe("sent");

    vi.restoreAllMocks();
    const after = await getApproval(env.DB, row.id);
    expect(after?.nudgedAt).not.toBeNull();
    // The `ts` is genuinely lost — a later `chat.update` has no message to
    // edit. That is the cheap half of the trade this asserts.
    expect(after?.nudgeTs).toBeNull();
  });

  it("fails without claiming anything when no destination is configured", async () => {
    const row = await seedApproval();
    stubSlack(happySlack);

    expect(
      await sendNudge(testEnv({ NUDGE_FALLBACK_CHANNEL_ID: "" }), row, NOW)
    ).toBe("failed");
    expect(sent).toEqual([]);
    expect((await getApproval(env.DB, row.id))?.nudgedAt).toBeNull();
  });
});

/**
 * THE CARD REWRITES ITS OWN DM — Phase 13 Task 6.
 *
 * The nudge carries a "Review" button. Once a human has decided (or the model
 * has withdrawn the draft) that button leads to a card that is no longer
 * actionable, so the message is edited in place. Two properties:
 *
 *  1. NO MESSAGE, NO CALL. A nudge that never landed (or whose `ts` was lost —
 *     see `sendNudge`'s bookkeeping trade) has nothing to edit, and guessing is
 *     worse than silence.
 *  2. IT NEVER THROWS. A dead DM must not break approval resolution: the
 *     human's decision is a fact whether or not Slack accepts the edit.
 */
describe("updateNudge", () => {
  const NUDGE_TS = "1723640000.000100";

  /** A card with a recorded nudge DM, decided by a human. */
  async function decidedWithNudge(recordMessage = true): Promise<ApprovalRow> {
    const row = await seedApproval();
    if (recordMessage)
      await recordNudgeMessage(env.DB, row.id, DM_CHANNEL, NUDGE_TS);
    const decided = await decideApproval(
      env.DB,
      row.id,
      { action: "approve" },
      "ronit@zellify.com",
      NOW
    );
    expect(decided.result).toBe("decided");
    return (await getApproval(env.DB, row.id))!;
  }

  it("edits the recorded nudge message in place with the resolved blocks", async () => {
    const row = await decidedWithNudge();
    stubSlack(() => ({ ok: true, ts: NUDGE_TS }));

    await expect(updateNudge(testEnv(), row)).resolves.toBeUndefined();

    expect(sent.map((s) => s.url)).toEqual([
      "https://slack.com/api/chat.update",
    ]);
    expect(sent[0]!.body.channel).toBe(DM_CHANNEL);
    expect(sent[0]!.body.ts).toBe(NUDGE_TS);
    const payload = JSON.stringify(sent[0]!.body.blocks);
    expect(payload).toContain("Approved by ronit@zellify.com");
    // The replacement body carries no button — the dead link is the whole
    // point of this call.
    expect(payload).not.toContain("button");
    // The edit is of a BOT-posted engineer DM, so it is the one other place in
    // this phase that spends the bot token. It must never carry a user token.
    expect(sent[0]!.authorization).toBe(`Bearer ${env.SLACK_BOT_TOKEN}`);
  });

  it("names the withdrawal when the model retracted the draft", async () => {
    const row = await seedApproval();
    await recordNudgeMessage(env.DB, row.id, DM_CHANNEL, NUDGE_TS);
    expect((await withdrawApproval(env.DB, row.id, NOW)).result).toBe(
      "withdrawn"
    );
    const withdrawn = (await getApproval(env.DB, row.id))!;
    stubSlack(() => ({ ok: true, ts: NUDGE_TS }));

    await updateNudge(testEnv(), withdrawn);

    expect(JSON.stringify(sent[0]!.body.blocks)).toContain("Withdrawn");
  });

  it("makes no Slack call at all when no nudge message was recorded", async () => {
    const row = await decidedWithNudge(false);
    stubSlack(() => ({ ok: true, ts: NUDGE_TS }));

    await updateNudge(testEnv(), row);

    expect(sent).toEqual([]);
  });

  it("makes no Slack call for a card that is still pending", async () => {
    const row = await seedApproval();
    await recordNudgeMessage(env.DB, row.id, DM_CHANNEL, NUDGE_TS);
    stubSlack(() => ({ ok: true, ts: NUDGE_TS }));

    await updateNudge(testEnv(), (await getApproval(env.DB, row.id))!);

    expect(sent).toEqual([]);
  });

  it("swallows a Slack refusal", async () => {
    const row = await decidedWithNudge();
    stubSlack(() => ({ ok: false, error: "message_not_found" }));

    await expect(updateNudge(testEnv(), row)).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  it("swallows a thrown request", async () => {
    const row = await decidedWithNudge();
    stubTransport(async () => {
      throw new Error("network down");
    });

    await expect(updateNudge(testEnv(), row)).resolves.toBeUndefined();
  });

  it("swallows a non-JSON response", async () => {
    const row = await decidedWithNudge();
    stubTransport(
      async () => new Response("<html>gateway timeout</html>", { status: 504 })
    );

    await expect(updateNudge(testEnv(), row)).resolves.toBeUndefined();
  });
});

describe("sweepNudges", () => {
  it("nudges pending cards older than 60s and leaves fresh ones alone", async () => {
    const old = await seedApproval(NOW - 120_000);
    const fresh = await seedApproval(NOW - 10_000);
    await connectSpeaker();
    stubSlack(happySlack);

    expect(await sweepNudges(testEnv(), NOW)).toBe(1);

    expect((await getApproval(env.DB, old.id))?.nudgeTs).toBe(
      "1723640000.000100"
    );
    expect((await getApproval(env.DB, fresh.id))?.nudgedAt).toBeNull();
  });
});

// The `approval_card` projection-hook cases lived here. They drove
// `makeApprovalCardRunner`, part of the agent layer removed on 2026-08-23: the
// projection job that turned an escalation into a D1 card and then nudged once.
//
// RESTORED, against the chassis that replaced it, in
// `test/approval-port.test.ts` > "nudging the engineer about a fresh card".
// There is no projection job any more — `ApprovalPort.open` writes the card
// itself and schedules `RunAgent.nudgeApproval` — so the three properties moved
// with the code: the card is committed before the DM is attempted, a failed
// nudge leaves the claim free for the sweeper, and a decided card is not nudged
// at all. `sendNudge`, `updateNudge` and `sweepNudges` — all covered above —
// are the halves that never moved.
