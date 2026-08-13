# Phase 15 — Run List + Live Run Drawer — Execution Notes

Branch: `phase-15-16` (worktree `../firefighter-ui`). Zero worker files changed, as the plan requires.

## Commits

| Wave | Task | Commit | Subject |
|---|---|---|---|
| A | 1 | `1510d5b` | `feat(dashboard): typed runs API layer` |
| A | 2 | `e630aef` | `feat(dashboard): pure session reducer over the run event protocol` |
| B | 3 | `e5c7deb` | `feat(dashboard): reconnecting run socket with ack-or-HTTP steering` |
| B | 4 | `26a5bfd` | `feat(dashboard): the one session component` |
| C | 5 | `dd3ffc0` | `feat(dashboard): run list and drawer chrome` |
| D | 6 | see below | `feat(dashboard): watch and steer any run from the drawer` |

## Contract corrections against the worker (the worker is the authority)

Two of the plan's "Public contracts" entries were stale sketches. Pinned from source:

1. **`GET /api/runs` rows are `RunListItem`, not `publicRun`.** They carry `channelName` and
   `customerSlug` (joined from `channels`) and have **no `threadTs`**. `threadTs` exists only on
   the detail route's `run`. The dashboard therefore models two shapes — `RunSummary` (list) and
   `RunDetail` (snapshot) — rather than the plan's single `RunSummary`.
2. **`POST /api/runs/:id/turns` answers `201`, not `200`.** The local `postJson` gates on
   `response.ok` for exactly this reason.

`postJson` was kept local to `src/runs/api.ts` rather than lifted into `lib/api.ts`: Phase 16 lands
its own `patchJson` in `src/approvals/api.ts` under the same rule, and a shared writer is worth
extracting when there is a third, not a second.

## Bug caught in review (Task 3, deep-review task)

The hook originally fired `fetchRunSnapshot` **concurrently** with the socket open. Because
`reduceSession`'s `sync` branch rebuilds the transcript from its own events — which is precisely
what makes reconnect replay duplicate-proof — a snapshot taken at cursor 20 that resolved *after*
the socket had already streamed events 21–25 would delete those five events, and the socket would
never resend them. A silent, permanent gap, on the phase's headline invariant.

Fixed by making the snapshot lose to anything newer: `if (cursorRef.current > sync.cursor) return;`.
Racing the two is fine; letting the loser overwrite the winner is not.

## Live verification against `wrangler dev`

Local D1 in a fresh worktree has no schema, so `wrangler d1 migrations apply firefighter --local`
was run first (reads `apps/worker/migrations/**`, writes only this worktree's `.wrangler` state —
no worker file was modified).

Scripted run created with the plan's own command:

```
curl -X POST localhost:8787/api/runs -H 'content-type: application/json' \
  -d '{"firstMessage":"summarize what you can do"}'
```

Verified against the real worker:

- **List shape matches the pinned types exactly**, `channelName`/`customerSlug` present, no `threadTs`.
- **Snapshot** returns `{run, driver, model, events, cursor, complete}` with a well-formed event
  stream (`turn` seq 1, `status` seq 2–3) and `cursor: 3`.
- **Usage total is a decimal string**: `"totalCostUsd":"0.000000000"` — rendered verbatim, never coerced.
- **Steer idempotency proven live, end to end.** `POST /api/runs/:id/turns` with
  `requestId: "visual-pass-1"` → `201`. The *same* requestId replayed → `{"seq":4,"appended":false}`.
  That is the exact double-steer defence the socket-then-HTTP fallback relies on, confirmed against
  the worker rather than against a mock.
- **Vite dev + proxy**: SPA `200` on `:5173`, `/api/runs` proxied through to `:8787` correctly.

Both processes were killed afterwards; ports 8787 and 5173 released.

## DEFERRED GATE — the browser-eyes half of the visual pass

Not deferred for a port conflict; deferred because this environment cannot produce the conditions:

1. **`/api/identity` returns 401 locally** (no Cloudflare Access JWT), so `App` renders
   `SignedOutPage` and the run list and drawer are unreachable in a browser here. This is a
   pre-existing Phase 14 condition, not something Phase 15 introduced.
2. **No model credentials.** The scripted run failed immediately with
   `driver.error: "missing_anthropic_key"` / `missingConfiguration: [ANTHROPIC_API_KEY,
   AI_GATEWAY_ANTHROPIC_URL, AI_GATEWAY_TOKEN]`, so there is no live agent loop to stream, no
   assistant draft, and no tool call to expand.

Consequently **unverified by eye** and owed before the phase can be called visually done:

- [ ] the drawer streaming a run live over the socket, with tool calls collapsing/expanding
- [ ] two tabs on the same run showing identical streams
- [ ] devtools-offline → disconnect banner, bounded backoff, gapless resume from the cursor
- [ ] a steer typed mid-run appearing and changing the next step
- [ ] the pulsing live indicator on a genuinely `live` run

The reducer's correctness — seq-dedupe, sync-replace-without-duplication, the whole assistant
lifecycle including `superseded`-is-not-an-error — is covered by 21 node tests, which is where the
plan put the risk. The list above is chrome and transport under real network conditions.

## Gate

- `pnpm --filter @workspace/dashboard build` — green (tsc + vite, 75 modules).
- `pnpm exec vitest run test/session-reducer.test.ts test/runs-api.test.ts` — 2 files, 32 tests, all passing.
