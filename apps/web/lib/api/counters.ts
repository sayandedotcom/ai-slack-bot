import { demoCounters } from "../fixtures/counters";
import { fixture, getJson, isDemo } from "./client";

export type Counters = {
  counters: {
    seen: number;
    triaged: number;
    woken: number;
    escalated: number;
  };
  since: number;
};

export function getCounters(): Promise<Counters> {
  if (isDemo()) return fixture(demoCounters);
  return getJson<Counters>("/api/counters");
}

export type Funnel = {
  seen: number;
  triaged: number;
  dropped: number;
  woken: number;
  escalated: number;
};

/**
 * `dropped` is the messages cheap triage judged not worth waking the expensive
 * model for. The endpoint does not return it — it is `triaged - woken`, and it
 * is labelled as derived wherever it is shown, because a number nobody counted
 * should not look like one somebody did.
 *
 * The clamp is not defensive noise: `triaged` and `woken` are counted by
 * different consumers over the same window, so a message triaged just before
 * the window opened and woken just after it makes `woken` momentarily larger.
 */
export function deriveFunnel(counters: Counters["counters"]): Funnel {
  return {
    seen: counters.seen,
    triaged: counters.triaged,
    dropped: Math.max(0, counters.triaged - counters.woken),
    woken: counters.woken,
    escalated: counters.escalated,
  };
}
