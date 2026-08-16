import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it, vi } from "vitest";
import type { LanguageModel, UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type {
  RunTurnSubmit,
  RunTurnWait,
  SubmitMessagesResult,
  TurnConfig,
  TurnContext,
  TurnResult,
} from "@cloudflare/think";
import type { Env } from "../src/index";
import type { RunAgent } from "../src/run/agent";
import { firefighterModel, firefighterTurnConfig, primeModelModule } from "../src/run/agent-prompt";
import { createOrGetRun } from "../src/run/repository";
import { FABLE_5_MODEL_ID } from "../src/agent/cost";
import { DEFAULT_AGENT_LIMITS } from "../src/agent/limits";
import { GATEWAY_AUTH_HEADER, GATEWAY_PROVIDER_NATIVE_HOST } from "../src/agent/gateway";
import { errorStep, mockModel, readableReasoningStep, textStep, toolStep } from "./helpers/agent-loop";

/**
 * The agentic loop, re-pinned for `RunAgent` (Project Think).
 *
 * This is the Think counterpart of `test/agent-loop.test.ts`. The legacy suite
 * drives `makeAgentContinuation` and reads RunDO's own session tables; there is
 * no such loop here — Think owns `streamText`, the transcript and the tool
 * lifecycle — so every case below is expressed against what this chassis
 * actually exposes: the production hooks (`beforeTurn`, `beforeStep`,
 * `beforeToolCall`, `onStepFinish`), the persisted `UIMessage` tree, and the
 * D1 projections.
 *
 * ## How a turn is driven, and what is real in it
 *
 * `getModel()` composes Fable through AI Gateway and there is deliberately no
 * injection seam for it (spec D11 — a model-id string would let Think's own
 * resolver pick a provider). The pool binds empty Gateway settings precisely so
 * no suite can compose a real one. So a live turn is driven by stamping ONE own
 * property onto the instance — `getModel` — inside `runInDurableObject`, and
 * calling `runTurn({ mode: "wait" })` over the stub. Everything else in the
 * turn is production: `beforeTurn` refreshes the run's D1 facts and returns
 * `firefighterTurnConfig`, `beforeStep` splices steers and renders the real
 * system blocks, `run_code` is the real Worker Loader isolate over the eleven
 * real connectors, and `onStepFinish` writes the real usage and projection
 * rows. Nothing here can reach a vendor: the model is a `MockLanguageModelV4`
 * and the isolate has `globalOutbound: null`.
 *
 * `maxSteps` is the one other thing a case may tighten, and it is done by
 * WRAPPING the production `beforeTurn` rather than replacing it, so the scope
 * refresh and the turn identity that hook owns still happen.
 *
 * A FRESH run key per case, with its D1 `runs` row written BEFORE the agent is
 * addressed: pool storage is shared across tests and files, and an unconfirmed
 * run gets no capabilities at all (see `test/run-agent-core.test.ts`).
 *
 * ## Chassis gaps this file pins as `it.fails`
 *
 * Four properties the legacy loop guarantees have no implementation on this
 * chassis yet. They are written as `it.fails` rather than omitted, so the day
 * they are implemented the test turns green and says so, and each has an entry
 * in `TEST-FINDINGS.md`: the generation spend cap, the final-turn delivery
 * label (`internal_narration` vs `visible`), the durable freshness guard behind
 * `run_code` (`agent.ts` composes `alwaysFresh()`), and the readable-reasoning
 * rejection (`src/agent/transcript.ts` is reached only from `loop.ts`).
 */

/** Programs the REAL isolate runs. No capability needed, no vendor reached. */
const TRIVIAL = "async () => ({ ok: true })";
/** A real capability refusal: a chat run has no conversation to reply into. */
const REPLY = 'async () => slack.reply({ text: "hello" })';

/* ------------------------------------------------------------- the harness -- */

/** `runTurn` is overloaded three ways and a DO stub keeps only the last. */
type WaitOnlyAgent = { runTurn(options: RunTurnWait): Promise<TurnResult> };
type SubmitOnlyAgent = { runTurn(options: RunTurnSubmit): Promise<SubmitMessagesResult> };

type TurnHarness = {
  key: string;
  stub: DurableObjectStub<RunAgent>;
  /** One turn, run to completion inside the object. */
  wait: (input: string) => Promise<TurnResult>;
  /** One durable submission, deduplicated on `idempotencyKey`. */
  submit: (input: string, idempotencyKey: string) => Promise<SubmitMessagesResult>;
  messages: () => Promise<UIMessage[]>;
};

async function seedChatRun(): Promise<string> {
  const key = `chat:${crypto.randomUUID()}`;
  await createOrGetRun(env.DB, { key, origin: "chat", channelId: null, threadTs: null });
  return key;
}

async function seedSlackRun(): Promise<string> {
  const channelId = `C${crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
  const threadTs = `17123456${Math.floor(10 + Math.random() * 89)}.000100`;
  await env.DB.prepare(
    "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, 'acme', 'live')",
  )
    .bind(channelId, `chan-${channelId}`)
    .run();
  const key = `slack:${channelId}:${threadTs}`;
  await createOrGetRun(env.DB, { key, origin: "slack", channelId, threadTs });
  return key;
}

type Patchable = {
  getModel: () => LanguageModel;
  beforeTurn: (ctx: TurnContext) => Promise<TurnConfig>;
  beforeToolCall?: (ctx: { toolName: string }) => Promise<void>;
  afterToolCall?: (ctx: { toolName: string }) => Promise<void>;
};

async function thinkRun(options: {
  model: LanguageModel;
  origin?: "chat" | "slack";
  /** Tighten the per-turn step ceiling, through the production hook. */
  maxSteps?: number;
  /** Collect `beforeToolCall`/`afterToolCall`, in order. */
  toolEvents?: string[];
}): Promise<TurnHarness> {
  const key = options.origin === "slack" ? await seedSlackRun() : await seedChatRun();
  const stub = await getAgentByName<Env, RunAgent>(env.RUN_AGENTS, key);

  await runInDurableObject(stub, (agent: RunAgent) => {
    const patch = agent as unknown as Patchable;
    patch.getModel = () => options.model;

    if (options.maxSteps !== undefined) {
      const production = patch.beforeTurn.bind(agent);
      patch.beforeTurn = async (ctx: TurnContext) => ({
        ...(await production(ctx)),
        maxSteps: options.maxSteps,
      });
    }

    if (options.toolEvents !== undefined) {
      const events = options.toolEvents;
      patch.beforeToolCall = async (ctx: { toolName: string }) => {
        events.push(`start:${ctx.toolName}`);
      };
      patch.afterToolCall = async (ctx: { toolName: string }) => {
        events.push(`end:${ctx.toolName}`);
      };
    }
  });

  return {
    key,
    stub,
    wait: (input: string) => (stub as unknown as WaitOnlyAgent).runTurn({ mode: "wait", input }),
    submit: (input: string, idempotencyKey: string) =>
      (stub as unknown as SubmitOnlyAgent).runTurn({ mode: "submit", input, idempotencyKey }),
    messages: async () => (await stub.getMessages()) as unknown as UIMessage[],
  };
}

/**
 * A provider that records the options every invocation was built with.
 *
 * Wraps rather than replaces, so the recorded call is the one the loop actually
 * made and the surrounding fixture keeps its meaning.
 */
function recordingModel(inner: LanguageModel, calls: unknown[]): LanguageModel {
  const model = inner as unknown as MockLanguageModelV4;
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: FABLE_5_MODEL_ID,
    doStream: async (callOptions) => {
      calls.push(callOptions.prompt);
      return model.doStream(callOptions);
    },
  }) as unknown as LanguageModel;
}

type UiPart = { type: string; [key: string]: unknown };

function partsOf(message: UIMessage | undefined): UiPart[] {
  return ((message?.parts ?? []) as unknown as UiPart[]) ?? [];
}

function textPartsOf(message: UIMessage | undefined): string[] {
  return partsOf(message)
    .filter((part) => part.type === "text")
    .map((part) => String(part.text ?? ""));
}

function toolPartsOf(message: UIMessage | undefined): UiPart[] {
  return partsOf(message).filter((part) => part.type.startsWith("tool-"));
}

function lastAssistant(messages: UIMessage[]): UIMessage | undefined {
  return messages.filter((message) => message.role === "assistant").at(-1);
}

/** Everything the turn left in the assistant's message, as one string. */
function transcriptText(messages: UIMessage[]): string {
  return JSON.stringify(messages);
}

/** Poll until `predicate` holds, or give up. Used only for durable submits. */
async function settle(
  read: () => Promise<UIMessage[]>,
  predicate: (messages: UIMessage[]) => boolean,
  timeoutMs = 8_000,
): Promise<UIMessage[]> {
  const deadline = Date.now() + timeoutMs;
  let latest = await read();
  while (!predicate(latest)) {
    if (Date.now() > deadline) return latest;
    await new Promise((resolve) => setTimeout(resolve, 25));
    latest = await read();
  }
  return latest;
}

/* ------------------------------------------------------------ the ceiling -- */

describe("the step ceiling is preflighted, not left to stopWhen", () => {
  it("refuses to build a turn for a spent budget, before the provider is invoked", async () => {
    // `stepCountIs(n)` is strict equality in the pinned SDK, so a zero budget
    // expressed only as `stopWhen` would never fire and the first call would be
    // made anyway — with money. `beforeTurn` builds its config through
    // `firefighterTurnConfig`, which is where that preflight lives on this
    // chassis, and it runs BEFORE `streamText` is entered at all.
    let composed = 0;
    const model = mockModel([textStep({ chunks: ["should never be reached"] })]);
    const harness = await thinkRun({ model });
    await runInDurableObject(harness.stub, (agent: RunAgent) => {
      const patch = agent as unknown as Patchable;
      patch.getModel = () => {
        composed += 1;
        return model;
      };
    });

    // `.then(ok, err)` rather than `expect(...).rejects`: a rejection that
    // crosses the DO boundary unobserved fails the pool run.
    const spent = await runInDurableObject(harness.stub, (agent: RunAgent) =>
      firefighterTurnConfig(agent, DEFAULT_AGENT_LIMITS, 0).then(
        () => "built a turn config for a spent budget",
        (error: unknown) => String(error),
      ),
    );
    expect(spent).toMatch(/positive integer/);

    // ...and a positive budget still carries the reviewed policy: AI Gateway is
    // the only retry owner (invariant 27) and the ceiling is a real condition.
    const config = await runInDurableObject(harness.stub, (agent: RunAgent) =>
      firefighterTurnConfig(agent, DEFAULT_AGENT_LIMITS, 3),
    );
    expect(config.maxRetries).toBe(0);
    expect(config.stopWhen).toBeTypeOf("function");

    // Nothing was billed, because no model was ever composed.
    expect(composed).toBe(0);
  });

  it("returns step_limit — never an empty answer — when the step ceiling lands mid tool loop", async () => {
    // A model that only ever calls the tool. With the ceiling at two steps the
    // loop must stop at two, and it must not promote the half-finished turn to
    // an answer.
    const calls: number[] = [];
    const model = mockModel([toolStep({ toolCallId: "call_ceiling", code: TRIVIAL })], {
      onCall: (call) => calls.push(call),
    });
    const harness = await thinkRun({ model, maxSteps: 2 });

    await harness.wait("the deploy is stuck");

    // The ceiling held: a third step would have been a third billed call.
    expect(calls).toHaveLength(2);

    const messages = await harness.messages();
    const assistant = lastAssistant(messages);
    // Work really was done...
    expect(toolPartsOf(assistant).length).toBeGreaterThan(0);
    // ...and nothing empty was promoted to an answer. An empty final text part
    // is exactly what a customer would read as "the agent had nothing to say".
    for (const text of textPartsOf(assistant)) expect(text.trim()).not.toBe("");

    // NOTE (TEST-FINDINGS): this chassis has no typed `step_limit` outcome —
    // `SaveMessagesResult.status` is `completed` for a turn the ceiling cut
    // short, so nothing downstream can tell a finished answer from a truncated
    // one. The two assertions above are the safety half of the legacy property;
    // the reporting half is the gap.
  });
});

/* -------------------------------------------------------- prompt authority -- */

describe("customer text reaches the model only as untrusted user data", () => {
  it("never puts customer bytes anywhere but a user message", async () => {
    const CUSTOMER = "exports are empty since the 04:12 deploy";
    const prompts: unknown[] = [];
    const model = recordingModel(mockModel([textStep({ chunks: ["ok"] })]), prompts);
    const harness = await thinkRun({ model });

    await harness.wait(CUSTOMER);

    expect(prompts.length).toBeGreaterThan(0);
    const prompt = prompts[0] as Array<{ role: string; content: unknown }>;

    // The system blocks are OURS — a stable policy prefix and host-assembled
    // facts. Customer bytes there would be customer text speaking with system
    // authority, which is the whole prompt-injection surface (invariant 26).
    const system = prompt.filter((message) => message.role === "system");
    expect(system.length).toBeGreaterThan(0);
    expect(JSON.stringify(system)).not.toContain(CUSTOMER);

    // ...and it did reach the model, as a user turn, so the assertion above is
    // about placement rather than about the text having been dropped.
    const user = prompt.filter((message) => message.role === "user");
    expect(JSON.stringify(user)).toContain(CUSTOMER);
  });
});

/* ---------------------------------------------------- the tool round trip -- */

describe("text -> run_code -> result -> final answer", () => {
  it("treats a Code Mode error as a normal tool result AND a failed tool event", async () => {
    const prompts: unknown[] = [];
    const model = recordingModel(
      mockModel([
        toolStep({ toolCallId: "call_reply", code: REPLY }),
        textStep({ chunks: ["That query is not available; here is what I could check."] }),
      ]),
      prompts,
    );
    const harness = await thinkRun({ model });

    const result = await harness.wait("reply to the customer");
    expect(result.status).toBe("completed");

    // HALF ONE — a normal tool result. The refusal did not throw out of the
    // tool, so a second step ran and the model adapted to it.
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[1])).toContain("slack_context_required");

    // HALF TWO — and it is nonetheless recorded as a FAILURE, not as a value.
    // Both are true at once: the model sees a result it can reason about, the
    // host record says the capability refused.
    const messages = await harness.messages();
    const call = toolPartsOf(lastAssistant(messages)).find(
      (part) => part.toolCallId === "call_reply",
    );
    expect(call).toBeDefined();
    const output = call?.output as { status?: string; error?: string } | undefined;
    expect(output?.status).toBe("error");
    expect(String(output?.error ?? "")).toContain("slack_context_required");
  });

  it("emits the outer tool lifecycle exactly once per run_code call", async () => {
    const toolEvents: string[] = [];
    const model = mockModel([
      toolStep({ toolCallId: "call_once", code: TRIVIAL }),
      textStep({ chunks: ["done"] }),
    ]);
    const harness = await thinkRun({ model, toolEvents });

    await harness.wait("check the deploy");

    // One start, one end, for the one call. Wiring an audit sink on TOP of
    // Think's own tool lifecycle would make this four, with the second
    // `completed` overwriting the first's output — the exact duplication the
    // legacy suite pins for `withOuterToolEvents`.
    expect(toolEvents).toEqual(["start:run_code", "end:run_code"]);

    // ...and the durable record agrees: one part for one call id, not two.
    const messages = await harness.messages();
    const parts = toolPartsOf(lastAssistant(messages)).filter(
      (part) => part.toolCallId === "call_once",
    );
    expect(parts).toHaveLength(1);
  });

  it("persists only the terminal step's text as the final turn; a redelivered finalization appends no second turn", async () => {
    const model = mockModel([
      toolStep({
        toolCallId: "call_final",
        code: TRIVIAL,
        narration: ["Let me check ", "the deploy logs."],
      }),
      textStep({ chunks: ["The 04:12 deploy ", "renamed a column."] }),
    ]);
    const harness = await thinkRun({ model });

    await harness.wait("why are exports empty");

    const texts = textPartsOf(lastAssistant(await harness.messages()));
    // The ANSWER is the terminal step's text, whole and on its own. Narration
    // was streamed and is kept in the transcript, but it is not the answer, and
    // a reader that took the first text part would send the customer a
    // half-finished thought.
    expect(texts.at(-1)).toBe("The 04:12 deploy renamed a column.");
    expect(texts.at(-1)).not.toContain("Let me check");

    // Redelivery. The durable submission row is keyed on `idempotencyKey`
    // (verified fact 10), so an at-least-once queue that re-delivers the same
    // Slack `event_id` must not append a second copy of the same input — which
    // is what would produce a second answer to one customer message.
    const token = `Ev${crypto.randomUUID()}`;
    const first = await harness.submit("and what about billing?", token);
    const second = await harness.submit("and what about billing?", token);
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);

    const settled = await settle(harness.messages, (messages) =>
      messages.some(
        (message) =>
          message.role === "user" && textPartsOf(message).join("").includes("and what about billing?"),
      ),
    );
    const repeats = settled.filter(
      (message) =>
        message.role === "user" && textPartsOf(message).join("").includes("and what about billing?"),
    );
    expect(repeats).toHaveLength(1);
  });
});

/* -------------------------------------------------------- terminal paths -- */

describe("every terminal path leaves the run legal and resumable", () => {
  it("maps a provider refusal to a refused generation that a later steer can resume", async () => {
    // A refusal, then a normal answer: the script's entries are consumed in
    // order, so the SECOND turn is the one that recovers.
    const model = mockModel([
      textStep({ chunks: [], unified: "content-filter", raw: "refusal" }),
      textStep({ chunks: ["The 502s stopped at 14:10 after the rollback."] }),
    ]);
    const harness = await thinkRun({ model });

    await harness.wait("is the outage over?");

    // Nothing was promoted to an answer: a refusal is not a completion
    // (invariant 30), and half a refused message is not something to send.
    const refused = lastAssistant(await harness.messages());
    for (const text of textPartsOf(refused)) expect(text.trim()).toBe("");

    // The run is RESUMABLE — `requires_input`, not terminal. A human correcting
    // the run afterwards must get a real answer rather than a dead session.
    const resumed = await harness.wait("try again, and stick to what we verified");
    expect(resumed.status).toBe("completed");
    const answered = lastAssistant(await harness.messages());
    expect(textPartsOf(answered).join("")).toBe("The 502s stopped at 14:10 after the rollback.");
  });

  it("maps a provider stream error to a bounded retry, and a timeout-shaped error to provider_timeout", async () => {
    const calls: number[] = [];
    const model = mockModel([errorStep("upstream connection reset")], {
      onCall: (call) => calls.push(call),
    });
    const harness = await thinkRun({ model });

    const result = await harness.wait("the deploy is stuck");

    // The turn FAILED. Reporting `completed` for a stream the provider dropped
    // is the silent-wrong-answer shape: the dashboard says answered, the
    // customer got nothing.
    expect(result.status).toBe("error");

    // BOUNDED. `maxRetries: 0` makes AI Gateway the only retry owner
    // (invariant 27); an SDK that retried on its own would multiply the
    // reviewed worst-case spend with nothing thrown anywhere.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBeLessThanOrEqual(DEFAULT_AGENT_LIMITS.gatewayMaxAttempts);

    // The timeout-shaped half. Same shape of failure, same bounded treatment.
    const timeoutCalls: number[] = [];
    const timing = await thinkRun({
      model: mockModel([errorStep("the request timed out after 90000ms")], {
        onCall: (call) => timeoutCalls.push(call),
      }),
    });
    const timedOut = await timing.wait("the deploy is stuck");
    expect(timedOut.status).toBe("error");
    expect(timeoutCalls.length).toBeLessThanOrEqual(DEFAULT_AGENT_LIMITS.gatewayMaxAttempts);

    // NOTE (TEST-FINDINGS): the legacy loop separates these two into
    // `infrastructure_retry` and `provider_timeout` and drives a scheduled
    // retry off the difference. This chassis reports one untyped `error`
    // string, so the distinction — and the bounded re-schedule that depends on
    // it — does not exist here yet.
  });

  it.fails("stops on the generation spend cap rather than buying another step", async () => {
    // KNOWN GAP (TEST-FINDINGS): `generationSpendCapNanoUsd` is read only by
    // `src/agent/loop.ts`. Nothing on the Think chassis consults it, so a run
    // that has already spent past the cap buys another step anyway.
    let calls = 0;
    const model = mockModel([textStep({ chunks: ["never reached"] })], {
      onCall: () => {
        calls += 1;
      },
    });
    const harness = await thinkRun({ model });

    // Spend, recorded through the production usage path, far past the cap.
    await harness.stub.recordUsageForTest({
      stepId: `step_${crypto.randomUUID()}`,
      model: FABLE_5_MODEL_ID,
      usage: { inputTokens: 1_000_000_000, outputTokens: 1_000_000, totalTokens: 1_001_000_000 },
    });

    await harness.wait("keep going");

    // The provider must not have been invoked at all: the cap is a preflight,
    // not a post-hoc report.
    expect(calls).toBe(0);
  });
});

/* ------------------------------------------------------- delivery labels -- */

describe("a final turn says how it may be delivered", () => {
  it.fails("labels a Slack final turn as internal narration and a Chat final turn as visible", async () => {
    // KNOWN GAP (TEST-FINDINGS): `internal_narration` exists only in
    // `src/run/session.ts` (the legacy chassis). A Think final turn carries no
    // delivery label at all, so a surface that renders the transcript cannot
    // tell "this is run narration, the customer never saw it" from "this was
    // sent". Customer-facing output happens only through `slack.reply`, so the
    // label — not the origin — is what a renderer must read.
    const slack = await thinkRun({
      model: mockModel([textStep({ chunks: ["drafted, not sent"] })]),
      origin: "slack",
    });
    await slack.wait("the customer is asking for an update");
    const slackFinal = lastAssistant(await slack.messages());
    expect((slackFinal?.metadata as { delivery?: string } | undefined)?.delivery).toBe(
      "internal_narration",
    );

    const chat = await thinkRun({
      model: mockModel([textStep({ chunks: ["here is the answer"] })]),
      origin: "chat",
    });
    await chat.wait("what happened?");
    const chatFinal = lastAssistant(await chat.messages());
    expect((chatFinal?.metadata as { delivery?: string } | undefined)?.delivery).toBe("visible");
  });
});

/* --------------------------------------------------- the freshness guard -- */

describe("the execution guard reaches the tool through the shipping composition", () => {
  it.fails("turns a stale generation (superseded by a newer wake) into a safe tool result the model can read", async () => {
    // KNOWN GAP (TEST-FINDINGS): `src/run/agent.ts` composes its connectors
    // with `alwaysFresh()`, so nothing behind `run_code` can tell that the
    // generation it belongs to has been superseded. On the legacy chassis that
    // check is durable and cannot be switched off (invariant 15) — a capability
    // that runs for an abandoned question can post an answer to a customer who
    // has already moved on.
    const harness = await thinkRun({ model: mockModel([textStep({ chunks: ["ok"] })]) });

    // A NEWER input, durably admitted. Everything already in flight for the
    // previous question is now stale.
    await harness.submit("actually — ignore that, what about billing?", `Ev${crypto.randomUUID()}`);

    // The tool's own `execute`, i.e. exactly what a still-running step would
    // call. A refusal here is a RESULT the model reads and adapts to, never a
    // crash.
    const output = await harness.stub.executeForTest("return 1");
    expect(output.status).toBe("error");
    expect(JSON.stringify(output)).toContain("stale_generation");
  });
});

/* --------------------------------------------------------- the provider -- */

describe("the Think path reaches Fable only through an authenticated Gateway", () => {
  /**
   * `test/agent-gateway.test.ts` proves `createProductionModelFactory` attaches
   * `cf-aig-authorization`. It does NOT prove the Think chassis goes through
   * that factory: `getModel()` calls `firefighterModel`, which resolves the
   * composer through a dynamic import, and deleting the auth term or swapping
   * the composer there is invisible to that suite.
   *
   * So this drives `firefighterModel` itself and inspects the REQUEST. No
   * `vi.mock`: `src/run/agent-prompt.ts` is in the Worker entry's eager module
   * graph, and a module registered there cannot be re-mocked from a test file.
   * `globalThis.fetch` is resolved by the provider per request, so spying on it
   * catches the composed model at the last possible moment.
   */
  const CANARY_GATEWAY_TOKEN = "cf-aig-canary-think-3d81f0e9c2a4e6f8d3b1a5c7e9f0d2b4";
  const CANARY_API_KEY = "sk-ant-canary-think-4f2e8a1c6b9d3e7f0a5c2b8d4e6f1a3c";

  function headerBag(input: unknown, init: unknown): Record<string, string> {
    const raw =
      (init as { headers?: unknown } | undefined)?.headers ??
      (input instanceof Request ? input.headers : undefined);
    const out: Record<string, string> = {};
    if (raw === undefined || raw === null) return out;
    if (raw instanceof Headers) {
      raw.forEach((value, name) => {
        out[name.toLowerCase()] = value;
      });
      return out;
    }
    if (Array.isArray(raw)) {
      for (const [name, value] of raw as [string, string][]) out[String(name).toLowerCase()] = value;
      return out;
    }
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") out[name.toLowerCase()] = value;
    }
    return out;
  }

  it("attaches the AI Gateway auth header on the Think path", async () => {
    // The composer is reached the way the chassis reaches it, and the stand-in
    // carries exactly what `firefighterModel` reads: the run key and the env.
    // (The pool's own env binds EMPTY gateway settings on purpose, so no suite
    // can compose a real provider; these are canaries that exist nowhere else.)
    await primeModelModule();
    const agent = {
      name: `chat:${crypto.randomUUID()}`,
      env: {
        ...env,
        ANTHROPIC_API_KEY: CANARY_API_KEY,
        AI_GATEWAY_ANTHROPIC_URL: `https://${GATEWAY_PROVIDER_NATIVE_HOST}/v1/acct-1/ff/anthropic`,
        AI_GATEWAY_TOKEN: CANARY_GATEWAY_TOKEN,
      },
    } as unknown as RunAgent;

    const requests: { url: string; headers: Record<string, string> }[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: unknown,
      init?: unknown,
    ) => {
      requests.push({
        url: String(input instanceof Request ? input.url : input),
        headers: headerBag(input, init),
      });
      // Refused rather than answered: this test is about what left the Worker.
      return new Response(JSON.stringify({ type: "error", error: { type: "api_error" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch);

    try {
      const model = firefighterModel(agent) as unknown as {
        doStream(options: unknown): Promise<unknown>;
      };
      await model
        .doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "the deploy is stuck" }] }],
        })
        .catch(() => undefined);
    } finally {
      spy.mockRestore();
    }

    expect(requests).toHaveLength(1);
    const request = requests[0];
    // Provider-native Gateway endpoint, never api.anthropic.com (invariant 27).
    expect(new URL(request.url).hostname).toBe(GATEWAY_PROVIDER_NATIVE_HOST);
    // THE positive assertion. An unauthenticated request against a gateway that
    // is not configured as authenticated SUCCEEDS, which defeats the "nobody
    // else can inflate this bill" property — and nothing else in this repo
    // notices its absence on the Think path.
    expect(request.headers[GATEWAY_AUTH_HEADER]).toBe(`Bearer ${CANARY_GATEWAY_TOKEN}`);
    // The provider still sends its own credential; the two are separate.
    expect(request.headers["x-api-key"]).toBe(CANARY_API_KEY);
    // ...and the reviewed policy travels on the same request, not instead of it.
    expect(request.headers["cf-aig-collect-log-payload"]).toBe("false");
    expect(request.headers["cf-aig-skip-cache"]).toBe("true");
  });
});

/* --------------------------------------------------------- thinking safety -- */

describe("reasoning is opaque or it is refused", () => {
  it.fails("fails the step safely when readable, unsigned thinking arrives", async () => {
    // The other half of `test/run-agent-thinking.test.ts`, which pins the
    // SIGNED case (a byte-identical round trip) and pins that readable
    // reasoning does not reach D1, Zep or a log — but not that the step fails.
    //
    // KNOWN GAP (TEST-FINDINGS): the rejection lives in
    // `src/agent/transcript.ts` and is reached only from `src/agent/loop.ts`.
    // Nothing on the Think chassis inspects reasoning parts, so readable
    // chain-of-thought is accepted, persisted in the session and carried
    // forward into the next request instead of failing the step.
    const model = mockModel([readableReasoningStep()]);
    const harness = await thinkRun({ model });

    const result = await harness.wait("the deploy is stuck");

    // Safe failure, not a completed turn built on readable reasoning.
    expect(result.status).toBe("error");
    // ...and the thinking itself never became part of the run's answer.
    expect(transcriptText(await harness.messages())).not.toContain("probably lying");
  });
});
