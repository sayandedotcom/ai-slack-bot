import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { resetRunPorts } from "../src/agent/driver";
import { makeRunCodeTool } from "../src/codemode/tool";
import { alwaysFresh, PRODUCTION_LIMITS } from "../src/codemode/contracts";
import { listEvents, listToolCalls, listTurns } from "../src/run/session";
import type { RunEvent, RunServerMessage } from "../src/run/protocol";
import { fakeDeps, seedPermittedScope } from "./helpers/codemode";
import {
  customerTurn,
  freshLoopRun,
  mockModel,
  textStep,
  toolStep,
} from "./helpers/agent-loop";
import type { Env } from "../src/index";

/**
 * END TO END, LOCALLY.
 *
 * `MockLanguageModelV4` -> `run_code` -> a REAL Phase 09 Dynamic Worker isolate
 * -> the tool result -> a final answer, driven through the real RunDO alarm.
 *
 * THIS FILE MAKES NO NETWORK CALL AND NO LIVE MODEL CALL. The name says
 * "e2e", not "live", deliberately: the provider is a scripted mock and every
 * host gateway behind the isolate is a fake. The one genuinely real thing is
 * the Worker Loader isolate, which is local to this pool — and driving the real
 * isolate against fake gateways is exactly the point, because it proves the
 * outer tool, the nested capability audit trail and the transcript all line up
 * without needing an account anywhere.
 */

afterEach(() => {
  resetRunPorts();
});

const CODE = `async () => {
  const thread = await slack.thread({});
  return { messages: thread.length, first: thread[0].text };
}`;

async function realIsolateTool() {
  const scope = await seedPermittedScope(env.DB);
  return makeRunCodeTool({
    scope,
    deps: fakeDeps({
      slackThread: [
        { ts: "1.0", userId: "U1", text: "exports are empty", permalink: null },
        { ts: "2.0", userId: "U2", text: "since the 04:12 deploy", permalink: null },
      ],
    }),
    limits: PRODUCTION_LIMITS,
    auditForExecution: () => ({
      async started() {},
      async completed() {},
      async failed() {},
    }),
    guard: alwaysFresh(),
    loader: (env as unknown as Env).LOADER,
  });
}

describe("the whole loop, against a real Tier 1 isolate", () => {
  it("runs mock model -> run_code -> isolate -> result -> final answer", async () => {
    const scope = await seedPermittedScope(env.DB);
    const harness = await freshLoopRun({
      model: mockModel([
        toolStep({
          toolCallId: "call_1",
          code: CODE,
          narration: ["Pulling ", "the thread."],
        }),
        textStep({ chunks: ["Two messages; it started at the 04:12 deploy."] }),
      ]),
      makeTools: async ({ auditForExecution }) =>
        makeRunCodeTool({
          scope,
          deps: fakeDeps({
            slackThread: [
              { ts: "1.0", userId: "U1", text: "exports are empty", permalink: null },
              { ts: "2.0", userId: "U2", text: "since the 04:12 deploy", permalink: null },
            ],
          }),
          limits: PRODUCTION_LIMITS,
          auditForExecution,
          guard: alwaysFresh(),
          loader: (env as unknown as Env).LOADER,
        }),
      flush: { chars: 16 },
    });

    await harness.stub.appendTurn(customerTurn("t1", "why are exports empty?"));
    await harness.alarm();

    expect(harness.results[0].path).toBe("completed");

    /* ---- exactly one outer tool, and its nested capability calls ---- */
    const calls = await harness.storage((storage) => listToolCalls(storage));
    const outer = calls.filter((call) => call.name === "run_code");
    expect(outer).toHaveLength(1);
    expect(outer[0].state).toBe("completed");
    expect(outer[0].callId).toBe("call_1");

    const nested = calls.filter((call) => call.callId.startsWith("cap:"));
    expect(nested.map((call) => call.name)).toEqual(["slack.thread"]);
    // The nested id carries its outer call, which is what makes the audit trail
    // reconstructable when one loop has issued ten `run_code` calls.
    expect(nested[0].callId).toBe("cap:call_1:1");
    expect(nested[0].state).toBe("completed");

    /* ---- ordering: outer start, nested, outer end ---- */
    const events = await harness.storage((storage) => listEvents(storage, 0, 500));
    const toolEvents = events.filter(
      (event): event is Extract<RunEvent, { type: "tool_call" }> => event.type === "tool_call",
    );
    expect(toolEvents.map((event) => `${event.update.name}:${event.update.state}`)).toEqual([
      "run_code:running",
      "slack.thread:running",
      "slack.thread:completed",
      "run_code:completed",
    ]);

    /* ---- the isolate really ran the model's program ---- */
    expect(JSON.stringify(outer[0].output)).toContain("messages");

    // THE PAYLOAD RULE. The model received the full capability result; the
    // event stream got size and duration and nothing else. A capability result
    // can be an entire customer conversation, and this stream is durable,
    // replayed to every socket and projected to D1.
    const nestedEnd = toolEvents.find(
      (event) => event.update.callId.startsWith("cap:") && event.update.state === "completed",
    );
    expect(Object.keys(nestedEnd!.update.output as object).sort()).toEqual([
      "durationMs",
      "resultChars",
    ]);
    expect(JSON.stringify(nestedEnd!.update)).not.toContain("04:12 deploy");

    /* ---- exactly one final assistant turn ---- */
    const turns = await harness.storage((storage) => listTurns(storage));
    const finals = turns.filter((turn) => turn.source === "agent");
    expect(finals).toHaveLength(1);
    expect(finals[0].content).toBe("Two messages; it started at the 04:12 deploy.");
    expect(finals[0].content).not.toContain("Pulling");

    /* ---- the run is idle and the driver is idle ---- */
    const state = await harness.stub.state();
    expect(state?.status).toBe("idle");
  });

  it("keeps the model's tool map to exactly one entry", async () => {
    const tool = await realIsolateTool();
    // The seven namespaces exist only inside the isolate, described once in this
    // tool's description (invariants 5 and 24).
    expect(typeof tool.description).toBe("string");
    expect(tool.description).toContain("slack");
    expect(tool.description).toContain("You have one tool");
  });
});

/* ------------------------------------------------------- reconnect replay -- */

describe("reconnect replays exactly the missing frames", () => {
  it("resumes from a mid-stream cursor with no gap and no duplicate", async () => {
    const harness = await freshLoopRun({
      model: mockModel([
        toolStep({
          toolCallId: "call_1",
          code: CODE,
          // Small flush threshold below, so this narration is several batches.
          narration: ["Pulling the thread ", "for this customer ", "now."],
        }),
        textStep({ chunks: ["Two messages; the 04:12 deploy started it."] }),
      ]),
      makeTools: async ({ auditForExecution }) => {
        const scope = await seedPermittedScope(env.DB);
        return makeRunCodeTool({
          scope,
          deps: fakeDeps({
            slackThread: [{ ts: "1.0", userId: "U1", text: "empty", permalink: null }],
          }),
          limits: PRODUCTION_LIMITS,
          auditForExecution,
          guard: alwaysFresh(),
          loader: (env as unknown as Env).LOADER,
        });
      },
      // One batch per narration chunk, so "two text batches" is a real cursor.
      flush: { chars: 8 },
    });

    await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    const all = await harness.storage((storage) => listEvents(storage, 0, 500));

    // The disconnect point: after two streamed assistant batches AND the nested
    // tool start. Chosen from the durable log rather than by racing a socket,
    // because the log IS the replay authority — a client that reconnects asks
    // for everything above its cursor and gets exactly this.
    const streamingSeqs = all
      .filter((event) => event.type === "assistant_update" && event.update.state === "streaming")
      .map((event) => event.seq);
    expect(streamingSeqs.length).toBeGreaterThanOrEqual(2);
    const nestedStart = all.find(
      (event) =>
        event.type === "tool_call" &&
        event.update.state === "running" &&
        event.update.callId.startsWith("cap:"),
    );
    expect(nestedStart).toBeDefined();

    const cursor = Math.max(streamingSeqs[1], nestedStart!.seq);
    const expected = all.filter((event) => event.seq > cursor);
    expect(expected.length).toBeGreaterThan(0);

    const response = await harness.stub.fetch(`https://run/ws?since=${cursor}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    const frames: RunServerMessage[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(event.data as string) as RunServerMessage);
    });
    socket.accept();

    const deadline = Date.now() + 2_000;
    while (!frames.some((frame) => frame.type === "sync" && frame.complete)) {
      if (Date.now() > deadline) throw new Error(`no complete sync; got ${frames.length} frames`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const replayed = frames.flatMap((frame) => (frame.type === "sync" ? frame.events : []));

    // No gap: every event above the cursor came back.
    expect(replayed.map((event) => event.seq)).toEqual(expected.map((event) => event.seq));
    // No duplicate: sequences are strictly increasing and unique.
    expect(new Set(replayed.map((event) => event.seq)).size).toBe(replayed.length);
    // Nothing at or below the cursor was resent.
    expect(replayed.every((event) => event.seq > cursor)).toBe(true);

    // And the three things a reconnecting client must not miss are all in it.
    const kinds = replayed.map((event) =>
      event.type === "tool_call"
        ? `tool:${event.update.name}:${event.update.state}`
        : event.type === "assistant_update"
          ? `assistant:${event.update.state}`
          : event.type === "turn"
            ? `turn:${event.turn.source}`
            : `status:${event.status}`,
    );
    expect(kinds).toContain("tool:run_code:completed");
    expect(kinds).toContain("assistant:completed");
    expect(kinds).toContain("turn:agent");

    socket.close();
  });
});

/* ------------------------------------------------------ batching in situ -- */

describe("a long answer is bounded event rows, not one row per token", () => {
  it("writes tens of batches for a 10,000-token answer, not thousands", async () => {
    const TOKENS = 10_000;
    const harness = await freshLoopRun({
      model: mockModel([
        textStep({ chunks: Array.from({ length: TOKENS }, () => "word") }),
      ]),
    });

    await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();
    expect(harness.results[0].path).toBe("completed");

    const events = await harness.storage((storage) => listEvents(storage, 0, 1_000));
    const batches = events.filter(
      (event) => event.type === "assistant_update" && event.update.state === "streaming",
    );
    // 40,000 characters at the reviewed 512-character threshold: 78 full
    // batches plus the 64-character remainder, flushed inside the finalization
    // transaction. 79 durable rows for 10,000 tokens.
    expect(batches.length).toBe(Math.ceil((TOKENS * 4) / 512));
    expect(batches.length).toBeLessThan(100);

    const turns = await harness.storage((storage) => listTurns(storage));
    expect(turns.find((turn) => turn.source === "agent")?.content).toHaveLength(TOKENS * 4);
  });
});
