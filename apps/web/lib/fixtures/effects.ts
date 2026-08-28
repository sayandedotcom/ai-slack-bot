import type { RunEffect } from "../api/effects";

/**
 * Per-run committal-effect ledgers, keyed by the demo run ids in
 * `fixtures/runs.ts`.
 *
 * The `codemode_effects` table (`apps/worker/src/capabilities/effects.ts`)
 * only ever gets a row from `runEffect`, and `runEffect` is only ever called
 * from four namespaces — verified with
 * `grep -rln runEffect apps/worker/src/capabilities/namespaces/`, which
 * returns exactly `files.ts`, `github.ts`, `slack.ts`, `linear.ts`. Every
 * other capability (including `memory` and `approval`, which this file used
 * to fixture here) is either a `read` or an `external_write` that never
 * reaches the ledger, so a production ledger can never contain them. The
 * namespace/method pairs and output shapes below are copied from those four
 * namespace files' own `output` Zod schemas — not guessed — so the "Did"
 * panel and the transcript chip strip show exactly what a real run can.
 *
 * The `turnId` on every row here is the id of that run's own user message in
 * `fixtures/run-transcript.ts` — `openingTranscript` already stamps its user
 * message `${runId}:1`. `LINGUA_RUN_ID` (the awaiting-approval run) has no
 * rows at all: it is paused on the one write it would make, so an empty
 * ledger is the honest state for it, not a gap — it is what drives the
 * "Nothing committal yet" empty-state copy in `use-dashboard-data.ts`.
 */

const now = Date.now();

const PULSEFIT_RUN_ID = "5f3b1c22-9d41-4a7e-8b02-1d6c4f0a91e3";
const MACROSNAP_RUN_ID = "7b2d5a90-6e1f-4c33-a8d7-90f1b3e6c258";

const byRun: Record<string, RunEffect[]> = {
  [PULSEFIT_RUN_ID]: [
    // slack.reply's output is `{ ts, permalink }` — apps/worker's own
    // namespaces/slack.ts. A live run that has already told the customer it
    // is working the problem is the realistic case for "live".
    {
      turnId: `${PULSEFIT_RUN_ID}:1`,
      namespace: "slack",
      method: "reply",
      state: "completed",
      safeResult: {
        ts: "1787734808.000200",
        permalink:
          "https://zellify-workspace.slack.com/archives/C0PULSEFIT/p1787734808000200",
      },
      safeError: null,
      createdAt: now - 9 * 60_000,
    },
  ],
  [MACROSNAP_RUN_ID]: [
    // linear.createIssue's output is `{ id, identifier, url }` —
    // namespaces/linear.ts.
    {
      turnId: `${MACROSNAP_RUN_ID}:1`,
      namespace: "linear",
      method: "createIssue",
      state: "completed",
      safeResult: {
        id: "a2f9e6d1-4c8b-4e2a-9f0d-6b1c8a3e5f70",
        identifier: "FIR-118",
        url: "https://linear.app/zellify/issue/FIR-118",
      },
      safeError: null,
      createdAt: now - 63 * 60_000,
    },
    // github.openPR's output is `{ number, url, headRef, author, updated }` —
    // namespaces/github.ts. Kept so the run that shipped a fix still shows a
    // PR link in the transcript and the inspector.
    {
      turnId: `${MACROSNAP_RUN_ID}:1`,
      namespace: "github",
      method: "openPR",
      state: "completed",
      safeResult: {
        number: 1287,
        url: "https://github.com/Zellify/web2app-rebuild/pull/1287",
        headRef: "feat/copy-funnel-id-button",
        author: "sayandeten",
        updated: false,
      },
      safeError: null,
      createdAt: now - 62 * 60_000,
    },
  ],
};

/** The effect ledger for one run, newest-first — every other run gets `[]`. */
export function demoEffectsFor(runId: string): RunEffect[] {
  const rows = byRun[runId] ?? [];
  return [...rows].sort((a, b) => b.createdAt - a.createdAt);
}
