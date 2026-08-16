import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessJwtError, type AccessIdentity, type AccessVerifier } from "../src/access/jwt";
import {
  approvalsApi,
  installApprovalApiPorts,
  resetApprovalApiPorts,
  sweepUndeliveredApprovals,
  APPROVAL_SWEEP_PAGE_SIZE,
  type ResolutionNotifier,
} from "../src/api/approvals";
import { runsApi } from "../src/api/runs";
import { NOT_CONNECTED } from "../src/approval/sender";
import {
  decideApproval,
  getApproval,
  insertApproval,
  listUndeliveredResolutions,
  recordNudgeMessage,
} from "../src/approval/repository";
import { upsertIdentity } from "../src/db/identities";
import { onDuty } from "../src/identity/rotation";
import type { Env } from "../src/index";
import type { RunAgent } from "../src/run/agent";
import { makeRunAgentResolutionNotifier } from "../src/run/agent-approvals";
import {
  createOrGetRun,
  createOrGetRunUnderPolicy,
  getRunByKey,
} from "../src/run/repository";

/**
 * THE APPROVAL PATH ON THE THINK CHASSIS.
 *
 * Every case here stands for a failure that is SILENT and lands in front of a
 * customer under a real engineer's name: a decision applied twice, an approved
 * message that is not the text the human typed, a send under the wrong
 * credential, a rejection whose reason never reaches memory, a card a browser
 * could decide without being on the roster.
 *
 * A FRESH key per case. Pool storage is shared across tests and files (no
 * `isolatedStorage`), so a reused key would carry another case's approvals and
 * another case's submissions.
 *
 * TWO HARNESS FACTS THAT SHAPE EVERY CASE BELOW, both measured rather than
 * assumed:
 *
 *  1. `RunAgent.resolveApproval` does NOT call `runTurn`. Re-entry is
 *     `schedule(0, "reenterAfterApproval")`, because calling `runTurn` from
 *     inside a DO RPC deadlocks even unawaited. So "the approval turn was
 *     appended exactly once" is asserted as "exactly one re-entry exists" —
 *     counted across the schedule row AND the durable submission it becomes,
 *     because the alarm may or may not have fired by the time a test looks.
 *     See `reentries()`.
 *  2. A Durable Object gets the POOL's env, never a test's spread. `RunAgent`
 *     builds its sender inline (`makeUserTokenSender(makeUserTokenSource(env))`)
 *     with no injectable port, so the delivery outcomes are driven through the
 *     only inputs the DO shares with the test: the D1 `runs` row, the
 *     `identities` table, and the global `fetch`.
 */

const FIREFIGHTER = "ronit@zellify.app";
const VIEWER = "marcus@zellify.app";
const OUTSIDER = "nobody@example.com";

const DRAFT = "We can have the export bug fixed by Friday.";
const EDITED = "We expect the export bug to be fixed early next week.";
const WHY = "it commits us to a date in front of the customer";

/* ------------------------------------------------------------- fixtures -- */

async function agentByKey(key: string) {
  return getAgentByName<Env, RunAgent>(env.RUN_AGENTS, key);
}

type AgentStub = Awaited<ReturnType<typeof agentByKey>>;

/** The three legacy tests at the bottom of this file: no `runs` row, on purpose. */
function agentFor() {
  return agentByKey(`chat:${crypto.randomUUID()}`);
}

type Run = {
  key: string;
  runId: string;
  channelId: string;
  threadTs: string;
  agent: AgentStub;
};

/**
 * A Slack run that the index can confirm: a `channels` policy row, a `runs`
 * row, and the agent that owns it.
 *
 * The policy row is not decoration — `resolveRunFacts` reads the customer slug
 * off it, and `deliver` reads `shadow` off the `runs` row. Both are host state
 * by construction here, which is the only way a test can prove the destination
 * was never guessed from the card.
 */
async function slackRun(options: { mode?: "live" | "observe"; shadow?: boolean } = {}): Promise<Run> {
  const channelId = `C${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
  const threadTs = `${Math.floor(Date.now() / 1000)}.${String(
    Math.floor(Math.random() * 1_000_000),
  ).padStart(6, "0")}`;
  const key = `slack:${channelId}:${threadTs}`;

  await env.DB.prepare(
    "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, 'acme', ?)",
  )
    .bind(channelId, `ext-${channelId.toLowerCase()}`, options.mode ?? "live")
    .run();

  const run = await createOrGetRunUnderPolicy(
    env.DB,
    { key, origin: "slack", channelId, threadTs },
    { mustShadow: options.shadow ?? false },
  );

  return { key, runId: run.id, channelId, threadTs, agent: await agentByKey(key) };
}

/** A chat run the index CAN confirm, and which therefore has no pinned thread. */
async function chatRun(): Promise<{ key: string; runId: string; agent: AgentStub }> {
  const key = `chat:${crypto.randomUUID()}`;
  const run = await createOrGetRun(env.DB, { key, origin: "chat", channelId: null, threadTs: null });
  return { key, runId: run.id, agent: await agentByKey(key) };
}

/** The header value IS the identity — the same fake every approval suite uses. */
function fakeVerifier(): AccessVerifier {
  return {
    async verify(jwt: string): Promise<AccessIdentity> {
      if (!jwt) throw new AccessJwtError("missing", "no token was supplied");
      if (!jwt.includes("@")) throw new AccessJwtError("malformed", "not an email-shaped fake token");
      return { email: jwt };
    },
  };
}

/** The deployment under test. `resolvePorts` reads it to pick the RunAgent notifier. */
const think: Env = { ...env, RUN_CHASSIS: "think" } as Env;

async function patch(id: string, body: unknown, token = FIREFIGHTER): Promise<Response> {
  return approvalsApi.fetch(
    new Request(`http://firefighter.test/approvals/${id}`, {
      method: "PATCH",
      headers: { "Cf-Access-Jwt-Assertion": token, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    think,
  );
}

/** The D1 card's delivery columns, which are not on `ApprovalRow`. */
type DeliveryRow = {
  decision: string;
  delivery: string;
  delivery_error: string | null;
  decided_by: string | null;
  resolution_delivered_at: number | null;
};

function cardOf(id: string): Promise<DeliveryRow | null> {
  return env.DB.prepare(
    `SELECT decision, delivery, delivery_error, decided_by, resolution_delivered_at
       FROM approvals WHERE id = ?`,
  )
    .bind(id)
    .first<DeliveryRow>();
}

/* -------------------------------------------------------------- probes -- */

type Reentry = { idempotencyKey: string; input: string | null };

/**
 * Every re-entry this agent holds for an approval, counted ONCE across both
 * places one can live.
 *
 * `resolveApproval` writes a schedule row and arms the alarm; when the alarm
 * fires, that row becomes a durable Think submission keyed on the same
 * `approval:{id}`. A test that looked at only one of the two would be asserting
 * on a race with the alarm rather than on the code — so this reads both and
 * de-duplicates by key. "Exactly one" here is the Think-chassis spelling of
 * "the resolution turn was appended exactly once".
 */
async function reentries(stub: AgentStub): Promise<Reentry[]> {
  return runInDurableObject(stub, async (agent: RunAgent) => {
    const schedules = agent.getSchedules() as unknown as Array<{
      callback: string;
      payload: unknown;
    }>;
    const scheduled: Reentry[] = schedules
      .filter((row) => row.callback === "reenterAfterApproval")
      .map((row) => {
        const payload = (
          typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload
        ) as { input?: string; idempotencyKey?: string };
        return { idempotencyKey: String(payload.idempotencyKey), input: payload.input ?? null };
      });

    const submitted: Reentry[] = (await agent.listSubmissions())
      .filter((row) => typeof row.idempotencyKey === "string" && row.idempotencyKey.startsWith("approval:"))
      .map((row) => ({ idempotencyKey: row.idempotencyKey as string, input: null }));

    const seen = new Set<string>();
    return [...scheduled, ...submitted].filter((entry) => {
      if (seen.has(entry.idempotencyKey)) return false;
      seen.add(entry.idempotencyKey);
      return true;
    });
  });
}

/**
 * EVERY row of EVERY table in the agent's own SQLite, as one string.
 *
 * Derived from `sqlite_master` rather than from a list of table names, so a
 * leak into a table Think adds next release is caught by a test written this
 * release. `exclude` is how the model-visible half is separated from the
 * host-only half: `approvals` legitimately stores the decider's email, and the
 * point of the `decidedBy` case is that nothing the model reads does.
 */
async function localDump(stub: AgentStub, exclude: string[] = []): Promise<string> {
  return runInDurableObject(stub, (_agent: RunAgent, state: DurableObjectState) => {
    const names = state.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((row) => row.name)
      .filter((name) => !name.startsWith("_cf") && !name.startsWith("sqlite_"))
      .filter((name) => !exclude.includes(name));
    const out: Record<string, unknown[]> = {};
    for (const name of names) {
      try {
        out[name] = state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray();
      } catch {
        out[name] = ["<unreadable>"];
      }
    }
    return JSON.stringify(out);
  });
}

/** Every Slack request made while `body` ran, in the same isolate as the DO. */
type SlackCall = { url: string; body: Record<string, unknown>; authorization: string | null };

async function recordingSlack<T>(
  answer: Record<string, unknown>,
  body: (calls: SlackCall[]) => Promise<T>,
): Promise<{ calls: SlackCall[]; value: T }> {
  const calls: SlackCall[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      authorization: new Headers(init.headers).get("authorization"),
    });
    return new Response(JSON.stringify(answer), { status: 200 });
  });
  try {
    return { calls, value: await body(calls) };
  } finally {
    vi.unstubAllGlobals();
  }
}

/** Run model-authored code through the real `run_code` isolate, flattened. */
async function program(stub: AgentStub, code: string): Promise<string> {
  const out = await stub.executeForTest(code);
  return out.status === "error"
    ? out.error
    : JSON.stringify((out as unknown as { result: unknown }).result);
}

/* ---------------------------------------------------------------- setup -- */

beforeEach(() => {
  resetApprovalApiPorts();
  installApprovalApiPorts({ verifier: fakeVerifier() });
});

afterEach(() => {
  resetApprovalApiPorts();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ============================================================== escalate = */

describe("escalate", () => {
  it("returns before any human has decided, and the dashboard card is already there", async () => {
    const run = await slackRun();
    const { approvalId } = await run.agent.escalate({ draft: DRAFT, why: WHY });

    // THE LOCAL ROW IS THE ONE THE RUN ACTS ON, and it is committed
    // synchronously — the call returns without waiting on a human, on D1, or on
    // Slack, because a capability that blocked here would hold a model's turn
    // open for however long an engineer takes to read their DMs.
    const [local] = await run.agent.pendingApprovalsForRun();
    expect(local).toMatchObject({
      id: approvalId,
      runId: run.runId,
      draft: DRAFT,
      why: WHY,
      decision: "pending",
      delivery: "none",
      decidedBy: null,
    });

    // ...and the card a human can actually act on reached D1 in the same call.
    // Ordering matters and is asserted by consequence: the nudge can only ever
    // point at a card the dashboard already has.
    expect(await getApproval(env.DB, approvalId)).toMatchObject({
      runId: run.runId,
      draft: DRAFT,
      why: WHY,
      decision: "pending",
      delivery: "none",
      shadow: false,
    });
  });

  /**
   * KNOWN OPEN GAP — the finalize latch does not exist on this chassis.
   *
   * Nothing in `src/run/agent.ts` or `src/run/agent-projection.ts` ever writes
   * `awaiting_approval`: `onStepFinish` projects `live` unconditionally, and
   * `#openApprovalId` is read by the capability's one-open-slot check and by
   * nothing else. So a run parked on a human decision is indistinguishable, in
   * D1 and therefore on the dashboard, from a run that is still working.
   *
   * See TEST-FINDINGS.md.
   */
  it.fails("projects awaiting_approval while a decision is outstanding", async () => {
    const run = await slackRun();
    await run.agent.escalate({ draft: DRAFT, why: WHY });

    expect((await getRunByKey(env.DB, run.key))?.status).toBe("awaiting_approval");
  });

  it("refuses a second escalate by name rather than queueing it silently", async () => {
    const run = await slackRun();

    // Both escalates in ONE model program, through the real isolate and the
    // real capability, because the refusal is host-side and pre-upstream: a
    // second open card is a second thing a human is asked to decide about a
    // conversation that has only one open question.
    const result = await program(
      run.agent,
      `async () => {
        const first = await approval.escalate({ draft: ${JSON.stringify(DRAFT)}, why: ${JSON.stringify(WHY)} });
        try {
          await approval.escalate({ draft: "and another thing", why: "second card" });
          return { first, second: "NOT REFUSED" };
        } catch (err) {
          return { first, second: String(err.message) };
        }
      }`,
    );

    expect(result).toContain("approval_already_open");
    expect(result).not.toContain("NOT REFUSED");
    // Refused, not queued: one open approval, not two waiting in a line.
    expect(await run.agent.pendingApprovalsForRun()).toHaveLength(1);
  });
});

/* ============================================================== withdraw = */

/**
 * KNOWN OPEN GAP — `RunAgent`'s `ApprovalPort.withdraw()` is a stub.
 *
 * It returns `{ withdrawn: false, decision: "rejected" }` unconditionally,
 * touching neither the local table, nor the D1 card, nor the nudge. The comment
 * on it in `src/run/agent.ts` says so and names Task 9. All three cases below
 * are therefore `it.fails`, and they are not one case: the first is a
 * retraction that never happens, the second is a LIE to the model about what a
 * human chose (it says "rejected" for a card the human approved), and the third
 * is a card that stays decidable after the model believed it was pulled.
 *
 * See TEST-FINDINGS.md.
 */
describe("withdraw", () => {
  it.fails("retracts the open approval and frees the one open slot", async () => {
    const run = await slackRun();

    const result = await program(
      run.agent,
      `async () => {
        await approval.escalate({ draft: ${JSON.stringify(DRAFT)}, why: ${JSON.stringify(WHY)} });
        const withdrawn = await approval.withdraw();
        const reopened = await approval.escalate({ draft: "the fix slipped to Monday", why: "the date changed" });
        return { withdrawn, reopened };
      }`,
    );

    expect(result).toContain('"withdrawn":true');
    expect(result).toContain('"state":"pending"');
  });

  it.fails("hands the model the human's ACTUAL decision when the human won the race", async () => {
    const run = await slackRun();
    const { approvalId } = await run.agent.escalate({ draft: DRAFT, why: WHY });
    await run.agent.resolveApproval({
      approvalId,
      decision: { action: "approve" },
      decidedBy: FIREFIGHTER,
      decidedAt: 1_700_000_000_000,
    });

    // The stub answers `"rejected"` here whatever the human chose, so a model
    // that withdrew after an APPROVAL is told its draft was refused — and the
    // next thing it says to the customer is built on that.
    const result = await program(run.agent, `async () => await approval.withdraw()`);
    expect(result).toBe('{"withdrawn":false,"decision":"approved"}');
  });

  it.fails("409s a human decision that lands after the model withdrew", async () => {
    const run = await slackRun();
    await program(
      run.agent,
      `async () => {
        await approval.escalate({ draft: ${JSON.stringify(DRAFT)}, why: ${JSON.stringify(WHY)} });
        return await approval.withdraw();
      }`,
    );
    const [open] = await run.agent.pendingApprovalsForRun({ includeResolved: true });

    const res = await patch(open!.id, { action: "approve" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "already_decided", decision: "withdrawn" });
  });
});

/* ============================================================ resolution = */

describe("a human decision", () => {
  it("commits the CAS and schedules exactly one re-entry under the approval's own key", async () => {
    const run = await slackRun();
    const { approvalId } = await run.agent.escalate({ draft: DRAFT, why: WHY });

    const outcome = await run.agent.resolveApproval({
      approvalId,
      decision: { action: "approve" },
      decidedBy: FIREFIGHTER,
      decidedAt: 1_700_000_000_000,
    });
    expect(outcome.status).toBe("resolved");

    // The re-entry is SCHEDULED, not called: `runTurn` from inside this RPC
    // deadlocks. The key is the approval's own id, which is what makes a
    // redelivered decision `accepted: false` instead of a second turn.
    const entries = await reentries(run.agent);
    expect(entries).toHaveLength(1);
    expect(entries[0].idempotencyKey).toBe(`approval:${approvalId}`);
  });

  it("adds no second re-entry when the same decision is redelivered", async () => {
    const run = await slackRun();
    const { approvalId } = await run.agent.escalate({ draft: DRAFT, why: WHY });
    const input = {
      approvalId,
      decision: { action: "approve" } as const,
      decidedBy: FIREFIGHTER,
      decidedAt: 1_700_000_000_000,
    };

    expect((await run.agent.resolveApproval(input)).status).toBe("resolved");
    // The retried PATCH, the second dashboard tab and the one-minute sweeper
    // all arrive here. A second re-entry is a second answer to one decision.
    expect((await run.agent.resolveApproval(input)).status).toBe("already_resolved");
    expect((await run.agent.resolveApproval(input)).status).toBe("already_resolved");

    const entries = await reentries(run.agent);
    expect(entries).toHaveLength(1);
    expect(entries[0].idempotencyKey).toBe(`approval:${approvalId}`);
  });

  it("keeps the decider's name out of everything the model can read", async () => {
    const run = await slackRun();
    const { approvalId } = await run.agent.escalate({ draft: DRAFT, why: WHY });

    await run.agent.resolveApproval({
      approvalId,
      decision: { action: "reject", reason: "we have not agreed that date" },
      decidedBy: FIREFIGHTER,
      decidedAt: 1_700_000_000_000,
    });

    // POSITIVE CONTROL FIRST. Without it every assertion below would pass just
    // as happily against a system that never recorded the decider at all.
    const [record] = await run.agent.pendingApprovalsForRun({ includeResolved: true });
    expect(record?.decidedBy).toBe(FIREFIGHTER);

    // Now the absence, over every local table EXCEPT the host-owned approval
    // row: the re-entry payload, the submission, the transcript. Invariant 12 —
    // which engineer clicked is not the model's business, and a name in the
    // transcript is a name the model can quote back to the customer.
    const visible = await localDump(run.agent, ["approvals"]);
    expect(visible).not.toContain(FIREFIGHTER);
    // ...and the reason DID travel, or the sweep above proves only that the
    // resolution never arrived.
    expect(visible).toContain("we have not agreed that date");
  });

  it("refuses a decision addressed at the wrong run, and touches neither", async () => {
    const a = await slackRun();
    const b = await slackRun();
    const opened = await a.agent.escalate({ draft: DRAFT, why: WHY });

    // B's object, A's approval. Only a caller bug produces this — the notifier
    // addresses the object by the run's own key — but the cost of getting it
    // wrong is one customer's approved text landing in another's conversation.
    const outcome = await b.agent.resolveApproval({
      approvalId: opened.approvalId,
      decision: { action: "approve" },
      decidedBy: FIREFIGHTER,
      decidedAt: 1_700_000_000_000,
    });
    expect(outcome.status).toBe("not_found");

    expect(await reentries(b.agent)).toEqual([]);
    expect(await reentries(a.agent)).toEqual([]);
    // A's approval is untouched: still pending, still decidable.
    expect((await a.agent.pendingApprovalsForRun())[0]).toMatchObject({
      id: opened.approvalId,
      decision: "pending",
      delivery: "none",
    });
  });
});

/* ============================================================== delivery = */

describe("delivery", () => {
  /**
   * The on-duty engineer's `identities` row decides everything in this block,
   * and this pool's D1 is shared across files — so each case sets the row it
   * needs and clears it afterwards, the same discipline
   * `test/user-token-sender.test.ts` documents. Only the on-duty engineer's
   * Slack row is touched; other suites' rows are left alone.
   */
  const onDutyEmail = () => onDuty(Date.now()).email;

  async function clearOnDutySlack(): Promise<void> {
    await env.DB.prepare("DELETE FROM identities WHERE email = ? AND provider = 'slack'")
      .bind(onDutyEmail())
      .run();
  }

  beforeEach(clearOnDutySlack);
  afterEach(clearOnDutySlack);

  it("blocks honestly, and calls nothing, when nobody on duty has connected Slack", async () => {
    // `SLACK_BOT_TOKEN` is present and usable in this pool, which is exactly why
    // this matters: refusing has to be a decision, not a missing credential.
    // Customer-facing speech carries a human's name or is not sent at all.
    expect(env.SLACK_BOT_TOKEN).toBeTruthy();
    const run = await slackRun();
    const { approvalId } = await run.agent.escalate({ draft: DRAFT, why: WHY });

    const { calls } = await recordingSlack({ ok: true, ts: "1720000000.000100" }, async () => {
      const res = await patch(approvalId, { action: "approve" });
      expect(res.status).toBe(200);
    });

    expect(calls.filter((call) => call.url.endsWith("/chat.postMessage"))).toEqual([]);
    expect(await cardOf(approvalId)).toMatchObject({
      decision: "approved",
      delivery: "blocked",
      delivery_error: NOT_CONNECTED,
    });
    // Terminal, and the run STILL comes back: a decision is a fact the moment a
    // human makes it, and delivery is a separate state machine.
    expect(await reentries(run.agent)).toHaveLength(1);
  });

  it("never calls Slack at all for a shadow run, and can only record suppressed", async () => {
    const run = await slackRun({ mode: "observe", shadow: true });
    const { approvalId } = await run.agent.escalate({ draft: DRAFT, why: WHY });

    // The card is honestly labelled before anyone decides, so a human reading
    // the queue knows this one can never go out.
    expect(await getApproval(env.DB, approvalId)).toMatchObject({ shadow: true, decision: "pending" });

    const { calls } = await recordingSlack({ ok: true, ts: "1720000000.000101" }, async () => {
      const res = await patch(approvalId, { action: "approve" });
      expect(res.status).toBe(200);
    });

    // NEVER CALLED, not merely "ended up suppressed": only the first of those
    // says a shadow run cannot speak to a customer.
    expect(calls.filter((call) => call.url.endsWith("/chat.postMessage"))).toEqual([]);
    expect(await cardOf(approvalId)).toMatchObject({ delivery: "suppressed", delivery_error: null });
    expect(await reentries(run.agent)).toHaveLength(1);
  });

  it("treats a thrown sender as an unknown outcome rather than a retry", async () => {
    // A row that will not open — a tampered ciphertext or a mis-rotated
    // `IDENTITY_KEY` — throws `SealError` straight through the sender. The one
    // place a naive `catch` would double-post: a throw does not mean the
    // message failed to reach Slack, and a duplicate customer message cannot be
    // taken back.
    await upsertIdentity(
      env.DB,
      {
        email: onDutyEmail(),
        provider: "slack",
        externalId: "U0NDUTY",
        scopes: "chat:write",
        tokenCiphertext: "not-a-sealed-value",
        connectedAt: 1000,
      },
      1000,
    );

    const run = await slackRun();
    const { approvalId } = await run.agent.escalate({ draft: DRAFT, why: WHY });

    const res = await patch(approvalId, { action: "approve" });
    expect(res.status).toBe(200);

    expect(await cardOf(approvalId)).toMatchObject({ delivery: "in_doubt" });
    // A second decision does not re-attempt it: the CAS refuses before the
    // delivery sub-machine is reached at all.
    expect((await patch(approvalId, { action: "approve" })).status).toBe(409);
    expect(await cardOf(approvalId)).toMatchObject({ delivery: "in_doubt" });
    expect(await reentries(run.agent)).toHaveLength(1);
  });

  it("takes the destination from run state, and refuses when there is none", async () => {
    // The card's columns are NOT NULL, so it always carries a channel and a
    // thread — here, deliberately, ones the run does not own. The run itself is
    // a chat run with no pinned thread, so the only honest answer is to refuse.
    // A delivery that trusted the card's snapshot would post into CGHOSTCHANNEL.
    const run = await chatRun();
    const { approvalId } = await run.agent.escalate({ draft: DRAFT, why: WHY });
    expect(
      await insertApproval(env.DB, {
        id: approvalId,
        runId: run.runId,
        generationId: approvalId,
        draft: DRAFT,
        why: WHY,
        channelId: "CGHOSTCHANNEL",
        threadTs: "1720000000.000001",
        shadow: false,
        now: Date.now(),
      }),
    ).toBe("created");

    const { calls } = await recordingSlack({ ok: true, ts: "1720000000.000102" }, async () => {
      const res = await patch(approvalId, { action: "approve" });
      expect(res.status).toBe(200);
    });

    expect(calls).toEqual([]);
    expect(await cardOf(approvalId)).toMatchObject({
      delivery: "blocked",
      delivery_error: "no_pinned_thread",
    });
  });

  /**
   * NOT REACHABLE ON THIS CHASSIS TODAY, and the reason is a `src/` gap rather
   * than a harness one.
   *
   * `deliver()` in `src/run/agent-approvals.ts` composes its sender inline —
   * `makeUserTokenSender(makeUserTokenSource(env))` — with no port to override,
   * where the legacy chassis has `installRunPorts({ approvalSender })`. Reaching
   * `sent` therefore needs a decryptable on-duty token inside the Durable
   * Object, which needs `IDENTITY_KEY` bound in the POOL env; it is not, and a
   * test that depended on the developer's `.dev.vars` would pass here and fail
   * on a fresh checkout.
   *
   * So the single most important assertion in this file — that the approved
   * text goes out under the ENGINEER'S user token and never the bot's, byte
   * exact, into the run's own pinned thread — has no home on the Think chassis.
   * See TEST-FINDINGS.md; the assertions are written out so they can be
   * un-skipped the moment a sender seam exists.
   */
  it.skip("sends the edited text, byte exact, under the on-duty engineer's own token", async () => {
    const run = await slackRun();
    const { approvalId } = await run.agent.escalate({ draft: DRAFT, why: WHY });

    const { calls } = await recordingSlack({ ok: true, ts: "1720000000.000500" }, async () => {
      expect((await patch(approvalId, { action: "edit", text: EDITED })).status).toBe(200);
    });

    const posts = calls.filter((call) => call.url === "https://slack.com/api/chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0].authorization).not.toBe(`Bearer ${env.SLACK_BOT_TOKEN}`);
    expect(posts[0].body).toEqual({
      channel: run.channelId,
      thread_ts: run.threadTs,
      text: EDITED,
    });
    expect(await cardOf(approvalId)).toMatchObject({ delivery: "sent" });
  });
});

/* ============================================================= rejection = */

describe("a rejected reply", () => {
  it("attempts no send, and files the reason in the memory outbox", async () => {
    const run = await slackRun();
    const { approvalId } = await run.agent.escalate({ draft: DRAFT, why: WHY });
    const reason = "we have not agreed that date internally";

    const { calls } = await recordingSlack({ ok: true, ts: "1720000000.000103" }, async () => {
      const res = await patch(approvalId, { action: "reject", reason });
      expect(res.status).toBe(200);
    });

    expect(calls.filter((call) => call.url.endsWith("/chat.postMessage"))).toEqual([]);
    // Nothing was sent, so the delivery sub-machine never ran at all.
    const [record] = await run.agent.pendingApprovalsForRun({ includeResolved: true });
    expect(record).toMatchObject({ decision: "rejected", delivery: "none", rejectReason: reason });

    // A rejection is the most valuable thing this system learns, so it reaches
    // memory even though nothing was sent — through the D1 outbox, which the
    // one-minute sweep drains whether or not the queue send landed.
    const outbox = await env.DB.prepare(
      "SELECT id, run_id, generation_id, episode_json FROM agent_memory_outbox WHERE id = ?",
    )
      .bind(`memory:${run.runId}:approval:${approvalId}`)
      .first<{ id: string; run_id: string; generation_id: string; episode_json: string }>();
    expect(outbox).not.toBeNull();
    expect(outbox?.run_id).toBe(run.runId);
    expect(outbox?.episode_json).toContain(reason);
    // The reason travels; the decider does not (invariant 12 reaches memory too).
    expect(outbox?.episode_json).not.toContain(FIREFIGHTER);

    expect(await reentries(run.agent)).toHaveLength(1);
  });
});

/* ================================================================= nudge = */

describe("the engineer's nudge DM", () => {
  it("is rewritten once the card is decided, so no dead Review button outlives it", async () => {
    // `updateNudge` is unit-tested in `notify-nudge.test.ts`; what this proves
    // is the WIRING — that the Think chassis's resolution actually calls it,
    // with the row that carries the decision. Every other case in this file
    // resolves a card with no recorded nudge message, where `updateNudge`
    // returns before it does anything, so without this one the call could be
    // deleted and the file would stay green.
    const NUDGE_CHANNEL = "D0THINKRESOLVED";
    const NUDGE_TS = "1723640000.000800";
    const run = await slackRun();
    const { approvalId } = await run.agent.escalate({ draft: DRAFT, why: WHY });
    await recordNudgeMessage(env.DB, approvalId, NUDGE_CHANNEL, NUDGE_TS);

    const { calls } = await recordingSlack({ ok: true, ts: NUDGE_TS }, async () => {
      expect((await patch(approvalId, { action: "approve" })).status).toBe(200);
    });

    const updates = calls.filter((call) => call.url === "https://slack.com/api/chat.update");
    expect(updates).toHaveLength(1);
    expect(updates[0].body.channel).toBe(NUDGE_CHANNEL);
    expect(updates[0].body.ts).toBe(NUDGE_TS);
    expect(JSON.stringify(updates[0].body.blocks)).toContain(`Approved by ${FIREFIGHTER}`);
    // The BOT's own message, edited with the BOT's token — a bot cannot edit a
    // message it did not author. The customer-facing send uses the engineer's
    // user token, and these two credentials must never be confused.
    expect(updates[0].authorization).toBe(`Bearer ${env.SLACK_BOT_TOKEN}`);
  });
});

/* =============================================================== repairs = */

describe("a resolution D1 decided but never delivered", () => {
  it("is repaired by the real sweeper into exactly one re-entry", async () => {
    const run = await slackRun();
    const { approvalId } = await run.agent.escalate({ draft: DRAFT, why: WHY });

    // The PATCH's own notify never happened — the worker died between the CAS
    // and the RPC — so the decision is committed in D1 with the repair key
    // still NULL. Written through the repository rather than the route for
    // exactly that reason: the route always notifies.
    expect(
      (await decideApproval(env.DB, approvalId, { action: "approve" }, FIREFIGHTER, 1)).result,
    ).toBe("decided");
    expect(await reentries(run.agent)).toEqual([]);

    // `decided_at = 1` puts this row first in `ORDER BY decided_at ASC`, so it
    // is inside the sweeper's one page no matter what other suites left
    // undelivered in this shared D1. Asserted, not hoped for.
    const due = await listUndeliveredResolutions(env.DB, APPROVAL_SWEEP_PAGE_SIZE);
    expect(due[0]?.id).toBe(approvalId);

    // The REAL sweeper over the REAL Think notifier, scoped to this row: a
    // sweep that notified another suite's run would mutate state this file does
    // not own, and the wiring being proved is the same either way.
    const real = makeRunAgentResolutionNotifier(think);
    const scoped: ResolutionNotifier = {
      notify: async (input) =>
        input.approvalId === approvalId ? real.notify(input) : { applied: false },
    };
    installApprovalApiPorts({ notifier: scoped });

    const swept = await sweepUndeliveredApprovals(think);
    expect(swept.delivered).toBeGreaterThanOrEqual(1);

    expect(await reentries(run.agent)).toHaveLength(1);
    expect((await cardOf(approvalId))?.resolution_delivered_at).not.toBeNull();

    // A SECOND SWEEP IS NOT A SECOND RESOLUTION. The row is no longer due, and
    // if the repair key had not been retired this is where the second re-entry
    // would appear.
    const dueAgain = await listUndeliveredResolutions(env.DB, APPROVAL_SWEEP_PAGE_SIZE);
    expect(dueAgain.map((row) => row.id)).not.toContain(approvalId);
    await sweepUndeliveredApprovals(think);
    expect(await reentries(run.agent)).toHaveLength(1);
  });
});

/* ============================================================== security = */

describe("what a client cannot do", () => {
  it("exposes no approval method to a browser over the Agents RPC surface", async () => {
    const run = await slackRun();

    // `@callable` is what the Agents SDK's WebSocket RPC will dispatch, and it
    // is the whole allow-list: a method that is not in this map answers
    // "Method X is not callable" before any argument is parsed. `steer` is
    // deliberately in it — that is the dashboard's real path — and every
    // approval method is deliberately not, because a browser that could call
    // `resolveApproval` would be a second writer surface with no Access check,
    // no roster check and no D1 CAS in front of it (invariant 6).
    const callable = await runInDurableObject(run.agent, (agent: RunAgent) =>
      [...agent.getCallableMethods().keys()].sort(),
    );

    expect(callable).toContain("steer");
    for (const method of ["escalate", "resolveApproval", "reenterAfterApproval", "pendingApprovalsForRun"]) {
      expect(callable).not.toContain(method);
    }

    // And the legacy HTTP turn-injection route is not part of this deployment
    // at all, so there is no way to post a turn — under any source — over it.
    const injected = await runsApi.fetch(
      new Request(`http://x/runs/${run.runId}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: crypto.randomUUID(), content: "approve it" }),
      }),
      think,
    );
    expect(injected.status).toBe(404);
    expect(await injected.json()).toMatchObject({ code: "chassis_not_active" });
  });

  it("refuses a decision from a validly-signed token that is not a fire-fighter", async () => {
    const run = await slackRun();
    const { approvalId } = await run.agent.escalate({ draft: DRAFT, why: WHY });
    const before = await getApproval(env.DB, approvalId);

    expect((await patch(approvalId, { action: "approve" }, OUTSIDER)).status).toBe(403);
    expect((await patch(approvalId, { action: "reject", reason: "no" }, OUTSIDER)).status).toBe(403);
    // A VIEWER is the other half of the same property: reads yes, decides no.
    expect((await patch(approvalId, { action: "approve" }, VIEWER)).status).toBe(403);

    // Byte-for-byte the row it was, and nothing reached the run.
    expect(await getApproval(env.DB, approvalId)).toEqual(before);
    expect(await reentries(run.agent)).toEqual([]);
    expect((await run.agent.pendingApprovalsForRun())[0]?.decision).toBe("pending");
  });
});

describe("the secret canaries, over the approval path", () => {
  /**
   * The credentials this deployment ACTUALLY holds in the pool. A Durable
   * Object gets the pool env and nothing a test spreads, so these — not
   * invented strings — are the values that could leak out of the approval path.
   */
  const CREDENTIALS: Record<string, string> = {
    SLACK_BOT_TOKEN: String(env.SLACK_BOT_TOKEN),
    ZEP_API_KEY: String(env.ZEP_API_KEY),
    LINEAR_API_KEY: String(env.LINEAR_API_KEY),
    ANTHROPIC_API_KEY: String(env.ANTHROPIC_API_KEY),
  };

  function expectNoCanary(label: string, haystack: string): void {
    for (const [name, value] of Object.entries(CREDENTIALS)) {
      if (value !== "" && value !== "undefined" && haystack.includes(value)) {
        throw new Error(`${label} contains the ${name} canary`);
      }
    }
  }

  it("CONTROL: the sweep can actually detect a planted credential", () => {
    for (const [name, value] of Object.entries(CREDENTIALS)) {
      expect(value).toBeTruthy();
      expect(() => expectNoCanary("a planted string", `before ${value} after`)).toThrow(name);
    }
    expect(() => expectNoCanary("a clean string", "nothing to find here")).not.toThrow();
  });

  it("finds none of them in the approval row, the card, the local tables or a log line", async () => {
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(
          args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
        );
      });
    }

    const run = await slackRun();
    const { approvalId } = await run.agent.escalate({ draft: DRAFT, why: WHY });
    const res = await patch(approvalId, { action: "edit", text: EDITED });
    expect(res.status).toBe(200);
    expectNoCanary("the PATCH response", await res.text());

    const card = await env.DB.prepare("SELECT * FROM approvals WHERE id = ?").bind(approvalId).all();
    expectNoCanary("the D1 approvals row", JSON.stringify(card.results));
    const runRow = await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(run.runId).all();
    expectNoCanary("the D1 runs row", JSON.stringify(runRow.results));

    // Every table in the agent's own SQLite, derived from `sqlite_master`: the
    // approval row, the schedule payload, the submission, the transcript.
    expectNoCanary("every local table", await localDump(run.agent));
    expectNoCanary("a log line", logged.join("\n"));

    // The path really ran, or the sweep above proves nothing.
    expect((await run.agent.pendingApprovalsForRun({ includeResolved: true }))[0]?.editedText).toBe(
      EDITED,
    );
  });
});

/* ============================================== the original three cases = */

/**
 * Nothing in this block seeds a D1 `runs` row on purpose: the card projection,
 * the send and the memory outbox all resolve the run through D1 and correctly
 * do nothing when it is absent. That is what makes "did not send twice"
 * observable — the delivery column records the send attempt either way, and a
 * run this pool cannot index can never reach Slack from a test.
 */
describe("RunAgent approvals", () => {
  it("applies an approval exactly once and reports the loser its decision", async () => {
    const agent = await agentFor();
    const { approvalId } = await agent.escalate({
      draft: "We shipped the fix.",
      why: "closes the thread",
    });

    const first = await agent.resolveApproval({
      approvalId,
      decision: { action: "approve" },
      decidedBy: "engineer@zellify.com",
      decidedAt: 1_700_000_000_000,
    });
    expect(first.status).toBe("resolved");

    // THE CAS. A retried PATCH, a second dashboard tab and the one-minute
    // repair sweep all arrive here, and the second one through must learn what
    // the first decided rather than re-run the send.
    const second = await agent.resolveApproval({
      approvalId,
      decision: { action: "approve" },
      decidedBy: "someone.else@zellify.com",
      decidedAt: 1_700_000_009_000,
    });
    expect(second.status).toBe("already_resolved");

    // The first decision stands whole: the decider, the instant and the
    // delivery outcome are all the first caller's, so nothing about the second
    // call reached the customer or the record.
    if (second.status !== "already_resolved") throw new Error("unreachable");
    expect(second.approval.decidedBy).toBe("engineer@zellify.com");
    expect(second.approval.decidedAt).toBe(1_700_000_000_000);
    expect(second.approval.decision).toBe("approved");

    const [record] = await agent.pendingApprovalsForRun({ includeResolved: true });
    expect(record?.decidedBy).toBe("engineer@zellify.com");
    // One send attempt, settled once: a second delivery would have moved this
    // to `in_doubt` through the `none -> sending` guard.
    expect(record?.delivery).toBe("blocked");
    expect(await agent.pendingApprovalsForRun()).toEqual([]);
  });

  it("sends the edited text, not the draft, and keeps both", async () => {
    const agent = await agentFor();
    const { approvalId } = await agent.escalate({
      draft: "Original draft. We will have this out by Friday.",
      why: "closes the thread",
    });

    const outcome = await agent.resolveApproval({
      approvalId,
      decision: { action: "edit", text: "Edited by the engineer. No date promised." },
      decidedBy: "engineer@zellify.com",
      decidedAt: 1_700_000_000_000,
    });

    expect(outcome.status).toBe("resolved");
    if (outcome.status !== "resolved") throw new Error("unreachable");
    // The edit is the ONLY version that may ever go out, and the draft survives
    // beside it — never instead of it — so memory can learn what was superseded.
    expect(outcome.approval.decision).toBe("edited");
    expect(outcome.approval.editedText).toBe("Edited by the engineer. No date promised.");
    expect(outcome.approval.draft).toBe("Original draft. We will have this out by Friday.");
  });

  it("keeps the rejection reason", async () => {
    const agent = await agentFor();
    const { approvalId } = await agent.escalate({
      draft: "Too promisey.",
      why: "closes the thread",
    });

    const outcome = await agent.resolveApproval({
      approvalId,
      decision: { action: "reject", reason: "overpromises a date" },
      decidedBy: "engineer@zellify.com",
      decidedAt: 1_700_000_000_000,
    });

    expect(outcome.status).toBe("resolved");
    if (outcome.status !== "resolved") throw new Error("unreachable");
    expect(outcome.approval.decision).toBe("rejected");
    expect(outcome.approval.rejectReason).toBe("overpromises a date");
    // Nothing was sent, so the delivery sub-machine never ran at all.
    expect(outcome.approval.delivery).toBe("none");

    const [record] = await agent.pendingApprovalsForRun({ includeResolved: true });
    expect(record?.rejectReason).toBe("overpromises a date");
  });
});
