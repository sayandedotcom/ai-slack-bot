import { Header } from "./components/header";

/**
 * The shell. It owns layout only: the panels below are filled in by the
 * Phase 14 tasks, each one a `Panel` fed by `usePoll`. Nothing here fetches.
 */
export function App() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header />
      <main className="mx-auto grid max-w-5xl grid-cols-1 gap-4 p-6 md:grid-cols-2">
        {/* slot: rotation strip — who is on duty, and who is next */}
        <div data-slot="rotation-panel" className="md:col-span-2" />
        {/* slot: connect panel — Slack and GitHub link state per engineer */}
        <div data-slot="connect-panel" />
        {/* slot: counters panel — seen / triaged / woken / escalated */}
        <div data-slot="counters-panel" />
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
