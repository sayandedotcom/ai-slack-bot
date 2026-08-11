import { z } from "zod";
import type { ToolDescriptors } from "@cloudflare/codemode/ai";
import { auditedCapability, type BindingContext } from "../registry";

const fact = z.strictObject({
  factId: z.string(),
  fact: z.string(),
});

const citation = z.strictObject({
  factId: z.string(),
  fact: z.string(),
  source: z.string(),
  permalink: z.string().nullable(),
});

/**
 * Read-only, on purpose. There is no `remember()` in Phase 09: memory writes
 * are automatic system behaviour driven by what actually happened, because a
 * model-callable write would durably record things the model merely inferred.
 */
export function makeMemoryTools(ctx: BindingContext): ToolDescriptors {
  return {
    recall: auditedCapability(ctx, "memory", "recall", {
      description:
        "Recall previously recorded facts. Scope 'customer' stays within this run's customer; 'org' covers shared engineering knowledge.",
      input: z.strictObject({
        query: z.string().min(1).max(500),
        scope: z.enum(["customer", "org"]).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      output: z.array(fact),
      run: async (input) =>
        ctx.deps.memory.recall(
          input.query,
          input.scope ?? "customer",
          input.limit ?? 10,
        ),
    }),

    cite: auditedCapability(ctx, "memory", "cite", {
      description:
        "Turn recalled facts into quotable citations. Only identifiers returned by recall in this same execution are accepted.",
      input: z.strictObject({
        factIds: z.array(z.string().min(1)).min(1).max(50),
      }),
      output: z.array(citation),
      run: async (input) => ctx.deps.memory.cite(input.factIds),
    }),
  };
}
