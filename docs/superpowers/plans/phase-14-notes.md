# Phase 14 notes — verification record

Companion to `phase-14-dashboard-shell.md`. Executed in the worktree
`../firefighter-p12` on branch `phase-12-14`, immediately after Phase 12, while
Phase 11 ran concurrently in the main checkout.

**Operator decision, recorded verbatim:** this run is **local + automated
only**. No `wrangler dev`, no `vite dev`, no browser, and no deploy. The two
steps that need a live process are recorded below as deferred, not as passed.

---

## Phase 12 was on the branch, so there are no fixtures

The plan's soft dependency resolved the normal way: `GET /api/roster` and
`GET /api/identity` were already mounted (commit `762a412`) before Task 4
started. `src/lib/fixtures.ts` was therefore **never created**, and the rotation
strip and connect panel call the real endpoints. There is no fetch-swap
follow-up outstanding.

## One deviation from the plan's wave C, and why

The plan schedules Tasks 3–6 concurrently as "four disjoint component files".
They are not quite disjoint: each task's Step 1 also mounts its component into
`src/app.tsx`, so four concurrent agents would have raced on one file. Each
task was dispatched to create *only* its own component; the orchestrator did
all of the `app.tsx` wiring afterwards, in one edit. Same result, no lost
writes.

The shared-`Roster` requirement from Task 5 shaped that wiring: `app.tsx` owns
the single `usePoll(getRoster, 60_000)` and the single `useIdentity()`, and
passes the resulting `PanelState<Roster>` down to both `RotationStrip` and
`ConnectPanel` as a prop. Two polls for one document would have meant two
requests a minute and two copies that could disagree on screen.

## `lucide-react` does not resolve from `apps/dashboard`

It is a dependency of `@workspace/ui`, not of the dashboard, and pnpm's
isolated `node_modules` does not hoist it into the dashboard's resolution
scope. Both the connect panel and the header hit `TS2307` reaching for it and
fell back to plain characters. Adding it as a direct dependency of
`@workspace/dashboard` would be the fix — deliberately NOT done here, because
"no extra dependencies beyond what Task 1 names" is one of this phase's speed
rules and a check glyph is not worth a review question.

## The SPA fallback needed a Worker-side guard — a real regression, caught by the suite

`"not_found_handling": "single-page-application"` is what makes a hard refresh
on a client-side path work, and it applies to **every** unmatched path, not
only the ones that look like SPA routes. With it on and nothing else changed,
`/api/anything-misspelled` returned `index.html` with a **200**.

`test/api-artifacts.test.ts` > "404s a traversal attempt" caught it: the key
`..` normalizes the URL to `/api/`, which matches no route, fell through to the
asset catch-all, and the route's deliberate one-404-for-every-failure became a
200 with an HTML body. It would also have broken the dashboard's own error
mapping — `getJson` would parse HTML, fail, and report "backend unreachable"
instead of the plain 404 it was.

Fix, in `src/index.ts` directly above the asset catch-all and below every
mount:

```ts
app.all("/api/*", (c) => c.json({ code: "not_found", message: "no such route" }, 404));
app.all("/ws/*",  (c) => c.json({ code: "not_found", message: "no such route" }, 404));
```

## Gates

```
cd apps/dashboard && pnpm build          → tsc --noEmit clean, vite build ok, dist/index.html written
cd apps/dashboard && pnpm exec vitest run test/api.test.ts   → 10 passed
cd apps/worker   && pnpm exec tsc --noEmit -p tsconfig.json  → exit 0, no output
cd apps/worker   && pnpm exec vitest run
  → Test Files  1 failed | 81 passed (82)
    Tests       1 failed | 1526 passed | 2 skipped (1529)
```

The one failure is the same inherited one recorded in `phase-12-notes.md`:
`test/agent-cost.test.ts` asserts `not.toContain("0007")`, a Phase-10 guard that
Phase 11 obsoleted when it landed `migrations/0007_approvals.sql`. Verified
present and already failing at the branch base `e2210cc`. Not fixed from this
worktree — see that file for why, and for the merge follow-up.

`apps/web` is deleted, and `rg` finds no reference to it outside the plan docs
that describe deleting it. `apps/worker/public` (one placeholder `index.html`)
went with it.

`apps/worker/package.json` gained `@workspace/dashboard` as a **devDependency**.
The plan says "workspace topology handles it" — it only does if a dependency
edge exists, and none did: turbo's `build` has `dependsOn: ["^build"]`, which
orders nothing without an edge. `dist/` is gitignored, so without this a fresh
checkout's `wrangler dev` (and the vitest pool, which reads `wrangler.jsonc`)
would find no assets directory. The explicit
`deploy: "pnpm --filter @workspace/dashboard build && wrangler deploy"` prefix
is the belt to that suspenders.

---

## Deferred — NOT RUN

### G14-1 — The one visual pass (plan Task 7 Step 4)

Deferred because it needs `wrangler dev` on port 8787 plus a Vite dev server,
and Phase 11 was running in the other terminal — a port collision would have
disrupted that run rather than this one.

```
# Terminal A
cd apps/worker && pnpm exec wrangler dev
# Terminal B
cd apps/dashboard && pnpm dev
```

Open the Vite URL and confirm, then record here:
- all four panels in their ready states (header identity + role badge, rotation
  strip, connect panel, counters);
- the empty state: counters all zero reads "Quiet — nothing needed the agent in
  the last 24h.";
- kill the API process and confirm every panel's error state offers a way
  forward (Retry button, "Backend unreachable");
- an unauthenticated request renders the full-page "Signed out" state rather
  than four broken panels.

Kill both processes afterwards.

### G14-2 — Deploy and the SPA-fallback proof (plan Task 7 Step 5)

Deferred with G14-1 — deploying from this worktree while Phase 11 is mid-run
would ship a half-merged tree.

```
cd apps/worker && pnpm deploy      # builds the dashboard first, then wrangler deploy
```

Then, through Access: the SPA serves at the workers.dev origin, `/api/health`
still answers JSON, a hard refresh on a client-side path returns the SPA (the
`single-page-application` proof), and `/api/nonsense` returns a JSON 404 rather
than HTML (the guard above).

Note this also depends on Phase 12's release gates — `IDENTITY_KEY` and the
four OAuth client secrets are unset, so until G12-1 the connect buttons lead to
a 503 naming the missing variable. That is the designed unconfigured state, and
it is what a deploy today would show.
