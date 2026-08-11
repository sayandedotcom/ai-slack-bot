import { z } from "zod";
import type { ToolDescriptors } from "@cloudflare/codemode/ai";
import { cite as resolveCitations } from "../../memory/cite";
import type { MemoryFact } from "../../memory/store";
import { CapabilityError } from "../errors";
import { auditedCapability, type BindingContext } from "../registry";

const fact = z.strictObject({
  factId: z.string(),
  fact: z.string(),
});

const citation = z.strictObject({
  factId: z.string(),
  fact: z.string(),
  permalink: z.string(),
  ts: z.string(),
});

/**
 * Read-only, on purpose. There is no `remember()` in Phase 09: memory writes
 * are automatic system behaviour driven by what actually happened, because a
 * model-callable write would durably record things the model merely inferred,
 * and the system of record would slowly fill with plausible fiction.
 */
export function makeMemoryTools(ctx: BindingContext): ToolDescriptors {
  /**
   * Facts recalled during THIS execution, keyed by the opaque Zep edge id.
   *
   * Owned by this closure, so it is request-local and holds no cross-run state.
   * It exists so `cite()` can resolve only facts the model actually received:
   * without it, model code could hand over an invented edge id and get a
   * citation pointing at a real message that says something else. Citations are
   * the one thing in this system that must be exact.
   */
  const recalled = new Map<string, MemoryFact>();

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
      run: async (input) => {
        // The graph is derived from the trusted scope. The model cannot name
        // one, which is what stops a customer graph being read from a run that
        // belongs to a different customer.
        const graphId = graphFor(ctx, input.scope ?? "customer");
        const facts = await ctx.deps.memory.search(
          graphId,
          input.query,
          Math.min(input.limit ?? 10, 50),
        );
        for (const f of facts) recalled.set(f.factId, f);
        // Episode UUIDs stay host-side: they are the handle cite() resolves,
        // and exposing them would let model code fabricate one.
        return facts.map((f) => ({ factId: f.factId, fact: f.fact }));
      },
    }),

    cite: auditedCapability(ctx, "memory", "cite", {
      description:
        "Turn recalled facts into quotable citations. Only identifiers returned by recall in this same execution are accepted.",
      input: z.strictObject({
        factIds: z.array(z.string().min(1)).min(1).max(50),
      }),
      output: z.array(citation),
      run: async (input) => {
        // Deduplicate while preserving first-seen order, so a repeated id
        // produces one citation and the result order matches the request.
        const wanted: MemoryFact[] = [];
        const seen = new Set<string>();
        const unknown: string[] = [];
        for (const id of input.factIds) {
          if (seen.has(id)) continue;
          seen.add(id);
          const found = recalled.get(id);
          if (found === undefined) {
            unknown.push(id);
            continue;
          }
          wanted.push(found);
        }

        if (unknown.length > 0) {
          // Refuse rather than silently omit. A short citation list looks like
          // "no source exists", which is a different claim from "you asked
          // about something you never recalled".
          throw new CapabilityError(
            "invalid_input",
            `${unknown.length} of ${seen.size} identifiers were not returned by recall in this execution. Cite only facts you recalled here.`,
          );
        }

        const citations = await resolveCitations(ctx.deps.db, wanted);
        // Drop channel_id: the permalink already locates the message, and a
        // destination identifier is never shown to the model.
        return citations.map((c) => ({
          factId: c.factId,
          fact: c.fact,
          permalink: c.permalink,
          ts: c.ts,
        }));
      },
    }),
  };
}

function graphFor(ctx: BindingContext, scope: "customer" | "org"): string {
  if (scope === "org") return "org";
  if (ctx.scope.customerSlug === null) {
    throw new CapabilityError(
      "customer_scope_required",
      "this run has no customer, so there is no customer memory to search. Ask which customer this concerns, or use scope 'org'.",
    );
  }
  return `customer:${ctx.scope.customerSlug}`;
}
