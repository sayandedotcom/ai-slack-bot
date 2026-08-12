import { describe, expect, it } from "vitest";
import {
  auditSinkFactory,
  boundedArgs,
  EVENT_ARG_CHARS,
  EVENT_CODE_PREVIEW_CHARS,
  EVENT_PREVIEW_CHARS,
  flatPreview,
  nestedToolUpdate,
  outerToolMapper,
  outerToolUpdateId,
  type ToolUpdateWriter,
} from "../src/agent/audit";
import { agentTurnIdFor, capabilityCallIdFor } from "../src/agent/contracts";
import type { CapabilityEvent } from "../src/codemode/contracts";
import type { CodeModeOutput } from "../src/codemode/tool";
import type { ToolCallUpdateInput } from "../src/run/protocol";

/**
 * ONE TOOL HIERARCHY, TWO AUDIENCES.
 *
 * The model receives the complete Code Mode result as its tool result, through
 * the AI SDK. The event stream receives a bounded summary. These cases are
 * mostly about the second one staying bounded, because the failure mode is
 * quiet: an unbounded payload does not break anything visibly, it just makes
 * every socket reconnect replay megabytes of a customer's data forever.
 */

const GEN = "gen:11111111-2222-3333-4444-555555555555";

const output = (patch: Partial<CodeModeOutput> = {}): CodeModeOutput => ({
  result: { answer: "the auth service returned 500" },
  logs: [],
  truncation: { result: false, logs: false },
  metrics: { durationMs: 1234, capabilityCalls: 3 },
  ...patch,
});

/* ------------------------------------------------------------ outer tool -- */

describe("the outer run_code lifecycle maps onto tool_call events", () => {
  const mapper = outerToolMapper(GEN);

  it("names the tool run_code at both ends", () => {
    const started = mapper.started({ toolCallId: "call_1", code: "async () => 1" });
    const ended = mapper.ended({ toolCallId: "call_1", output: output() });
    expect(started.name).toBe("run_code");
    expect(ended.name).toBe("run_code");
    expect(started.callId).toBe("call_1");
    expect(ended.callId).toBe("call_1");
  });

  it("gives start and end stable, distinct, replayable ids", () => {
    const a = mapper.started({ toolCallId: "call_1", code: "x" });
    const b = mapper.ended({ toolCallId: "call_1", output: output() });
    expect(a.id).not.toBe(b.id);
    // `tool_updates.id` is a primary key: a redelivered alarm re-running the
    // same step must produce the same id or the timeline grows a duplicate.
    expect(mapper.started({ toolCallId: "call_1", code: "x" }).id).toBe(a.id);
    expect(a.id).toContain(GEN);
  });

  it("separates two calls that share a provider tool call id across generations", () => {
    const other = outerToolMapper("gen:other");
    // A crash-retry of the same generation issues a fresh provider toolCallId,
    // and a provider id is only unique within one request — so the generation
    // has to be in the string.
    expect(outerToolUpdateId(GEN, "call_1", "start")).not.toBe(
      other.started({ toolCallId: "call_1", code: "x" }).id,
    );
  });

  it("stores a bounded code preview and the real size, not the program", () => {
    const code = `async () => { ${"const x = 1; ".repeat(400)} }`;
    const started = mapper.started({ toolCallId: "call_1", code });
    const input = started.input as Record<string, unknown>;

    expect(String(input.codePreview).length).toBeLessThanOrEqual(EVENT_CODE_PREVIEW_CHARS + 1);
    expect(input.codeChars).toBe(code.length);
    expect(input.codeTruncated).toBe(true);
    // The full program is already in the model's own message history.
    expect(JSON.stringify(started)).not.toContain(code);
  });

  it("records completion facts, not the result", () => {
    const ended = mapper.ended({
      toolCallId: "call_1",
      output: output({ logs: ["a", "b", "c"], metrics: { durationMs: 950, capabilityCalls: 7 } }),
    });
    const summary = ended.output as Record<string, unknown>;

    expect(ended.state).toBe("completed");
    expect(summary.durationMs).toBe(950);
    expect(summary.capabilityCalls).toBe(7);
    expect(summary.logLines).toBe(3);
    expect(summary.resultTruncated).toBe(false);
  });

  it("keeps a large result out of the event payload", () => {
    const big = "x".repeat(50_000);
    const ended = mapper.ended({ toolCallId: "call_1", output: output({ result: big }) });
    const summary = ended.output as Record<string, unknown>;

    expect(JSON.stringify(ended).length).toBeLessThan(4_000);
    expect(summary.resultChars).toBeGreaterThan(49_000);
    expect(summary.resultTruncated).toBe(true);
    expect(String(summary.resultPreview).length).toBeLessThanOrEqual(EVENT_PREVIEW_CHARS + 1);
  });

  it("bounds the log preview and reports how many lines there were", () => {
    const logs = Array.from({ length: 200 }, (_, i) => `line ${i} ${"y".repeat(200)}`);
    const summary = mapper.ended({ toolCallId: "call_1", output: output({ logs }) })
      .output as Record<string, unknown>;
    expect(summary.logLines).toBe(200);
    expect(String(summary.logPreview).length).toBeLessThan(1_000);
  });

  it("reports executor truncation separately from event truncation", () => {
    const summary = mapper.ended({
      toolCallId: "call_1",
      output: output({ result: "small", truncation: { result: true, logs: true } }),
    }).output as Record<string, unknown>;

    // Two different facts: the EVENT shows less than the model received, versus
    // the executor cut the value before the model ever saw it.
    expect(summary.resultTruncated).toBe(false);
    expect(summary.executorTruncatedResult).toBe(true);
    expect(summary.executorTruncatedLogs).toBe(true);
  });

  it("maps a CodeModeOutput error to a failed event", () => {
    const ended = mapper.ended({
      toolCallId: "call_1",
      output: output({ result: null, error: "invalid_input: the arguments are not valid" }),
    });
    // Failed here even though the AI SDK correctly receives that error as a
    // NORMAL tool result the model is meant to read and adapt to. Both are
    // true; only one of them is an event state.
    expect(ended.state).toBe("failed");
    expect(ended.error).toMatch(/invalid_input/);
  });

  it("bounds a very long error", () => {
    const ended = mapper.ended({
      toolCallId: "call_1",
      output: output({ error: `boom ${"z".repeat(9_000)}` }),
    });
    expect((ended.error ?? "").length).toBeLessThan(1_000);
  });
});

/* --------------------------------------------------------- nested capability -- */

const started = (patch: Partial<CapabilityEvent> = {}): CapabilityEvent =>
  ({
    kind: "started",
    runId: "run_1",
    turnId: agentTurnIdFor(GEN),
    callId: capabilityCallIdFor("call_1", 1),
    seq: 1,
    namespace: "memory",
    method: "recall",
    at: 1_000,
    args: { query: "auth outage" },
    ...patch,
  }) as CapabilityEvent;

describe("nested capability calls map onto cap:* tool call ids", () => {
  it("uses the id Task 1 built, carrying the outer call", () => {
    const update = nestedToolUpdate(GEN, started());
    // One agent loop issues many run_code calls and every one starts its
    // sequence at 1, so a bare `cap:1` collides across calls and makes the
    // audit trail unreconstructable exactly when someone needs to read it.
    expect(update.callId).toBe("cap:call_1:1");
  });

  it("shows namespace.method as the visible name", () => {
    // The model has one tool, so a timeline of `run_code, run_code, run_code`
    // says nothing. `linear.createIssue` is a line a human may need to find.
    expect(nestedToolUpdate(GEN, started()).name).toBe("memory.recall");
  });

  it("records bounded, already-redacted args on start", () => {
    const update = nestedToolUpdate(
      GEN,
      started({ args: { query: "q".repeat(5_000), limit: 10 } } as Partial<CapabilityEvent>),
    );
    const args = update.input as Record<string, unknown>;
    expect(String(args.query).length).toBeLessThanOrEqual(EVENT_ARG_CHARS + 1);
    expect(args.limit).toBe(10);
    expect(update.state).toBe("running");
  });

  it("records size on completion, never the result", () => {
    const update = nestedToolUpdate(GEN, {
      ...(started() as object),
      kind: "completed",
      durationMs: 42,
      resultChars: 90_000,
    } as CapabilityEvent);

    expect(update.state).toBe("completed");
    expect(update.output).toEqual({ durationMs: 42, resultChars: 90_000 });
    // A capability result can be an entire customer conversation. The model
    // needs it; the durable event stream does not.
    expect(JSON.stringify(update).length).toBeLessThan(500);
  });

  it("records the safe code, message and retryable bit on failure", () => {
    const update = nestedToolUpdate(GEN, {
      ...(started() as object),
      kind: "failed",
      durationMs: 7,
      code: "shadow_write_denied",
      message: "shadow_write_denied: this run is observing only; nothing was changed.",
      retryable: false,
    } as CapabilityEvent);

    expect(update.state).toBe("failed");
    expect(update.error).toMatch(/^shadow_write_denied: /);
    expect(update.output).toEqual({ durationMs: 7, retryable: false });
  });

  it("gives start and end distinct ids for one nested call", () => {
    const begin = nestedToolUpdate(GEN, started());
    const end = nestedToolUpdate(GEN, {
      ...(started() as object),
      kind: "completed",
      durationMs: 1,
      resultChars: 2,
    } as CapabilityEvent);
    expect(begin.id).not.toBe(end.id);
    expect(begin.callId).toBe(end.callId);
  });
});

describe("the audit sink writes one update per capability event", () => {
  it("streams start and end through the writer in order", async () => {
    const written: ToolCallUpdateInput[] = [];
    const writer: ToolUpdateWriter = {
      async write(update) {
        written.push(update);
      },
    };

    const sink = auditSinkFactory(GEN, writer)({ outerToolCallId: "call_1" });
    await sink.started(started() as never);
    await sink.completed({
      ...(started() as object),
      kind: "completed",
      durationMs: 5,
      resultChars: 10,
    } as never);

    expect(written.map((u) => [u.name, u.state])).toEqual([
      ["memory.recall", "running"],
      ["memory.recall", "completed"],
    ]);
  });
});

/* ----------------------------------------------------------------- helpers -- */

describe("flatPreview never nests and never throws", () => {
  it("flattens a deep object to one string", () => {
    const deep = { a: { b: { c: { d: { e: "bottom" } } } } };
    const { preview } = flatPreview(deep);
    // `JsonValue` bottoms out after four levels, so a nested preview can fail
    // to typecheck in a way no test observes. One string, always.
    expect(typeof preview).toBe("string");
  });

  it("survives a circular value", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => flatPreview(circular)).not.toThrow();
  });

  it("leaves scalars alone in bounded args", () => {
    expect(boundedArgs({ n: 5, b: true, nil: null })).toEqual({ n: 5, b: true, nil: null });
    expect(boundedArgs(null)).toBeNull();
  });
});
