# Phase 17 notes — Chat page: navigation, visual pass, gate

Task 4 of the phase-17 plan wires navigation between the dashboard and the
new chat page (`apps/dashboard/src/chat/chat-page.tsx`, shipped in Task 3).
This note records what was actually verified in this pass and what was
deliberately left unverified. It does not close the phase gate: the plan's
central exit criterion — citations opening real Slack threads — is still
unproven, and the phase remains open until the steps recorded under "Open
gate" below are run.

## What changed

- `apps/dashboard/src/app.tsx`: `useSelectedRun` (hash key `#run=<id>` only)
  replaced with `useHashRoute`, which parses four routes — `#` and
  `#run=<id>` (dashboard, drawer preserved with its existing `key`), `#chat`
  and `#chat/run=<id>` (chat page). `App` renders `<ChatPage runId={...}
  onSelectRun={...}>` when `route.page === "chat"`, otherwise the existing
  `<main>` grid and drawer, unchanged.
- `apps/dashboard/src/components/header.tsx`: `Header` gains a required
  `page: "dashboard" | "chat"` prop and a `<nav aria-label="Pages">` with two
  anchors (`href="#"`, `href="#chat"`). Anchors, not buttons — writing the
  hash is the navigation; `hashchange` (already wired in `useHashRoute`)
  does the rest. No new handler code, no router library.
- TypeScript strict-mode note: `chat[1]` and `drawer[1]` from the brief's
  regexes are `string | undefined` under `noUncheckedIndexedAccess`. Bound
  each to a local (`chatRunId`, `drawerRunId`) before the
  undefined-check/cast so the runtime behaviour matches the brief exactly
  while `tsc --noEmit` stays clean.

## Visual pass — what was verified, and how

**Environment used:** only `pnpm --filter @workspace/dashboard dev` (Vite on
5173). Per the controller's instructions, `apps/worker` was never started,
`.dev.vars` was never created/read/copied, and nothing in `apps/worker` was
run. `apps/dashboard/dev-stubs.ts` answers `/api/identity`, `/api/roster`,
`/api/approvals`; `/api/runs`, `/api/counters` and `/ws/run/:id` fall through
to a real worker that was not running, so they surface as genuine ERROR
states (not a fiction — this is exactly the coverage the controller asked
for).

**Method:** a locally available headless `google-chrome` (`--headless=new`)
took real screenshots and DOM dumps against the running Vite dev server —
this is pixels and rendered markup, not just curl + code reading, for the
states below. I did not have Playwright/Puppeteer/Selenium available for
scripted click/keyboard interaction, and a CDP-over-websocket harness proved
flaky in the time available, so a small number of items below (marked) are
verified by code reading only, not by a captured interaction.

Verified by headless-Chrome screenshot and/or `--dump-dom`:

- `http://localhost:5173/#chat` renders the chat page: session list panel
  (titled "Chats") in the "Backend unreachable" ERROR state with a Retry
  button (because `/api/runs` fell through to no worker), and the new-chat
  composer with heading "Ask the agent", the textarea placeholder "Ask
  anything, or hand it work…", an "Ask" button, and all four "Try asking"
  suggestions from the brief, verbatim.
- `http://localhost:5173/` and `http://localhost:5173/#run=dev-run` render
  the dashboard, unchanged: approvals ("Waiting on you"), rotation,
  connections, the Counters panel in its own "Backend unreachable" ERROR
  state, and the Runs panel. `#run=dev-run` additionally opens the
  `RunDrawer` with header "dev-run", a copy button, and the SessionView
  showing "Reconnecting — you may be seeing a stale view" and "Could not
  load this run's transcript. (snapshot_failed)" — the drawer mount and its
  `key` are intact and doing exactly what they did before this change; the
  error content is genuine because no worker was running.
- Header tabs switch correctly and set `aria-current`: `--dump-dom` on `#`
  shows `<a href="#" aria-current="page" ...>Dashboard</a>` and
  `<a href="#chat" ...>Chat</a>` (no `aria-current`); `--dump-dom` on `#chat`
  shows the reverse. Active-tab styling (`bg-muted font-medium`) matches the
  `aria-current` state in both screenshots.
- `parseHash("")` / `parseHash("#")` both resolve to `{ page: "dashboard",
  runId: null }` — confirmed by reading `app.tsx` (the `chat` regex doesn't
  match, the `drawer` regex requires `run=`, so both hit the final
  fallback), matching the dashboard's pre-existing behaviour.

Verified by code reading only (not captured live in this pass):

- Clicking a "Try asking" suggestion fills the composer textarea —
  `chat-page.tsx`'s suggestion buttons set `draft` to the suggestion text
  via the same `setDraft` the textarea is controlled by; no network
  involved, so this is a pure state wire, not something that needed a live
  citation loop to confirm, but it was not captured as a screenshot/DOM
  diff before/after a click in this pass.
- Browser back/forward across `#chat` → `#` → previous history: relies
  entirely on `useHashRoute`'s `hashchange` listener plus native browser
  history, both stock browser behaviour; not separately exercised with a
  scripted back/forward in this pass.

## Build and tests (the gate)

- `pnpm --filter @workspace/dashboard build` — PASS (`tsc --noEmit` then
  `vite build`; no type errors, bundle emitted).
- `cd apps/dashboard && pnpm exec vitest run test/citations.test.ts` — PASS,
  13/13 tests.

## Open gate — live citation loop (deferred, not skipped)

The following six items from the brief's Step 3 need the primary
environment — a real `.dev.vars` plus the ingested local D1 data — which
lives only in a different worktree that was actively being deployed from
during this pass. They were deliberately not attempted here:

1. Streamed transcript against a real question (asking about an actual
   ingested thread and watching the answer stream in).
2. The sources rail rendering against real `memory.cite` citations.
3. A sources-rail chip opening the real Slack thread in a new tab.
4. In-text permalink linkification resolving to a real, clickable Slack
   message inside assistant text.
5. Copy-id on a real run id (the drawer copy button itself was seen working
   structurally on `dev-run`, but not proven against a live run).
6. Backlog replay on reload of `#chat/run=<id>` for a session with real
   history (reload was not exercised against a live worker in this pass;
   the reconnect/error UI was seen instead, which is the expected fallback
   when there is no worker at all).

To close this gate, the operator should, in the worktree with the real
`.dev.vars` and the ingested local D1 (not this one):

```bash
# terminal 1 — real worker, real D1
pnpm --filter @workspace/worker dev

# terminal 2 — dashboard, proxied to the worker above
pnpm --filter @workspace/dashboard dev

# find a real ingested thread to ask about
cd apps/worker && pnpm exec wrangler d1 execute firefighter --local \
  --command "SELECT channel_id, text FROM messages LIMIT 5"
```

Then, in the browser: open `#chat`, ask a question about that thread,
confirm the sources rail appears once the model cites, click a chip and
confirm it opens the real Slack message in a new tab with the right
`#<channel-id>` + ts caption, confirm an in-text permalink is clickable in
place, reload on the resulting `#chat/run=<id>` and confirm backlog-then-live
replay, and steer mid-run from the composer to confirm the optimistic
pending row resolves. This is the proof this repo does not yet have.
