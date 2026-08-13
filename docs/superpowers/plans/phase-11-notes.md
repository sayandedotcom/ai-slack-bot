# Phase 11 notes — verification record

Companion to `phase-11-approval.md`. Task 0 produces this file before any
approval code is written; later tasks append to it. Every fact below was
checked on 2026-08-13 against this checkout, not carried over from the plan's
prose.

**Execution shape, recorded:** subagent-driven development, committing
**directly to `main`** (operator's choice, matching how phases 09 and 10
landed — the history has no merge commits). Tasks 1–9 are local + automated.
Task 10 is live and is gated on a fact this checkout does not have; see
"Release gates" below.

---

## Baseline

### Commit and versions

| Thing | Value |
| --- | --- |
| Branch | `main` |
| HEAD at Task 0 start | `3bd64ce` (`docs(plans): rewrite phase 11 against merged phase 10, roadmap follows`) |
| Planning baseline named by the plan | `b84f9f4` (Phase 10 merged + live fixes) |
| `git status --short` | clean |
| `ai` | `7.0.59` (installed) |
| `@ai-sdk/anthropic` | `^4.0.37` |
| `@cloudflare/codemode` | `0.5.1` (exact) |
| `wrangler` | `4.120.1` (installed) |
| `hono` | `^4.9.0` |
| `zod` | `4.4.3` (installed) |
| `vitest` / `@cloudflare/vitest-pool-workers` | `^4.1.0` / `^0.21.0` |
| `compatibility_date` | `2026-08-01`, flags `["nodejs_compat"]` |
| D1 migrations present | `0001`–`0006` (Phase 11 adds `0007_approvals.sql`) |

### Test / typecheck counts — reproduced, not taken on faith

```
pnpm --filter @workspace/worker typecheck   → tsc --noEmit, exit 0, no output
pnpm --filter @workspace/worker test        → vitest run
  Test Files  1 failed | 68 passed (69)
  Tests       1 failed | 1329 passed | 2 skipped (1332)
  Duration    104.69s
```

The plan predicted "69 files / 1329 passed". The file and pass counts match
exactly. The one failure is **not** a Phase 11 concern — see below.

### Known pre-existing flake (do not chase it)

`test/agent-failure-matrix.test.ts:632` intermittently fails under full-suite
load:

```
- "attempt": 2,  "phase": "running"      (expected)
+ "attempt": 0,  "phase": "idle"         (actual)
```

Re-run in isolation, the same file passes 13/13 (`pnpm vitest run
test/agent-failure-matrix.test.ts`, exit 0). The assertion reads driver state
"while it is in flight" after `reclaimed.wait()`, but nothing holds the
successor attempt open — on a loaded box the successor settles the run and the
driver clears `attempt` before the read lands. It is a test-side synchronization
gap, not a product defect: the same test still proves the real invariant
downstream (`lostOutcome.model === "claimed"` and the `aborted_stale_claim`
assertion), and those pass.

**Rule for this phase:** if this exact assertion fails, re-run that one file
before treating it as a regression. Task 9 owns
`test/agent-failure-matrix.test.ts` and closes the race there.

---

## Access configuration

| Thing | Value | Source |
| --- | --- | --- |
| Zero Trust team domain | `zellify-firefighter.cloudflareaccess.com` | `README.md:22`, corroborated by `phase-08-notes.md:427` (`/api/health` → 302 to that host) |
| `ACCESS_TEAM_DOMAIN` var | `zellify-firefighter.cloudflareaccess.com` | Task 2 sets it |
| `ACCESS_APP_AUD` var | **UNSET** — placeholder pending | see release gate G1 |

The Access application AUD could not be read from this checkout, and the
application itself may not be stood up yet (the manager's brief asks for Access
to be *put* in front of the dashboard, restricted to `@zellify.app`, with the
developer's personal email as a temporary policy override). Tasks 1–9 are
unaffected: every test injects a fake verifier, and production composition
reads the var.

## Roster — confirmed 2026-08-13

Confirmed by the operator relaying their manager. Two roles, hardcoded, seven
emails; "a hardcoded map of seven emails to roles is fine; nobody is judging
IAM here."

| Role | Emails | Rights |
| --- | --- | --- |
| Fire-fighters | `ronit@`, `luka@`, `mikheil@` (Misho), `zurab@` — all `@zellify.app` | 3-day rotation, connect Slack + GitHub, act on threads, **decide approvals** |
| Viewers | `marcus@`, `nils@`, `eric@` — all `@zellify.app` | dashboard + chat, no rotation, no OAuth, **read approvals only** |
| Temporary override | `sayandeten@gmail.com` | the developer building this; has no `@zellify.app` address |

The four fire-fighter emails are **confirmed**, so the plan's `// UNCONFIRMED`
tag (Task 0 Step 2 / Task 2 Step 3) does not apply to them.

**The override is placed in `FIREFIGHTERS`**, matching the plan's authorization
seam (`// 4 zellify.app emails + documented personal override`). Task 10's live
proof requires PATCH rights, which are fire-fighters-only. It carries a removal
tag in `src/access/roster.ts` and is listed as release gate G2.

## Release gates

| # | Gate | Blocks |
| --- | --- | --- |
| G1 | Read the real Access application AUD (Access → Applications → firefighter → Overview) and replace the `ACCESS_APP_AUD` placeholder. Until then a deployed Worker rejects every JWT — it fails **closed**, which is the safe direction. | Task 10 |
| G2 | Remove `sayandeten@gmail.com` from `src/access/roster.ts` **and** from the Cloudflare Access policy once the developer has a `@zellify.app` address or the engagement ends. Noted in `README.md` per the manager's instruction. | post-Phase-11 |

---

## Invented / assumed APIs

Recorded as they are used. An entry here means: the plan or the implementation
asserts a behaviour that was not read out of shipped source or vendor docs at
the time of writing, and a test pins it.

| API / behaviour | Assumption | Pinned by |
| --- | --- | --- |
| D1's `idx_approvals_one_open` UNIQUE-index violation message | On a real D1 insert that collides with the partial unique index, the thrown error's message contains exactly `UNIQUE constraint failed: approvals.run_id` — D1 names the violation by **column**, not by index name, even though the constraint is a partial unique index and `run_id` alone is not globally unique. `insertApproval` (`src/approval/repository.ts`) matches on this substring to map the violation to `duplicate_open`; anything else propagates. Confirmed empirically against the real workerd D1 pool while implementing Task 1 (`test/approval-repository.test.ts` > "one unsettled approval per run"). | `test/approval-repository.test.ts` |
| Cloudflare Access JWT claim shape (`src/access/jwt.ts`) | No real `Cf-Access-Jwt-Assertion` token was seen this session. Implementation assumes the standard Access shape documented publicly: header `{alg:"RS256", kid, typ:"JWT"}`; payload carries `iss` as `https://{team-domain}` (no trailing slash), `aud` as either a single string or an array of strings, `exp` as Unix seconds, and an `email` claim holding the authenticated user's address. JWKS at `https://{team-domain}/cdn-cgi/access/certs` is assumed to be a standard RFC 7517 `{keys:[...]}` document with each entry carrying `kid`. If the real document nests differently (e.g. `public_certs` instead of `keys`, as some older Access docs show), Task 6 or Task 10's live proof will surface it as every JWT failing `bad_signature` — fails closed, not open. | `test/access-jwt.test.ts` (mints its own RS256 keys/JWKS/JWT in-test to match this assumed shape) |

---

## Task 0 — plan gates re-checked against shipped code

The plan asks Task 0 to re-read the driver and finalize path "because Task 4
patches both and they may have drifted." Done; one gap found.

| Checked | Result |
| --- | --- |
| `src/agent/driver.ts:54` `ContinuationOutcome` | 3 members (`completed` / `failed` / `retry`). `driver.ts:51-53` carries a comment **forbidding** a `paused` member ("adding it here 'for later' is how it gets set by accident"). Task 4 replaces that comment, not just the type. |
| `src/agent/driver.ts:312` `toFinalizeRequest` | This — not an `applyOutcome` function, which does not exist — is the only path from a `ContinuationOutcome` to a persisted transition. |
| `src/agent/contracts.ts:447` `FinalizeRequest` | **Plan gap.** `driver.ts:47` calls `ContinuationOutcome` "deliberately one-to-one with `FinalizeRequest`", but the plan's "Driver contract extension" extends only the former, and Task 4's file list omits `src/agent/contracts.ts`. Task 4's real surface is `ContinuationOutcome` + `FinalizeRequest` + `toFinalizeRequest` + `finalizeGeneration`'s consumer in `src/run/session.ts`. |
| `WAKE_TURN_SOURCES` includes `"approval"` | Confirmed — the plan's claim holds. |
| `control_write` exempt from shadow/channel gating | Confirmed at `src/codemode/write-guard.ts:22-26,119`, which names Phase 11 as the owner of the run-state authorization it defers to. |
| Reserved seams already in place | `src/run/do.ts:128,494,884`, `src/run/session.ts:840,3399`, `src/agent/loop.ts:977`, `src/agent/transcript.ts:287`, `src/codemode/registry.ts:148`, `src/db/counters.ts:8` all name Phase 11 explicitly. |
