import { z } from "zod";
import type { ToolDescriptors } from "@cloudflare/codemode/ai";
import { auditedCapability, type BindingContext } from "../registry";

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const row = z.record(z.string(), scalar);

const resourceDescription = z.strictObject({
  resource: z.string(),
  columns: z.array(z.strictObject({ name: z.string(), type: z.string() })),
});

/**
 * A bounded, allowlisted read surface rather than a query string.
 *
 * Two reasons it is shaped this way. A structured filter list is trivial to
 * validate and audit, where a free-form query string is neither. And read-only
 * is enforced twice — here, and by the database itself, because the credential
 * is the publishable one and therefore subject to row-level policy. This is the
 * only vendor in the phase with a credential-level backstop.
 */
export function makeSupabaseTools(ctx: BindingContext): ToolDescriptors {
  return {
    schema: auditedCapability(ctx, "supabase", "schema", {
      description:
        "List the readable resources and their columns. Call this before select to learn what exists.",
      input: z
        .strictObject({ resource: z.string().min(1).max(120).optional() })
        .default({}),
      output: z.array(resourceDescription),
      run: async (input) => ctx.deps.supabase.describe(input.resource ?? null),
    }),

    select: auditedCapability(ctx, "supabase", "select", {
      description:
        "Read rows from one allowed resource. Filters are structured; free-form query text is not accepted.",
      input: z.strictObject({
        resource: z.string().min(1).max(120),
        columns: z.array(z.string().min(1).max(120)).max(50).optional(),
        filters: z
          .array(
            z.strictObject({
              column: z.string().min(1).max(120),
              op: z.enum([
                "eq",
                "neq",
                "gt",
                "gte",
                "lt",
                "lte",
                "in",
                "is",
                "like",
              ]),
              value: z.union([scalar, z.array(z.union([z.string(), z.number()])).max(100)]),
            }),
          )
          .max(10)
          .optional(),
        order: z
          .strictObject({
            column: z.string().min(1).max(120),
            direction: z.enum(["asc", "desc"]),
          })
          .optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      output: z.array(row),
      run: async (input) =>
        ctx.deps.supabase.select({
          resource: input.resource,
          columns: input.columns ?? null,
          filters: input.filters ?? [],
          order: input.order ?? null,
          limit: input.limit ?? 50,
        }),
    }),
  };
}
