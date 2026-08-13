# Phase 15 — Run List + Live Run Drawer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Watch and steer any run: a live-sorted run list, and a drawer that streams the session over WebSocket with backlog-then-live replay, collapsible tool calls, and a steering composer — the same session component the Phase 17 chat page will reuse.

**Architecture:** Dashboard-only. A pure event reducer turns Phase 10's `RunEvent` stream into a `SessionView` model; a reconnecting WebSocket client feeds it (`sync` → `event` frames, resume via `?since=cursor`); `SessionView` renders it. Steering goes over the socket with an `ack`, falling back to `POST /api/runs/:id/turns` on silence — both share `steer:{requestId}`, so the retry cannot double-steer (the worker guarantees it).

**Tech Stack:** React 19, native `WebSocket`, Phase 14's `apps/dashboard` toolchain (`Panel`, `usePoll`, `api.ts`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-10-firefighter-agent-design.md` §9, §10. Roadmap entry: `00-roadmap.md` Phase 15.

## Global Constraints

All of `00-roadmap.md` "Global Constraints" apply. The ones that bite here:

- **Loading, empty, error AND disconnected states** — the disconnect banner is named in the roadmap; a socket silently showing stale turns fails the phase.
- **One origin, relative paths** — the socket URL is `wss://` + `location.host` + `/ws/run/:id`, derived, never configured.
- **No tokens, no internal keys in the bundle.** The client renders `publicRun`/`publicDriver` shapes verbatim and does arithmetic on none of them (`costUsd` is a decimal STRING — render it, never compute).
- **Commit after every task.** Conventional prefixes.

## Depends on

Phase 10 (merged: `src/run/protocol.ts` message shapes, `src/api/runs.ts` routes, `/ws/run/:id`) and Phase 14 (`apps/dashboard`, `Panel`, `usePoll`, `api.ts`, the "Runs — Phase 15" grid slot). Execute after 14 is merged. **Zero worker-side files change in this phase** — the old roadmap sketch's "`src/api/runs.ts` (modify)" is stale; Phase 10 already shipped everything the drawer needs, including the HTTP steer fallback.

## Outcome

- Run list panel: status chip, origin badge (`slack`/`chat`), shadow badge, one-line summary, relative activity time, a pulsing live indicator on `live`/`awaiting_approval`, sorted by `updatedAt`, polling every 5 s.
- Click a run → drawer over the dashboard (not a third page): the full session replays instantly (snapshot), then streams live (socket), with no gap and no duplicate.
- Tool calls render collapsed (name + state + duration), expandable to arguments and results.
- Type into the composer on a live run → the steer turn appears from the `ack`/event stream, and the next step changes course.
- Socket loss → visible banner + backoff reconnect resuming from the last cursor; steering transparently falls back to HTTP.

## What this phase deliberately does not do

- **No worker changes.** The protocol is consumed, not extended.
- **No virtualized lists.** Runs are dozens, not thousands; a cap (`limit=50`) and honest scrolling beat a windowing dependency.
- **No usage/cost panel in the drawer** beyond one line (`GET /api/runs/:id/usage` total) — the full cost story is Phase 23's reconciliation.
- **No component-test infra** — same Phase 14/16 speed call. The reducer (where the correctness lives) is pure and node-tested hard; components get the one visual pass.

## Non-negotiable invariants

1. **The reducer is pure and exhaustive.** `(SessionState, RunServerMessage) → SessionState`, no I/O, a `switch` over every `RunEvent` type and every `AssistantUpdateState` — `started`, `streaming`, `completed`, `superseded`, `aborted`, `failed` — with `superseded` dropping the draft buffer silently (it is not an error; the protocol comment says so).
2. **Dedupe by `seq`.** Events at or below the applied cursor are dropped. Reconnect resumes with `?since=<cursor>`; replayed frames must be idempotent by construction, not by luck.
3. **Steer ids are `steer:{requestId}`** with a fresh `crypto.randomUUID()` per composer submit; the HTTP fallback reuses the SAME requestId — that shared id is the whole double-steer defence.
4. **Server-owned fields never leave the client.** The composer sends `{type:"steer", requestId, content}` and nothing else (`parseClientMessage` rejects `role`/`source`/`id`/`seq`/`createdAt`/`metadata` loudly — never trigger it).
5. **Reconnect backoff is bounded and visible:** 1s → 2s → 4s → 8s → capped 15s, banner showing "reconnecting"; a clean close on unmount does not reconnect.
6. **Every HTTP fetch goes through Phase 14's `api.ts`** (its invariant 2). The socket is the one non-`api.ts` transport, isolated in `socket.ts`.

## Public contracts

Consumes (Phase 10, verbatim — import nothing from the worker package; mirror the types and pin them against `src/run/protocol.ts` in Task 1):

- `GET /api/runs?status=&limit=` → `{ runs: RunSummary[] }` — id, origin, status, shadow, summary, channelId, threadTs, createdAt, updatedAt.
- `GET /api/runs/:id?since=` → `{ run, driver, model, events, cursor, complete }`.
- `POST /api/runs/:id/turns` body `{requestId, content}` → `{ seq, appended }`.
- WS `/ws/run/:id?since=` → `RunServerMessage` = `sync {events, cursor, complete, status}` | `event {event}` | `ack {requestId, seq}` | `error {code, message, requestId?}`. Client sends `RunClientMessage` = `steer {requestId, content}` only.

Produces (Phase 17 consumes all four):

```ts
// apps/dashboard/src/runs/session-reducer.ts  (pure)
export type ToolCallView = { callId: string; name: string; state: "running"|"completed"|"failed";
  input?: unknown; output?: unknown; error?: string; startedAt: number; endedAt: number | null };
export type SessionItem =
  | { kind: "turn"; turn: { id: string; role: string; source: string; content: string; createdAt: number } }
  | { kind: "tool_call"; call: ToolCallView }
  | { kind: "draft"; generationId: string; text: string };  // at most one, always last
export type SessionState = { items: SessionItem[]; status: RunStatus | null; cursor: number;
  pendingSteers: Map<string, string>; lastError: { code: string; message: string } | null };
export function initialSession(): SessionState;
export function reduceSession(state: SessionState, message: RunServerMessage): SessionState;

// apps/dashboard/src/runs/socket.ts
export type Connection = "connecting" | "open" | "reconnecting" | "closed";
export function openRunSocket(runId: string, opts: {
  since: () => number;                       // read the cursor at each (re)connect
  onMessage: (m: RunServerMessage) => void;
  onConnection: (c: Connection) => void;
}): { send: (m: RunClientMessage) => boolean; close: () => void };  // send=false when not open

// apps/dashboard/src/runs/use-run-session.ts
export function useRunSession(runId: string): {
  session: SessionState; connection: Connection;
  steer: (content: string) => void;          // socket-first, HTTP fallback after 3 s unacked
};

// apps/dashboard/src/runs/session-view.tsx  — THE component Phase 17 reuses
export function SessionView(props: { session: SessionState; connection: Connection;
  onSteer: (content: string) => void; composerPlaceholder?: string }): ReactNode;

// apps/dashboard/src/runs/api.ts
export type RunSummary = { id: string; origin: string; status: RunStatus; shadow: boolean;
  summary: string | null; channelId: string | null; threadTs: string | null;
  createdAt: number; updatedAt: number };
export async function fetchRuns(limit?: number): Promise<RunSummary[]>;
export async function fetchRunSnapshot(id: string, since?: number): Promise<{ run: RunSummary; events: RunServerMessage & {type:"sync"} }>;
export async function postSteer(id: string, requestId: string, content: string): Promise<{ seq: number; appended: boolean }>;
export async function fetchRunUsageTotal(id: string): Promise<string>;  // totalCostUsd, a decimal string
```

## File structure

- Create: `apps/dashboard/src/runs/api.ts`, `src/runs/session-reducer.ts`, `src/runs/socket.ts`, `src/runs/use-run-session.ts`, `src/runs/session-view.tsx`, `src/runs/run-list.tsx`, `src/runs/run-drawer.tsx`, `test/session-reducer.test.ts`, `test/runs-api.test.ts`
- Modify: `apps/dashboard/src/app.tsx` (replace the "Runs — Phase 15" placeholder slot; drawer selection via `location.hash` `#run=<id>` so a refresh reopens the same run)

## Execution speed rules — READ BEFORE DISPATCHING ANY TASK

Phase 14's regime; overrides per-step commands wherever they conflict.

1. **Gates are `pnpm --filter @workspace/dashboard build` and typecheck — not a suite.** The two vitest files run by exact path: `cd apps/dashboard && pnpm exec vitest run test/session-reducer.test.ts` (likewise `test/runs-api.test.ts`).
2. **One typecheck per task**, at the end.
3. **One visual pass, in Task 6.** No `pnpm dev` between tasks.
4. **Dispatch = the task's own text + Public contracts + these rules**, plus read access to `apps/dashboard/src/lib`, `src/components/panel.tsx`, and — Task 1/2 only — `apps/worker/src/run/protocol.ts` and `apps/worker/src/api/runs.ts` to pin shapes. Subagents must not re-explore beyond that.
5. **Review depth:** deep for Tasks 2 and 3 (the reducer and the reconnect/steer machinery are the phase's entire risk); light for 1, 4, 5; medium for 6.
6. **No new dependencies.** Native WebSocket, no state library — the reducer IS the state library.

### Parallel wave schedule

| Wave | Tasks (concurrent) | Why safe |
|---|---|---|
| A | **1** ∥ **2** | HTTP layer vs pure reducer — disjoint files, both pin against worker source directly |
| B | **3** ∥ **4** | socket client (transport, no rendering) vs SessionView (renders `SessionState`, no transport) |
| C | **5** | list + drawer chrome, hosts 4 |
| D | **6** | wiring, visual pass, gate |

## Task order

### Task 1 — Runs HTTP layer

**Files:** create `src/runs/api.ts`, `test/runs-api.test.ts`.

- [ ] **Step 1: Pin shapes.** Read `apps/worker/src/api/runs.ts` (`publicRun`, the snapshot route's response keys, the turns route) and copy exact key names into the types.
- [ ] **Step 2: Failing tests** (node env, stubbed fetch): list parses; snapshot returns events+cursor; `postSteer` sends `{requestId, content}` and nothing else (assert the body's exact key set); 404 → `ApiError`; `fetchRunUsageTotal` returns the string untouched (assert no `Number()` coercion by feeding `"0.5081"` and expecting identity).
- [ ] **Step 3: Implement** over `getJson` + a local `postJson` (same pattern Phase 16 used — lift into `lib/api.ts` ONLY if 16 already landed its `patchJson` there; otherwise keep local and note it).
- [ ] **Step 4: Run by exact path + typecheck; PASS. Commit:** `feat(dashboard): typed runs API layer`

### Task 2 — The session reducer

**Files:** create `src/runs/session-reducer.ts`, `test/session-reducer.test.ts`. This is the phase's real work — test it like it matters.

- [ ] **Step 1: Failing tests.** Feed scripted `RunServerMessage` sequences, assert `SessionState`: `sync` seeds items and cursor; a live `event` appends; **an event with `seq <= cursor` is dropped** (replay a frame, assert identical state); turn/tool_call/status each render to the right item (tool calls keyed by `callId`, a `completed` update merging into the `running` entry, not appending a second); assistant lifecycle — `started` opens a draft, `streaming` deltas concatenate, `completed` converts the draft to nothing (the final turn arrives as its own `turn` event — assert the draft clears and no synthetic turn is invented), `superseded` clears the draft with NO error, `failed` clears it and sets `lastError`; `ack` deletes the matching `pendingSteers` entry; out-of-order protection — a `sync` arriving after events (reconnect) replaces items wholesale and never duplicates; status events update `status` and append a status item.
- [ ] **Step 2: Run, verify FAIL** (`cd apps/dashboard && pnpm exec vitest run test/session-reducer.test.ts`).
- [ ] **Step 3: Implement.** Immutable updates, one `switch`, no `any`. Mirror the protocol types locally (`src/runs/protocol-types.ts` inline in the reducer file is fine) with a comment naming `apps/worker/src/run/protocol.ts` as the authority.
- [ ] **Step 4: Run + typecheck; PASS. Commit:** `feat(dashboard): pure session reducer over the run event protocol`

### Task 3 — Socket client + the session hook

**Files:** create `src/runs/socket.ts`, `src/runs/use-run-session.ts`.

- [ ] **Step 1: Implement `openRunSocket`.** URL `(location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/ws/run/" + id + "?since=" + opts.since()`; parse frames as `RunServerMessage` (a malformed frame → `onMessage` an `error` message, never a throw); backoff per invariant 5 with `onConnection` transitions; `close()` sets a flag so the close handler does not schedule a reconnect.
- [ ] **Step 2: Implement `useRunSession`.** Fetch `fetchRunSnapshot` first (instant paint), reduce its sync; open the socket with `since` reading the current cursor; `steer(content)`: uuid requestId, optimistic `pendingSteers` entry, socket `send`; if `send` returned false OR no `ack` within 3 s → `postSteer` with the same requestId (idempotent server-side), then clear pending on the response. Cleanup closes the socket.
- [ ] **Step 3: Typecheck (components not yet rendering — that is Task 4's gate too). Commit:** `feat(dashboard): reconnecting run socket with ack-or-HTTP steering`

### Task 4 — SessionView

**Files:** create `src/runs/session-view.tsx`.

- [ ] **Step 1: Implement.** Scrollable transcript (auto-stick to bottom unless the user scrolled up); turns styled by role with the `source` as a small caption (`customer`, `steer`, `approval`, `triage`); tool calls collapsed — name, state icon, duration — expanding to pretty-printed input/output (bounded: `JSON.stringify(v, null, 2).slice(0, 5_000)` with a truncation marker); the draft item renders with a streaming cursor; `lastError` as an inline banner; `connection !== "open"` renders the disconnect banner ("Reconnecting — you may be seeing a stale view"); composer at the bottom (textarea + send, disabled when `status` is `done`/`failed` with the reason as placeholder).
- [ ] **Step 2: Typecheck. Commit:** `feat(dashboard): the one session component`

### Task 5 — Run list + drawer

**Files:** create `src/runs/run-list.tsx`, `src/runs/run-drawer.tsx`.

- [ ] **Step 1: Run list.** `Panel` titled "Runs", `usePoll(fetchRuns, 5_000)`; rows per the Outcome section; empty hint "No runs yet — the agent wakes when a customer thread needs it."; click → `onSelect(id)`.
- [ ] **Step 2: Drawer.** Fixed right-side overlay (slide-in, `Escape`/backdrop/× to close) over the dashboard — not a page; header: origin badge, status chip, shadow badge ("shadow — nothing this run does reaches a customer"), the one-line usage total (`fetchRunUsageTotal`, fetched once, rendered as text), run id with a copy button; body: `children` (Task 6 mounts `SessionView` here — the drawer takes `children` so this task needs nothing from wave B).
- [ ] **Step 3: Typecheck. Commit:** `feat(dashboard): run list and drawer chrome`

### Task 6 — Wire, visual pass, gate

**Files:** modify `src/app.tsx`.

- [ ] **Step 1: Mount.** Run list replaces the placeholder slot. Selection state ← `location.hash` (`#run=<id>`, written on select, cleared on close, read on load); drawer hosts `useRunSession(id)` + `SessionView`.
- [ ] **Step 2: Visual pass.** `wrangler dev` + `pnpm dev` (Phase 14's setup). Create a scripted run: `curl -X POST localhost:8787/api/runs -d '{"firstMessage":"summarize what you can do"}'`. Verify: it appears in the list; the drawer streams it live; open the SAME run in a second tab — identical streams; kill/restore the network (devtools offline) — banner, backoff, gapless resume; type a steer mid-run — it appears and the next step reacts; expand a tool call. Kill both processes.
- [ ] **Step 3: Gate:** dashboard build + both test files by exact path.
- [ ] **Step 4: Commit:** `feat(dashboard): watch and steer any run from the drawer`

## Test matrix

| Row | Proven by |
|---|---|
| Backlog-then-live, no gap, no duplicate | Task 2 seq-dedupe + sync-replace tests; Task 6 two-tab check |
| Every assistant state incl. superseded-is-not-an-error | Task 2 |
| Steer exactly once across socket retry + HTTP fallback | shared requestId (Task 3) + worker's `steer:{requestId}` id; Task 1 body-shape test |
| Disconnect visible, reconnect resumes from cursor | Task 3 + Task 6 offline check |
| Tool calls collapsed/expandable, bounded rendering | Task 4 + visual pass |
| Cost rendered as string, never computed | Task 1 identity test |

## Exit criteria

Open a scripted running loop, watch tool calls stream, type a correction, see the next step change course; a second tab shows the identical stream; pulling the network produces a banner and a gapless resume. Build + typecheck + both test files green; visual pass recorded in `phase-15-notes.md`. (A real cloud bug-fix run remains the Phase 18–20 integration.)

## Downstream handoff

- **Phase 17:** consumes `SessionView`, `useRunSession`, `postSteer` (composer on a fresh chat run), and the drawer's copy-id pattern. The chat page is these pieces plus `POST /api/runs`.
- **Phase 16 (if it lands after):** may swap its 3 s poll for this socket — `CardState` reconciliation is transport-agnostic.
- **Phase 21:** the shadow badge is the "shadow-run affordance"; the side-by-side view builds beside `SessionView`, not inside it.
- **Phase 22:** reconnection-under-real-network-loss polish extends `socket.ts` only.
