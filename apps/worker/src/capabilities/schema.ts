import type { JSONSchema7 } from "json-schema";
import { z } from "zod";

/**
 * Convert a Zod schema to the JSON Schema a `ConnectorTool` must carry.
 *
 * Load-bearing, and not obvious. `@cloudflare/codemode`'s connector base
 * derives its descriptors with:
 *
 *   for (const candidate of [t.inputSchema, t.parameters])
 *     if (candidate && typeof candidate === "object" &&
 *         ("type" in candidate || "properties" in candidate || "$ref" in candidate))
 *       return candidate;
 *   return { type: "object" };
 *
 * A Zod v4 schema has `.type === "object"`, so it PASSES that check and is
 * used verbatim as if it were JSON Schema — but it has no `.properties`, so
 * `generateTypesFromJsonSchema` renders `type XInput = unknown` and drops the
 * description. Measured 2026-08-16; see phase-25-notes.md.
 *
 * The Zod schema itself stays the runtime boundary (the parse inside
 * `defineCapability`); this is only what the model is shown.
 */
const cache = new WeakMap<object, JSONSchema7>();

export function toJsonSchema(schema: z.ZodType): JSONSchema7 {
  const cached = cache.get(schema as unknown as object);
  if (cached) return cached;
  const json = z.toJSONSchema(schema, {
    io: "input",
    // `unrepresentable` defaults to "throw", and one real capability trips it:
    // `files.publish` takes `bytes: z.instanceof(Uint8Array)`, which has no
    // JSON Schema. Throwing here would not degrade one field — it would abort
    // `FirefighterConnector.tools()`, so `describe()` throws, so the whole
    // `files` connector fails to build and `run_code` cannot be constructed at
    // all. Measured 2026-08-16 by the Task 4 sweep.
    //
    // "any" emits `{}` for that one node instead, which is what JSON Schema
    // means by "any value" and is strictly more than the model gets today:
    // `bytes` types as `unknown` while `contentType` and `filename` keep their
    // real types, where the legacy renderer degraded the ENTIRE capability to
    // `unknown`. The hand-written `FILES_DECLARATIONS` override still wins for
    // what the model is shown, and the Zod schema is still the runtime parse —
    // binary really does survive the boundary (the package base64-tags a
    // Uint8Array with `__codemode_binary_v1__` and decodes it on the host).
    unrepresentable: "any",
  }) as JSONSchema7;
  cache.set(schema as unknown as object, json);
  return json;
}
