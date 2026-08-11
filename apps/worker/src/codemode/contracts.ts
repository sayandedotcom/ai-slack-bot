import { z } from "zod";
import type { JsonObject, JsonValue } from "../run/protocol";
import { CapabilityError, type CapabilityErrorCode } from "./errors";

/**
 * The trusted envelope every capability call runs inside.
 *
 * Validated once, before any provider is constructed, and never serialized
 * into the Dynamic Worker. Model-authored code cannot read it, name it, or
 * influence it; it only observes its effects (which customer's rows come back,
 * which thread a reply lands in).
 *
 * Each field has exactly one trusted source. See the field-source table in
 * docs/superpowers/plans/phase-09-code-mode-tier-1.md — in particular `shadow`,
 * which lives on the D1 `runs` row and NOT on `RunState`. A shadow check that
 * reads it off the run descriptor reads `undefined` and fails open.
 */
export type CodeModeScope = {
  runId: string;
  turnId: string;
  origin: "slack" | "chat";
  shadow: boolean;
  customerSlug: string | null;
  slackThread: {
    channelId: string;
    threadTs: string;
  } | null;
  actor: {
    engineerEmail: string;
    slackUserId: string | null;
  } | null;
};

/**
 * Caps on a single `run_code` execution. One reviewed production constant;
 * tests inject smaller ones. Nothing the model writes, and no HTTP request,
 * may raise them.
 */
export type CodeModeLimits = {
  maxCodeChars: number;
  wallTimeMs: number;
  cpuMs: number;
  subRequests: number;
  maxResultChars: number;
  maxConsoleChars: number;
  maxCapabilityCalls: number;
};

export const PRODUCTION_LIMITS: CodeModeLimits = {
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

/* ------------------------------------------------------------------ scope -- */

// Slack IDs are uppercase alphanumeric with a type-letter prefix (C…, U…).
const SLACK_ID = /^[A-Z][A-Z0-9]{1,20}$/;
// Slack message timestamps are `<10-digit epoch>.<6-digit sequence>`. Accepting
// a looser shape here is how a caller-supplied string reaches an API call.
const SLACK_TS = /^\d{10}\.\d{6}$/;

const scopeSchema = z
  .strictObject({
    runId: z.string().min(1).max(200),
    turnId: z.string().min(1).max(200),
    origin: z.enum(["slack", "chat"]),
    shadow: z.boolean(),
    customerSlug: z.string().min(1).max(120).nullable(),
    slackThread: z
      .strictObject({
        channelId: z.string().regex(SLACK_ID),
        threadTs: z.string().regex(SLACK_TS),
      })
      .nullable(),
    actor: z
      .strictObject({
        engineerEmail: z.string().min(3).max(320).includes("@"),
        slackUserId: z.string().regex(SLACK_ID).nullable(),
      })
      .nullable(),
  })
  .refine((s) => s.origin !== "slack" || s.slackThread !== null, {
    message: "a Slack run must carry both channelId and threadTs",
  });

/**
 * Validate the trust envelope. Strict at every level: an unknown field is
 * rejected rather than dropped, because silently ignoring `slackToken` is what
 * lets a later refactor start reading it.
 *
 * The thrown message names the offending *path*, never the offending value —
 * echoing a smuggled credential into an error string would defeat the point.
 */
export function validateScope(input: unknown): CodeModeScope {
  const parsed = scopeSchema.safeParse(input);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.code}`;
    })
    .join("; ");
  throw new CapabilityError(
    "invalid_context",
    `the execution scope is not usable (${issues})`,
  );
}

/* ------------------------------------------------------------- safe json -- */

/**
 * Maximum container nesting, fixed by the protocol rather than chosen.
 *
 * Results flow into `RunDO.appendToolCallUpdate({ output?: JsonValue })`, and
 * `JsonValue` in src/run/protocol.ts bottoms out after four levels — it has to,
 * because a self-referential JSON type trips TS2589 across an RPC stub and
 * `unknown` collapses the return type to `never`. A value one level deeper is a
 * typecheck failure that no test can observe. Hence 3, not a round number.
 */
export const MAX_JSON_DEPTH = 3;

/**
 * Keys that must never be copied onto a result object. `JSON.parse` creates
 * `__proto__` as a real own property, so a parsed upstream payload can carry
 * one; assigning it with `out[key] = …` would set the prototype instead of a
 * field.
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function invalidInput(reason: string): CapabilityError {
  return new CapabilityError("invalid_input", reason);
}

function describeValue(value: object): string {
  const name = value.constructor?.name;
  return typeof name === "string" && name.length > 0 ? name : "an exotic object";
}

/**
 * Reduce an arbitrary host value to something that is both JSON and inside the
 * protocol's depth bound, or refuse.
 *
 * Refusal rather than coercion is deliberate. Quietly turning an `Error` into
 * `{}` or a `Uint8Array` into `{"0":1,"1":2}` produces a result the model will
 * reason about incorrectly; a capability that cannot express its result in JSON
 * has a design problem the adapter should fix.
 */
function coerce(value: unknown, depth: number, path: Set<object>): JsonValue {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
      return value;
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw invalidInput(`${String(value)} has no JSON representation`);
      }
      return value;
    case "bigint":
      throw invalidInput("a bigint has no JSON representation");
    case "undefined":
      throw invalidInput("undefined is not a JSON value");
    case "function":
      throw invalidInput("a function is not a JSON value");
    case "symbol":
      throw invalidInput("a symbol is not a JSON value");
  }

  const object = value as object;

  if (depth >= MAX_JSON_DEPTH) {
    throw invalidInput(
      `nested deeper than ${MAX_JSON_DEPTH} levels, which the run protocol cannot store`,
    );
  }
  if (path.has(object)) {
    throw invalidInput("contains a circular reference");
  }

  path.add(object);
  try {
    if (Array.isArray(object)) {
      return object.map((item) => coerce(item, depth + 1, path)) as JsonValue;
    }

    // Anything with its own prototype is a class instance, not data: Error,
    // Response, Request, Uint8Array, Date, an SDK object, an RPC stub. Note
    // this also means a hostile `toJSON()` is rejected as a function-valued
    // property and never invoked — we do not call it to find out.
    const proto = Object.getPrototypeOf(object) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      throw invalidInput(
        `a ${describeValue(object)} is not plain JSON data; format it in the adapter`,
      );
    }

    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(object)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      out[key] = coerce(item, depth + 1, path);
    }
    return out as JsonValue;
  } finally {
    path.delete(object);
  }
}

/**
 * The single conversion every capability result passes through on its way out
 * of the trusted parent Worker.
 */
export function toSafeJson(value: unknown, limits: CodeModeLimits): JsonValue {
  const safe = coerce(value, 0, new Set<object>());

  const encoded = JSON.stringify(safe);
  if (encoded !== undefined && encoded.length > limits.maxResultChars) {
    throw new CapabilityError(
      "output_too_large",
      `the result is ${encoded.length} characters; the cap is ${limits.maxResultChars}. Narrow the query or select fewer fields.`,
    );
  }
  return safe;
}

/* ------------------------------------------------------------ audit sink -- */

type CapabilityEventBase = {
  runId: string;
  turnId: string;
  /** 1-based position of this call within one `run_code` execution. */
  seq: number;
  namespace: string;
  method: string;
  at: number;
};

export type CapabilityStarted = CapabilityEventBase & {
  kind: "started";
  args: JsonObject | null;
};

export type CapabilityCompleted = CapabilityEventBase & {
  kind: "completed";
  durationMs: number;
  /** Size of the serialized result, or null when it is not serializable. */
  resultChars: number | null;
};

export type CapabilityFailed = CapabilityEventBase & {
  kind: "failed";
  durationMs: number;
  code: CapabilityErrorCode;
  /** Always the safe message. Never an upstream string. */
  message: string;
  retryable: boolean;
};

export type CapabilityEvent =
  | CapabilityStarted
  | CapabilityCompleted
  | CapabilityFailed;

/**
 * Where capability activity is recorded. Phase 10 adapts these to
 * `RunDO.appendToolCallUpdate()`. Never receives bytes, tokens, SQL
 * credentials, HTTP headers, or an unredacted trace.
 */
export interface CapabilityAuditSink {
  started(event: CapabilityStarted): Promise<void>;
  completed(event: CapabilityCompleted): Promise<void>;
  failed(event: CapabilityFailed): Promise<void>;
}
