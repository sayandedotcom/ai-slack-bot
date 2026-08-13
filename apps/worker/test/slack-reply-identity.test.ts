import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCodeModeScope } from "../src/agent/dependencies";
import { buildRegistry } from "../src/codemode/registry";
import { CapabilityError } from "../src/codemode/errors";
import type { CodeModeScope } from "../src/codemode/contracts";
import type { UserTokenSource } from "../src/identity/user-token";
import type { RunState } from "../src/run/session";
import { makeSlackGateway } from "../src/slack/gateway";
import {
  fakeAuditSink,
  fakeDeps,
  seedPermittedScope,
  TEST_LIMITS,
  testExecution,
} from "./helpers/codemode";

/**
 * `slack.reply` SPEAKS AS A HUMAN, OR IT DOES NOT SPEAK.
 *
 * Phase 10 left the credential seam refusing unconditionally. This file is the
 * proof that filling it changed exactly one thing — whose token the request
 * carries — and nothing else:
 *
 *  - the destination is still the run's pinned channel and thread, never an
 *    argument;
 *  - the shared write guard still runs first, so an observe channel or a shadow
 *    run is refused BEFORE any request exists;
 *  - the effect ledger still reserves before the send, so a replay inside one
 *    turn posts once;
 *  - and with nobody connected it still refuses with `identity_unavailable`,
 *    with a working `SLACK_BOT_TOKEN` sitting right there unused.
 *
 * Every case stubs `fetch`. Nothing here reaches Slack.
 */

const USER_TOKEN = "xoxp-not-a-real-on-duty-token";
const ON_DUTY = "ronit@zellify.app";

/** The on-duty engineer, connected. */
function connected(token = USER_TOKEN): UserTokenSource {
  return {
    async onDutyToken() {
      return { token, slackUserId: "U0NDUTY01", email: ON_DUTY };
    },
  };
}

/** Nobody on duty has connected Slack. An ordinary state, not an error. */
const unconnected: UserTokenSource = {
  async onDutyToken() {
    return null;
  },
};

/**
 * A source that records every instant it was asked about.
 *
 * `asked` is the assertion that matters for the runs that cannot speak: "the
 * identity table was never read" is a strictly stronger claim than "the actor
 * came out null", and only the first one says a corrupt row for the on-duty
 * engineer cannot take out a Chat run.
 */
function counting(inner: UserTokenSource): UserTokenSource & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    async onDutyToken(nowMs: number) {
      asked.push(nowMs);
      return inner.onDutyToken(nowMs);
    },
  };
}

type Captured = { url: string; authorization: string | null; body: unknown };

/**
 * Replace global `fetch` and record what a send would have carried.
 *
 * The captured `authorization` is the assertion this whole phase exists for: a
 * customer-facing message must go out under the ENGINEER'S token, and a bot
 * token appearing there would be the one failure the design forbids.
 */
function stubSlack(
  respond: () => { status?: number; body: unknown; text?: string } | Promise<never>,
): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    const answer = await respond();
    return new Response(answer.text ?? JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

const ok = (ts: string) => () => ({ body: { ok: true, ts } });

/** The real gateway and the real registry, with only the credential injected. */
function slackTools(scope: CodeModeScope, source: UserTokenSource | null) {
  const deps = {
    ...fakeDeps(),
    db: env.DB,
    slack: makeSlackGateway(env.DB, scope, source),
  };
  const registry = buildRegistry(
    scope,
    deps,
    TEST_LIMITS,
    testExecution({ audit: fakeAuditSink() }),
  );
  return registry.find((p) => p.name === "slack")!.tools;
}

const call = (tools: ReturnType<typeof slackTools>, method: string, args: unknown) =>
  (tools[method] as { execute: (a: unknown) => Promise<unknown> }).execute(args);

type EffectRow = { state: string; safe_result_json: string | null; safe_error: string | null };

function effectsFor(scope: CodeModeScope): Promise<EffectRow[]> {
  return env.DB.prepare(
    `SELECT state, safe_result_json, safe_error FROM codemode_effects
      WHERE run_id = ? AND turn_id = ? AND namespace = 'slack' AND method = 'reply'`,
  )
    .bind(scope.runId, scope.turnId)
    .all<EffectRow>()
    .then((r) => r.results);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ----------------------------------------------- the actor, in production -- */

const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();

async function seedScopeRun(input: {
  origin: "slack" | "chat";
  shadow?: boolean;
}): Promise<RunState> {
  const runId = `run_${crypto.randomUUID()}`;
  const channelId = input.origin === "slack" ? `C${uid()}` : null;
  const threadTs = input.origin === "slack" ? "1712345678.000100" : null;
  const key =
    input.origin === "slack" ? `slack:${channelId}:${threadTs}` : `chat:${crypto.randomUUID()}`;

  if (channelId !== null) {
    await env.DB.prepare(
      "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, 'acme', 'live')",
    )
      .bind(channelId, `chan-${channelId}`)
      .run();
  }
  await env.DB.prepare(
    `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'live', ?, 0, 0)`,
  )
    .bind(runId, key, input.origin, channelId, threadTs, input.shadow === true ? 1 : 0)
    .run();

  return {
    runId,
    key,
    origin: input.origin,
    channelId,
    threadTs,
    status: "live",
    summary: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * WHERE THE ON-DUTY ENGINEER ENTERS THE SCOPE.
 *
 * `bindings/slack.ts` refuses a reply whose scope carries no actor, so this
 * resolution is the half of the credential path that makes production work at
 * all — and it is asked ONLY of runs that could speak, because the question can
 * fail loudly (a `SealError`, or an `externalId` `validateScope` rejects) and
 * that failure must not reach a Chat run that was never going to reply.
 */
describe("resolveCodeModeScope resolves the on-duty engineer", () => {
  it("names the connected engineer, and carries no credential", async () => {
    const state = await seedScopeRun({ origin: "slack" });

    const scope = await resolveCodeModeScope(env.DB, state, "agent:gen:1", connected());

    expect(scope.actor).toEqual({
      engineerEmail: ON_DUTY,
      slackUserId: "U0NDUTY01",
    });
    expect(JSON.stringify(scope)).not.toContain(USER_TOKEN);
  });

  it("resolves no actor when nobody on duty has connected Slack", async () => {
    const state = await seedScopeRun({ origin: "slack" });
    const scope = await resolveCodeModeScope(env.DB, state, "agent:gen:2", unconnected);
    expect(scope.actor).toBeNull();
  });

  // The default the four two-argument call sites depend on. Absent source means
  // nobody, and nobody means every customer-facing write refuses.
  it("resolves no actor when no source is supplied at all", async () => {
    const state = await seedScopeRun({ origin: "slack" });
    const scope = await resolveCodeModeScope(env.DB, state, "agent:gen:3");
    expect(scope.actor).toBeNull();
  });

  it("asks at the RUN'S instant, not the wall clock", async () => {
    // The rotation is a pure function of an instant, so the clock is what
    // decides WHOSE identity is used.
    const state = await seedScopeRun({ origin: "slack" });
    const source = counting(connected());
    const runInstant = 1_760_000_000_000;

    await resolveCodeModeScope(env.DB, state, "agent:gen:4", source, () => runInstant);

    expect(source.asked).toEqual([runInstant]);
  });

  it("never reads an identity for a Chat run", async () => {
    const state = await seedScopeRun({ origin: "chat" });
    const source = counting(connected());

    const scope = await resolveCodeModeScope(env.DB, state, "agent:gen:5", source);

    expect(scope.actor).toBeNull();
    expect(source.asked).toEqual([]);
  });

  it("never reads an identity for a run with no pinned thread", async () => {
    // A threadless Slack run is not representable — the `runs` CHECK forbids
    // the row and `validateScope` refuses the scope — so the run that reaches
    // the identity question with `slackThread: null` is a Chat one, and it is
    // refused an identity read for that reason rather than for its origin.
    const seeded = await seedScopeRun({ origin: "slack" });
    const source = counting(connected());

    await expect(
      resolveCodeModeScope(env.DB, { ...seeded, threadTs: null }, "agent:gen:6", source),
    ).rejects.toThrow(/invalid_context/);
    expect(source.asked).toEqual([]);
  });

  it("never reads an identity for a shadow run", async () => {
    const state = await seedScopeRun({ origin: "slack", shadow: true });
    const source = counting(connected());

    const scope = await resolveCodeModeScope(env.DB, state, "agent:gen:7", source);

    // Shadow comes from the D1 row, and a shadow run cannot write at all.
    expect(scope.shadow).toBe(true);
    expect(scope.actor).toBeNull();
    expect(source.asked).toEqual([]);
  });

  it("lets a tampered identity fail loudly rather than look unconnected", async () => {
    const state = await seedScopeRun({ origin: "slack" });
    const sealed: UserTokenSource = {
      async onDutyToken() {
        throw new Error("SealError: ciphertext did not open");
      },
    };

    await expect(resolveCodeModeScope(env.DB, state, "agent:gen:8", sealed))
      .rejects.toThrow(/ciphertext did not open/);
  });
});

/* ------------------------------------------------------------- the send -- */

describe("slack.reply as the on-duty engineer", () => {
  it("posts under the engineer's OWN token, to the run's pinned thread", async () => {
    const scope = await seedPermittedScope(env.DB);
    const calls = stubSlack(ok("1720000000.000200"));

    const out = await call(slackTools(scope, connected()), "reply", {
      text: "The migration finished at 14:02 UTC.",
    });

    expect(out).toEqual({ ts: "1720000000.000200", permalink: null });
    expect(calls).toHaveLength(1);
    // THE CREDENTIAL. The engineer's token, and provably not the bot's.
    expect(calls[0].authorization).toBe(`Bearer ${USER_TOKEN}`);
    expect(calls[0].authorization).not.toContain(env.SLACK_BOT_TOKEN);
    expect(calls[0].url).toBe("https://slack.com/api/chat.postMessage");
    // THE DESTINATION. Pinned by the run, unchanged by identity.
    expect(calls[0].body).toEqual({
      channel: scope.slackThread!.channelId,
      thread_ts: scope.slackThread!.threadTs,
      text: "The migration finished at 14:02 UTC.",
    });
  });

  it("sends the text byte-exact, with no preamble and no signature", async () => {
    const scope = await seedPermittedScope(env.DB);
    const calls = stubSlack(ok("1720000000.000201"));
    const text = "  Rolled back to 4.2.1.\n\nNo data was lost.  ";

    await call(slackTools(scope, connected()), "reply", { text });

    expect((calls[0].body as { text: string }).text).toBe(text);
  });

  it("records the effect ledger entry exactly as before, with no token in it", async () => {
    const scope = await seedPermittedScope(env.DB);
    stubSlack(ok("1720000000.000202"));

    await call(slackTools(scope, connected()), "reply", { text: "hello" });

    const rows = await effectsFor(scope);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("completed");
    expect(rows[0].safe_result_json).toContain("1720000000.000202");
    expect(JSON.stringify(rows)).not.toContain(USER_TOKEN);
    expect(JSON.stringify(rows)).not.toContain(ON_DUTY);
  });

  it("posts once when the same reply is replayed inside one turn", async () => {
    const scope = await seedPermittedScope(env.DB);
    const calls = stubSlack(ok("1720000000.000203"));
    const tools = slackTools(scope, connected());

    const first = await call(tools, "reply", { text: "same text" });
    const second = await call(tools, "reply", { text: "same text" });

    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
  });
});

/* ------------------------------------------------------- no human, no send -- */

describe("slack.reply with nobody connected", () => {
  it("still refuses with identity_unavailable and sends NOTHING", async () => {
    const scope = await seedPermittedScope(env.DB);
    const calls = stubSlack(ok("1720000000.000300"));

    const err = await call(slackTools(scope, unconnected), "reply", { text: "hi" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as CapabilityError).code).toBe("identity_unavailable");
    expect(calls).toEqual([]);
  });

  // The bot token is present and usable in this environment, which is exactly
  // why this matters: refusing has to be a decision, not an accident.
  it("never falls back to the bot token, which is right there and working", async () => {
    expect(env.SLACK_BOT_TOKEN).toBeTruthy();
    const scope = await seedPermittedScope(env.DB);
    const calls = stubSlack(ok("1720000000.000301"));

    const err = await makeSlackGateway(env.DB, scope, unconnected)
      .reply("hi", "key")
      .catch((e: unknown) => e);

    expect((err as CapabilityError).code).toBe("identity_unavailable");
    expect((err as CapabilityError).message).not.toContain(env.SLACK_BOT_TOKEN);
    expect(calls).toEqual([]);
  });

  it("refuses when no credential source is composed at all", async () => {
    const scope = await seedPermittedScope(env.DB);
    const calls = stubSlack(ok("1720000000.000302"));

    const err = await makeSlackGateway(env.DB, scope)
      .reply("hi", "key")
      .catch((e: unknown) => e);

    expect((err as CapabilityError).code).toBe("identity_unavailable");
    expect(calls).toEqual([]);
  });

  it("refuses before the send when the scope carries no resolved actor", async () => {
    const scope = await seedPermittedScope(env.DB, { actor: null });
    const calls = stubSlack(ok("1720000000.000303"));

    await expect(call(slackTools(scope, connected()), "reply", { text: "hi" }))
      .rejects.toThrow(/identity_unavailable/);
    expect(calls).toEqual([]);
  });
});

/* -------------------------------------------------- the guards, unchanged -- */

describe("the Phase 09/10 guard rails still run first", () => {
  it("refuses an observe channel without building a request", async () => {
    const scope = await seedPermittedScope(env.DB);
    await env.DB.prepare("UPDATE channels SET mode = 'observe' WHERE channel_id = ?")
      .bind(scope.slackThread!.channelId)
      .run();
    const calls = stubSlack(ok("1720000000.000400"));

    await expect(call(slackTools(scope, connected()), "reply", { text: "hi" }))
      .rejects.toThrow(/channel_read_only/);
    expect(calls).toEqual([]);
  });

  it("refuses a shadow run even with a connected engineer", async () => {
    const scope = await seedPermittedScope(env.DB);
    await env.DB.prepare("UPDATE runs SET shadow = 1 WHERE id = ?").bind(scope.runId).run();
    const calls = stubSlack(ok("1720000000.000401"));

    await expect(call(slackTools(scope, connected()), "reply", { text: "hi" }))
      .rejects.toThrow(/shadow_write_denied/);
    expect(calls).toEqual([]);
  });

  it("still refuses a destination argument, credential or not", async () => {
    const scope = await seedPermittedScope(env.DB);
    const calls = stubSlack(ok("1720000000.000402"));

    await expect(
      call(slackTools(scope, connected()), "reply", { text: "hi", channel: "C_OTHER" }),
    ).rejects.toThrow(/invalid_input/);
    expect(calls).toEqual([]);
  });

  it("refuses a run with no attached conversation", async () => {
    const scope = await seedPermittedScope(env.DB, {
      origin: "chat",
      slackThread: null,
    });
    const calls = stubSlack(ok("1720000000.000403"));

    await expect(call(slackTools(scope, connected()), "reply", { text: "hi" }))
      .rejects.toThrow(/slack_context_required/);
    expect(calls).toEqual([]);
  });
});

/* ------------------------------------------------------------- outcomes -- */

describe("what Slack answers", () => {
  it("turns a definite refusal into a failed ledger entry, not a doubt", async () => {
    const scope = await seedPermittedScope(env.DB);
    stubSlack(() => ({ body: { ok: false, error: "channel_not_found" } }));

    const err = await call(slackTools(scope, connected()), "reply", { text: "hi" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as CapabilityError).message).toContain("channel_not_found");
    const rows = await effectsFor(scope);
    expect(rows[0].state).toBe("failed");
  });

  it("leaves a thrown request in doubt rather than inviting a second send", async () => {
    const scope = await seedPermittedScope(env.DB);
    vi.stubGlobal("fetch", async () => {
      throw new Error("socket hang up");
    });

    const err = await call(slackTools(scope, connected()), "reply", { text: "hi" })
      .catch((e: unknown) => e);

    expect((err as CapabilityError).code).toBe("effect_in_doubt");
    const rows = await effectsFor(scope);
    expect(rows[0].state).toBe("in_doubt");
    // Nothing about the transport failure reaches the model or the ledger.
    expect(JSON.stringify(rows)).not.toContain("socket hang up");
  });
});
