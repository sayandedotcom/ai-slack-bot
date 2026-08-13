import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessJwtError, type AccessIdentity, type AccessVerifier } from "../src/access/jwt";
import { installApprovalApiPorts, resetApprovalApiPorts } from "../src/api/approvals";
import { installRunPorts } from "../src/agent/driver";
import {
  makeIdentityRefusingSender,
  makeUserTokenSender,
  NOT_CONNECTED,
  type ApprovalSender,
} from "../src/approval/sender";
import type { UserTokenSource } from "../src/identity/user-token";
import type { DecisionInput } from "../src/approval/contracts";
import {
  decideApproval,
  insertApproval,
  listUndeliveredResolutions,
  recordNudgeMessage,
  setDelivery,
} from "../src/approval/repository";
import {
  putApprovalState,
  readApprovalState,
  readModelTranscript,
  resolveApprovalState,
} from "../src/run/session";
import { FakeContinuation, freshDriverRun, turn, type DriverHarness } from "./helpers/agent-driver";

/**
 * RESOLUTION: one human decision, back into the run it came from.
 *
 * Everything here runs against the real RunDO, the real session transactions,
 * the real D1 `approvals` row and the real driver. The two cases that decide
 * whether a customer hears anything use the REAL Phase 13 sender
 * (`makeUserTokenSender`) over a stubbed transport — one with the on-duty
 * engineer connected, one with nobody connected — because "delivery reached
 * `sent`" and "delivery blocked honestly" are the behaviours that have to be
 * proved, not mocked. The remaining cases fake the port, because what they are
 * about is the state machine around the send rather than the send itself.
 *
 * The two properties worth naming, because both look like bugs from outside:
 *
 *  - a `blocked` delivery is TERMINAL and the run STILL RESUMES. A deployment
 *    where nobody on duty has connected Slack has nobody to speak as, and there
 *    is no bot-token fallback, ever, so parking the run until the send succeeds
 *    would strand every escalation. The decision is a fact; delivery is a
 *    separate state machine.
 *  - a replayed `resolveApproval` — the sweeper repairing a crash — appends NO
 *    second turn and attempts NO second send. The turn id is what makes the
 *    first true and the delivery CAS is what makes the second true.
 */

const DRAFT = "We can have the migration finished by Friday.";
const EDITED = "We expect the migration to finish early next week.";
const WHY = "it commits us to a date in front of the customer";
const FIREFIGHTER = "ronit@zellify.app";
const CHANNEL = "C11RESOLUTION";
/** The engineer DM a nudge already landed in, for the nudge-rewrite case. */
const NUDGE_CHANNEL = "D0RESOLVED";
const NUDGE_TS = "1723640000.000800";

/* ---------------------------------------------------------------- fakes -- */

type SendInput = Parameters<ApprovalSender["send"]>[0];
type SendResult = Awaited<ReturnType<ApprovalSender["send"]>>;

/**
 * Records every send it is asked for. `calls.length` is the assertion that
 * matters most in this file: "the sender was NEVER called" is a strictly
 * stronger claim than "delivery ended up suppressed", and only the first one
 * says a shadow run cannot speak to a customer.
 */
function recordingSender(
  result: SendResult = { result: "sent", ts: "1720000000.000100" },
): ApprovalSender & { calls: SendInput[] } {
  const calls: SendInput[] = [];
  return {
    calls,
    async send(input) {
      calls.push(input);
      return result;
    },
  };
}

/* ------------------------------------------------- the real Phase 13 sender -- */

const USER_TOKEN = "xoxp-not-a-real-on-duty-token";

/** The on-duty engineer, connected. */
const connected: UserTokenSource = {
  async onDutyToken() {
    return { token: USER_TOKEN, slackUserId: "U0NDUTY01", email: "ronit@zellify.app" };
  },
};

/** Nobody on duty has connected Slack. Configuration, not error. */
const unconnected: UserTokenSource = {
  async onDutyToken() {
    return null;
  },
};

type Posted = { url: string; authorization: string | null; body: unknown };

/**
 * A `fetch` for the real sender to post through, injected rather than stubbed
 * globally: this file drives a real Durable Object over `SELF.fetch`, and a
 * global stub would sit in the middle of that too.
 */
function slackFetch(answer: { ok: true; ts: string } | { ok: false; error: string }): {
  calls: Posted[];
  fetchImpl: typeof fetch;
} {
  const calls: Posted[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** Same fake identity-as-token verifier as `approval-api.test.ts`. */
function fakeVerifier(): AccessVerifier {
  return {
    async verify(jwt: string): Promise<AccessIdentity> {
      if (!jwt) throw new AccessJwtError("missing", "no token was supplied");
      if (!jwt.includes("@")) throw new AccessJwtError("malformed", "not an email-shaped fake token");
      return { email: jwt };
    },
  };
}

/* ------------------------------------------------------------- fixtures -- */

let threads = 0;

/** A fresh, well-formed `seconds.microseconds` thread id per run. */
function nextThreadTs(): string {
  threads += 1;
  return `${1_720_000_000 + Math.floor(Math.random() * 8_000_000)}.${String(threads).padStart(6, "0")}`;
}

type Parked = {
  h: DriverHarness;
  approvalId: string;
  channelId: string;
  threadTs: string;
  continuation: FakeContinuation;
};

/**
 * A run genuinely parked on a genuinely open approval: the local
 * `approval_state` row a real `escalate` writes, the D1 card the projection
 * would create, the real `paused` finalize, and (unless `decide: false`) the
 * human decision already CASed into D1 — i.e. exactly the state the DO is in
 * when the dashboard's PATCH notifies it.
 */
async function parkedApproval(
  options: {
    sender?: ApprovalSender;
    /** Flip the D1 `runs` row, NOT the card, to shadow. */
    shadowRun?: boolean;
    /** The card's own snapshot of `shadow`. */
    cardShadow?: boolean;
    /** Where the CARD says the reply goes — deliberately settable apart from
     *  the run's pinned thread, so invariant 10 can be tested. */
    cardChannelId?: string;
    cardThreadTs?: string;
    decision?: DecisionInput;
    decide?: boolean;
  } = {},
): Promise<Parked> {
  const continuation = new FakeContinuation();
  const channelId = CHANNEL;
  const threadTs = nextThreadTs();
  const h = await freshDriverRun({ continuation, slack: { channelId, threadTs } });
  if (options.sender) {
    installRunPorts({ approvalSender: options.sender }, { runKey: h.key });
  }

  const approvalId = `apr:${crypto.randomUUID()}`;
  continuation
    .onRun((claim, s) => {
      putApprovalState(s, {
        approvalId,
        generationId: claim.generationId,
        draft: DRAFT,
        why: WHY,
        now: h.clock.value,
      });
    })
    .returns({ outcome: "paused", approvalId });

  await h.stub.appendTurn(turn(`open:${approvalId}`));
  await h.alarm();
  expect((await h.stub.state())?.status).toBe("awaiting_approval");

  if (options.shadowRun === true) {
    await env.DB.prepare(`UPDATE runs SET shadow = 1 WHERE id = ?`).bind(h.runId).run();
  }

  expect(
    await insertApproval(env.DB, {
      id: approvalId,
      runId: h.runId,
      generationId: continuation.claims[0].generationId,
      draft: DRAFT,
      why: WHY,
      channelId: options.cardChannelId ?? channelId,
      threadTs: options.cardThreadTs ?? threadTs,
      shadow: options.cardShadow ?? false,
      now: h.clock.value,
    }),
  ).toBe("created");

  if (options.decide !== false) {
    const decided = await decideApproval(
      env.DB,
      approvalId,
      options.decision ?? { action: "approve" },
      FIREFIGHTER,
      h.clock.value,
    );
    expect(decided.result).toBe("decided");
  }

  // The escalation is over. The next generation is an ordinary one, so it
  // consumes the resolution turn instead of opening a second approval.
  continuation.onRun(async () => {}).returns({ outcome: "completed" });

  return { h, approvalId, channelId, threadTs, continuation };
}

type DeliveryRow = {
  delivery: string;
  delivery_error: string | null;
  resolution_delivered_at: number | null;
};

/** `delivery_error` and `resolution_delivered_at` are not on `ApprovalRow`. */
function deliveryOf(id: string): Promise<DeliveryRow | null> {
  return env.DB.prepare(
    `SELECT delivery, delivery_error, resolution_delivered_at FROM approvals WHERE id = ?`,
  )
    .bind(id)
    .first<DeliveryRow>();
}

/**
 * Every resolution turn in the run, found by SOURCE rather than by the id
 * under test. Filtering by `approval:{id}` would make "exactly one turn" true
 * by construction — a second turn under a different id would simply not be
 * counted, which is the one failure this file most needs to see.
 */
async function resolutionTurns(h: DriverHarness) {
  const turns = await h.stub.turns();
  return turns.filter((t) => t.source === "approval");
}

/* ------------------------------------------------------- approved/edited -- */

describe("an approved reply resolves through the one inbox", () => {
  it("goes out under the ON-DUTY ENGINEER'S token and records delivery sent", async () => {
    // THE PHASE 13 PATH, end to end: the real `makeUserTokenSender` over a
    // stubbed transport, reached through the same port a deployed RunDO uses.
    const slack = slackFetch({ ok: true, ts: "1720000000.000500" });
    const { h, approvalId, channelId, threadTs } = await parkedApproval({
      sender: makeUserTokenSender(connected, slack.fetchImpl),
    });

    expect(
      await h.stub.resolveApproval({
        approvalId,
        decision: "approved",
        outboundText: DRAFT,
        rejectReason: null,
        decidedBy: FIREFIGHTER,
      }),
    ).toEqual({ applied: true });

    expect((await deliveryOf(approvalId))?.delivery).toBe("sent");
    expect((await deliveryOf(approvalId))?.resolution_delivered_at).not.toBeNull();

    // THE CREDENTIAL: the human's token, and provably not the bot's.
    expect(slack.calls).toHaveLength(1);
    expect(slack.calls[0].authorization).toBe(`Bearer ${USER_TOKEN}`);
    expect(slack.calls[0].authorization).not.toContain(env.SLACK_BOT_TOKEN);
    expect(slack.calls[0].url).toBe("https://slack.com/api/chat.postMessage");
    // THE DESTINATION AND THE TEXT: the run's own pinned thread, and the
    // approved characters byte-exact — no preamble, no signature.
    expect(slack.calls[0].body).toEqual({
      channel: channelId,
      thread_ts: threadTs,
      text: DRAFT,
    });

    const resolution = await resolutionTurns(h);
    expect(resolution).toHaveLength(1);
    expect(resolution[0].content).toContain(DRAFT);
    expect(resolution[0].content).not.toContain("NOT sent");
    expect((await h.stub.state())?.status).toBe("live");
    // The token never reaches the run's own record of what happened.
    expect(JSON.stringify(resolution)).not.toContain(USER_TOKEN);
  });

  it("blocks when nobody on duty has connected Slack, and never uses the bot", async () => {
    // THE HONEST FALLBACK, preserved rather than deleted. `SLACK_BOT_TOKEN` is
    // present and usable in this environment, which is exactly why this
    // matters: refusing has to be a decision, not a missing credential.
    expect(env.SLACK_BOT_TOKEN).toBeTruthy();
    const slack = slackFetch({ ok: true, ts: "1720000000.000501" });
    const { h, approvalId } = await parkedApproval({
      sender: makeUserTokenSender(unconnected, slack.fetchImpl),
    });

    expect(
      await h.stub.resolveApproval({
        approvalId,
        decision: "approved",
        outboundText: DRAFT,
        rejectReason: null,
        decidedBy: FIREFIGHTER,
      }),
    ).toEqual({ applied: true });

    // Nothing was attempted at all, under any identity.
    expect(slack.calls).toEqual([]);
    // Delivery is terminal and honest about why.
    expect(await deliveryOf(approvalId)).toMatchObject({
      delivery: "blocked",
      delivery_error: NOT_CONNECTED,
    });
    expect((await deliveryOf(approvalId))?.resolution_delivered_at).not.toBeNull();

    // Exactly one resolution turn, from the approval source.
    const resolution = await resolutionTurns(h);
    expect(resolution).toHaveLength(1);
    expect(resolution[0].id).toBe(`approval:${approvalId}`);
    expect(resolution[0].source).toBe("approval");
    expect(resolution[0].role).toBe("user");
    expect(resolution[0].content).toContain(DRAFT);
    expect(resolution[0].content).toContain("NOT sent");

    // The run unparked, and the local record is settled so the next finalize
    // cannot re-park it.
    expect((await h.stub.state())?.status).toBe("live");
    expect((await h.storage((s) => readApprovalState(s, approvalId)))?.state).toBe("resolved");

    // And the next generation genuinely SEES it, as user-authority input.
    await h.alarm();
    const transcript = await h.storage((s) => readModelTranscript(s));
    const inputs = transcript.filter((entry) => entry.kind === "input");
    expect(JSON.stringify(inputs.at(-1))).toContain(DRAFT);
  });

  it("sends the EDITED text, and only the edited text", async () => {
    const sender = recordingSender();
    const { h, approvalId } = await parkedApproval({
      sender,
      decision: { action: "edit", text: EDITED },
    });

    await h.stub.resolveApproval({
      approvalId,
      decision: "edited",
      outboundText: EDITED,
      rejectReason: null,
      decidedBy: FIREFIGHTER,
    });

    expect(sender.calls).toHaveLength(1);
    // THE SEND carries only the edited text — `.toBe`, not `.toContain`, so a
    // draft that leaked in as a prefix or suffix would fail this too.
    expect(sender.calls[0].text).toBe(EDITED);
    expect((await deliveryOf(approvalId))?.delivery).toBe("sent");

    // THE RESOLUTION TURN is not the send: it also carries the model's own
    // superseded draft, deliberately (per `resolutionTurnContent`) — the
    // model needs to see what it originally proposed beside what actually
    // went out. Only the wire text sent to the customer is draft-free.
    const resolution = await resolutionTurns(h);
    expect(resolution[0].content).toContain(EDITED);
    expect(resolution[0].content).toContain(DRAFT);
  });

  it("takes the destination from run state, never from the card's snapshot", async () => {
    // The card claims a different channel and thread. It is a DISPLAY
    // snapshot; the sender re-derives the destination from `run_state` at
    // delivery time (invariant 10), so the card's values must not appear.
    const sender = recordingSender();
    const { h, approvalId, channelId, threadTs } = await parkedApproval({
      sender,
      cardChannelId: "CWRONGPLACE",
      cardThreadTs: "1699999999.999999",
    });

    await h.stub.resolveApproval({
      approvalId,
      decision: "approved",
      outboundText: DRAFT,
      rejectReason: null,
      decidedBy: FIREFIGHTER,
    });

    expect(sender.calls[0]).toMatchObject({ runId: h.runId, channelId, threadTs });
  });

  /**
   * THE SETTLED CARD REWRITES ITS OWN NUDGE DM (Phase 13 Task 6).
   *
   * `updateNudge` is unit-tested in `notify-nudge.test.ts`; this proves the
   * WIRING — that `RunDO.resolveApproval` actually calls it, with the row that
   * carries the decision and the decider. Every other case in this file
   * resolves a card with no recorded nudge message, where `updateNudge`
   * returns before it does anything, so without this one the call could be
   * deleted and the file would stay green.
   *
   * The nudge is not sent here (no projector runs); the recorded message id is
   * written directly, because what is under test is what happens to a DM that
   * HAS gone out.
   */
  it("rewrites the engineer's nudge DM, whose Review button is now dead", async () => {
    const { h, approvalId } = await parkedApproval({ sender: recordingSender() });
    await recordNudgeMessage(env.DB, approvalId, NUDGE_CHANNEL, NUDGE_TS);

    // Same isolate as the Durable Object, so this reaches the call the
    // resolution makes. The customer send does not come through here — it goes
    // through the injected sender above — so every request recorded is the
    // nudge edit.
    const slackCalls: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      slackCalls.push({
        url: String(url),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        authorization: new Headers(init.headers).get("authorization"),
      });
      return new Response(JSON.stringify({ ok: true, ts: NUDGE_TS }), { status: 200 });
    });

    try {
      expect(
        await h.stub.resolveApproval({
          approvalId,
          decision: "approved",
          outboundText: DRAFT,
          rejectReason: null,
          decidedBy: FIREFIGHTER,
        }),
      ).toEqual({ applied: true });
    } finally {
      vi.unstubAllGlobals();
    }

    const updates = slackCalls.filter((call) => call.url === "https://slack.com/api/chat.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.body.channel).toBe(NUDGE_CHANNEL);
    expect(updates[0]!.body.ts).toBe(NUDGE_TS);
    // The decision and the decider, in the message that replaces the card.
    expect(JSON.stringify(updates[0]!.body.blocks)).toContain(`Approved by ${FIREFIGHTER}`);
    // The bot's own message, edited with the bot's own token. The customer
    // send above used the engineer's user token, and these two credentials
    // must never be confused for one another.
    expect(updates[0]!.authorization).toBe(`Bearer ${env.SLACK_BOT_TOKEN}`);
  });

  it("keeps decidedBy out of the model's context entirely", async () => {
    const { h, approvalId } = await parkedApproval();
    await h.stub.resolveApproval({
      approvalId,
      decision: "approved",
      outboundText: DRAFT,
      rejectReason: null,
      decidedBy: FIREFIGHTER,
    });

    // Invariant 12: D1 records who decided; the model has no business knowing.
    // Content AND metadata, because metadata rides along on the same turn.
    const resolution = await resolutionTurns(h);
    expect(JSON.stringify(resolution[0])).not.toContain(FIREFIGHTER);

    await h.alarm();
    const transcript = await h.storage((s) => readModelTranscript(s));
    expect(JSON.stringify(transcript)).not.toContain(FIREFIGHTER);
  });
});

/* ------------------------------------------------------------- rejected -- */

describe("a rejected reply", () => {
  it("attempts no send, leaves delivery none, and carries the reason into the run", async () => {
    const sender = recordingSender();
    const { h, approvalId } = await parkedApproval({
      sender,
      decision: { action: "reject", reason: "we have not agreed that date internally" },
    });

    await h.stub.resolveApproval({
      approvalId,
      decision: "rejected",
      outboundText: null,
      rejectReason: "we have not agreed that date internally",
      decidedBy: FIREFIGHTER,
    });

    expect(sender.calls).toHaveLength(0);
    expect((await deliveryOf(approvalId))?.delivery).toBe("none");

    const resolution = await resolutionTurns(h);
    expect(resolution).toHaveLength(1);
    expect(resolution[0].content).toContain("we have not agreed that date internally");
    expect((await h.stub.state())?.status).toBe("live");
  });
});

/* --------------------------------------------------------------- shadow -- */

describe("a shadow run", () => {
  it("suppresses delivery and NEVER calls the sender", async () => {
    // The card says `shadow: false` — it was projected before the run was
    // ratcheted — and the D1 `runs` row says true. The live row wins.
    const sender = recordingSender();
    const { h, approvalId } = await parkedApproval({ sender, shadowRun: true, cardShadow: false });

    await h.stub.resolveApproval({
      approvalId,
      decision: "approved",
      outboundText: DRAFT,
      rejectReason: null,
      decidedBy: FIREFIGHTER,
    });

    expect(sender.calls).toEqual([]);
    expect((await deliveryOf(approvalId))?.delivery).toBe("suppressed");

    const resolution = await resolutionTurns(h);
    expect(resolution).toHaveLength(1);
    expect(resolution[0].content).toContain("nothing was sent");
    // The human's decision is still a fact, so the run still resumes.
    expect((await h.stub.state())?.status).toBe("live");
  });
});

/* ------------------------------------------------------------- in doubt -- */

describe("an unknown send outcome", () => {
  it("records in_doubt, says so in the turn, and still resumes the run", async () => {
    const sender = recordingSender({ result: "in_doubt", reason: "the gateway timed out" });
    const { h, approvalId } = await parkedApproval({ sender });

    await h.stub.resolveApproval({
      approvalId,
      decision: "approved",
      outboundText: DRAFT,
      rejectReason: null,
      decidedBy: FIREFIGHTER,
    });

    expect(await deliveryOf(approvalId)).toMatchObject({
      delivery: "in_doubt",
      delivery_error: "the gateway timed out",
    });
    const resolution = await resolutionTurns(h);
    expect(resolution[0].content).toContain("unknown");
    expect((await h.stub.state())?.status).toBe("live");
  });

  it("maps a `sending` row found on re-entry to in_doubt without a second send", async () => {
    // The crash window the sweeper repairs: step (2) moved the row to
    // `sending` and the isolate died before the sender returned. Nobody knows
    // whether the customer saw it, and a duplicate customer message is not
    // recoverable — so this is a human's problem, not a retry.
    const sender = recordingSender();
    const { h, approvalId } = await parkedApproval({ sender });
    expect(await setDelivery(env.DB, approvalId, ["none"], "sending", null, h.clock.value)).toBe(true);

    await h.stub.resolveApproval({
      approvalId,
      decision: "approved",
      outboundText: DRAFT,
      rejectReason: null,
      decidedBy: FIREFIGHTER,
    });

    expect(sender.calls).toEqual([]);
    expect((await deliveryOf(approvalId))?.delivery).toBe("in_doubt");
    expect(await resolutionTurns(h)).toHaveLength(1);
    expect((await h.stub.state())?.status).toBe("live");
  });
});

/* ------------------------------------------------ the one writer surface -- */

describe("a resolution D1 does not carry", () => {
  it("is refused: no send, no turn, and the run stays parked", async () => {
    // The approval is still `pending` in D1 — nobody decided it. A caller that
    // announced a decision anyway would be a second writer surface
    // (invariant 6), and unparking on it would answer a customer with a
    // decision no human ever made.
    const sender = recordingSender();
    const { h, approvalId } = await parkedApproval({ sender, decide: false });

    expect(
      await h.stub.resolveApproval({
        approvalId,
        decision: "approved",
        outboundText: DRAFT,
        rejectReason: null,
        decidedBy: FIREFIGHTER,
      }),
    ).toEqual({ applied: false });

    expect(sender.calls).toEqual([]);
    expect(await resolutionTurns(h)).toHaveLength(0);
    expect((await deliveryOf(approvalId))?.delivery).toBe("none");
    expect((await h.stub.state())?.status).toBe("awaiting_approval");
  });
});

/* ----------------------------------------------------------- idempotency -- */

describe("a replayed resolution (the sweeper repairing a crash)", () => {
  it("appends no second turn and attempts no second send", async () => {
    const sender = recordingSender();
    const { h, approvalId } = await parkedApproval({ sender });
    const input = {
      approvalId,
      decision: "approved" as const,
      outboundText: DRAFT,
      rejectReason: null,
      decidedBy: FIREFIGHTER,
    };

    expect(await h.stub.resolveApproval(input)).toEqual({ applied: true });
    const afterFirst = await h.stub.turns();
    const deliveredAt = (await deliveryOf(approvalId))?.resolution_delivered_at;

    // The sweeper's re-drive: the same call, twice more.
    expect(await h.stub.resolveApproval(input)).toEqual({ applied: true });
    expect(await h.stub.resolveApproval(input)).toEqual({ applied: true });

    // ONE turn, and not one more turn of any kind: a second resolution turn
    // would be a second wake and a second answer to the same decision.
    expect(await resolutionTurns(h)).toHaveLength(1);
    expect(await h.stub.turns()).toEqual(afterFirst);

    // ONE send. The delivery CAS, not the turn id, is what makes this true.
    expect(sender.calls).toHaveLength(1);
    expect((await deliveryOf(approvalId))?.delivery).toBe("sent");
    expect(deliveredAt).not.toBeNull();
    expect((await deliveryOf(approvalId))?.resolution_delivered_at).not.toBeNull();
    expect((await h.storage((s) => readApprovalState(s, approvalId)))?.state).toBe("resolved");
  });
});

/* ------------------------------------------------------- the crash window -- */

describe("a crash between settling the local record and committing the turn", () => {
  it("heals on re-entry: the run ends live with exactly one resolution turn", async () => {
    const sender = recordingSender();
    const { h, approvalId } = await parkedApproval({ sender });
    const input = {
      approvalId,
      decision: "approved" as const,
      outboundText: DRAFT,
      rejectReason: null,
      decidedBy: FIREFIGHTER,
    };

    // The crash, reproduced exactly: step 3 committed (the local record is
    // settled), step 4 never ran (no turn), so nothing woke the run and
    // `resolution_delivered_at` is still NULL.
    await h.storage((s) => resolveApprovalState(s, approvalId, "resolved", h.clock.value));
    expect(await resolutionTurns(h)).toHaveLength(0);
    expect((await h.stub.state())?.status).toBe("awaiting_approval");

    // The repair key the one-minute sweeper selects on. Asserted rather than
    // invoking `scheduled()`, because this pool's D1 is shared across files:
    // a real sweep would page in whichever undelivered rows other suites left
    // behind, which makes both the page contents and the sweeper's own
    // warning output depend on file order. What the sweeper does to THIS row
    // is re-invoke the RPC, which is the next line.
    const due = await listUndeliveredResolutions(env.DB, 50);
    expect(due.map((row) => row.id)).toContain(approvalId);

    expect(await h.stub.resolveApproval(input)).toEqual({ applied: true });

    // The run is genuinely back, and the finalize latch cannot re-park it.
    expect((await h.stub.state())?.status).toBe("live");
    expect(await resolutionTurns(h)).toHaveLength(1);
    expect((await deliveryOf(approvalId))?.resolution_delivered_at).not.toBeNull();

    await h.alarm();
    expect((await h.stub.state())?.status).not.toBe("awaiting_approval");
    expect((await h.storage((s) => readApprovalState(s, approvalId)))?.state).toBe("resolved");
    // Still one send: the delivery CAS does not care which step crashed.
    expect(sender.calls).toHaveLength(1);
  });

  it("cannot heal the MIRROR of that window, which is why the order is what it is", async () => {
    // The state the plan's order (turn first, settle second) leaves behind on
    // the same crash: a committed resolution turn beside a still-`open` local
    // record. Re-entry cannot repair it — `writeTurn` returns `appended:false`
    // for an id it already holds, so no input transaction runs, and this
    // method deliberately writes no status of its own. The run stays parked
    // until something unrelated wakes it.
    //
    // This case exists to keep that reasoning falsifiable. It is asserting
    // that `resolveApproval` NEVER writes a run status directly: "repair it
    // here" is the tempting fix, and it would let this method unpark a run
    // that is legitimately parked on a newer approval. The real fix is that
    // the current order makes this state unreachable.
    const { h, approvalId } = await parkedApproval();
    const input = {
      approvalId,
      decision: "approved" as const,
      outboundText: DRAFT,
      rejectReason: null,
      decidedBy: FIREFIGHTER,
    };

    // The turn, committed with the local record left open — i.e. exactly what
    // a crash after step 4 under the reversed order would leave.
    await h.stub.appendTurn({
      id: `approval:${approvalId}`,
      role: "user",
      source: "approval",
      content: "a resolution turn whose local record was never settled",
    });
    // The local record is untouched — `parkedApproval` left it `open` — and
    // the run is put back the way that generation's finalize would leave it.
    expect((await h.storage((s) => readApprovalState(s, approvalId)))?.state).toBe("open");
    await h.stub.setStatus("awaiting_approval");

    // Spied, not merely tolerated: this pair is the anomaly the method logs,
    // and asserting it keeps the suite's output clean at the same time.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await h.stub.resolveApproval(input)).toEqual({ applied: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("moved after its turn was committed");
    } finally {
      warn.mockRestore();
    }

    expect(await resolutionTurns(h)).toHaveLength(1);
    expect((await h.stub.state())?.status).toBe("awaiting_approval");
  });
});

/* ---------------------------------------------------- the wrong-run guard -- */

describe("a resolution addressed at the wrong run", () => {
  it("is refused by the owning object, and neither run is touched", async () => {
    const senderA = recordingSender();
    const senderB = recordingSender();
    const a = await parkedApproval({ sender: senderA });
    const b = await parkedApproval({ sender: senderB });

    // B's object, A's approval. Nothing but a caller bug produces this — the
    // notifier addresses the object by the run's own key — but the cost of
    // getting it wrong is one customer's approved text landing in another
    // customer's conversation.
    expect(
      await b.h.stub.resolveApproval({
        approvalId: a.approvalId,
        decision: "approved",
        outboundText: DRAFT,
        rejectReason: null,
        decidedBy: FIREFIGHTER,
      }),
    ).toEqual({ applied: false });

    expect(senderA.calls).toEqual([]);
    expect(senderB.calls).toEqual([]);
    expect(await resolutionTurns(b.h)).toHaveLength(0);
    expect(await resolutionTurns(a.h)).toHaveLength(0);
    expect((await b.h.stub.state())?.status).toBe("awaiting_approval");
    expect((await a.h.stub.state())?.status).toBe("awaiting_approval");
    // A's approval is untouched: still undelivered, still deliverable.
    expect(await deliveryOf(a.approvalId)).toMatchObject({
      delivery: "none",
      resolution_delivered_at: null,
    });
  });
});

/* ------------------------------------------- the remaining outcome sources -- */

describe("a run with no pinned Slack thread", () => {
  it("blocks on no_pinned_thread rather than guessing a destination", async () => {
    // `escalate` refuses to open an approval on a Chat run at all, so this is
    // unreachable today — but it is the branch that decides what happens when
    // the only trusted source of a destination is empty, and "guess" must
    // never be the answer.
    const sender = recordingSender();
    const h = await freshDriverRun({ continuation: null });
    installRunPorts({ approvalSender: sender }, { runKey: h.key });

    const approvalId = `apr:${crypto.randomUUID()}`;
    await h.storage((s) =>
      putApprovalState(s, {
        approvalId,
        generationId: "gen:no-thread",
        draft: DRAFT,
        why: WHY,
        now: h.clock.value,
      }),
    );
    expect(
      await insertApproval(env.DB, {
        id: approvalId,
        runId: h.runId,
        generationId: "gen:no-thread",
        draft: DRAFT,
        why: WHY,
        // The card's columns are NOT NULL, so it carries a destination even
        // though the run it belongs to has none. Precisely why the card is not
        // allowed to be the source of one.
        channelId: "CGHOSTCHANNEL",
        threadTs: "1720000000.000001",
        shadow: false,
        now: h.clock.value,
      }),
    ).toBe("created");
    await decideApproval(env.DB, approvalId, { action: "approve" }, FIREFIGHTER, h.clock.value);

    expect(
      await h.stub.resolveApproval({
        approvalId,
        decision: "approved",
        outboundText: DRAFT,
        rejectReason: null,
        decidedBy: FIREFIGHTER,
      }),
    ).toEqual({ applied: true });

    expect(sender.calls).toEqual([]);
    expect(await deliveryOf(approvalId)).toMatchObject({
      delivery: "blocked",
      delivery_error: "no_pinned_thread",
    });
    expect(await resolutionTurns(h)).toHaveLength(1);
  });
});

describe("a sender that throws", () => {
  it("is an unknown outcome, not a retry", async () => {
    // The one place a naive `catch` would double-post: a throw does not mean
    // the message failed to reach Slack. Reachable the moment Phase 13's real
    // sender lands.
    const sender: ApprovalSender & { calls: SendInput[] } = {
      calls: [],
      async send(sendInput) {
        this.calls.push(sendInput);
        throw new Error("socket hang up");
      },
    };
    const { h, approvalId } = await parkedApproval({ sender });

    await h.stub.resolveApproval({
      approvalId,
      decision: "approved",
      outboundText: DRAFT,
      rejectReason: null,
      decidedBy: FIREFIGHTER,
    });

    expect(sender.calls).toHaveLength(1);
    expect((await deliveryOf(approvalId))?.delivery).toBe("in_doubt");
    expect((await deliveryOf(approvalId))?.delivery_error).toContain("socket hang up");
    const resolution = await resolutionTurns(h);
    expect(resolution[0].content).toContain("unknown");
    expect((await h.stub.state())?.status).toBe("live");
  });
});

/* --------------------------------------------------- the production wiring */

describe("the production ResolutionNotifier", () => {
  beforeEach(() => {
    resetApprovalApiPorts();
  });

  it("carries a real PATCH into the owning RunDO", async () => {
    // The verifier is faked because signing a real Access JWT is
    // `access-jwt.test.ts`'s subject. The NOTIFIER deliberately is not: this
    // case fails if the wave-D wiring is missing, because an unwired notifier
    // and a dead DO are indistinguishable from the response alone — hence the
    // assertions on the DO's own state below.
    installApprovalApiPorts({ verifier: fakeVerifier() });
    const { h, approvalId } = await parkedApproval({ decide: false });

    const res = await SELF.fetch(`https://firefighter.test/api/approvals/${approvalId}`, {
      method: "PATCH",
      headers: {
        "Cf-Access-Jwt-Assertion": FIREFIGHTER,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "approve" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ approval: { decision: string }; resolutionDelivered: boolean }>();
    expect(body.approval.decision).toBe("approved");
    expect(body.resolutionDelivered).toBe(true);

    // The object itself, not just the response: the turn landed and the run
    // came back out of `awaiting_approval`.
    expect(await resolutionTurns(h)).toHaveLength(1);
    expect((await h.stub.state())?.status).toBe("live");
    expect((await deliveryOf(approvalId))?.delivery).toBe("blocked");
    expect((await deliveryOf(approvalId))?.resolution_delivered_at).not.toBeNull();
  });
});

/* ------------------------------------------------------------ the sender -- */

describe("makeIdentityRefusingSender", () => {
  it("refuses every send with identity_unavailable, whatever it is handed", async () => {
    const sender = makeIdentityRefusingSender();
    expect(
      await sender.send({
        runId: "run_1",
        channelId: CHANNEL,
        threadTs: "1720000000.000001",
        text: DRAFT,
      }),
    ).toEqual({ result: "blocked", reason: "identity_unavailable" });
  });
});
