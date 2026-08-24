import { z } from "zod";

import type { ClassifiedTool } from "../define";
import { auditedCapability, type BindingContext } from "../registry";

const logLine = z.strictObject({
  at: z.string(),
  level: z.string(),
  message: z.string(),
});

/**
 * An explicit ALLOWLIST of fields, not a passthrough and not a denylist.
 *
 * The upstream monitor record carries the credentials each monitor uses to
 * authenticate against whatever it watches. Returning the record as-is, or
 * removing the fields known to be sensitive today, hands those to model code
 * the first time upstream adds a field nobody denylisted.
 */
const monitor = z.strictObject({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  lastCheckedAt: z.string().nullable(),
});

export function makeBetterStackTools(ctx: BindingContext): Record<string, ClassifiedTool> {
  return {
    logs: auditedCapability(ctx, "betterstack", "logs", {
      effect: "read",
      description:
        "Search collected production logs over a time window. 'since' and 'until' are ISO-8601 instants.",
      input: z.strictObject({
        query: z.string().min(1).max(1000),
        since: z.string().min(1).max(64),
        until: z.string().min(1).max(64).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      output: z.array(logLine),
      run: async (input) =>
        ctx.deps.betterstack.logs({
          query: input.query,
          since: input.since,
          until: input.until ?? null,
          limit: input.limit ?? 50,
        }),
    }),

    monitors: auditedCapability(ctx, "betterstack", "monitors", {
      effect: "read",
      description:
        "List the current up/down state of the configured monitors.",
      // Takes no arguments, but still needs `.default({})`: a model writing
      // `betterstack.monitors()` reaches execute(undefined), because
      // ToolDispatcher spreads an empty argument array.
      input: z.strictObject({}).default({}),
      output: z.array(monitor),
      run: async () => ctx.deps.betterstack.monitors(),
    }),
  };
}
