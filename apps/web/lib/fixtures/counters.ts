import type { Counters } from "../api/counters";

/**
 * A day's traffic through the cheap half of the pipeline. `dropped` is
 * counted server-side now — the whole point of the two-model design is that
 * most of what the agent hears costs a fraction of a cent to ignore.
 */
export const demoCounters: Counters = {
  counters: {
    heard: 148,
    ingested: 140,
    triaged: 140,
    woken: 17,
    dropped: 123,
    escalated: 1,
  },
  since: Date.now() - 24 * 60 * 60 * 1000,
  window: "24h",
};
