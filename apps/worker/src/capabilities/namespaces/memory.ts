import { z } from "zod";

import type { ClassifiedTool } from "../define";
import { cite as resolveCitations } from "../../memory/cite";
import { CUSTOMER_SEARCH_MAX, searchCustomers } from "../../db/channels";
import type { MemoryFact } from "../../memory/store";
import { CapabilityError } from "../../gateways/errors";
import { auditedCapability, type BindingContext } from "../registry";
import { assertDiscoveryAllowed, resolveCustomerScope } from "./customers";

const fact = z.strictObject({
  factId: z.string(),
  fact: z.string(),
});

const customerMatch = z.strictObject({
  /** Opaque, execution-local, and the ONLY handle a capability will accept. */
  customerRef: z.string(),
  label: z.string(),
});

/**
 * A reference is a handle, not a name. Bounded so a model cannot paste a
 * megabyte of text into the resolver's map key and so an obviously-forged value
 * is refused before it costs a lookup.
 */
const customerRefInput = z.string().min(1).max(120).optional();

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
export function makeMemoryTools(
  ctx: BindingContext
): Record<string, ClassifiedTool> {
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
    /**
     * The one way a customer enters an internal chat's scope.
     *
     * Read-only, Chat-only, capped, and it hands back a REFERENCE rather than
     * anything that names the customer to the host: a slug, a graph id or a
     * channel id in this result would be a credential for reading that
     * customer's data from any later execution.
     */
    findCustomers: auditedCapability(ctx, "memory", "findCustomers", {
      effect: "read",
      description:
        "Look up which customer an internal question is about. Returns opaque references usable only in this execution; pass one as customerRef to recall or slack.searchMessages. Unavailable in a customer conversation, which is already scoped.",
      input: z.strictObject({
        query: z.string().min(2).max(120),
        limit: z.number().int().min(1).max(CUSTOMER_SEARCH_MAX).optional(),
      }),
      output: z.array(customerMatch),
      run: async (input) => {
        assertDiscoveryAllowed(ctx);
        const matches = await searchCustomers(
          ctx.deps.db,
          input.query,
          input.limit ?? 5
        );
        // Mint AFTER the D1 read, one reference per row D1 actually returned.
        // That ordering is the guarantee: the resolver only ever holds slugs
        // this host read out of its own catalog.
        return matches.map((match) => ({
          customerRef: ctx.execution.customers.mint(match.slug),
          label: match.label,
        }));
      },
    }),

    recall: auditedCapability(ctx, "memory", "recall", {
      effect: "read",
      description:
        "Recall previously recorded facts. Scope 'customer' stays within this conversation's customer, or the one named by customerRef in an internal chat; 'org' covers shared engineering knowledge.",
      input: z.strictObject({
        query: z.string().min(1).max(500),
        scope: z.enum(["customer", "org"]).optional(),
        customerRef: customerRefInput,
        limit: z.number().int().min(1).max(50).optional(),
      }),
      output: z.array(fact),
      run: async (input) => {
        // The graph is derived from the trusted scope, or from a reference the
        // HOST minted from a row it read itself. The model cannot name a graph,
        // which is what stops a customer graph being read from a run that
        // belongs to a different customer.
        const graphId = graphFor(
          ctx,
          input.scope ?? "customer",
          input.customerRef
        );
        const facts = await ctx.deps.memory.search(
          graphId,
          input.query,
          Math.min(input.limit ?? 10, 50)
        );
        for (const f of facts) recalled.set(f.factId, f);

        // Provenance, registered from what this read RETURNED.
        //
        // This is the line that makes an internal Chat answer cite the CUSTOMER
        // evidence it was built on. Without it the only source descriptor a
        // Chat generation would have is its own input turn — which for Chat
        // carries no message event id at all, so the answer would silently
        // become uncitable while appearing to be grounded. The ids come from
        // the store's own response and are never model-supplied.
        ctx.execution.provenance.record(
          facts.flatMap((f) =>
            f.episodeUuids.map((ref) => ({ kind: "zep_episode" as const, ref }))
          )
        );

        // Episode UUIDs stay host-side: they are the handle cite() resolves,
        // and exposing them would let model code fabricate one.
        return facts.map((f) => ({ factId: f.factId, fact: f.fact }));
      },
    }),

    cite: auditedCapability(ctx, "memory", "cite", {
      effect: "read",
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
            `${unknown.length} of ${seen.size} identifiers were not returned by recall in this execution. Cite only facts you recalled here.`
          );
        }

        const citations = await resolveCitations(ctx.deps.db, wanted);

        // Redundant TODAY, and kept deliberately.
        //
        // `recalled` is execution-local, so every fact reaching this line was
        // already registered by the recall above and the sink's primary key
        // collapses the repeat. What this line buys is that the registration
        // does not depend on that coincidence: `cite` is the stronger claim —
        // the model did not merely receive these facts, it built its answer on
        // them — and if the citation cache ever widens beyond one execution,
        // provenance keeps working rather than quietly going missing.
        ctx.execution.provenance.record(
          wanted.flatMap((f) =>
            f.episodeUuids.map((ref) => ({ kind: "zep_episode" as const, ref }))
          )
        );
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

/**
 * Which Zep graph a recall reads.
 *
 * Note where the string comes from. `resolveCustomerScope` returns either the
 * scope's own slug (set by the composer from the D1 channel policy) or a slug
 * the resolver is holding because THIS execution's `findCustomers` read it out
 * of D1. There is no branch on which a model-supplied string reaches this
 * template — `customer:${modelInput}` does not exist anywhere in the host.
 */
function graphFor(
  ctx: BindingContext,
  scope: "customer" | "org",
  customerRef: string | undefined
): string {
  if (scope === "org") {
    if (customerRef !== undefined) {
      throw new CapabilityError(
        "invalid_input",
        "org memory is not customer-scoped; drop customerRef or use scope 'customer'."
      );
    }
    return "org";
  }
  return `customer:${resolveCustomerScope(ctx, customerRef)}`;
}
