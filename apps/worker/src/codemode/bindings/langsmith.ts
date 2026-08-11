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
 * Steps are a flat list carrying their own depth rather than a nested tree.
 * `JsonValue` bottoms out after four levels, so a freely nested tree cannot be
 * stored by `RunDO.appendToolCallUpdate` — and that failure is a typecheck
 * error the test suite cannot see, because vitest strips types.
 */
const trace = z.strictObject({
  traceId: z.string(),
  name: z.string(),
  startedAt: z.string(),
  status: z.string(),
  steps: z.array(
    z.strictObject({
      name: z.string(),
      depth: z.number(),
      status: z.string(),
      durationMs: z.number(),
    }),
  ),
});

/**
 * Reads only, against one fixed project. The credential is account-wide, so the
 * project pin lives in configuration and never in an argument — the same reason
 * the Linear destination is not a parameter.
 */
export function makeLangSmithTools(ctx: BindingContext): ToolDescriptors {
  return {
    trace: auditedCapability(ctx, "langsmith", "trace", {
      description:
        "Fetch one recorded run by its identifier, with its steps flattened into a list.",
      input: z.strictObject({ traceId: z.string().min(1).max(200) }),
      output: trace,
      run: async (input) => ctx.deps.langsmith.trace(input.traceId),
    }),

    searchTraces: auditedCapability(ctx, "langsmith", "searchTraces", {
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
