import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeRunCodeTool, type CodeModeOutput } from "../src/codemode/tool";
import {
  alwaysFresh,
  type AgentExecutionGuard,
  type CodeModeScope,
} from "../src/codemode/contracts";
import { staleGeneration } from "../src/codemode/bindings/shared";
import type { SlackGateway } from "../src/codemode/gateways";
import {
  fakeAuditSink,
  fakeDeps,
  slackScope,
  TEST_LIMITS,
  type FakeAuditSink,
  type FakeFixtures,
} from "./helpers/codemode";

/**
 * One tool instance, two executions.
 *
 * Every test in this file constructs the tool ONCE and calls `execute` twice.
 * That is the whole point: a test that builds two factories proves nothing,
 * because the defect this file exists to prevent is state captured by the
 * factory and shared by every execution it hands out. An agent loop calls one
 * tool instance repeatedly — this is the shape production has.
 */

type ExecuteOptions = {
  toolCallId: string;
  abortSignal?: AbortSignal;
};

const run = async (
  t: ReturnType<typeof makeRunCodeTool>,
  code: string,
  options: ExecuteOptions,
): Promise<CodeModeOutput> =>
  (await t.execute!({ code }, {
    ...options,
    messages: [],
  } as never)) as CodeModeOutput;

function makeTool(input: {
  audit: FakeAuditSink;
  fixtures?: FakeFixtures;
  scope?: CodeModeScope;
  slack?: SlackGateway;
  wallTimeMs?: number;
  guard?: AgentExecutionGuard;
}) {
  return makeRunCodeTool({
    scope: input.scope ?? slackScope,
    deps: {
      ...fakeDeps(input.fixtures ?? {}),
      db: env.DB,
      ...(input.slack ? { slack: input.slack } : {}),
    },
    limits: { ...TEST_LIMITS, wallTimeMs: input.wallTimeMs ?? TEST_LIMITS.wallTimeMs },
    // One sink per execution, tied to that execution's outer tool call. The
    // recorder underneath is shared so the test can compare the two streams.
    auditForExecution: () => input.audit,
    guard: input.guard ?? alwaysFresh(),
    loader: env.LOADER,
  });
}

describe("two executions of ONE run_code tool are isolated", () => {
  it("gives each execution its own capability counter", async () => {
    const audit = fakeAuditSink();
    const t = makeTool({ audit });

    const a = await run(t, "async () => { await slack.thread({}); await slack.thread({}); return 'a'; }", {
      toolCallId: "call_a",
    });
    const b = await run(t, "async () => { await slack.thread({}); return 'b'; }", {
      toolCallId: "call_b",
    });

    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    // Each execution reports ONLY its own work. A shared counter reports 3 here.
    expect(a.metrics.capabilityCalls).toBe(2);
    expect(b.metrics.capabilityCalls).toBe(1);
  });

  it("restarts the per-execution call budget", async () => {
    const audit = fakeAuditSink();
    const t = makeTool({ audit });
    const burn = `async () => {
      const seen = [];
      for (let i = 0; i < 6; i++) {
        try { await slack.thread({}); seen.push("ok"); }
        catch (e) { seen.push(e.message.split(":")[0]); }
      }
      return seen;
    }`;

    // TEST_LIMITS allows 8 calls. Six then six must both be entirely allowed:
    // a budget shared across executions refuses four of the second six.
    const a = await run(t, burn, { toolCallId: "call_a" });
    const b = await run(t, burn, { toolCallId: "call_b" });

    expect((a.result as string[]).filter((s) => s === "ok")).toHaveLength(6);
    expect((b.result as string[]).filter((s) => s === "ok")).toHaveLength(6);
  });

  it("does not let a fact recalled in one execution be cited in another", async () => {
    const audit = fakeAuditSink();
    const t = makeTool({
      audit,
      fixtures: {
        memoryFacts: [
          { factId: "f1", fact: "acme uses the legacy checkout", episodeUuids: ["e1"] },
        ],
      },
    });

    const a = await run(
      t,
      `async () => (await memory.recall({ query: "checkout", scope: "customer" })).length`,
      { toolCallId: "call_a" },
    );
    expect(a.result).toBe(1);

    // B never recalled f1. The citation cache is execution-local, so citing it
    // here must be refused — citations are the one thing that must be exact.
    const b = await run(
      t,
      `async () => {
        try { await memory.cite({ factIds: ["f1"] }); return "CITED"; }
        catch (e) { return "REFUSED:" + e.message; }
      }`,
      { toolCallId: "call_b" },
    );
    expect(String(b.result)).toMatch(/^REFUSED:invalid_input/);
  });

  it("scopes nested capability ids to their outer tool call", async () => {
    const audit = fakeAuditSink();
    const t = makeTool({ audit });

    await run(t, "async () => { await slack.thread({}); return 1; }", { toolCallId: "call_a" });
    await run(t, "async () => { await slack.thread({}); return 2; }", { toolCallId: "call_b" });

    const started = audit.events.filter((e) => e.kind === "started");
    // Not two colliding `cap:1`s: each nested call is addressable by the outer
    // tool call it belongs to, which is what makes an audit trail reconstructable
    // once one loop issues many run_code calls.
    expect(started.map((e) => e.callId)).toEqual(["cap:call_a:1", "cap:call_b:1"]);
    expect(new Set(audit.events.map((e) => e.callId)).size).toBe(2);
  });

  it("does not let one execution's abort signal cancel another", async () => {
    const audit = fakeAuditSink();
    const t = makeTool({ audit });

    const aborted = new AbortController();
    aborted.abort();
    const a = await run(t, "async () => 1", {
      toolCallId: "call_a",
      abortSignal: aborted.signal,
    });
    expect(a.error).toMatch(/execution_timeout/);

    // A second execution of the SAME tool is unaffected by the first's signal.
    const b = await run(t, "async () => 2", {
      toolCallId: "call_b",
      abortSignal: new AbortController().signal,
    });
    expect(b.error).toBeUndefined();
    expect(b.result).toBe(2);
  });

  /**
   * The guard has two call sites and both matter. The chokepoint one is proved
   * in codemode-contracts.test.ts; this is the outer one, which is what stops a
   * superseded step paying for a Worker load at all.
   */
  it("refuses a superseded execution before the isolate starts", async () => {
    const audit = fakeAuditSink();
    let asked = 0;
    const t = makeTool({
      audit,
      guard: { async assertFresh() { asked += 1; throw staleGeneration(); } },
    });

    const out = await run(t, "async () => { await slack.thread({}); return 1; }", {
      toolCallId: "call_a",
    });
    expect(out.error).toMatch(/^stale_generation: /);
    // The program never ran, so the guard was asked exactly once — by the outer
    // check, not by a capability the isolate reached.
    expect(asked).toBe(1);
    expect(out.metrics.capabilityCalls).toBe(0);
    expect(audit.events).toEqual([]);
  });

  it("does not leave a stale refusal blocking the next execution", async () => {
    const audit = fakeAuditSink();
    let fresh = false;
    const t = makeTool({
      audit,
      guard: { async assertFresh() { if (!fresh) throw staleGeneration(); } },
    });

    const a = await run(t, "async () => 1", { toolCallId: "call_a" });
    expect(a.error).toMatch(/stale_generation/);

    // The tool instance is not poisoned: the next step, on current input, runs.
    fresh = true;
    const b = await run(t, "async () => 2", { toolCallId: "call_b" });
    expect(b.error).toBeUndefined();
    expect(b.result).toBe(2);
  });

  // Step 6: the same claims, but with both executions genuinely in flight.
  it("keeps two concurrent executions of one tool independent", async () => {
    const audit = fakeAuditSink();

    let entered = 0;
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Neither execution can finish its first capability call until BOTH have
    // started one, so the interleaving the counter must survive is guaranteed
    // rather than hoped for.
    const slack: SlackGateway = {
      async thread() {
        entered += 1;
        if (entered === 2) release();
        await barrier;
        return [];
      },
      async searchMessages() { return []; },
      async reply() { return { ts: "1.0", permalink: null }; },
    };

    const t = makeTool({ audit, slack, wallTimeMs: 5_000 });
    const [a, b] = await Promise.all([
      run(t, "async () => { await slack.thread({}); return 'a'; }", { toolCallId: "call_a" }),
      run(t, "async () => { await slack.thread({}); return 'b'; }", { toolCallId: "call_b" }),
    ]);

    expect(a.result).toBe("a");
    expect(b.result).toBe("b");
    expect(a.metrics.capabilityCalls).toBe(1);
    expect(b.metrics.capabilityCalls).toBe(1);
    expect(audit.events.filter((e) => e.kind === "started").map((e) => e.callId).sort())
      .toEqual(["cap:call_a:1", "cap:call_b:1"]);
  });
});
