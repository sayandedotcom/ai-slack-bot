/**
 * The trace emitter wired into the REAL agent loop.
 *
 * `test/langsmith-tracer.test.ts` proves the tracer's own behaviour against
 * hand-fed spans. This proves the wiring: that a genuine continuation — real
 * `makeAgentContinuation`, real prompt build, real isolate running a real
 * program — produces the tree, and that turning it on changes nothing else.
 *
 * The property in the last test is the one that matters most. Telemetry that
 * can fail a run is worse than no telemetry.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetRunPorts } from "../src/agent/driver";
import { makeLangSmithTracer } from "../src/langsmith/tracer";
import type { LangSmithTracerConfig } from "../src/langsmith/tracer";
import { customerTurn, freshLoopRun, mockModel, textStep, toolStep } from "./helpers/agent-loop";

/** A program the real isolate runs. No capability, no vendor reached. */
const TRIVIAL = "async () => ({ ok: true })";

type WireRun = {
  id: string;
  trace_id: string;
  parent_run_id?: string;
  dotted_order: string;
  name: string;
  run_type: string;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: string;
  extra?: { metadata?: Record<string, unknown> };
};

let posted: Array<{ url: string; post: WireRun[] }> = [];

function stubLangSmith(behaviour: "ok" | "reject" = "ok") {
  posted = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    posted.push({
      url: String(url),
      post: (JSON.parse(String(init.body)) as { post: WireRun[] }).post,
    });
    if (behaviour === "reject") throw new TypeError("langsmith is unreachable");
    return new Response("{}", { status: 202 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetRunPorts();
});

function tracerConfig(patch: Partial<LangSmithTracerConfig> = {}): LangSmithTracerConfig {
  return {
    endpoint: "https://api.smith.langchain.com",
    apiKey: "not-a-real-langsmith-key",
    project: "fire-fighter",
    enabled: true,
    payloads: "redacted",
    ...patch,
  };
}

/** One tool step then one text step — the shape every incident actually takes. */
const toolThenText = () =>
  mockModel([
    toolStep({ toolCallId: "call_1", code: TRIVIAL, narration: ["Checking ", "the logs."] }),
    textStep({ chunks: ["The 04:12 deploy ", "renamed a column."] }),
  ]);

describe("agent loop -> langsmith trace", () => {
  it("emits one batch per continuation, with the root/llm/tool tree", async () => {
    stubLangSmith();
    const tracer = makeLangSmithTracer(tracerConfig(), () => Date.now());
    const harness = await freshLoopRun({ model: toolThenText(), tracer });

    await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    expect(harness.results[0].path).toBe("completed");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe("https://api.smith.langchain.com/runs/batch");

    const runs = posted[0]!.post;
    const roots = runs.filter((r) => r.run_type === "chain");
    const llms = runs.filter((r) => r.run_type === "llm");
    const tools = runs.filter((r) => r.run_type === "tool");

    expect(roots).toHaveLength(1);
    // Two model steps: the one that called the tool, and the one that answered.
    expect(llms).toHaveLength(2);
    expect(tools).toHaveLength(1);

    const root = roots[0]!;
    for (const child of [...llms, ...tools]) {
      expect(child.trace_id).toBe(root.id);
      expect(child.parent_run_id).toBe(root.id);
      expect(child.dotted_order.startsWith(`${root.dotted_order}.`)).toBe(true);
    }
    expect(root.outputs).toMatchObject({ outcome_path: "completed" });
  });

  it("carries the real usage, cost and gateway facts on each llm span", async () => {
    stubLangSmith();
    const tracer = makeLangSmithTracer(tracerConfig(), () => Date.now());
    const harness = await freshLoopRun({ model: toolThenText(), tracer });

    await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    for (const llm of posted[0]!.post.filter((r) => r.run_type === "llm")) {
      expect(llm.inputs).toMatchObject({ provider: "anthropic" });
      // The field the `/reason|thinking/` deny-pattern used to eat.
      expect(llm.outputs).toHaveProperty("finish_reason");
      expect(llm.outputs).toHaveProperty("cost_nano_usd");

      // TOKENS LIVE IN `outputs.usage_metadata`, NOWHERE ELSE. Measured against
      // live ingest: any other placement is accepted with 202 and silently
      // discarded, and the run then shows 0 tokens and $0.00 in the UI. Asserted
      // here on a REAL loop run rather than a hand-built span, because the bug
      // this replaces was exactly a hand-built span agreeing with itself while
      // the loop fed different field names through.
      const usage = llm.outputs!.usage_metadata as Record<string, unknown>;
      expect(usage).toBeDefined();
      for (const key of ["input_tokens", "output_tokens", "total_tokens"]) {
        expect(typeof usage[key]).toBe("number");
      }
      expect(usage.input_token_details).toMatchObject({
        cache_read: expect.any(Number),
        cache_creation: expect.any(Number),
      });
      // Our cost, in USD, consistent with the nano-USD figure beside it — the
      // property that keeps this column equal to `agent_model_calls` in D1.
      expect(usage.total_cost).toBeCloseTo(
        (llm.outputs!.cost_nano_usd as number) / 1_000_000_000,
        12,
      );
      expect((usage.input_cost as number) + (usage.output_cost as number))
        .toBeCloseTo(usage.total_cost as number, 12);

      // And the model is named where LangSmith looks, or it prices nothing.
      expect(llm.extra?.metadata).toMatchObject({
        ls_model_name: expect.any(String),
        ls_provider: "anthropic",
      });
    }
  });

  it("carries the program the model authored on the tool span", async () => {
    stubLangSmith();
    const tracer = makeLangSmithTracer(tracerConfig(), () => Date.now());
    const harness = await freshLoopRun({ model: toolThenText(), tracer });

    await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    const tool = posted[0]!.post.find((r) => r.run_type === "tool")!;
    expect(tool.name).toBe("run_code");
    expect(tool.inputs.code).toContain("ok: true");
    expect(tool.outputs).toMatchObject({ ok: true });
  });

  it('payloads:"none" emits the tree and the numbers but no prose', async () => {
    stubLangSmith();
    const tracer = makeLangSmithTracer(tracerConfig({ payloads: "none" }), () => Date.now());
    const harness = await freshLoopRun({ model: toolThenText(), tracer });

    await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    const wire = JSON.stringify(posted[0]!.post);
    expect(wire).not.toContain("renamed a column");
    expect(wire).not.toContain("ok: true");
    expect(wire).toContain("cost_nano_usd");
    expect(posted[0]!.post.filter((r) => r.run_type === "llm")).toHaveLength(2);
  });

  it("emits nothing at all when no tracer is installed", async () => {
    stubLangSmith();
    const harness = await freshLoopRun({ model: toolThenText() });

    await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    expect(harness.results[0].path).toBe("completed");
    expect(posted).toHaveLength(0);
  });

  it("does not change the outcome path", async () => {
    stubLangSmith();
    const withTracer = await freshLoopRun({
      model: toolThenText(),
      tracer: makeLangSmithTracer(tracerConfig(), () => Date.now()),
    });
    await withTracer.stub.appendTurn(customerTurn("t1"));
    await withTracer.alarm();
    resetRunPorts();

    const without = await freshLoopRun({ model: toolThenText() });
    await without.stub.appendTurn(customerTurn("t1"));
    await without.alarm();

    // `finalTurnId` embeds the generation's own UUID, so it is different by
    // construction between two independent runs. The classification is what
    // must not move.
    const shape = (result: (typeof without.results)[number]) => ({
      path: result.path,
      errorCode: result.errorCode,
      hasFinalTurn: result.finalTurnId !== undefined,
    });
    expect(shape(withTracer.results[0])).toEqual(shape(without.results[0]));
  });

  it("completes the run when LangSmith is unreachable", async () => {
    // The whole justification for `ctx.waitUntil` and the swallowed catch. A
    // telemetry sink must never be able to fail a run — invariant 27 has one
    // retry owner and it is not this.
    stubLangSmith("reject");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tracer = makeLangSmithTracer(tracerConfig(), () => Date.now());
    const harness = await freshLoopRun({ model: toolThenText(), tracer });

    await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    expect(harness.results[0].path).toBe("completed");
    warn.mockRestore();
  });
});
