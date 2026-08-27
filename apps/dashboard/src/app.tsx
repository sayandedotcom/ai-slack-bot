import { useCallback, useEffect, useState } from "react";

import { ApprovalsPanel } from "./approvals/approvals-panel";
import { useApprovals } from "./approvals/use-approvals";
import type { DecideAction } from "./approvals/api";
import { ConnectPanel } from "./components/connect-panel";
import { CountersPanel } from "./components/counters-panel";
import { Header, SignedOutPage, useIdentity } from "./components/header";
import { SpeakerStrip } from "./components/speaker-strip";
import { getRoster, type Role } from "./lib/api";
import { usePoll } from "./lib/use-poll";
import { RunList } from "./runs/run-list";
import { RunSession } from "./runs/run-view";
import { RunApprovals } from "./approvals/run-approvals";
import { ChatStarter } from "./chat/chat-page";
import { ShadowPanel } from "./shadow/shadow-panel";

/**
 * Which run the dashboard has selected, kept in `location.hash` rather than
 * React state alone. A run is the thing an operator pastes into Slack and
 * reloads into at 3am, so a selection that evaporates on refresh would make it
 * unshareable. No router library — one hash key is the entire routing need.
 */
function parseHash(hash: string): string | null {
  const selected = /^#run=(.+)$/.exec(hash);
  return selected === null ? null : decodeURIComponent(selected[1] as string);
}

function routeToHash(runId: string | null): string {
  return runId === null ? "" : `#run=${encodeURIComponent(runId)}`;
}

/** The hash is the state; back, forward and a hand-edited hash are all the
 * same event to us. */
function useSelectedRun(): [string | null, (runId: string | null) => void] {
  const [runId, setRunId] = useState<string | null>(() => parseHash(location.hash));

  useEffect(() => {
    const onHashChange = () => setRunId(parseHash(location.hash));
    addEventListener("hashchange", onHashChange);
    return () => removeEventListener("hashchange", onHashChange);
  }, []);

  const select = useCallback((next: string | null) => {
    location.hash = routeToHash(next);
    setRunId(next);
  }, []);

  return [runId, select];
}

/**
 * The shell. It owns two things and no others: the one identity fetch, and
 * the one roster poll.
 *
 * Both are lifted here rather than left in the components that display them.
 * Identity, because a failure to establish it is not a panel-shaped problem —
 * every panel would 401 in exactly the same way, so the whole grid is replaced
 * by one honest page instead of four separately-broken ones. The roster,
 * because the speaker strip and the connect panel read the SAME document; two
 * `usePoll` calls would mean two requests a minute for one answer, and two
 * copies of it that could disagree on screen. Each takes the poll's
 * `PanelState` as a prop and renders it through `Panel`.
 */
export function App() {
  const { identity, error: identityError } = useIdentity();
  const roster = usePoll(getRoster, 60_000);
  const approvals = useApprovals();
  const [selectedRun, selectRun] = useSelectedRun();

  if (identityError) return <SignedOutPage error={identityError} />;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header identity={identity} />
      <main className="mx-auto grid max-w-5xl grid-cols-1 gap-4 p-6 md:grid-cols-2">
        {/* First in the grid, deliberately: a pending escalation is the only
            thing on this page with a human waiting on the other end of it, so
            it is pinned above the fold ahead of the fire-fighters and the counters. */}
        <div data-slot="approvals-panel" className="md:col-span-2">
          <ApprovalsPanel
            state={approvals.state}
            role={identity?.role ?? "viewer"}
            onDecide={approvals.decideCard}
          />
        </div>
        <div className="md:col-span-2">
          <SpeakerStrip state={roster} />
        </div>
        <ConnectPanel state={roster} identity={identity} />
        <CountersPanel />
        {/* One create form, above the list it feeds. A chat run is the same
            object a Slack wake produces, so there is no second session shape
            here — starting one selects it and the run view below takes over. */}
        <div data-slot="chat-panel" className="md:col-span-2 rounded-lg border p-3">
          <ChatStarter onStarted={selectRun} />
        </div>
        <div data-slot="runs-panel" className="md:col-span-2">
          <RunList onSelect={selectRun} />
        </div>
        {/* The selected run, live over its own socket. Keyed by id so switching
            runs tears the old socket down instead of re-pointing it — a
            re-pointed connection would briefly show one run's transcript under
            another run's header. */}
        {selectedRun === null ? null : (
          <section
            data-slot="run-session"
            aria-label="Selected run"
            className="md:col-span-2 h-[32rem] rounded-lg border p-3"
          >
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-medium">Run</h2>
              <button
                type="button"
                onClick={() => selectRun(null)}
                className="text-xs text-muted-foreground underline"
              >
                Close
              </button>
            </div>
            <RunSession
              key={selectedRun}
              runId={selectedRun}
              approvals={
                <RunApprovals
                  runId={selectedRun}
                  state={approvals.state}
                  role={identity?.role ?? "viewer"}
                  onDecide={approvals.decideCard}
                />
              }
            />
          </section>
        )}
        {/* Below the fold, deliberately: this is an eval corpus for
            reviewing after the fact, not something waiting on a human
            the way the approvals queue is. */}
        <div data-slot="shadow-panel" className="md:col-span-2">
          <ShadowPanel />
        </div>
      </main>
    </div>
  );
}
