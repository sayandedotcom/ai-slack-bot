import { MockLanguageModelV4 } from "ai/test";

/**
 * One part of a provider stream, derived from the mock's own `doStream` rather
 * than imported: `@ai-sdk/provider` is a transitive package with no direct
 * dependency entry, so its module specifier does not resolve here. Deriving it
 * keeps the parts below checked against the installed spec version.
 */
type StreamPart =
  Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

/**
 * A model that answers instantly and never leaves the isolate.
 *
 * THE HARNESS LIMIT THIS EXISTS TO REMOVE. The pool binds
 * `AGENT_MODEL_DISABLED=true` and empty AI Gateway settings, so a run woken
 * under it starts a turn that can never complete — and a Durable Object stuck
 * in a turn stops answering RPC, which made every wake path unassertable past
 * the submit. `installTestModel` (`src/run/model.ts`) swaps this in; nothing
 * here touches the network, so the pool's money guarantee is untouched for
 * every suite that does not install one.
 *
 * One text step, one `finish`, no tool calls: the question these suites ask is
 * whether the turn was ADMITTED and what the run became, not what the model
 * said. The prompts it was called with are on `doStreamCalls`, which is how a
 * test reads what actually reached the provider.
 */
export function cannedModel(options: { text?: string; modelId?: string } = {}): MockLanguageModelV4 {
  const text = options.text ?? "Looked at it.";
  const modelId = options.modelId ?? "claude-fable-5";

  const parts: StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "response-metadata", id: "req_canned", modelId },
    { type: "text-start", id: "t0" },
    { type: "text-delta", id: "t0", delta: text },
    { type: "text-end", id: "t0" },
    {
      type: "finish",
      // V4 splits the finish reason into the unified vocabulary and the
      // provider's own raw string. `onStepEnd` reads both.
      finishReason: { unified: "stop", raw: "end_turn" },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 10, text: 10, reasoning: 0 },
      },
    },
  ];

  return new MockLanguageModelV4({
    provider: "anthropic",
    modelId,
    doStream: async () => ({ stream: streamOf(parts) }),
  });
}

function streamOf(parts: StreamPart[]): ReadableStream<StreamPart> {
  return new ReadableStream<StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}
