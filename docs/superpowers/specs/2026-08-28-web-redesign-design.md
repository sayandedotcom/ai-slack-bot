# `apps/web` redesign — pages by job, a Runs workbench, one accent

Date: 2026-08-28
Status: approved in chat 2026-08-28. Builds on
`2026-08-26-nextjs-frontend-design.md` (D1–D13 stay in force) and closes
`apps/web/BACKEND-GAPS.md` §6, §9 and §10.

## 1. Why

`apps/web` (live at `https://firefighter.sayande.xyz`) stacks nine unrelated
panels on one scrolling page, three of them static documentation. The
operator's verdict: congested, confusing, inconsistent gaps. The screenshot
also shows a literal `NaN` in the funnel.

Two findings shape the work:

- **The `NaN` is a contract bug.** `GET /api/counters` returns
  `{heard, ingested, triaged, escalated}` (`apps/worker/src/db/counters.ts`);
  `apps/web/lib/api/counters.ts` and `apps/dashboard/src/lib/api.ts` both read
  `{seen, triaged, woken, escalated}`. `dropped = triaged − undefined` is `NaN`,
  `scale = max(undefined, 1)` is `NaN`, every bar gets `width: NaN%`, and the
  "Quiet" empty state can never fire. The Worker has no `woken` counter at all.
  `BACKEND-GAPS.md §6` documents the wrong shape, which is how it survived.
- **The API cannot carry a runs workbench.** `GET /api/runs` has no search, no
  channel filter, no pagination, no spend, no turn count, no open-approval flag.
  There is no per-run approval history and the `codemode_effects` ledger —
  what a run actually did — has no API surface. `RunAgent.cancel()` exists and
  nothing calls it.

## 2. Decisions

- **D14 — Pages by job.** Six routes, one job each: `/` Overview, `/runs`
  (+ `/runs/[id]`), `/approvals`, `/team`, `/channels`, `/eval`. `/chat` is
  removed as a page; its composer becomes a "New run" dialog on `/runs`.
  Documentation panels (two tokens, nudge preview) live in a collapsible at
  the bottom of `/team`, off every critical path.
- **D15 — `/runs` is a split view, and the URL is still the run.** List |
  transcript | inspector. D9 stands: `/runs/[id]` is the address; `/runs`
  alone selects the newest run. Nothing is stored in `?run=` any more; the
  run sheet is deleted.
- **D16 — Fix and extend the Worker, read-only.** Every new endpoint reads
  existing D1 columns. Nothing new is written to D1. No migration.
- **D17 — Vercel theme as base, one attention accent.** The tweakcn Vercel
  `registry:style` variables are installed in `apps/web/app/globals.css`, NOT
  `packages/ui` (both front-ends import that file; the Vite SPA must not
  change under it). Geist Sans/Mono replace IBM Plex. Colour means one thing:
  `--attention` marks "a human is needed" and nothing else; semantic
  success/warning/info/destructive stay; `--shadow-run` stays reserved.
- **D18 — One badge.** `StatusBadge` in `packages/ui` replaces `StatusChip`,
  `OriginBadge`, `ShadowBadge`, `TellBadge`, `ConnectChip` and every free-text
  "not connected". The mapping from domain value to tone is one pure module,
  `apps/web/lib/status.ts`, and it is tested.
- **D19 — The provenance doctrine survives the font change.** Sans = a person
  typed it (including the agent's draft, deliberately); mono (`.machine`,
  `.eyebrow`) = the system produced it.
- **D20 — Effects are shown, never invented.** "What this run did" and
  "artifacts" both come from `codemode_effects.safe_result_json`. Arguments
  and `args_hash` are never exposed. If the ledger has nothing, the UI says
  nothing (gaps §9, answered honestly).

## 3. Shell and navigation

Sidebar (icon-collapsible, `sidebar-07` mechanic as today), six entries:

| Route | Job | Badge |
|---|---|---|
| `/` | what needs me right now | — |
| `/runs`, `/runs/[id]` | split view | `live + awaiting_approval` count |
| `/approvals` | the queue + Decided (24h) | open count |
| `/team` | speaker, connect state, pool order, how it works | — |
| `/channels` | registry table | — |
| `/eval` | Shadow pairs · Triage score | — |

Header: sidebar trigger, page title, the "N waiting on you" pulse (kept), and
a ⌘K command palette (jump to a run by id/summary/channel, to an approval, or
to a page) built from the caches already polled.

Deep links: `/?approval=<id>` redirects to `/approvals?approval=<id>` so links
already in Slack keep working; `src/notify/blocks.ts` emits the new path.
`DASHBOARD_BASE_URL` is unchanged.

## 4. `/runs`

Three `resizable` panels: list (320px) | transcript (flex) | inspector (280px,
collapsible, remembered per browser). Below `lg` they stack: list at `/runs`,
detail at `/runs/[id]` with a back link.

**List.** Search (`?q=`, server side over summary, channel name, id prefix);
filter chips → `status`, `origin`, `channelId`, `shadow`; infinite scroll on a
keyset `cursor`. Row: status dot, one-line summary (italic "No summary yet"),
`#channel`, relative time, spend, an attention mark when `openApprovalId` is
set. `j`/`k` move the selection. Filter state is a pure reducer
(`lib/runs/filters.ts`). Empty state: "No runs match — the agent wakes only
when triage says so."

**Transcript.** The existing `RunView`/`Transcript`, restyled. Each `run_code`
row collapses to a capability chip strip ("slack.post · supabase.read ×3 ·
approval.escalate") from `/api/runs/:id/effects` matched on `turnId`, falling
back to "run_code · N chars". Expanding shows code and output (5000-char cap,
unchanged). The approval card renders inline. The composer has one verb,
`Steer` (fresh `requestId` per send, unchanged). A **Cancel** button appears
while `status === "live"`, behind a confirmation popover, calling the existing
`cancel` callable; it is disabled while an approval is open because a parked
run is not running.

**Inspector.** Facts (run id, origin, channel, thread, started, last
activity); spend by model (`/usage`, decimal strings, never `Number()`);
approvals for this run (`/api/runs/:id/approvals`); "Did" — effects grouped
by namespace, linked when `safeResult` carries `url`/`html_url`/`permalink`.

## 5. `/` and `/approvals`

Overview fits a laptop without scrolling:

1. Attention row — *Waiting on you (N)* with the oldest card's age →
   `/approvals`; *Live runs (N)* → `/runs?status=live`; *Speaks as* — the
   speaker with Slack/GitHub ticks, or the refusal banner when nobody has
   connected.
2. Funnel — heard → triaged → woke → escalated, `dropped` as a caption under
   triaged, bars scaled from `heard`, a 24h/7d toggle (`?window=`), and the
   "Quiet" state when `heard === 0`.
3. Recent runs — eight, the same `RunRow` as the split view, "See all →".

`/approvals`: the queue in one column, oldest first, the existing
`ApprovalCard` and overlay store; `?approval=` scroll-and-ring moves here.
Below it, a **Decided (last 24h)** collapsible — decision, who, when, draft
excerpt — because today a decided card vanishes and the product's whole claim
is the decision.

## 6. `/team`, `/channels`, `/eval`

- `/team`: one table (person · role · Slack · GitHub · speaks-by-default), the
  tie-break rule as a caption, the refusal banner only when nobody is
  connected, self-row OAuth links kept. "How this works" collapsible holds
  `TokenExplainer` and `NudgePreview` unchanged.
- `/channels`: `ChannelsPanel` plus client-side search and mode filter; the
  unconfirmed-slug mark gets a tooltip naming what it blocks (tenant-scoped
  Supabase reads). Authorization split unchanged.
- `/eval`: tabs — Shadow (`ShadowPanel`) and Triage (`/api/eval/triage?days=`,
  7/30/90; `null` precision/recall renders "not measured").

## 7. Design system

- Theme vars (light + dark) from the tweakcn Vercel style, radius 0.5rem,
  letter-spacing 0. `--attention`/`--attention-foreground` added.
- `Geist` + `Geist_Mono` via `next/font/google`.
- `StatusBadge`: `variant dot | soft | outline`, `size sm | md`, `tone neutral
  | attention | success | warning | info | destructive | shadow`, `pulse`,
  optional icon. Run status → tone: live = attention pulse,
  awaiting_approval = attention, idle = neutral, done = success, failed =
  destructive.
- Layout rules: one container (`max-w-7xl p-6 gap-6`; the split view is
  full-bleed), one card padding (`p-5`), one `SectionHeader` (eyebrow, title,
  right-side action), no sticky side columns, no card inside a card, lists are
  lists.
- Primitives added to `packages/ui`: dialog, tabs, select, switch,
  scroll-area, command, resizable, avatar, alert, popover, collapsible,
  sonner. Toasts report decide/steer/cancel outcomes.
- `prefers-reduced-motion` respected; pulse only on `live`.

## 8. Worker changes

All behind `requireTeamMember` (any member). No migration.

| Change | Where |
|---|---|
| `GET /api/counters?window=24h\|7d` → `{counters:{heard, ingested, triaged, woken, dropped, escalated}, since, window}`; `woken` counts `triage_decisions.wake = 1`; `dropped = triaged − woken` | `src/db/counters.ts`, `src/api/counters.ts`; `apps/dashboard` types and tiles corrected to the real shape |
| `GET /api/runs` gains `q`, `channelId`, `origin`, `shadow`, `cursor` (keyset on `updated_at DESC, id`) → `{runs, nextCursor}`; rows gain `costUsd` (string via `money.ts`), `turns`, `openApprovalId` | `src/run/repository.ts`, `src/api/runs.ts` |
| `GET /api/runs/:id/approvals` — every decision, `created_at ASC`, the card shape | `src/approval/repository.ts`, `src/api/runs.ts` |
| `GET /api/runs/:id/effects` → `{effects:[{turnId, namespace, method, state, safeResult, createdAt}]}`, cap 200, `safe_result_json` only | new `src/api/effects.ts` |
| `GET /api/approvals?state=decided&since=` (default 24h, limit 50) | `src/api/approvals.ts`, `src/approval/repository.ts` |
| `PATCH /api/approvals/:id` 409 body gains `decidedBy`; the overlay store's reconcile branch is deleted | `src/api/approvals.ts`, `apps/web/lib/store/approvals-overlay.ts` |
| `requireTeamMember` added to `GET /api/counters`, `GET /api/runs`, `GET /api/runs/:id/usage`, `POST /api/backfill/memory` | `src/api/*.ts` |
| Review button → `/approvals?approval=` | `src/notify/blocks.ts` |

Tests: `test/api/counters.test.ts`, `test/api/runs.test.ts`,
`test/api/approvals.test.ts`, `test/api/effects.test.ts` (asserts no
`args_hash`), `test/notify/blocks.test.ts`; `test/canary-secrets.test.ts`
stays green.

## 9. Delivery

Five commits, each green on `pnpm check`:

1. `feat(api):` Worker changes, counters fix, dashboard type fix, gaps doc.
2. `feat(ui):` theme, Geist, `StatusBadge`, primitives, `SectionHeader`,
   `lib/status.ts`.
3. `feat(web):` shell nav, `/runs` split view, New-run dialog, cancel, `/chat`
   removed.
4. `feat(web):` Overview, `/approvals`, the `/?approval=` redirect.
5. `feat(web):` `/team`, `/channels`, `/eval`, ⌘K, docs.

## 10. Verification

`pnpm check` at the root before and after each commit; `apps/web` vitest
(existing 13 files plus `run-filters`, `status` mapping, funnel against the
real shape, palette index) and `next build`; `apps/dashboard` at its baseline;
`NEXT_PUBLIC_DEMO=1 pnpm dev` through all six routes with fixtures updated to
the new shapes; after deploy, a live check that the funnel shows numbers,
`/runs` shows spend, an inspector shows effects, and a Slack Review button
lands on `/approvals?approval=`.

## 11. Out of scope

Retiring `apps/dashboard` (gaps §12). The "agent may act as me" toggle (gaps
§8). Per-message cost (gaps §6's cost figure — the counters fix is the shape,
not a price). Any write endpoint beyond what exists.
