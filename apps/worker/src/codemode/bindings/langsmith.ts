import { z } from "zod";
import type { ToolDescriptors } from "@cloudflare/codemode/ai";
import { auditedCapability, type BindingContext } from "../registry";

const traceRef = z.strictObject({
  traceId: z.string(),
  name: z.string(),
  startedAt: z.string(),
  status: z.string(),
});

/**
 * A flat node list with parent links, never a nested tree. `JsonValue` bottoms
 * out after four levels, so a nested tree cannot survive
 * `RunDO.appendToolCallUpdate` — and that failure is a typecheck error the test
 * suite cannot see, because vitest strips types. Model code rebuilds the tree
 * from parentId in three lines if it wants one.
 */
const trace = z.strictObject({
  traceId: z.string(),
  name: z.string(),
  startedAt: z.string(),
  status: z.string(),
  nodes: z.array(
    z.strictObject({
      id: z.string(),
      parentId: z.string().nullable(),
      name: z.string(),
      runType: z.string(),
      status: z.string(),
      startedAt: z.string(),
      durationMs: z.number(),
      inputPreview: z.string(),
      outputPreview: z.string(),
      error: z.string().nullable(),
    }),
  ),
  truncated: z.boolean(),
});

/**
 * Reads only, against one fixed project. The credential is account-wide, so the
 * project pin lives in configuration and never in an argument — the same reason
 * the Linear destination is not a parameter.
 */
export function makeLangSmithTools(ctx: BindingContext): ToolDescriptors {
  return {
    trace: auditedCapability(ctx, "langsmith", "trace", {
      effect: "read",
      description:
        "Fetch one recorded run by its identifier. Steps come back as a flat list; rebuild the tree from parentId if you need it.",
      input: z.strictObject({ traceId: z.string().min(1).max(200) }),
      output: trace,
      run: async (input) => ctx.deps.langsmith.trace(input.traceId),
    }),

    searchTraces: auditedCapability(ctx, "langsmith", "searchTraces", {
      effect: "read",
      // searchTraces, not search: see the naming note in the Slack binding.
      description:
        "Find recorded runs in the configured project. Use ISO-8601 for 'since'.",
      input: z
        .strictObject({
          query: z.string().min(1).max(500).optional(),
          since: z.string().min(1).max(64).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        })
        .default({}),
      output: z.array(traceRef),
      run: async (input) =>
        ctx.deps.langsmith.searchTraces({
          query: input.query ?? null,
          since: input.since ?? null,
          limit: input.limit ?? 20,
        }),
    }),
  };
}
