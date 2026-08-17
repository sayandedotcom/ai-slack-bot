import { useMemo } from "react";
import type { ReactNode } from "react";

import { Panel, type PanelState } from "../components/panel";
import { usePoll } from "../lib/use-poll";
import { fetchRuns, type RunStatus, type RunSummary } from "./api";

/**
 * The dashboard's index of agent runs: one row per run, newest activity first,
 * polled every five seconds. It owns its own poll rather than taking a
 * `PanelState` prop (the way `SpeakerStrip` does) because it is the only
 * consumer of `/api/runs` and the drawer above it must never restart the list's
 * clock when it opens.
 *
 * A row is deliberately a summary and not a preview: everything that costs a
 * second request — the transcript, the usage total — lives in the drawer.
 */

const POLL_MS = 5_000;

/**
 * Statuses that mean "something is happening right now, and it may be waiting
 * on you". These are the only rows that pulse; a pulse on a finished run would
 * train operators to ignore the one signal that matters.
 */
const LIVE: ReadonlySet<RunStatus> = new Set<RunStatus>(["live", "awaiting_approval"]);

const STATUS_LABEL: Record<RunStatus, string> = {
  live: "live",
  awaiting_approval: "awaiting approval",
  idle: "idle",
  done: "done",
  failed: "failed",
};

const STATUS_CLASS: Record<RunStatus, string> = {
  live: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  awaiting_approval: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  idle: "border-border bg-muted text-muted-foreground",
  done: "border-border bg-muted text-muted-foreground",
  failed: "border-destructive/40 bg-destructive/10 text-destructive",
};

/**
 * Coarse on purpose. The list re-renders on every poll, so a minute-accurate
 * string is as precise as the data underneath it; seconds would flicker and
 * imply a freshness the five-second poll cannot back.
 */
export function ago(thenMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function StatusChip({ status }: { status: RunStatus }): ReactNode {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_CLASS[status]}`}
    >
      {LIVE.has(status) ? (
        // Two layers: a steady dot so the state is readable when the OS is set
        // to reduce motion, plus a ping that draws the eye across the list.
        <span className="relative flex size-1.5" aria-hidden="true">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-70" />
          <span className="relative inline-flex size-1.5 rounded-full bg-current" />
        </span>
      ) : null}
      {STATUS_LABEL[status]}
    </span>
  );
}

export function OriginBadge({ origin }: { origin: string }): ReactNode {
  return (
    <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
      {origin}
    </span>
  );
}

export function ShadowBadge({ label }: { label?: string }): ReactNode {
  return (
    <span
      title="shadow — nothing this run does reaches a customer"
      className="rounded border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[11px] text-violet-600 dark:text-violet-400"
    >
      {label ?? "shadow"}
    </span>
  );
}

function RunRow({ run, now, onSelect }: { run: RunSummary; now: number; onSelect: (id: string) => void }) {
  // The worker joins these for display; a run started from chat has neither.
  const where = run.channelName ?? run.customerSlug;

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(run.id)}
        className="flex w-full flex-col gap-1 rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status={run.status} />
          <OriginBadge origin={run.origin} />
          {run.shadow ? <ShadowBadge /> : null}
          {where === null ? null : (
            <span className="truncate text-xs text-muted-foreground">{where}</span>
          )}
          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
            {ago(run.updatedAt, now)}
          </span>
        </div>
        <p className="truncate text-sm">
          {/* A run can be woken before it has said anything worth summarising;
              saying so beats an empty row that reads as a rendering bug. */}
          {run.summary ?? <span className="text-muted-foreground">No summary yet</span>}
        </p>
      </button>
    </li>
  );
}

export function RunList({ onSelect }: { onSelect: (id: string) => void }): ReactNode {
  const polled = usePoll<RunSummary[]>(useMemo(() => () => fetchRuns(), []), POLL_MS);

  // `Panel` renders `empty` for us but cannot know that an empty array is empty
  // rather than ready — so the emptiness is decided here, once.
  const state: PanelState<RunSummary[]> =
    polled.kind === "ready" && polled.data.length === 0
      ? { kind: "empty", hint: "No runs yet — the agent wakes when a customer thread needs it." }
      : polled;

  const now = Date.now();

  return (
    <Panel title="Runs" state={state}>
      {(runs) => (
        <ul className="space-y-2">
          {/* Arrives sorted by `updatedAt` DESC from the worker. We copy-sort
              anyway: correctness here must not rest on an endpoint's ordering. */}
          {[...runs]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((run) => (
              <RunRow key={run.id} run={run} now={now} onSelect={onSelect} />
            ))}
        </ul>
      )}
    </Panel>
  );
}
