import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it } from "vitest";

import type { ApprovalPort } from "../src/approval/contracts";
import { makeApprovalPort } from "../src/approval/port";
import {
  decideApproval,
  getApproval,
  insertApproval,
} from "../src/approval/repository";
import { CapabilityError } from "../src/gateways/errors";
import { chatRunKey } from "../src/run/keys";
import { installTestModel, resetTestModel } from "../src/run/model";
import { createOrGetRun } from "../src/run/repository";
import { createRunFromChat } from "../src/run/wake";
import { cannedModel } from "./helpers/canned-model";

afterEach(() => resetTestModel());

const THREAD = { channelId: "C0PORT", threadTs: "1720000000.000100" };

async function freshRunId(): Promise<string> {
  const run = await createOrGetRun(env.DB, {
    key: chatRunKey(crypto.randomUUID()),
    origin: "chat",
    channelId: null,
    threadTs: null,
  });
  return run.id;
}

/**
 * The port against a stand-in for the object's durable state. `openApprovalId`
 * is a synchronous read of `this.state` in production, and this mirror is what
 * lets the port be exercised without a live turn.
 */
function port(
  over: Partial<Parameters<typeof makeApprovalPort>[0]> & { runId: string }
) {
  const state = { open: null as string | null, last: null as string | null };
  const nudged: string[] = [];
  const expired: string[] = [];

  const built: ApprovalPort = makeApprovalPort({
    db: env.DB,
    env,
    generationId: "turn-1",
    slackThread: THREAD,
    shadow: false,
    now: () => 1_700_000_000_000,
    openApprovalId: () => state.open,
    lastApprovalId: () => state.last,
    setOpenApproval: async (approvalId) => {
      state.open = approvalId;
      state.last = approvalId ?? state.last;
    },
    scheduleNudge: async (approvalId) => {
      nudged.push(approvalId);
    },
    scheduleExpiry: async (approvalId) => {
      expired.push(approvalId);
    },
    ...over,
  });

  return { port: built, state, nudged, expired };
}

describe("opening an approval", () => {
  it("writes the card, parks the run, and queues the two follow-ups", async () => {
    const runId = await freshRunId();
    const { port: approval, state, nudged, expired } = port({ runId });

    const { approvalId } = await approval.open({
      draft: "We can refund it.",
      why: "committal",
    });

    expect(approvalId).toMatch(/^apr:[0-9a-f-]{36}$/);
    expect(state.open).toBe(approvalId);
    expect(approval.openApprovalId()).toBe(approvalId);
    expect(await getApproval(env.DB, approvalId)).toMatchObject({
      runId,
      draft: "We can refund it.",
      why: "committal",
      channelId: THREAD.channelId,
      threadTs: THREAD.threadTs,
      decision: "pending",
      delivery: "none",
    });
    // Both are scheduled rather than awaited: an eight-second Slack timeout
    // inside the model's own run_code execution is not a cost a tool call gets
    // to impose, and the human does not need the DM until the run parks.
    expect(nudged).toEqual([approvalId]);
    expect(expired).toEqual([approvalId]);
  });

  it("snapshots the run's shadow flag onto the card", async () => {
    const runId = await freshRunId();
    const { port: approval } = port({ runId, shadow: true });
    const { approvalId } = await approval.open({ draft: "d", why: "w" });
    expect(await getApproval(env.DB, approvalId)).toMatchObject({
      shadow: true,
    });
  });

  it("refuses a run with no customer thread", async () => {
    // Approval gates Slack replies only. A chat run has no thread to reply in,
    // so there is nothing a human could approve — refused here rather than
    // discovered later, which would park a run on a card that cannot exist.
    const runId = await freshRunId();
    const { port: approval, state } = port({ runId, slackThread: null });

    await expect(approval.open({ draft: "d", why: "w" })).rejects.toThrow(
      /no customer Slack thread/
    );
    expect(state.open).toBeNull();
  });

  it("refuses a second open even when the host-side check saw nothing open", async () => {
    // The database is the guard: `idx_approvals_one_open` is a partial unique
    // index, so two escalations racing each other cannot both write a card.
    const runId = await freshRunId();
    const first = port({ runId });
    await first.port.open({ draft: "first", why: "w" });

    const racer = port({ runId, openApprovalId: () => null });
    await expect(
      racer.port.open({ draft: "second", why: "w" })
    ).rejects.toMatchObject({
      code: "approval_already_open",
    });
  });
});

describe("withdrawing an approval", () => {
  it("retracts an undecided card and unparks the run", async () => {
    const runId = await freshRunId();
    const { port: approval, state } = port({ runId });
    const { approvalId } = await approval.open({ draft: "d", why: "w" });

    expect(await approval.withdraw()).toEqual({ withdrawn: true });
    expect(state.open).toBeNull();
    expect(await getApproval(env.DB, approvalId)).toMatchObject({
      decision: "withdrawn",
    });
  });

  it("frees the one-open slot, so the run can escalate again", async () => {
    const runId = await freshRunId();
    const { port: approval } = port({ runId });
    await approval.open({ draft: "first", why: "w" });
    await approval.withdraw();

    const second = await approval.open({ draft: "second", why: "w" });
    expect(await getApproval(env.DB, second.approvalId)).toMatchObject({
      draft: "second",
    });
  });

  it("returns the human's decision when they got there first", async () => {
    // The old stub reported a clean withdrawal unconditionally, which told the
    // model it had retracted a message that may already have gone out.
    const runId = await freshRunId();
    const { port: approval } = port({ runId });
    const { approvalId } = await approval.open({ draft: "d", why: "w" });
    await decideApproval(
      env.DB,
      approvalId,
      { action: "approve" },
      "eng@zellify.com",
      Date.now()
    );

    expect(await approval.withdraw()).toEqual({
      withdrawn: false,
      decision: "approved",
    });
    // Never overwritten: delivery is a separate machine and the decision stands.
    expect(await getApproval(env.DB, approvalId)).toMatchObject({
      decision: "approved",
    });
  });

  it("returns an edited decision as edited, not as approved", async () => {
    const runId = await freshRunId();
    const { port: approval } = port({ runId });
    const { approvalId } = await approval.open({ draft: "d", why: "w" });
    await decideApproval(
      env.DB,
      approvalId,
      { action: "edit", text: "Actually, no refund." },
      "eng@zellify.com",
      Date.now()
    );

    expect(await approval.withdraw()).toEqual({
      withdrawn: false,
      decision: "edited",
    });
  });

  it("tells a redelivered withdrawal apart from one that lost a race", async () => {
    const runId = await freshRunId();
    const { port: approval, state } = port({ runId });
    const { approvalId } = await approval.open({ draft: "d", why: "w" });
    await approval.withdraw();

    // Nothing open, and the last card is genuinely withdrawn: the truthful
    // answer is the same one the first call gave.
    expect(state.open).toBeNull();
    expect(state.last).toBe(approvalId);
    expect(await approval.withdraw()).toEqual({ withdrawn: true });

    // Nothing open, but the last card was DECIDED — the flag was cleared by the
    // resolution while the model's program was awaiting something. Reporting a
    // withdrawal here would be a lie about a message that may have been sent.
    const decided = port({
      runId,
      openApprovalId: () => null,
      lastApprovalId: () => null,
    });
    const second = await decided.port.open({ draft: "d2", why: "w" });
    await decideApproval(
      env.DB,
      second.approvalId,
      { action: "reject", reason: "wrong tone" },
      "eng@zellify.com",
      Date.now()
    );
    const after = port({
      runId,
      openApprovalId: () => null,
      lastApprovalId: () => second.approvalId,
    });
    expect(await after.port.withdraw()).toEqual({
      withdrawn: false,
      decision: "rejected",
    });
  });

  it("says withdrawn when this run has never opened anything", async () => {
    const runId = await freshRunId();
    const { port: approval } = port({
      runId,
      openApprovalId: () => null,
      lastApprovalId: () => null,
    });
    expect(await approval.withdraw()).toEqual({ withdrawn: true });
  });

  it("carries a CapabilityError, not a bare Error, out of a refusal", async () => {
    // The model reads the code, so it has to survive the capability pipeline.
    const runId = await freshRunId();
    const { port: approval } = port({ runId, slackThread: null });
    await approval.open({ draft: "d", why: "w" }).catch((err: unknown) => {
      expect(err).toBeInstanceOf(CapabilityError);
      expect((err as CapabilityError).code).toBe("slack_context_required");
    });
    expect.assertions(2);
  });
});

describe("the run's own parked flag", () => {
  it("blocks every tool call while a decision is outstanding", async () => {
    const stub = await getAgentByName(
      env.RUN_AGENTS,
      chatRunKey(crypto.randomUUID())
    );
    await stub.setOpenApproval("apr:blocked");
    expect(await stub.toolCallDecisionForTest()).toMatchObject({
      action: "block",
    });

    await stub.setOpenApproval(null);
    expect(await stub.toolCallDecisionForTest()).toBeUndefined();
  });

  it("remembers the last approval after the flag is cleared", async () => {
    // `openApprovalId` alone cannot answer a withdraw that arrives just after a
    // human decided: the resolution clears it.
    const stub = await getAgentByName(
      env.RUN_AGENTS,
      chatRunKey(crypto.randomUUID())
    );
    await stub.setOpenApproval("apr:remembered");
    await stub.setOpenApproval(null);

    const state = await stub.runStateForTest();
    expect(state.openApprovalId).toBeNull();
    expect(state.lastApprovalId).toBe("apr:remembered");
  });

  it("fails the run when nobody decides before the escalation expires", async () => {
    // It does NOT decide for the human. `failed` releases the Slack thread, and
    // triage's abandoned-thread override reads exactly that status to re-wake a
    // thread whose run died — so a customer who follows up is answered.
    installTestModel(cannedModel());
    const { runId } = await createRunFromChat(env, {});
    const key = (
      await env.DB.prepare('SELECT "key" FROM runs WHERE id = ?')
        .bind(runId)
        .first<{ key: string }>()
    )?.key;
    const stub = await getAgentByName(env.RUN_AGENTS, key ?? "");

    const approvalId = `apr:${crypto.randomUUID()}`;
    await insertApproval(env.DB, {
      id: approvalId,
      runId,
      generationId: "turn-1",
      draft: "d",
      why: "w",
      channelId: THREAD.channelId,
      threadTs: THREAD.threadTs,
      shadow: false,
      now: Date.now(),
    });
    await stub.setOpenApproval(approvalId);

    await stub.approvalExpired({ approvalId });

    expect((await stub.runStateForTest()).status).toBe("failed");
    expect(await getApproval(env.DB, approvalId)).toMatchObject({
      decision: "withdrawn",
    });
  });

  it("does nothing on an expiry for an approval that is no longer open", async () => {
    const stub = await getAgentByName(
      env.RUN_AGENTS,
      chatRunKey(crypto.randomUUID())
    );
    await stub.approvalExpired({ approvalId: "apr:stale" });
    expect((await stub.runStateForTest()).status).toBe("idle");
  });

  it("drops a scheduled payload it cannot read", async () => {
    // A schedule row round-trips through JSON in DO SQLite and can outlive a
    // deploy, so one written by an older build is a thing to drop rather than
    // to crash on.
    const stub = await getAgentByName(
      env.RUN_AGENTS,
      chatRunKey(crypto.randomUUID())
    );
    await stub.approvalExpired(null);
    await stub.approvalExpired({ approvalId: 7 });
    await stub.nudgeApproval("apr:not-an-object");
    expect((await stub.runStateForTest()).status).toBe("idle");
  });
});

/**
 * What the deleted `approval_card` projection hook used to pin, restored
 * against the chassis that replaced it (`test/notify-nudge.test.ts`'s closing
 * note). The projection job is gone — `open()` writes the card itself and
 * schedules the DM — so the three properties move here.
 */
describe("nudging the engineer about a fresh card", () => {
  it("commits the card before the DM is ever attempted", async () => {
    // Structural now rather than ordered-by-hand: the row is written by
    // `insertApproval`, and the DM is a separate scheduled callback that can
    // only run after this turn ends. A crash before the DM leaves a decidable
    // card; the cron sweep is what eventually sends it.
    const runId = await freshRunId();
    const { port: approval, nudged } = port({ runId });
    const { approvalId } = await approval.open({ draft: "d", why: "w" });

    expect(await getApproval(env.DB, approvalId)).not.toBeNull();
    expect(nudged).toEqual([approvalId]);
  });

  it("leaves the claim free for the sweeper when Slack cannot be reached", async () => {
    // The pool binds no fallback channel and no fire-fighter has connected
    // Slack, so `sendNudge` refuses before it claims anything — which is the
    // case that matters: burning the once-only slot on an attempt that cannot
    // be made would silence the sweeper too.
    installTestModel(cannedModel());
    const { runId } = await createRunFromChat(env, {});
    const key = (
      await env.DB.prepare('SELECT "key" FROM runs WHERE id = ?')
        .bind(runId)
        .first<{ key: string }>()
    )?.key;
    const stub = await getAgentByName(env.RUN_AGENTS, key ?? "");

    const approvalId = `apr:${crypto.randomUUID()}`;
    await insertApproval(env.DB, {
      id: approvalId,
      runId,
      generationId: "turn-1",
      draft: "d",
      why: "w",
      channelId: THREAD.channelId,
      threadTs: THREAD.threadTs,
      shadow: false,
      now: Date.now(),
    });

    await stub.nudgeApproval({ approvalId });
    await stub.nudgeApproval({ approvalId });

    expect(await getApproval(env.DB, approvalId)).toMatchObject({
      nudgedAt: null,
      nudgeTs: null,
    });
  });

  it("does not nudge a card a human has already decided", async () => {
    const runId = await freshRunId();
    const { port: approval } = port({ runId });
    const { approvalId } = await approval.open({ draft: "d", why: "w" });
    await decideApproval(
      env.DB,
      approvalId,
      { action: "approve" },
      "eng@zellify.com",
      Date.now()
    );

    const key = (
      await env.DB.prepare('SELECT "key" FROM runs WHERE id = ?')
        .bind(runId)
        .first<{ key: string }>()
    )?.key;
    const stub = await getAgentByName(env.RUN_AGENTS, key ?? "");
    await stub.nudgeApproval({ approvalId });

    expect(await getApproval(env.DB, approvalId)).toMatchObject({
      nudgedAt: null,
    });
  });
});
