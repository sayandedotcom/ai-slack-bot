import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildRegistry } from "../src/codemode/registry";
import { makeSlackGateway } from "../src/slack/gateway";
import { CapabilityError } from "../src/codemode/errors";
import type { CodeModeScope } from "../src/codemode/contracts";
import { fakeAuditSink, fakeDeps, slackScope, TEST_LIMITS, testExecution } from "./helpers/codemode";

/**
 * Storage is shared across cases and files (test/setup.ts migrates once), so
 * every case mints its own channel, thread and run. Nothing here asserts a
 * table-wide count.
 */
const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();

async function seedChannel(mode: "observe" | "live" | "internal", customerSlug: string | null) {
  const channelId = `C${uid()}`;
  await env.DB.prepare(
    "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, ?, ?)",
  ).bind(channelId, `chan-${channelId}`, customerSlug, mode).run();
  return channelId;
}

async function seedRun(channelId: string, threadTs: string, shadow: boolean) {
  const runId = `run_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, created_at, updated_at)
     VALUES (?, ?, 'slack', ?, ?, 'live', ?, 0, 0)`,
  ).bind(runId, `slack:${channelId}:${threadTs}`, channelId, threadTs, shadow ? 1 : 0).run();
  return runId;
}

async function seedMessage(input: {
  channelId: string; ts: string; threadTs: string | null;
  text: string; customerSlug: string | null; permalink?: string | null;
}) {
  await env.DB.prepare(
    `INSERT INTO messages
       (event_id, channel_id, ts, thread_ts, user_id, text, subtype, permalink, customer_slug, received_at)
     VALUES (?, ?, ?, ?, 'U1', ?, NULL, ?, ?, 0)`,
  ).bind(
    `ev_${crypto.randomUUID()}`, input.channelId, input.ts, input.threadTs,
    input.text, input.permalink ?? null, input.customerSlug,
  ).run();
}

const scopeFor = (channelId: string, threadTs: string, runId: string, patch: Partial<CodeModeScope> = {}): CodeModeScope => ({
  ...slackScope,
  runId,
  turnId: `turn_${crypto.randomUUID()}`,
  slackThread: { channelId, threadTs },
  ...patch,
});

/** The real gateway over real D1, with the fakes replaced for this namespace. */
function slackTools(scope: CodeModeScope) {
  const deps = { ...fakeDeps(), db: env.DB, slack: makeSlackGateway(env.DB, scope) };
  const registry = buildRegistry(scope, deps, TEST_LIMITS, testExecution({ audit: fakeAuditSink() }));
  return registry.find((p) => p.name === "slack")!.tools;
}

const call = (tools: ReturnType<typeof slackTools>, method: string, args: unknown) =>
  (tools[method] as { execute: (a: unknown) => Promise<unknown> }).execute(args);

describe("slack.thread", () => {
  it("returns the root plus its replies in timestamp order", async () => {
    const channelId = await seedChannel("live", "acme");
    const root = "1712345678.000100";
    await seedMessage({ channelId, ts: root, threadTs: null, text: "root", customerSlug: "acme", permalink: "https://p/root" });
    await seedMessage({ channelId, ts: "1712345680.000100", threadTs: root, text: "second", customerSlug: "acme" });
    await seedMessage({ channelId, ts: "1712345679.000100", threadTs: root, text: "first", customerSlug: "acme" });
    const runId = await seedRun(channelId, root, false);

    const out = await call(slackTools(scopeFor(channelId, root, runId)), "thread", {}) as Array<{ text: string }>;
    expect(out.map((m) => m.text)).toEqual(["root", "first", "second"]);
  });

  it("reads only the current conversation", async () => {
    const mine = await seedChannel("live", "acme");
    const theirs = await seedChannel("live", "globex");
    const root = "1712345678.000200";
    await seedMessage({ channelId: mine, ts: root, threadTs: null, text: "mine", customerSlug: "acme" });
    await seedMessage({ channelId: theirs, ts: root, threadTs: null, text: "theirs", customerSlug: "globex" });
    const runId = await seedRun(mine, root, false);

    const out = await call(slackTools(scopeFor(mine, root, runId)), "thread", {}) as Array<{ text: string }>;
    expect(out.map((m) => m.text)).toEqual(["mine"]);
  });

  it("returns an empty array for a thread with nothing in it", async () => {
    const channelId = await seedChannel("live", "acme");
    const root = "1712345678.000300";
    const runId = await seedRun(channelId, root, false);
    await expect(call(slackTools(scopeFor(channelId, root, runId)), "thread", {})).resolves.toEqual([]);
  });

  it("clamps the limit rather than trusting it", async () => {
    const channelId = await seedChannel("live", "acme");
    const root = "1712345678.000400";
    await seedMessage({ channelId, ts: root, threadTs: null, text: "root", customerSlug: "acme" });
    await seedMessage({ channelId, ts: "1712345679.000400", threadTs: root, text: "reply", customerSlug: "acme" });
    const runId = await seedRun(channelId, root, false);
    const out = await call(slackTools(scopeFor(channelId, root, runId)), "thread", { limit: 1 }) as unknown[];
    expect(out).toHaveLength(1);
  });

  it("normalizes rows and never returns raw column names", async () => {
    const channelId = await seedChannel("live", "acme");
    const root = "1712345678.000500";
    await seedMessage({ channelId, ts: root, threadTs: null, text: "hello", customerSlug: "acme", permalink: "https://p/1" });
    const runId = await seedRun(channelId, root, false);
    const out = await call(slackTools(scopeFor(channelId, root, runId)), "thread", {}) as Array<Record<string, unknown>>;
    expect(Object.keys(out[0]).sort()).toEqual(["permalink", "text", "ts", "userId"]);
    expect(JSON.stringify(out)).not.toContain("customer_slug");
    expect(JSON.stringify(out)).not.toContain("event_id");
    expect(JSON.stringify(out)).not.toMatch(/xox[bp]-/);
  });

  it("refuses when the run is not attached to a conversation", async () => {
    const scope = { ...slackScope, origin: "chat" as const, slackThread: null };
    await expect(call(slackTools(scope), "thread", {}))
      .rejects.toThrow(/slack_context_required/);
  });
});

describe("slack.searchMessages", () => {
  it("scopes to this run's customer and no other", async () => {
    const mine = await seedChannel("live", `acme-${uid()}`);
    const mineSlug = (await env.DB.prepare("SELECT customer_slug AS s FROM channels WHERE channel_id = ?")
      .bind(mine).first<{ s: string }>())!.s;
    const theirs = await seedChannel("live", `globex-${uid()}`);
    const theirSlug = (await env.DB.prepare("SELECT customer_slug AS s FROM channels WHERE channel_id = ?")
      .bind(theirs).first<{ s: string }>())!.s;

    const marker = `needle${uid()}`;
    await seedMessage({ channelId: mine, ts: "1712345678.000600", threadTs: null, text: `ours ${marker}`, customerSlug: mineSlug });
    await seedMessage({ channelId: theirs, ts: "1712345678.000601", threadTs: null, text: `theirs ${marker}`, customerSlug: theirSlug });

    const runId = await seedRun(mine, "1712345678.000600", false);
    const scope = scopeFor(mine, "1712345678.000600", runId, { customerSlug: mineSlug });
    const out = await call(slackTools(scope), "searchMessages", { query: marker }) as Array<{ text: string }>;
    expect(out.map((m) => m.text)).toEqual([`ours ${marker}`]);
  });

  it("treats LIKE metacharacters as literal text", async () => {
    const channelId = await seedChannel("live", `pct-${uid()}`);
    const slug = (await env.DB.prepare("SELECT customer_slug AS s FROM channels WHERE channel_id = ?")
      .bind(channelId).first<{ s: string }>())!.s;
    await seedMessage({ channelId, ts: "1712345678.000700", threadTs: null, text: "plain text", customerSlug: slug });
    const runId = await seedRun(channelId, "1712345678.000700", false);
    const scope = scopeFor(channelId, "1712345678.000700", runId, { customerSlug: slug });
    // A bare % would match every row if it were interpolated as a wildcard.
    await expect(call(slackTools(scope), "searchMessages", { query: "%text" }))
      .resolves.toEqual([]);
  });

  it("refuses a wildcard-only query", async () => {
    const channelId = await seedChannel("live", "acme");
    const runId = await seedRun(channelId, "1712345678.000800", false);
    const scope = scopeFor(channelId, "1712345678.000800", runId);
    await expect(call(slackTools(scope), "searchMessages", { query: "%%" }))
      .rejects.toThrow(/invalid_input/);
  });

  it("refuses when the run has no customer", async () => {
    const channelId = await seedChannel("internal", null);
    const runId = await seedRun(channelId, "1712345678.000900", false);
    const scope = scopeFor(channelId, "1712345678.000900", runId, { customerSlug: null });
    await expect(call(slackTools(scope), "searchMessages", { query: "anything" }))
      .rejects.toThrow(/customer_scope_required/);
  });
});

describe("slack.reply write policy", () => {
  const attempt = async (opts: {
    mode: "observe" | "live" | "internal";
    customerSlug: string | null;
    shadow?: boolean;
    actor?: CodeModeScope["actor"];
    detach?: boolean;
  }) => {
    const channelId = await seedChannel(opts.mode, opts.customerSlug);
    const ts = `171234567${Math.floor(Math.random() * 9)}.000001`;
    const runId = await seedRun(channelId, ts, opts.shadow ?? false);
    const scope = scopeFor(channelId, ts, runId, {
      actor: opts.actor === undefined ? slackScope.actor : opts.actor,
      ...(opts.detach ? { slackThread: null, origin: "chat" as const } : {}),
    });
    return call(slackTools(scope), "reply", { text: "hello" });
  };

  it("refuses an unknown conversation", async () => {
    const scope = scopeFor(`C${uid()}`, "1712345678.001000",
      await seedRun(`C${uid()}`, "1712345678.001000", false));
    await expect(call(slackTools(scope), "reply", { text: "hi" }))
      .rejects.toThrow(/channel_read_only/);
  });

  it("refuses an observe channel", async () => {
    await expect(attempt({ mode: "observe", customerSlug: "acme" }))
      .rejects.toThrow(/channel_read_only/);
  });

  it("refuses an internal channel", async () => {
    await expect(attempt({ mode: "internal", customerSlug: null }))
      .rejects.toThrow(/channel_read_only/);
  });

  // Fail-open guard. `shadow` lives on the D1 runs row, not on RunState, so a
  // check written against the descriptor reads undefined and the run posts.
  it("refuses a shadow run even on a live channel", async () => {
    await expect(attempt({ mode: "live", customerSlug: "acme", shadow: true }))
      .rejects.toThrow(/shadow_write_denied/);
  });

  it("refuses a run with no attached conversation", async () => {
    await expect(attempt({ mode: "live", customerSlug: "acme", detach: true }))
      .rejects.toThrow(/slack_context_required/);
  });

  it("refuses when no on-duty engineer is resolved", async () => {
    await expect(attempt({ mode: "live", customerSlug: "acme", actor: null }))
      .rejects.toThrow(/identity_unavailable/);
  });

  // Phase 12 seam. Until an encrypted per-engineer token exists, a fully
  // permitted reply still refuses — it must never fall back to the bot token.
  it("still refuses on the happy path, because identity is Phase 12", async () => {
    await expect(attempt({ mode: "live", customerSlug: "acme" }))
      .rejects.toThrow(/identity_unavailable/);
  });

  // The bot token is present and usable in this environment, which is exactly
  // why this matters: refusing has to be a decision, not an accident of a
  // missing credential.
  it("refuses even though a working bot token is available", async () => {
    expect(env.SLACK_BOT_TOKEN).toBeTruthy();
    const gateway = makeSlackGateway(env.DB, slackScope);
    const err = await gateway.reply("hi", "key").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as CapabilityError).code).toBe("identity_unavailable");
    // And it never leaks the credential it declined to use.
    expect((err as CapabilityError).message).not.toContain(env.SLACK_BOT_TOKEN);
  });
});

describe("slack targets are unspoofable", () => {
  it.each([
    ["channel", { text: "hi", channel: "C_OTHER" }],
    ["channelId", { text: "hi", channelId: "C_OTHER" }],
    ["thread_ts", { text: "hi", thread_ts: "1.1" }],
    ["threadTs", { text: "hi", threadTs: "1.1" }],
    ["user", { text: "hi", user: "U_OTHER" }],
    ["actor", { text: "hi", actor: "U_OTHER" }],
    ["token", { text: "hi", token: "xoxp-leak" }],
  ])("rejects a %s argument at runtime, not just in the types", async (_label, args) => {
    const channelId = await seedChannel("live", "acme");
    const ts = "1712345678.002000";
    const runId = await seedRun(channelId, ts, false);
    await expect(call(slackTools(scopeFor(channelId, ts, runId)), "reply", args))
      .rejects.toThrow(/invalid_input/);
  });
});
