# Phase 16 — Approval Card — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One click, where the engineer already was: the pending draft pinned above the fold, Approve / inline-Edit / Reject-with-reason, honest under races and withdrawals.

**Architecture:** A dashboard panel over Phase 11's three approval routes, built entirely from Phase 14's primitives (`Panel`, `usePoll`, `api.ts`). State lives in one `useApprovals` hook: a 3-second poll of the open list, optimistic decisions rolled back off the `409 already_decided` contract, and vanish-reconciliation (a card that disappears without a local decision gets one detail fetch and a transient explanation — never a silent disappearance).

**Tech Stack:** React 19, `@workspace/ui`, Phase 14's `apps/dashboard` toolchain. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-10-firefighter-agent-design.md` §5.3, §10. Roadmap entry: `00-roadmap.md` Phase 16.

## Global Constraints

All of `00-roadmap.md` "Global Constraints" apply. The ones that bite here:

- **Loading, empty and error states** are graded deliverables; the empty state must read as reassurance.
- **Reject requires a reason** — it is Phase 21 training data, enforced in the UI before the request and by the API's 422 behind it.
- **One origin, relative paths, no tokens in the bundle.**
- **Commit after every task.** Conventional prefixes.

## Depends on

Phase 11 (the API and its `409 already_decided` contract) and Phase 14 (`apps/dashboard`, `Panel`, `usePoll`, `api.ts`, the grid slot, `Identity` in the header). Execute after both are merged. Phase 15 is NOT a dependency — see the design change below.

**Design change vs. the old roadmap sketch:** live withdrawal handling used the run WebSocket. This plan uses **poll + reconcile** instead, because the dashboard has no WebSocket client until Phase 15 and the card must not wait for it. The poll already exists (the open list), so "vanished under the cursor" is detectable for free; one `GET /api/approvals/:id` explains it. Phase 15/22 may upgrade the transport to push; the reconciliation logic survives that unchanged.

## Outcome

- An escalation appears on the dashboard within one poll interval (≤3 s), pinned above the fold: draft, why, target channel, thread timestamp, age.
- Approve is one click. Edit is inline (textarea prefilled with the draft), not a modal. Reject demands a reason before the button enables.
- A decision renders instantly (optimistic), confirms on 200, and on `409` rolls back to show the winning decision with who made it.
- A card withdrawn by the agent vanishes **with a transient explanation**, never silently.
- Viewers see everything and can decide nothing (buttons disabled with the reason).

## What this phase deliberately does not do

- **No WebSocket.** Poll + reconcile (above).
- **No decision history page.** Open cards plus a transient just-resolved note; history is a later phase if ever.
- **No delivery-state babysitting UI.** The just-resolved note names the decision; `blocked`/`in_doubt` delivery detail stays an API/Phase 22 concern.
- **No component-test infrastructure** — same speed call as Phase 14: the only vitest file is the API layer's; components are verified in the one visual pass.

## Non-negotiable invariants

1. **The optimistic layer never invents state.** Only three sources render: the poll's rows, a 200's returned decision, a 409's returned winner. On any other failure the card returns to `pending` with the error shown.
2. **A decision in flight locks the card's actions** — no double-submit, no editing a draft mid-approve.
3. **Rollback is the 409 contract:** render `already_decided` using the response body's winning decision, not a refetch race.
4. **Every fetch goes through Phase 14's `api.ts`** — no raw `fetch` in components (Phase 14 invariant 2 holds here).
5. **Reject with an empty reason is unsendable in the UI** and would be a 422 anyway — both layers hold.

## Public contracts

Consumes (Phase 11, verbatim):

- `GET /api/approvals?state=open` → `{ approvals: OpenApproval[] }` — id, runId, draft, why, channel/thread snapshot, createdAt. **Verify the exact JSON key names against `src/api/approvals.ts` in Task 1 Step 1 and pin them in the types — do not guess.**
- `GET /api/approvals/:id` → card + `decision`/`delivery`/`decidedBy`/`editedText`/`rejectReason`.
- `PATCH /api/approvals/:id` body `{action:"approve"} | {action:"edit", text} | {action:"reject", reason}` → 200 `{decision, delivery, ...}` · `409 {decision, decidedBy}` (winner) · `422` · `404` · `401/403`.

Produces:

```ts
// apps/dashboard/src/approvals/api.ts
export type OpenApproval = { id: string; runId: string; draft: string; why: string;
  channelId: string; threadTs: string; createdAt: number };
export type Decision = "pending" | "approved" | "edited" | "rejected" | "withdrawn";
export type ApprovalDetail = OpenApproval & { decision: Decision; decidedBy: string | null;
  editedText: string | null; rejectReason: string | null; delivery: string };
export type DecideAction = { action: "approve" } | { action: "edit"; text: string } | { action: "reject"; reason: string };
export type DecideResult =
  | { result: "decided"; decision: Decision }
  | { result: "already_decided"; decision: Decision; decidedBy: string | null }  // the 409 body
  | { result: "error"; error: ApiError };
export async function fetchOpenApprovals(): Promise<OpenApproval[]>;
export async function fetchApproval(id: string): Promise<ApprovalDetail>;
export async function decide(id: string, action: DecideAction): Promise<DecideResult>;

// apps/dashboard/src/approvals/use-approvals.ts
export type CardState =
  | { kind: "open"; card: OpenApproval }
  | { kind: "deciding"; card: OpenApproval; action: DecideAction }
  | { kind: "resolved"; card: OpenApproval; decision: Decision; decidedBy: string | null; mine: boolean };
export function useApprovals(): { state: PanelState<CardState[]>; decideCard: (id: string, action: DecideAction) => void };
```

Phase 22 consumes: `CardState` stays the one state vocabulary for the sweep.

## File structure

- Create: `apps/dashboard/src/approvals/api.ts`, `apps/dashboard/src/approvals/use-approvals.ts`, `apps/dashboard/src/approvals/approval-card.tsx`, `apps/dashboard/src/approvals/approvals-panel.tsx`, `apps/dashboard/test/approvals-api.test.ts`
- Modify: `apps/dashboard/src/app.tsx` (mount the panel first in the grid — above the fold — passing the header's `Identity` role down)

## Execution speed rules — READ BEFORE DISPATCHING ANY TASK

Same regime as Phase 14; overrides per-step commands wherever they conflict.

1. **The gates are `pnpm --filter @workspace/dashboard build` and typecheck — not a test suite.** The one vitest file runs by exact path: `cd apps/dashboard && pnpm exec vitest run test/approvals-api.test.ts`.
2. **One typecheck per task**, at the end.
3. **One visual pass, in Task 4** — do not keep `pnpm dev` running between tasks.
4. **Dispatch = the task's own text + Public contracts + these rules**, plus read access to `apps/dashboard/src/lib` and `src/components/panel.tsx` (Phase 14's primitives) and — Task 1 only — `apps/worker/src/api/approvals.ts` to pin the real JSON keys.
5. **Review depth:** deep for Task 2 (the optimistic/409/reconcile machine — the phase's whole risk); light for 1 and 3; medium for 4.
6. **No new dependencies.**

### Parallel wave schedule

| Wave | Tasks (concurrent) | Why safe |
|---|---|---|
| A | **1** | API layer — both later tasks consume its types |
| B | **2** ∥ **3** | 2 owns the hook (state machine); 3 owns the two components rendering against `CardState` — disjoint files |
| C | **4** | mount, visual pass, gate |

## Task order

### Task 1 — Approvals API layer

**Files:** create `src/approvals/api.ts`, `test/approvals-api.test.ts`.

- [ ] **Step 1: Pin the contract.** Read `apps/worker/src/api/approvals.ts` and copy the exact response key names into the types above (correcting them if the worker says otherwise — the worker is the authority).
- [ ] **Step 2: Failing tests** (node env, stubbed fetch): 200 list parses; PATCH 200 → `decided`; **409 → `already_decided` with the body's winner** (this is the one test that guards the phase's contract); 422 → `error` with `ApiError`; 401/403 map to Phase 14's `unauthorized`/`forbidden` kinds; no response body text ever appears in an error message.
- [ ] **Step 3: Implement** on top of `api.ts`'s `getJson` plus one small `patchJson` added HERE (in `src/approvals/api.ts`, not by widening `lib/api.ts` — Phase 15 can lift it later if a second writer appears).
- [ ] **Step 4: Run the test by exact path + typecheck; verify PASS.**
- [ ] **Step 5: Commit:** `feat(dashboard): typed approvals API with the 409 winner contract`

### Task 2 — The `useApprovals` state machine

**Files:** create `src/approvals/use-approvals.ts`.

- [ ] **Step 1: Implement** (no component yet; typecheck is the step's gate):
  - Poll `fetchOpenApprovals` every 3 s via `usePoll`, keeping last-good data (Phase 14 behavior).
  - Merge poll rows with a local `Map<string, CardState>`: a polled id not in the map → `open`; an id in `deciding`/`resolved` is NOT overwritten by the poll (the local decision outranks a stale list).
  - `decideCard`: set `deciding`, call `decide`; 200 → `resolved` with `mine: true`; 409 → `resolved` with the winner and `mine: false`; error → back to `open` and surface the error on the card.
  - **Vanish reconciliation:** an id that was `open` last tick and absent from this poll with no local decision → one `fetchApproval(id)` → `resolved` with that decision (`withdrawn` renders as "the agent withdrew this"); the detail fetch failing → `resolved` with decision `withdrawn`-unknown copy ("resolved elsewhere").
  - `resolved` cards expire from the map after 15 s (one `setTimeout` per resolution, cleaned up on unmount) — the transient note, then gone.
- [ ] **Step 2: Typecheck; commit:** `feat(dashboard): approval card state machine — optimistic, 409-honest, never a silent vanish`

### Task 3 — Card and panel components

**Files:** create `src/approvals/approval-card.tsx`, `src/approvals/approvals-panel.tsx`.

- [ ] **Step 1: `ApprovalCard`.** Renders one `CardState`. `open`: why (prominent), draft (block-quoted, scrollable past 12 lines), `#channel` + thread ts + relative age; actions row — **Approve** (primary), **Edit** (swaps the quote for a textarea prefilled with the draft; Send/Cancel), **Reject** (reveals a required reason input; button disabled while empty). Viewer role: all actions disabled with the caption "fire-fighters decide". `deciding`: actions locked, subtle progress. `resolved`: one-line banner — mine: "You approved/edited/rejected this"; not mine: "{decidedBy} approved this before you" (the 409 render); withdrawn: "The agent withdrew this — the thread moved on".
- [ ] **Step 2: `ApprovalsPanel`.** `Panel` wrapper titled "Waiting on you"; ready with zero cards → empty hint "Nothing needs a decision. The agent escalates only committal replies."; ready with cards → newest first.
- [ ] **Step 3: Typecheck; commit:** `feat(dashboard): approval card with inline edit and required reject reason`

### Task 4 — Mount, visual pass, gate

**Files:** modify `src/app.tsx`.

- [ ] **Step 1: Mount first in the grid** (above the counters/rotation panels — "pinned above the fold"), passing the identity role down.
- [ ] **Step 2: The one visual pass.** `wrangler dev` + `pnpm dev` (Phase 14 Task 7's setup). Seed one open approval (insert a row via `pnpm exec wrangler d1 execute firefighter --local --command "INSERT INTO approvals (...)"` with plausible values — record the exact command in `phase-16-notes.md`). Verify: card renders; approve → optimistic → resolved; a second seeded card decided directly in D1 mid-view → vanishes with the explanation; reject blocked until a reason is typed. Kill both processes.
- [ ] **Step 3: Gate:** `pnpm --filter @workspace/dashboard build` + `cd apps/dashboard && pnpm exec vitest run test/approvals-api.test.ts`.
- [ ] **Step 4: Commit:** `feat(dashboard): approvals panel pinned above the fold`

## Test matrix

| Row | Proven by |
|---|---|
| 409 renders the winner, not a refetch race | Task 1 test + Task 2 machine |
| Optimistic never invents state (error → back to open) | Task 2 + Task 4 visual |
| Vanish is never silent | Task 2 reconciliation + Task 4 seeded-decide check |
| Reject reason enforced client-side | Task 3 + Task 4 visual |
| Viewer cannot decide | Task 3 (disabled) + Phase 11's 403 behind it |
| Empty state reassures | Task 3 |

## Exit criteria

An escalation appears within one 3-second poll, pinned above the fold. Approve/edit/reject update optimistically and honestly under the Phase 11 fake-sender contract (real sending is Phase 13's exit, not this one). A rejection's reason reaches memory via the existing Phase 11 path. A withdrawn card explains itself. Build + typecheck + the API test green; visual pass recorded in `phase-16-notes.md`.

## Downstream handoff

- **Phase 15:** if its WebSocket client lands, `useApprovals` can subscribe instead of poll — the `CardState` machine and reconciliation are transport-agnostic by construction.
- **Phase 22:** the state sweep audits `CardState` renders; the transient-resolution copy is the polish surface.
- **Phase 21:** shadow-run cards flow through unchanged (delivery `suppressed` server-side; the UI needs no shadow special-casing).
