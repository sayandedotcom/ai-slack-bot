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
