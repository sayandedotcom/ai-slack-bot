/**
 * The LangSmith trace EMITTER, in isolation.
 *
 * Three classes of property here, and they matter in this order:
 *
 *  1. **Containment.** A planted credential must never reach the wire. This is
 *     a new outbound sink, so it is a new surface for invariant 39, and
 *     `test/agent-canaries.test.ts` sweeps it end to end as well.
 *  2. **Totality.** No method throws, ever. They are called from `onStepEnd`
 *     and from inside the `run_code` execute wrapper; a throw there would fail
 *     a run over telemetry.
 *  3. **Shape.** One POST, correct header, correct tree.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeLangSmithTracer, makeNoopTracer } from "../src/langsmith/tracer";
import type { LangSmithTracerConfig } from "../src/langsmith/tracer";

const ENDPOINT = "https://api.smith.langchain.com";
const NOW = Date.parse("2026-08-17T12:00:00Z");

type Sent = { url: string; body: { post: WireRun[] }; headers: Headers; init: RequestInit };
type WireRun = {
  id: string;
  trace_id: string;
  parent_run_id?: string;
  dotted_order: string;
  name: string;
  run_type: string;
  start_time: string;
  end_time?: string;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: string;
  session_name: string;
  extra?: { metadata?: Record<string, unknown> };
};

let sent: Sent[] = [];

function stubFetch(status = 202) {
  sent = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({
      url: String(url),
      body: JSON.parse(String(init.body)) as { post: WireRun[] },
      headers: new Headers(init.headers),
      init,
    });
    return new Response("{}", { status });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function config(patch: Partial<LangSmithTracerConfig> = {}): LangSmithTracerConfig {
  return {
    endpoint: ENDPOINT,
    apiKey: "lsv2_pt_not_a_real_tracer_key",
    project: "fire-fighter",
    enabled: true,
    payloads: "none",
    ...patch,
  };
}

/** A tracer with the full three-level tree already recorded. */
function tracedRun(patch: Partial<LangSmithTracerConfig> = {}, promptText = "what broke?") {
  let at = NOW;
  const tracer = makeLangSmithTracer(config(patch), () => at);
  const root = tracer.startRoot({
    runId: "run-1",
    generationId: "gen-1",
    agentTurnId: "turn-1",
    attempt: 1,
    surface: "slack",
    startedAtMs: at,
  });
  const llm = tracer.startLlm(root, {
    stepNumber: 0,
    globalStep: 0,
    modelId: "claude-fable-5",
    provider: "anthropic",
    startedAtMs: at,
    promptText,
  });
  at += 1_200;
  tracer.endLlm(llm, {
    endedAtMs: at,
    usage: {
      inputTokens: 900,
      outputTokens: 120,
      totalTokens: 1_020,
      cacheReadTokens: 400,
      cacheWriteTokens: 50,
    },
    costNanoUsd: 42_000_000,
    outputCostNanoUsd: 18_000_000,
    latencyMs: 1_200,
    finishReason: "tool-calls",
    rawFinishReason: "tool_use",
    providerRequestId: "req_abc",
    gatewayLogId: "log_xyz",
    errorCode: null,
    outputText: "I will check the logs.",
  });
  const tool = tracer.startTool(root, {
    toolName: "run_code",
    toolCallId: "call-1",
    startedAtMs: at,
    code: "await slack.reply({ text: 'looking' });",
  });
  at += 800;
  tracer.endTool(tool, {
    endedAtMs: at,
    ok: true,
    durationMs: 800,
    capabilityCalls: 3,
    errorCode: null,
    resultPreview: "posted",
  });
  at += 50;
  tracer.endRoot(root, {
    endedAtMs: at,
    path: "completed",
    errorCode: null,
    finalTurnId: "turn-9",
  });
  return tracer;
}

describe("langsmith tracer — wire shape", () => {
  it("posts every span once, to /runs/batch, with x-api-key and never Authorization", async () => {
    stubFetch();
    const report = await tracedRun().flush();

    expect(report).toMatchObject({ outcome: "sent", posted: 3, dropped: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${ENDPOINT}/runs/batch`);
    expect(sent[0]!.init.method).toBe("POST");
    expect(sent[0]!.headers.get("x-api-key")).toBe("lsv2_pt_not_a_real_tracer_key");
    // LangSmith ignores a bearer token and fails the request as
    // unauthenticated. Sending both would work and hide the mistake.
    expect(sent[0]!.headers.get("authorization")).toBeNull();
  });

  it("pins every run to the configured project", async () => {
    stubFetch();
    await tracedRun().flush();
    for (const run of sent[0]!.body.post) expect(run.session_name).toBe("fire-fighter");
  });

  it("builds a tree: root is the trace, children hang off it in start order", async () => {
    stubFetch();
    const tracer = tracedRun();
    await tracer.flush();

    const [root, llm, tool] = sent[0]!.body.post;
    expect(root!.id).toBe(tracer.traceId);
    expect(root!.trace_id).toBe(tracer.traceId);
    expect(root!.parent_run_id).toBeUndefined();
    expect(root!.run_type).toBe("chain");

    for (const child of [llm!, tool!]) {
      expect(child.trace_id).toBe(tracer.traceId);
      expect(child.parent_run_id).toBe(tracer.traceId);
      expect(child.dotted_order.startsWith(`${root!.dotted_order}.`)).toBe(true);
    }
    expect(llm!.run_type).toBe("llm");
    expect(tool!.run_type).toBe("tool");
    // Ordering is the whole job of dotted_order, and it has to survive spans
    // that start in the same millisecond — which, under a fixed clock, is all
    // of them.
    expect(llm!.dotted_order < tool!.dotted_order).toBe(true);
  });

  it("stamps dotted_order with MICROSECONDS, which ingest requires", async () => {
    // MEASURED 2026-08-17: LangSmith parses this with the Go layout
    // `20060102T150405.000000` and rejects three-digit precision outright:
    //
    //   HTTP 400 invalid 'dotted_order': ... parsing time "20260817T083114.022"
    //   as "20060102T150405.000000": cannot parse ".022" as ".000000"
    //
    // `toISOString()` gives three, so they are padded to six. This is the only
    // assertion standing between a green suite and a feature that 400s on every
    // real request — `scripts/langsmith-seed.mjs` has the unpadded form and its
    // ingest has never succeeded.
    stubFetch();
    await tracedRun().flush();

    const stamp = /^\d{8}T\d{6}\d{6}Z$/;
    for (const run of sent[0]!.body.post) {
      for (const segment of run.dotted_order.split(".")) {
        expect(segment.slice(0, 22)).toMatch(stamp);
        // ...and the uuid follows the `Z`, un-truncated.
        expect(segment.slice(22)).toHaveLength(36);
      }
    }
  });

  it("orders same-millisecond spans deterministically", async () => {
    stubFetch();
    const tracer = makeLangSmithTracer(config(), () => NOW);
    const root = tracer.startRoot({
      runId: "r", generationId: "g", agentTurnId: "t", attempt: 1,
      surface: "chat", startedAtMs: NOW,
    });
    const first = tracer.startTool(root, { toolName: "run_code", toolCallId: "a", startedAtMs: NOW });
    const second = tracer.startTool(root, { toolName: "run_code", toolCallId: "b", startedAtMs: NOW });
    tracer.endTool(first, { endedAtMs: NOW, ok: true, durationMs: 0, capabilityCalls: 0, errorCode: null });
    tracer.endTool(second, { endedAtMs: NOW, ok: true, durationMs: 0, capabilityCalls: 0, errorCode: null });
    tracer.endRoot(root, { endedAtMs: NOW, path: "completed", errorCode: null });
    await tracer.flush();

    const byId = new Map(sent[0]!.body.post.map((r) => [r.id, r]));
    expect(byId.get(first.id)!.dotted_order < byId.get(second.id)!.dotted_order).toBe(true);
  });

  it("carries the scalars an operator reads, in both payload modes", async () => {
    for (const payloads of ["none", "redacted"] as const) {
      stubFetch();
      await tracedRun({ payloads }).flush();
      const llm = sent[0]!.body.post.find((r) => r.run_type === "llm")!;
      // THE SHAPE LANGSMITH READS. Measured 2026-08-17: token counts are picked
      // up ONLY from `outputs.usage_metadata` or `outputs.llm_output.token_usage`.
      // A top-level `usage_metadata`, `extra.usage_metadata`, top-level
      // `prompt_tokens`, and the provider-native `outputs.usage` are all
      // accepted with 202 and silently discarded — the run comes back showing
      // 0 tokens and $0.00. Nothing but this assertion notices.
      expect(llm.outputs!.usage_metadata).toEqual({
        input_tokens: 900,
        output_tokens: 120,
        total_tokens: 1_020,
        input_token_details: { cache_read: 400, cache_creation: 50 },
        // OUR cost, in USD, not LangSmith's estimate — 42_000_000 nano-USD.
        // Given tokens without these it invents a figure from its own price
        // table, which would then disagree with `agent_model_calls` in D1.
        input_cost: 0.024,
        output_cost: 0.018,
        total_cost: 0.042,
      });
      // ...and the model is named where LangSmith looks for it.
      expect(llm.extra?.metadata).toMatchObject({
        ls_model_name: "claude-fable-5",
        ls_provider: "anthropic",
      });
      expect(llm.outputs).toMatchObject({
        cost_nano_usd: 42_000_000,
        latency_ms: 1_200,
        finish_reason: "tool-calls",
        provider_request_id: "req_abc",
        gateway_log_id: "log_xyz",
      });
      const tool = sent[0]!.body.post.find((r) => r.run_type === "tool")!;
      expect(tool.outputs).toMatchObject({ ok: true, duration_ms: 800, capability_calls: 3 });
      const root = sent[0]!.body.post.find((r) => r.run_type === "chain")!;
      expect(root.outputs).toMatchObject({ outcome_path: "completed", final_turn_id: "turn-9" });
    }
  });
});

describe("langsmith tracer — what leaves the Worker", () => {
  it('payloads:"none" ships no prose at all', async () => {
    stubFetch();
    await tracedRun({ payloads: "none" }, "PLANTED-PROMPT-TEXT").flush();
    const wire = JSON.stringify(sent[0]!.body);

    expect(wire).not.toContain("PLANTED-PROMPT-TEXT");
    expect(wire).not.toContain("I will check the logs.");
    expect(wire).not.toContain("slack.reply");
    // ...while the numbers still arrive. A mode that dropped everything would
    // pass the line above and be useless.
    expect(wire).toContain("cost_nano_usd");
  });

  it('payloads:"redacted" ships prose but scrubs credential shapes', async () => {
    stubFetch();
    const tracer = tracedRun(
      { payloads: "redacted" },
      "token is xoxb-9999999999-abcdefghijkl and key lsv2_pt_deadbeefdeadbeefdeadbeef",
    );
    await tracer.flush();
    const wire = JSON.stringify(sent[0]!.body);

    expect(wire).toContain("token is");
    expect(wire).toContain("I will check the logs.");
    expect(wire).not.toContain("xoxb-9999999999-abcdefghijkl");
    expect(wire).not.toContain("lsv2_pt_deadbeefdeadbeefdeadbeef");
    expect(wire).toContain("[redacted-slack-token]");
    expect(wire).toContain("[redacted-key]");
  });

  it("scrubs bearer tokens and email addresses out of prose", async () => {
    stubFetch();
    await tracedRun(
      { payloads: "redacted" },
      "Authorization: Bearer abcdefghijklmnop, ping engineer@zellify.com",
    ).flush();
    const wire = JSON.stringify(sent[0]!.body);

    expect(wire).not.toContain("abcdefghijklmnop");
    expect(wire).not.toContain("engineer@zellify.com");
  });

  it("bounds prose so one enormous prompt cannot become the whole body", async () => {
    stubFetch();
    await tracedRun({ payloads: "redacted" }, "z".repeat(50_000)).flush();
    const llm = sent[0]!.body.post.find((r) => r.run_type === "llm")!;

    expect(String(llm.inputs.prompt).length).toBeLessThan(3_000);
    expect(String(llm.inputs.prompt).endsWith("…")).toBe(true);
  });

  it("never emits reasoning, even when a caller smuggles it into a field name", async () => {
    stubFetch();
    let at = NOW;
    const tracer = makeLangSmithTracer(config({ payloads: "redacted" }), () => at);
    const root = tracer.startRoot({
      runId: "r", generationId: "g", agentTurnId: "t", attempt: 1,
      surface: "chat", startedAtMs: at,
    });
    at += 10;
    // Not a shape the loop produces — the loop never reads a reasoning part.
    // This asserts the SECOND guard: even handed one, the serializer drops it.
    tracer.endRoot(root, {
      endedAtMs: at,
      path: "completed",
      errorCode: null,
      ...({ reasoning: "SECRET-CHAIN-OF-THOUGHT", thinking: "ALSO-SECRET" } as object),
    });
    await tracer.flush();

    const wire = JSON.stringify(sent[0]!.body);
    expect(wire).not.toContain("SECRET-CHAIN-OF-THOUGHT");
    expect(wire).not.toContain("ALSO-SECRET");
  });
});

describe("langsmith tracer — totality", () => {
  it("is disabled with no flag, no key, or no project, and reaches no network", async () => {
    for (const patch of [{ enabled: false }, { apiKey: "" }, { project: "" }]) {
      stubFetch();
      const report = await tracedRun(patch).flush();
      expect(report.outcome).toBe("disabled");
      expect(sent).toHaveLength(0);
    }
  });

  it("makeNoopTracer buffers nothing and fetches nothing", async () => {
    stubFetch();
    const tracer = makeNoopTracer();
    const root = tracer.startRoot({
      runId: "r", generationId: "g", agentTurnId: "t", attempt: 1,
      surface: "chat", startedAtMs: NOW,
    });
    tracer.endRoot(root, { endedAtMs: NOW, path: "completed", errorCode: null });

    expect(tracer.size).toBe(0);
    expect((await tracer.flush()).outcome).toBe("disabled");
    expect(sent).toHaveLength(0);
  });

  it("reports rather than throws when LangSmith rejects", async () => {
    stubFetch(500);
    const report = await tracedRun().flush();
    expect(report).toMatchObject({ outcome: "rejected", posted: 0, status: 500 });
  });

  it("reports rather than throws when the host is unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("network failure");
    });
    expect((await tracedRun().flush()).outcome).toBe("network_error");
  });

  it("reports a timeout rather than hanging", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      await new Promise((resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new DOMException("aborted", "TimeoutError"));
        });
        setTimeout(resolve, 30_000);
      });
      return new Response("{}", { status: 202 });
    });
    const tracer = tracedRun({ flushTimeoutMs: 20 });
    expect((await tracer.flush()).outcome).toBe("timeout");
  });

  it("flushes once however many times it is called", async () => {
    stubFetch();
    const tracer = tracedRun();
    const [a, b] = await Promise.all([tracer.flush(), tracer.flush()]);
    await tracer.flush();

    expect(sent).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it("closes a span the caller opened and never ended", async () => {
    stubFetch();
    let at = NOW;
    const tracer = makeLangSmithTracer(config(), () => at);
    const root = tracer.startRoot({
      runId: "r", generationId: "g", agentTurnId: "t", attempt: 1,
      surface: "chat", startedAtMs: at,
    });
    // A `halt()` mid-step looks exactly like this: the llm span is opened and
    // the function that would have closed it never runs.
    tracer.startLlm(root, {
      stepNumber: 0, globalStep: 0, modelId: "m", provider: "anthropic", startedAtMs: at,
    });
    at += 500;
    tracer.endRoot(root, { endedAtMs: at, path: "provider_refusal", errorCode: "refusal" });
    await tracer.flush();

    const llm = sent[0]!.body.post.find((r) => r.run_type === "llm")!;
    expect(llm.end_time).toBeDefined();
    expect(llm.error).toBe("span_not_closed");
  });

  it("caps the span count and reports what it dropped", async () => {
    stubFetch();
    let at = NOW;
    const tracer = makeLangSmithTracer(config({ maxSpans: 4 }), () => at);
    const root = tracer.startRoot({
      runId: "r", generationId: "g", agentTurnId: "t", attempt: 1,
      surface: "chat", startedAtMs: at,
    });
    for (let i = 0; i < 20; i += 1) {
      const span = tracer.startTool(root, {
        toolName: "run_code", toolCallId: `c${i}`, startedAtMs: at,
      });
      at += 1;
      tracer.endTool(span, {
        endedAtMs: at, ok: true, durationMs: 1, capabilityCalls: 0, errorCode: null,
      });
    }
    tracer.endRoot(root, { endedAtMs: at, path: "completed", errorCode: null });
    const report = await tracer.flush();

    expect(sent[0]!.body.post).toHaveLength(4);
    expect(report.dropped).toBe(17);
  });

  it("caps the body size", async () => {
    stubFetch();
    let at = NOW;
    const tracer = makeLangSmithTracer(
      config({ payloads: "redacted", maxBodyBytes: 4_000 }),
      () => at,
    );
    const root = tracer.startRoot({
      runId: "r", generationId: "g", agentTurnId: "t", attempt: 1,
      surface: "chat", startedAtMs: at,
    });
    for (let i = 0; i < 30; i += 1) {
      const span = tracer.startTool(root, {
        toolName: "run_code", toolCallId: `c${i}`, startedAtMs: at, code: "x".repeat(600),
      });
      at += 1;
      tracer.endTool(span, {
        endedAtMs: at, ok: true, durationMs: 1, capabilityCalls: 0, errorCode: null,
      });
    }
    tracer.endRoot(root, { endedAtMs: at, path: "completed", errorCode: null });
    const report = await tracer.flush();

    expect(String(sent[0]!.init.body).length).toBeLessThanOrEqual(4_000);
    expect(report.dropped).toBeGreaterThan(0);
  });

  it("sends nothing when no span was ever opened", async () => {
    stubFetch();
    const tracer = makeLangSmithTracer(config(), () => NOW);
    expect((await tracer.flush()).outcome).toBe("empty");
    expect(sent).toHaveLength(0);
  });
});
