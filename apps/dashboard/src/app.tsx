import { useCallback, useEffect, useState } from "react";

import { ApprovalsPanel } from "./approvals/approvals-panel";
import { useApprovals } from "./approvals/use-approvals";
import { ChatPage } from "./chat/chat-page";
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
 * Which page is showing, and which run the dashboard drawer or the chat page
 * has open, kept in `location.hash` rather than React state alone. A run is
 * the thing an operator pastes into Slack and reloads into at 3am; a
 * selection that evaporates on refresh would make the drawer unshareable. No
 * router library — one hash key is the entire routing need here.
 */
type Route =
  | { page: "dashboard"; runId: string | null }
  | { page: "chat"; runId: string | null };

function parseHash(hash: string): Route {
  const chat = /^#chat(?:\/run=(.+))?$/.exec(hash);
  if (chat !== null) {
    const chatRunId = chat[1];
    return { page: "chat", runId: chatRunId === undefined ? null : decodeURIComponent(chatRunId) };
  }
  const drawer = /^#run=(.+)$/.exec(hash);
  if (drawer !== null) {
    const drawerRunId = drawer[1] as string;
    return { page: "dashboard", runId: decodeURIComponent(drawerRunId) };
  }
  return { page: "dashboard", runId: null };
}

function routeToHash(route: Route): string {
  if (route.page === "chat") {
    return route.runId === null ? "#chat" : `#chat/run=${encodeURIComponent(route.runId)}`;
  }
  return route.runId === null ? "" : `#run=${encodeURIComponent(route.runId)}`;
}

/** Same discipline as the old `useSelectedRun`: the hash is the state; back,
 * forward, and a hand-edited hash are all the same event to us. */
function useHashRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(location.hash));
    addEventListener("hashchange", onHashChange);
    return () => removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    location.hash = routeToHash(next);
    setRoute(next);
  }, []);

  return [route, navigate];
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
  const [route, navigate] = useHashRoute();
  const selectedRun = route.page === "dashboard" ? route.runId : null;
  const selectRun = useCallback(
    (id: string | null) => navigate({ page: "dashboard", runId: id }),
    [navigate],
  );
  const closeDrawer = useCallback(() => selectRun(null), [selectRun]);

  if (identityError) return <SignedOutPage error={identityError} />;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header identity={identity} page={route.page} />
      {route.page === "chat" ? (
        <ChatPage
          runId={route.runId}
          onSelectRun={(id) => navigate({ page: "chat", runId: id })}
        />
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
