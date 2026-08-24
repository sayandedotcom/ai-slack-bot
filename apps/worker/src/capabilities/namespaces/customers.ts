/**
 * Where a capability's customer scope comes from, and the asymmetry between the
 * two origins (invariants 35 and 36).
 *
 * SLACK is pinned. The run's customer is whatever the D1 policy for its channel
 * says, decided by the host before model code ran. A Slack-origin execution can
 * neither discover another customer nor name one: supplying `customerRef` at
 * all is refused, not merely ignored. Ignoring it would be worse than refusing
 * — the model would believe it had scoped a search and reason about the answer
 * as if it had.
 *
 * CHAT has no ambient customer. An internal engineer opening a chat has not
 * told us who they are asking about, so scope arrives through host-mediated
 * discovery: `memory.findCustomers` searches the D1 catalog and returns opaque
 * references, and those references are the ONLY thing `recall` and
 * `searchMessages` accept.
 *
 * The single most important line in this file is what it does NOT do: nothing
 * here ever interpolates model input into a slug, a graph id, or a query
 * predicate. `resolve()` is a lookup in a per-execution map whose values were
 * put there by the host after a D1 read — so `customer:${slug}` downstream is
 * always `customer:${something D1 said exists}`, never `customer:${modelInput}`.
 */
import { CapabilityError } from "../../gateways/errors";
import type { BindingContext } from "../registry";

export function resolveCustomerScope(
  ctx: BindingContext,
  customerRef: string | undefined,
): string {
  if (customerRef !== undefined) {
    if (ctx.scope.origin !== "chat") {
      // Refuse loudly. A Slack run's customer is a property of the channel a
      // human put the conversation in; letting model-authored code redirect it
      // is precisely the cross-customer read this design exists to prevent.
      throw new CapabilityError(
        "invalid_input",
        "this conversation's customer is fixed by the channel it is in and cannot be chosen here. Drop customerRef.",
      );
    }
    // A reference, never a slug. Unknown, stale, guessed and cross-execution
    // references all land in the same refusal.
    return ctx.execution.customers.resolve(customerRef);
  }

  if (ctx.scope.customerSlug !== null) return ctx.scope.customerSlug;

  throw new CapabilityError(
    "customer_scope_required",
    ctx.scope.origin === "chat"
      ? "this conversation is not about a particular customer yet. Use memory.findCustomers to look one up, then pass the customerRef it returns."
      : "this run has no customer, so there is no customer scope to search. Ask which customer this concerns.",
  );
}
