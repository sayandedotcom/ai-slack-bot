import type { ReactNode } from "react";

import { getCounters } from "../lib/api";
import type { Counters } from "../lib/api";
import { usePoll } from "../lib/use-poll";
import { Panel } from "./panel";
import type { PanelState } from "./panel";

/**
 * The agent's last 24 hours in four numbers. All-zero is not a state worth four
 * tiles of zeroes — it is the good outcome, so it is folded into `empty` and
 * said in one line. Everything else stays a plain read of the counters.
 */

const TILES: { key: keyof Counters["counters"]; label: string }[] = [
  { key: "seen", label: "seen" },
  { key: "triaged", label: "triaged" },
  { key: "woken", label: "woken" },
  { key: "escalated", label: "escalated" },
];

function Tile({ value, label }: { value: number; label: string }): ReactNode {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

export function CountersPanel() {
  const state = usePoll(getCounters, 10_000);

  const view: PanelState<Counters> =
    state.kind === "ready" &&
    TILES.every(({ key }) => state.data.counters[key] === 0)
      ? {
          kind: "empty",
          hint: "Quiet — nothing needed the agent in the last 24h.",
        }
      : state;

  return (
    <Panel title="Counters" state={view}>
      {({ counters, since }) => (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {TILES.map(({ key, label }) => (
              <Tile key={key} value={counters[key]} label={label} />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            last 24h — since {new Date(since).toLocaleString()}
          </p>
        </div>
      )}
    </Panel>
  );
}
