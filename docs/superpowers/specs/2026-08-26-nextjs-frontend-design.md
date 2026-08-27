# Next.js front-end (`apps/web`) — design

Date: 2026-08-26
Branch: `worktree-next-frontend` (worktree `.claude/worktrees/next-frontend`)
Status: approved in chat 2026-08-26; supersedes nothing.

## 1. Why

`apps/dashboard` is a Vite SPA compiled into `dist/` and served by the Worker as
its `ASSETS` bundle. The operator wants the front-end on **Vercel**, on
Next.js, with a real design system behind it — a collapsible sidebar shell,
shadcn components sourced from `packages/ui`, lucide icons, tooltips — instead
of the four-panel grid the SPA has today.

This document covers the front-end only. Every backend change the move implies
is recorded, unbuilt, in `apps/web/BACKEND-GAPS.md`.

## 2. The constraint that shapes everything

The current SPA has no backend URL and no CORS anywhere. It calls relative
`/api/...` with `credentials: "same-origin"`, and Cloudflare Access gates that
one origin, so the browser already carries `CF_Authorization` on every request.
`apps/worker/src/access/jwt.ts` has no dev bypass: an identity is a real JWT
verified against Cloudflare's JWKS or it is a 401.

A Vercel deployment is a **different origin**. That cookie will not travel to
it, and `next.config` rewrites do not change that — a rewrite proxies the
*request*, and the request never had the cookie in the first place.

So: the Next app is built to the same one-origin contract, the rewrite keeps
CORS out of the bundle, and the authentication hole is written down rather than
papered over. Until the backend answers it, live mode 401s and demo mode is
what renders on Vercel.

## 3. Decisions

- **D1 — Additive.** New workspace `apps/web`. `apps/dashboard` is untouched, so
  the Worker keeps serving its bundle and `pnpm run deploy` keeps working. The
  two front-ends coexist; retiring the SPA is a later, separate call.
- **D2 — Real data model, mockup polish.** The prototype screenshots show a
  three-day on-duty rotation with a shift countdown. Rotation was removed on
  2026-08-17 (`src/identity/speaker.ts`); `/api/roster` returns `speaker`,
  `githubSpeaker`, `pool` and `engineers`, and nothing else. The hero card gets
  the visual weight of the mockup's "on duty" card and the *honest* copy:
  who speaks by default, and why. No countdown, no schedule, no "last shift".
- **D3 — Components live in `packages/ui`.** Every shadcn primitive is installed
  into `packages/ui` (its `components.json` already aliases there). `apps/web`
  holds only composition. `apps/web/components.json` aliases `ui` →
  `@workspace/ui/components` so the CLI splits them that way automatically.
- **D4 — The block is a source of primitives, not a template.** `sidebar-07`
  is installed for its primitives and its layout mechanics; the actual sidebar,
  every panel and every empty state is hand-authored against Fire-Fighter's own
  nouns. A renamed demo nav is not a design.
- **D5 — One API client, two sources.** `lib/api/*` ports the SPA's contract
  verbatim — `ApiError`, the 401/403/else classification, `getJson`/`postJson`/
  `patchJson`, every response type. `NEXT_PUBLIC_DEMO=1` swaps the transport for
  `lib/fixtures/*`. Nothing else in the app knows which is in play.
- **D6 — Client-side data only.** No server components fetch from `/api`. Auth
  is a browser cookie; a Vercel server render cannot hold one. Pages are static
  shells that mount client panels.
- **D7 — `?run=` replaces `#run=`.** The SPA keeps its run selection in
  `location.hash`. A search param is shareable in the same way, survives the
  same reload, and is readable without a hydration dance.
- **D8 — Dark-first, both themes work.** `packages/ui`'s neutral token set
  stays generic. `apps/web` overrides `--primary`, `--ring` and the chart ramp
  to the ember accent in its own layer, and `next-themes` (already a
  `packages/ui` dependency) drives the class.

### Added 2026-08-27, when the Agents-SDK run chassis landed on `main`

- **D9 — A run gets a route, not a drawer.** The Vite dashboard renders the
  live session inline beneath the runs list. Here it is `/runs/[id]`. A run is
  the thing an operator pastes into Slack and reloads into at 3am, so it
  deserves a URL that survives a refresh and a back button. The `?run=` sheet
  stays as the cheap peek from the list — status, spend, origin, two D1 reads
  and no socket — and its primary action opens the route.
- **D10 — `/chat` is a create form and nothing else.** A chat run is the same
  object a Slack wake produces, so once `POST /api/runs` answers, the page
  routes to `/runs/:id` and the run view takes over. Building a second session
  shape on the chat page is how the two drift.
- **D11 — The socket needs its own address.** `next.config.ts` rewrites keep
  every REST path relative, but a rewrite proxies an HTTP request and does not
  carry a WebSocket upgrade — on Vercel there is no upgrade path at all. So
  `NEXT_PUBLIC_WORKER_ORIGIN` puts the Worker's host in the bundle for the
  socket alone. It is a hostname, carries no credential, and the Worker still
  runs `requireTeamMember` on the upgrade. What it does *not* fix is §1 of the
  gaps doc, and a WebSocket handshake is a subresource request, so it fails
  there sooner than a fetch would.
- **D12 — Demo mode branches at the component, not in the hook.** `useRunAgent`
  would otherwise open a socket to a host that demo mode deliberately does not
  have, and a hook cannot be called conditionally. `RunPanel` picks; both
  branches render the same pure `RunView`, so a demo is a demo of the real
  component. The fixture transcript is in the socket's own wire shape for the
  same reason, and it is per-run — one customer's conversation under another
  customer's header teaches the reader that the transcript is decorative.
- **D13 — The transcript narrows `unknown` itself.** Its part union comes from
  the AI SDK and moves with it. Typing the prop as that union would drag the
  SDK into a component the test harness renders; narrowing locally also makes
  an unrecognised part something that is *dropped* rather than something that
  throws in a view somebody is reading during an incident.

## 4. Layout

```
apps/web/
  app/
    layout.tsx            theme + sidebar shell, fonts, the one <html>
    globals.css           imports @workspace/ui/globals.css, brand overrides, @source
    page.tsx              Dashboard
    chat/page.tsx         Chat
  components/
    shell/                app-sidebar, site-header, nav, user menu, theme toggle
    dashboard/            speaker-hero, roster-card, funnel-strip, runs-feed,
                          approvals-queue, approval-card, token-explainer,
                          team-table, shadow-panel, run-sheet
    chat/                 transcript, composer, citation-card, tool-chip, prompts
    common/               panel (the four-state wrapper), status-chip, empty,
                          copy-id, relative-time, error-boundary
  lib/
    api/                  client, errors, identity, roster, counters, runs,
                          approvals, shadow, chat
    fixtures/             the prototype's data, one module per endpoint
    hooks/                use-poll, use-approvals, use-identity, use-selected-run
  BACKEND-GAPS.md
```

`packages/ui` gains: sidebar, sheet, tooltip, separator, breadcrumb,
dropdown-menu, avatar, collapsible, skeleton, badge, table, input, textarea,
scroll-area, and whatever `sidebar-07` pulls with them. Nothing app-specific
goes in there.

## 5. Screens

### Shell

Icon-collapsible sidebar (`sidebar-07`'s mechanic). Brand mark, then two nav
entries — Dashboard, Chat — then a footer holding the signed-in identity, the
role badge, and a menu with the theme toggle. A rail toggle with a tooltip when
collapsed. The header carries a breadcrumb and the live "waiting on you" count,
because that number is the only reason to switch pages in a hurry.

### Dashboard

In order down the page:

1. **Speaker hero** (accent-bordered, left) — who the agent speaks as by
   default, their Slack/GitHub connect state, and the PR author when it differs.
   When nobody has connected: the refusal state, said plainly, because that is
   the condition where every customer-facing write is blocked.
2. **Roster card** (right) — the rest of the `pool` in tie-break order with
   connect state. This is what replaces the mockup's rotation schedule.
3. **Funnel strip** — seen → triaged → woken → escalated as one connected row
   with arrows. `dropped` is derived (`triaged - woken`) and labelled as
   derived. No cost figure: `/api/counters` does not carry one.
4. **Agent runs** (left column) — the run feed. Status chip (pulse only on
   `live`/`awaiting_approval`), origin, shadow badge, where, relative time,
   summary. Clicking sets `?run=` and opens the run sheet.
5. **Waiting on you** (right column) — the approvals queue, the only surface on
   this page with a human on the other end. Approve / Edit / Reject, with the
   reject reason required, exactly as the SPA enforces it.
6. **Two tokens** — the explainer pair from the mockups (user token speaks to
   customers, bot token nudges the team). Static copy; it is documentation, and
   it is the thing that makes the rest of the page legible to a newcomer.
7. **Team** — a real `<table>`: person, role, Slack, GitHub, last activity. The
   mockup's "agent may act as me" toggle renders read-only (see gaps).
8. **Shadow eval** — below the fold, as in the SPA: the draft/human pair with
   detected tells. It is a review corpus, not something waiting on anyone.

Run sheet (`?run=`): the run's meta and its usage total, the two things
`/api/runs` and `/api/runs/:id/usage` actually return. No transcript — there is
no endpoint for one.

### Chat

The second door, and a create form: one composer, the four claims about what
this door proves, and openings that fill the box rather than sending
themselves. `POST /api/runs`, then straight to the run.

### Run

`/runs/[id]`. A header from D1 — status, origin, channel, run id, spend — that
draws whether or not a socket ever connected, and beneath it the transcript
over `/api/runs/:id/agent`. Tool calls collapse by default; every capability
call is inside one `run_code` payload, so an expanded row is most of the
transcript's bytes and almost never what the reader came for. The run's
approval card renders *inside* the transcript, because a run parks mid-answer
and the reader is already looking here — the decision still leaves over
`PATCH /api/approvals/:id`. The composer has one verb, `Steer`, because the
Worker drops every other client frame.

## 6. State and errors

`Panel` keeps the SPA's four-state contract — `loading | error | empty | ready` —
and every asynchronous region renders through it. `usePoll` keeps the SPA's
rule that a panel holding good data never falls back to a spinner because one
background poll failed. `ApiError` messages carry the path and nothing from the
response body. An identity failure replaces the whole page, not each panel.

## 7. Verification

- `pnpm --filter @workspace/web test` — vitest + Testing Library over the parts
  worth testing: error classification, the demo/live transport switch, relative
  time, the approval card's state machine, the funnel's derived field.
- `pnpm --filter @workspace/web typecheck`, `lint`, and a real `next build`.
- `apps/dashboard` and `apps/worker` suites must stay at their baseline
  (dashboard 26/26 at the time of writing); nothing in this work touches them
  except the `@source` fix in §8.

## 8. One targeted fix outside `apps/web`

`packages/ui/src/styles/globals.css` declares
`@source "../../../apps/**/*.{ts,tsx}"`. From `packages/ui/src/styles/` that
resolves to `packages/apps/**`, which does not exist — the glob has never
matched anything. The Vite dashboard was unaffected because
`@tailwindcss/vite` detects its own sources. Next's PostCSS pipeline does not,
so the path is corrected to `../../../../apps/**` and a matching
`packages/ui/src/**` glob is added. Adding sources is safe for the existing
build; it only widens what Tailwind scans.

## 9. Out of scope

Retiring `apps/dashboard`. Any Worker change — CORS, an auth exchange, or a
writer for `runs.summary`. Those are enumerated with their contracts in
`apps/web/BACKEND-GAPS.md` and built by nobody until someone decides to. The
chat route and the run detail route *were* on this list and are no longer:
they landed on the Worker on their own, and gaps §3–§5 record what closed
them.
