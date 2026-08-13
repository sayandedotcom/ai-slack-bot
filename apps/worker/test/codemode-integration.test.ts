import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeRunCodeTool, type CodeModeOutput } from "../src/codemode/tool";
import { makeSupabaseReader } from "../src/supabase/reader";
import {
  alwaysFresh,
  PRODUCTION_LIMITS,
  type CodeModeLimits,
  type CodeModeScope,
} from "../src/codemode/contracts";
import {
  fakeAuditSink,
  fakeDeps,
  slackScope,
  TEST_LIMITS,
  type FakeFixtures,
} from "./helpers/codemode";

// The AI SDK types execute() as PromiseLike<OUT> | AsyncIterable<OUT>, since a
// tool may stream. Ours never does, so narrow once here rather than at every
// assertion.
//
// A distinct toolCallId per call, because that is what the SDK does and what
// the nested audit ids are derived from: reusing one would make this helper
// quietly hide the collision that test/codemode-isolation.test.ts exists to
// catch.
const run = async (
  t: ReturnType<typeof makeRunCodeTool>,
  code: string,
): Promise<CodeModeOutput> =>
  (await t.execute!({ code }, {
    toolCallId: `call_${crypto.randomUUID()}`,
    messages: [],
  } as never)) as CodeModeOutput;

const tool = (
  fixtures: FakeFixtures = {},
  audit = fakeAuditSink(),
  scope: CodeModeScope = slackScope,
  limits: CodeModeLimits = TEST_LIMITS,
) =>
  makeRunCodeTool({
    scope,
    deps: { ...fakeDeps(fixtures), db: env.DB },
    limits,
    auditForExecution: () => audit,
    guard: alwaysFresh(),
    loader: env.LOADER,
  });

describe("the tool surface Phase 10 receives", () => {
  it("is exactly one tool named run_code", () => {
    const tools = { run_code: tool() };
    expect(Object.keys(tools)).toEqual(["run_code"]);
  });

  it("does not expose any provider as a model tool", () => {
    const tools = { run_code: tool() };
    for (const ns of ["slack", "memory", "linear", "supabase",
                      "langsmith", "betterstack", "files"]) {
      expect(Object.keys(tools)).not.toContain(ns);
    }
  });

  it("accepts exactly { code: string } and no execution knobs", async () => {
    const schema = tool().inputSchema as unknown as {
      safeParseAsync: (v: unknown) => Promise<{ success: boolean }>;
    };
    await expect(schema.safeParseAsync({ code: "async () => 1" }))
      .resolves.toMatchObject({ success: true });
    for (const knob of ["ts", "timeout", "network", "bindings", "actor", "scope",
                        "globalOutbound", "limits"]) {
      const out = await schema.safeParseAsync({ code: "async () => 1", [knob]: 1 });
      expect(out.success, `${knob} must be rejected`).toBe(false);
    }
  });

  it("refuses oversized code before loading a Worker", async () => {
    const out = await run(tool(), `async () => { /* ${"x".repeat(TEST_LIMITS.maxCodeChars + 1)} */ }`);
    expect(JSON.stringify(out)).toMatch(/output_too_large|invalid_input/);
  });

  it("embeds the generated declarations in its description", () => {
    const description = tool().description ?? "";
    expect(description).toContain("declare const slack: {");
    expect(description).toContain("declare const files: {");
    expect(description).not.toContain("{{types}}");   // placeholder was replaced
  });

  // The model is told to shorten an over-long program (agent/loop.ts's
  // SCHEMA_REFUSAL) and the SDK message that carried the number is suppressed
  // before it gets there, so the number has to be here — RENDERED, not typed.
  // A hardcoded "24000" in the prose is the defect, not the fix, which is why
  // this asserts the rendered text FOLLOWS the configured limit rather than
  // matching a literal.
  it("states the code cap, derived from the configured limit", () => {
    const other: CodeModeLimits = { ...TEST_LIMITS, maxCodeChars: 4_321 };
    expect(TEST_LIMITS.maxCodeChars).not.toBe(other.maxCodeChars);

    const asConfigured = tool().description ?? "";
    const asOverridden = tool(undefined, undefined, undefined, other).description ?? "";

    expect(asConfigured).toContain(`at most ${TEST_LIMITS.maxCodeChars} characters`);
    expect(asOverridden).toContain(`at most ${other.maxCodeChars} characters`);
    // The old number is gone, so the sentence cannot be a hardcoded constant
    // that happens to agree with one of the two configurations.
    expect(asOverridden).not.toContain(String(TEST_LIMITS.maxCodeChars));
    expect(asConfigured).not.toContain("{{maxCodeChars}}");   // placeholder was replaced
  });

  // Production ships the same rendering, so the number the model reads is the
  // number `z.string().max()` enforces.
  it("states the production cap when given production limits", () => {
    const production = makeRunCodeTool({
      scope: slackScope,
      deps: { ...fakeDeps(), db: env.DB },
      limits: PRODUCTION_LIMITS,
      auditForExecution: () => fakeAuditSink(),
      guard: alwaysFresh(),
      loader: env.LOADER,
    });
    const description = typeof production.description === "string" ? production.description : "";
    expect(description).toContain(`at most ${PRODUCTION_LIMITS.maxCodeChars} characters`);
  });

  it("tells the model it is writing JavaScript and has no network", () => {
    const description = tool().description ?? "";
    expect(description).toMatch(/JAVASCRIPT/i);
    expect(description).toMatch(/no network|every call is refused/i);
  });

  // Phase 10's system prompt teaches escalation; the tool must not imply one.
  it("states no approval policy", () => {
    const description = tool().description ?? "";
    expect(description).not.toMatch(/approv/i);
  });

  it("never puts a credential in the description", () => {
    const description = tool().description ?? "";
    expect(description).not.toMatch(/xox[bp]-|sk-ant|lin_api_|lsv2_|sb_publishable|Bearer /);
  });
});

// The test that proves Code Mode earns its place: five capability calls, one
// model turn, joined in code rather than across round trips.
describe("chaining capabilities in one execution", () => {
  it("chains five capabilities with no model round trip", async () => {
    const audit = fakeAuditSink();
    const scope: CodeModeScope = { ...slackScope, customerSlug: "acme" };
    const fixtures: FakeFixtures = {
      slackThread: [
        { ts: "1.0", userId: "U_CUST", text: "checkout is timing out", permalink: "https://s/1" },
        { ts: "2.0", userId: "U_CUST", text: "started around 09:00", permalink: "https://s/2" },
      ],
      memoryFacts: [{ factId: "f1", fact: "acme uses the legacy checkout", episodeUuids: ["e1"] }],
      supabaseRows: [{ id: 1, status: "failed" }, { id: 2, status: "ok" }],
      logLines: [{ at: "2026-08-11T09:01:00Z", level: "error", message: "upstream timeout" }],
    };

    // A real reader over a fixture allowlist, so select() is genuinely bounded.
    const deps = {
      ...fakeDeps(fixtures),
      db: env.DB,
      supabase: makeSupabaseReader(
        {
          url: "https://proj.supabase.co",
          key: "sb_publishable_test",
          allowlist: [{
            resource: "orders",
            columns: [{ name: "id", type: "int" }, { name: "status", type: "text" }],
            tenantColumn: null,
          }],
        },
        scope,
      ),
    };
    // The reader would really fetch; give it the fixture rows.
    deps.supabase = {
      async describe() { return []; },
      async select() { return fixtures.supabaseRows!; },
    };

    const runCodeTool = makeRunCodeTool({
      scope, deps, limits: TEST_LIMITS,
      auditForExecution: () => audit,
      guard: alwaysFresh(),
      loader: env.LOADER,
    });

    const program = `async () => {
      const thread = await slack.thread({ limit: 20 });
      const facts  = await memory.recall({ query: "checkout", scope: "customer" });
      const cites  = await memory.cite({ factIds: facts.map(f => f.factId) });
      const rows   = await supabase.select({ resource: "orders", limit: 50 });
      const logs   = await betterstack.logs({ query: "level:error", since: "2026-08-11T00:00:00Z" });
      console.log("gathered", thread.length, rows.length, logs.length);
      // The whole point: join and filter HERE, not across model turns.
      const failed = rows.filter(r => r.status === "failed");
      return {
        messageCount: thread.length,
        failedOrders: failed.length,
        citation: cites.length,
        firstError: logs.length > 0 ? logs[0].message : null,
      };
    }`;

    const out = (await runCodeTool.execute!({ code: program }, {
      toolCallId: "call_chain",
      messages: [],
    } as never)) as CodeModeOutput;

    expect(out.error).toBeUndefined();
    expect(out.result).toEqual({
      messageCount: 2, failedOrders: 1, citation: 0, firstError: "upstream timeout",
    });
    expect(out.logs.join(" ")).toContain("gathered 2 2 1");

    // Five nested capability calls, in program order, under ONE outer execution.
    const completed = audit.events.filter((e) => e.kind === "completed");
    expect(completed.map((e) => `${e.namespace}.${e.method}`)).toEqual([
      "slack.thread", "memory.recall", "memory.cite",
      "supabase.select", "betterstack.logs",
    ]);
    expect(completed.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(out.metrics.capabilityCalls).toBe(5);

    // No credential or binding reached the result or the audit trail.
    const serialized = JSON.stringify({ out, events: audit.events });
    for (const forbidden of ["xoxb-", "xoxp-", "Bearer ", "postgres://", "ZEP_API_KEY",
                             "sb_publishable", "lin_api_", "lsv2_"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("reports duration and call count even when the program fails", async () => {
    const out = await run(tool(), "async () => { await slack.thread({}); throw new Error('boom'); }");
    expect(out.error).toBeTruthy();
    expect(out.metrics.capabilityCalls).toBe(1);
    expect(out.metrics.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("normal agent mistakes come back correctable", () => {
  it.each([
    ["a syntax error",         "async () => { return ( }",                     /SyntaxError|Unexpected/],
    ["a misspelled namespace", "async () => await slak.thread({})",            /slak is not defined/],
    ["an unknown method",      "async () => await slack.nope({})",             /not found/i],
    ["invalid provider args",  "async () => await slack.reply({ text: 42 })",  /invalid_input/],
    ["a refused write",        "async () => await slack.reply({ text: 'hi' })",/channel_read_only/],
    ["a non-serializable return", "async () => (() => 1)",                     /invalid_input/],
  ])("returns a correctable error for %s", async (_label, code, pattern) => {
    const out = await run(tool(), code);
    const text = out.error ?? JSON.stringify(out.result);
    expect(text).toMatch(pattern);
    expect(text.length).toBeLessThan(2000);      // an error, not a memory dump
    expect(text).not.toMatch(/at Object\.|node_modules|\/src\//);   // no stack paths
  });

  // normalizeCode() in the package strips fences and wraps a bare expression.
  // Assert the BEHAVIOUR, so a package change surfaces here not in production.
  it("tolerates a fenced code block", async () => {
    const out = await run(tool(), "```js\nasync () => 41 + 1\n```");
    expect(out.error).toBeUndefined();
    expect(out.result).toBe(42);
  });

  it("tolerates a bare expression", async () => {
    const out = await run(tool(), "1 + 1");
    expect(out.error).toBeUndefined();
    expect(out.result).toBe(2);
  });
});

describe("the factory hands out nothing else", () => {
  it("exposes no gateway, loader, or executor constructor", async () => {
    const module = await import("../src/codemode/tool");
    // Types are erased at runtime, so only the value exports appear here.
    expect(Object.keys(module).sort()).toEqual(
      ["makeRunCodeTool", "renderCapabilityDeclarations", "safeMessage"].sort(),
    );
  });

  // Two factories is the WEAK version of this claim and it passed even while
  // one tool instance shared a counter across every execution. The claim that
  // matters — one instance, two executions — lives in
  // test/codemode-isolation.test.ts. This one is kept because it is still true
  // and cheap, not because it is sufficient.
  it("builds a fresh registry per invocation", async () => {
    // The call budget is per execution: two tools must not share a counter.
    const a = tool();
    const b = tool();
    await run(a, "async () => { await slack.thread({}); return 1; }");
    const out = await run(b, "async () => { await slack.thread({}); return 2; }");
    expect(out.metrics.capabilityCalls).toBe(1);
  });
});
