import { createScheduledController, env, SELF } from "cloudflare:test";
import { getAgentByName } from "agents";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AccessIdentity,
  AccessJwtError,
  type AccessVerifier,
} from "../../src/access/jwt";
import {
  installApprovalApiPorts,
  type ResolutionNotifier,
  resetApprovalApiPorts,
} from "../../src/api/approvals";
import {
  installIdentityApiPorts,
  resetIdentityApiPorts,
} from "../../src/api/identity";
import {
  insertApproval,
  type NewApprovalCard,
  setDelivery,
} from "../../src/approval/repository";
import worker from "../../src/index";

/**
 * Real D1 through the workerd vitest pool, no `isolatedStorage` — same
 * discipline as `test/approval-repository.test.ts` and `test/run-api.test.ts`.
 * Every case mints its own run/approval ids; `approvals` and `runs` are wiped
 * in `beforeEach` because a couple of assertions (the sweeper cases) check
 * exact membership.
 */

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM approvals").run();
  await env.DB.prepare("DELETE FROM runs").run();
  resetApprovalApiPorts();
});

/* ------------------------------------------------------------- fixtures */

/**
 * A verifier that treats the raw header value AS the identity: no signing,
 * no JWKS, no network. `""` and `"garbage"` both fail, one as `missing` and
 * one as `malformed`, so a test can exercise both the no-token and
 * bad-token halves of `401 access_jwt_invalid` without touching real crypto
 * — that path is `test/access-jwt.test.ts`'s job, not this file's.
 */
function fakeVerifier(): AccessVerifier {
  return {
    async verify(jwt: string): Promise<AccessIdentity> {
      if (!jwt) throw new AccessJwtError("missing", "no token was supplied");
      if (!jwt.includes("@"))
        throw new AccessJwtError("malformed", "not an email-shaped fake token");
      return { email: jwt };
    },
  };
}

type NotifyCall = Parameters<ResolutionNotifier["notify"]>[0];

/** Records every call and always reports success. */
function recordingNotifier(): ResolutionNotifier & { calls: NotifyCall[] } {
  const calls: NotifyCall[] = [];
  return {
    calls,
    async notify(input) {
      calls.push(input);
      return { applied: true };
    },
  };
}

/**
 * Records every call, reports success, and — as its side effect — moves
 * `delivery` in D1 exactly like the real DO does inside `resolveApproval` ->
 * `#deliverApproval` before `notify` returns. No real DO exists in this
 * file's fixtures, so a fake that never touches `delivery` would make the
 * PATCH handler's pre-notify and post-notify reads indistinguishable — which
 * is exactly the bug this fixture exists to make visible.
 */
function notifierThatDelivers(
  to: "blocked" | "sent" | "in_doubt" = "blocked",
  error: string | null = "identity_unavailable"
): ResolutionNotifier & { calls: NotifyCall[] } {
  const calls: NotifyCall[] = [];
  return {
    calls,
    async notify(input) {
      calls.push(input);
      await setDelivery(
        env.DB,
        input.approvalId,
        ["none"],
        to,
        error,
        Date.now()
      );
      return { applied: true };
    },
  };
}

/** Always throws — the "DO is dead" fixture for invariant 9. */
function deadNotifier(): ResolutionNotifier & { calls: NotifyCall[] } {
  const calls: NotifyCall[] = [];
  return {
    calls,
    async notify(input) {
      calls.push(input);
      throw new Error("DO unreachable");
    },
  };
}

async function seedRun(): Promise<{ runId: string; key: string }> {
  const runId = `run_${crypto.randomUUID()}`;
  const key = `chat:${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, created_at, updated_at)
     VALUES (?, ?, 'chat', NULL, NULL, 'idle', 0, ?, ?)`
  )
    .bind(runId, key, Date.now(), Date.now())
    .run();
  return { runId, key };
}

function card(
  runId: string,
  overrides: Partial<NewApprovalCard> = {}
): NewApprovalCard {
  return {
    id: `apr:${crypto.randomUUID()}`,
    runId,
    generationId: `gen:${crypto.randomUUID()}`,
    draft: "We can refund the last invoice.",
    why: "customer asked for a refund, this is committal",
    channelId: "C1",
    threadTs: "1720000000.123456",
    shadow: false,
    now: Date.now(),
    ...overrides,
  };
}

async function seedApproval(
  overrides: Partial<NewApprovalCard> = {}
): Promise<{ runId: string; runKey: string; id: string }> {
  let runId = overrides.runId;
  let runKey = "";
  if (runId === undefined) {
    const seeded = await seedRun();
    runId = seeded.runId;
    runKey = seeded.key;
  }
  const c = card(runId, overrides);
  expect(await insertApproval(env.DB, c)).toBe("created");
  return { runId, runKey, id: c.id };
}

const FIREFIGHTER = "ronit@zellify.app";
const VIEWER = "marcus@zellify.app";
const OUTSIDER = "nobody@example.com";

function req(
  path: string,
  init: RequestInit & { token?: string } = {}
): Promise<Response> {
  const { token, headers, ...rest } = init;
  const h = new Headers(headers);
  if (token !== undefined) h.set("Cf-Access-Jwt-Assertion", token);
  return SELF.fetch(`https://firefighter.test${path}`, { ...rest, headers: h });
}

/* ------------------------------------------------------------------ GET */

describe("GET /api/approvals", () => {
  it("401s with no token", async () => {
    installApprovalApiPorts({ verifier: fakeVerifier() });
    const res = await req("/api/approvals");
    expect(res.status).toBe(401);
    expect((await res.json<{ code: string }>()).code).toBe(
      "access_jwt_invalid"
    );
  });

  it("401s a garbage token", async () => {
    installApprovalApiPorts({ verifier: fakeVerifier() });
    const res = await req("/api/approvals", { token: "garbage" });
    expect(res.status).toBe(401);
  });

  it("403s an outsider with an otherwise-valid token", async () => {
    installApprovalApiPorts({ verifier: fakeVerifier() });
    const res = await req("/api/approvals", { token: OUTSIDER });
    expect(res.status).toBe(403);
    expect((await res.json<{ code: string }>()).code).toBe("not_a_firefighter");
  });

  it("200s for a viewer — reads are for any of the seven", async () => {
    installApprovalApiPorts({ verifier: fakeVerifier() });
    const res = await req("/api/approvals", { token: VIEWER });
    expect(res.status).toBe(200);
  });

  it("lists open approvals from D1, without waking a DO", async () => {
    installApprovalApiPorts({ verifier: fakeVerifier() });
    const { runId, runKey, id } = await seedApproval();

    const res = await req("/api/approvals", { token: FIREFIGHTER });
    expect(res.status).toBe(200);
    const body = await res.json<{
      approvals: Array<Record<string, unknown>>;
    }>();
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]).toMatchObject({
      id,
      runId,
      draft: "We can refund the last invoice.",
    });

    // THE OTHER HALF, restored against the chassis that replaced the RunDO
    // (invariant 7): the route wrote nothing into the run's session. Reading it
    // here is what wakes the object for the first time, so an untouched state
    // and an empty transcript are only possible if the request itself never
    // reached it — a list of N open approvals must not cost N wakes.
    const stub = await getAgentByName(env.RUN_AGENTS, runKey);
    expect(await stub.runStateForTest()).toMatchObject({
      status: "idle",
      turnId: null,
      openApprovalId: null,
      inputRevision: 0,
    });
    expect(await stub.getMessages()).toEqual([]);
  });

  it("rejects a state value other than 'open'", async () => {
    installApprovalApiPorts({ verifier: fakeVerifier() });
    const res = await req("/api/approvals?state=closed", {
      token: FIREFIGHTER,
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/approvals/:id", () => {
  it("404s an unknown id", async () => {
    installApprovalApiPorts({ verifier: fakeVerifier() });
    const res = await req(`/api/approvals/apr:${crypto.randomUUID()}`, {
      token: FIREFIGHTER,
    });
    expect(res.status).toBe(404);
    expect((await res.json<{ code: string }>()).code).toBe("unknown_approval");
  });

  it("403s an outsider", async () => {
    installApprovalApiPorts({ verifier: fakeVerifier() });
    const { id } = await seedApproval();
    const res = await req(`/api/approvals/${id}`, { token: OUTSIDER });
    expect(res.status).toBe(403);
  });

  it("returns the full card for a viewer, decidedBy included as legitimate PII", async () => {
    installApprovalApiPorts({ verifier: fakeVerifier() });
    const { id } = await seedApproval();
    const res = await req(`/api/approvals/${id}`, { token: VIEWER });
    expect(res.status).toBe(200);
    const body = await res.json<{ approval: Record<string, unknown> }>();
    expect(body.approval).toMatchObject({
      id,
      decision: "pending",
      delivery: "none",
      decidedBy: null,
    });
  });
});

/* --------------------------------------------------------------- PATCH */

describe("PATCH /api/approvals/:id — authorization", () => {
  it("403s a viewer, and the row stays untouched", async () => {
    installApprovalApiPorts({
      verifier: fakeVerifier(),
      notifier: recordingNotifier(),
    });
    const { id } = await seedApproval();

    const res = await req(`/api/approvals/${id}`, {
      method: "PATCH",
      token: VIEWER,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json<{ code: string }>()).code).toBe("not_a_firefighter");

    const row = await env.DB.prepare(
      "SELECT decision, decided_by FROM approvals WHERE id = ?"
    )
      .bind(id)
      .first<{ decision: string; decided_by: string | null }>();
    expect(row).toMatchObject({ decision: "pending", decided_by: null });
  });

  it("401s with no token, row untouched", async () => {
    installApprovalApiPorts({ verifier: fakeVerifier() });
    const { id } = await seedApproval();

    const res = await req(`/api/approvals/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    expect(res.status).toBe(401);

    const row = await env.DB.prepare(
      "SELECT decision FROM approvals WHERE id = ?"
    )
      .bind(id)
      .first<{ decision: string }>();
    expect(row?.decision).toBe("pending");
  });
});

describe("PATCH /api/approvals/:id — deciding", () => {
  it("approves as a fire-fighter: 200, decision+delivery in the body, notifier called once", async () => {
    // `notifierThatDelivers`, not `recordingNotifier`: it moves `delivery` in
    // D1 as its side effect, the way the real DO does before `notify`
    // returns. That is what makes the assertion below meaningful — with a
    // notifier that never touches `delivery`, the pre-notify and post-notify
    // reads are byte-identical and the assertion would pass whether or not
    // the handler re-reads at all.
    const notifier = notifierThatDelivers();
    installApprovalApiPorts({ verifier: fakeVerifier(), notifier });
    const { runId, id } = await seedApproval();

    const res = await req(`/api/approvals/${id}`, {
      method: "PATCH",
      token: FIREFIGHTER,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{
      approval: { decision: string; delivery: string };
      resolutionDelivered: boolean;
    }>();
    expect(body.approval.decision).toBe("approved");
    expect(body.resolutionDelivered).toBe(true);
    // THE PROPERTY THIS ASSERTS: the body reports the delivery state the
    // notify call CAUSED, not the `none` snapshot `decideApproval`'s own CAS
    // read before notify ever ran. Rendering that stale snapshot is exactly
    // the defect being fixed.
    expect(body.approval.delivery).toBe("blocked");

    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]).toMatchObject({
      runId,
      approvalId: id,
      decision: "approved",
      outboundText: "We can refund the last invoice.",
      rejectReason: null,
      decidedBy: FIREFIGHTER,
    });

    const row = await env.DB.prepare(
      "SELECT decision, decided_by, resolution_delivered_at FROM approvals WHERE id = ?"
    )
      .bind(id)
      .first<{
        decision: string;
        decided_by: string;
        resolution_delivered_at: number | null;
      }>();
    expect(row?.decision).toBe("approved");
    expect(row?.decided_by).toBe(FIREFIGHTER);
    expect(row?.resolution_delivered_at).not.toBeNull();
  });

  it("edits with text, and the notifier sees the edited text as outbound", async () => {
    const notifier = recordingNotifier();
    installApprovalApiPorts({ verifier: fakeVerifier(), notifier });
    const { id } = await seedApproval();

    const res = await req(`/api/approvals/${id}`, {
      method: "PATCH",
      token: FIREFIGHTER,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "edit",
        text: "We can refund the last two invoices.",
      }),
    });
    expect(res.status).toBe(200);
    expect(notifier.calls[0].outboundText).toBe(
      "We can refund the last two invoices."
    );
  });

  it("rejects with a reason, and outboundText is null", async () => {
    const notifier = recordingNotifier();
    installApprovalApiPorts({ verifier: fakeVerifier(), notifier });
    const { id } = await seedApproval();

    const res = await req(`/api/approvals/${id}`, {
      method: "PATCH",
      token: FIREFIGHTER,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "reject", reason: "not accurate" }),
    });
    expect(res.status).toBe(200);
    expect(notifier.calls[0]).toMatchObject({
      decision: "rejected",
      outboundText: null,
      rejectReason: "not accurate",
    });
  });

  it("422s an edit with no text", async () => {
    installApprovalApiPorts({
      verifier: fakeVerifier(),
      notifier: recordingNotifier(),
    });
    const { id } = await seedApproval();
    const res = await req(`/api/approvals/${id}`, {
      method: "PATCH",
      token: FIREFIGHTER,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "edit" }),
    });
    expect(res.status).toBe(422);
    expect((await res.json<{ code: string }>()).code).toBe("invalid_action");
  });

  it("422s an edit with a blank text", async () => {
    installApprovalApiPorts({
      verifier: fakeVerifier(),
      notifier: recordingNotifier(),
    });
    const { id } = await seedApproval();
    const res = await req(`/api/approvals/${id}`, {
      method: "PATCH",
      token: FIREFIGHTER,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "edit", text: "   " }),
    });
    expect(res.status).toBe(422);
  });

  it("422s a reject with no reason", async () => {
    installApprovalApiPorts({
      verifier: fakeVerifier(),
      notifier: recordingNotifier(),
    });
    const { id } = await seedApproval();
    const res = await req(`/api/approvals/${id}`, {
      method: "PATCH",
      token: FIREFIGHTER,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "reject" }),
    });
    expect(res.status).toBe(422);
  });

  it("422s an unknown action", async () => {
    installApprovalApiPorts({
      verifier: fakeVerifier(),
      notifier: recordingNotifier(),
    });
    const { id } = await seedApproval();
    const res = await req(`/api/approvals/${id}`, {
      method: "PATCH",
      token: FIREFIGHTER,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "withdraw" }),
    });
    expect(res.status).toBe(422);
  });

  it("404s an unknown id", async () => {
    installApprovalApiPorts({
      verifier: fakeVerifier(),
      notifier: recordingNotifier(),
    });
    const res = await req(`/api/approvals/apr:${crypto.randomUUID()}`, {
      method: "PATCH",
      token: FIREFIGHTER,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    expect(res.status).toBe(404);
  });

  it("races approve vs reject: exactly one 200, the loser gets 409 with the winning decision", async () => {
    installApprovalApiPorts({
      verifier: fakeVerifier(),
      notifier: recordingNotifier(),
    });
    const { id } = await seedApproval();

    const approve = () =>
      req(`/api/approvals/${id}`, {
        method: "PATCH",
        token: FIREFIGHTER,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      });
    const reject = () =>
      req(`/api/approvals/${id}`, {
        method: "PATCH",
        token: FIREFIGHTER,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reject", reason: "changed my mind" }),
      });

    const [a, b] = await Promise.all([approve(), reject()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const loser = a.status === 409 ? a : b;
    const loserBody = await loser.json<{ code: string; decision: string }>();
    expect(loserBody.code).toBe("already_decided");

    const winner = a.status === 200 ? a : b;
    const winnerBody = await winner.json<{ approval: { decision: string } }>();
    expect(loserBody.decision).toBe(winnerBody.approval.decision);

    const row = await env.DB.prepare(
      "SELECT decision FROM approvals WHERE id = ?"
    )
      .bind(id)
      .first<{ decision: string }>();
    expect(["approved", "rejected"]).toContain(row?.decision);
  });

  it("invariant 9: a dead notifier does not roll back the decision — 200, resolutionDelivered:false, row stays decided", async () => {
    const notifier = deadNotifier();
    installApprovalApiPorts({ verifier: fakeVerifier(), notifier });
    const { id } = await seedApproval();

    const res = await req(`/api/approvals/${id}`, {
      method: "PATCH",
      token: FIREFIGHTER,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{
      approval: { decision: string };
      resolutionDelivered: boolean;
    }>();
    expect(body.approval.decision).toBe("approved");
    expect(body.resolutionDelivered).toBe(false);

    const row = await env.DB.prepare(
      "SELECT decision, resolution_delivered_at FROM approvals WHERE id = ?"
    )
      .bind(id)
      .first<{ decision: string; resolution_delivered_at: number | null }>();
    expect(row?.decision).toBe("approved");
    expect(row?.resolution_delivered_at).toBeNull();
    expect(notifier.calls).toHaveLength(1);
  });
});

/* ------------------------------------------------------------- sweeper */

describe("the extended scheduled() sweeper", () => {
  // `scheduled()` as shipped in `src/index.ts` takes only `(controller, env)`
  // — the sweep is awaited directly rather than deferred via `waitUntil`, so
  // there is no execution context to create or wait on here.
  async function runScheduled(): Promise<void> {
    await worker.scheduled(createScheduledController(), env);
  }

  it("re-delivers a resolution the notifier failed on the first attempt", async () => {
    const dead = deadNotifier();
    installApprovalApiPorts({ verifier: fakeVerifier(), notifier: dead });
    const { id } = await seedApproval();

    const patchRes = await req(`/api/approvals/${id}`, {
      method: "PATCH",
      token: FIREFIGHTER,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    expect(
      (await patchRes.json<{ resolutionDelivered: boolean }>())
        .resolutionDelivered
    ).toBe(false);

    // Swap in a working notifier — same shape as the DO coming back up —
    // and let the sweep re-drive the row the PATCH left undelivered.
    const recovered = recordingNotifier();
    installApprovalApiPorts({ notifier: recovered });

    await runScheduled();

    expect(recovered.calls).toHaveLength(1);
    expect(recovered.calls[0]).toMatchObject({
      approvalId: id,
      decision: "approved",
    });

    const row = await env.DB.prepare(
      "SELECT resolution_delivered_at FROM approvals WHERE id = ?"
    )
      .bind(id)
      .first<{ resolution_delivered_at: number | null }>();
    expect(row?.resolution_delivered_at).not.toBeNull();
  });

  it("leaves a still-undeliverable row due for the next sweep", async () => {
    const dead = deadNotifier();
    installApprovalApiPorts({ verifier: fakeVerifier(), notifier: dead });
    const { id } = await seedApproval();

    await req(`/api/approvals/${id}`, {
      method: "PATCH",
      token: FIREFIGHTER,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });

    await runScheduled();

    const row = await env.DB.prepare(
      "SELECT resolution_delivered_at FROM approvals WHERE id = ?"
    )
      .bind(id)
      .first<{ resolution_delivered_at: number | null }>();
    expect(row?.resolution_delivered_at).toBeNull();
    // Two attempts total: the PATCH's own, plus the sweep's.
    expect(dead.calls).toHaveLength(2);
  });

  /**
   * A `D1Database` whose `prepare()` throws for the exact query
   * `listDueOutboxRows` (`src/memory/outbox.ts`) issues, and passes every
   * other query straight through to the real pool. This is the cheapest way
   * to make `sweepMemoryOutbox` genuinely throw without touching a file this
   * task does not own: `sweepMemoryOutbox` itself never throws under normal
   * operation (every per-row failure is caught internally), so the only
   * realistic way to observe it fail is a broken query underneath it.
   */
  function dbThatBreaksTheMemorySweep(real: D1Database): D1Database {
    return new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string): D1PreparedStatement => {
            if (sql.includes("agent_memory_outbox")) {
              throw new Error("simulated memory sweep failure");
            }
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  it("still runs the approval sweep when the memory sweep throws, and the cron invocation still fails honestly", async () => {
    const dead = deadNotifier();
    installApprovalApiPorts({ verifier: fakeVerifier(), notifier: dead });
    const { id } = await seedApproval();

    await req(`/api/approvals/${id}`, {
      method: "PATCH",
      token: FIREFIGHTER,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });

    const recovered = recordingNotifier();
    installApprovalApiPorts({ notifier: recovered });

    const brokenEnv = { ...env, DB: dbThatBreaksTheMemorySweep(env.DB) };
    await expect(
      worker.scheduled(createScheduledController(), brokenEnv)
    ).rejects.toThrow();

    // The memory sweep threw first (it runs via the same `Promise.allSettled`
    // entry, and its query is the one rigged to fail) — but the approval
    // sweep, run independently, still reached the notifier and repaired the
    // row invariant 9 promises will be repaired. If the two sweeps were still
    // sequential, this notifier would never have been called at all.
    expect(recovered.calls).toHaveLength(1);
    expect(recovered.calls[0]).toMatchObject({ approvalId: id });

    const row = await env.DB.prepare(
      "SELECT resolution_delivered_at FROM approvals WHERE id = ?"
    )
      .bind(id)
      .first<{ resolution_delivered_at: number | null }>();
    expect(row?.resolution_delivered_at).not.toBeNull();
  });
});

describe("history reads", () => {
  const get = (path: string, who = VIEWER) =>
    SELF.fetch(`https://firefighter.test${path}`, {
      headers: { "Cf-Access-Jwt-Assertion": who },
    });

  beforeEach(() => {
    installApprovalApiPorts({
      verifier: fakeVerifier(),
      notifier: recordingNotifier(),
    });
    // `GET /runs/:id/approvals` lives in `src/api/runs.ts` and is gated by
    // `requireTeamMember` (`src/api/identity.ts`), a SEPARATE port registry
    // from `installApprovalApiPorts` above — without this, that route falls
    // through to the real Access verifier and every case below 401s.
    installIdentityApiPorts({ verifier: fakeVerifier() });
  });

  afterEach(() => {
    resetIdentityApiPorts();
  });

  it("lists a run's approvals oldest first, every decision included", async () => {
    const { runId } = await seedRun();
    const first = card(runId, { now: 1_000 });
    await insertApproval(env.DB, first);
    // `delivery` must also reach a terminal state here — `idx_approvals_one_open`
    // (migrations/0007_approvals.sql) still counts an approved-but-`none`
    // row as unsettled, so a plain decision-only UPDATE would make the
    // second `insertApproval` below collide with the same partial unique
    // index invariant 4 relies on.
    await env.DB.prepare(
      "UPDATE approvals SET decision = 'approved', decided_by = ?, decided_at = 2000, updated_at = 2000, delivery = 'sent' WHERE id = ?"
    )
      .bind(FIREFIGHTER, first.id)
      .run();
    const second = card(runId, { now: 3_000 });
    await insertApproval(env.DB, second);

    const res = await get(`/api/runs/${runId}/approvals`);
    expect(res.status).toBe(200);
    const body = await res.json<{
      approvals: { id: string; decision: string; decidedBy: string | null }[];
    }>();
    expect(body.approvals.map((a) => a.id)).toEqual([first.id, second.id]);
    expect(body.approvals[0].decision).toBe("approved");
    expect(body.approvals[0].decidedBy).toBe(FIREFIGHTER);
  });

  it("404s a run that does not exist", async () => {
    expect((await get("/api/runs/nope/approvals")).status).toBe(404);
  });

  it("lists decided approvals newest first within the window", async () => {
    const now = Date.now();
    const a = (await seedRun()).runId;
    const b = (await seedRun()).runId;
    const c = (await seedRun()).runId;
    const old = card(a, { now: now - 3 * 86_400_000 });
    const recent = card(b, { now: now - 3_600_000 });
    const open = card(c, { now });
    await insertApproval(env.DB, old);
    await insertApproval(env.DB, recent);
    await insertApproval(env.DB, open);
    await env.DB.prepare(
      "UPDATE approvals SET decision = 'rejected', reject_reason = 'no', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?"
    )
      .bind(FIREFIGHTER, old.now, old.now, old.id)
      .run();
    await env.DB.prepare(
      "UPDATE approvals SET decision = 'edited', edited_text = 'x', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?"
    )
      .bind(FIREFIGHTER, recent.now, recent.now, recent.id)
      .run();

    const day = await get("/api/approvals?state=decided");
    expect(day.status).toBe(200);
    expect(
      (await day.json<{ approvals: { id: string }[] }>()).approvals.map(
        (x) => x.id
      )
    ).toEqual([recent.id]);

    const week = await get(
      `/api/approvals?state=decided&since=${now - 7 * 86_400_000}`
    );
    expect(
      (await week.json<{ approvals: { id: string }[] }>()).approvals.map(
        (x) => x.id
      )
    ).toEqual([recent.id, old.id]);

    expect(
      (await get("/api/approvals?state=decided&since=yesterday")).status
    ).toBe(400);
  });

  it("names the winner in the 409 body", async () => {
    const { runId } = await seedRun();
    const c = card(runId);
    await insertApproval(env.DB, c);
    const patch = (who: string) =>
      SELF.fetch(`https://firefighter.test/api/approvals/${c.id}`, {
        method: "PATCH",
        headers: {
          "Cf-Access-Jwt-Assertion": who,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "approve" }),
      });
    expect((await patch(FIREFIGHTER)).status).toBe(200);
    const lost = await patch("luka@zellify.app");
    expect(lost.status).toBe(409);
    const body = await lost.json<{
      decision: string;
      decidedBy: string | null;
    }>();
    expect(body.decision).toBe("approved");
    expect(body.decidedBy).toBe(FIREFIGHTER);
  });
});
