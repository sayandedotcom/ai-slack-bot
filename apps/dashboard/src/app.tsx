import { useCallback, useEffect, useState } from "react";

import { ApprovalsPanel } from "./approvals/approvals-panel";
import { useApprovals } from "./approvals/use-approvals";
import { ConnectPanel } from "./components/connect-panel";
import { CountersPanel } from "./components/counters-panel";
import { Header, SignedOutPage, useIdentity } from "./components/header";
import { RotationStrip } from "./components/rotation-strip";
import { getRoster } from "./lib/api";
import { usePoll } from "./lib/use-poll";
import { RunDrawer } from "./runs/run-drawer";
import { RunList } from "./runs/run-list";
import { SessionView } from "./runs/session-view";
import { useRunSession } from "./runs/use-run-session";

/**
 * Which run the drawer is showing, kept in `location.hash` rather than React
 * state alone. A run is the thing an operator pastes into Slack and reloads
 * into at 3am; a selection that evaporates on refresh would make the drawer
 * unshareable. No router — one hash key is the entire routing need here.
 */
function useSelectedRun(): [string | null, (id: string | null) => void] {
  const read = () => {
    const match = /^#run=(.+)$/.exec(location.hash);
    return match ? decodeURIComponent(match[1] as string) : null;
  };
  const [runId, setRunId] = useState<string | null>(read);

  useEffect(() => {
    // Back/forward and a hand-edited hash are the same event to us.
    const onHashChange = () => setRunId(read());
    addEventListener("hashchange", onHashChange);
    return () => removeEventListener("hashchange", onHashChange);
  }, []);

  const select = useCallback((id: string | null) => {
    // Writing the hash fires `hashchange`, which sets the state; assigning it
    // here too keeps the drawer instant rather than waiting on the event.
    location.hash = id === null ? "" : `run=${encodeURIComponent(id)}`;
    setRunId(id);
  }, []);

  return [runId, select];
}

/**
 * The drawer's body. It exists as its own component for one reason: hooks.
 * `useRunSession` opens a socket, so it must mount and unmount with the
 * selected run — calling it in `App` would hold a connection open for a run
 * nobody is looking at, and could not be conditional.
 */
function RunSession({ runId, onClose }: { runId: string; onClose: () => void }) {
  const { session, connection, steer } = useRunSession(runId);

  return (
    <RunDrawer runId={runId} onClose={onClose}>
      <SessionView session={session} connection={connection} onSteer={steer} />
    </RunDrawer>
  );
}

/**
 * The shell. It owns two things and no others: the one identity fetch, and
 * the one roster poll.
 *
 * Both are lifted here rather than left in the components that display them.
 * Identity, because a failure to establish it is not a panel-shaped problem —
 * every panel would 401 in exactly the same way, so the whole grid is replaced
 * by one honest page instead of four separately-broken ones. The roster,
 * because the rotation strip and the connect panel read the SAME document; two
 * `usePoll` calls would mean two requests a minute for one answer, and two
 * copies of it that could disagree on screen. Each takes the poll's
 * `PanelState` as a prop and renders it through `Panel`.
 */
export function App() {
  const { identity, error: identityError } = useIdentity();
  const roster = usePoll(getRoster, 60_000);
  const approvals = useApprovals();
  const [selectedRun, selectRun] = useSelectedRun();
  const closeDrawer = useCallback(() => selectRun(null), [selectRun]);

  if (identityError) return <SignedOutPage error={identityError} />;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header identity={identity} />
      <main className="mx-auto grid max-w-5xl grid-cols-1 gap-4 p-6 md:grid-cols-2">
        {/* First in the grid, deliberately: a pending escalation is the only
            thing on this page with a human waiting on the other end of it, so
            it is pinned above the fold ahead of the rotation and the counters. */}
        <div data-slot="approvals-panel" className="md:col-span-2">
          <ApprovalsPanel
            state={approvals.state}
            role={identity?.role ?? "viewer"}
            onDecide={approvals.decideCard}
          />
        </div>
        <div className="md:col-span-2">
          <RotationStrip state={roster} />
        </div>
        <ConnectPanel state={roster} identity={identity} />
        <CountersPanel />
        <div data-slot="runs-panel" className="md:col-span-2">
          <RunList onSelect={selectRun} />
        </div>
      </main>
      {selectedRun === null ? null : (
        <RunSession
          // Keyed by run id so switching runs remounts the session rather than
          // feeding a second run's events into the first one's reducer.
          key={selectedRun}
          runId={selectedRun}
          onClose={closeDrawer}
        />
      )}
    </div>
  );
}
