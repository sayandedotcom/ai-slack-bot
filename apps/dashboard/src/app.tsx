import { ConnectPanel } from "./components/connect-panel";
import { CountersPanel } from "./components/counters-panel";
import { Header, SignedOutPage, useIdentity } from "./components/header";
import { RotationStrip } from "./components/rotation-strip";
import { getRoster } from "./lib/api";
import { usePoll } from "./lib/use-poll";

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

  if (identityError) return <SignedOutPage error={identityError} />;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header identity={identity} />
      <main className="mx-auto grid max-w-5xl grid-cols-1 gap-4 p-6 md:grid-cols-2">
        <div className="md:col-span-2">
          <RotationStrip state={roster} />
        </div>
        <ConnectPanel state={roster} identity={identity} />
        <CountersPanel />
        <div
          data-slot="runs-panel"
          className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground md:col-span-2"
        >
          Runs — Phase 15
        </div>
      </main>
    </div>
  );
}
