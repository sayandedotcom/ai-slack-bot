import type { ChannelPolicy } from "../db/channels";

/**
 * Which Zep graph a channel's messages belong to. Customer channels get a
 * per-customer graph; internal channels share the org graph. Unknown channels
 * get nothing — fail closed, same rule as posting. See spec §7 / decision D4.
 */
export function graphIdFor(policy: ChannelPolicy): string | null {
  if (!policy.known) return null;
  if (policy.mode === "internal") return "org";
  if (policy.customer_slug !== null) return `customer:${policy.customer_slug}`;
  return null;
}

/** The shared engineering graph. Everything unscoped lands here. */
export const ORG_GRAPH_ID = "org";

/**
 * Which graph a settled GENERATION's episode belongs to.
 *
 * Deliberately different from `graphIdFor` in one way: an unknown scope is not
 * "nothing", it is `org`. A message from an unrecognised channel is not ours to
 * remember, but an agent turn always happened and always has a home — and the
 * safe home is the one with no customer in it. That is what "fails closed"
 * means here: the failure direction is toward LESS customer scoping, never
 * toward a customer graph we are not sure about.
 *
 * WHERE THE SLUG COMES FROM, which is the security property. `policy` is the
 * D1 channel policy for the run's own channel, read by the host from the
 * persisted run descriptor. No argument to this function can originate in model
 * output, a tool result, a customer message, or a capability argument — a
 * malicious string has no route here at all, so there is no `customer:${input}`
 * to sanitize. This preserves the property Task 6 established for the
 * capability layer (invariants 35 and 36).
 */
export function agentGraphIdFor(input: {
  origin: "slack" | "chat";
  policy: ChannelPolicy | null;
}): string {
  // Chat and internal work are org memory: an internal engineer's question has
  // no ambient customer, and host-mediated discovery scopes a READ, never the
  // record of what the agent did.
  if (input.origin !== "slack") return ORG_GRAPH_ID;
  if (input.policy === null || !input.policy.known) return ORG_GRAPH_ID;
  if (input.policy.mode === "internal") return ORG_GRAPH_ID;
  if (input.policy.customer_slug !== null)
    return `customer:${input.policy.customer_slug}`;
  return ORG_GRAPH_ID;
}
