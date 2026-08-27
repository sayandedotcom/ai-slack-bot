/**
 * Everything that belongs to ONE `run_code` execution, and the chokepoint every
 * capability call passes through.
 *
 * This module exists so that "per execution" is a thing you can hold, pass, and
 * fail to construct — rather than a property of *where* a line of code happens
 * to sit. Nothing here is a module global: two runs executing concurrently in
 * the same isolate must not share a call budget, a citation cache, or an audit
 * stream with colliding ids.
 */
import {
  CapabilityError,
  STALE_GENERATION_MESSAGE,
  toCapabilityError,
} from "../gateways/errors";
import type { RunScope } from "../gateways/scope";
import {
  discardingProvenanceSink,
  type ProvenanceSink,
} from "../memory/episode";
import {
  type CapabilityAuditSink,
  redactArgs,
  serializedLength,
} from "./audit";

/* ------------------------------------------------------------- limits -- */

/**
 * Caps on a single `run_code` execution. One reviewed production constant;
 * tests inject smaller ones. Nothing the model writes, and no HTTP request,
 * may raise them.
 */
export type CapabilityLimits = {
  maxCodeChars: number;
  wallTimeMs: number;
  cpuMs: number;
  subRequests: number;
  maxResultChars: number;
  maxConsoleChars: number;
  maxCapabilityCalls: number;
};

export const PRODUCTION_LIMITS: CapabilityLimits = {
  maxCodeChars: 24_000,
  wallTimeMs: 20_000,
  cpuMs: 500,
  subRequests: 32,
  maxResultChars: 24_000,
  maxConsoleChars: 32_000,
  maxCapabilityCalls: 40,
};

/** Hard ceiling. A configured `wallTimeMs` above this is a bug, not a choice. */
export const MAX_WALL_TIME_MS = 60_000;

/* ------------------------------------------------------------ freshness -- */

export interface AgentExecutionGuard {
  assertFresh(): Promise<void>;
}

/**
 * The guard for callers that have no generation to check.
 *
 * Explicit rather than an optional field. A `guard?: AgentExecutionGuard` would
 * let a call site forget to pass one and silently lose the check; making it
 * required means every caller states which answer it means.
 */
export function alwaysFresh(): AgentExecutionGuard {
  return { async assertFresh() {} };
}

/** The refusal a guard raises. Exported so an implementation cannot misspell it. */
export function staleGeneration(): CapabilityError {
  return new CapabilityError("stale_generation", STALE_GENERATION_MESSAGE);
}

/* -------------------------------------------------------------- budget -- */

export type CallCounter = {
  /** Reserve the next slot and return its 1-based sequence number. */
  next(): number;
  readonly limit: number;
  readonly used: number;
};

export function newCallCounter(limits: CapabilityLimits): CallCounter {
  let used = 0;
  return {
    limit: limits.maxCapabilityCalls,
    // Synchronous increment. JS is single-threaded, so no two concurrent
    // callers can observe the same value — this is what gives interleaved
    // reads distinct sequence numbers without a lock.
    next(): number {
      used += 1;
      return used;
    },
    get used() {
      return used;
    },
  };
}

/* ------------------------------------------------- customer references -- */

/**
 * Maps opaque references to D1-validated customer slugs, for one execution.
 *
 * The indirection is the point. A capability that returned a raw slug would let
 * model-authored code hand that slug back to a *different* capability and read
 * across customers; a reference is unguessable, minted only from a slug the
 * host itself validated, and resolvable only inside the execution that minted
 * it. `crypto.randomUUID()` rather than a counter for exactly that reason —
 * `cust_1` is guessable, and the second execution would happily resolve it.
 */
export type CustomerReferenceResolver = {
  /** Mint a reference for a slug the host has already validated. */
  mint(customerSlug: string): string;
  /** Resolve a reference minted in THIS execution, or refuse. */
  resolve(reference: string): string;
};

export function newCustomerReferenceResolver(): CustomerReferenceResolver {
  const slugs = new Map<string, string>();
  return {
    mint(customerSlug: string): string {
      const reference = `cust_${crypto.randomUUID()}`;
      slugs.set(reference, customerSlug);
      return reference;
    },
    resolve(reference: string): string {
      const slug = slugs.get(reference);
      if (slug === undefined) {
        // Names neither the reference nor any slug: the error is read by the
        // party that supplied the bad reference, and confirming which of two
        // guesses was closer is itself an oracle.
        throw new CapabilityError(
          "invalid_input",
          "that customer reference was not produced in this execution. Use only references returned to you here."
        );
      }
      return slug;
    },
  };
}

/* -------------------------------------------------------- one execution -- */

export type CodeExecution = {
  /**
   * The AI SDK `toolCallId` of the `run_code` call these capability calls sit
   * underneath. Supplied by the trusted parent, never by model-authored code.
   */
  outerToolCallId: string;
  audit: CapabilityAuditSink;
  counter: CallCounter;
  guard: AgentExecutionGuard;
  customers: CustomerReferenceResolver;
  /**
   * Where a trusted tool read registers what it RETURNED.
   *
   * On the execution rather than on `deps` because it belongs to one
   * generation's record of what it learned, not to a vendor port. A capability
   * writes ids the HOST produced — a Zep episode uuid, a stored message event
   * id — and never anything model-authored code supplied or even saw.
   */
  provenance: ProvenanceSink;
  clock: () => number;
  /** The overall operation's signal, where a parent-side wait can honour it. */
  abortSignal?: AbortSignal;
};

/**
 * Build the state for one execution. Every field that could leak between two
 * tool calls is constructed here, so there is exactly one place to look.
 */
export function newCodeExecution(input: {
  outerToolCallId: string;
  audit: CapabilityAuditSink;
  guard: AgentExecutionGuard;
  limits: CapabilityLimits;
  clock: () => number;
  provenance?: ProvenanceSink;
  abortSignal?: AbortSignal;
}): CodeExecution {
  return {
    outerToolCallId: input.outerToolCallId,
    audit: input.audit,
    counter: newCallCounter(input.limits),
    guard: input.guard,
    customers: newCustomerReferenceResolver(),
    // Defaults to discarding, which is the right default for a
    // declaration-only registry and for a caller with no generation to
    // attribute a read to. A missing sink costs a citation; it can never
    // produce a wrong one.
    provenance: input.provenance ?? discardingProvenanceSink(),
    clock: input.clock,
    abortSignal: input.abortSignal,
  };
}

/* ----------------------------------------------------------- the pipe -- */

/**
 * The single chokepoint every capability call passes through.
 *
 * Responsibilities, in order: charge the execution's call budget, record that
 * the call started, confirm the run still wants this work, run it, and record
 * how it ended. Scope and execution both arrive as arguments rather than being
 * read from ambient state — the one refactor most likely to cross two
 * customers' data is a module-global `currentRun`.
 *
 * The freshness check sits immediately before the host call and after the
 * budget charge. That order is deliberate: a stale call must still be *counted*
 * and *recorded*, because "the loop kept calling capabilities on a superseded
 * generation" is the exact thing an operator needs to be able to see, and a
 * refusal that leaves no trace is indistinguishable from a call that never
 * happened.
 *
 * Errors are narrowed on the way out. An adapter is supposed to translate its
 * own upstream failures, but if one does not, collapsing here is what stops an
 * upstream connection string from being handed to model-authored code.
 */
export async function withCapabilityAudit<T>(
  execution: CodeExecution,
  scope: RunScope,
  namespace: string,
  method: string,
  fn: () => Promise<T>,
  /**
   * Wider than `JsonObject` on purpose: `files.publish` carries a real
   * `Uint8Array`. `redactArgs` is what narrows this to JSON before it is
   * recorded — see `summarizeNonData`.
   */
  args?: Record<string, unknown>
): Promise<T> {
  const { audit, clock, counter } = execution;
  const seq = counter.next();
  const startedAt = clock();

  const base = {
    runId: scope.runId,
    turnId: scope.turnId,
    callId: `cap:${execution.outerToolCallId}:${seq}`,
    seq,
    namespace,
    method,
    at: startedAt,
  };

  await audit.started({ ...base, kind: "started", args: redactArgs(args) });

  const fail = async (err: unknown): Promise<never> => {
    const safe = toCapabilityError(err);
    await audit.failed({
      ...base,
      kind: "failed",
      durationMs: clock() - startedAt,
      code: safe.code,
      message: safe.message,
      retryable: safe.retryable,
    });
    throw safe;
  };

  // Budget is charged before the host call, not after: the point is that the
  // 41st read never reaches Slack, not that it is logged after it did.
  if (seq > counter.limit) {
    return fail(
      new CapabilityError(
        "capability_unavailable",
        `this execution has used its budget of ${counter.limit} capability calls. Collect what you need in fewer calls.`
      )
    );
  }

  // The last thing before the capability body. Checking here rather than only
  // at the top of the execution is what bounds the damage of a long program:
  // an isolate that has been running for ten seconds against superseded input
  // stops at its next capability call instead of finishing its whole plan.
  try {
    await execution.guard.assertFresh();
  } catch (err) {
    return fail(err);
  }

  let result: T;
  try {
    result = await fn();
  } catch (err) {
    return fail(err);
  }

  await audit.completed({
    ...base,
    kind: "completed",
    durationMs: clock() - startedAt,
    resultChars: serializedLength(result),
  });
  return result;
}
