import type { JsonValue } from "../run/protocol";
import type { CodeModeScope } from "./contracts";
import { CapabilityError, safeMessage, toCapabilityError } from "./errors";
import type { CapabilityErrorCode } from "./errors";

/**
 * Bumping this invalidates every existing key, which is the point: if the
 * envelope's shape changes, old rows must stop matching rather than silently
 * start colliding with new ones.
 */
const EFFECT_KEY_VERSION = 1;

/** How long a caller waits on someone else's in-flight reservation. */
const POLL_INTERVAL_MS = 5;
const MAX_POLLS = 40;

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * Codes that prove the call was refused *before* anything left this Worker.
 *
 * Everything absent from this set is treated as unproven, including
 * `upstream_unavailable` and `output_too_large`. That asymmetry is deliberate:
 * mistakenly marking a real send as `failed` lets a retry send it twice, while
 * mistakenly marking a non-send as `in_doubt` only costs a human a look. Only
 * one of those reaches a customer.
 */
const PROVEN_PRE_UPSTREAM: ReadonlySet<CapabilityErrorCode> = new Set([
  "invalid_context",
  "invalid_input",
  "capability_unavailable",
  "channel_read_only",
  "slack_context_required",
  "identity_unavailable",
  "shadow_write_denied",
  "linear_team_denied",
  "customer_scope_required",
  "read_only_violation",
]);

export type EffectDeps = {
  db: D1Database;
  clock: () => number;
};

export type RunEffectOptions<T> = {
  /**
   * Perform the effect. Receives the effect key so it can be forwarded as the
   * upstream idempotency token wherever the API supports one — the ledger and
   * the vendor then agree on what "the same effect" means.
   */
  execute: (idempotencyKey: string) => Promise<T>;
  /**
   * Ask upstream what actually happened to an in-doubt effect. Return the
   * recorded outcome, or null when upstream cannot confirm either way.
   */
  reconcile?: (idempotencyKey: string) => Promise<T | null>;
};

type EffectRow = {
  state: "reserved" | "completed" | "failed" | "in_doubt";
  safe_result_json: string | null;
};

/* ------------------------------------------------------------ canonical -- */

function invalidInput(reason: string): CapabilityError {
  return new CapabilityError("invalid_input", reason);
}

/**
 * Reduce a value to a form whose JSON encoding is byte-identical for any two
 * semantically equal inputs.
 *
 * Object keys are sorted (key order is not meaning) but array order is
 * preserved (it is). Strings are NFC-normalized so that two spellings of "café"
 * do not reserve two different effects and send two messages.
 */
function canonical(value: unknown, path: Set<object>): unknown {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
      return value.normalize("NFC");
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw invalidInput(`${String(value)} cannot be part of an effect key`);
      }
      return value;
    case "bigint":
      throw invalidInput("a bigint cannot be part of an effect key");
    case "undefined":
      throw invalidInput("undefined cannot be part of an effect key");
    case "function":
      throw invalidInput("a function cannot be part of an effect key");
    case "symbol":
      throw invalidInput("a symbol cannot be part of an effect key");
  }

  const object = value as object;
  if (path.has(object)) {
    throw invalidInput("an effect argument contains a circular reference");
  }

  path.add(object);
  try {
    if (Array.isArray(object)) {
      return object.map((item) => canonical(item, path));
    }
    const proto = Object.getPrototypeOf(object) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      throw invalidInput(
        "only plain JSON data can be part of an effect key; format it in the adapter",
      );
    }
    const source = object as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      out[key] = canonical(source[key], path);
    }
    return out;
  } finally {
    path.delete(object);
  }
}

function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(canonical(value, new Set<object>()));
  if (encoded === undefined) {
    throw invalidInput("the effect arguments have no JSON encoding");
  }
  return encoded;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The identity of one side effect.
 *
 * A SHA-256 over a canonical versioned envelope rather than string
 * concatenation — concatenation collides the moment an argument contains the
 * separator, and a collision here means one customer's message suppressing
 * another's.
 *
 * `turnId` is part of the envelope on purpose. A retry of one model turn must
 * replay; a later turn that deliberately sends the same text must not be
 * mistaken for that retry.
 */
export async function effectKey(
  scope: CodeModeScope,
  namespace: string,
  method: string,
  args: JsonValue,
): Promise<string> {
  return sha256Hex(
    canonicalJson({
      version: EFFECT_KEY_VERSION,
      runId: scope.runId,
      turnId: scope.turnId,
      namespace,
      method,
      args,
    }),
  );
}

/* --------------------------------------------------------------- ledger -- */

function inDoubt(): CapabilityError {
  return new CapabilityError(
    "effect_in_doubt",
    "this effect may already have been performed and could not be confirmed. Do not retry it; report it and let a human check.",
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readEffect(
  deps: EffectDeps,
  key: string,
): Promise<EffectRow | null> {
  return deps.db
    .prepare(
      "SELECT state, safe_result_json FROM codemode_effects WHERE effect_key = ?",
    )
    .bind(key)
    .first<EffectRow>();
}

/** Insert the reservation. Returns false when someone else got there first. */
async function claim(
  deps: EffectDeps,
  key: string,
  scope: CodeModeScope,
  namespace: string,
  method: string,
  argsHash: string,
): Promise<boolean> {
  const now = deps.clock();
  const row = await deps.db
    .prepare(
      `INSERT INTO codemode_effects
         (effect_key, run_id, turn_id, namespace, method, args_hash,
          state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
       ON CONFLICT(effect_key) DO NOTHING
       RETURNING effect_key`,
    )
    .bind(key, scope.runId, scope.turnId, namespace, method, argsHash, now, now)
    .first<{ effect_key: string }>();
  return row !== null;
}

/**
 * Take ownership of a previously failed effect so it can be retried. The
 * `state = 'failed'` guard is what makes this safe under concurrency: exactly
 * one caller's UPDATE matches.
 */
async function reclaim(deps: EffectDeps, key: string): Promise<boolean> {
  const row = await deps.db
    .prepare(
      `UPDATE codemode_effects
          SET state = 'reserved', safe_error = NULL, updated_at = ?
        WHERE effect_key = ? AND state = 'failed'
        RETURNING effect_key`,
    )
    .bind(deps.clock(), key)
    .first<{ effect_key: string }>();
  return row !== null;
}

async function mark(
  deps: EffectDeps,
  key: string,
  state: EffectRow["state"],
  resultJson: string | null,
  error: string | null,
): Promise<void> {
  await deps.db
    .prepare(
      `UPDATE codemode_effects
          SET state = ?, safe_result_json = ?, safe_error = ?, updated_at = ?
        WHERE effect_key = ?`,
    )
    .bind(state, resultJson, error, deps.clock(), key)
    .run();
}

/**
 * Run the effect while we hold the reservation.
 *
 * No D1 statement is held open across the external call. Reserve and commit,
 * call upstream, then record the outcome in a second statement. The gap between
 * those two writes IS the in-doubt window — which is why `in_doubt` is a state
 * in the schema rather than an error path in this function.
 */
async function performClaimed<T>(
  deps: EffectDeps,
  key: string,
  options: RunEffectOptions<T>,
): Promise<T> {
  let result: T;
  try {
    result = await options.execute(key);
  } catch (err) {
    const safe = toCapabilityError(err);
    if (err instanceof CapabilityError && PROVEN_PRE_UPSTREAM.has(err.code)) {
      await mark(deps, key, "failed", null, safeMessage(err));
      throw err;
    }
    await mark(deps, key, "in_doubt", null, safeMessage(safe));
    throw inDoubt();
  }

  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(result);
  } catch {
    encoded = undefined;
  }
  if (encoded === undefined) {
    // The effect happened; we just cannot record what it produced. Refusing to
    // call that "completed" is what stops a retry from doing it a second time.
    await mark(
      deps,
      key,
      "in_doubt",
      null,
      "effect_in_doubt: the effect succeeded but its result could not be recorded",
    );
    throw inDoubt();
  }

  await mark(deps, key, "completed", encoded, null);
  // Return the round-tripped value so the caller sees exactly what the ledger
  // will replay to a retry. Otherwise the first call and its replay can differ.
  return JSON.parse(encoded) as T;
}

async function resolveInDoubt<T>(
  deps: EffectDeps,
  key: string,
  options: RunEffectOptions<T>,
): Promise<T> {
  if (!options.reconcile) throw inDoubt();

  const found = await options.reconcile(key);
  if (found === null) throw inDoubt();

  const encoded = JSON.stringify(found);
  if (encoded === undefined) throw inDoubt();
  await mark(deps, key, "completed", encoded, null);
  return JSON.parse(encoded) as T;
}

/**
 * Perform an external side effect at most once per (run, turn, namespace,
 * method, arguments).
 *
 * D1 is the coordination authority, not an in-memory set: a Worker restart is
 * exactly when a retry shows up, and an in-process record is empty by then.
 */
export async function runEffect<T>(
  deps: EffectDeps,
  scope: CodeModeScope,
  namespace: string,
  method: string,
  args: JsonValue,
  options: RunEffectOptions<T>,
): Promise<T> {
  // Both hashes are computed before any row is written: an unhashable argument
  // must not leave a reservation behind.
  const argsHash = await sha256Hex(canonicalJson(args));
  const key = await effectKey(scope, namespace, method, args);

  for (let poll = 0; poll <= MAX_POLLS; poll += 1) {
    const row = await readEffect(deps, key);

    if (row === null) {
      if (await claim(deps, key, scope, namespace, method, argsHash)) {
        return performClaimed(deps, key, options);
      }
      continue; // lost the race; the next read sees the winner's row
    }

    switch (row.state) {
      case "completed":
        if (row.safe_result_json === null) throw inDoubt();
        return JSON.parse(row.safe_result_json) as T;

      case "failed":
        if (await reclaim(deps, key)) {
          return performClaimed(deps, key, options);
        }
        continue; // another caller reclaimed it; observe what they do

      case "in_doubt":
        return resolveInDoubt(deps, key, options);

      case "reserved":
        // Someone else is mid-flight. Wait for them rather than sending twice.
        await sleep(POLL_INTERVAL_MS);
        continue;
    }
  }

  // Still reserved after the whole budget: the holder probably died between
  // reserving and recording, which is indistinguishable from a slow send.
  throw inDoubt();
}
