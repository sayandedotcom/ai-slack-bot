# `apps/web` — the Next.js front-end

The dashboard and chat surfaces, on Next.js App Router, deployable to Vercel.
It sits **beside** `apps/dashboard` rather than replacing it: the Worker still
builds and serves the Vite SPA as its `ASSETS` bundle, and `pnpm run deploy` in
`apps/worker` is unaffected.

Read `BACKEND-GAPS.md` before deploying it live. The short version: Cloudflare
Access issues its cookie for the Worker's hostname, so a browser on a Vercel
origin carries no credential and every live request 401s. Until that is
answered, `NEXT_PUBLIC_DEMO=1` is what you deploy.

## Running it

```bash
pnpm install                                    # repo root, once
cd apps/web

NEXT_PUBLIC_DEMO=1 pnpm dev                     # :3000, fixtures, no backend
WORKER_ORIGIN=http://localhost:8787 pnpm dev    # against `wrangler dev` in apps/worker

pnpm typecheck          # tsc --noEmit
pnpm test               # vitest
pnpm lint
pnpm build              # next build
```

`pnpm dev` with neither variable set starts with no rewrite target, so every
`/api` call 404s against Next itself. Pick one.

## Environment

Two variables, both in `.env.example`.

| Name | Where | What it does |
| --- | --- | --- |
| `NEXT_PUBLIC_DEMO` | build + client | `"1"` serves fixtures and never opens a socket. Inlined at build time, so a live build drops the fixture tree entirely. |
| `WORKER_ORIGIN` | build (server) | Origin the `/api/*` and `/proofs/*` rewrites point at. No trailing slash. Ignored in demo mode. |

There is no backend URL and no token in the client bundle. Every caller in
`lib/api` uses a relative path, and `next.config.ts` rewrites it — the same
one-origin property the Worker gives the Vite SPA for free.

## Deploying to Vercel

- **Root Directory:** `apps/web`, with *Include files outside of the Root
  Directory* enabled — the app imports `@workspace/ui` from source.
- **Package manager:** pnpm 10.33.4, picked up from the root `packageManager`
  field. No override needed.
- **Build command:** the default `next build` is correct. Vercel installs from
  the workspace root, so `@workspace/ui` resolves.
- **Environment:** `NEXT_PUBLIC_DEMO=1` for now. Add `WORKER_ORIGIN` and drop
  the demo flag once BACKEND-GAPS.md §1 has an answer.

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

**The funnel is the one bold element.** Four stat tiles would say "here are four
numbers"; what is true is an attenuation, so each stage carries a bar scaled
against what came in and they visibly collapse across the row. Ember is spent on
exactly one stage — `escalated` — the only one that costs a person's attention.
