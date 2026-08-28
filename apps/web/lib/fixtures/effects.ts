import type { RunEffect } from "../api/effects";

/**
 * Per-run committal-effect ledgers, keyed by the demo run ids in
 * `fixtures/runs.ts`.
 *
 * The `turnId` on every row here is the id of that run's own user message in
 * `fixtures/run-transcript.ts` — `openingTranscript` already stamps its user
 * message `${runId}:1`, and the approval transcript stamps its `a1` — so the
 * chip strip a transcript view renders lines up with the turn it actually
 * happened in, the same way it will against the live ledger.
 */

const now = Date.now();

const PULSEFIT_RUN_ID = "5f3b1c22-9d41-4a7e-8b02-1d6c4f0a91e3";
const LINGUA_RUN_ID = "a1c9e7d4-32b8-4f10-95aa-7c2e5b8d0446";
const MACROSNAP_RUN_ID = "7b2d5a90-6e1f-4c33-a8d7-90f1b3e6c258";

const byRun: Record<string, RunEffect[]> = {
  [PULSEFIT_RUN_ID]: [
    {
      turnId: `${PULSEFIT_RUN_ID}:1`,
      namespace: "supabase",
      method: "read",
      state: "completed",
      safeResult: { rows: 3 },
      safeError: null,
      createdAt: now - 11 * 60_000,
    },
    {
      turnId: `${PULSEFIT_RUN_ID}:1`,
      namespace: "supabase",
      method: "read",
      state: "completed",
      safeResult: { rows: 1 },
      safeError: null,
      createdAt: now - 11 * 60_000 + 400,
    },
    {
      turnId: `${PULSEFIT_RUN_ID}:1`,
      namespace: "betterstack",
      method: "query",
      state: "completed",
      safeResult: { matches: 12 },
      safeError: null,
      createdAt: now - 10 * 60_000,
    },
    {
      turnId: `${PULSEFIT_RUN_ID}:1`,
      namespace: "sandbox",
      method: "exec",
      state: "completed",
      safeResult: { exitCode: 0 },
      safeError: null,
      createdAt: now - 9 * 60_000,
    },
  ],
  [LINGUA_RUN_ID]: [
    {
      turnId: "a1",
      namespace: "memory",
      method: "recall",
      state: "completed",
      safeResult: { hits: 2 },
      safeError: null,
      createdAt: now - 27 * 60_000,
    },
    {
      turnId: "a1",
      namespace: "approval",
      method: "escalate",
      state: "completed",
      safeResult: { approvalId: "apr-8f21c05e" },
      safeError: null,
      createdAt: now - 26 * 60_000,
    },
  ],
  [MACROSNAP_RUN_ID]: [
    {
      turnId: `${MACROSNAP_RUN_ID}:1`,
      namespace: "github",
      method: "openPullRequest",
      state: "completed",
      safeResult: {
        html_url: "https://github.com/Zellify/web2app-rebuild/pull/1287",
      },
      safeError: null,
      createdAt: now - 63 * 60_000,
    },
    {
      turnId: `${MACROSNAP_RUN_ID}:1`,
      namespace: "linear",
      method: "createIssue",
      state: "completed",
      safeResult: { url: "https://linear.app/zellify/issue/ZEL-412" },
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
