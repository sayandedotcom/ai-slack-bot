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
| Task 7 touches `src/agent/loop.ts` and `src/approval/port.ts`, NOT `src/run/do.ts` | The task's file list names `do.ts` for both halves. Neither half lives there. The trusted context is built in `composeAndRun` (`src/agent/loop.ts`), which is the only place holding both `ctx.storage` and the claim — `do.ts` never calls `resolveTrustedContext`. The withdraw path was already shipped by Task 4 as `ApprovalPort.withdraw` (`src/approval/port.ts`), so Task 7 hardened it rather than writing a second one; a withdraw RPC on the DO would have been a second writer of approval state, which invariant 6 forbids. `do.ts` is unchanged by this task. | `test/approval-interrupt.test.ts` (whole file — every case drives the real loop and the real port) |
| `resolveTrustedContext` takes `storage: DurableObjectStorage \| null` and reads `openApproval` ITSELF | The plan says "context builder reads `openApproval(storage)`" without saying who holds the handle. Handing the caller's already-read record in would have matched the file's existing `RunCoordinates` convention — and would have been the wrong shape here: a pending approval carries CONTENT (the draft), so a parameter that accepts a draft is a parameter that can one day be passed something the model wrote. Taking the storage handle instead makes `approval_state` the only reachable source. Nullable-but-required so the composer's own unit tests state their intent rather than omitting it by accident. | `test/approval-interrupt.test.ts` ("tells the new generation what is pending" — rewrites the local record to a sentinel that appears in no turn and requires the prompt to carry it) |
| `TrustedContext` gains `pendingApproval: {approvalId, draft, why} \| null`, rendered as its own prompt block | Additive to a pinned type. The block names the id, the reason and the draft verbatim, and NOTHING about the human (invariant 12). | `test/agent-prompt.test.ts`, `test/approval-interrupt.test.ts` ("never names the human, even once a decision exists") |
| `latestApprovalState(storage)` added to `src/run/session.ts` | New read, needed by `withdraw`'s "nothing open" branch: between the capability's `openApprovalId()` pre-check and the port's own read, a human's decision can settle the record, and the port has to name THAT approval to answer honestly. `openApproval` deliberately cannot see a settled row, so it could not be reused. | `test/approval-interrupt.test.ts` ("hands the model the human's decision when the human won") |
| Task 4's `withdraw` loser branch NO LONGER re-opens the local record (`resolved -> resolving`) | Behaviour change to shipped code, found by Task 7's race. `resolveApproval` settles the local record and THEN commits the resolution turn (Task 5's reversed order); a `withdraw` whose D1 CAS was in flight across that whole sequence loses the CAS and is the LAST writer of the local row. Re-opening it there re-parks a run whose decision has already been delivered — with the repair key retired and the turn id taken, nothing can ever unpark it. Leaving the row settled is safe in the other direction because delivery of the decision never depended on it (the PATCH notifies, the sweeper re-drives, both keyed on D1); the worst case is a generation settling `completed` a moment before the resolution turn wakes a new one. | `test/approval-interrupt.test.ts` ("a withdraw whose D1 CAS was in flight when the resolution landed" — wraps the port's own `D1Database` to run the whole resolution inside the CAS's `batch()`) |
| `withdraw` with nothing open now answers from the D1 row instead of always `{withdrawn:true}` | Same branch, the other half. Reaching the port with no open record means the row moved after the capability's pre-check — i.e. a human's decision landed while the model's program was awaiting something. Reporting a withdrawal there is a lie about a message that may already have been approved. A `withdrawn`, missing, or still-`pending` row all keep the old answer. | `test/approval-interrupt.test.ts` ("hands the model the human's decision when the human won") |
| KNOWN WINDOW: a `withdrawn:false` answer frees the host-side escalate check before the decided card frees the D1 slot | Consequence of the loser-branch fix above, accepted rather than reverted (review of Task 7). Leaving the local record settled means `openApprovalId()` returns null, so the capability layer would permit a second `escalate` — while the human's decided card is still UNSETTLED under `idx_approvals_one_open` (approved/edited with delivery not yet `sent`/`blocked`). The projector would answer `duplicate_open` and retry against a bounded job budget while the run sits parked on a card the dashboard cannot see. The old reopen blocked this only by accident, at the cost of stranding runs, which is strictly worse. Closed with GUIDANCE, not a guarantee: the pending-approval context block tells the model that a decision returned by `withdraw()` is final and must not be re-escalated. **CORRECTED 2026-08-14 (final whole-branch review):** the reason originally given here for deferring a structural fix — "it would put a D1 read on the escalate path, which invariant 2 keeps synchronous and local" — is a misreading of invariant 2 and should not be inherited by Phase 13. Invariant 2 says `escalate` must never **block waiting for a human decision**; it says nothing against a bounded D1 round-trip in general. **A first correction attempt claimed `ApprovalPort.open()` "already performs a D1 write (the projection enqueue) on the escalate path" — that claim was checked against the source and is FALSE, and is itself struck here rather than left to mislead a later reader:** `open()`'s `enqueueProjectionJob` call (`src/approval/port.ts:84`, `src/run/session.ts:1793`) is a plain `storage.sql.exec` against the Durable Object's own local SQLite, not D1 — the doc comment on `open()` says so explicitly ("neither touching D1 or the network"), and `src/run/do.ts:231`'s comparable comment ("no projector, no D1") confirms the pattern. The actual D1 insert happens later and out-of-band, in the alarm-driven projector. The real, verified precedent is `ApprovalPort.withdraw()` instead: `withdrawApproval` (`src/approval/repository.ts:216`) runs a real `db.batch()` — an awaited D1 round-trip — from inside a model-facing capability call (`approval.withdraw()`) in the same `run_code` execution `escalate` runs in, and this is already shipped, accepted design, not something invariant 2 was ever read to forbid. So the codebase already tolerates a bounded async D1 round-trip inside a model-facing approval capability during one execution; what invariant 2 rules out is blocking on a HUMAN's unbounded decision time, which a D1 read never does. The synchronicity requirement that IS real belongs to `openApprovalId()` (the finalize latch's own synchronous local read, used inside `transactionSync`) and the finalize latch itself — neither of which a D1 read inside `open()`/the capability layer would touch. So a structural fix (re-reading the D1 card's delivery state before permitting a second escalate) is not ruled out by invariant 2; it remains deferred as a scope decision for a later phase, not because the invariants forbid it. | `test/approval-interrupt.test.ts` ("hands the model the human's decision when the human won" pins the state the window starts from; the guidance itself is prompt text and is pinned only as rendered copy) |
| KNOWN WINDOW (scope correction): the prompt guidance above protects only the generation that called `withdraw()`, not every generation that could re-escalate | The window's closing guidance (`src/agent/prompt/context.ts:269`, inside `if (context.pendingApproval !== null)`) was described above as closing the gap for the run in general. It is narrower: once `withdraw()` loses to a human decision, the local record is settled, so `openApproval(storage)` returns `null` for it and the whole `### One reply is waiting on a human` block — the guidance included — is **not rendered at all** for any later generation. Only the SAME generation that called `withdraw()` and is still mid-turn sees the guidance in its own transcript history. A later generation woken by, e.g., a new customer message arriving before the resolution turn lands sees no block and no guidance, and is free to call `escalate` again with nothing telling it not to. Still recoverable in practice — the next wake after the resolution turn commits renders the new pending-approval block as normal — so this stays a known window rather than a defect, but Phase 13 should treat the guidance as covering one generation, not the run. | `test/approval-interrupt.test.ts` (same case as above; no test currently pins the narrower scope directly) |
| Test harness: `freshLoopRun({ realApproval: true })` forwards the REAL port | `freshLoopRun` fakes every vendor port including `approval`. The interruption suite needs the real one (local record, D1 CAS, projection) while still wrapping it for the race barrier, so the harness now forwards `dependencies`' fourth argument when asked. Opt-in: the real port refuses to open an approval on a run with no pinned Slack thread, which every chat-origin suite would hit. | `test/approval-interrupt.test.ts` (the only caller) |

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

---

## Task 9 — the gate: mutation review, triage, and the full-suite run

### The full gate, command by command

Run at commit `8d0ddf5` + this task's diff, on `main`.

| Command | Result | vs. Task 0 baseline |
| --- | --- | --- |
| `pnpm --filter @workspace/worker test` | **78 files, 1494 passed, 2 skipped, 0 failed** (123.2s) | baseline 69 files / 1329 passed / 2 skipped / **1 failed**. +9 files, +165 tests, and the baseline's one failure is gone |
| `pnpm --filter @workspace/worker codemode:dts:check` | `capability declarations are up to date`; `check-text-files: no control bytes` | unchanged |
| `pnpm exec tsc --noEmit -p tsconfig.json` | exit 0, no output | unchanged (clean at baseline) |
| `pnpm lint` | 2 tasks (`@workspace/ui`, `web`), both pass — the worker package declares no `lint` script | unchanged |
| `pnpm build` | 1 task (`web`), compiled + 4 static pages | unchanged |
| `wrangler deploy --dry-run` | 3086.85 KiB / gzip 475.04 KiB, all bindings resolved | `ACCESS_APP_AUD` is still `UNSET_SEE_PHASE_11_NOTES` — release gate G1, Task 10's to set |

The +9 files are Phase 11's own: `access-jwt`, `approval-api`,
`approval-contracts`, `approval-interrupt`, `approval-repository`,
`approval-resolution`, `agent-pause`, `codemode-approval`, and this task's
`approval-e2e`.

**Two red tests existed on `main` before this task and are fixed here.**

1. `test/agent-cost.test.ts` > "0006 migration properties" asserted
   `numbers).not.toContain("0007")` — a Phase 10 guard that Task 1 retired by
   writing `migrations/0007_approvals.sql`. Red since `00eafc5`; nothing in the
   per-task process could have caught it, because no task's exact-path suite
   included that file. Now asserts what is actually worth pinning: prefixes are
   unique, `0006` is still the agent-loop migration (nobody renumbered an
   already-applied migration), and `0007` exists.
2. `test/agent-failure-matrix.test.ts:632`, the recorded flake. Closed by
   holding the successor attempt open inside its own tool call
   (`holdAfterToolInput(2)` + a second latch) instead of merely observing that
   attempt 2's stream had started, so the in-flight read cannot lose a race with
   the successor's own finalize. The assertion is unchanged — the property (a
   reclaim continues generation attempt 2 rather than forking) is still checked.

### Mutation review — three mutated, three reviewed by reading

Each mutation was applied to the real source, run against its exact-path
suites, and reverted. **Mutated (evidence, not reasoning):**

| # | Mutation | Result | Caught by |
| --- | --- | --- | --- |
| 1 | `migrations/0007_approvals.sql`: `CREATE UNIQUE INDEX idx_approvals_one_open` → `CREATE INDEX` | **5 failures** | `approval-repository` ("refuses a second insert while the first is pending", "still refuses … once decided but undelivered"), `agent-pause` ("treats duplicate_open as success", "retries rather than retiring a job whose collision is a DIFFERENT approval"), `approval-e2e` ("the card appears exactly once" — with the index gone the collision becomes a PRIMARY KEY violation whose message text is correctly NOT mapped to `duplicate_open`, so the job retries forever) |
| 2 | `src/api/approvals.ts` `requireIdentity`: `if (c.req.method === "PATCH") return { email: jwt }` — i.e. PATCH skips verification entirely | **3 failures** | `approval-api` ("401s with no token, row untouched"), `approval-e2e` ("gets no token material back in the real verifier's 401") and — the one worth noting — `approval-e2e`'s canary sweep, because an unverified token becomes `decided_by` and the raw bearer credential lands in the D1 `approvals` row |
| 3 | `src/run/session.ts` `finalizeGeneration`: `latchApprovalPause(...)` moved above the `isCurrentClaim` fence, so a superseded claimant latches the pause | **1 failure** | `agent-pause` > "refuses a paused finalize from a superseded claimant" (`pausedApprovalId` must stay null). Honest limit: this mutation only reaches the generation row's `paused_approval_id`; the same test also asserts the run status, but the mutation's early return never gets as far as writing one, so that half of the assertion was not exercised by this experiment. |

**Reviewed by reading only — NOT mutation-tested** (the plan's timebox is three):

- **Viewer PATCH.** `approvalsApi.patch` calls `isFirefighter(identity.email)`
  before parsing the body or touching D1, so a viewer's 403 provably precedes
  any write. Covered by `approval-api` > "403s a viewer, and the row stays
  untouched" and by `approval-e2e` > "reads nothing and decides nothing", which
  additionally asserts the whole row is byte-identical afterwards.
- **Decision rollback on delivery failure.** No code path writes `decision`
  outside `decideApproval`/`withdrawApproval`, and `setDelivery` touches only
  `delivery`/`delivery_error`/`updated_at`. Invariant 5 holds by the shape of
  the two statements rather than by a guard, so a mutation would have to be an
  invented rollback rather than a deletion.
- **Model-supplied channel.** `ApprovalPort.open` takes `slackThread` from
  `run_state` and the sender's destination is re-derived at delivery time in
  `#deliverApproval`; the capability declares no destination argument
  (`codemode-approval` > "takes no destination argument", `approval-resolution`
  > "takes the destination from run state, never from the card's snapshot").

### Deferred-Minor triage — every one, with its decision

**Fixed in this commit:**

| From | Minor | What was done |
| --- | --- | --- |
| Task 2 | `crypto.subtle.importKey` unwrapped in the JWKS import loop, so a malformed JWK escapes as a raw `DOMException`/`TypeError` and breaks the closed `AccessJwtError` contract | Wrapped; an unimportable key is skipped so the document's GOOD keys still work, and a token needing the skipped key fails closed as `bad_signature`. New case in `access-jwt.test.ts`; verified red without the fix. It matters because `api/approvals.ts` maps `AccessJwtError` to 401 **by code** and anything else becomes a 500 on the decision path |
| Task 3 | `codemode-integration` checked the tool DESCRIPTION for `needsApproval` rather than the descriptor's shape, so it could not detect a real AI SDK approval gate (invariant 1) | Now asserts the descriptor's own keys, and sweeps every method of every namespace in a real `buildRegistry` for a `needsApproval` property. The description check stays as the weaker second half |
| Task 4 | A refused public-status transition dropped silently in `finalizeAnswer` | `console.warn` on the refused branch (statuses only, no content). Confirmed unreachable-in-practice rather than merely unlikely: the outer `if` guarantees `from !== to`, and `evaluateTransition` returns `changed:false` only for `from === to`, so the new branch fires solely on an illegal transition |
| Task 4 ⚠️ | **No test pinned a shadow-run escalation card** (invariant 14's card half) | `approval-e2e` > "projects an honestly-labelled card for a SHADOW run": a real `escalate` on a real shadow run, the real projector, `shadow: true` on the card, then a real PATCH whose delivery is `suppressed` with the sender never called |
| Task 6 | The PATCH notify failure was swallowed with no log | `console.warn("approval notify did not apply; the sweeper will re-drive it", {approvalId, runId})`. Ids only. The decision still stands (invariant 9); what changes is that an operator can see a click now riding on the sweeper |
| Task 6 | `approval-api`'s zero-DO comment overstated its mechanism | Comment rewritten to claim only what `state() === null` proves (nothing was WRITTEN), with the stronger invariant-7 claim attributed to its actual evidence: the route file never references `env.RUNS` |
| Task 8 | The byte-identical prompt test covered `STABLE_POLICY_SECTIONS` but not `VOICE_EXAMPLES`/`renderVoiceExamples()` | Both added to the two-module-builds comparison; they are the second half of the same cached stable prefix |
| Task 1 | `setDelivery`'s `from.length === 0` guard untested | A case was added — and it is recorded here as **weaker than it looks**: removing the guard leaves it GREEN, because SQLite/D1 accepts `delivery IN ()` and matches nothing. The guard is a saved statement, not a syntax-error shield. The case is kept for the CONTRACT (empty `from` = refused no-op, row untouched) and says so in its own comment |

**Recorded, not fixed:**

| From | Minor | Why not |
| --- | --- | --- |
| Task 1 | `ONE_OPEN_INDEX_ERROR` assumes `run_id` stays the only unique column on `approvals` | Correct today and now backed by evidence rather than by the comment: mutation 1 dropped the unique index, the collision became a PRIMARY KEY violation, and the different message text was correctly NOT mapped to `duplicate_open`. A future unique column would need this constant revisited; the assumption is documented at the constant |
| Task 4 | `src/approval/projection.ts` reads local state outside its `try`, so a throw escapes `run()` | **The premise does not hold.** `src/run/do.ts`'s projection dispatcher already wraps `runner.run(job)` in try/catch and converts a throw into `{outcome:"retry"}` with `safeErrorText`, which is the same bounded retry the inner `catch` produces. Moving the reads inside would change nothing observable |
| Task 5 | An `in_doubt` delivery leaves the row permanently unsettled under `idx_approvals_one_open` | Already recorded above as a Phase 13 hazard; unreachable in Phase 11 (the production sender refuses first). Not this gate's to change — it is the plan's own schema |
| Task 5 | `#settleDelivery` returns `{delivery: to}` when the re-read finds no row | Already recorded above; the honest alternative (`null` + abandon the resolution) changes crash semantics and is not a gate-sized edit |
| Task 8 | A substring assertion ends mid-sentence on a dangling "so" | Cosmetic; the assertion is correct and changing prose in a passing assertion buys nothing at the gate |

### What the full suite revealed that per-task review could not

Only one thing, and it is the reason the two-run budget was worth spending
here: the `0007` assertion in `test/agent-cost.test.ts`. It was red on `main`
for eight commits. Every task ran its own exact-path suites and every one of
them was green, because the broken assertion lived in a file no Phase 11 task
touched. Nothing else surfaced: with the flake closed, the 78-file run was
green first time and no cross-file ordering problem appeared.

### Tests this task judged weaker than they look

Stated because an honestly-reported gap is worth more than a green suite.

1. **`setDelivery`'s empty-`from` case** — measured, not suspected; see above.
2. **`approval-e2e` > "gets no token material back in the real verifier's
   401"** proves the ROUTE does not echo the header or the JWKS document, and
   that the error body has exactly two keys. It cannot catch a future
   `AccessJwtError` that put token material in its own `message`, because
   `fail()` only forwards `err.code` — the property is guaranteed by
   `jwt.ts`'s construction, and this test guards the shaping around it.
3. **The WS forgery case's first two assertions** (`unknown_type`,
   `server_owned_field`) would both still pass if the injection were possible
   by another route, so the case carries a third assertion that survives
   deleting both guards: an ACCEPTED frame is committed with the source the
   server assigns (`human_steer`), never `approval`. That is the one that means
   the browser cannot forge a decision.
4. **The canary sweep's boundary** is the same one `agent-canaries.test.ts`
   documents: vendor gateways are faked at the `dependencies` seam, so a real
   adapter echoing its own credential is not caught here. What this file adds is
   the approval path specifically — the D1 row, the events, the resolution turn,
   every local table, the woken generation's transcript, and the logs.

---

## Final whole-branch review — two Important fixes

Applied 2026-08-14, after Task 9's gate, as the last code change before deploy.
Both were unmet plan requirements, not polish.

1. **The rejected/edited draft never reached org memory.**
   `resolutionTurnContent` (`src/approval/contracts.ts`) now takes a required
   `draft` input. The rejected branch appends `The draft that was rejected: …`
   **last**, after the reason — `readAsked()`'s 1,000-char `EPISODE_LIMITS.asked`
   cap means trailing placement is what gets truncated first, and the reason is
   the more valuable half if only one survives. The edited branch appends
   `Your original draft, now superseded: …` between the final text and the
   delivery line. `src/run/do.ts`'s call site now passes `card.draft`. The
   covering tests in `test/memory-outbox.test.ts` were changed to build their
   turns with the real `resolutionTurnContent` instead of a hand-written
   literal — the literal had drifted from what Task 5 actually built and the
   test kept passing anyway, which is what let this slip through the gate.
2. **The PATCH response reported delivery from before `notify` ran.**
   `src/api/approvals.ts`'s handler now re-reads the row with `getApproval`
   after the notify branch (falling back to the pre-notify `row` if the
   re-read finds nothing) and renders that. The notify-failure path
   (invariant 9: 200, `resolutionDelivered:false`, decision stands) is
   untouched — the re-read runs after that branch either way, and on failure
   nothing changed the row for it to newly reveal.

Full detail, tests, and commands are in
`.superpowers/sdd/phase-11-approval/final-fix-report.md`.

---

## Phase 13 entry criteria

Decisions this phase is handing forward, so Phase 13 inherits them as stated
constraints rather than rediscovering them.

- **`in_doubt` permanently holds the one-open slot.** `idx_approvals_one_open`
  treats a decided approved/edited row as unsettled unless its delivery is
  `sent`, `blocked` or `suppressed` — `in_doubt` is none of those, so a run
  whose delivery lands there can never escalate again, with no operator exit
  but hand-editing D1. Unreachable in Phase 11 (the identity-refusing sender
  never reaches `in_doubt`). Phase 13 must decide: a reconciliation action
  that moves `in_doubt` to a terminal delivery, or an explicit, documented
  dead end.
- **The approval sweeper has no per-row backoff.**
  `listUndeliveredResolutions` pages `APPROVAL_SWEEP_PAGE_SIZE` (10) rows
  `ORDER BY decided_at ASC` with no attempt counter, so a permanently-failing
  row would sit at the head of the page every minute and head-of-line block
  every later decision's repair. Theoretical today (nothing in Phase 11 fails
  permanently); real the moment a delivery path can.
- **`src/access/jwt.ts` cannot distinguish a JWKS outage from a forged
  token.** Both map to `bad_signature` → 401. Fails closed, which is the
  right direction, but the code is wrong about why it failed, and an outage
  is then indistinguishable from an attack in the logs. Adding an
  `unavailable` member to `AccessJwtErrorCode` is a deliberate contract
  change, deferred to Phase 12's rework of `src/access/`.

## Release gate G2 — grep-able marker

G2 (remove the temporary personal-email override, see "Release gates" above)
is tagged in three places: `src/access/roster.ts`, `README.md`, and this
file. As of this review those three tags used different wording, so finding
all of them meant remembering three separate places rather than running one
search. All three now carry the literal marker string `G2-TEMP-OVERRIDE`
verbatim, so removal is `grep -rn G2-TEMP-OVERRIDE` across the repo, once,
rather than three memories.
