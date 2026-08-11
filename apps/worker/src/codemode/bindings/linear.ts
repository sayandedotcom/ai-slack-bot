import { z } from "zod";
import type { ToolDescriptors } from "@cloudflare/codemode/ai";
import { auditedCapability, type BindingContext } from "../registry";

const level = z.enum(["low", "medium", "high"]);

/**
 * The assessment is required, not optional. It is the thing that replaces the
 * banned ticket type: instead of classifying the work into a category, the
 * model has to state what it is worth and why, in fields a human can argue
 * with.
 */
const assessment = z.strictObject({
  platformValue: level,
  blocking: level,
  customerWeight: level,
  evidence: z.string().min(1).max(2000),
});

export function makeLinearTools(ctx: BindingContext): ToolDescriptors {
  return {
    createIssue: auditedCapability(ctx, "linear", "createIssue", {
      // No destination argument. The destination is pinned server-side; the
      // credential itself reaches every group in the account, so this pin is
      // the only thing that keeps the agent out of the live ones.
      description:
        "File an issue. Where it is filed is fixed by configuration and cannot be chosen here.",
      input: z.strictObject({
        title: z.string().min(1).max(255),
        description: z.string().min(1).max(20_000),
        assessment,
        labels: z.array(z.string().min(1).max(60)).max(10).optional(),
      }),
      output: z.strictObject({
        id: z.string(),
        identifier: z.string(),
        url: z.string(),
      }),
      run: async (input) =>
        ctx.deps.linear.createIssue({
          title: input.title,
          description: renderDescription(input.description, input.assessment),
          labels: input.labels ?? [],
          idempotencyKey: ctx.scope.turnId,
        }),
    }),

    updateIssue: auditedCapability(ctx, "linear", "updateIssue", {
      description:
        "Update an issue this run already created or read. Fields left out are unchanged.",
      input: z.strictObject({
        issueId: z.string().min(1).max(200),
        title: z.string().min(1).max(255).optional(),
        description: z.string().min(1).max(20_000).optional(),
        state: z.string().min(1).max(60).optional(),
      }),
      output: z.strictObject({ id: z.string(), url: z.string() }),
      run: async (input) => ctx.deps.linear.updateIssue(input),
    }),
  };
}

/**
 * The assessment travels in the issue body rather than as structured fields,
 * because the reader is a human triaging a queue, not a query.
 */
function renderDescription(
  body: string,
  a: z.infer<typeof assessment>,
): string {
  return [
    body,
    "",
    "---",
    `Platform value: ${a.platformValue}`,
    `Blocking: ${a.blocking}`,
    `Customer weight: ${a.customerWeight}`,
    "",
    `Evidence: ${a.evidence}`,
  ].join("\n");
}
