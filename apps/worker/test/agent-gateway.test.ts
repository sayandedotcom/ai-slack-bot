import { describe, expect, it, vi } from "vitest";
import { streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  buildGatewayMetadata,
  GATEWAY_AUTH_HEADER,
  GATEWAY_METADATA_MAX_BYTES,
  GATEWAY_METADATA_MAX_VALUES,
  GATEWAY_PROVIDER_NATIVE_HOST,
  gatewayHeaders,
  GatewayMetadataError,
} from "../src/agent/gateway";
import {
  ANTHROPIC_REFUSAL_RAW_REASON,
  classifyStepOutcome,
  createProductionModelFactory,
  modelCallOptions,
  ModelCompositionError,
  REFUSAL_GENERATION_STATE,
  REFUSAL_RESUME_POLICY,
  REFUSAL_SAFE_MESSAGE,
  type ModelEnv,
} from "../src/agent/model";
import { costNanoUsd, FABLE_5_MODEL_ID, normalizeSdkUsage } from "../src/agent/cost";
import {
  DEFAULT_AGENT_LIMITS,
  GATEWAY_BACKOFF,
  GATEWAY_MAX_ATTEMPTS,
  GATEWAY_REQUEST_TIMEOUT_MS,
  GATEWAY_RETRY_DELAY_MS,
} from "../src/agent/limits";

/**
 * The provider path: safe Gateway headers, a composer that fails closed, one
 * retry owner, and refusal as a first-class outcome.
 *
 * Nothing here reaches the network. The production composer is exercised only
 * for its refusals and for what it does with a canary credential; every model
 * that actually runs is a `MockLanguageModelV4`.
 */

/**
 * A value that appears NOWHERE else in this repo. If it turns up in a header
 * map, a metadata document, a log line, an error, or a serialized handle, the
 * only way it got there is the composer leaking it.
 */
const CANARY_GATEWAY_TOKEN = "cf-aig-canary-b7d41f0e9c2a4e6f8d3b1a5c7e9f0d2b";
const CANARY_API_KEY = "sk-ant-canary-4f2e8a1c6b9d3e7f0a5c2b8d4e6f1a3c";

function canaryEnv(overrides: Partial<ModelEnv> = {}): ModelEnv {
  return {
    ANTHROPIC_API_KEY: CANARY_API_KEY,
    AI_GATEWAY_ANTHROPIC_URL: `https://${GATEWAY_PROVIDER_NATIVE_HOST}/v1/acct-1/ff/anthropic`,
    AI_GATEWAY_TOKEN: CANARY_GATEWAY_TOKEN,
    ...overrides,
  };
}

const invocation = {
  runId: "run:2f9c1e44-0000-4000-8000-000000000001",
  generationId: "gen:2f9c1e44-0000-4000-8000-000000000002",
  attempt: 1,
  surface: "slack" as const,
};

/** Every string reachable from a value, for canary sweeps. */
function reachableStrings(value: unknown, depth = 0, seen = new Set<unknown>()): string[] {
  if (depth > 6 || value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (typeof value === "function") return [value.toString()];
  if (typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const out: string[] = [];
  for (const entry of Object.values(value as Record<string, unknown>)) {
    out.push(...reachableStrings(entry, depth + 1, seen));
  }
  return out;
}

describe("gateway header helper", () => {
  it("produces the exact reviewed header map", () => {
    expect(gatewayHeaders({ ...invocation, run: invocation.runId, generation: invocation.generationId })).toEqual({
      "cf-aig-collect-log-payload": "false",
      "cf-aig-skip-cache": "true",
      "cf-aig-max-attempts": "2",
      "cf-aig-retry-delay": "250",
      "cf-aig-backoff": "exponential",
      "cf-aig-request-timeout": "30000",
      "cf-aig-metadata":
        '{"run":"run:2f9c1e44-0000-4000-8000-000000000001","generation":"gen:2f9c1e44-0000-4000-8000-000000000002","attempt":1,"surface":"slack"}',
    });
  });

  it("turns payload collection off as the string false, not a boolean", () => {
    const headers = gatewayHeaders({ run: "run:a", generation: "gen:b", attempt: 0, surface: "chat" });
    // Headers are strings on the wire; a boolean would stringify to "true"
    // under some serializers and silently enable payload logging.
    expect(headers["cf-aig-collect-log-payload"]).toBe("false");
    expect(typeof headers["cf-aig-collect-log-payload"]).toBe("string");
  });

  it("skips gateway RESPONSE caching for customer prompts", () => {
    const headers = gatewayHeaders({ run: "run:a", generation: "gen:b", attempt: 0, surface: "chat" });
    // One customer's answer must never be served to another. This is unrelated
    // to Anthropic PROMPT caching, which this system uses on purpose.
    expect(headers["cf-aig-skip-cache"]).toBe("true");
  });

  it("states timeout, retry delay, attempts and backoff explicitly", () => {
    const headers = gatewayHeaders({ run: "run:a", generation: "gen:b", attempt: 0, surface: "chat" });
    // All four present, so a Gateway dashboard default cannot quietly replace
    // the reviewed policy.
    expect(headers["cf-aig-max-attempts"]).toBe(String(GATEWAY_MAX_ATTEMPTS));
    expect(headers["cf-aig-retry-delay"]).toBe(String(GATEWAY_RETRY_DELAY_MS));
    expect(headers["cf-aig-backoff"]).toBe(GATEWAY_BACKOFF);
    expect(headers["cf-aig-request-timeout"]).toBe(String(GATEWAY_REQUEST_TIMEOUT_MS));
  });

  it("carries at most five scalar metadata values", () => {
    const metadata = buildGatewayMetadata({
      run: "run:a",
      generation: "gen:b",
      attempt: 3,
      surface: "chat",
    });
    const values = Object.values(metadata);
    expect(values.length).toBeLessThanOrEqual(GATEWAY_METADATA_MAX_VALUES);
    for (const value of values) {
      expect(["string", "number"]).toContain(typeof value);
    }
    expect(Object.keys(metadata).sort()).toEqual(["attempt", "generation", "run", "surface"]);
  });

  it("keeps the metadata document bounded and stable", () => {
    const first = gatewayHeaders({ run: "run:a", generation: "gen:b", attempt: 1, surface: "chat" });
    const second = gatewayHeaders({ run: "run:a", generation: "gen:b", attempt: 1, surface: "chat" });
    // Byte-identical across calls: key order is fixed by the builder, so a
    // reviewer diffing two requests sees only what actually changed.
    expect(first["cf-aig-metadata"]).toBe(second["cf-aig-metadata"]);
    expect(new TextEncoder().encode(first["cf-aig-metadata"]).byteLength).toBeLessThanOrEqual(
      GATEWAY_METADATA_MAX_BYTES,
    );
  });

  it("refuses a customer slug, email, slack coordinate, prompt or secret as an id", () => {
    const forbidden = [
      "acme-corp inc", // a slug with a space
      "someone@customer.example.com", // an email
      "C123ABC/p1712345678", // a slack channel and thread coordinate
      "the deploy is stuck, please help", // prompt text
      CANARY_GATEWAY_TOKEN.replace(/-/g, " "), // a credential with separators
      '{"run":"x"}', // structure smuggled through a string
      "run:\nX-Injected: true", // header injection
      "«unicode»",
      "",
      "x".repeat(129),
    ];

    for (const value of forbidden) {
      expect(() =>
        gatewayHeaders({ run: value, generation: "gen:b", attempt: 0, surface: "chat" }),
      ).toThrow(GatewayMetadataError);
      expect(() =>
        gatewayHeaders({ run: "run:a", generation: value, attempt: 0, surface: "chat" }),
      ).toThrow(GatewayMetadataError);
    }
  });

  it("does not echo the rejected value into its own error message", () => {
    // An error string is exactly the wrong place for a credential or a prompt
    // fragment to end up, and errors are logged.
    let message = "";
    try {
      gatewayHeaders({ run: CANARY_GATEWAY_TOKEN + " x", generation: "gen:b", attempt: 0, surface: "chat" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(CANARY_GATEWAY_TOKEN);
    expect(message).toContain("opaque id");
  });

  it("refuses an unknown surface and an out-of-range attempt", () => {
    expect(() =>
      gatewayHeaders({
        run: "run:a",
        generation: "gen:b",
        attempt: 0,
        surface: "email" as never,
      }),
    ).toThrow(GatewayMetadataError);
    for (const attempt of [-1, 1.5, 10_000, Number.NaN]) {
      expect(() =>
        gatewayHeaders({ run: "run:a", generation: "gen:b", attempt, surface: "chat" }),
      ).toThrow(GatewayMetadataError);
    }
  });

  it("never emits an authorization header of any kind", () => {
    const headers = gatewayHeaders({ run: "run:a", generation: "gen:b", attempt: 0, surface: "chat" });
    const names = Object.keys(headers).map((name) => name.toLowerCase());
    expect(names).not.toContain(GATEWAY_AUTH_HEADER);
    expect(names).not.toContain("authorization");
    expect(names).not.toContain("x-api-key");
    // Every value is a fixed policy string or an opaque id.
    for (const value of Object.values(headers)) {
      expect(value).not.toContain(CANARY_GATEWAY_TOKEN);
      expect(value).not.toContain(CANARY_API_KEY);
    }
  });
});

describe("production model composer", () => {
  it("fails closed when the gateway url is absent", () => {
    // The gateway does not exist in this account yet, which is exactly the
    // state that must refuse rather than call Anthropic directly.
    const error = catchComposition({ AI_GATEWAY_ANTHROPIC_URL: undefined });
    expect(error?.code).toBe("missing_gateway_url");

    expect(catchComposition({ AI_GATEWAY_ANTHROPIC_URL: "   " })?.code).toBe("missing_gateway_url");
  });

  it("fails closed when the gateway token is absent", () => {
    expect(catchComposition({ AI_GATEWAY_TOKEN: undefined })?.code).toBe("missing_gateway_token");
  });

  it("fails closed when the anthropic key is absent", () => {
    expect(catchComposition({ ANTHROPIC_API_KEY: "" })?.code).toBe("missing_anthropic_key");
  });

  it("refuses a gateway url that is not a provider-native https endpoint", () => {
    for (const url of [
      "http://gateway.ai.cloudflare.com/v1/a/b/anthropic", // not https
      "https://api.cloudflare.com/client/v4/accounts/a/ai", // the REST family
      "https://api.anthropic.com/v1", // straight to the provider
      "https://gateway.ai.cloudflare.com.evil.example/v1", // suffix lookalike
      "not-a-url",
    ]) {
      expect(catchComposition({ AI_GATEWAY_ANTHROPIC_URL: url })?.code).toBe("invalid_gateway_url");
    }
  });

  it("refuses a model with no reviewed price table", () => {
    let code: string | undefined;
    try {
      createProductionModelFactory(canaryEnv(), { modelId: "claude-fable-6" });
    } catch (error) {
      code = error instanceof ModelCompositionError ? error.code : undefined;
    }
    expect(code).toBe("unpriced_model");
  });

  it("builds one fable model per invocation with the safe headers attached", () => {
    const factory = createProductionModelFactory(canaryEnv());
    const handle = factory(invocation);

    expect(handle.modelId).toBe(FABLE_5_MODEL_ID);
    expect(handle.provider).toBe("anthropic");
    expect(handle.gatewayAttempts).toBe(GATEWAY_MAX_ATTEMPTS);
    expect(handle.safeHeaders["cf-aig-metadata"]).toContain(invocation.runId);
    expect(handle.safeHeaders["cf-aig-max-attempts"]).toBe(String(handle.gatewayAttempts));

    // A second invocation is a second model, not a mutated one.
    const other = factory({ ...invocation, attempt: 2 });
    expect(other.model).not.toBe(handle.model);
    expect(other.safeHeaders["cf-aig-metadata"]).toContain('"attempt":2');
  });
});

describe("gateway token canaries", () => {
  it("never enters the safe header map or the metadata document", () => {
    const handle = createProductionModelFactory(canaryEnv())(invocation);
    const serialized = JSON.stringify(handle.safeHeaders);
    expect(serialized).not.toContain(CANARY_GATEWAY_TOKEN);
    expect(serialized).not.toContain(CANARY_API_KEY);
    expect(serialized).not.toContain("Bearer");
    expect(handle.safeHeaders[GATEWAY_AUTH_HEADER]).toBeUndefined();
    expect(handle.safeHeaders["authorization"]).toBeUndefined();
  });

  it("never appears in any own property of the handle except the model adapter", () => {
    const handle = createProductionModelFactory(canaryEnv())(invocation);
    const { model: _model, ...rest } = handle;

    // The model IS the trusted host adapter and must hold the credential to
    // send it; everything a caller might log, snapshot or persist is `rest`.
    for (const found of reachableStrings(rest)) {
      expect(found).not.toContain(CANARY_GATEWAY_TOKEN);
      expect(found).not.toContain(CANARY_API_KEY);
    }
  });

  it("never reaches a log line while composing or invoking", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    try {
      const handle = createProductionModelFactory(canaryEnv())(invocation);
      expect(handle.modelId).toBe(FABLE_5_MODEL_ID);
      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          for (const found of reachableStrings(call)) {
            expect(found).not.toContain(CANARY_GATEWAY_TOKEN);
            expect(found).not.toContain(CANARY_API_KEY);
          }
        }
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("never appears in a composition error message or stack", () => {
    for (const override of [
      { AI_GATEWAY_ANTHROPIC_URL: undefined },
      { AI_GATEWAY_ANTHROPIC_URL: "https://api.anthropic.com/v1" },
      { AI_GATEWAY_TOKEN: undefined },
      { ANTHROPIC_API_KEY: "" },
    ] as Partial<ModelEnv>[]) {
      const error = catchComposition(override);
      const text = `${error?.message ?? ""}\n${error?.stack ?? ""}`;
      expect(text).not.toContain(CANARY_GATEWAY_TOKEN);
      expect(text).not.toContain(CANARY_API_KEY);
    }
  });

  it("has no path from telemetry or model context to the token", () => {
    const handle = createProductionModelFactory(canaryEnv())(invocation);
    // What a step actually persists: ids, counts, cost, finish reasons. There
    // is nowhere in this record to put a header, a body, or a credential.
    const record = {
      provider: handle.provider,
      model: handle.modelId,
      usage: normalizeSdkUsage(undefined),
      costNanoUsd: 0,
      gatewayAttempts: handle.gatewayAttempts,
    };
    for (const found of reachableStrings(record)) {
      expect(found).not.toContain(CANARY_GATEWAY_TOKEN);
      expect(found).not.toContain(CANARY_API_KEY);
    }
  });
});

describe("one retry owner", () => {
  it("sets the AI SDK's own retries to zero", () => {
    const options = modelCallOptions();
    // The SDK default is 2. Left in place it would multiply the reviewed
    // worst-case spend by four and make cf-aig-max-attempts a fiction.
    expect(options.maxRetries).toBe(0);
  });

  it("states every timeout explicitly from the reviewed limits", () => {
    expect(modelCallOptions().timeout).toEqual({
      totalMs: DEFAULT_AGENT_LIMITS.continuationMs,
      stepMs: DEFAULT_AGENT_LIMITS.stepMs,
      firstChunkMs: DEFAULT_AGENT_LIMITS.firstChunkMs,
      chunkMs: DEFAULT_AGENT_LIMITS.chunkMs,
      toolMs: DEFAULT_AGENT_LIMITS.toolMs,
    });
  });

  it("keeps the continuation under the alarm ceiling and the step under the lease", () => {
    const { timeout } = modelCallOptions();
    expect(timeout.totalMs).toBeLessThan(15 * 60_000);
    expect(timeout.stepMs).toBeLessThan(DEFAULT_AGENT_LIMITS.continuationMs);
    expect(timeout.firstChunkMs).toBeLessThan(timeout.stepMs);
  });
});

// --- refusal ----------------------------------------------------------------

/**
 * A mock Fable that returns HTTP 200 with the provider's raw `refusal` stop
 * reason. Note the PROVIDER-level shapes: `finishReason` is the object
 * `{ unified, raw }` and `usage` NESTS its counters. The SDK flattens both
 * before a callback sees them, which is precisely what the assertions below
 * pin down.
 */
function refusingModel(options: { emitTextBefore: string | null }) {
  return new MockLanguageModelV4({
    provider: "anthropic",
    modelId: FABLE_5_MODEL_ID,
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (options.emitTextBefore !== null) {
            controller.enqueue({ type: "text-start", id: "t0" });
            controller.enqueue({ type: "text-delta", id: "t0", delta: options.emitTextBefore });
            controller.enqueue({ type: "text-end", id: "t0" });
          }
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "other", raw: ANTHROPIC_REFUSAL_RAW_REASON },
            usage: {
              inputTokens: { total: 5_000, noCache: 5_000, cacheRead: 0, cacheWrite: 0 },
              outputTokens: {
                total: options.emitTextBefore === null ? 0 : 40,
                text: options.emitTextBefore === null ? 0 : 40,
                reasoning: 0,
              },
              // NOTE: `LanguageModelV4Usage` has NO `totalTokens` field at all
              // — the provider type carries only the two nested bags. The SDK
              // derives the flat `totalTokens` itself. Adding one here is a
              // type error, which is a nice hard proof that this really is the
              // provider shape and not the AI-SDK one.
            },
          });
          controller.close();
        },
      }),
    }),
  });
}

async function runToCompletion(model: MockLanguageModelV4) {
  const result = streamText({ model, prompt: "the deploy is stuck", maxRetries: 0 });
  let emitted = "";
  for await (const delta of result.textStream) emitted += delta;
  const steps = await result.steps;
  return { emitted, step: steps[0] };
}

describe("refusal fixtures", () => {
  it("PRE-OUTPUT: surfaces the raw refusal, retains usage, and costs nothing", async () => {
    const { emitted, step } = await runToCompletion(refusingModel({ emitTextBefore: null }));

    expect(emitted).toBe("");
    // HTTP 200 with the provider's own word for it, read structurally.
    expect(step.rawFinishReason).toBe(ANTHROPIC_REFUSAL_RAW_REASON);

    const outcome = classifyStepOutcome({
      finishReason: step.finishReason,
      rawFinishReason: step.rawFinishReason,
      emittedVisibleOutput: emitted.length > 0,
    });
    expect(outcome.kind).toBe("refusal_pre_output");
    expect(outcome.billing).toBe("none");
    expect(outcome.errorCode).toBe("provider_refusal");

    const usage = normalizeSdkUsage(step.usage);
    // Usage is RETAINED for rate limiting and observability...
    expect(usage.inputTokens).toBe(5_000);
    expect(usage.outputTokens).toBe(0);
    // ...but Anthropic does not bill a refusal it made before emitting output.
    const cost = costNanoUsd({
      modelId: FABLE_5_MODEL_ID,
      usage,
      billing: outcome.billing,
    });
    expect(cost.totalNanoUsd).toBe(0);

    // Not success, and no fallback model exists to try instead.
    expect(step.finishReason).not.toBe("stop");
    expect(REFUSAL_GENERATION_STATE).toBe("refused");
    expect(REFUSAL_RESUME_POLICY).toBe("requires_input");
  });

  it("MID-STREAM: charges the real usage but discards every partial draft", async () => {
    const { emitted, step } = await runToCompletion(
      refusingModel({ emitTextBefore: "Here is what I found so far" }),
    );

    expect(emitted).toBe("Here is what I found so far");
    expect(step.rawFinishReason).toBe(ANTHROPIC_REFUSAL_RAW_REASON);

    const outcome = classifyStepOutcome({
      finishReason: step.finishReason,
      rawFinishReason: step.rawFinishReason,
      emittedVisibleOutput: emitted.length > 0,
    });
    expect(outcome.kind).toBe("refusal_mid_stream");
    // The tokens really were emitted, so they really were billed.
    expect(outcome.billing).toBe("normal");
    expect(outcome.errorCode).toBe("provider_refusal_mid_stream");
    // But half a refused message must never be promoted to a final answer.
    expect(outcome.discardPartialDrafts).toBe(true);

    const usage = normalizeSdkUsage(step.usage);
    const cost = costNanoUsd({ modelId: FABLE_5_MODEL_ID, usage, billing: outcome.billing });
    expect(usage.outputTokens).toBe(40);
    expect(cost.totalNanoUsd).toBe(5_000 * 10_000 + 40 * 50_000);
    expect(cost.totalNanoUsd).toBeGreaterThan(0);
  });

  it("both refusals discard drafts and neither is completed", async () => {
    for (const emitTextBefore of [null, "partial"]) {
      const { emitted, step } = await runToCompletion(refusingModel({ emitTextBefore }));
      const outcome = classifyStepOutcome({
        finishReason: step.finishReason,
        rawFinishReason: step.rawFinishReason,
        emittedVisibleOutput: emitted.length > 0,
      });
      expect(outcome.kind).not.toBe("ok");
      expect(outcome.discardPartialDrafts).toBe(true);
    }
  });

  it("says something safe rather than echoing the provider's refusal prose", () => {
    expect(REFUSAL_SAFE_MESSAGE).toContain("needs a human");
    expect(REFUSAL_SAFE_MESSAGE).not.toContain("refusal");
  });

  it("catches a refusal whose raw reason is lost but whose unified reason is not", () => {
    const outcome = classifyStepOutcome({
      finishReason: "content-filter",
      rawFinishReason: undefined,
      emittedVisibleOutput: false,
    });
    expect(outcome.kind).toBe("refusal_pre_output");
  });

  it("leaves an ordinary stop and an ordinary tool call alone", () => {
    for (const [finishReason, raw] of [
      ["stop", "end_turn"],
      ["tool-calls", "tool_use"],
      ["length", "max_tokens"],
    ] as const) {
      const outcome = classifyStepOutcome({
        finishReason,
        rawFinishReason: raw,
        emittedVisibleOutput: true,
      });
      expect(outcome).toEqual({
        kind: "ok",
        billing: "normal",
        discardPartialDrafts: false,
        errorCode: null,
      });
    }
  });
});

describe("installed usage shape", () => {
  it("streamText hands back the FLAT LanguageModelUsage, not the nested provider one", async () => {
    const { step } = await runToCompletion(refusingModel({ emitTextBefore: "x" }));

    // The mock emitted the PROVIDER shape `inputTokens: { total, noCache, ... }`.
    // What arrives here is the AI-SDK shape: a flat number plus detail bags.
    expect(typeof step.usage.inputTokens).toBe("number");
    expect(step.usage.inputTokens).toBe(5_000);
    expect(step.usage.inputTokenDetails).toBeDefined();
    expect(step.usage.inputTokenDetails.noCacheTokens).toBe(5_000);
    expect(step.usage.outputTokenDetails).toBeDefined();

    // Reading it as the nested provider type would have produced this, which
    // costs nothing and reads as a free request.
    expect(
      (step.usage.inputTokens as unknown as { total?: number })?.total,
    ).toBeUndefined();
  });
});

function catchComposition(overrides: Partial<ModelEnv>): ModelCompositionError | undefined {
  try {
    createProductionModelFactory(canaryEnv(overrides));
    return undefined;
  } catch (error) {
    if (error instanceof ModelCompositionError) return error;
    throw error;
  }
}
