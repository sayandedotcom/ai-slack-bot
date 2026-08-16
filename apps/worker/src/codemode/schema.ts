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
  const json = z.toJSONSchema(schema, { io: "input" }) as JSONSchema7;
  cache.set(schema as unknown as object, json);
  return json;
}
