import { describe, expect, it } from "vitest";
import { AssistantStream, type StreamClock } from "../src/agent/stream";
import { ASSISTANT_FLUSH_CHARS, type AssistantUpdateInput } from "../src/run/protocol";
import type { AssistantUpdateOutcome, ClaimFence } from "../src/agent/contracts";

/**
 * The draft buffer, on its own.
 *
 * Nothing here touches storage, a Durable Object or a provider. Batching and
 * per-step scoping are arithmetic over strings and a clock, and proving them
 * through a model would mean every batching bug arrived dressed as a model bug.
 */

const FENCE: ClaimFence = { generationId: "gen:1", claimEpoch: 1 };

class ManualClock implements StreamClock {
  constructor(public value = 1_000_000) {}
  now(): number {
    return this.value;
  }
  advance(ms: number): void {
    this.value += ms;
  }
}

function recorder(options: { stale?: boolean } = {}) {
  const written: AssistantUpdateInput[] = [];
  const sink = async (input: AssistantUpdateInput): Promise<AssistantUpdateOutcome> => {
    if (options.stale === true) return { outcome: "stale_claim" };
    written.push(input);
    return {
      outcome: "appended",
      event: {
        seq: written.length,
        type: "assistant_update",
        update: {
          id: `assistant:gen:1:1:${input.batchSeq}`,
          generationId: input.generationId,
          attempt: input.attempt,
          state: input.state,
          ...(input.delta === undefined ? {} : { delta: input.delta }),
          createdAt: input.createdAt ?? 0,
        },
      },
    };
  };
  return { written, sink };
}

const makeStream = (clock: ManualClock, sink: ReturnType<typeof recorder>["sink"]) =>
  new AssistantStream({ fence: FENCE, attempt: 1, sink, clock });

describe("batching: 250 ms or 512 characters, whichever comes first", () => {
  it("does not write a row per token", async () => {
    const clock = new ManualClock();
    const { written, sink } = recorder();
    const stream = makeStream(clock, sink);
    await stream.start();

    // The clock never moves, so ONLY the character threshold can fire. That is
    // the point: it isolates one half of the rule from the other.
    for (let i = 0; i < 100; i += 1) await stream.delta("0123456789");

    const streaming = written.filter((row) => row.state === "streaming");
    expect(streaming.length).toBe(Math.floor(1_000 / ASSISTANT_FLUSH_CHARS));
    for (const row of streaming) expect(row.delta?.length).toBeGreaterThanOrEqual(512);
  });

  it("flushes on the time threshold even when the buffer is small", async () => {
    const clock = new ManualClock();
    const { written, sink } = recorder();
    const stream = makeStream(clock, sink);
    await stream.start();

    await stream.delta("a");
    expect(written.filter((row) => row.state === "streaming")).toHaveLength(0);

    clock.advance(250);
    await stream.delta("b");
    expect(written.filter((row) => row.state === "streaming")).toHaveLength(1);
    expect(written[1].delta).toBe("ab");
  });

  /**
   * The number invariant 20 exists for. A 10,000-token answer at four characters
   * a token is 40,000 characters; at 512 characters a batch that is 78 durable
   * rows, not 10,000.
   */
  it("keeps a 10,000-token stream to a bounded number of durable rows", async () => {
    const clock = new ManualClock();
    const { written, sink } = recorder();
    const stream = makeStream(clock, sink);
    await stream.start();

    const TOKENS = 10_000;
    for (let i = 0; i < TOKENS; i += 1) await stream.delta("word");
    await stream.endStep({ hadToolCalls: false });

    const rows = written.filter((row) => row.state === "streaming");
    expect(rows.length).toBe(Math.ceil((TOKENS * 4) / ASSISTANT_FLUSH_CHARS));
    expect(rows.length).toBeLessThan(100);
    expect(stream.batches).toBeLessThan(100);
    // And nothing was lost on the way.
    expect(rows.map((row) => row.delta ?? "").join("")).toHaveLength(TOKENS * 4);
  });
});

describe("draft buffers are scoped per provider step", () => {
  it("keeps pre-tool narration out of the terminal answer", async () => {
    const clock = new ManualClock();
    const { written, sink } = recorder();
    const stream = makeStream(clock, sink);
    await stream.start();

    // Step 0: narration, then a tool call.
    stream.beginStep();
    await stream.delta("Let me check the deploy logs.");
    await stream.endStep({ hadToolCalls: true });

    // Step 1: the answer.
    stream.beginStep();
    await stream.delta("The 04:12 deploy renamed a column the report filters on.");
    await stream.endStep({ hadToolCalls: false });

    expect(stream.terminalText).toBe(
      "The 04:12 deploy renamed a column the report filters on.",
    );
    expect(stream.terminalText).not.toContain("Let me check");

    // The narration was still STREAMED — a customer watching must see progress.
    const streamed = written.filter((row) => row.state === "streaming").map((row) => row.delta);
    expect(streamed).toContain("Let me check the deploy logs.");
  });

  it("does not let a trailing empty step blank a good answer", async () => {
    const clock = new ManualClock();
    const { sink } = recorder();
    const stream = makeStream(clock, sink);
    await stream.start();

    stream.beginStep();
    await stream.delta("done: the queue drained at 04:20.");
    await stream.endStep({ hadToolCalls: false });

    stream.beginStep();
    await stream.endStep({ hadToolCalls: false });

    expect(stream.terminalText).toBe("done: the queue drained at 04:20.");
  });

  it("discards partial drafts when a step is refused mid-stream", async () => {
    const clock = new ManualClock();
    const { sink } = recorder();
    const stream = makeStream(clock, sink);
    await stream.start();

    stream.beginStep();
    await stream.delta("I will not");
    await stream.endStep({ hadToolCalls: false, discardDrafts: true });

    // Half a refused message is not an answer to send anyone.
    expect(stream.terminalText).toBe("");
    expect(stream.takePending()).toBeNull();
  });
});

describe("terminal handover", () => {
  it("hands the trailing partial to the caller instead of writing it", async () => {
    const clock = new ManualClock();
    const { written, sink } = recorder();
    const stream = makeStream(clock, sink);
    await stream.start();

    stream.beginStep();
    await stream.delta("short answer");

    const before = written.length;
    expect(stream.takePending()).toBe("short answer");
    // Nothing was written: the successful path commits this delta inside
    // `finalizeAnswer`'s transaction, with the final turn.
    expect(written).toHaveLength(before);
    expect(stream.takePending()).toBeNull();
  });

  it("flushes before terminating a failed stream", async () => {
    const clock = new ManualClock();
    const { written, sink } = recorder();
    const stream = makeStream(clock, sink);
    await stream.start();
    await stream.delta("partial");
    await stream.terminate("failed", "provider_timeout");

    expect(written.map((row) => row.state)).toEqual(["started", "streaming", "failed"]);
    expect(written[1].delta).toBe("partial");
    expect(written[2].error).toBe("provider_timeout");
  });

  it("records a refused write instead of throwing into the loop", async () => {
    const clock = new ManualClock();
    const { sink } = recorder({ stale: true });
    const stream = makeStream(clock, sink);
    await stream.start();
    expect(stream.staleClaim).toBe(true);
    expect(stream.batches).toBe(0);
  });

  it("gives every batch a distinct sequence, so ids cannot collide", async () => {
    const clock = new ManualClock();
    const { written, sink } = recorder();
    const stream = makeStream(clock, sink);
    await stream.start();
    await stream.delta("x".repeat(600));
    await stream.flush();
    await stream.terminate("aborted");

    const seqs = written.map((row) => row.batchSeq);
    expect(seqs).toEqual([...new Set(seqs)]);
    // started, one 600-character flush (the threshold is a floor, not a slice),
    // then the terminal update. The redundant `flush()` writes nothing.
    expect(seqs).toEqual([0, 1, 2]);
    expect(written.map((row) => row.state)).toEqual(["started", "streaming", "aborted"]);
  });
});
