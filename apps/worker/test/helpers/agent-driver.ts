import { env, runInDurableObject } from "cloudflare:test";
import { chatRunKey, runStubForKey } from "../../src/run/keys";
import { createOrGetRun } from "../../src/run/repository";
import {
  appendInputMessages,
  listPendingInputTurns,
  turnEventSeq,
  type RunDescriptor,
} from "../../src/run/session";
import type { RunTurnInput } from "../../src/run/protocol";
import {
  installRunPorts,
  type AgentContinuation,
  type AgentProjectionRunner,
  type ClaimedGeneration,
  type ClaimedProjectionJob,
  type ContinuationOutcome,
  type ProjectionOutcome,
} from "../../src/agent/driver";

/**
 * The barrier fake the whole task is proved against.
 *
 * It records every claim it is handed and, when held, parks until the test
 * releases it. That is what makes single-flight observable at all: with a fake
 * that returns immediately, two "concurrent" kicks are never actually
 * concurrent, and a broken driver would still look correct.
 */
export class FakeContinuation implements AgentContinuation {
  readonly claims: ClaimedGeneration[] = [];
  /** Session writes that were refused by the epoch fence. */
  readonly staleWrites: string[] = [];

  #gate: Promise<void> | null = null;
  #open!: () => void;
  #outcome: ContinuationOutcome = { outcome: "completed" };
  #throws: Error | null = null;
  #onRun: ((claim: ClaimedGeneration) => void | Promise<void>) | null = null;
  #storage: DurableObjectStorage | null = null;
  #consumesInput: boolean;

  constructor(options: { hold?: boolean; consumesInput?: boolean } = {}) {
    this.#consumesInput = options.consumesInput ?? true;
    if (options.hold === true) this.hold();
  }

  /**
   * Hand the fake the object's own storage.
   *
   * Called from INSIDE `runInDurableObject`, so the handle never crosses out of
   * the object. A continuation that cannot read pending input is not a useful
   * stand-in for the real one: `finalizeGeneration` decides settle-versus-
   * continue from the generation's included cursor, so a fake that never
   * included anything would continue forever and hide every settlement bug.
   */
  attach(storage: DurableObjectStorage): this {
    this.#storage = storage;
    return this;
  }

  get runs(): number {
    return this.claims.length;
  }

  /** Park every subsequent run until `release()`. */
  hold(): void {
    if (this.#gate) return;
    this.#gate = new Promise((resolve) => {
      this.#open = resolve;
    });
  }

  release(): void {
    const open = this.#open;
    this.#gate = null;
    if (open) open();
  }

  returns(outcome: ContinuationOutcome): this {
    this.#outcome = outcome;
    this.#throws = null;
    return this;
  }

  throws(error: Error): this {
    this.#throws = error;
    return this;
  }

  /** Runs inside the continuation, after the claim, before the outcome. */
  onRun(hook: (claim: ClaimedGeneration) => void | Promise<void>): this {
    this.#onRun = hook;
    return this;
  }

  async run(claim: ClaimedGeneration): Promise<ContinuationOutcome> {
    this.claims.push(claim);

    // Input is consumed BEFORE the barrier, exactly as a real loop reads its
    // pending turns before calling the provider. Anything that arrives while
    // the barrier is held is therefore above the included cursor, and the
    // finalize must continue the generation rather than settle it.
    this.#includePendingInput(claim);

    if (this.#gate) await this.#gate;
    if (this.#onRun) await this.#onRun(claim);
    if (this.#throws) throw this.#throws;
    return this.#outcome;
  }

  #includePendingInput(claim: ClaimedGeneration): void {
    const storage = this.#storage;
    if (!storage || !this.#consumesInput) return;

    const pending = listPendingInputTurns(storage, claim.includedThroughSeq);
    const messages = pending.flatMap((pendingTurn) => {
      const seq = turnEventSeq(storage, pendingTurn.id);
      return seq === null ? [] : [{ sourceEventSeq: seq, message: { role: "user", content: pendingTurn.content } }];
    });
    if (messages.length === 0) return;

    const outcome = appendInputMessages(storage, claim.fence, {
      globalStep: claim.stepCount,
      messages,
    });
    if (outcome.outcome === "stale_claim") this.staleWrites.push("appendInputMessages");
  }
}

export class FakeProjectionRunner implements AgentProjectionRunner {
  readonly jobs: ClaimedProjectionJob[] = [];
  outcome: ProjectionOutcome = { outcome: "delivered" };
  fails: Error | null = null;

  async run(job: ClaimedProjectionJob): Promise<ProjectionOutcome> {
    this.jobs.push(job);
    if (this.fails) throw this.fails;
    return this.outcome;
  }
}

/**
 * A clock a test can move, so a lease can expire without waiting 150 seconds.
 *
 * It starts an hour ahead of wall time on purpose. Alarms in this pool really
 * do fire on their own, and every time this driver arms one it arms it at a
 * time from THIS clock — an hour in the runtime's future — so no background
 * delivery can land in the middle of a case and claim a generation the test was
 * about to reason about. Every alarm in these suites is delivered explicitly.
 */
export const CLOCK_SKEW_MS = 60 * 60_000;

export class FakeClock {
  constructor(public value = Date.now() + CLOCK_SKEW_MS) {}

  now = (): number => this.value;

  advance(ms: number): number {
    this.value += ms;
    return this.value;
  }
}

/**
 * Wait for something the Durable Object will do, WITHOUT awaiting a promise the
 * object resolves.
 *
 * That distinction is not cosmetic. A promise resolved inside the object
 * resumes its awaiter in the OBJECT's I/O context, and the next stub call the
 * test makes from there fails with "cannot perform I/O on behalf of a different
 * Durable Object". Polling a plain field from the test's own timer keeps the
 * test in its own context.
 */
export async function waitFor(
  predicate: () => boolean,
  label = "condition",
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

export type DriverHarness = {
  descriptor: RunDescriptor;
  runId: string;
  key: string;
  stub: DurableObjectStub<import("../../src/run/do").RunDO>;
  clock: FakeClock;
  continuation: FakeContinuation | null;
  /** One faithful platform delivery: clear the armed alarm, then dispatch. */
  alarm: () => Promise<import("../../src/run/do").AlarmOutcome>;
  /** A raw redelivery that leaves the alarm slot alone — for concurrent kicks. */
  dispatch: () => Promise<import("../../src/run/do").AlarmOutcome>;
  storage: <T>(fn: (storage: DurableObjectStorage) => T) => Promise<T>;
  alarmAt: () => Promise<number | null>;
  /** Re-hand the fake this object's storage after an eviction invalidated it. */
  reattach: () => Promise<void>;
};

/**
 * A fresh run with ports installed under ITS key.
 *
 * Key-scoped on purpose: storage and module state are shared across cases and
 * files in this pool, so an unscoped fake continuation would be handed to every
 * other run in the runtime — including suites that assert nothing ever claims.
 */
export async function freshDriverRun(
  options: {
    continuation?: FakeContinuation | null;
    projections?: Partial<Record<"run_index" | "d1_usage" | "memory_outbox", AgentProjectionRunner>>;
    clock?: FakeClock;
    limits?: Partial<{ claimLeaseMs: number; maxAttempts: number; continuationTotalMs: number }>;
  } = {},
): Promise<DriverHarness> {
  const key = chatRunKey(crypto.randomUUID());
  const record = await createOrGetRun(env.DB, {
    key,
    origin: "chat",
    channelId: null,
    threadTs: null,
  });
  const descriptor: RunDescriptor = {
    runId: record.id,
    key,
    origin: "chat",
    channelId: null,
    threadTs: null,
  };

  const clock = options.clock ?? new FakeClock();
  const continuation =
    options.continuation === undefined ? new FakeContinuation() : options.continuation;

  installRunPorts(
    {
      // A FACTORY, not the fake itself. This is what retired Task 3's
      // `attach(storage)` hack: the port is now built per claimed attempt from
      // the object's own `ctx`, so the fake reads pending input through the same
      // route the real continuation does instead of being handed a storage
      // handle from inside `runInDurableObject`.
      ...(continuation === null
        ? {}
        : { continuation: (ctx: DurableObjectState) => continuation.attach(ctx.storage) }),
      ...(options.projections ? { projections: options.projections } : {}),
      now: clock.now,
      limits: {
        claimLeaseMs: 150_000,
        maxAttempts: 3,
        continuationTotalMs: 8 * 60_000,
        ...options.limits,
      },
    },
    { runKey: key },
  );

  const stub = runStubForKey(env.RUNS, key);
  await stub.initialize(descriptor);

  const reattach = async (): Promise<void> => {
    if (!continuation) return;
    await runInDurableObject(stub, (_instance, state) => {
      continuation.attach(state.storage);
    });
  };
  await reattach();

  return {
    descriptor,
    runId: record.id,
    key,
    stub,
    clock,
    continuation,
    // Driven over RPC, not through `runInDurableObject`: a pending
    // `runInDurableObject` call pins the test to that object's I/O context, so
    // any other stub call made while a continuation is held fails with
    // "cannot perform I/O on behalf of a different Durable Object". Concurrent
    // kicks are the whole subject here, so they have to be real RPCs.
    //
    // The delete reproduces the platform: the runtime clears the alarm BEFORE
    // running the handler, which is why re-arming inside the handler is allowed
    // to move the next wake later. Skipping it would leave the object's own
    // "only ever arm earlier" rule looking broken.
    alarm: async () => {
      await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
      return stub.dispatchAlarm();
    },
    dispatch: () => stub.dispatchAlarm(),
    storage: (fn) => runInDurableObject(stub, (_instance, state) => fn(state.storage)),
    alarmAt: () => runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
    reattach,
  };
}

export function turn(id: string, overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    id,
    role: "user",
    source: "customer",
    content: "the deploy is stuck",
    ...overrides,
  };
}
