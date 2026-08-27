# `apps/web` — the Next.js front-end

The dashboard and chat surfaces, on Next.js App Router, deployable to Vercel.
It sits **beside** `apps/dashboard` rather than replacing it: the Worker still
builds and serves the Vite SPA as its `ASSETS` bundle, and `pnpm run deploy` in
`apps/worker` is unaffected.

Three surfaces: `/` the dashboard, `/chat` to start a run, `/runs/[id]` for one
run live over its own socket.

Read `BACKEND-GAPS.md` before deploying it live. The short version: Cloudflare
Access issues its cookie for the Worker's hostname, so a browser on a Vercel
origin carries no credential and every live request 401s — and the run socket
fails for the same reason, harder. Until that is answered,
`NEXT_PUBLIC_DEMO=1` is what you deploy.

## Running it

```bash
pnpm install                                    # repo root, once
cd apps/web

NEXT_PUBLIC_DEMO=1 pnpm dev                     # :3000, fixtures, no backend

# against `wrangler dev` in apps/worker. BOTH variables: the first is the
# rewrite target for /api/*, the second is where the run socket dials, because
# a Next rewrite does not carry a WebSocket upgrade.
WORKER_ORIGIN=http://localhost:8787 \
NEXT_PUBLIC_WORKER_ORIGIN=http://localhost:8787 pnpm dev

pnpm typecheck          # tsc --noEmit
pnpm test               # vitest
pnpm build              # next build

# Lint and format are Biome, run ONCE at the repository root — there is no
# per-workspace lint script here or in any other workspace.
pnpm lint               # from the repo root: biome ci .
pnpm format             # from the repo root: biome check --write .
```

`pnpm dev` with neither variable set starts with no rewrite target, so every
`/api` call 404s against Next itself. Pick one.

**Three routes do not work against `wrangler dev`, and cannot be made to.**
`POST /api/runs`, `GET /api/runs/:id` and the run socket all sit behind
`requireTeamMember`, which verifies a real Access JWT — and `wrangler dev` has
no Cloudflare Access in front of it, so all three answer 401 locally. The runs
list, counters, roster and approvals are fine; starting a run and opening a
transcript are not. The Vite dashboard has the same hole and says so in
`apps/dashboard/dev-stubs.ts`, which deliberately does **not** stub them: a
faked create hands back an id whose socket then refuses, which reads as a bug
in the run view rather than as the absence of Access. Exercise those three
against a deployed Worker behind the real Access application, or use
`NEXT_PUBLIC_DEMO=1`.

## Environment

Three variables, all in `.env.example`.

| Name | Where | What it does |
| --- | --- | --- |
| `NEXT_PUBLIC_DEMO` | build + client | `"1"` serves fixtures and never opens a socket. Inlined at build time, so a live build drops the fixture tree entirely. |
| `WORKER_ORIGIN` | build (server) | Origin the `/api/*` and `/proofs/*` rewrites point at. No trailing slash. Ignored in demo mode. |
| `NEXT_PUBLIC_WORKER_ORIGIN` | build + client | Host the run socket dials. Leave empty when this app is served from the Worker's own origin. |

No token reaches the client bundle. Every REST caller in `lib/api` uses a
relative path and `next.config.ts` rewrites it — the same one-origin property
the Worker gives the Vite SPA for free.

The socket is the one exception, and it has to be: a Next rewrite proxies an
HTTP request and does not carry a WebSocket upgrade, so the Worker's host has
to be in the bundle. It is a hostname and nothing more — the Worker still runs
`requireTeamMember` on the upgrade (`src/api/agents.ts`) before it names the
Durable Object.

## Deploying to Vercel

- **Root Directory:** `apps/web`, with *Include files outside of the Root
  Directory* enabled — the app imports `@workspace/ui` from source.
- **Package manager:** pnpm 10.33.4, picked up from the root `packageManager`
  field. No override needed.
- **Build command:** the default `next build` is correct. Vercel installs from
  the workspace root, so `@workspace/ui` resolves.
- **Environment:** `NEXT_PUBLIC_DEMO=1` for now. Add `WORKER_ORIGIN` and
  `NEXT_PUBLIC_WORKER_ORIGIN` and drop the demo flag once BACKEND-GAPS.md §1
  has an answer.

`transpilePackages: ["@workspace/ui"]` in `next.config.ts` is load-bearing:
`@workspace/ui` ships raw `.tsx` from `src/` with no build step of its own.

## How it is put together

**Components come from `packages/ui` and only from there.** Every shadcn
primitive was installed into that package (its `components.json` aliases
there); `apps/web/components.json` aliases `ui` → `@workspace/ui/components`,
so `npx shadcn@latest add <thing>` from this directory keeps splitting them
that way. Nothing in `apps/web/components` is a primitive — they are all
compositions of one.

**Reads go through TanStack Query; one thing goes through Zustand.** The cache
is why the panels can each ask for what they need: the speaker hero and the
team table both call `useRoster()`, and one request is made. `toPanelState`
bridges a query into the four-state contract every panel renders through, and
it asks about `data` *before* the error — TanStack retains the previous data on
a failed refetch, so a panel that already has something to show never blinks to
an error banner because one background poll failed.

The one piece of genuine client state is the approvals overlay
(`lib/store/approvals-overlay.ts`): a decided card lingers as a transient note,
it is read by both the queue and the sidebar badge, it outlives any component's
mount, and it owns timers. Its rule is that it never invents a decision — only
a 200, a 409, or a detail read can resolve a card, and a network failure puts
the card back to `open` with a sentence on it. That rule is tested directly,
without rendering anything.

Selected run lives in `?run=`, sidebar state in `SidebarProvider`'s cookie,
theme in `next-themes`, and a half-typed rejection reason in the card that owns
it. None of those belong in a store.

**Type carries provenance.** IBM Plex Mono for anything a machine produced —
channel ids, thread keys, run uuids, counts, capability calls — and Plex Sans
for anything a person wrote. The agent's draft reply is set in sans on purpose:
the product's whole claim is that it will read as though the fire-fighter wrote
it, so it must not look machine-made on the page where somebody approves it.

**Two write surfaces, and both are gated twice.** Approvals go out over
`PATCH /api/approvals/:id`; channel policy over `PATCH /api/channels/:id`,
which is fire-fighters only. In both cases the UI hides the controls a viewer
cannot use, and in both cases that is a courtesy rather than the enforcement —
the Worker refuses either write before it touches D1.

The channel panel never predicts `slugSource`. Confirming a customer promotes
it to `human` and clearing it drops back to `derived`, both inside the Worker's
one UPDATE, so the row it returns is what goes into the cache.

**A run has one write, and it is `steer`.** The Worker drops five client frames
from every socket connection (`src/run/transport.ts`), so a "send a message"
path would fail silently. `lib/hooks/use-run-agent.ts` exposes exactly one verb
and the composer on `/runs/[id]` says *Steer*, not *Send*. Approvals are decided
in the transcript where the reader already is, but the decision still leaves
over `PATCH /api/approvals/:id` — the roster check and the D1 CAS are not
bypassed by where the card is drawn.

The two request-id rules are opposites and both are pinned in
`test/run-idempotency.test.ts`: a **create** reuses its id across retries (it
may have arrived and written a run), a **steer** mints a fresh one (it may
never have arrived, and a duplicate id would be refused).

**The funnel is the one bold element.** Four stat tiles would say "here are four
numbers"; what is true is an attenuation, so each stage carries a bar scaled
against what came in and they visibly collapse across the row. Ember is spent on
exactly one stage — `escalated` — the only one that costs a person's attention.
