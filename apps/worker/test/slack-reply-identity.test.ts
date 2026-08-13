import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRegistry } from "../src/codemode/registry";
import { CapabilityError } from "../src/codemode/errors";
import type { CodeModeScope } from "../src/codemode/contracts";
import type { UserTokenSource } from "../src/identity/user-token";
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
