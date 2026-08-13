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
| `ApprovalPort.escalate`/`.withdraw` refuse HOST-SIDE via `openApprovalId()` before calling the port at all | The brief's contract shows `open()` and `withdraw()` with no "already open"/"nothing open" branch in their own signatures, and invariant 8 requires `approval_already_open` to leave no effect-ledger row ("nothing happened upstream"). Read together, the only shape that satisfies both is: the capability calls the SYNCHRONOUS `openApprovalId()` read first and refuses locally, never reaching `open()`/`withdraw()` at all on the refused path. Task 4's real port must keep `openApprovalId()` synchronous and side-effect-free for this to keep holding. | `test/codemode-approval.test.ts` ("refuses a second escalate... with no effect-ledger entry", "refuses with no effect-ledger entry either") |
| `makeCapabilityDependencies`'s `approval` port is a per-execution in-memory stand-in, not real storage | Task 3 owns the `ApprovalPort` interface and threading it through `src/agent/dependencies.ts`, but explicitly must not touch D1 or RunDO storage (that needs Task 4's schema-v3 migration, which does not exist yet). `makeInMemoryApprovalPort()` in `dependencies.ts` is a closure rebuilt fresh per `run_code` execution — correct within one execution, silently reset between executions — and is expected to be replaced wholesale by Task 4's real implementation, not extended. | `test/agent-composer.test.ts` ("exactly ten narrow ports"); no dedicated test exercises cross-execution persistence, because there is none yet by design |

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

---

## Task 8 — prompt judgment, memory, counter

**Dependency gap the task brief did not flag, resolved as directed by the
operator:** Step 1's memory assertion as literally written ("a generation
that settled `paused` and was later rejected") needs Task 4's reserved
`paused` outcome and Task 5's PATCH-driven resolution turn. Neither exists
yet. Per direction, the deferred assertion was **not** faked; instead:

- Verified the claim in invariant 13 directly: `TURN_SOURCES` in
  `src/run/session.ts:146-153` already accepts `source: "approval"`, and
  `WAKE_TURN_SOURCES` (`src/agent/contracts.ts:209`, reconfirmed at Task 0)
  already includes it. `readAsked()` (`src/run/session.ts:3280`) reads every
  input turn's `content` for the generation it answers, with no source-based
  filtering. So an approval-sourced turn's content — whatever Task 5 puts in
  it — reaches the next generation's episode `asked` field through the
  ordinary path, with zero changes needed in `src/agent/memory.ts` or
  `src/memory/episode.ts`. No new pipeline was added, matching invariant 13.
- Proved it empirically instead of arguing it: `test/memory-outbox.test.ts`
  ("approval outcomes reach memory through the existing outbox") runs a real
  two-generation loop through `freshLoopRun`, appends a second turn with
  `source: "approval"` carrying a rejection reason + original draft (and, in
  a second case, an edit's human text + the model's draft), and asserts both
  pieces of text land in the second generation's frozen `episodeJson.asked`.
  Both tests pass against unmodified `src/agent/memory.ts` / `src/memory/episode.ts`
  — the honest result the operator predicted.
- **Deferred, not written:** the exact assertion naming `paused` and a real
  `PATCH`-driven resolution turn. That needs Task 4 (driver `paused` member)
  and Task 5 (the resolution turn's actual content construction) to exist
  first. Nothing here should be read as claiming that path is covered — only
  the underlying mechanism it will rely on.

`src/agent/prompt/policy.ts`'s `phase_limitation` section ("There is no
escalation capability yet") was **removed**, not edited: Task 3 makes
`approval.escalate` / `approval.withdraw` real capabilities in this same
wave, so a policy sentence still claiming they don't exist would directly
contradict the rewritten `escalation_judgment` section and the tool's own
declaration doc comments. `STABLE_POLICY_SECTIONS` now has nine sections
(was ten); `test/agent-prompt.test.ts` updated to match.

---

## Task 6 — The HTTP API, and the JWKS key-miss amplification finding

**Port pattern reused, not invented.** `src/api/approvals.ts` mirrors
`src/agent/driver.ts`'s `RunPorts` shape (`installRunPorts` / `resolveRunPorts`
/ module-scope registry) for its own `ApprovalApiPorts` (`verifier`,
`notifier`): a plain object a test overrides before `SELF.fetch`, and
production fills the `verifier` gap lazily on first request (mirroring
`ensureRunPortsInstalled`'s "install once, only if nothing is there yet"
shape from `src/agent/ports.ts`). No per-key scoping — an approval route has
no run-key equivalent to scope by, and every test in this file resets the
registry itself, same as the unkeyed half of `installRunPorts`. `notifier` is
deliberately left unfilled by production composition: wiring `notify` to the
RunDO's real `resolveApproval` is wave D's single composition line, not this
task's, per the brief's explicit "decoupling" instruction. Until that lands,
a decided approval always reports `resolutionDelivered:false` and relies on
the sweeper to keep retrying — which is the same behavior the row would show
if the real DO happened to be unreachable, so nothing here is a special case.

**Finding: are the routes reachable without upstream Access enforcement?**
Yes, in the sense that matters for this task, and the evidence is in this
same checkout:

- `README.md`'s "Access and the temporary override" describes the *intended*
  edge gate — one Access application matching the whole
  `firefighter.sayandeten.workers.dev` host, covering `/api/*` (and
  therefore `/api/approvals/*`) with only `/slack/*` and `/oauth/*` carved out
  as explicit bypasses. If that application exists and is configured
  correctly, `/api/approvals` is gated exactly like `/api/runs` already is.
- But Task 0's own baseline (this file, "Access configuration") recorded
  `ACCESS_APP_AUD` as **still an unconfirmed placeholder**
  (`UNSET_SEE_PHASE_11_NOTES`) as of this session, and release gate G1 says
  the real AUD has not yet been read from the live Access application. That
  is a fact about configuration, not code, but it means this checkout cannot
  assert the Access application is actually standing guard today — only that
  the Worker's *own* code enforces nothing on its own. `src/access/jwt.ts`'s
  own header comment says it plainly: "a header being PRESENT is not the
  same as it being VALID". Nothing server-side refuses a request that never
  passed through Access; that refusal is Access's job alone, at the edge.
- So: whether `/api/approvals` is reachable unauthenticated on the live
  deployment right now is an operational fact this task cannot observe (no
  network access, no Cloudflare credentials in this environment) — but the
  honest worst-case assumption, given G1's open status, is "yes, possibly."
  Task 10's live-proof step re-runs the `curl` check from README.md's
  "Verifying the gate still lets ingest through" section against
  `/api/approvals` specifically before relying on Access for this route.

**Decision: mitigate at this layer, cheaply.** Task 2's review accepted, as a
deferred Minor, that `AccessVerifier`'s JWKS cache
(`src/access/jwt.ts`'s `resolveKey`) refetches on every key-miss rather than
respecting the 1-hour floor — bounded per `verify()` call, not globally. That
was theoretical while nothing called the verifier; this task is what makes it
reachable, and `resolveKey` runs the JWKS lookup *before* the signature is
even checked, so a syntactically-valid three-segment token with a fresh
random `kid` on every request is enough to force one real JWKS fetch per
request, with no valid signature required. If Cloudflare's JWKS endpoint
throttles under that load, authentication breaks for every real user, not
just the attacker.

This is **not** a redesign of Task 2's cache — that stays exactly as shipped,
per the dispatch's explicit instruction — and a redesign would be the wrong
place to spend this task's budget regardless: the real fix (a cache that
remembers "this `kid` doesn't exist" for some bounded time, independent of
the overall freshness floor) belongs in `src/access/jwt.ts` where the cache
already lives, not bolted onto one caller of it.

What *is* implemented, in `src/api/approvals.ts` (`requireIdentity`, the
"verify circuit breaker" section): a per-isolate cap of 30 failed
verifications per rolling 60-second window. Once tripped, further requests
in that window get `401 access_jwt_invalid` without the fake/real verifier's
`verify()` ever being called — so the worst case for this route is bounded to
30 JWKS-endpoint round trips per isolate per minute, regardless of how many
distinct `kid`s an attacker cycles through, rather than one round trip per
request unboundedly. A legitimate caller with an occasionally-stale token
sees no behavior change (they were already getting `401` on the one bad
attempt), the breaker self-clears every minute so a real Access key rotation
is never permanently locked out, and it costs nothing beyond one counter
check on the request path. Covered by
`test/approval-api.test.ts` > "the failed-verify circuit breaker (JWKS
amplification mitigation)", which drives 40 distinct failing "tokens" through
a counting fake verifier and asserts the fake was called fewer than 40 times.

This is a mitigation, not a fix: it bounds the blast radius at this one route
rather than closing the underlying gap, which is why `src/access/jwt.ts`
itself is untouched and the Minor from Task 2's review is still open at the
source. Recorded here per the dispatch's instruction that silence on this
question is not an acceptable answer.
