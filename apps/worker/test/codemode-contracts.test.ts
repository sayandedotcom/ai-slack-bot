import { describe, expect, it } from "vitest";
import {
  toSafeJson,
  validateScope,
  type AgentExecutionGuard,
  type CapabilityFailed,
} from "../src/codemode/contracts";
import { CapabilityError, safeMessage } from "../src/codemode/errors";
import { staleGeneration, withCapabilityAudit } from "../src/codemode/bindings/shared";
import { fakeAuditSink, TEST_LIMITS, testExecution } from "./helpers/codemode";

const slackScope = {
  runId: "run_1",
  turnId: "turn_1",
  origin: "slack" as const,
  shadow: false,
  customerSlug: "acme",
  slackThread: { channelId: "C123", threadTs: "1712345678.000100" },
  actor: { engineerEmail: "eng@example.com", slackUserId: "U1" },
};

describe("validateScope", () => {
  it("accepts a well-formed Slack scope unchanged", () => {
    expect(validateScope(slackScope)).toEqual(slackScope);
  });

  it("requires a Slack target when origin is slack", () => {
    expect(() => validateScope({ ...slackScope, slackThread: null }))
      .toThrow(CapabilityError);
  });

  it("allows a Chat run with no Slack target", () => {
    const chat = { ...slackScope, origin: "chat" as const, slackThread: null };
    expect(validateScope(chat).slackThread).toBeNull();
  });

  it("allows a missing actor — Phase 12 supplies it", () => {
    expect(validateScope({ ...slackScope, actor: null }).actor).toBeNull();
  });

  // The smuggling case. An extra field must be rejected, never ignored:
  // silently dropping it invites a later refactor to start reading it.
  it("rejects unknown fields so a caller cannot smuggle a token in", () => {
    expect(() => validateScope({ ...slackScope, slackToken: "xoxp-leak" }))
      .toThrow(/invalid_context/);
  });

  it("does not echo a rejected value back in the error message", () => {
    try {
      validateScope({ ...slackScope, slackToken: "xoxp-leak" });
      expect.unreachable("validateScope should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain("xoxp-leak");
    }
  });

  it.each([
    ["blank runId", { runId: "" }],
    ["oversized customerSlug", { customerSlug: "x".repeat(300) }],
    ["non-boolean shadow", { shadow: "false" }],
    ["malformed threadTs", { slackThread: { channelId: "C1", threadTs: "nope" } }],
  ])("rejects %s", (_label, patch) => {
    expect(() => validateScope({ ...slackScope, ...patch })).toThrow(CapabilityError);
  });
});

describe("toSafeJson", () => {
  it("passes small structured values through unchanged", () => {
    const value = { ok: true, count: 2, items: ["a", "b"], nothing: null };
    expect(toSafeJson(value, TEST_LIMITS)).toEqual(value);
  });

  it.each([
    ["bigint", 1n],
    ["function", () => {}],
    ["symbol", Symbol("s")],
    ["Error", new Error("boom")],
    ["Response", new Response("x")],
    ["Request", new Request("https://example.com")],
    ["class instance", new (class Foo { bar = 1 })()],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects %s", (_label, value) => {
    expect(() => toSafeJson(value, TEST_LIMITS)).toThrow(/invalid_input/);
  });

  it("rejects a cyclic value rather than hanging", () => {
    const cycle: Record<string, unknown> = { name: "loop" };
    cycle.self = cycle;
    expect(() => toSafeJson(cycle, TEST_LIMITS)).toThrow(/invalid_input/);
  });

  it("rejects nesting deeper than the protocol's JsonValue allows", () => {
    expect(() => toSafeJson({ a: { b: { c: { d: 1 } } } }, TEST_LIMITS))
      .toThrow(/invalid_input/);
  });

  it("accepts nesting exactly at the protocol's limit", () => {
    const atLimit = { a: { b: { c: 1 } } };
    expect(toSafeJson(atLimit, TEST_LIMITS)).toEqual(atLimit);
  });

  it("rejects an object whose toJSON() throws", () => {
    const hostile = { toJSON() { throw new Error("nope"); } };
    expect(() => toSafeJson(hostile, TEST_LIMITS)).toThrow(/invalid_input/);
  });

  it("does not let prototype-pollution keys through", () => {
    const parsed = JSON.parse('{"__proto__":{"polluted":true},"ok":1}');
    const safe = toSafeJson(parsed, TEST_LIMITS) as Record<string, unknown>;
    expect(safe).toEqual({ ok: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects Uint8Array as an ordinary result", () => {
    expect(() => toSafeJson(new Uint8Array([1, 2]), TEST_LIMITS))
      .toThrow(/invalid_input/);
  });

  it("refuses a result past maxResultChars", () => {
    const big = { blob: "x".repeat(TEST_LIMITS.maxResultChars + 1) };
    expect(() => toSafeJson(big, TEST_LIMITS)).toThrow(/output_too_large/);
  });
});

describe("safeMessage", () => {
  it("serializes a CapabilityError as `code: message`", () => {
    const err = new CapabilityError("channel_read_only", "Slack replies are disabled for #ref (mode=observe).");
    expect(safeMessage(err)).toBe(
      "channel_read_only: Slack replies are disabled for #ref (mode=observe).",
    );
  });

  // Only `message` survives ToolDispatcher, so the code must be IN the message.
  it("keeps the code recoverable after a message-only round trip", () => {
    const err = new CapabilityError("customer_scope_required", "Ask which customer this concerns.");
    const rethrown = new Error(safeMessage(err));       // what the sandbox does
    expect(rethrown.message).toMatch(/^customer_scope_required: /);
  });

  it("maps an unknown error to one safe code and leaks nothing", () => {
    const upstream = new Error("PG connect failed: postgres://user:hunter2@db/prod");
    const out = safeMessage(upstream);
    expect(out).toMatch(/^upstream_unavailable: /);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("postgres://");
    expect(out).not.toContain("at Object.");           // no stack frames
  });
});

describe("withCapabilityAudit", () => {
  it("emits started then completed, in order", async () => {
    const audit = fakeAuditSink();
    const run = () => withCapabilityAudit(
      testExecution({ audit }), slackScope,
      "slack", "thread", async () => [{ ts: "1.0", text: "hi" }],
    );
    await expect(run()).resolves.toEqual([{ ts: "1.0", text: "hi" }]);
    expect(audit.events.map((e) => e.kind)).toEqual(["started", "completed"]);
  });

  it("emits started then failed exactly once on throw", async () => {
    const audit = fakeAuditSink();
    await expect(withCapabilityAudit(
      testExecution({ audit }), slackScope, "slack", "reply",
      async () => { throw new CapabilityError("channel_read_only", "no"); },
    )).rejects.toThrow(/channel_read_only/);
    expect(audit.events.map((e) => e.kind)).toEqual(["started", "failed"]);
  });

  // Defense in depth: an adapter that forgets to translate must not be the
  // reason a connection string reaches the model.
  it("converts an untranslated upstream error into a safe one", async () => {
    const audit = fakeAuditSink();
    await expect(withCapabilityAudit(
      testExecution({ audit }), slackScope, "supabase", "query",
      async () => { throw new Error("PG connect failed: postgres://u:hunter2@db/prod"); },
    )).rejects.toThrow(/^upstream_unavailable: /);
    expect(JSON.stringify(audit.events)).not.toContain("hunter2");
  });

  it("refuses past maxCapabilityCalls before making the host call", async () => {
    const audit = fakeAuditSink();
    const execution = testExecution({
      audit, limits: { ...TEST_LIMITS, maxCapabilityCalls: 2 },
    });
    let hostCalls = 0;
    const call = () => withCapabilityAudit(
      execution, slackScope, "slack", "thread",
      async () => { hostCalls += 1; return []; },
    );
    await call();
    await call();
    await expect(call()).rejects.toThrow(/capability_unavailable/);
    expect(hostCalls).toBe(2);          // the third never reached the host
  });

  it("counts correctly when reads run concurrently", async () => {
    const audit = fakeAuditSink();
    const execution = testExecution({
      audit, limits: { ...TEST_LIMITS, maxCapabilityCalls: 10 },
    });
    await Promise.all([1, 2, 3, 4].map(() => withCapabilityAudit(
      execution, slackScope, "slack", "thread", async () => [],
    )));
    expect(audit.events.filter((e) => e.kind === "completed")).toHaveLength(4);
  });

  it("gives every call in one execution a distinct sequence", async () => {
    const audit = fakeAuditSink();
    const execution = testExecution({ audit });
    await Promise.all([1, 2, 3, 4].map(() => withCapabilityAudit(
      execution, slackScope, "slack", "thread", async () => [],
    )));
    const seqs = audit.events.filter((e) => e.kind === "started").map((e) => e.seq);
    expect(new Set(seqs).size).toBe(4);
  });

  // The seq alone is not an identity once one agent loop makes many run_code
  // calls: every execution's first call is seq 1.
  it("addresses each call by its outer tool call, not just its sequence", async () => {
    const audit = fakeAuditSink();
    const execution = testExecution({ audit, outerToolCallId: "call_xyz" });
    await withCapabilityAudit(execution, slackScope, "slack", "thread", async () => []);
    await withCapabilityAudit(execution, slackScope, "slack", "thread", async () => []);
    expect(audit.events.filter((e) => e.kind === "started").map((e) => e.callId))
      .toEqual(["cap:call_xyz:1", "cap:call_xyz:2"]);
  });

  it("never lets a secret-shaped argument into an audit event", async () => {
    const audit = fakeAuditSink();
    await withCapabilityAudit(
      testExecution({ audit }), slackScope,
      "slack", "reply", async () => ({ ts: "1.0" }),
      { token: "xoxb-should-never-appear", apiKey: "Bearer abc" },
    );
    expect(JSON.stringify(audit.events)).not.toMatch(/xox[bp]-|Bearer |api[_-]?key/i);
  });

  it("keeps two interleaved invocations' scopes separate", async () => {
    const a = { ...slackScope, runId: "run_a", customerSlug: "acme",
                slackThread: { channelId: "C_A", threadTs: "1.1" } };
    const b = { ...slackScope, runId: "run_b", customerSlug: "globex",
                slackThread: { channelId: "C_B", threadTs: "2.2" } };

    const auditA = fakeAuditSink();
    const auditB = fakeAuditSink();
    const call = (scope: typeof a, audit: ReturnType<typeof fakeAuditSink>) =>
      withCapabilityAudit(testExecution({ audit }), scope, "slack", "thread",
        async () => { await new Promise((r) => setTimeout(r, 1)); return [scope.customerSlug]; });

    const [ra, rb] = await Promise.all([call(a, auditA), call(b, auditB)]);
    expect(ra).toEqual(["acme"]);
    expect(rb).toEqual(["globex"]);
    expect(JSON.stringify(auditA.events)).not.toMatch(/globex|run_b|C_B/);
    expect(JSON.stringify(auditB.events)).not.toMatch(/acme|run_a|C_A/);
  });
});

/**
 * The freshness seam. Task 8 supplies the RunDO-generation implementation; what
 * is provable here is that the chokepoint asks, that a refusal is recorded, and
 * that the refusal proves nothing left this Worker.
 */
describe("the execution guard", () => {
  const stale: AgentExecutionGuard = {
    async assertFresh() { throw staleGeneration(); },
  };

  it("is asked before the capability body runs", async () => {
    const audit = fakeAuditSink();
    let hostCalls = 0;
    await expect(withCapabilityAudit(
      testExecution({ audit, guard: stale }), slackScope, "slack", "reply",
      async () => { hostCalls += 1; return { ts: "1.0" }; },
    )).rejects.toThrow(/^stale_generation: /);
    expect(hostCalls).toBe(0);              // the send never reached the host
  });

  it("records the refusal rather than swallowing it", async () => {
    const audit = fakeAuditSink();
    await expect(withCapabilityAudit(
      testExecution({ audit, guard: stale }), slackScope, "slack", "thread",
      async () => [],
    )).rejects.toThrow(CapabilityError);
    // Both events, so an operator can see that a superseded generation kept
    // calling capabilities — a refusal with no trace looks like no call at all.
    expect(audit.events.map((e) => e.kind)).toEqual(["started", "failed"]);
    const failed = audit.events.find((e) => e.kind === "failed") as CapabilityFailed;
    expect(failed.code).toBe("stale_generation");
    expect(failed.retryable).toBe(false);
  });

  it("does not hand the model the newer input's text", async () => {
    // The steer is the next step's business. Naming it here would put
    // unreviewed content into an error string that also reaches the audit log.
    expect(staleGeneration().message).toMatch(/^stale_generation: /);
    expect(staleGeneration().message).toMatch(/newer input/i);
    expect(staleGeneration().message.length).toBeLessThan(300);
  });

  it("counts a refused call against the budget", async () => {
    const audit = fakeAuditSink();
    const execution = testExecution({ audit, guard: stale });
    await expect(withCapabilityAudit(
      execution, slackScope, "slack", "thread", async () => [],
    )).rejects.toThrow(/stale_generation/);
    expect(execution.counter.used).toBe(1);
  });
});

describe("customer references are execution-local", () => {
  it("resolves a reference minted in the same execution", () => {
    const execution = testExecution({ audit: fakeAuditSink() });
    const reference = execution.customers.mint("acme");
    expect(execution.customers.resolve(reference)).toBe("acme");
  });

  it("does not resolve a reference minted in another execution", () => {
    const a = testExecution({ audit: fakeAuditSink() });
    const b = testExecution({ audit: fakeAuditSink() });
    const reference = a.customers.mint("acme");
    // The whole point: one tool call's handle is meaningless in the next one.
    expect(() => b.customers.resolve(reference)).toThrow(/invalid_input/);
  });

  it("mints unguessable references rather than sequential ones", () => {
    const execution = testExecution({ audit: fakeAuditSink() });
    const first = execution.customers.mint("acme");
    const second = execution.customers.mint("globex");
    expect(first).not.toBe(second);
    // `cust_1` would be trivially forgeable from another execution.
    expect(first).not.toMatch(/_\d+$/);
  });

  it("names neither the reference nor a slug when it refuses", () => {
    const a = testExecution({ audit: fakeAuditSink() });
    const b = testExecution({ audit: fakeAuditSink() });
    const reference = a.customers.mint("globex");
    try {
      b.customers.resolve(reference);
      expect.unreachable("resolve should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain(reference);
      expect((err as Error).message).not.toContain("globex");
    }
  });
});
