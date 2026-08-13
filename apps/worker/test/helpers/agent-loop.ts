import { env, runInDurableObject } from "cloudflare:test";
import { simulateReadableStream, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { chatRunKey, runStubForKey, slackRunKey } from "../../src/run/keys";
import { createOrGetRun } from "../../src/run/repository";
import type { RunDescriptor } from "../../src/run/session";
import type { RunTurnInput } from "../../src/run/protocol";
import { installRunPorts, type RunPorts } from "../../src/agent/driver";
import type { AlarmOutcome, RunDO } from "../../src/run/do";
import { makeAgentContinuation, type ContinuationResult } from "../../src/agent/loop";
import { FABLE_5_MODEL_ID } from "../../src/agent/cost";
import { DEFAULT_AGENT_LIMITS, type AgentLimits } from "../../src/agent/limits";
import type { ModelHandle } from "../../src/agent/model";
import type { StreamClock } from "../../src/agent/stream";
import { alwaysFresh, type AgentExecutionGuard } from "../../src/codemode/contracts";
import type { CodeModeOutput } from "../../src/codemode/tool";
import { fakeDeps, type FakeFixtures } from "./codemode";
import type { CapabilityDependencies } from "../../src/codemode/gateways";
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

/**
 * A tool step whose tool-input framing arrives BEFORE its text ends.
 *
 * The shape that makes `tool-input-start` load-bearing for the steering abort:
 * with the ordinary `toolStep` the text has already ended by the time the tool
 * is declared, so `text-end` disarms first and the tool-input window is covered
 * either way. Interleaved, only the `tool-input-start` arm keeps a steer from
 * cutting short a step whose program is already streaming.
 */
export function interleavedToolStep(input: {
  toolCallId: string;
  code: string;
  narration: string[];
}): LanguageModelV4StreamPart[] {
  const inputJson = JSON.stringify({ code: input.code });
  return [
    ...head("resp_interleaved"),
    { type: "text-start", id: "n1" },
    ...input.narration.map(
      (delta): LanguageModelV4StreamPart => ({ type: "text-delta", id: "n1", delta }),
    ),
    { type: "tool-input-start", id: input.toolCallId, toolName: "run_code" },
    { type: "tool-input-delta", id: input.toolCallId, delta: inputJson },
    { type: "tool-input-end", id: input.toolCallId },
    { type: "text-end", id: "n1" },
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
export type ModelScript = {
  /**
   * Called with the 1-based provider invocation number BEFORE the stream is
   * produced. This is the number the coalescing property is about: ten steers
   * during one answer must cost one extra invocation, not ten.
   */
  onCall?: (call: number) => void;
  /**
   * Hold the provider here. Awaited before any part is emitted, so a test can
   * append durable input through the REAL RunDO RPC while a claimed attempt is
   * genuinely mid-flight, then release it.
   */
  hold?: (call: number) => Promise<void>;
  /**
   * Hold the stream open AFTER its first text delta.
   *
   * The window the abort optimization lives in: the provider is streaming
   * visible text, the loop has armed its controller, and a steer arriving now
   * may cut the call short. Nothing about correctness depends on it — the same
   * steer arriving with nothing armed is absorbed by the cursor compare — but
   * it is the only way to exercise the abort deterministically.
   */
  holdAfterDelta?: (call: number) => Promise<void>;
  /**
   * Hold the stream open after the first `tool-input-delta` — i.e. while the
   * model's program is being streamed as the tool's argument. Nothing may be
   * armed for abort here: the step has declared work worth keeping.
   */
  holdAfterToolInput?: (call: number) => Promise<void>;
};

export function mockModel(
  steps: LanguageModelV4StreamPart[][],
  script: ModelScript = {},
): LanguageModel {
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
      script.onCall?.(call);
      if (script.hold) await script.hold(call);
      const invocation = call;
      const stream = simulateReadableStream({
        chunks: parts,
        initialDelayInMs: 0,
        chunkDelayInMs: 0,
      });
      const holdAfterDelta = script.holdAfterDelta;
      const holdAfterToolInput = script.holdAfterToolInput;
      if (!holdAfterDelta && !holdAfterToolInput) {
        return { stream, response: { headers: { "cf-aig-log-id": "log_local" } } };
      }

      let heldText = false;
      let heldToolInput = false;
      const pause = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        async transform(part, controller) {
          controller.enqueue(part);
          if (holdAfterDelta && !heldText && part.type === "text-delta") {
            heldText = true;
            await holdAfterDelta(invocation);
          }
          if (holdAfterToolInput && !heldToolInput && part.type === "tool-input-delta") {
            heldToolInput = true;
            await holdAfterToolInput(invocation);
          }
        },
      });
      return {
        stream: stream.pipeThrough(pause),
        response: { headers: { "cf-aig-log-id": "log_local" } },
      };
    },
  }) as unknown as LanguageModel;
}

/**
 * Tap the provider stream so a test can commit to durable storage part-way
 * through the FINAL step.
 *
 * The tap runs inside the Durable Object's own execution context — the SDK
 * pulls this stream there — so it calls the SYNCHRONOUS session functions
 * directly. An RPC back into the same object from here would deadlock.
 *
 * It fires once per claimed attempt, on the first `text-delta`. Callers that
 * need the window before `finalizeAnswer`'s cursor compare therefore script a
 * SINGLE text step: with only one step there is no later `prepareStep` to
 * absorb the input, which is exactly the state that branch exists for.
 */
function wrapModel(
  model: LanguageModel,
  ctx: DurableObjectState,
  midStream: ((storage: DurableObjectStorage) => void) | undefined,
): LanguageModel {
  if (!midStream) return model;

  const inner = model as unknown as MockLanguageModelV4;
  let fired = false;

  return new MockLanguageModelV4({
    provider: "mock",
    modelId: FABLE_5_MODEL_ID,
    doStream: async (callOptions) => {
      const result = await inner.doStream(callOptions);
      const tap = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(part, controller) {
          if (!fired && part.type === "text-delta") {
            fired = true;
            midStream(ctx.storage);
          }
          controller.enqueue(part);
        },
      });
      return { ...result, stream: result.stream.pipeThrough(tap) };
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

/* -------------------------------------------------------------- harness -- */

export type LoopHarness = {
  key: string;
  runId: string;
  stub: DurableObjectStub<RunDO>;
  /** The ten typed paths, observed through the factory's own `onOutcome`. */
  results: ContinuationResult[];
  /** One faithful platform delivery: clear the armed alarm, then dispatch. */
  alarm: () => Promise<AlarmOutcome>;
  storage: <T>(fn: (storage: DurableObjectStorage) => T) => Promise<T>;
  /**
   * The exact ports this harness installed, so a test can put them BACK after
   * temporarily swapping in the production ones.
   *
   * Used by the operator-config recovery case, which has to run a real
   * unconfigured production composition first (to get the terminal failure) and
   * then a real answer (to prove the run came back) — with no provider in
   * either half.
   */
  ports: Partial<RunPorts>;
  /**
   * The object's own storage handle, captured when a claim builds the
   * continuation.
   *
   * For code that already runs INSIDE the Durable Object's execution context —
   * a fake vendor port called from a live `run_code` execution, a stream tap —
   * and therefore must use the synchronous session functions rather than an RPC
   * back into the object it is already inside. Null before the first claim.
   */
  claimed: () => DurableObjectStorage | null;
};

export type LoopOptions = {
  model: LanguageModel;
  /**
   * Vendor ports only. Everything else — scope resolution, the write guard, the
   * loader, the one-tool map — is the real production composer.
   */
  fixtures?: FakeFixtures;
  /**
   * An EXTRA check ANDed on top of the durable freshness guard, which
   * `makeAgentContinuation` always composes and nothing here can switch off.
   * Defaults to `alwaysFresh()` — meaning "nothing extra", not "no checking".
   */
  additionalGuard?: AgentExecutionGuard;
  limits?: Partial<AgentLimits>;
  clock?: StreamClock;
  flush?: { chars?: number; ms?: number };
  origin?: "chat" | "slack";
  shadow?: boolean;
  historyBounds?: { maxMessages: number; maxBytes: number };
  /**
   * Commit something to durable storage part-way through the FINAL provider
   * step, from inside the object's own execution context.
   *
   * This exists for one scenario that cannot be reached any other way: input
   * that lands after the last `prepareStep` and before the finalization
   * transaction. That is precisely the window `finalizeAnswer`'s atomic cursor
   * compare exists for, and a steer arriving anywhere earlier is absorbed by the
   * next `prepareStep` instead — correctly, which is why it does not exercise
   * the branch.
   */
  midStream?: (storage: DurableObjectStorage) => void;
  /**
   * Wrap the fake vendor ports.
   *
   * Used by the steering suite to make a capability commit durable input while
   * it is running — the only way to reach "input arrived BETWEEN two capability
   * calls" without a second thread.
   */
  wrapDeps?: (base: CapabilityDependencies) => CapabilityDependencies;
};

export async function freshLoopRun(options: LoopOptions): Promise<LoopHarness> {
  const origin = options.origin ?? "chat";
  const descriptor = await seedRun(origin, options.shadow ?? false);
  const results: ContinuationResult[] = [];
  const limits: AgentLimits = { ...DEFAULT_AGENT_LIMITS, ...options.limits };
  let claimedStorage: DurableObjectStorage | null = null;

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

  const ports: Partial<RunPorts> = {
      /**
       * THE PRODUCTION FACTORY, not a copy of it.
       *
       * These suites call `makeAgentContinuation` — the same function Task 10
       * will install — so `resolveTrustedContext`, `makeAgentTools`,
       * `resolveCodeModeScope`, the write guard, `auditSinkFactory` and
       * `withOuterToolEvents` are all genuinely executed. A harness that rebuilt
       * that composition itself would leave the shipping entry point untested:
       * it could pass the wrong scope, drop the guard or mis-key the tool map
       * and every assertion below would still pass.
       *
       * The ONLY thing swapped is the vendor ports, through the narrow
       * `dependencies` seam, so nothing here can reach Slack, Zep, Linear,
       * Supabase, LangSmith, Better Stack or R2.
       */
      continuation: (ctx, workerEnv) => {
        claimedStorage = ctx.storage;
        return makeAgentContinuation(ctx, workerEnv, {
          modelFactory: () => handleFor(wrapModel(options.model, ctx, options.midStream)),
          // The ADDITIONAL guard only. The durable freshness guard is composed
          // by `makeAgentContinuation` itself and cannot be switched off here,
          // which is exactly the property invariant 15 needs.
          additionalGuard: options.additionalGuard ?? alwaysFresh(),
          dependencies: (_env, _scope, depsClock) => {
            const base: CapabilityDependencies = {
              ...fakeDeps(options.fixtures ?? {}),
              // The write guard re-reads the channel policy and the `runs` row
              // from D1 immediately before any `external_write`, so it needs a
              // real handle. Faking it would fake away the thing being protected.
              db: workerEnv.DB,
              clock: depsClock,
            };
            return options.wrapDeps ? options.wrapDeps(base) : base;
          },
          limits,
          clock,
          onOutcome: (result) => results.push(result),
          ...(options.flush === undefined ? {} : { flush: options.flush }),
          ...(options.historyBounds === undefined
            ? {}
            : { historyBounds: options.historyBounds }),
        });
      },
      now: () => clock.now(),
      limits: {
        claimLeaseMs: 150_000,
        maxAttempts: 3,
        continuationTotalMs: 8 * 60_000,
      },
  };
  installRunPorts(ports, { runKey: descriptor.key });

  const stub = runStubForKey(env.RUNS, descriptor.key);
  await stub.initialize(descriptor);

  return {
    key: descriptor.key,
    runId: descriptor.runId,
    stub,
    results,
    ports,
    alarm: async () => {
      await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
      return stub.dispatchAlarm();
    },
    storage: (fn) => runInDurableObject(stub, (_instance, state) => fn(state.storage)),
    claimed: () => claimedStorage,
  };
}

async function seedRun(origin: "chat" | "slack", shadow: boolean): Promise<RunDescriptor> {
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
  if (shadow) {
    // `shadow` lives on the D1 `runs` row and NOWHERE else — a check written
    // against the RunDO descriptor reads `undefined`, which is falsy, and an
    // observing run posts to a real customer.
    await env.DB.prepare("UPDATE runs SET shadow = 1 WHERE id = ?").bind(record.id).run();
  }
  return { runId: record.id, key, origin: "slack", channelId, threadTs };
}

export function customerTurn(id: string, content = "the deploy is stuck"): RunTurnInput {
  return { id, role: "user", source: "customer", content };
}

/**
 * Human steering, shaped exactly as `RunDO`'s own WebSocket handler shapes it:
 * server-assigned role and source, so a browser cannot pose as the customer.
 */
export function steerTurn(id: string, content: string): RunTurnInput {
  return { id, role: "user", source: "human_steer", content };
}

/**
 * A one-way flag two Workers I/O contexts may share.
 *
 * NOT a promise, deliberately, and this is the whole reason the helper exists.
 * A promise created in the test and resolved inside the Durable Object drags
 * the resolving context across the await, and the next line — `stub.appendTurn`
 * in the test, or a storage write in the object — fails with "Cannot perform
 * I/O on behalf of a different Durable Object". A boolean plus a timer owned by
 * whichever side is waiting keeps each context's I/O its own.
 */
export function latch(): {
  open: () => void;
  isOpen: () => boolean;
  wait: (timeoutMs?: number) => Promise<void>;
} {
  let opened = false;
  return {
    open: () => {
      opened = true;
    },
    isOpen: () => opened,
    wait: async (timeoutMs = 5_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!opened) {
        if (Date.now() > deadline) throw new Error("latch never opened");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

/** A stored triage opening shaped exactly like the pre-fix rows in production. */
export function legacyTriageTurn(id: string, content: string): RunTurnInput {
  return { id, role: "system", source: "triage", content };
}
