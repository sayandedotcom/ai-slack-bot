import type { Counters } from "../api/counters";

/**
 * A day's traffic through the cheap half of the pipeline. `triaged - woken` is
 * 131, which is the number the funnel shows as "dropped" — the whole point of
 * the two-model design is that most of what the agent hears costs a fraction
 * of a cent to ignore.
 */
export const demoCounters: Counters = {
  counters: { seen: 148, triaged: 148, woken: 17, escalated: 1 },
  since: Date.now() - 24 * 60 * 60 * 1000,
};
