# Phase 14 — Dashboard Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cold visitor understands the page in 30 seconds: who is on duty, who is connected, what the system has been doing — served from the same Worker origin.

**Architecture:** New `apps/dashboard` (Vite + React 19 + Tailwind 4, consuming `packages/ui`'s shadcn components). The Worker's existing Workers Assets binding serves the built SPA; `run_worker_first` already routes `/api/*` and `/ws/*` to Hono and everything else to assets. One `Panel` primitive owns loading/empty/error states so every panel inherits them instead of reimplementing them.

**Tech Stack:** Vite 7, React 19.2, Tailwind 4 (`@tailwindcss/vite`), `@workspace/ui`, Workers Assets (`single-page-application` fallback).

**Spec:** `docs/superpowers/specs/2026-08-10-firefighter-agent-design.md` §10. Roadmap entry: `00-roadmap.md` Phase 14 (dependency on 12 is **soft** — see below).

## Global Constraints

All of `00-roadmap.md` "Global Constraints" apply. The ones that bite here:

- **Loading, empty and error states for every panel** are graded deliverables, not polish.
- **Customer-facing copy rules apply to dashboard copy too:** direct, technical, no filler.
- **One origin.** No second deploy target, no CORS: the SPA calls relative `/api/...` paths.
- **Commit after every task.** Conventional prefixes.

## Depends on

Phase 05 (Access fronts the origin; `/api/counters` exists). Phase 12 supplies `GET /api/roster` and `GET /api/identity` — **soft**: if executing before 12 has merged into your branch, implement Tasks 4–6 against `src/lib/fixtures.ts` (defined in Task 4) and leave the one-line fetch-swap as the recorded follow-up. If 12 is already on your branch (the normal case when one terminal runs 12 then 14), skip the fixtures and call the real endpoints directly.

**Parallel-safe with Phase 11:** everything here lives in `apps/dashboard/` (new) except two mechanical worker-side edits (`wrangler.jsonc` assets block, `package.json` build script), which Phase 11 does not touch.

## Outcome

- `pnpm build && pnpm deploy` from `apps/worker` ships API + SPA as one origin behind the existing Access application.
- Header: product name, the signed-in Access identity, role badge.
- Rotation strip: who is on duty now, when it changes, who is next.
- Connect panel: per-engineer Slack/GitHub status with connect buttons (plain links to `/api/oauth/{provider}/start`).
- Counters panel: the four Phase 05 counters, polling live.
- Every panel renders sensibly in all four states: loading, loaded, empty, error-with-a-way-forward.

## What this phase deliberately does not do

- **No run list, no drawer, no chat, no approval card** — Phases 15–17. The shell leaves an obvious grid slot for them.
- **No client-side auth logic.** Access gates the origin; the SPA only *displays* identity. A 401/403 from `/api/identity` renders as a full-page "not signed in / not on the roster" state, not a login flow.
- **No test infrastructure for components.** Typecheck + build are the gates; the only vitest node tests are for pure logic (API-response parsing). Visual verification happens once, live, in Task 7. This is a deliberate speed call for a 7-day trial — do not scaffold jsdom/testing-library here.
- **No dark/light toggle.** One committed dark theme (packages/ui globals already define tokens).

## Non-negotiable invariants

1. **`apps/web` (the unused Next 16 scaffold) is deleted in this phase** — decision D2. One SPA, not two.
2. **Every fetch goes through `src/lib/api.ts`.** It is the one place that turns non-2xx into typed errors; components never call `fetch` directly.
3. **The `Panel` primitive is the only state machinery.** A new panel that hand-rolls its own spinner is a review rejection.
4. **No secrets, no tokens, no absolute backend URLs in the bundle.** Relative paths only.
5. **`pnpm dev` works locally**: Vite dev server proxies `/api` and `/ws` to `wrangler dev`'s port 8787.

## Public contracts

```ts
// src/lib/api.ts
export class ApiError extends Error { readonly status: number; readonly kind: "unauthorized" | "forbidden" | "unavailable"; }
export async function getJson<T>(path: string): Promise<T>;          // relative path, throws ApiError
export type Identity = { email: string; role: "firefighter" | "viewer" };
export type Shift = { email: string; index: number; shiftStartMs: number; shiftEndMs: number; nextEmail: string };
export type ConnectStatus = { email: string; role: "firefighter" | "viewer"; slack: boolean; github: boolean };
export type Roster = { onDuty: Shift; rotation: string[]; engineers: ConnectStatus[] };
export type Counters = { counters: { seen: number; triaged: number; woken: number; escalated: number }; since: number };

// src/components/panel.tsx
export type PanelState<T> = { kind: "loading" } | { kind: "error"; error: ApiError; retry: () => void }
  | { kind: "empty"; hint: string } | { kind: "ready"; data: T };
export function Panel<T>(props: { title: string; state: PanelState<T>; children: (data: T) => ReactNode }): ReactNode;

// src/lib/use-poll.ts
export function usePoll<T>(fetcher: () => Promise<T>, intervalMs: number): PanelState<T> & { refresh: () => void };
```

Phase 15–17 build on: the app shell's grid slot (`<main>` renders a `children` outlet), `Panel`, `usePoll`, and `api.ts`.

## File structure

- Create: `apps/dashboard/` — `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/app.tsx`, `src/lib/api.ts`, `src/lib/use-poll.ts`, `src/lib/fixtures.ts` (only if 12 absent), `src/components/panel.tsx`, `src/components/header.tsx`, `src/components/rotation-strip.tsx`, `src/components/connect-panel.tsx`, `src/components/counters-panel.tsx`, `test/api.test.ts`
- Modify: `apps/worker/wrangler.jsonc` (assets → `../dashboard/dist`, SPA fallback), `apps/worker/package.json` (build script builds the dashboard first), `turbo.json` only if the existing pipeline doesn't already give `build` dependsOn `^build`
- Delete: `apps/web/` entirely

## Execution speed rules — READ BEFORE DISPATCHING ANY TASK

1. **The gates are `pnpm --filter @workspace/dashboard build` and `tsc --noEmit` — not a test suite.** The only vitest file is `test/api.test.ts` (node environment, run by exact path: `cd apps/dashboard && pnpm exec vitest run test/api.test.ts`).
2. **One typecheck per task**, at the end.
3. **Do not leave `pnpm dev` running between tasks.** Boot it in Task 7 for the single visual pass, then kill it.
4. **Dispatch = the task's own text + Public contracts + these rules.** For component tasks, also grant read of `packages/ui/src/components` so imports are real, not guessed.
5. **Review depth:** deep for Tasks 1 and 7 (workspace + serving wiring — breakage here is invisible until deploy); light for 3–6 (components against a fixed contract).
6. **No extra dependencies** beyond what Task 1 names. Every new package is a review question.

### Parallel wave schedule

| Wave | Tasks (concurrent) | Why safe |
|---|---|---|
| A | **1** | scaffold — everything depends on it |
| B | **2** | shell + `Panel` + `api.ts` — the contracts every panel consumes |
| C | **3** ∥ **4** ∥ **5** ∥ **6** | four disjoint component files against wave B's contracts |
| D | **7** | worker wiring, `apps/web` deletion, gate, deploy |

## Task order

### Task 1 — Scaffold `apps/dashboard`

**Files:** create `apps/dashboard/{package.json,vite.config.ts,tsconfig.json,index.html,src/main.tsx,src/app.tsx}`.

- [ ] **Step 1: Package.** `apps/dashboard/package.json` name `@workspace/dashboard`, private; deps: `react`/`react-dom` `19.2.4` (pin to the workspace's existing versions), `@workspace/ui": "workspace:*"`; devDeps: `vite`, `@vitejs/plugin-react`, `tailwindcss@^4`, `@tailwindcss/vite`, `typescript@^5`, `@types/react`, `@types/react-dom`, `vitest`, `@workspace/typescript-config": "workspace:*"`. Scripts: `dev: "vite"`, `build: "tsc --noEmit -p tsconfig.json && vite build"`, `typecheck: "tsc --noEmit -p tsconfig.json"`.
- [ ] **Step 2: Vite config.**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
});
```

- [ ] **Step 3: Entry.** `index.html` with `<title>Fire-Fighter</title>` and a root div; `src/main.tsx` imports `@workspace/ui/globals.css` then mounts `<App/>`; `src/app.tsx` renders a placeholder `<h1>`. `tsconfig.json` extends `@workspace/typescript-config/react-library.json` (check the package for the exact exported name; fall back to the config `apps/web` used, since it is deleted in Task 7 anyway).
- [ ] **Step 4: Verify:** `pnpm install` (root), then `cd apps/dashboard && pnpm build` produces `dist/index.html`.
- [ ] **Step 5: Commit:** `feat(dashboard): scaffold Vite + React + Tailwind app consuming @workspace/ui`

### Task 2 — Shell, `Panel`, API client

**Files:** create `src/lib/api.ts`, `src/lib/use-poll.ts`, `src/components/panel.tsx`, `src/components/header.tsx`; modify `src/app.tsx`; create `test/api.test.ts`.

- [ ] **Step 1: Failing api test** (node env, stubbed `fetch`): 200 parses JSON; 401→`ApiError{kind:"unauthorized"}`; 403→`forbidden`; 500/network→`unavailable`; error message contains the path but never the response body.
- [ ] **Step 2: Implement `api.ts` + `use-poll.ts`.** `usePoll` fetches immediately, re-fetches on the interval with `setInterval` cleaned up on unmount, keeps the last good data during a background refresh, and downgrades to `error` only when there is no prior data (a panel that flickers to a spinner every 10s fails the cold-visitor test).
- [ ] **Step 3: Implement `Panel`.** Card chrome from `@workspace/ui` (`components/card`), a skeleton row for `loading`, the `hint` line for `empty`, and for `error` a one-line reason by `kind` (`"Sign in via Access"` / `"You're not on the roster"` / `"Backend unreachable"`) with a Retry button calling `retry`.
- [ ] **Step 4: Shell.** `app.tsx`: `<Header/>` + a responsive grid `<main>` with slots for the three Phase 14 panels and one visually-quiet placeholder slot labeled "Runs — Phase 15". `Header` shows the product name and, wired in Task 6, identity.
- [ ] **Step 5: Run `pnpm exec vitest run test/api.test.ts` + typecheck; verify PASS. Commit:** `feat(dashboard): app shell with Panel state primitive and typed API client`

### Task 3 — Counters panel

**Files:** create `src/components/counters-panel.tsx`; modify `src/app.tsx` (mount).

- [ ] **Step 1: Implement.** `usePoll(() => getJson<Counters>("/api/counters"), 10_000)`. Four stat tiles (seen / triaged / woken / escalated) with a "last 24h" caption derived from `since`. Empty state (`all zeros`) reads as reassurance: "Quiet — nothing needed the agent in the last 24h."
- [ ] **Step 2: Typecheck; commit:** `feat(dashboard): live counters panel`

### Task 4 — Rotation strip

**Files:** create `src/components/rotation-strip.tsx`; modify `src/app.tsx` (mount). If Phase 12 is absent from the branch: also create `src/lib/fixtures.ts` exporting `const FIXTURE_ROSTER: Roster` (four rotation emails, a plausible `onDuty`, seven engineers all disconnected) and fetch from it behind `const source = () => getJson<Roster>("/api/roster")` — the swap-back is deleting the fixture import.

- [ ] **Step 1: Implement.** One horizontal strip, not a card grid: **on duty now** (name, avatar-less initial badge, "until {date}"), then "next: {name} in {n}d {h}h", then the remaining rotation order dimmed. Countdown derived from `shiftEndMs` at render time; `usePoll` at 60s keeps it honest without a ticking timer.
- [ ] **Step 2: Typecheck; commit:** `feat(dashboard): rotation strip`

### Task 5 — Connect panel

**Files:** create `src/components/connect-panel.tsx`; modify `src/app.tsx` (mount). Same fixture fallback as Task 4 (shared `Roster` fetch — lift it into `app.tsx` and pass data down so the strip and this panel poll once, not twice).

- [ ] **Step 1: Implement.** One row per engineer: email, role badge, Slack and GitHub as either a green "connected" check or an outline "Connect" button — a plain `<a href="/api/oauth/slack/start">` (the browser carries the Access cookie; no JS needed). Viewers show "—" (viewers don't connect, per the roster contract). The signed-in user's own row is highlighted; other engineers' connect buttons render disabled with the tooltip "each engineer connects their own account".
- [ ] **Step 2: Typecheck; commit:** `feat(dashboard): per-engineer connect status panel`

### Task 6 — Identity in the header

**Files:** modify `src/components/header.tsx`, `src/app.tsx`.

- [ ] **Step 1: Implement.** One fetch of `/api/identity` at mount (no poll). Ready: email + role badge. `unauthorized`/`forbidden`: replace the entire grid with a full-page state — "Signed out — reload to re-authenticate with Access" / "This account isn't on the fire-fighter roster" — because every other panel would 401 in the same way; one honest message beats four broken panels.
- [ ] **Step 2: Typecheck; commit:** `feat(dashboard): Access identity in the header with signed-out full-page state`

### Task 7 — Serve from the Worker, delete `apps/web`, deploy

**Files:** modify `apps/worker/wrangler.jsonc`, `apps/worker/package.json`; delete `apps/web/`.

- [ ] **Step 1: Assets.** In `wrangler.jsonc`: `"assets": { "directory": "../dashboard/dist", "binding": "ASSETS", "run_worker_first": true, "not_found_handling": "single-page-application" }`. Delete the now-unused `apps/worker/public` directory if nothing else references it (`rg "public/" apps/worker` first).
- [ ] **Step 2: Build order.** In `apps/worker/package.json`, prefix the deploy script: `"deploy": "pnpm --filter @workspace/dashboard build && wrangler deploy"`. Verify turbo's `build` task already carries `"dependsOn": ["^build"]`; add `@workspace/dashboard` nothing further — workspace topology handles it.
- [ ] **Step 3: Delete `apps/web`.** `git rm -r apps/web`, then `rg -l "apps/web|@workspace/web" --glob '!pnpm-lock.yaml'` must return nothing; `pnpm install` to settle the lockfile.
- [ ] **Step 4: The one visual pass.** Terminal A: `cd apps/worker && pnpm exec wrangler dev`. Terminal B: `cd apps/dashboard && pnpm dev`. Open the Vite URL; verify all four panels in their ready states, then kill the API process and verify every panel's error state offers a way forward. Kill both processes.
- [ ] **Step 5: Gate + deploy.** `cd apps/worker && pnpm exec vitest run && pnpm exec tsc --noEmit -p tsconfig.json` (the worker suite — proves the wrangler.jsonc edit broke nothing), then `pnpm deploy`. Load the workers.dev origin through Access; confirm the SPA serves, `/api/health` still answers, and a hard refresh on a client-side path returns the SPA (SPA fallback proof).
- [ ] **Step 6: Commit:** `feat(dashboard): serve SPA from Workers Assets, remove apps/web`

## Test matrix

| Row | Proven by |
|---|---|
| ApiError mapping incl. no-body-echo | `test/api.test.ts` |
| SPA fallback + one-origin serving | Task 7 Step 5 live check |
| Worker regression after wrangler.jsonc edit | worker suite in Task 7 |
| All four panel states reachable | Task 7 Step 4 visual pass (recorded in `phase-14-notes.md`) |

## Exit criteria

Deployed behind Access, one origin. A cold visitor can say what the page does in 30 seconds: who's on duty, who's connected, whether the system is busy. `apps/web` is gone. Phase 15's drawer has a grid slot, `Panel`, `usePoll`, and `api.ts` waiting for it.

## Downstream handoff

- **Phase 15/16/17:** add panels/pages inside `apps/dashboard/src`, reusing `Panel` + `api.ts`; the WebSocket client is new work (15).
- **Phase 22:** the state sweep audits every `Panel` usage — keep `PanelState` the only state mechanism so the sweep is a grep, not an archaeology dig.
