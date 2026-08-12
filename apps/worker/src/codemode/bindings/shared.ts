import type { JsonObject } from "../../run/protocol";
import type {
  AgentExecutionGuard,
  CapabilityAuditSink,
  CodeModeLimits,
  CodeModeScope,
} from "../contracts";
import {
  CapabilityError,
  STALE_GENERATION_MESSAGE,
  toCapabilityError,
} from "../errors";

/**
 * Per-execution call budget.
 *
 * One counter is created per `run_code` execution and threaded through every
 * capability call, so the budget is a property of the execution rather than of
 * a provider. Nothing here is a module global: two runs executing concurrently
 * in the same isolate must not share a count, and the concurrency test in
 * test/codemode-contracts.test.ts exists to keep it that way.
 */
export type CallCounter = {
  /** Reserve the next slot and return its 1-based sequence number. */
  next(): number;
  readonly limit: number;
  readonly used: number;
};

export function newCallCounter(limits: CodeModeLimits): CallCounter {
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
 *
 * Shared by the `memory` and `slack` namespaces *within* one execution so a
 * reference minted by one is usable by the other, and by nothing else.
 *
 * WHO MINTS ONE. Exactly one capability: `memory.findCustomers`, which is
 * Chat-only and mints only after reading the D1 channel/customer catalog
 * itself. That ordering is the guarantee this whole indirection rests on —
 * `resolve()` can only ever return a slug the host read out of its own
 * database, so `customer:${slug}` downstream is never `customer:${modelInput}`.
 * A Slack-origin run mints nothing and accepts no reference: its customer is
 * pinned to its channel's policy (invariant 35).
 *
 * COVERAGE, stated precisely rather than implied. The isolation claim — a
 * reference minted in execution A is unknown in execution B — is proven twice:
 * at unit level in `test/codemode-contracts.test.ts` ("customer references are
 * execution-local"), and END TO END in `test/codemode-isolation.test.ts` ("a
 * customer reference does not survive its execution"), which drives two real
 * `execute()` calls on ONE tool instance and carries the reference across them
 * the way model-authored code would. The end-to-end form is the load-bearing
 * one; the unit tests remain because they pin the refusal's wording, which is
 * itself a security property (it names neither the reference nor a slug).
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
          "that customer reference was not produced in this execution. Use only references returned to you here.",
        );
      }
      return slug;
    },
  };
}

/* -------------------------------------------------------- one execution -- */

/**
 * Everything that belongs to ONE `run_code` execution and must never be shared
 * with a second one.
 *
 * This type exists so that "per execution" is a thing you can hold, pass, and
 * fail to construct — rather than a property of *where* a line of code happens
 * to sit. Before Phase 10 the registry was built once per factory and every one
 * of these fields was silently shared by every tool call the agent loop made:
 * one call budget, one citation cache, one audit stream with colliding ids.
 */
export type CodeExecution = {
  /**
   * The AI SDK `ToolExecutionOptions.toolCallId` of the `run_code` call these
   * capability calls sit underneath. Supplied by the trusted parent, never by
   * model-authored code.
   */
  outerToolCallId: string;
  audit: CapabilityAuditSink;
  counter: CallCounter;
  guard: AgentExecutionGuard;
  customers: CustomerReferenceResolver;
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
  limits: CodeModeLimits;
  clock: () => number;
  abortSignal?: AbortSignal;
}): CodeExecution {
  return {
    outerToolCallId: input.outerToolCallId,
    audit: input.audit,
    counter: newCallCounter(input.limits),
    guard: input.guard,
    customers: newCustomerReferenceResolver(),
    clock: input.clock,
    abortSignal: input.abortSignal,
  };
}

/** Names whose *values* are redacted before they reach an audit record. */
const SECRET_KEY = /token|secret|password|passwd|api[_-]?key|authorization|cookie|credential/i;
/** Values that look like a credential regardless of what they are called. */
const SECRET_VALUE = /xox[baprs]-|^Bearer\s|^sk-|^lin_api_|^lsv2_|^sb_(secret|publishable)_/i;

/**
 * Strip credential-shaped arguments before they are recorded.
 *
 * The key is dropped along with the value, not blanked in place. A field
 * *named* `apiKey` is itself information — it fingerprints which credential an
 * adapter is passing around — and an audit record is durable. Only the count
 * survives, which is enough to notice that an adapter is passing something it
 * should not.
 *
 * Defense in depth only. The real boundary is that no credential is ever in
 * scope for a capability argument in the first place: gateways own secrets and
 * providers receive narrow interfaces. This exists so that a future adapter
 * getting that wrong leaves a redaction count rather than a durable plaintext
 * copy of a token.
 */
function redactArgs(args: JsonObject | undefined): JsonObject | null {
  if (args === undefined) return null;

  const out: Record<string, unknown> = {};
  let redacted = 0;
  for (const [key, value] of Object.entries(args)) {
    const secretName = SECRET_KEY.test(key);
    const secretValue = typeof value === "string" && SECRET_VALUE.test(value);
    if (secretName || secretValue) {
      redacted += 1;
      continue;
    }
    out[key] = summarizeNonData(value);
  }
  if (redacted > 0) out.redactedFields = redacted;
  return out as JsonObject;
}

/**
 * Replace anything that is not plain JSON data with a description of it.
 *
 * This exists for `files.publish`, whose validated input carries a real
 * `Uint8Array` of up to `MAX_ARTIFACT_BYTES`. An audit record is supposed to
 * say what a call was ASKED to do, and every consumer downstream bounds the
 * string it stores — but bounding happens after serialization, and
 * `JSON.stringify` on a 5MB typed array first materializes a ~67 MILLION
 * character string (`{"0":1,"1":2,…}`) inside the trusted parent Worker, taking
 * over a second of CPU. The stored event would look perfectly correct at 400
 * characters, which is exactly why nothing downstream can catch this: the cost
 * is entirely in a transient allocation that model-authored code can trigger on
 * demand, once per publish.
 *
 * So the bytes never enter the record in the first place. A summary is also the
 * more USEFUL audit line — "20 bytes of binary" is what a reader wants, and the
 * content hash is already an argument of the effect key.
 */
function summarizeNonData(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value !== "object") return value;

  if (ArrayBuffer.isView(value)) return `<binary: ${value.byteLength} bytes>`;
  if (value instanceof ArrayBuffer) return `<binary: ${value.byteLength} bytes>`;
  if (Array.isArray(value)) return value.map(summarizeNonData);

  // A class instance is not data. Naming its constructor is enough for an
  // audit line and avoids walking an object whose size we do not control.
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    const name = (value as object).constructor?.name;
    return `<${typeof name === "string" && name.length > 0 ? name : "object"}>`;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = summarizeNonData(item);
  return out;
}

function serializedLength(value: unknown): number | null {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : encoded.length;
  } catch {
    return null;
  }
}

/**
 * The single chokepoint every capability call passes through.
 *
 * Responsibilities, in order: charge the execution's call budget, record that
 * the call started, confirm the run still wants this work, run it, and record
 * how it ended. Scope and execution both arrive as arguments rather than being
 * read from ambient state — the one refactor most likely to cross two
 * customers' data is a module-global `currentRun`, and there is a test
 * dedicated to preventing it.
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
  scope: CodeModeScope,
  namespace: string,
  method: string,
  fn: () => Promise<T>,
  args?: JsonObject,
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
        `this execution has used its budget of ${counter.limit} capability calls. Collect what you need in fewer calls.`,
      ),
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

/** The refusal a guard raises. Exported so an implementation cannot misspell it. */
export function staleGeneration(): CapabilityError {
  return new CapabilityError("stale_generation", STALE_GENERATION_MESSAGE);
}
