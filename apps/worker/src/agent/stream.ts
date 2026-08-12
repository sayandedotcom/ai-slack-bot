import {
  ASSISTANT_FLUSH_CHARS,
  ASSISTANT_FLUSH_MS,
  type AssistantUpdateInput,
  type AssistantUpdateState,
} from "../run/protocol";
import type { AssistantUpdateOutcome, ClaimFence } from "./contracts";

/**
 * The assistant draft buffer: how provider text becomes a bounded number of
 * durable, replayable batches.
 *
 * TWO SEPARATE JOBS LIVE HERE, and confusing them is the defect this module
 * exists to prevent:
 *
 *  - **What the customer sees while the answer is being written.** Every text
 *    delta the model emits, including narration before a tool call, is streamed
 *    out as `assistant_update` batches. That is progress, and hiding it makes a
 *    two-minute investigation look like a hang.
 *  - **What becomes the durable final turn.** ONLY the terminal step's text.
 *    A model that says "let me check the logs", calls `run_code`, and then
 *    answers must not have its throat-clearing concatenated onto the answer —
 *    that text was true about a step that has since been superseded by a tool
 *    result, and a customer reading it in the final message reads a lie about
 *    what the agent knew.
 *
 * So the buffer is scoped PER PROVIDER STEP (`beginStep` / `endStep`), and only
 * a step that finished WITHOUT issuing a tool call promotes its text to
 * `terminalText`.
 *
 * Batching is 250 ms **or** 512 characters, whichever comes first (invariant 20:
 * never one SQLite row per token). The clock is injected so a test can prove the
 * time half deterministically instead of sleeping, and the decision is taken on
 * delta arrival rather than from a background timer: a timer callback firing
 * into a Durable Object mid-stream would be a write racing the reader for no
 * benefit, and every path that ends a step or the stream flushes explicitly.
 */

/** The one time source. Injected so a test never sleeps and never flakes. */
export type StreamClock = { now(): number };

export const systemClock: StreamClock = { now: () => Date.now() };

/**
 * Where a batch is committed and broadcast. A port, not a RunDO import: this
 * module must stay testable without a Durable Object.
 */
export type AssistantUpdateSink = (
  input: AssistantUpdateInput,
) => Promise<AssistantUpdateOutcome>;

export type AssistantStreamOptions = {
  fence: ClaimFence;
  attempt: number;
  sink: AssistantUpdateSink;
  clock?: StreamClock;
  flushChars?: number;
  flushMs?: number;
};

/**
 * The terminal states this stream may end in. `completed` is deliberately
 * ABSENT: a successful answer's terminal update is written inside
 * `finalizeAnswer`'s atomic transaction, together with the final turn, because
 * a `completed` event that survives a crash which lost the turn tells the client
 * to drop a draft it will never get a replacement for.
 */
export type StreamTerminalState = Exclude<AssistantUpdateState, "completed" | "streaming">;

export class AssistantStream {
  readonly #fence: ClaimFence;
  readonly #attempt: number;
  readonly #sink: AssistantUpdateSink;
  readonly #clock: StreamClock;
  readonly #flushChars: number;
  readonly #flushMs: number;

  /** Text buffered since the last flush. Reset by every flush AND by a new step. */
  #buffer = "";
  /** When the current buffer's first character arrived. Null while empty. */
  #bufferedSince: number | null = null;
  /** Text of the step currently being streamed. Reset by `beginStep`. */
  #stepText = "";
  /** Text of the last step that ended WITHOUT a tool call. The answer. */
  #terminalText = "";
  #batchSeq = 0;
  #batches = 0;
  #emittedVisibleOutput = false;
  #started = false;
  #terminated = false;
  #staleClaim = false;

  constructor(options: AssistantStreamOptions) {
    this.#fence = options.fence;
    this.#attempt = options.attempt;
    this.#sink = options.sink;
    this.#clock = options.clock ?? systemClock;
    this.#flushChars = options.flushChars ?? ASSISTANT_FLUSH_CHARS;
    this.#flushMs = options.flushMs ?? ASSISTANT_FLUSH_MS;
  }

  /** Durable batches written so far. The number invariant 20 bounds. */
  get batches(): number {
    return this.#batches;
  }

  /** The next unused batch sequence. `finalizeAnswer` needs it to key its writes. */
  get nextBatchSeq(): number {
    return this.#batchSeq;
  }

  /**
   * Whether any customer-visible draft text was actually emitted.
   *
   * `classifyStepOutcome` needs this measured from what was STREAMED, not from
   * a reported output token count: a refusal can report output tokens it never
   * emitted, and a model can emit text a usage row rounds to zero.
   */
  get emittedVisibleOutput(): boolean {
    return this.#emittedVisibleOutput;
  }

  /** The terminal answer step's text. Never narration from a tool-calling step. */
  get terminalText(): string {
    return this.#terminalText;
  }

  /** True once a fenced write was refused: this claimant no longer owns the run. */
  get staleClaim(): boolean {
    return this.#staleClaim;
  }

  /** One `started` event, before any provider chunk is consumed. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    await this.#emit({ state: "started" });
  }

  /**
   * A new provider step. Drops any unflushed narration from the previous step's
   * buffer only after it has been flushed — `endStep` is what flushes, so a
   * caller that forgets it loses nothing durable, it just batches less often.
   */
  beginStep(): void {
    this.#stepText = "";
  }

  async delta(text: string): Promise<void> {
    if (text.length === 0 || this.#terminated) return;
    if (this.#bufferedSince === null) this.#bufferedSince = this.#clock.now();
    this.#buffer += text;
    this.#stepText += text;
    this.#emittedVisibleOutput = true;

    if (this.#shouldFlush()) await this.flush();
  }

  #shouldFlush(): boolean {
    if (this.#buffer.length >= this.#flushChars) return true;
    if (this.#bufferedSince === null) return false;
    return this.#clock.now() - this.#bufferedSince >= this.#flushMs;
  }

  /** Write whatever is buffered as one `streaming` batch. A no-op when empty. */
  async flush(): Promise<void> {
    const delta = this.#takeBuffer();
    if (delta === null) return;
    await this.#emit({ state: "streaming", delta });
  }

  /**
   * End the current provider step.
   *
   * `hadToolCalls` decides everything: a step that called a tool contributed
   * narration, and a step that did not contributed the answer. A step that
   * produced no text at all does not clear a previously captured answer, which
   * is what keeps a trailing empty step from blanking a good final turn.
   */
  async endStep(input: { hadToolCalls: boolean; discardDrafts?: boolean }): Promise<void> {
    if (input.discardDrafts === true) {
      // A mid-stream refusal. Half a refused message is not an answer to send
      // anyone, so the partial buffer is dropped rather than promoted.
      this.#buffer = "";
      this.#bufferedSince = null;
      this.#stepText = "";
      return;
    }
    await this.flush();
    if (!input.hadToolCalls && this.#stepText.length > 0) this.#terminalText = this.#stepText;
    this.#stepText = "";
  }

  /**
   * Hand the caller the unflushed buffer WITHOUT writing it.
   *
   * The successful path uses this so the trailing partial delta is committed
   * inside `finalizeAnswer`'s atomic transaction rather than as a separate event
   * that a crash could strand ahead of a final turn that never arrives.
   */
  takePending(): string | null {
    return this.#takeBuffer();
  }

  /**
   * Flush and terminate. Every non-success exit calls this, so the client is
   * never left holding a draft with nothing coming for it (Step 8: every path
   * flushes and terminates a stream update).
   */
  async terminate(state: StreamTerminalState, error?: string): Promise<void> {
    if (this.#terminated) return;
    await this.flush();
    this.#terminated = true;
    await this.#emit({ state, ...(error === undefined ? {} : { error }) });
  }

  #takeBuffer(): string | null {
    if (this.#buffer.length === 0) return null;
    const delta = this.#buffer;
    this.#buffer = "";
    this.#bufferedSince = null;
    return delta;
  }

  async #emit(input: { state: AssistantUpdateState; delta?: string; error?: string }): Promise<void> {
    const batchSeq = this.#batchSeq;
    this.#batchSeq += 1;
    const outcome = await this.#sink({
      generationId: this.#fence.generationId,
      attempt: this.#attempt,
      batchSeq,
      state: input.state,
      ...(input.delta === undefined ? {} : { delta: input.delta }),
      ...(input.error === undefined ? {} : { error: input.error }),
      createdAt: this.#clock.now(),
    });
    if (outcome.outcome === "stale_claim") {
      // A successor owns the run. Recorded rather than thrown: the loop reads
      // this and exits through its own aborted path, which leaves driver state
      // legal instead of unwinding through a crash handler.
      this.#staleClaim = true;
      return;
    }
    this.#batches += 1;
  }
}
