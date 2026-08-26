# Next.js front-end (`apps/web`) Implementation Plan

> **For agentic workers:** This plan is executed **inline, in the authoring
> session**, at the operator's instruction ("continue implementation"). Steps
> use checkbox (`- [ ]`) syntax for tracking. If you are picking this up cold
> instead, use `superpowers:executing-plans`.

**Goal:** A Next.js app at `apps/web`, deployable to Vercel, that replaces the
Vite dashboard's four-panel grid with a sidebar shell and designed panels, built
entirely from shadcn components living in `packages/ui`.

**Architecture:** App Router, all data client-side through one API client that
swaps to fixtures under `NEXT_PUBLIC_DEMO=1`. Relative `/api/*` paths kept, with
a `next.config` rewrite to the Worker origin, so no backend URL and no CORS
reach the bundle. `apps/dashboard` and `apps/worker` are untouched.

**Tech Stack:** Next.js 16, React 19.2.4, Tailwind v4, shadcn (`base-nova` on
`@base-ui/react`), lucide-react, next-themes, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-26-nextjs-frontend-design.md`

## Global Constraints

- React is pinned at exactly `19.2.4` everywhere in the workspace. `apps/web`
  pins the same string — a second React copy breaks context across the
  `@workspace/ui` boundary.
- pnpm `10.33.4`, Node `>= 20`. Workspace globs are `apps/*` and `packages/*`.
- Every shadcn primitive lands in `packages/ui/src/components/`. `apps/web`
  imports from `@workspace/ui/components/*` and never redefines one.
- `next.config.ts` must set `transpilePackages: ["@workspace/ui"]` — the package
  exports raw `.tsx`.
- No backend URL, token, or email address is hardcoded in a component. Errors
  carry the request path and nothing from a response body (invariant 39's
  front-end half).
- Copy is direct and technical: no preamble, no recap, no exclamation marks.
- `apps/dashboard` baseline is 26/26 vitest tests. It must stay there.
- Rotation, shifts, and countdowns do not exist. Never render one.

---

### Task 1: Scaffold `apps/web` and fix Tailwind's source globs

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`,
  `apps/web/next.config.ts`, `apps/web/postcss.config.mjs`,
  `apps/web/components.json`, `apps/web/.gitignore`,
  `apps/web/app/layout.tsx`, `apps/web/app/globals.css`, `apps/web/app/page.tsx`
- Modify: `packages/ui/src/styles/globals.css` (the `@source` globs)

**Interfaces:**
- Produces: workspace `@workspace/web`; `NEXT_PUBLIC_DEMO` and `WORKER_ORIGIN`
  as the only two environment variables the app reads.

- [ ] **Step 1:** Write `apps/web/package.json` — name `@workspace/web`,
  private, `dev`/`build`/`start`/`lint`/`typecheck`/`test` scripts, deps
  `next`, `react@19.2.4`, `react-dom@19.2.4`, `@workspace/ui: workspace:*`,
  `lucide-react`, `next-themes`.
- [ ] **Step 2:** `tsconfig.json` extending `@workspace/typescript-config`,
  with `"@/*": ["./*"]` and the Next plugin.
- [ ] **Step 3:** `next.config.ts` with `transpilePackages: ["@workspace/ui"]`
  and a `rewrites()` that maps `/api/:path*` to `${WORKER_ORIGIN}/api/:path*`,
  returning `[]` when `NEXT_PUBLIC_DEMO === "1"` or `WORKER_ORIGIN` is unset.
- [ ] **Step 4:** Fix `packages/ui/src/styles/globals.css`: `../../../apps/**`
  resolves to `packages/apps/**` and has never matched. Correct it to
  `../../../../apps/**/*.{ts,tsx}` and add `../../../../packages/*/src/**/*.{ts,tsx}`.
- [ ] **Step 5:** `app/globals.css` importing `@workspace/ui/globals.css`, then
  the ember brand overrides for `--primary`, `--primary-foreground`, `--ring`,
  `--sidebar-primary` and the chart ramp in both `:root` and `.dark`, plus
  `--font-sans`/`--font-mono` bound to the `next/font` variables.
- [ ] **Step 6:** `app/layout.tsx` — `<html lang="en" suppressHydrationWarning>`,
  fonts, `ThemeProvider` from next-themes with `defaultTheme="dark"`.
- [ ] **Step 7:** Placeholder `app/page.tsx`, then `pnpm install` at the root.
- [ ] **Step 8:** Run `pnpm --filter @workspace/web build`. Expected: succeeds,
  and the compiled CSS contains utilities used only in `apps/web` (proves the
  `@source` fix).
- [ ] **Step 9:** Run `cd apps/dashboard && pnpm vitest run`. Expected: 26/26 —
  the `@source` change must not have disturbed it.
- [ ] **Step 10:** Commit `feat(web): scaffold the Next.js app and fix Tailwind source globs`.

---

### Task 2: Install the shadcn primitives into `packages/ui`

**Files:**
- Create: `packages/ui/src/components/{sidebar,sheet,tooltip,separator,badge,table,input,textarea,skeleton,avatar,dropdown-menu,collapsible,breadcrumb,scroll-area,label}.tsx`
- Create: `packages/ui/src/hooks/use-mobile.ts`
- Modify: `packages/ui/package.json` (whatever deps the CLI adds)

**Interfaces:**
- Produces: `@workspace/ui/components/sidebar` exporting `SidebarProvider`,
  `Sidebar`, `SidebarContent`, `SidebarGroup`, `SidebarMenu`, `SidebarMenuItem`,
  `SidebarMenuButton`, `SidebarInset`, `SidebarTrigger`, `SidebarRail`,
  `SidebarHeader`, `SidebarFooter`, `useSidebar`.

- [ ] **Step 1:** From `apps/web`, run `npx shadcn@latest add sidebar-07`. Its
  `components.json` aliases `ui` → `@workspace/ui/components`, so primitives
  land in `packages/ui` and the block's own files land in `apps/web`.
- [ ] **Step 2:** Add the remaining primitives the panels need:
  `npx shadcn@latest add tooltip badge table textarea input skeleton avatar dropdown-menu scroll-area separator`.
- [ ] **Step 3:** Delete the block's generated demo pages and demo `app-sidebar`
  — they are a template, and D4 says the sidebar is hand-authored. Keep only
  what landed in `packages/ui`.
- [ ] **Step 4:** `pnpm install`, then `pnpm --filter @workspace/ui typecheck`
  and `pnpm --filter @workspace/web build`. Expected: both pass.
- [ ] **Step 5:** Commit `feat(ui): shadcn primitives for the sidebar shell`.

---

### Task 3: The API client, the fixtures, and the transport switch

**Files:**
- Create: `apps/web/lib/api/{errors,client,identity,roster,counters,runs,approvals,shadow,chat}.ts`
- Create: `apps/web/lib/fixtures/{index,roster,counters,runs,approvals,shadow,chat}.ts`
- Test: `apps/web/test/api-client.test.ts`, `apps/web/test/fixtures.test.ts`
- Create: `apps/web/vitest.config.ts`

**Interfaces:**
- Produces:
  - `class ApiError extends Error { status: number; kind: "unauthorized" | "forbidden" | "unavailable" }`
  - `getJson<T>(path: string): Promise<T>`, `postJson<T>(path, body): Promise<T>`,
    `patchJson(path, body): Promise<{ status: number; body: unknown }>`
  - `isDemo(): boolean` — reads `process.env.NEXT_PUBLIC_DEMO === "1"`
  - Types ported verbatim from `apps/dashboard/src/lib/api.ts`,
    `src/runs/api.ts`, `src/approvals/api.ts`, `src/shadow/api.ts`.
  - Each endpoint module exports one reader, e.g. `getRoster(): Promise<Roster>`,
    which returns its fixture when `isDemo()`.

- [ ] **Step 1:** Write `test/api-client.test.ts` first: a 401 classifies as
  `unauthorized`, a 403 as `forbidden`, a 500 and a network throw both as
  `unavailable`, an unparseable 200 as `unavailable`, and the thrown message
  contains the path and **not** the response body.
- [ ] **Step 2:** Run it. Expected: fail, module not found.
- [ ] **Step 3:** Port `errors.ts` and `client.ts` from the SPA.
- [ ] **Step 4:** Run. Expected: pass.
- [ ] **Step 5:** Write `test/fixtures.test.ts`: with `NEXT_PUBLIC_DEMO=1`,
  `getRoster()` resolves without touching `fetch` (assert on a `fetch` spy that
  is never called); without it, `fetch` is called with `/api/roster`.
- [ ] **Step 6:** Write the fixture modules using the prototype's data — Luka
  speaking, Zurab/Mikheil/Ronit in the pool, Mikheil not connected, the three
  Slack runs, one open approval, the shadow pair, the chat transcript.
- [ ] **Step 7:** Run both test files. Expected: pass.
- [ ] **Step 8:** Commit `feat(web): api client, fixtures and the demo transport switch`.

---

### Task 4: Hooks

**Files:**
- Create: `apps/web/lib/hooks/{use-poll,use-identity,use-approvals,use-selected-run}.ts`
- Test: `apps/web/test/use-poll.test.tsx`

**Interfaces:**
- Consumes: Task 3's readers and `ApiError`.
- Produces:
  - `type PanelState<T> = {kind:"loading"} | {kind:"error"; error: ApiError; retry: () => void} | {kind:"empty"; hint: string} | {kind:"ready"; data: T}`
    (exported from `apps/web/components/common/panel.tsx`, imported by the hooks)
  - `usePoll<T>(fetcher: () => Promise<T>, intervalMs: number): PanelState<T> & { refresh: () => void }`
  - `useIdentity(): { identity?: Identity; error?: ApiError }`
  - `useApprovals(): { state: PanelState<CardState[]>; decideCard: (id: string, action: DecideAction) => void }`
  - `useSelectedRun(): [string | null, (id: string | null) => void]` — backed by
    `?run=` via `useRouter`/`useSearchParams`, not `location.hash`.

- [ ] **Step 1:** Write `test/use-poll.test.tsx`: a poll that succeeds then
  fails keeps showing the good data (stays `ready`), and a poll that fails
  first shows `error`.
- [ ] **Step 2:** Run. Expected: fail.
- [ ] **Step 3:** Port `use-poll` from the SPA; write the other three.
- [ ] **Step 4:** Run. Expected: pass.
- [ ] **Step 5:** Commit `feat(web): polling, identity, approvals and run-selection hooks`.

---

### Task 5: Common components

**Files:**
- Create: `apps/web/components/common/{panel,status-chip,relative-time,copy-id,empty,error-boundary,signed-out}.tsx`
- Test: `apps/web/test/relative-time.test.ts`

**Interfaces:**
- Produces: `Panel<T>({ title, state, children, action?, description?, icon? })`
  rendering the four `PanelState` branches; `StatusChip({ status })` pulsing only
  for `live` and `awaiting_approval`; `ago(thenMs, nowMs): string`;
  `CopyId({ value, label })`; `Empty({ icon, title, hint })`.

- [ ] **Step 1:** Write `test/relative-time.test.ts` covering `just now`,
  `Nm ago`, `Nh ago`, `Nd ago`, and a future timestamp clamping to `just now`.
- [ ] **Step 2:** Run. Expected: fail.
- [ ] **Step 3:** Implement the components; `Panel` uses `Card` + `Skeleton`,
  every non-obvious affordance gets a `Tooltip`.
- [ ] **Step 4:** Run. Expected: pass.
- [ ] **Step 5:** Commit `feat(web): panel, status chip and the shared primitives`.

---

### Task 6: The shell

**Files:**
- Create: `apps/web/components/shell/{app-sidebar,site-header,nav-main,nav-user,theme-toggle,brand.tsx}`
- Modify: `apps/web/app/layout.tsx`

**Interfaces:**
- Consumes: `@workspace/ui/components/sidebar`, `useIdentity`.
- Produces: the shell wrapping both routes; `SidebarInset` is where a page's
  children render.

- [ ] **Step 1:** `AppSidebar` — brand mark, nav (Dashboard `/`, Chat `/chat`)
  with `usePathname` for the active state, footer with identity + role badge and
  a dropdown holding the theme toggle. Collapsed rail shows icons with tooltips.
- [ ] **Step 2:** `SiteHeader` — sidebar trigger, breadcrumb, and the open
  approvals count as a badge linking to the queue.
- [ ] **Step 3:** Wire into `layout.tsx` inside `SidebarProvider`.
- [ ] **Step 4:** `pnpm --filter @workspace/web build`. Expected: pass.
- [ ] **Step 5:** Commit `feat(web): sidebar shell, header and theme toggle`.

---

### Task 7: Dashboard — speaker hero, roster, funnel

**Files:**
- Create: `apps/web/components/dashboard/{speaker-hero,roster-card,funnel-strip}.tsx`
- Modify: `apps/web/app/page.tsx`
- Test: `apps/web/test/funnel.test.ts`

**Interfaces:**
- Consumes: `usePoll(getRoster, 60_000)`, `usePoll(getCounters, 10_000)`.
- Produces: `deriveFunnel(counters: Counters["counters"]): { seen, triaged, dropped, woken, escalated }`
  where `dropped = Math.max(0, triaged - woken)`.

- [ ] **Step 1:** Write `test/funnel.test.ts`: `dropped` derives correctly and
  clamps at zero when `woken > triaged`.
- [ ] **Step 2:** Run. Expected: fail. Implement. Run. Expected: pass.
- [ ] **Step 3:** `SpeakerHero` — accent left border, avatar initial, "speaks by
  default", Slack/GitHub connect chips, PR-author line only when
  `githubSpeaker` differs, and the blocked state when `speaker === null`.
- [ ] **Step 4:** `RosterCard` — the rest of `pool` in order with connect state
  and a tooltip explaining tie-break order.
- [ ] **Step 5:** `FunnelStrip` — one row, arrows between stages, `dropped`
  carrying a tooltip that says it is derived.
- [ ] **Step 6:** Commit `feat(web): speaker hero, roster and the triage funnel`.

---

### Task 8: Dashboard — runs feed and the run sheet

**Files:**
- Create: `apps/web/components/dashboard/{runs-feed,run-row,run-sheet}.tsx`
- Modify: `apps/web/app/page.tsx`

**Interfaces:**
- Consumes: `usePoll(getRuns, 5_000)`, `getRunUsageTotal(id)`, `useSelectedRun()`.
- Produces: clicking a row sets `?run=<id>`; `RunSheet` opens off that param and
  shows meta plus the usage total as the exact decimal string the ledger
  returned (never `Number()`ed).

- [ ] **Step 1:** `RunRow` — status chip, origin badge, shadow badge with
  tooltip, channel/customer, relative time, summary or the "no summary yet" line.
- [ ] **Step 2:** `RunsFeed` — copy-sorted by `updatedAt` desc, empty state
  naming why the list is empty.
- [ ] **Step 3:** `RunSheet` — `Sheet` from `@workspace/ui`, meta rows, usage
  total, `CopyId`, and an explicit line that there is no transcript endpoint.
- [ ] **Step 4:** `pnpm --filter @workspace/web build`. Expected: pass.
- [ ] **Step 5:** Commit `feat(web): the agent runs feed and run detail sheet`.

---

### Task 9: Dashboard — the approvals queue

**Files:**
- Create: `apps/web/components/dashboard/{approvals-queue,approval-card}.tsx`
- Test: `apps/web/test/approval-card.test.tsx`

**Interfaces:**
- Consumes: `useApprovals()`, `CardState`, `DecideAction`.
- Produces: `ApprovalCard({ state, role, onDecide })` — the SPA's three-state
  card (`open` / `deciding` / `resolved`) with its rules intact.

- [ ] **Step 1:** Write `test/approval-card.test.tsx`: the reject button stays
  disabled until a reason is typed; a viewer sees no action buttons; a
  `deciding` card locks its controls; a `resolved` card with `decidedBy: null`
  renders "Someone else … first" rather than a blank name.
- [ ] **Step 2:** Run. Expected: fail.
- [ ] **Step 3:** Implement, porting the SPA's copy and its asymmetry — approve
  is one click, edit opens inline (never a modal, so `why` stays visible),
  reject costs a sentence.
- [ ] **Step 4:** Run. Expected: pass.
- [ ] **Step 5:** Commit `feat(web): the approvals queue`.

---

### Task 10: Dashboard — explainers, team table, shadow panel

**Files:**
- Create: `apps/web/components/dashboard/{token-explainer,team-table,shadow-panel,nudge-preview}.tsx`
- Modify: `apps/web/app/page.tsx`

- [ ] **Step 1:** `TokenExplainer` — the two-token pair from the prototype, as
  static documentation cards with lucide icons.
- [ ] **Step 2:** `NudgePreview` — the Block Kit DM as it reaches the speaker,
  labelled a notification and not a control surface.
- [ ] **Step 3:** `TeamTable` — a real `<table>` from `@workspace/ui/components/table`:
  person, role, Slack, GitHub, and the connect action on the signed-in
  engineer's own row only. Viewers render `—`.
- [ ] **Step 4:** `ShadowPanel` — draft/human pair with the detected tells as
  badges, each tooltipped with what the tell means.
- [ ] **Step 5:** Assemble `app/page.tsx` in the spec's §5 order.
- [ ] **Step 6:** Commit `feat(web): token explainer, team table and shadow eval`.

---

### Task 11: Chat

**Files:**
- Create: `apps/web/app/chat/page.tsx`,
  `apps/web/components/chat/{transcript,message,citation-card,tool-chip,composer,suggested-prompts,demo-banner}.tsx`

- [ ] **Step 1:** `DemoBanner` — states plainly that chat has no backend today,
  naming the commit that removed the agent layer. Rendered whenever the chat
  transport is fixtures, which is always.
- [ ] **Step 2:** Transcript, message bubbles, citation cards linking to Slack
  permalinks, tool chips (`linear.create → ZEL-2044`) in mono.
- [ ] **Step 3:** Composer — disabled with an explanatory tooltip in demo mode,
  and the suggested prompts as clickable chips.
- [ ] **Step 4:** `pnpm --filter @workspace/web build`. Expected: pass.
- [ ] **Step 5:** Commit `feat(web): the chat surface`.

---

### Task 12: `BACKEND-GAPS.md`, Vercel wiring, verification

**Files:**
- Create: `apps/web/BACKEND-GAPS.md`, `apps/web/.env.example`, `apps/web/README.md`
- Modify: `CLAUDE.md` (one paragraph naming the new workspace)

- [ ] **Step 1:** Write `BACKEND-GAPS.md`: every gap with what the front-end
  already does, what it needs, and the exact contract — the Access cookie
  crossing origins, CORS, the missing chat and transcript endpoints, no
  `GET /api/runs/:id`, no rotation source, no write behind the team toggle, no
  cost-per-message, no PR/Linear fields on a run, no `decidedBy` on a 409.
- [ ] **Step 2:** `.env.example` with `NEXT_PUBLIC_DEMO` and `WORKER_ORIGIN`,
  names only, no values.
- [ ] **Step 3:** `README.md` — Vercel root directory `apps/web`, "include files
  outside root" on, pnpm from the root `packageManager`, and the two env vars.
- [ ] **Step 4:** Run the full gate: `pnpm --filter @workspace/web typecheck`,
  `lint`, `test`, `build`; then `apps/dashboard` vitest (expect 26/26); then
  `apps/worker` `pnpm test` + `pnpm typecheck` + `pnpm codemode:dts:check`
  against the baseline recorded at the start of the session.
- [ ] **Step 5:** Commit `docs(web): backend gaps, Vercel wiring and the README`.

---

## Self-Review

**Spec coverage.** §3 D1→T1, D2→T7, D3→T2, D4→T2/T6, D5→T3, D6→T3/T4, D7→T4,
D8→T1/T6. §4 layout→T1–T11. §5 shell→T6, dashboard 1–8→T7/T8/T9/T10, chat→T11.
§6 state→T4/T5. §7 verification→T12. §8 the `@source` fix→T1 step 4. §9 out of
scope→T12 step 1. No section is unclaimed.

**Placeholders.** None: no "TBD", no "handle edge cases", no "similar to Task N".
Where a step says "port from the SPA" it names the exact source file.

**Type consistency.** `PanelState<T>` is defined once in Task 4's interface
block and consumed under that name in Tasks 5–10. `CardState` and `DecideAction`
originate in Task 3 (ported types) and are used unchanged in Tasks 4 and 9.
`ago(thenMs, nowMs)` keeps the SPA's signature so both apps agree on "now".
`deriveFunnel` is defined in Task 7 and used nowhere else.
