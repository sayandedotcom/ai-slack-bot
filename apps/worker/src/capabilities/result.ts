/**
 * The single conversion every capability result passes through on its way out
 * of the trusted parent Worker.
 *
 * This lived in the deleted `codemode/contracts.ts`. It has one job — reduce an
 * arbitrary host value to something that is both JSON and inside the run
 * protocol's depth bound, or refuse — so it gets its own module rather than
 * being folded into `execution.ts`.
 */
import { CapabilityError } from "../gateways/errors";
import type { JsonValue } from "../run/protocol";
import type { CapabilityLimits } from "./execution";

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
  return typeof name === "string" && name.length > 0
    ? name
    : "an exotic object";
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
      `nested deeper than ${MAX_JSON_DEPTH} levels, which the run protocol cannot store`
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
        `a ${describeValue(object)} is not plain JSON data; format it in the adapter`
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

export function toSafeJson(
  value: unknown,
  limits: CapabilityLimits
): JsonValue {
  const safe = coerce(value, 0, new Set<object>());

  const encoded = JSON.stringify(safe);
  if (encoded !== undefined && encoded.length > limits.maxResultChars) {
    throw new CapabilityError(
      "output_too_large",
      `the result is ${encoded.length} characters; the cap is ${limits.maxResultChars}. Narrow the query or select fewer fields.`
    );
  }
  return safe;
}
