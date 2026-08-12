import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  normalizeResponseMessages,
  readOmittedThinking,
  selectModelHistory,
  type ResponseMessage,
  type TranscriptMessage,
} from "../src/agent/transcript";
import {
  appendTurn,
  checkpointStepMessages,
  claimGeneration,
  initializeSession,
  listEvents,
  readModelTranscript,
  type RunDescriptor,
} from "../src/run/session";
import { chatRunKey } from "../src/run/keys";
import type { ClaimFence } from "../src/agent/contracts";
import type { ModelMessage } from "ai";

/**
 * Storage carries across cases AND files in vitest-pool-workers 0.21, so every
 * case mints its own key and nothing asserts an absolute sequence. Same rule as
 * `agent-state.test.ts`; see phase-08-notes.md.
 */
function freshRun() {
  const runId = crypto.randomUUID();
  const key = chatRunKey(crypto.randomUUID());
  const stub = env.RUNS.get(env.RUNS.idFromName(key));
  const descriptor: RunDescriptor = {
    runId,
    key,
    origin: "chat",
    channelId: null,
    threadTs: null,
  };
  return { stub, descriptor };
}

function inRun<T>(stub: DurableObjectStub, fn: (storage: DurableObjectStorage) => T): Promise<T> {
  return runInDurableObject(stub, (_instance, state) => fn(state.storage));
}

async function claimedRun() {
  const run = freshRun();
  const claim = await inRun(run.stub, (s) => {
    initializeSession(s, run.descriptor, 1_000);
    appendTurn(
      s,
      { id: `slack:${crypto.randomUUID()}`, role: "user", source: "customer", content: "exports are empty" },
      1_001,
    );
    const outcome = claimGeneration(s, { now: 2_000, leaseMs: 60_000 });
    if (outcome.outcome !== "claimed") throw new Error(`expected a claim, got ${outcome.outcome}`);
    return outcome.claim;
  });
  return { ...run, claim, fence: claim.fence as ClaimFence };
}

/**
 * A realistic Fable tool-use step: an omitted-thinking block carrying an opaque
 * signature, the `run_code` call it accompanies, and the tool result.
 *
 * The signature is deliberately full of characters an eager sanitiser would
 * touch — `+`, `/`, `=`, mixed case — because "unmodified" is the whole claim.
 */
const SIGNATURE =
  "ErUBCkYIBBgCKkBv+Sm3/Hh1lYq0Zx8xQ==pTr4d9OeJ/kK7wLmN0aXyZbC1dEfGhIjKlMnOpQrStUvWxYz0123456789+/=abc";

function fableStep(options: { redacted?: boolean } = {}): ResponseMessage[] {
  const thinkingMetadata = options.redacted
    ? { redactedData: "EroBCkYIBBgCKkD3RedactedOpaqueBlob==/+abcDEF" }
    : { signature: SIGNATURE };

  return [
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "", providerOptions: { anthropic: thinkingMetadata } },
        {
          type: "tool-call",
          toolCallId: "toolu_01ABC",
          toolName: "run_code",
          input: { code: "async () => (await supabase.select({ resource: 'exports' })).length" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "toolu_01ABC",
          toolName: "run_code",
          output: { type: "json", value: { result: 0, logs: [], metrics: { capabilityCalls: 1 } } },
        },
      ],
    },
  ];
}

// --- Step 5: the response-part allowlist ------------------------------------

describe("response message allowlist", () => {
  it("keeps assistant text, the run_code call, and its result", () => {
    const outcome = normalizeResponseMessages([
      { role: "assistant", content: [{ type: "text", text: "Checking the export job." }] },
      ...fableStep(),
    ]);
    expect(outcome.outcome).toBe("normalized");
    if (outcome.outcome !== "normalized") return;

    expect(outcome.messages).toHaveLength(3);
    expect(outcome.messages[0]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Checking the export job." }],
    });
    expect(outcome.dropped).toEqual([]);
  });

  it("keeps the omitted-thinking block and its signature unmodified", () => {
    const outcome = normalizeResponseMessages(fableStep());
    expect(outcome.outcome).toBe("normalized");
    if (outcome.outcome !== "normalized") return;

    const reasoning = (outcome.messages[0] as { content: Array<{ type: string }> }).content[0] as {
      type: string;
      text: string;
      providerOptions: { anthropic: { signature: string } };
    };
    expect(reasoning.type).toBe("reasoning");
    // Persisted thinking display text is empty — invariant 17's expected case.
    expect(reasoning.text).toBe("");
    // Byte-identical, including the `+`, `/` and `=` an over-eager encoder eats.
    expect(reasoning.providerOptions.anthropic.signature).toBe(SIGNATURE);
    expect(Object.keys(reasoning.providerOptions.anthropic)).toEqual(["signature"]);
  });

  it("keeps a redacted thinking block the same way", () => {
    const outcome = normalizeResponseMessages(fableStep({ redacted: true }));
    if (outcome.outcome !== "normalized") throw new Error("expected a normalized step");
    const reasoning = (outcome.messages[0] as { content: Array<Record<string, unknown>> })
      .content[0] as { providerOptions: { anthropic: { redactedData: string } } };
    expect(reasoning.providerOptions.anthropic.redactedData).toBe(
      "EroBCkYIBBgCKkD3RedactedOpaqueBlob==/+abcDEF",
    );
  });

  /**
   * The safety case. `display: "omitted"` should make this impossible; if it
   * happens anyway, the provider ignored an option we depend on, and the right
   * answer is to refuse the step — NOT to blank the text and replay a signature
   * we can no longer reason about (invariant 17).
   */
  it("rejects the step outright if readable reasoning appears", () => {
    const step = fableStep();
    (step[0] as { content: Array<{ text?: string }> }).content[0].text =
      "First I should check whether the customer is lying about the deploy time.";

    const outcome = normalizeResponseMessages(step);
    expect(outcome).toMatchObject({ outcome: "rejected", reason: "readable_reasoning" });
    // Nothing was mutated on the way out: the caller still holds the original.
    expect((step[0] as { content: Array<{ text?: string }> }).content[0].text).toContain("First I");
  });

  it("drops an empty thinking block that carries no continuation metadata", () => {
    const outcome = normalizeResponseMessages([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "", providerOptions: { anthropic: { cacheControl: null } } },
          { type: "text", text: "done" },
        ],
      },
    ]);
    if (outcome.outcome !== "normalized") throw new Error("expected a normalized step");
    expect(outcome.dropped).toEqual([
      { messageIndex: 0, partIndex: 0, partType: "reasoning", reason: "reasoning_without_signature" },
    ]);
    expect(outcome.messages[0]).toEqual({ role: "assistant", content: [{ type: "text", text: "done" }] });
  });

  it("rejects a tool call that is not run_code", () => {
    expect(
      normalizeResponseMessages([
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "t1", toolName: "slack_post", input: { text: "hi" } },
          ],
        },
      ]),
    ).toMatchObject({ outcome: "rejected", reason: "unsupported_tool" });
  });

  it("rejects a provider-executed tool call", () => {
    expect(
      normalizeResponseMessages([
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "t1",
              toolName: "run_code",
              input: { code: "x" },
              providerExecuted: true,
            },
          ],
        },
      ]),
    ).toMatchObject({ outcome: "rejected", reason: "provider_executed_tool" });
  });

  it("drops file, reasoning-file and custom parts rather than forwarding them", () => {
    const outcome = normalizeResponseMessages([
      {
        role: "assistant",
        content: [
          { type: "file", data: "aGk=", mediaType: "image/png" },
          { type: "reasoning-file", data: "aGk=", mediaType: "text/plain" },
          { type: "custom", kind: "anthropic.something", providerOptions: {} },
          { type: "text", text: "the answer" },
        ],
      },
    ] as unknown as ResponseMessage[]);
    if (outcome.outcome !== "normalized") throw new Error("expected a normalized step");

    expect(outcome.dropped.map((entry) => entry.partType)).toEqual([
      "file",
      "reasoning-file",
      "custom",
    ]);
    expect(outcome.messages[0]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "the answer" }],
    });
  });

  it("rejects a tool output that cannot be stored", () => {
    const step = fableStep();
    (step[1] as { content: Array<{ output: unknown }> }).content[0].output = {
      type: "json",
      value: { cycle: undefined, fn: () => 1 },
    };
    expect(normalizeResponseMessages(step)).toMatchObject({
      outcome: "rejected",
      reason: "unserializable_tool_output",
    });
  });

  it("carries a tool error result through", () => {
    const step = fableStep();
    (step[1] as { content: Array<{ output: unknown }> }).content[0].output = {
      type: "error-text",
      value: "execution_timeout: the program ran for longer than 20000ms",
    };
    const outcome = normalizeResponseMessages(step);
    if (outcome.outcome !== "normalized") throw new Error("expected a normalized step");
    expect(outcome.messages[1]).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", output: { type: "error-text" } }],
    });
  });

  it("finds nothing to replay in metadata that carries no signature", () => {
    expect(readOmittedThinking(undefined)).toBeNull();
    expect(readOmittedThinking({ openai: { signature: "x" } })).toBeNull();
    expect(readOmittedThinking({ anthropic: { signature: "" } })).toBeNull();
  });
});

// --- Step 6: serialize -> deserialize -> continue ----------------------------

describe("Fable continuation validity (automated; the live proof is deferred)", () => {
  /**
   * NOT a live provider proof. No Anthropic call is made anywhere in this file.
   * This asserts that the durable round trip is lossless and that the recovered
   * history is one the AI SDK will build a request from without raising a
   * missing-tool-result or modified-thinking-block error. The live half — that
   * Anthropic itself accepts the replayed signature — remains NOT RUN and is
   * recorded in phase-10-notes.md under deferred live proofs.
   */
  it("round-trips a Fable tool-use step through durable storage byte for byte", async () => {
    const { stub, fence } = await claimedRun();
    const normalized = normalizeResponseMessages(fableStep());
    if (normalized.outcome !== "normalized") throw new Error("expected a normalized step");

    const recovered = await inRun(stub, (s) => {
      checkpointStepMessages(s, fence, { globalStep: 0, messages: normalized.messages, now: 3_000 });
      return readModelTranscript(s).map((entry) => entry.message);
    });

    expect(JSON.stringify(recovered)).toBe(JSON.stringify(normalized.messages));
  });

  it("round-trips a redacted thinking block the same way", async () => {
    const { stub, fence } = await claimedRun();
    const normalized = normalizeResponseMessages(fableStep({ redacted: true }));
    if (normalized.outcome !== "normalized") throw new Error("expected a normalized step");

    const recovered = await inRun(stub, (s) => {
      checkpointStepMessages(s, fence, { globalStep: 0, messages: normalized.messages, now: 3_000 });
      return readModelTranscript(s).map((entry) => entry.message);
    });
    expect(JSON.stringify(recovered)).toBe(JSON.stringify(normalized.messages));
  });

  it("continues from the recovered history with the signed block intact", async () => {
    const { stub, fence } = await claimedRun();
    const normalized = normalizeResponseMessages(fableStep());
    if (normalized.outcome !== "normalized") throw new Error("expected a normalized step");

    const recovered = await inRun(stub, (s) => {
      checkpointStepMessages(s, fence, { globalStep: 0, messages: normalized.messages, now: 3_000 });
      return readModelTranscript(s).map((entry) => entry.message as ModelMessage);
    });

    // A mock model, so nothing leaves the process. What it proves is that the
    // SDK's own prompt standardization accepts the recovered history: a split
    // tool exchange raises before `doGenerate` is ever reached.
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "Exports are empty because the job filters a renamed column." }],
        // `LanguageModelV4FinishReason` is an OBJECT in the installed provider
        // package — `{ unified, raw }` — not a bare string. Worth knowing before
        // Task 5 builds cost/finish accounting on it.
        finishReason: { unified: "stop" as const, raw: "end_turn" },
        // `LanguageModelV4Usage` nests its counters (`inputTokens.total`,
        // `outputTokens.reasoning`, …) at the PROVIDER level. The flat
        // `LanguageModelUsage` the plan's table describes is the AI-SDK-level
        // shape; they are two different types with similar names.
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 10, text: 10, reasoning: 0 },
        },
        warnings: [],
      }),
    });

    const result = await generateText({
      model,
      instructions: "stand-in for the stable policy",
      messages: [{ role: "user", content: "why are exports empty?" }, ...recovered],
    });
    expect(result.text).toContain("renamed column");

    // The signed block reached the provider layer unchanged.
    const sent = model.doGenerateCalls[0].prompt;
    const assistant = sent.find((message) => message.role === "assistant");
    const reasoning = (assistant?.content as unknown as Array<Record<string, unknown>>).find(
      (part) => part.type === "reasoning",
    ) as unknown as { text: string; providerOptions: { anthropic: { signature: string } } };
    expect(reasoning.text).toBe("");
    expect(reasoning.providerOptions.anthropic.signature).toBe(SIGNATURE);

    // And every tool call the model made still has its result beside it.
    const toolResults = sent.flatMap((message) =>
      message.role === "tool"
        ? (message.content as Array<{ toolCallId: string }>).map((part) => part.toolCallId)
        : [],
    );
    expect(toolResults).toEqual(["toolu_01ABC"]);
  });

  it("puts no reasoning, and no signature, into the run event stream", async () => {
    const { stub, fence } = await claimedRun();
    const normalized = normalizeResponseMessages(fableStep());
    if (normalized.outcome !== "normalized") throw new Error("expected a normalized step");

    const events = await inRun(stub, (s) => {
      checkpointStepMessages(s, fence, { globalStep: 0, messages: normalized.messages, now: 3_000 });
      return listEvents(s, 0, 100);
    });

    // The transcript is a private table. Checkpointing a step emits no RunEvent
    // at all, so there is nothing for a socket, a log, or a D1 projection to
    // carry away (invariant 18).
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(SIGNATURE);
    expect(serialized).not.toContain("reasoning");
    expect(serialized).not.toContain("thinking");
  });
});

// --- Step 7: bounded history selection --------------------------------------

describe("bounded history selection", () => {
  function entry(ordinal: number, generationId: string, message: ModelMessage): TranscriptMessage {
    return { ordinal, generationId, message };
  }

  /** N complete exchanges: user -> assistant(tool call) -> tool result. */
  function exchanges(count: number, generationId = "gen:old"): TranscriptMessage[] {
    const out: TranscriptMessage[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = `toolu_${index}`;
      const base = index * 3;
      out.push(entry(base + 1, generationId, { role: "user", content: `question ${index}` }));
      out.push(
        entry(base + 2, generationId, {
          role: "assistant",
          content: [
            { type: "reasoning", text: "", providerOptions: { anthropic: { signature: `sig${index}` } } },
            { type: "tool-call", toolCallId: id, toolName: "run_code", input: { code: "x" } },
          ],
        }),
      );
      out.push(
        entry(base + 3, generationId, {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: id, toolName: "run_code", output: { type: "json", value: index } },
          ],
        }),
      );
    }
    return out;
  }

  it("reads an empty transcript as nothing to send, not as a failure", () => {
    expect(selectModelHistory([], { maxMessages: 10, maxBytes: 1_000 })).toMatchObject({
      outcome: "selected",
      messages: [],
    });
  });

  it("keeps everything when it fits", () => {
    const selection = selectModelHistory(exchanges(3), { maxMessages: 100, maxBytes: 100_000 });
    expect(selection).toMatchObject({ outcome: "selected", droppedGroups: 0 });
    if (selection.outcome !== "selected") return;
    expect(selection.messages).toHaveLength(9);
  });

  it("never splits an assistant tool call from its tool result", () => {
    // A message cap that lands mid-exchange. The pruner must evict the whole
    // group rather than take the cap literally.
    for (const maxMessages of [3, 4, 5, 6, 7, 8]) {
      const selection = selectModelHistory(exchanges(4), { maxMessages, maxBytes: 100_000 });
      if (selection.outcome !== "selected") continue;

      const callIds = new Set<string>();
      const resultIds = new Set<string>();
      for (const message of selection.messages) {
        if (message.role === "assistant" && Array.isArray(message.content)) {
          for (const part of message.content) {
            if (part.type === "tool-call") callIds.add(part.toolCallId);
          }
        }
        if (message.role === "tool") {
          for (const part of message.content) {
            if (part.type === "tool-result") resultIds.add(part.toolCallId);
          }
        }
      }
      expect([...resultIds].every((id) => callIds.has(id))).toBe(true);
      expect([...callIds].every((id) => resultIds.has(id))).toBe(true);
    }
  });

  it("never separates a thinking block from the call it accompanies", () => {
    const selection = selectModelHistory(exchanges(4), { maxMessages: 6, maxBytes: 100_000 });
    if (selection.outcome !== "selected") throw new Error("expected a selection");

    for (const message of selection.messages) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      const hasReasoning = message.content.some((part) => part.type === "reasoning");
      const hasCall = message.content.some((part) => part.type === "tool-call");
      // They are parts of ONE message, so this is structural: a thinking block
      // can only be lost by dropping the tool call with it.
      expect(hasReasoning).toBe(hasCall);
    }
  });

  it("evicts from the oldest end", () => {
    const selection = selectModelHistory(exchanges(4), { maxMessages: 6, maxBytes: 100_000 });
    if (selection.outcome !== "selected") throw new Error("expected a selection");
    expect(selection.droppedGroups).toBeGreaterThan(0);
    expect(JSON.stringify(selection.messages)).toContain("question 3");
    expect(JSON.stringify(selection.messages)).not.toContain("question 0");
  });

  it("protects the current unsettled generation", () => {
    const history = [...exchanges(3, "gen:old"), ...exchanges(2, "gen:current")].map(
      (item, index) => ({ ...item, ordinal: index + 1 }),
    );
    const selection = selectModelHistory(history, {
      maxMessages: 6,
      maxBytes: 100_000,
      protectedGenerationId: "gen:current",
    });
    if (selection.outcome !== "selected") throw new Error("expected a selection");
    expect(selection.messages).toHaveLength(6);
    expect(selection.messages.every((message) => message.role !== "system")).toBe(true);
  });

  it("returns context_limit rather than truncating the unsettled generation", () => {
    const history = exchanges(3, "gen:current");
    expect(
      selectModelHistory(history, {
        maxMessages: 4,
        maxBytes: 100_000,
        protectedGenerationId: "gen:current",
      }),
    ).toMatchObject({ outcome: "context_limit", reason: "protected_exceeds_budget" });
  });

  it("returns context_limit when a single exchange exceeds the byte budget", () => {
    expect(selectModelHistory(exchanges(2), { maxMessages: 100, maxBytes: 50 })).toMatchObject({
      outcome: "context_limit",
      reason: "protected_exceeds_budget",
    });
  });

  it("refuses a history whose tool result has no call, rather than repairing it", () => {
    const orphan: TranscriptMessage[] = [
      entry(1, "gen:1", {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "ghost", toolName: "run_code", output: { type: "json", value: 1 } },
        ],
      }),
    ];
    expect(selectModelHistory(orphan, { maxMessages: 100, maxBytes: 100_000 })).toMatchObject({
      outcome: "context_limit",
      reason: "unpaired_tool_call",
    });
  });

  it("keeps a trailing unresolved tool call, which is a real crash-recovery state", () => {
    const history = [
      ...exchanges(1),
      entry(4, "gen:current", {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "toolu_live", toolName: "run_code", input: { code: "x" } }],
      }),
    ];
    const selection = selectModelHistory(history, { maxMessages: 100, maxBytes: 100_000 });
    expect(selection.outcome).toBe("selected");
  });

  it("refuses when an unresolved call is stranded in the middle of the history", () => {
    const history = [
      entry(1, "gen:1", {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "toolu_lost", toolName: "run_code", input: { code: "x" } }],
      }),
      entry(2, "gen:1", { role: "user", content: "still there?" }),
    ];
    expect(selectModelHistory(history, { maxMessages: 100, maxBytes: 100_000 })).toMatchObject({
      outcome: "context_limit",
      reason: "unpaired_tool_call",
    });
  });
});
