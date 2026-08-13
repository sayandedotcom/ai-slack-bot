# Phase 16 — Approval Card — Execution Notes

Branch: `phase-15-16` (worktree `../firefighter-ui`), executed after Phase 15 on the same branch.
Zero worker files changed.

## Commits

| Wave | Task | Commit | Subject |
|---|---|---|---|
| A | 1 | `ed72a8f` | `feat(dashboard): typed approvals API with the 409 winner contract` |
| B | 2 | `f0623a1` | `feat(dashboard): approval card state machine — optimistic, 409-honest, never a silent vanish` |
| B | 3 | `d8daddd` | `feat(dashboard): approval card with inline edit and required reject reason` |
| C | 4 | see below | `feat(dashboard): approvals panel pinned above the fold` |

## THE CONTRACT CORRECTION — the 409 body carries no `decidedBy`

The plan's Public contracts sketch says `409 {decision, decidedBy}` (winner). **The worker sends
only `{code, message, decision}`.** From `apps/worker/src/api/approvals.ts`:

```ts
return c.json({ ...fail("already_decided", "already decided"), decision: result.row.decision }, 409);
```

The decider's name exists **only** on `GET /api/approvals/:id`. This is not cosmetic — the plan's
own Task 3 copy ("{decidedBy} approved this before you") cannot be rendered from the 409 alone.

Resolved without weakening invariant 3 ("rollback is the 409 contract, not a refetch race") by
splitting the two facts by source:

- The winning **decision** comes from the 409 body and only from there. No refetch can change it.
- The decider's **name** is filled in afterwards by one opportunistic `fetchApproval(id)` whose only
  permitted effect is setting `decidedBy` on a card that is *already* `resolved`. It is guarded
  three ways (entry still exists, still `kind === "resolved"`, still `decidedBy === null`), never
  touches the decision, never moves the card out of `resolved`, and its failure is invisible.
- The card therefore renders a **name-less conflict variant** ("Someone else approved this first")
  as a first-class, common case rather than an edge case — and generalises over the decision verb,
  so a conflict whose winner rejected reads "Someone else rejected this first".

## Other decisions worth recording

- `patchJson` lives in `src/approvals/api.ts`, not `lib/api.ts` — same rule Phase 15 applied to its
  `postJson`. It returns `{status, body}` instead of throwing, because `decide` must read the 409
  body as *data*: a conflict is a normal outcome, not an error. `decide` never throws on any path.
- **Vanish reconciliation** detects a disappearance by diffing the previous poll's id set against
  the current one, skips ids with a local decision (the poll is the stale one there), and is guarded
  at-most-once per id by a ref set *before* the fetch starts, so a poll landing mid-flight cannot
  start a second. The card is held visible from the last polled row for the round trip, so it does
  not flicker out and back in.
- Caught in review: `useApprovals` returned its own empty hint ("Nothing is waiting on you"), which
  meant the panel's graded reassurance copy was dead code — the hook never emits a ready-empty list
  for the panel to override. The hook now carries the plan's copy, so both paths agree.
- The panel is mounted with `role={identity?.role ?? "viewer"}`. Defaulting to `viewer` while
  identity is still loading is the safe direction: actions stay disabled until the role is known.

## Live verification against `wrangler dev`

One open approval seeded into local D1 (recorded verbatim, as the plan requires):

```
cd apps/worker && pnpm exec wrangler d1 execute firefighter --local --command \
"INSERT INTO approvals (id, run_id, generation_id, kind, draft, why, channel_id, thread_ts, shadow, decision, delivery, created_at, updated_at) VALUES ('apr:visual-pass-1', '<run-id>', 'gen:visual-1', 'slack_reply', 'We have rolled back the deploy that caused the 502s. Your data was not affected, and we will follow up with a post-mortem by Friday.', 'A committal promise about a post-mortem date, so a human should sign off.', 'C0ACME', '1786650000.000100', 0, 'pending', 'none', 1786656900000, 1786656900000);"
```

(The `run_id` must reference a real `runs` row; the Phase 15 scripted run was reused. A fresh
worktree also needs `pnpm exec wrangler d1 migrations apply firefighter --local` first.)

Result: **both approvals routes answer `401 {"code":"access_jwt_invalid","message":"token failed
verification: missing"}`** — `GET /api/approvals?state=open` and `PATCH /api/approvals/:id` alike.

## DEFERRED GATE — the visual pass

Deferred for an environmental blocker, not a port conflict (8787 and 5173 were free and were used):

**Every approvals route is behind Cloudflare Access**, and a valid Access JWT cannot be minted
locally — the verifier checks Cloudflare's JWKS for the real team domain
(`ACCESS_TEAM_DOMAIN=zellify-firefighter.cloudflareaccess.com`). So the seeded card cannot be read
by the dashboard, or by curl, from this machine. `/api/identity` 401s for the same reason, which
also makes `App` render `SignedOutPage` instead of the grid.

Owed before the phase can be called visually done, on an environment with an Access session:

- [ ] the seeded card renders within one 3 s poll, pinned above the fold
- [ ] approve → optimistic `deciding` → `resolved` "You approved this"
- [ ] a second seeded card decided directly in D1 mid-view → vanishes **with** the explanation
- [ ] reject stays disabled until a reason is typed
- [ ] a real 409 (two tabs racing) renders the winner, name-less then named
- [ ] viewer role sees everything, decides nothing ("fire-fighters decide")

What the 401s *do* confirm: the dashboard's `unauthorized` mapping is exercised by the real backend
on both routes, so the signed-out path is not theoretical.

## Gate

- `pnpm --filter @workspace/dashboard build` — green (tsc + vite, 79 modules).
- `pnpm exec vitest run` — 4 files, 51 tests, all passing (`api`, `runs-api`, `session-reducer`,
  `approvals-api`).
