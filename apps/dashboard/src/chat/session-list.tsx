import { useMemo } from "react";
import type { ReactNode } from "react";

import { Panel, type PanelState } from "../components/panel";
import { usePoll } from "../lib/use-poll";
import { StatusChip, ago } from "../runs/run-list";
import type { RunSummary } from "../runs/api";
import { fetchChatSessions } from "./api";

const POLL_MS = 10_000;

/**
 * Past chat runs, newest first. Mirrors `RunList`'s shape but stays its own
 * component: it polls a different (filtered) view, highlights the open
 * session, and never shows origin badges — everything here is origin "chat".
 */
export function SessionList({
  activeId,
  onSelect,
}: {
  activeId: string | null;
  onSelect: (id: string) => void;
}): ReactNode {
  const polled = usePoll<RunSummary[]>(useMemo(() => () => fetchChatSessions(), []), POLL_MS);

  const state: PanelState<RunSummary[]> =
    polled.kind === "ready" && polled.data.length === 0
      ? { kind: "empty", hint: "Ask about any customer thread — answers cite the real Slack messages." }
      : polled;

  const now = Date.now();

  return (
    <Panel title="Chats" state={state}>
      {(sessions) => (
        <ul className="space-y-2">
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                onClick={() => onSelect(session.id)}
                aria-current={session.id === activeId ? "true" : undefined}
                className={`flex w-full flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                  session.id === activeId ? "border-primary/50 bg-primary/5" : "bg-card"
                }`}
              >
                <div className="flex items-center gap-2">
                  <StatusChip status={session.status} />
                  <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                    {ago(session.updatedAt, now)}
                  </span>
                </div>
                <p className="truncate text-sm">
                  {session.summary ?? <span className="text-muted-foreground">Untitled chat</span>}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
