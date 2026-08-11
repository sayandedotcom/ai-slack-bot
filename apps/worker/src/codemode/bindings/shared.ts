import type { JsonObject } from "../../run/protocol";
import type {
  CapabilityAuditSink,
  CodeModeLimits,
  CodeModeScope,
} from "../contracts";
import { CapabilityError, toCapabilityError } from "../errors";

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

export type AuditDeps = {
  audit: CapabilityAuditSink;
  clock: () => number;
};

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
    out[key] = value;
  }
  if (redacted > 0) out.redactedFields = redacted;
  return out as JsonObject;
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
 * the call started, run it, and record how it ended. Scope arrives as an
 * argument on every call rather than being read from ambient state — the one
 * refactor most likely to cross two customers' data is a module-global
 * `currentRun`, and there is a test dedicated to preventing it.
 *
 * Errors are narrowed on the way out. An adapter is supposed to translate its
 * own upstream failures, but if one does not, collapsing here is what stops an
 * upstream connection string from being handed to model-authored code.
 */
export async function withCapabilityAudit<T>(
  deps: AuditDeps,
  scope: CodeModeScope,
  counter: CallCounter,
  namespace: string,
  method: string,
  fn: () => Promise<T>,
  args?: JsonObject,
): Promise<T> {
  const seq = counter.next();
  const startedAt = deps.clock();

  const base = {
    runId: scope.runId,
    turnId: scope.turnId,
    seq,
    namespace,
    method,
    at: startedAt,
  };

  await deps.audit.started({ ...base, kind: "started", args: redactArgs(args) });

  const fail = async (err: unknown): Promise<never> => {
    const safe = toCapabilityError(err);
    await deps.audit.failed({
      ...base,
      kind: "failed",
      durationMs: deps.clock() - startedAt,
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

  let result: T;
  try {
    result = await fn();
  } catch (err) {
    return fail(err);
  }

  await deps.audit.completed({
    ...base,
    kind: "completed",
    durationMs: deps.clock() - startedAt,
    resultChars: serializedLength(result),
  });
  return result;
}
