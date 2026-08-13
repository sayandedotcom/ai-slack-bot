# Phase 12 notes — verification record

Companion to `phase-12-identity-oauth-rotation.md`.

**Operator decision, recorded verbatim:** this implementation run is
**local + automated only**, executed in the worktree `../firefighter-p12` on
branch `phase-12-14` while Phase 11 ran concurrently in the main checkout. No
live Slack or GitHub OAuth app was registered, no `wrangler secret put` was
run, no remote D1 migration was applied, and no account state was read. Every
live step is recorded below as a release gate, not as something that passed.

---

## Baseline

| Thing | Value |
| --- | --- |
| Worktree branch | `phase-12-14` (worktree `../firefighter-p12`) |
| Branch base | `e2210cc` (`fix(api): remove the pre-identity verify breaker...`) |
| Migration this phase owns | `0008_identities.sql`, and nothing else |
| Shared file touched | `apps/worker/src/index.ts` — route mounts + five optional `Env` fields only |

### Full-suite gate (Task 7 Step 3), run once

```
cd apps/worker && pnpm exec tsc --noEmit -p tsconfig.json   → exit 0, no output
cd apps/worker && pnpm exec vitest run
  → Test Files  1 failed | 81 passed (82)
    Tests       1 failed | 1526 passed | 2 skipped (1529)
```

**The one failure is inherited, not caused here.**
`test/agent-cost.test.ts` > "0006 migration properties" asserts
`expect(numbers).not.toContain("0007")`, with the comment "Phase 11's
approvals migration is 0007 and is not this task's to write." That guard was
correct when Phase 10 wrote it and became false the moment Phase 11 landed
`migrations/0007_approvals.sql`. Verified against the branch base:
`git ls-tree e2210cc apps/worker/migrations/` already lists
`0007_approvals.sql`, and the assertion is present unchanged at that commit —
so the suite was already red before this branch existed.

Left unfixed ON PURPOSE. The stale line belongs to Phase 11's migration, and
Phase 11 was executing concurrently in the main checkout; editing its test file
from this worktree buys a rebase conflict for a one-line deletion that its own
run should make. **Follow-up for whoever merges:** delete that assertion (or
retarget it at `0009`) once both branches are in.

Phase 12's own files are green: `rotation`, `identity-crypto`, `identities-db`,
`oauth-state`, `oauth-slack`, `oauth-github`, `api-identity` — 7 files, all
passing, inside the run above.

---

## Unconfirmed answers carried in code

Both are one-line diffs plus a re-run of `test/rotation.test.ts` when the
answer arrives. Both carry `// UNCONFIRMED` at the definition.

| Assumption | Where | Risk if wrong |
| --- | --- | --- |
| `ROTATION_EPOCH_MS = Date.parse("2026-08-10T00:00:00Z")` | `src/identity/rotation.ts` | An epoch off by a day silently nudges the wrong person. |
| Rotation ORDER `ronit → luka → mikheil → zurab` | `src/identity/rotation.ts` | Same: the strip names the wrong fire-fighter, and Phase 13's sender picks the wrong token. |

`ROTATION` is deliberately kept separate from `FIREFIGHTERS`
(`src/access/roster.ts`): the personal-override email `sayandeten@gmail.com`
is in `FIREFIGHTERS` for approval-PATCH rights, and `test/rotation.test.ts`
asserts across 30 sampled days that it never appears on duty.

---

## Release gates — NOT RUN, deferred live steps

These are Task 7 Step 5 of the plan. Nothing in this phase is provable in
production until they are done, and none of them was attempted in this run.

### G12-1 — Generate and install the five secrets

```
openssl rand -base64 32                 # → IDENTITY_KEY, must decode to 32 bytes
cd apps/worker
pnpm exec wrangler secret put IDENTITY_KEY
pnpm exec wrangler secret put SLACK_CLIENT_ID
pnpm exec wrangler secret put SLACK_CLIENT_SECRET
pnpm exec wrangler secret put GITHUB_CLIENT_ID
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
```

Locally the same five go in `.dev.vars` (see `.dev.vars.example`, updated in
Task 7). Until they exist, every identity/OAuth route answers **503 naming the
missing variable** — that is the designed state of an unconfigured checkout,
not a failure.

Note on rotation: replacing `IDENTITY_KEY` makes every existing `identities`
row un-openable. `getDecryptedToken` throws `SealError` rather than reporting
"not connected", so a rotation means every fire-fighter re-connects both
accounts. Deliberate — silently reading a mis-rotated key as "nobody is
connected" would hide the mistake.

### G12-2 — Register the callback URLs

- Slack app → OAuth & Permissions → Redirect URLs:
  `https://firefighter.sayandeten.workers.dev/api/oauth/slack/callback`
  (the redirect URI is derived from the request origin, so localhost needs its
  own entry to test locally).
  **If the production Slack app is Ronit's to edit**, register a personal test
  app, connect against that, and record the swap to the production app as its
  own gate.
- GitHub → Settings → Developer settings → OAuth Apps → new OAuth app,
  Authorization callback URL
  `https://firefighter.sayandeten.workers.dev/api/oauth/github/callback`.
  A plain OAuth app, not a GitHub App — see the plan's "What this phase
  deliberately does not do". If the pending answer says GitHub App, only
  `src/oauth/github.ts` changes.

### G12-3 — Apply migration 0008 remotely

```
cd apps/worker && pnpm exec wrangler d1 migrations apply firefighter --remote
```

### G12-4 — Connect two accounts end to end

Load the dashboard through Access, click Connect Slack and Connect GitHub, and
confirm afterwards that `SELECT email, provider, external_id FROM identities`
shows two rows and that no column of either row is a usable credential.
Record the result here.

---

## What this phase deliberately did not do

- **No sending.** The Slack user token is stored and never used;
  `ApprovalSender` stays identity-refusing until Phase 13 Task 5b.
- **No token refresh machinery.** Slack user tokens and GitHub OAuth-app
  tokens do not expire on a schedule; revocation surfaces as a 401 at use
  time, which is Phase 13/20's error path.
- **No roster UI or roster storage.** The roster stays hardcoded in
  `src/access/roster.ts`.
