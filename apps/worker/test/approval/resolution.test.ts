import { env, SELF } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type AccessIdentity,
  AccessJwtError,
  type AccessVerifier,
} from "../../src/access/jwt";
import {
  installApprovalApiPorts,
  resetApprovalApiPorts,
  sweepUndeliveredApprovals,
} from "../../src/api/approvals";
import { makeRunAgentResolutionNotifier } from "../../src/approval/notifier";
import {
  decideApproval,
  getApproval,
  insertApproval,
} from "../../src/approval/repository";
import type { ApprovalSender } from "../../src/approval/sender";
import { slackRunKey } from "../../src/run/keys";
import { installTestModel, resetTestModel } from "../../src/run/model";
import { getRunByKey, setRunStatus } from "../../src/run/repository";
import { wakeRun } from "../../src/run/wake";
import { cannedModel } from "../helpers/canned-model";
import { waitFor } from "../helpers/wait";

const FIREFIGHTER = "ronit@zellify.app";
const VIEWER = "viewer@zellify.app";

/** The header value IS the identity: no signing, no JWKS, no network. */
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

/** A sender whose outcome the test picks, so `sent` and `in_doubt` are reachable. */
function sender(
  result: ApprovalSender extends never ? never : "sent" | "blocked" | "in_doubt"
) {
  const calls: {
    text: string;
    channelId: string;
    threadTs: string;
    decidedBy: string | null;
  }[] = [];
  const port: ApprovalSender = {
    async send(input) {
      calls.push({
        text: input.text,
        channelId: input.channelId,
        threadTs: input.threadTs,
        decidedBy: input.decidedBy,
      });
      if (result === "sent") return { result: "sent", ts: "1720000000.000200" };
      if (result === "blocked")
        return { result: "blocked", reason: "identity_unavailable" };
      return { result: "in_doubt", reason: "send attempted; outcome unknown" };
    },
  };
  return { port, calls };
}

let channelSeq = 0;
async function liveChannel(): Promise<string> {
  channelSeq += 1;
  const channelId = `CRES${channelSeq}${Math.floor(Math.random() * 1e5)}`
    .toUpperCase()
    .slice(0, 20);
  await env.DB.prepare(
    "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, 'pulsefit', 'live')"
  )
    .bind(channelId, `ext-${channelId.toLowerCase()}`)
    .run();
  return channelId;
}

let threadSeq = 1_730_000_000;
function freshThreadTs(): string {
  threadSeq += 1;
  return `${threadSeq}.000100`;
}

/** A woken Slack run, its D1 row, its agent stub, and one open approval card. */
async function parkedRun(options: { shadow?: boolean } = {}) {
  const channelId = await liveChannel();
  const threadTs = freshThreadTs();
  await wakeRun(env, {
    eventId: `Ev${crypto.randomUUID()}`,
    channelId,
    threadTs,
    openingPrompt: "the exporter is stuck",
  });

  const key = slackRunKey(channelId, threadTs);
  const run = await getRunByKey(env.DB, key);
  if (run === null) throw new Error("the wake wrote no run row");
  if (options.shadow === true) {
    await env.DB.prepare("UPDATE runs SET shadow = 1 WHERE id = ?")
      .bind(run.id)
      .run();
  }

  const approvalId = `apr:${crypto.randomUUID()}`;
  await insertApproval(env.DB, {
    id: approvalId,
    runId: run.id,
    generationId: "turn-1",
    draft: "We can refund the last invoice.",
    why: "committal",
    channelId,
    threadTs,
    shadow: options.shadow === true,
    now: Date.now(),
  });

  const stub = await getAgentByName(env.RUN_AGENTS, key);
  await stub.setOpenApproval(approvalId);

  return { run, approvalId, stub, channelId, threadTs };
}

/**
 * Every user-authority message this run holds, newest last.
 *
 * Typed structurally rather than as the agent stub: `getAgentByName` without
 * explicit type arguments widens `state` to `never`, and naming only the one
 * method this reads keeps the helper honest about what it touches.
 */
async function userTexts(stub: {
  getMessages(): Promise<UIMessage[]>;
}): Promise<string[]> {
  const messages = await stub.getMessages();
  return messages
    .filter((message) => message.role === "user")
    .map((message) =>
      message.parts
        .filter(
          (part): part is { type: "text"; text: string } => part.type === "text"
        )
        .map((part) => part.text)
        .join("")
    );
}

beforeEach(() => {
  resetApprovalApiPorts();
  installTestModel(cannedModel());
});
afterEach(() => {
  resetApprovalApiPorts();
  resetTestModel();
});

describe("delivering a decision into its run", () => {
  it("unparks the run and submits the approved text", async () => {
    const { run, approvalId, stub } = await parkedRun();
    const outbound = sender("blocked");
    await decideApproval(
      env.DB,
      approvalId,
      { action: "approve" },
      FIREFIGHTER,
      Date.now()
    );

    const outcome = await makeRunAgentResolutionNotifier({
      env,
      sender: outbound.port,
    }).notify({
      runId: run.id,
      approvalId,
      decision: "approved",
      outboundText: "We can refund the last invoice.",
      rejectReason: null,
      decidedBy: FIREFIGHTER,
    });

    expect(outcome).toEqual({ applied: true });
    // Unparked BEFORE the turn: `beforeToolCall` blocks every tool call while
    // the flag is set, so a resolution turn against a still-parked run could
    // read the decision and then be refused the call it needs to act on it.
    expect((await stub.runStateForTest()).openApprovalId).toBeNull();

    const resolution = await waitFor("the resolution turn", async () => {
      const texts = await userTexts(stub);
      return texts.find((text) => text.includes("APPROVED")) ?? null;
    });
    expect(resolution).toContain("We can refund the last invoice.");
  });

  it("delivers the human's edit, never the model's superseded draft", async () => {
    const { run, approvalId, stub } = await parkedRun();
    const outbound = sender("sent");
    await decideApproval(
      env.DB,
      approvalId,
      { action: "edit", text: "We'll credit the last invoice instead." },
      FIREFIGHTER,
      Date.now()
    );

    await makeRunAgentResolutionNotifier({ env, sender: outbound.port }).notify(
      {
        runId: run.id,
        approvalId,
        decision: "edited",
        outboundText: "We'll credit the last invoice instead.",
        rejectReason: null,
        decidedBy: FIREFIGHTER,
      }
    );

    // The edited text is what goes to the customer, byte-exact.
    expect(outbound.calls[0].text).toBe(
      "We'll credit the last invoice instead."
    );
    const resolution = await waitFor("the resolution turn", async () => {
      const texts = await userTexts(stub);
      return texts.find((text) => text.includes("EDITED")) ?? null;
    });
    expect(resolution).toContain("We'll credit the last invoice instead.");
    // And the model is shown what its own version was, so it can see the gap.
    expect(resolution).toContain("We can refund the last invoice.");
  });

  it("carries a rejection's reason and sends nothing at all", async () => {
    const { run, approvalId, stub } = await parkedRun();
    const outbound = sender("sent");
    await decideApproval(
      env.DB,
      approvalId,
      { action: "reject", reason: "we do not promise refunds" },
      FIREFIGHTER,
      Date.now()
    );

    await makeRunAgentResolutionNotifier({ env, sender: outbound.port }).notify(
      {
        runId: run.id,
        approvalId,
        decision: "rejected",
        outboundText: null,
        rejectReason: "we do not promise refunds",
        decidedBy: FIREFIGHTER,
      }
    );

    expect(outbound.calls).toEqual([]);
    expect(await getApproval(env.DB, approvalId)).toMatchObject({
      delivery: "none",
    });
    const resolution = await waitFor("the resolution turn", async () => {
      const texts = await userTexts(stub);
      return texts.find((text) => text.includes("REJECTED")) ?? null;
    });
    expect(resolution).toContain("we do not promise refunds");
  });

  it("never tells the model who decided", async () => {
    // Invariant 12: D1 records which engineer clicked because the dashboard and
    // later audits need it. A run's answer must not change with who was on duty.
    const { run, approvalId, stub } = await parkedRun();
    await decideApproval(
      env.DB,
      approvalId,
      { action: "approve" },
      FIREFIGHTER,
      Date.now()
    );
    await makeRunAgentResolutionNotifier({
      env,
      sender: sender("blocked").port,
    }).notify({
      runId: run.id,
      approvalId,
      decision: "approved",
      outboundText: "We can refund the last invoice.",
      rejectReason: null,
      decidedBy: FIREFIGHTER,
    });

    await waitFor("the resolution turn", async () => {
      const texts = await userTexts(stub);
      return texts.find((text) => text.includes("APPROVED")) ?? null;
    });
    expect(JSON.stringify(await stub.getMessages())).not.toContain(FIREFIGHTER);
  });

  it("submits one turn however many times the resolution is re-driven", async () => {
    // Idempotency replaces the delivered-CAS: the cron re-submits
    // `approval:{id}` unconditionally and the submission queue refuses repeats.
    const { run, approvalId, stub } = await parkedRun();
    await decideApproval(
      env.DB,
      approvalId,
      { action: "approve" },
      FIREFIGHTER,
      Date.now()
    );
    const notifier = makeRunAgentResolutionNotifier({
      env,
      sender: sender("blocked").port,
    });
    const notification = {
      runId: run.id,
      approvalId,
      decision: "approved" as const,
      outboundText: "We can refund the last invoice.",
      rejectReason: null,
      decidedBy: FIREFIGHTER,
    };

    expect(await notifier.notify(notification)).toEqual({ applied: true });
    expect(await notifier.notify(notification)).toEqual({ applied: true });
    await waitFor("the resolution turn", async () => {
      const texts = await userTexts(stub);
      return texts.find((text) => text.includes("APPROVED")) ?? null;
    });

    const resolutions = (await userTexts(stub)).filter((text) =>
      text.includes("APPROVED")
    );
    expect(resolutions).toHaveLength(1);
  });

  it("attempts one send however many times it is re-driven", async () => {
    // A duplicate message to a customer cannot be taken back, so the second
    // attempt is refused by the delivery CAS and reported as in doubt.
    const { run, approvalId } = await parkedRun();
    const outbound = sender("sent");
    await decideApproval(
      env.DB,
      approvalId,
      { action: "approve" },
      FIREFIGHTER,
      Date.now()
    );
    const notifier = makeRunAgentResolutionNotifier({
      env,
      sender: outbound.port,
    });
    const notification = {
      runId: run.id,
      approvalId,
      decision: "approved" as const,
      outboundText: "We can refund the last invoice.",
      rejectReason: null,
      decidedBy: FIREFIGHTER,
    };

    await notifier.notify(notification);
    await notifier.notify(notification);

    expect(outbound.calls).toHaveLength(1);
    expect(await getApproval(env.DB, approvalId)).toMatchObject({
      delivery: "sent",
    });
  });

  it("suppresses the send for a shadow run and still resolves it", async () => {
    const { run, approvalId, stub } = await parkedRun({ shadow: true });
    const outbound = sender("sent");
    await decideApproval(
      env.DB,
      approvalId,
      { action: "approve" },
      FIREFIGHTER,
      Date.now()
    );

    await makeRunAgentResolutionNotifier({ env, sender: outbound.port }).notify(
      {
        runId: run.id,
        approvalId,
        decision: "approved",
        outboundText: "We can refund the last invoice.",
        rejectReason: null,
        decidedBy: FIREFIGHTER,
      }
    );

    expect(outbound.calls).toEqual([]);
    expect(await getApproval(env.DB, approvalId)).toMatchObject({
      delivery: "suppressed",
    });
    const resolution = await waitFor("the resolution turn", async () => {
      const texts = await userTexts(stub);
      return texts.find((text) => text.includes("APPROVED")) ?? null;
    });
    expect(resolution).toContain(
      "shadowing a conversation it must never write to"
    );
  });

  it("sends to the run's own pinned thread, never the card's copy of it", async () => {
    const { run, approvalId, channelId, threadTs } = await parkedRun();
    const outbound = sender("sent");
    await decideApproval(
      env.DB,
      approvalId,
      { action: "approve" },
      FIREFIGHTER,
      Date.now()
    );

    await makeRunAgentResolutionNotifier({ env, sender: outbound.port }).notify(
      {
        runId: run.id,
        approvalId,
        decision: "approved",
        outboundText: "text",
        rejectReason: null,
        decidedBy: FIREFIGHTER,
      }
    );

    expect(outbound.calls[0]).toMatchObject({
      channelId,
      threadTs,
      decidedBy: FIREFIGHTER,
    });
  });
});

describe("a resolution that cannot be delivered", () => {
  it("reports undelivered rather than throwing when the run has no row", async () => {
    // A human's committed decision must never turn into a failed request.
    const outcome = await makeRunAgentResolutionNotifier({ env }).notify({
      runId: crypto.randomUUID(),
      approvalId: `apr:${crypto.randomUUID()}`,
      decision: "approved",
      outboundText: "text",
      rejectReason: null,
      decidedBy: FIREFIGHTER,
    });
    expect(outcome).toEqual({ applied: false });
  });

  it("refuses a decision the system of record does not carry", async () => {
    // Unparking a run on a decision D1 does not hold would be a resolution
    // nobody made.
    const { run, approvalId } = await parkedRun();
    const outcome = await makeRunAgentResolutionNotifier({ env }).notify({
      runId: run.id,
      approvalId,
      decision: "approved",
      outboundText: "text",
      rejectReason: null,
      decidedBy: FIREFIGHTER,
    });
    expect(outcome).toEqual({ applied: false });
  });

  it("refuses a card that belongs to a different run", async () => {
    // An approval resolved into the wrong object would put one customer's
    // approved text into another customer's run.
    const first = await parkedRun();
    const second = await parkedRun();
    await decideApproval(
      env.DB,
      first.approvalId,
      { action: "approve" },
      FIREFIGHTER,
      Date.now()
    );

    const outcome = await makeRunAgentResolutionNotifier({ env }).notify({
      runId: second.run.id,
      approvalId: first.approvalId,
      decision: "approved",
      outboundText: "text",
      rejectReason: null,
      decidedBy: FIREFIGHTER,
    });
    expect(outcome).toEqual({ applied: false });
    expect((await second.stub.runStateForTest()).openApprovalId).toBe(
      second.approvalId
    );
  });
});

describe("the route that carries the click", () => {
  async function patch(approvalId: string, body: unknown, token: string) {
    return SELF.fetch(`https://firefighter.test/api/approvals/${approvalId}`, {
      method: "PATCH",
      headers: {
        "Cf-Access-Jwt-Assertion": token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  it("delivers through the production notifier with nothing installed but the verifier", async () => {
    // `resolvePorts` composes the real notifier when none is installed. Until
    // this existed, an unwired notifier and a dead run were indistinguishable —
    // both produce `resolutionDelivered: false`.
    installApprovalApiPorts({ verifier: fakeVerifier() });
    const { run, approvalId, stub } = await parkedRun();

    const res = await patch(approvalId, { action: "approve" }, FIREFIGHTER);
    expect(res.status).toBe(200);
    const body = await res.json<{
      resolutionDelivered: boolean;
      approval: { delivery: string };
    }>();
    expect(body.resolutionDelivered).toBe(true);
    // The response is re-read AFTER the notify settles, so it reports the
    // delivery state the run actually reached rather than the pre-notify one.
    expect(body.approval.delivery).toBe("blocked");
    expect(await getApproval(env.DB, approvalId)).toMatchObject({
      decision: "approved",
    });
    expect((await stub.runStateForTest()).openApprovalId).toBeNull();
    expect(run.id).toBeTruthy();
  });

  it("still refuses a viewer before anything is written", async () => {
    installApprovalApiPorts({ verifier: fakeVerifier() });
    const { approvalId, stub } = await parkedRun();

    const res = await patch(approvalId, { action: "approve" }, VIEWER);
    expect(res.status).toBe(403);
    expect(await getApproval(env.DB, approvalId)).toMatchObject({
      decision: "pending",
    });
    // The run is still parked: nothing reached it.
    expect((await stub.runStateForTest()).openApprovalId).toBe(approvalId);
  });

  it("still refuses an unverifiable token", async () => {
    installApprovalApiPorts({ verifier: fakeVerifier() });
    const { approvalId } = await parkedRun();
    expect((await patch(approvalId, { action: "approve" }, "")).status).toBe(
      401
    );
    expect(await getApproval(env.DB, approvalId)).toMatchObject({
      decision: "pending",
    });
  });

  it("409s a second click, carrying the decision that won", async () => {
    installApprovalApiPorts({ verifier: fakeVerifier() });
    const { approvalId } = await parkedRun();

    expect(
      (await patch(approvalId, { action: "approve" }, FIREFIGHTER)).status
    ).toBe(200);
    const second = await patch(
      approvalId,
      { action: "reject", reason: "no" },
      FIREFIGHTER
    );
    expect(second.status).toBe(409);
    expect(await second.json<{ decision: string }>()).toMatchObject({
      decision: "approved",
    });
  });

  it("re-drives an undelivered resolution from the sweep", async () => {
    installApprovalApiPorts({ verifier: fakeVerifier() });
    const { run, approvalId, stub } = await parkedRun();
    // Decided in D1 with no notify at all: the state a crashed PATCH leaves.
    await decideApproval(
      env.DB,
      approvalId,
      { action: "approve" },
      FIREFIGHTER,
      Date.now()
    );

    // One page per sweep, and this pool's D1 is shared across files, so the
    // row is not guaranteed to be on the first page. Repeating is what the
    // cron does anyway — once a minute, forever.
    await waitFor("the sweep to reach this row", async () => {
      await sweepUndeliveredApprovals(env);
      return (await stub.runStateForTest()).openApprovalId === null
        ? true
        : null;
    });

    const resolution = await waitFor("the swept resolution turn", async () => {
      const texts = await userTexts(stub);
      return texts.find((text) => text.includes("APPROVED")) ?? null;
    });
    expect(resolution).toContain("We can refund the last invoice.");
    expect(run.id).toBeTruthy();
  });
});

describe("a resolved run", () => {
  it("is not re-parked by the resolution it just took", async () => {
    const { run, approvalId, stub } = await parkedRun();
    await decideApproval(
      env.DB,
      approvalId,
      { action: "approve" },
      FIREFIGHTER,
      Date.now()
    );
    await makeRunAgentResolutionNotifier({
      env,
      sender: sender("blocked").port,
    }).notify({
      runId: run.id,
      approvalId,
      decision: "approved",
      outboundText: "text",
      rejectReason: null,
      decidedBy: FIREFIGHTER,
    });

    await waitFor("the resolution turn to finish", async () => {
      const state = await stub.runStateForTest();
      return state.status === "idle" ? state : null;
    });
    // Defect 3 in the other direction: `awaiting_approval` is for a decision
    // that is still outstanding, and this one is not.
    expect((await stub.runStateForTest()).status).toBe("idle");
    await setRunStatus(env.DB, run.id, "idle");
  });
});
