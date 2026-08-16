# Testing brief — bring the Think chassis up to main's coverage

Paste this whole file as the first message in a dedicated terminal. It is a
self-contained brief for a fresh session: context, hard rules, and the ordered
list of tests to write. Another session (the "drill terminal") is running live
scenarios in the SAME worktree at the same time — the coordination rules below
exist so the two never collide.

---

## 0. Where you are and what this is

- Repo: Fire-Fighter Agent (Zellify trial). Read `CLAUDE.md` at the repo root
  first — it is the authoritative map. Then `apps/worker/CLAUDE.md` if present,
  and `docs/things-to-remember.md` (gitignored; never commit it).
- **Worktree:** `/home/sayan/Desktop/zellify/firefighter/.claude/worktrees/think-chassis`,
  branch `worktree-think-chassis`. Run everything from
  `apps/worker` inside that path. Never `cd` into the main checkout, never
  touch `main`.
- What changed on this branch (spec: `docs/superpowers/specs/2026-08-16-think-chassis-migration-design.md`,
  plan: `docs/superpowers/plans/2026-08-16-think-chassis-migration.md`,
  notes: `docs/superpowers/plans/phase-25-notes.md`): a second run chassis,
  `RunAgent extends Think<Env>` (`src/run/agent.ts` + `agent-*.ts`), lives
  BESIDE the legacy `RunDO` behind `RUN_CHASSIS=think|legacy`
  (`src/run/chassis.ts`). The 11 capability namespaces are now also
  `CodemodeConnector`s (`src/codemode/connectors/`), rendered through JSON
  Schema (`src/codemode/schema.ts`, `dts.ts`). The dashboard is chassis-aware
  (`apps/dashboard/src/lib/chassis.ts`, `runs/agent-session.tsx`).
- The gap you are closing: the legacy chassis has ~250 tests across
  `run-do`, `run-session`, `agent-loop`, `approval-*`, `run-api`, `run-ws*`.
  The Think chassis has ~22 across `run-agent-*` and `run-chassis`. Every
  invariant the legacy suites pin must be pinned again for `RunAgent`, or the
  legacy chassis cannot be deleted at cutover.

## 1. Hard rules (read twice)

**Coordination with the drill terminal — this is the important one.**
- You may create or modify files ONLY under `apps/worker/test/`,
  `apps/worker/test/helpers/`, and `apps/dashboard/test/`. Nothing in `src/`,
  `sandbox/`, `wrangler.jsonc`, generated files, or docs.
- If a test you write finds a REAL bug in `src/`, do NOT fix it. Write the
  failing test with `it.fails(...)` or `it.skip(...)` plus a comment naming
  the defect, and append an entry to `TEST-FINDINGS.md` at the repo root
  (create it if absent): file, test name, what is wrong, why you think so. The
  drill terminal fixes `src/`. Two sessions editing `src/` in one worktree is
  how work gets lost.
- **Do not commit. At all.** Leave every file you write in the working tree.
  The human commits all the tests together at the end, so the test commit and
  the code commits it covers stay together. No `git add`, no `git commit`, no
  `git stash` (the stash stack is shared with other sessions). If a subagent
  commits anyway, note it in `TEST-FINDINGS.md` — do not try to undo it.
- **Never deploy. Never run `wrangler deploy`, `wrangler containers push`, or
  touch production D1.** Not even to "check". Never edit `RUN_CHASSIS`.
- **Speed regime: write everything first, run once at the end.** Do NOT run
  vitest after each file. Writing a test file needs no pool; running one does,
  and the pool is one workerd with shared on-disk state — two vitest processes
  in one worktree have stalled for an hour before. So:
  1. Write ALL the files in section 2 (subagent-driven, in parallel — see §3).
  2. `pnpm typecheck` ONCE when they are all written (tsc is cheap, touches no
     pool, and is half the gate — vitest strips types).
  3. Write "READY TO RUN" at the bottom of `TEST-FINDINGS.md`, then run the
     NEW files together in ONE vitest process:
     `npx vitest run test/run-agent-*.test.ts test/run-chassis.test.ts test/agents-route.test.ts test/codemode-connectors.test.ts test/codemode-linear.test.ts test/codemode-dts.test.ts`
     (one invocation, not the full suite). Fix your own test bugs from that
     run; anything that is a `src/` bug goes to `TEST-FINDINGS.md`.
  4. Only then, and only once, the full gate: `pnpm test && pnpm typecheck`.
     Write "READY FOR FULL GATE" first so the drill terminal stops its runs.
  A subagent that wants to "quickly run its file to check" is the thing this
  rule forbids. Correctness comes from reading the model files in §1 and the
  legacy suite it is cribbing from, not from a run per file.

**Harness facts (from CLAUDE.md; they bite).**
- Storage is SHARED across tests and files (no `isolatedStorage`). Mint a
  fresh run key per case — `chat:${crypto.randomUUID()}` or a fresh
  `slack:C…:{ts}` (see `freshSlackKey()` in `test/run-chassis.test.ts`).
  Never assert an absolute `seq`. Never call `reset()`. Never assume an
  empty table.
- Pool env: synthetic credentials, `AGENT_MODEL_DISABLED=true`,
  `SANDBOX_DISABLED=true`, empty gateway settings. A suite that needs the
  Think chassis passes its own env: `const think: Env = { ...env, RUN_CHASSIS: "think" }`.
- Helpers: `test/helpers/agent-driver.ts` (barrier `FakeContinuation`),
  `run-ws.ts`, `fake-memory.ts`, `codemode.ts` (`fakeCapabilityDependencies`
  etc.), `test/setup.ts`.
- **Read these as your models before writing anything:**
  `test/run-agent-core.test.ts`, `test/run-agent-approvals.test.ts`,
  `test/run-agent-replay.test.ts`, `test/run-agent-thinking.test.ts`,
  `test/run-chassis.test.ts`, `test/codemode-connectors.test.ts`. They show
  how a `RunAgent` is reached (`getAgentByName(env.RUN_AGENTS, key)`), how the
  model is faked, and how the DO's SQLite is read back.
- Verified traps for `RunAgent` (all measured, all in `README.md` § "Project
  Think" and `phase-25-notes.md`):
  - Never call `runTurn` from inside a DO RPC method — it deadlocks, even
    unawaited. Post-approval re-entry is `schedule(0, "reenterAfterApproval")`;
    a test that awaits it must drive the alarm/scheduler, not the RPC.
  - `runTurn` is overloaded three ways; a DO stub keeps only the last. Use the
    `SubmitOnlyAgent` narrowing pattern in `src/run/chassis.ts`.
  - `getTools()` is NOT the model's tool map — six sources merge after it.
    Use `agent.toolNames()` (already exists) to assert "exactly one tool".
  - Anything in the Worker entry's eager module graph cannot be `vi.mock`ed;
    the model composer is reached via `await import()` for this reason. Do not
    add static imports of `src/agent/model` in helpers.
  - `CodemodeRuntime` must be in `new_sqlite_classes` — it is; a facet
    failure looks like "Incorrect type for the 'class' field on 'StartupOptions'".
- Test budget philosophy for this branch: fewer, load-bearing tests. Every
  test below pins an invariant that has a number in
  `docs/superpowers/plans/phase-10-agent-loop.md` § "Load-bearing invariants"
  or a row in the README security table. Do not pad. One `it` per behaviour;
  name it as a sentence a reviewer can disagree with.

## 2. The list — in priority order

For each file: **Create** or **Extend**, the legacy suite to crib from, and
the behaviours as `it(...)` sentences. Where a behaviour is already covered
on this branch, it says *(verify present)* — confirm and move on.

### P0 — boundaries and idempotency (do these first, in this order)

#### A. `test/run-agent-core.test.ts` — Extend (4 → ~18). Crib: `run-do.test.ts`, `run-session.test.ts`
- resolves the same key to the same RunAgent object, and a slack key and a chat key to different objects
- gives a root Slack message and its thread reply the same object (via `wakeRun`)
- returns structured-clone-safe values across the RPC boundary (`getMessages`/snapshot shapes)
- reports `accepted:false` for a repeated `idempotencyKey` and appends no second turn *(verify present in run-chassis; if so, skip)*
- exposes exactly one tool to the model, `run_code`, through `toolNames()` — and the sandbox declarations expose neither `state` nor `browser` *(verify present; 79cab3e added the merged-map assertion)*
- keeps the constructor free of timers and outbound sockets; `blockConcurrencyWhile` only primes the model composer
- has no in-memory state to lose: evict the object (new stub / `abort` in the pool), re-read turns and status
- projects to D1 `runs` only when `projection_seq` increases; a redelivered projection with a stale seq is a no-op *(crib `run-do` "writes a status change to both stores")*
- moves `updated_at` after a committed turn
- refuses an illegal status transition without changing state, and treats a same-state change as eventless
- survives a D1 outage on projection: the turn is durable in DO SQLite and the projection job stays pending for the sweep

#### B. `test/run-agent-loop.test.ts` — Create. Crib: `agent-loop.test.ts` (25 its)
- refuses to build a turn for a spent budget, before the provider is invoked
- returns `step_limit` — never an empty answer — when the step ceiling lands mid tool loop
- never puts customer bytes anywhere but a user message (system prompt is ours; opening prompt/steers are user turns)
- treats a Code Mode error as a normal tool result AND a failed tool event (both true at once)
- emits the outer tool lifecycle exactly once per `run_code` call (audit sink)
- maps a provider refusal to a refused generation that a later steer can resume
- maps a provider stream error to a bounded retry, and a timeout-shaped error to `provider_timeout`
- stops on the generation spend cap rather than buying another step
- persists only the terminal step's text as the final turn; a redelivered finalization appends no second turn
- labels a Slack final turn as internal narration and a Chat final turn as visible
- turns a stale generation (superseded by a newer wake) into a safe tool result the model can read
- attaches the AI Gateway auth header on the Think path *(verify: fc93fcf's gateway spy — if it only covers legacy, add the Think case)*
- signed Fable thinking blocks survive Think's sanitizer; readable/unsigned thinking fails the step safely *(verify present in run-agent-thinking; extend if only one half)*

#### C. `test/run-agent-approvals.test.ts` — Extend (3 → ~22). Crib: `approval-interrupt`, `approval-resolution`, `approval-e2e`, `approval-api`
- `approval.escalate` writes local state + a projection job and returns immediately; the pause latches at finalize as `awaiting_approval`
- one open slot: a second escalate while one is open is refused by name, not queued silently
- `withdraw` retracts and frees the slot; when withdraw and a human decision race, exactly one wins; the loser gets 409 / the decision back *(this is an OPEN GAP: `ApprovalPort.withdraw()` currently returns `{ withdrawn: false }` — write these as `it.fails` and log to TEST-FINDINGS.md)*
- `resolveApproval` commits the D1 CAS, then re-enters via `schedule(0, "reenterAfterApproval")` and appends the approval turn EXACTLY once; a redelivered PATCH appends nothing
- the model is handed the decision, never the human's name (`decidedBy` stays out of context)
- approve sends the EDITED text, only the edited text, under the ON-DUTY ENGINEER'S user token — never the bot; destination from run state, never the card's snapshot
- delivery outcomes map honestly: `sent`, `in_doubt` (sending row found on re-entry → no second send), `none` (identity_unavailable — attempts no send, carries the reason into the run), `suppressed` (shadow — sender never called)
- reject sends nothing, appends a turn that says so, and the run resumes live
- a shadow run's card is honestly labelled and its delivery can only be suppressed
- an undelivered resolution is repaired by the real cron sweeper into exactly one resolution turn
- a client cannot inject an approval turn or name the `approval:` source over `/agents/*` or HTTP
- CONTROL + canary: no token material in the approval row, the events, the turns, or a log line (crib `approval-e2e` — the control that plants a canary must still detect it)
- a PATCH for run A cannot resolve an approval owned by run B (refused by the owning object)
- the engineer's nudge DM is rewritten once the card is decided or withdrawn

#### D. `test/run-chassis.test.ts` — Extend (5 → ~14). Crib: `run-api.test.ts` "wakeSlackRun"/"routeSlackMessageToOwnedRun"
- `wakeRun` on think creates one run row + one opening turn; a queue replay adds neither
- two racing wakes converge on one run
- reopens a finished thread on the same object and keeps its history
- an `observe` channel yields `shadow=1`; a `live` one `shadow=0`; the ratchet is one-way across two wakes *(verify present)*
- an unmapped channel fails closed: throws, no row, no turn
- an unrecognised `RUN_CHASSIS` throws `RunChassisError` (never falls back to legacy)
- the legacy branch refuses a chat key by name
- `routeToOwnedRun` on think absorbs a thread reply into the owning `RunAgent` with no model call, and does not claim a thread whose run is done
- `createRunFromChat` on think mints two different uuids (public id ≠ key), the key never leaves the Worker

### P1 — transport, routing, sockets

#### E. `test/agents-route.test.ts` — Create. Crib: `run-api.test.ts` (routes), `run-ws-live.test.ts`
- `/agents/*` returns 404 `chassis_not_active` on legacy *(verify present in index tests; else add)*
- resolves `runs.id` → key through D1 and rewrites the path; a guessed raw `slack:C…` key gets 404 (a key is not an id); an unknown id gets 404 without instantiating an object
- the route is NOT Access-bypassed (no bypass header on it; only `/proofs/*` is)
- `POST /api/runs` on think: 201, no `key` in the body, the opening turn lands in the `RunAgent` (not `RunDO`); blank `firstMessage` rejected
- steer through the agent socket is idempotent on `requestId`; a rejected steer is not broadcast; two tabs on one run see the same event; a socket's cursor survives eviction
- ping answers pong without reaching the message handler *(if the Agents SDK transport exposes it; else skip with a note)*

#### F. `test/run-agent-steering.test.ts` — Extend (1 → ~6). Crib: `agent-loop` "absorbs a steer", `agent-steering.test.ts`
- a steer submitted mid-turn is absorbed by a later `prepareStep` in the same generation
- a steer to an idle run starts a new generation; to a parked (awaiting_approval) run it does not bypass the pause
- steer content is a user turn, never system; a client-supplied `source`/`role` is refused

#### G. `test/run-agent-projection.test.ts` — Extend (1 → ~5). Crib: `run-api` "shows the newest summary and status in the list"
- `GET /api/runs` shows the Think run's newest summary and status from D1 only — no DO wake (count DO invocations)
- two racing lifecycle changes keep the newest bundle
- never exposes a `type` or `category` field (invariant: no ticket type)

### P2 — Code Mode connectors and generated surface

#### H. `test/codemode-connectors.test.ts` — Extend (2 → ~10). Crib: `codemode-write-guard`, `codemode-dts`, `codemode-integration`
- every method of every namespace renders a REAL input type — no `type XInput = unknown` anywhere (the fact-8 regression: Zod passes codemode's sniff test and degrades silently)
- descriptions survive to the JSON schema and the rendered `.d.ts` for every method (spot-check all 11 namespaces by name)
- exactly one degraded property in the whole surface: `files.publish.bytes` (`z.instanceof(Uint8Array)` → any); anything else degrading fails the test
- the effect classification table through the connector path equals the registry's (crib the table in `codemode-write-guard`)
- `requiresApproval` is never set on any tool (decision D4)
- an `external_write` through the connector path is denied under shadow and under an `observe` channel, re-read from D1 at call time
- every connector call is audited and counts against the per-call budget; known dev-env values are redacted from what returns to the model
- runtime declarations are byte-identical to the committed `.d.ts` *(verify present)*

#### I. `test/codemode-linear.test.ts` and `test/codemode-dts.test.ts` — Extend (small guards for today's fixes)
- `linear.createIssue`'s `labels` description names `Bug`, `Improvement`, `Feature`, `Customer Request`, `Support thread` and forbids a `!`-prefixed name; the `.d.ts` never contains the word "workspace" *(the latter exists)*
- `browser.record`'s description tells the model to warm the route before recording
- `github.searchPRs` is declared, classified `read`, and `checkPR` points at it *(searchPRs tests exist; verify)*

### P3 — dashboard (`apps/dashboard`, `pnpm test` there; vitest, no DOM by default — check `vitest.config` before assuming jsdom)

#### J. `apps/dashboard/test/chassis.test.ts` — Create
- `fetchChassis` accepts exactly `think|legacy`, throws on anything else; `useChassis` degrades to `legacy` with `degraded: true` on a failed fetch (one fetch, no poll)

#### K. `apps/dashboard/test/chat-api.test.ts` — Extend `api.test.ts` or create
- `createEmptyChat` (think) posts no `firstMessage`; `createChat` (legacy) posts it; the same `requestId` is the idempotency key on both doors
- the run socket URL and the agent route are addressed by `runs.id`, never a key

#### L. `apps/dashboard/test/run-approvals.test.ts` — Create
- the approval PATCH goes to `/api/approvals/:id`, never an agent RPC; a 409 renders as "someone else decided", not an error toast

## 3. How to execute — subagent-driven

Use `superpowers:subagent-driven-development`. One fresh subagent per file
(A–L), dispatched in parallel waves so independent files are written at once:

- **Wave 1 (parallel):** A, B, C, D — the P0 files. Independent of each other.
- **Wave 2 (parallel):** E, F, G, H, I.
- **Wave 3 (parallel):** J, K, L (dashboard; different package, different
  vitest config — the subagent must read `apps/dashboard/vitest.config.*`
  and an existing test there before writing).

Each subagent's prompt MUST carry, verbatim: the file it owns and its
behaviour list from §2; the coordination rules from §1 (test/ only, no
commits, no vitest runs, findings not fixes); the names of the model files
to read first; and the legacy suite to crib from. Tell it explicitly: **do not
run vitest and do not commit; write the file, run `pnpm typecheck` if you
like, report back.** A subagent that reports "I ran it and it passes" or "I
committed it" has broken the regime — note it, don't repeat it.

Between waves you (the orchestrator) review each file for the harness traps
in §1 — fresh keys, no absolute seq, no `runTurn` inside an RPC, no static
import of `src/agent/model` — because those are the bugs a run would have
caught and the regime says we catch them by reading instead.

When you finish a file (or a subagent reports one):
1. Skim it against the traps above.
2. Tick it off in §4 (edit this brief in place — this file is yours to edit;
   leave it uncommitted like everything else).
3. Anything you already know fails for a `src/` reason → `TEST-FINDINGS.md`,
   not a fix.

Then the run sequence in §1's speed regime: typecheck once → "READY TO RUN"
→ one vitest process over the new files → fix test bugs → "READY FOR FULL
GATE" → stop until the drill terminal acknowledges → full gate once.

## 4. Progress

- [ ] A core
- [ ] B loop
- [ ] C approvals
- [ ] D chassis/wake
- [ ] E agents route
- [ ] F steering
- [ ] G projection
- [ ] H connectors
- [ ] I guards for today's fixes
- [ ] J dashboard chassis
- [ ] K dashboard chat api
- [ ] L dashboard approvals
