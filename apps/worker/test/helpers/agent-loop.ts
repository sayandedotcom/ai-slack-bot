import { env, runInDurableObject } from "cloudflare:test";
import { simulateReadableStream, tool, type LanguageModel, type Tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { chatRunKey, runStubForKey, slackRunKey } from "../../src/run/keys";
import { createOrGetRun } from "../../src/run/repository";
import { readState, type RunDescriptor } from "../../src/run/session";
import type { RunTurnInput } from "../../src/run/protocol";
import { installRunPorts } from "../../src/agent/driver";
import type { AlarmOutcome, RunDO } from "../../src/run/do";
import {
  makeRunEventPort,
  runContinuation,
  toContinuationOutcome,
  withOuterToolEvents,
  type ContinuationResult,
  type RunEventPort,
} from "../../src/agent/loop";
import type { ToolUpdateWriter } from "../../src/agent/audit";
import { auditSinkFactory } from "../../src/agent/audit";
import { FABLE_5_MODEL_ID } from "../../src/agent/cost";
import { DEFAULT_AGENT_LIMITS, type AgentLimits } from "../../src/agent/limits";
import type { ModelHandle } from "../../src/agent/model";
import { resolveTrustedContext } from "../../src/agent/prompt";
import type { StreamClock } from "../../src/agent/stream";
import type { CodeModeOutput } from "../../src/codemode/tool";
import type { Env } from "../../src/index";
import { FakeClock } from "./agent-driver";

/**
 * The harness for the streamed continuation.
 *
 * Everything here is LOCAL: a `MockLanguageModelV4`, this pool's own Durable
 * Object, and either a fake tool or the real Phase 09 isolate against fake host
 * gateways. Nothing reaches Anthropic, AI Gateway, Slack, Zep or any vendor, and
 * nothing in these suites can be made to.
 */

/* ------------------------------------------------------- provider fixtures -- */

/**
 * The provider-level stream part, DERIVED from the installed mock's own
 * declaration rather than imported from `@ai-sdk/provider`.
 *
 * Two reasons, and the first one is mundane: `@ai-sdk/provider` is a transitive
 * dependency of `ai` and is not resolvable from this package, so a direct import
 * typechecks nowhere. The second is the one that matters — deriving it means a
 * part shape that changes in a minor SDK bump breaks these fixtures at compile
 * time, instead of letting them keep scripting a stream the SDK no longer reads.
 */
type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
export type LanguageModelV4StreamPart =
  StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const USAGE = {
  inputTokens: { total: 1_200, noCache: 1_000, cacheRead: 200, cacheWrite: 0 },
  outputTokens: { total: 80, text: 80, reasoning: 0 },
} as const;

function head(id: string): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    {
      type: "response-metadata",
      id,
      modelId: FABLE_5_MODEL_ID,
      timestamp: new Date(0),
    },
  ];
}

function finish(
  unified: "stop" | "tool-calls" | "content-filter",
  raw: string,
): LanguageModelV4StreamPart {
  return { type: "finish", finishReason: { unified, raw }, usage: { ...USAGE } };
}

/** One provider step that streams text and stops. */
export function textStep(input: {
  id?: string;
  chunks: string[];
  raw?: string;
  unified?: "stop" | "content-filter";
}): LanguageModelV4StreamPart[] {
  return [
    ...head(input.id ?? "resp_text"),
    { type: "text-start", id: "t1" },
    ...input.chunks.map(
      (delta): LanguageModelV4StreamPart => ({ type: "text-delta", id: "t1", delta }),
    ),
    { type: "text-end", id: "t1" },
    finish(input.unified ?? "stop", input.raw ?? "end_turn"),
  ];
}

/** One provider step that narrates, then calls `run_code`. */
export function toolStep(input: {
  id?: string;
  toolCallId: string;
  code: string;
  narration?: string[];
}): LanguageModelV4StreamPart[] {
  const inputJson = JSON.stringify({ code: input.code });
  return [
    ...head(input.id ?? "resp_tool"),
    ...(input.narration
      ? [
          { type: "text-start" as const, id: "n1" },
          ...input.narration.map(
            (delta): LanguageModelV4StreamPart => ({ type: "text-delta", id: "n1", delta }),
          ),
          { type: "text-end" as const, id: "n1" },
        ]
      : []),
    { type: "tool-input-start", id: input.toolCallId, toolName: "run_code" },
    { type: "tool-input-delta", id: input.toolCallId, delta: inputJson },
    { type: "tool-input-end", id: input.toolCallId },
    {
      type: "tool-call",
      toolCallId: input.toolCallId,
      toolName: "run_code",
      input: inputJson,
    },
    finish("tool-calls", "tool_use"),
  ];
}

/** A step whose omitted-thinking block arrives with readable text. Must fail safe. */
export function readableReasoningStep(): LanguageModelV4StreamPart[] {
  return [
    ...head("resp_reasoning"),
    { type: "reasoning-start", id: "r1" },
    { type: "reasoning-delta", id: "r1", delta: "the customer is probably lying about" },
    { type: "reasoning-end", id: "r1" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "here is the answer" },
    { type: "text-end", id: "t1" },
    finish("stop", "end_turn"),
  ];
}

export function errorStep(message: string): LanguageModelV4StreamPart[] {
  return [...head("resp_error"), { type: "error", error: new Error(message) }];
}

/**
 * A scripted provider. Each entry is one step's worth of stream parts; the last
 * entry repeats, so a fixture never has to guess how many steps the loop takes.
 */
export function mockModel(steps: LanguageModelV4StreamPart[][]): LanguageModel {
  let call = 0;
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: FABLE_5_MODEL_ID,
    doGenerate: async () => {
      throw new Error("this loop streams; doGenerate must never be called");
    },
    doStream: async () => {
      const parts = steps[Math.min(call, steps.length - 1)];
      call += 1;
      return {
        stream: simulateReadableStream({
          chunks: parts,
          initialDelayInMs: 0,
          chunkDelayInMs: 0,
        }),
        response: { headers: { "cf-aig-log-id": "log_local" } },
      };
    },
  }) as unknown as LanguageModel;
}

export function handleFor(model: LanguageModel): ModelHandle {
  return {
    model,
    modelId: FABLE_5_MODEL_ID,
    provider: "anthropic",
    safeHeaders: {},
    gatewayAttempts: 2,
  };
}

/* ------------------------------------------------------------- fake tool -- */

export const okOutput = (result: unknown): CodeModeOutput => ({
  result: result as CodeModeOutput["result"],
  logs: [],
  truncation: { result: false, logs: false },
  metrics: { durationMs: 4, capabilityCalls: 1 },
});

export const failedOutput = (error: string): CodeModeOutput => ({
  result: null,
  logs: [],
  error,
  truncation: { result: false, logs: false },
  metrics: { durationMs: 4, capabilityCalls: 0 },
});

export function fakeRunCodeTool(
  execute: (code: string) => CodeModeOutput | Promise<CodeModeOutput>,
): Tool<{ code: string }, CodeModeOutput> {
  return tool({
    description: "run javascript",
    inputSchema: z.strictObject({ code: z.string().min(1) }),
    execute: async ({ code }) => execute(code),
  }) as Tool<{ code: string }, CodeModeOutput>;
}

/* -------------------------------------------------------------- harness -- */

export type LoopHarness = {
  key: string;
  runId: string;
  stub: DurableObjectStub<RunDO>;
  results: ContinuationResult[];
  /** One faithful platform delivery: clear the armed alarm, then dispatch. */
  alarm: () => Promise<AlarmOutcome>;
  storage: <T>(fn: (storage: DurableObjectStorage) => T) => Promise<T>;
};

export type LoopOptions = {
  model: LanguageModel;
  /** The fake tool. Ignored when `makeTools` is supplied. */
  tool?: Tool<{ code: string }, CodeModeOutput>;
  /** The real composer path, for the end-to-end suite. */
  makeTools?: (input: {
    env: Env;
    generationId: string;
    agentTurnId: string;
    auditForExecution: ReturnType<typeof auditSinkFactory>;
  }) => Promise<Tool<{ code: string }, CodeModeOutput>>;
  limits?: Partial<AgentLimits>;
  clock?: StreamClock;
  flush?: { chars?: number; ms?: number };
  origin?: "chat" | "slack";
  historyBounds?: { maxMessages: number; maxBytes: number };
};

export async function freshLoopRun(options: LoopOptions): Promise<LoopHarness> {
  const origin = options.origin ?? "chat";
  const descriptor = await seedRun(origin);
  const results: ContinuationResult[] = [];
  const limits: AgentLimits = { ...DEFAULT_AGENT_LIMITS, ...options.limits };

  /**
   * ONE clock, an hour ahead of wall time, driving both the driver and the
   * stream. Two properties depend on it and both are load-bearing:
   *
   *  - alarms in this pool really do fire on their own, and `nextAlarmAt` never
   *    arms before this `now`, so every delivery in these suites is the explicit
   *    one the test makes. Without it a background delivery claims the
   *    generation first and the explicit dispatch finds a live lease;
   *  - it does not advance, so only the 512-character half of the flush rule can
   *    fire. A real clock makes batch counts a function of how fast the machine
   *    ran the test, which is the definition of a flaky assertion.
   */
  const clock = options.clock ?? new FakeClock();

  installRunPorts(
    {
      continuation: (ctx, workerEnv) => ({
        async run(claim) {
          const state = readState(ctx.storage);
          if (!state) throw new Error("run is not initialized");

          const resolved = await resolveTrustedContext(workerEnv.DB, {
            generationId: claim.generationId,
            run: {
              runId: state.runId,
              origin: state.origin,
              channelId: state.channelId,
              threadTs: state.threadTs,
            },
          });
          if (resolved.outcome === "refused") {
            throw new Error(`trusted context refused: ${resolved.reason}`);
          }

          const events: RunEventPort = makeRunEventPort(ctx, claim.fence);
          const writer: ToolUpdateWriter = {
            async write(update) {
              await events.toolUpdate(update);
            },
          };
          const inner = options.makeTools
            ? await options.makeTools({
                env: workerEnv,
                generationId: claim.generationId,
                agentTurnId: claim.agentTurnId,
                auditForExecution: auditSinkFactory(claim.generationId, writer),
              })
            : (options.tool ?? fakeRunCodeTool(() => okOutput({ ok: true })));

          const result = await runContinuation(claim, {
            storage: ctx.storage,
            events,
            tools: {
              run_code: withOuterToolEvents(inner, claim.generationId, writer),
            },
            model: handleFor(options.model),
            context: resolved.context,
            limits,
            clock,
            ...(options.flush === undefined ? {} : { flush: options.flush }),
            ...(options.historyBounds === undefined
              ? {}
              : { historyBounds: options.historyBounds }),
          });
          results.push(result);
          return toContinuationOutcome(result);
        },
      }),
      now: () => clock.now(),
      limits: {
        claimLeaseMs: 150_000,
        maxAttempts: 3,
        continuationTotalMs: 8 * 60_000,
      },
    },
    { runKey: descriptor.key },
  );

  const stub = runStubForKey(env.RUNS, descriptor.key);
  await stub.initialize(descriptor);

  return {
    key: descriptor.key,
    runId: descriptor.runId,
    stub,
    results,
    alarm: async () => {
      await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
      return stub.dispatchAlarm();
    },
    storage: (fn) => runInDurableObject(stub, (_instance, state) => fn(state.storage)),
  };
}

async function seedRun(origin: "chat" | "slack"): Promise<RunDescriptor> {
  if (origin === "chat") {
    const key = chatRunKey(crypto.randomUUID());
    const record = await createOrGetRun(env.DB, {
      key,
      origin: "chat",
      channelId: null,
      threadTs: null,
    });
    return { runId: record.id, key, origin: "chat", channelId: null, threadTs: null };
  }

  const channelId = `C${crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
  const threadTs = `17123456${Math.floor(10 + Math.random() * 89)}.000100`;
  await env.DB.prepare(
    "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, 'acme', 'live')",
  )
    .bind(channelId, `chan-${channelId}`)
    .run();

  const key = slackRunKey(channelId, threadTs);
  const record = await createOrGetRun(env.DB, {
    key,
    origin: "slack",
    channelId,
    threadTs,
  });
  return { runId: record.id, key, origin: "slack", channelId, threadTs };
}

export function customerTurn(id: string, content = "the deploy is stuck"): RunTurnInput {
  return { id, role: "user", source: "customer", content };
}

/** A stored triage opening shaped exactly like the pre-fix rows in production. */
export function legacyTriageTurn(id: string, content: string): RunTurnInput {
  return { id, role: "system", source: "triage", content };
}
