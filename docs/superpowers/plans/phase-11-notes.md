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
| `FinalizeRequest` gains a `paused` kind (Task 4) | **The plan never mentions it.** The plan's "Driver contract extension" extends `ContinuationOutcome` only, and Task 4's file list omits `src/agent/contracts.ts` entirely — but `driver.ts:47` calls the two types "deliberately one-to-one", `toFinalizeRequest()` is the ONLY path from an outcome to a persisted transition, and there is no `applyOutcome` function despite the plan's prose. So `FinalizeRequest` gains `{ kind:"paused"; approvalId }`, `FinalizeOutcome`'s `settled` gains an optional `pausedApprovalId`, and `GenerationRecord` gains `pausedApprovalId`. | `test/agent-pause.test.ts` ("maps the paused outcome onto a paused finalize request", plus every latch case) |
| The pause must ALSO latch inside `finalizeAnswer`, not only `finalizeGeneration` | The plan says the pause latches "at generation finalize", which reads as one function. There are two: `finalizeAnswer` (`session.ts`) is what actually settles a generation that produced an answer — it sets the generation terminal, the driver idle and the public status, all in its own transaction — so by the time the driver's `finalizeGeneration` runs it returns `already_settled` and can change nothing. Latching only there would mean the real production loop never parks, while every fake-continuation test passed. Both transactions now call the same `latchApprovalPause` helper. | `test/agent-pause.test.ts` (driver path) + the `finalizeAnswer` outcome carrying `pausedApprovalId` through `toContinuationOutcome` |
| RunDO local schema is **v6**, not the plan's "v3" | The plan was written when the local ledger stopped at v2; `main` ships v5. Inserting a second v3 would either be skipped as already applied or reorder a shipped migration, so Phase 11's migration is v6. The property the plan asks for is preserved: the upgrade keeps every Phase 10 row and is idempotent. | `test/agent-pause.test.ts` ("preserves Phase 10 state and is idempotent"), `test/agent-state.test.ts` (ledger) |
| `approval_state` carries a `generation_id` column the plan's pinned block does not show | The pinned RunDO block lists six columns. The D1 card's `generation_id` is `NOT NULL`, and at projection time there is no other honest source for it: `agent_driver.current_generation_id` is already NULL once the generation settled, and `agent_generations.paused_approval_id` is only written if the generation reached its finalize — which is exactly the crash the projection has to survive. The column is a strict addition; nothing pinned was changed. | `test/agent-pause.test.ts` ("delivers the D1 card through the alarm dispatcher", crash-recovery case) |
| `agent_projection_jobs.kind` had to be rebuilt to accept `approval_card` | The plan says the new kind "reuses the existing `agent_projection_jobs` table". It does — but that table's `kind` column carries a CHECK constraint naming exactly three kinds, and SQLite cannot alter a CHECK in place. v6 rebuilds the table (copy, drop, rename) rather than dropping the constraint, so a typo'd kind is still refused instead of parking forever with no runner. Self-idempotent: it inspects `sqlite_master` rather than trusting the ledger. | `test/agent-pause.test.ts` (all four projection cases; the migration case re-runs v6) |
| `RunCodeToolInput.approval` / `makeCapabilityDependencies`'s 4th parameter are REQUIRED | Task 3's stand-in is deleted, and the real port needs a `DurableObjectStorage` that `dependencies.ts` structurally cannot reach. The port is therefore built in `loop.ts` (which has `ctx`, the run's pinned Slack scope and the generation id) and handed down. Required rather than defaulted on purpose: the only possible default is one that pretends to work, which is the exact failure Task 3's stand-in had — escalations forgotten between executions, so no run could ever park. | compile-time (both call sites), `test/agent-pause.test.ts` (the port's real behaviour) |
| ~~`makeCapabilityDependencies`'s `approval` port is a per-execution in-memory stand-in~~ — **superseded by Task 4** | Task 3 owns the `ApprovalPort` interface and threading it through `src/agent/dependencies.ts`, but explicitly must not touch D1 or RunDO storage (that needs Task 4's schema-v3 migration, which does not exist yet). `makeInMemoryApprovalPort()` in `dependencies.ts` was a closure rebuilt fresh per `run_code` execution — correct within one execution, silently reset between executions. **Task 4 deleted it** and replaced it with `src/approval/port.ts`, the storage-backed port; it is reachable from no path, production or test. | `test/agent-composer.test.ts` ("exactly ten narrow ports"); no dedicated test exercises cross-execution persistence, because there is none yet by design |
| The `ApprovalSender` port rides on `RunPorts` (`src/agent/driver.ts`), NOT on `src/agent/dependencies.ts` | Task 5's file list says to compose the sender in `dependencies.ts`. That file turns `Env` into the model-facing CAPABILITY ports; the sender is consumed by the RunDO's `resolveApproval` RPC, which has no `CapabilityDependencies` in scope and must reach the port from a Durable Object method. `RunPorts` is the existing seam for exactly that (it already carries `now`, `limits`, `continuation`, `projections`), and it is the only one a test can override per run key. `dependencies.ts` was therefore left untouched. The sender DEFAULTS to `makeIdentityRefusingSender()` in `defaultRunPorts()` rather than being installed in `productionRunPorts`: the refusing sender IS the Phase 11 production implementation, so the default and the production wiring are the same object, and a forgotten install fails closed instead of yielding an absent-sender code path. | `test/approval-resolution.test.ts` (the un-faked cases resolve `blocked`/`identity_unavailable` through the default) |
| The resolution turn's content is PROSE built by `resolutionTurnContent` (`src/approval/contracts.ts`) | The plan asks for `content: <structured resolution: decision, final text or reason, delivery outcome>`. It is emitted as prose, not JSON, because it lands in the model's transcript as user-authority input and its delivery half is an INSTRUCTION — under the identity-refusing sender the approved text has to be posted by a human, and `"delivery":"blocked"` is not something a model can act on. The three structured fields also ride on the turn's `metadata` (`approvalId`, `decision`, `delivery`) for machine readers. `decidedBy` appears in neither (invariant 12). | `test/approval-resolution.test.ts` ("keeps decidedBy out of the model's context entirely", plus the per-outcome content assertions) |
| `resolveApproval` refuses a decision the D1 row does not carry | Not in the plan. The RPC compares `input.decision` against the row's own `decision` and returns `{applied:false}` on any mismatch (including a still-`pending` row). Without it, any caller could unpark a run with a decision no human made — a second writer surface (invariant 6) reachable from inside the Worker. Refusing leaves `resolution_delivered_at` NULL, so the sweeper keeps re-driving and the failure is visible rather than silent. The TEXT is still taken from the caller's `outboundText`, so a sweeper replay is byte-identical to the original notify. | `test/approval-resolution.test.ts` ("a resolution D1 does not carry") |
| Shadow is re-read LIVE at delivery and OR-ed with the card's snapshot | The plan says the sender "re-checks" shadow, but `ApprovalSender.send`'s pinned input carries no `shadow` field, so the re-check lives in `resolveApproval` instead — before any sender call, which is what makes "a shadow run's delivery is only ever suppressed" provable as "the sender was never called". A run's `shadow` flag only ratchets false->true, so OR-ing the live `runs` row with the card's snapshot fails closed in both directions (a card projected before the ratchet, or an unreadable `runs` row). | `test/approval-resolution.test.ts` ("suppresses delivery and NEVER calls the sender" — card says false, the live row says true) |
| The wave-D wiring: `ResolutionNotifier` is composed lazily in `resolvePorts`, like the verifier | Task 6 left `notifier` deliberately `undefined`. `src/approval/notifier.ts` (`makeRunDoResolutionNotifier`) now fills it on first use from `env`, resolving `runId -> runs.key -> runStubForKey -> resolveApproval`. Composed in `resolvePorts` rather than at a route, so both the PATCH handler and the one-minute sweeper get it from one place; every existing test still wins by installing its own notifier first. | `test/approval-resolution.test.ts` ("carries a real PATCH into the owning RunDO" — asserts the DO's own turn and status, because an unwired notifier and a dead DO both read as `resolutionDelivered:false` from the response alone) |
| Steps 3 and 4 of `resolveApproval` are the REVERSE of the plan's order | The plan orders `appendTurn` before `approval_state -> resolved`. That order has a crash window its own repair path cannot repair: the committed turn has already scheduled a generation, which answers and then RE-PARKS at finalize (the local row is still `open`), and the sweeper's re-drive appends nothing (`writeTurn` returns `appended:false` for a known id) and writes no status — so the run sits `awaiting_approval` until an unrelated customer message wakes it. Settling the local record FIRST makes the same window self-healing: nothing wakes, nothing re-parks, and the sweeper's re-entry commits the turn (id not yet present) with the latch already unable to park. Safe because the only reader of an unsettled row is the pause latch, and a generation racing this one settles without parking — which is the correct end state anyway. Found in review of Task 5. | `test/approval-resolution.test.ts` ("heals on re-entry", and "cannot heal the MIRROR of that window", which pins the reason: `resolveApproval` never writes a run status itself) |

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

**Decision (revised after review): mitigate at the source, not at this
route.** Task 2's review accepted, as a deferred Minor, that `AccessVerifier`'s
JWKS cache (`src/access/jwt.ts`'s `resolveKey`) refetches on every key-miss
rather than respecting the 1-hour floor — bounded per `verify()` call, not
globally. That was theoretical while nothing called the verifier; this task
is what makes it reachable, and `resolveKey` runs the JWKS lookup *before*
the signature is even checked, so a syntactically-valid three-segment token
with a fresh random `kid` on every request is enough to force one real JWKS
fetch per request, with no valid signature required. If Cloudflare's JWKS
endpoint throttles under that load, authentication breaks for every real
user, not just the attacker.

**First attempt, rejected on review.** The first cut of this fix added an
unkeyed, per-isolate "circuit breaker" in `src/api/approvals.ts`'s
`requireIdentity`: after 30 failed verifications in a rolling 60-second
window, refuse further requests with no call into the verifier at all. Review
caught two real problems with it, not just a tuning nit:

- It ran *before* the identity/role check and was not scoped by identity, IP,
  or `kid`. Once tripped, it denied every caller for the rest of the window —
  **including a fire-fighter presenting a perfectly valid JWT to
  `PATCH /api/approvals/:id`.** Under its own threat model that is a strictly
  bad trade: "attacker adds load to Cloudflare's JWKS endpoint" becomes
  "attacker prevents fire-fighters from approving anything," on the one
  surface this entire phase exists to provide.
- The failures that tripped it were free to produce: `verify("")` throws
  `missing`, and a header that isn't a three-segment JWT with a `kid` throws
  `malformed` — both **before** `resolveKey` runs, so before any JWKS fetch
  at all (`src/access/jwt.ts`'s `verify`, header/format checks ahead of
  `resolveKey`). Thirty header-less `GET`s cost an attacker nothing and
  produce zero amplification, yet still denied the approval surface for the
  rest of the minute. The counter was not measuring the resource it was
  meant to protect.

That breaker (and its test) were removed entirely — see
`src/api/approvals.ts`'s `requireIdentity` doc comment, which now explains
why no rate-limiting lives at this layer.

**What shipped instead: a short-TTL negative cache inside `resolveKey`
itself**, `src/access/jwt.ts`. Once a `kid` survives a full refetch and is
still missing, it is remembered as unknown for `UNKNOWN_KID_NEGATIVE_TTL_MS`
(60 seconds); any further `resolveKey(kid)` call for that same `kid` fails
immediately with **no network call**, until the entry's TTL elapses. This
throttles the actual expensive operation (the JWKS fetch) directly, scoped
per-`kid` rather than as a blunt cap on the whole route, and it never refuses
a request that carries a token whose `kid` it hasn't already tried and
failed — so a legitimate caller is never collaterally denied by someone
else's garbage traffic, unlike the removed breaker.

**The rotation trap, handled explicitly.** A negative cache with no expiry
would turn a real Access key rotation into a self-inflicted outage: every
valid token signed with a newly-published key would be rejected for as long
as the negative entry lived. `UNKNOWN_KID_NEGATIVE_TTL_MS` is deliberately
short (60s, matching the order of magnitude the review asked for) so
rotation's blind spot is small and self-heals automatically — proven by
`test/access-jwt.test.ts` > "re-checks a kid after its negative entry's TTL
elapses, so rotation self-heals," which advances an injected clock (a new
optional `now` parameter on `makeAccessVerifier`, defaulting to the real
clock in production) past the TTL and asserts a `kid` that became real in the
interim verifies successfully afterward. The companion test, "stops
refetching for a repeated unknown kid within the TTL," proves the throttling
half: ten repeated attempts for the same never-published `kid` inside the
TTL cost zero additional fetches.

This is a mitigation at the actual bottleneck, not a redesign of the
freshness-floor cache around it — `JWKS_CACHE_FLOOR_MS` and the "refetch
exactly once per miss, per call" behavior are untouched, and every
pre-existing test in `test/access-jwt.test.ts` still passes unmodified.
Recorded here per the dispatch's instruction that silence on this question is
not an acceptable answer, and revised here per the review that correctly
rejected the first attempt.

---

## Task 5 — two hazards handed to Phase 13

Neither is reachable in Phase 11 (the production sender refuses before either
can occur) and neither is a defect in the Task 5 diff. Both need to be answered
by whoever lands the real Slack sender.

**1. An `in_doubt` delivery leaves the run unable to escalate again, forever.**
`idx_approvals_one_open` (the plan's own schema, `migrations/0007_approvals.sql`)
treats a decided approved/edited row as UNSETTLED unless its delivery is
`sent`, `blocked` or `suppressed`. `in_doubt` is none of those, so the partial
unique index keeps holding that `run_id` and every later `escalate` on that run
fails `duplicate_open`. That is arguably correct — a run with an unreconciled
customer message probably should not be drafting another one — but it is
currently silent and has no operator path out except editing D1 by hand. Phase
13 needs either a reconciliation action that moves `in_doubt` to a terminal
delivery, or an explicit decision that this is the intended dead end.

**2. `#settleDelivery` reports an intention, not a fact, on one impossible
branch.** `src/run/do.ts` — when the CAS is refused AND the re-read finds no
row at all, it returns the state it failed to write. Deliberately not "fixed":
the honest alternative is `in_doubt`, which would be a WORSE lie on the shadow
path (telling the model a send outcome is unknown when no send was ever
attempted), and the branch is unreachable while the `approvals` row exists —
`resolveApproval` read it successfully moments earlier and nothing deletes
approval rows. The structurally honest fix is for `#settleDelivery` to return
`null` and the caller to abandon the resolution, which changes crash semantics
and is not a one-liner. Recorded rather than done.
