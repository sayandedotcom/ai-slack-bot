import { demoCounters } from "../fixtures/counters";
import { fixture, getJson, isDemo } from "./client";

export type CountersWindow = "24h" | "7d";

/** Exactly what `GET /api/counters` returns — `dropped` is computed server-side now. */
export type Counters = {
  counters: {
    heard: number;
    ingested: number;
    triaged: number;
    woken: number;
    dropped: number;
    escalated: number;
  };
  since: number;
  window: CountersWindow;
};

export function getCounters(window: CountersWindow): Promise<Counters> {
  if (isDemo()) return fixture({ ...demoCounters, window });
  return getJson<Counters>(`/api/counters?window=${window}`);
}

export type FunnelStage = {
  key: "heard" | "triaged" | "woken" | "escalated";
  label: string;
  value: number;
  /** value / heard, clamped to [0, 1]; 0 on a quiet window. */
  ratio: number;
  /** The one stage that costs a person's attention. */
  accent: boolean;
};

export function funnelStages(c: Counters["counters"]): FunnelStage[] {
  const scale = c.heard > 0 ? c.heard : null;
  const ratio = (v: number) =>
    scale === null ? 0 : Math.min(1, Math.max(0, v / scale));
  return [
    {
      key: "heard",
      label: "heard",
      value: c.heard,
      ratio: ratio(c.heard),
      accent: false,
    },
    {
      key: "triaged",
      label: "triaged",
      value: c.triaged,
      ratio: ratio(c.triaged),
      accent: false,
    },
    {
      key: "woken",
      label: "woke the agent",
      value: c.woken,
      ratio: ratio(c.woken),
      accent: false,
    },
    {
      key: "escalated",
      label: "escalated",
      value: c.escalated,
      ratio: ratio(c.escalated),
      accent: true,
    },
  ];
}

export function isQuiet(c: Counters["counters"]): boolean {
  return c.heard === 0;
}
