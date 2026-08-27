# Phase 26 — agent layer rebuild on Think + Code Mode

Dated verification log and invented-API list for
`docs/superpowers/plans/2026-08-23-agent-rebuild.md`.

## Startup gate (Task 2) — PARTIAL, blocked on a first deploy

**2026-08-24.**

### Measured

| Figure | Value | Limit | Verdict |
| --- | --- | --- | --- |
| Bundle, uncompressed | 8902.03 KiB | 64 MB | fine |
| Bundle, gzip | 1710.78 KiB | 10 MB (Workers Paid) | **17% of ceiling — fine** |

Taken with `wrangler deploy --dry-run --outdir` at commit `afa811f`, with
`RunAgent`, `CodemodeRuntime` and the boot-probe connector in the entry's eager
graph. The uncompressed figure matches the ~10 MB eager graph the Phase 25
README recorded as its unsolved cost; gzip is what the platform limit is
actually applied to, and there is a lot of headroom.

Re-measure after Wave 2, when eleven namespaces and their vendor clients
(Zep, Linear, Supabase, LangSmith, Better Stack, GitHub, `@cloudflare/sandbox`)
are all reachable from the entry.

### Not measured — and why

**Nothing is deployed.** The startup time and the webhook p95 both need a live
Worker, and there is not one.

- `wrangler versions upload` → *"You cannot upload a new version of a Worker
  that does not yet exist."*
- The Workers API reports **zero Workers** on account
  `cdf27b547d94db5a7bb2f42b13c5319b`.
- `https://firefighter.sayandeten.workers.dev/api/health` returns a bare
  Cloudflare **404** (17 bytes, `text/plain`) — the `workers.dev` subdomain
  with nothing behind it, not the Worker's own 404 handler.

**A retracted measurement.** An initial run of the plan's webhook probe loop
against that hostname reported p50 834 ms / p95 1445 ms. Those numbers are
meaningless: the probe was measuring an edge 404, not the Worker. The probe as
the plan writes it cannot tell the difference, because it only reads
`%{time_total}`. **Amend Task 2 Step 3 to assert on the response body or a
Worker-set header before trusting any timing it produces.**

### State of the Cloudflare account

| Resource | State |
| --- | --- |
| Workers | **none** |
| D1 `firefighter` (`bbd12fae-0c81-4efc-800e-63669fc4905c`) | exists, matches `wrangler.jsonc`, **0 tables — migrations never applied** |
| R2 `firefighter-artifacts` | exists |
| Container image `firefighter-sandbox@sha256:dc9b98e0…` | referenced by config; presence not verified |

So the deployed state that `README.md` and `CLAUDE.md` describe does not
currently exist. This is not a consequence of the rebuild — the agent layer was
removed on 2026-08-23 and nothing has been deployed since, and the empty D1
predates that.

### Auth

`CF_API_TOKEN` is exported from `~/.bashrc` and is **rejected** by the API
(`Invalid access token [code: 9109]`); wrangler prefers it over the stored
session, so every wrangler command that talks to the API fails until it is
unset or replaced. The OAuth session at
`~/.config/.wrangler/config/default.toml` is valid for the same account and
carries `workers (write)`, `workers_scripts (write)`, `containers (write)`,
`d1 (write)`, `queues (write)` — enough to deploy. Every command in this log
that reached the API ran with `env -u CF_API_TOKEN`.

### What the first deploy will do

It is a **create**, not an update, and it is the human's to run (the plan's
review gate reserves deploys):

1. create the Worker and bind `firefighter.sayandeten.workers.dev`;
2. apply DO migrations `v1`→`v5` from scratch, creating `RunAgent`,
   `CodemodeRuntime` and `Sandbox`;
3. provision the container from the prebuilt image;
4. bind D1, R2 and the three queues.

D1 **table** migrations are separate and must be applied too, or every route
that touches the database 500s:

```bash
cd apps/worker
env -u CF_API_TOKEN npx wrangler d1 migrations apply firefighter --remote
env -u CF_API_TOKEN pnpm run deploy    # builds the dashboard, then deploys
```

Then the startup time is reported on upload (platform limit **1 s**, enforced —
a Worker over it is refused, so this is pass/fail rather than advisory), and the
webhook probe becomes meaningful.

## Invented or corrected APIs

**1. `createExecuteTool` refuses an empty connector list.**
`@cloudflare/think/dist/tools/execute.js:84` — *"createExecuteTool has nothing
to expose — provide at least one of `tools`, `state`, `browser`, or
`connectors`."* Passing `connectors: []` with `state: undefined, browser:
undefined` throws at construction. Worked around with
`src/run/boot-probe.ts`, a placeholder namespace Task 8 deletes, so that the
`CodemodeRuntime` facet — and therefore migration `v5` — could be proven in
Task 1 rather than in Task 8. `facets.get` is lazy, so only a real call into
the facet (`this.codemode.executions()`) can tell whether the migration is
right; counting tool names cannot.

**2. `sendIdentityOnConnect` is the supported fix for the run-key leak.**
`agents/dist/index.js:951-964` gates the `cf_agent_identity` frame on
`this._resolvedOptions.sendIdentityOnConnect`, and warns when the instance name
is not already visible in the URL — exactly this project's case. `static
options = { sendIdentityOnConnect: false }` on the agent class is the whole fix.
Phase 25 shipped the leak and pinned it as an `it.fails`; no WebSocket relay is
needed.

**3. The merged tool map can never be one entry.**
`think.js:2628` calls `createWorkspaceTools(this.workspace, { bash:
this.workspaceBash })` unconditionally, and `tools/workspace.js:72` always
returns `read, write, edit, list, find, grep, delete` — only `bash` is
conditional. `this.workspace` is auto-created in `onStart` when unset, so there
is no configuration that yields zero workspace tools. Invariant 5 is therefore
enforced as `beforeTurn → activeTools: ["run_code"]` (the control Think
forwards to `streamText` at `think.js:2729`) plus an exact-allowlist assertion
on the merged map (the tripwire). Any claim that this agent "has exactly one
tool" must be phrased against the active set, not the merged set.

## Deferred decisions

**2026-08-24.**

**The first deploy is deferred.** Task 2's startup-time and webhook measurements
stay open until it happens; the bundle measurement above is complete and is the
part that constrains design. Waves 1–4 need no deployment, so the rebuild is
not blocked. Reopen Task 2 after the deploy, and fix its Step 3 probe to assert
on the response body first — as written it happily measures an edge 404.

**An ORM is deferred, and the choice is Drizzle when it happens.** Considered
Prisma and Drizzle; the reasons, for the record:

- Prisma on D1 needs `@prisma/adapter-d1` with the `driverAdapters` preview
  feature and a `prisma generate` codegen step producing a client in the
  entry's graph. This Worker has a hard 1 s startup limit and already carries
  cold start as a known cost.
- The migrations in `apps/worker/migrations/` are append-only, hand-written,
  and their comments encode design rationale (why `in_doubt` is a first-class
  state, why `agent_model_calls` is unique on
  `(generation_id, attempt, step_index)`, why `approvals` uses a partial unique
  index). Prisma wants `schema.prisma` to own that. Drizzle is content to be a
  typed query builder over tables it did not create, with `drizzle-kit`
  strictly optional.

Not now, because: 67 `.prepare()` sites across 17 files, several with subtle
semantics (`approval/repository.ts` D1 CAS + partial unique index,
`memory/outbox.ts` claim tokens and leases, `run/repository.ts` projection
ordering); the rebuild adds no new tables, so an ORM buys it nothing; and the
714-test baseline is the oracle for agent-layer regressions and should not be
churning at the same time.

When it happens, convert module by module **behind the existing exported
function signatures** (`getRunById`, `decideApproval`, `claimNudge`, …). Nothing
outside `src/db/*.ts` and the `*/repository.ts` modules then changes, every
existing test stays the oracle, and it lands as ~17 reviewable commits instead
of one big-bang diff.

## Test-harness noise, not a defect

**2026-08-24.** A full `pnpm test` prints, before any test file result:

```
exception = workerd/api/streams/internal.c++:2563: disconnected: pump canceled
exception = kj/async-io.c++:1713: disconnected: fixed-length pipe ended prematurely
uncaught exception; source = Uncaught (in promise); stack = Error: Network connection lost.   (x2)
```

**It is pre-existing and unrelated to the rebuild.** Verified by removing the
Wave 1 modules, reverting `src/index.ts` and `wrangler.jsonc` to `55fd2e3`
(before `RunAgent` entered the entry's eager graph) and re-running: the same
two occurrences appear, with the same two workerd stream messages. It fires at
pool boot, before the first test file, so it is not attributable to any suite.

Recorded here so the next person reading a green gate does not spend the
twenty minutes again. If it ever needs fixing it is a harness issue, not an
agent-layer one.

## Docs audit before Wave 3 (2026-08-24)

Prompted by the question "are we leveraging the Agents SDK, Think and Code Mode
fully, or carrying the old code's habits?" — asked after Waves 0–2 landed and
before the turn-lifecycle work began. All ~50 relevant pages under
`developers.cloudflare.com/agents/` were read, and every claim that mattered
was checked against the installed pins (`agents` 0.20.1, `@cloudflare/think`
0.15.1, `@cloudflare/codemode` 0.5.1) in `node_modules/*/dist`, because the
docs describe a moving target and the pins do not move.

### Verdict

The architecture holds. Every custom piece was tested against the SDK
alternative and each stands on verified grounds (§"What stands", below). But
the plan for Tasks 13–28 was written from the deleted code's assumptions, and
roughly a third of it would have rebuilt things Think already does — or done
them the way the docs say not to. Two of the findings are bugs in code already
committed. The plan and the spec were amended the same day; this section is
the evidence they cite.

### Bugs in committed code

**1. The per-execution call budget was per-call.** `FirefighterConnector`'s
`execute(args)` ignored the second argument — codemode passes
`{ executionId }` (`dist/index.js:1586`) — and `RunAgent` handed
`buildConnectors` a provider that minted a fresh `BindingContext` on every
call. So `newCodeExecution`'s budget (40 calls) reset per call and could never
trip, and a customer reference minted by `memory.findCustomers` in one call was
unknown to `slack.searchMessages` in the next call of the same execution. Fixed
by memoising the context per `executionId` inside the connector and evicting it
in `onPassEnd(executionId, status)`.

**2. The run id lived in an in-memory field.** `#cachedRunId` on the agent is
lost on every hibernation, and the Task 19 plan to persist it with
`this.configure()` referenced a method that **does not exist** on Think 0.15.1
(`grep configure index-s3Pl812H.d.ts` finds only `configureChannels` and
`configureSession`). Run-scoped durable state is `this.state`; turn-scoped
facts travel on `runTurn({ metadata })` and read back via
`this.activeTurnMetadata`.

### Invented or corrected APIs (continued from §1–3 above)

**4. `this.configure()` / `getConfig()` do not exist on Think 0.15.1.** The
Think docs' configuration page describes them; the pin has neither. Persisted
per-run state is `this.state` (SQLite-backed, broadcast to connections on
`setState`).

**5. Session context blocks are rendered ONCE and cached, not per turn.**
`freezeSystemPrompt()` loads each provider's `get()` once per isolate;
`withCachedPrompt()` persists the rendered prompt in SQLite until
`refreshSystemPrompt()`. A per-turn `RunScope` as a context block would freeze
the first turn's scope for the life of the object. And once any block has
content, **`getSystemPrompt()` is silently ignored** (d.ts:1866-1873). Static
text belongs in get-only `withContext` blocks; per-turn text in
`beforeTurn → { instructions }` or a channel's `instructions(ctx)`, which IS
re-evaluated per turn (think.js:2657).

**6. `onStepFinish` is deprecated in 0.15.1** (d.ts:2334) in favour of
`onStepEnd(ctx: StepContext)`. Same context; the plan named the old one.

**7. Think's recovery is on by default.** `chatRecovery = true` (think.js:920)
wraps every turn in a fiber with keepalive; an interrupted turn resumes after
eviction; `repairInterruptedToolPart` flips a dangling `run_code` call to
`output-error` before the model sees it. There is nothing to build for
interruption. What is NOT handled: refusals (`@ai-sdk/anthropic` 4.0.37 maps
Anthropic `stop_reason: refusal` → `finishReason: "content-filter"`, a normal
finish visible only in `onStepEnd`/`onChatResponse`), recovery exhaustion
(`chatRecovery.onExhausted`), and — a leak — `onChatError`'s return value
becomes the client-visible error text (think.js:2405-2411), so provider error
bodies broadcast to every dashboard tab unless overridden to return scrubbed
text.

**8. Readonly connections do not gate chat.** `shouldConnectionBeReadonly`
exists on Agent but only rejects client `cf_agent_state` pushes;
`grep readonly think.js` → zero hits. Think honours `clear` (wipes history),
`cancel` (aborts the turn) and `chat-request` (starts a real turn, bypassing
`steer`) from ANY connection. Human input has to be forced through the `steer`
RPC by re-wrapping `onMessage` to drop those frames.

**9. `routeAgentRequest`'s hooks cannot remap the instance.** partyserver
computes `idFromName(name)` from the third path segment BEFORE
`onBeforeConnect`/`onBeforeRequest` run; they can substitute the Request the
DO sees but not which DO. A path rewrite works but leaves the private key in
`connection.uri`. The built-in indirection is `useAgent({ basePath })` on the
client and `getAgentByName(ns, key).fetch(request)` on the server — the key
then never appears in any URL.

**10. `addMessages` is idempotent by message id** across the whole session
tree (d.ts:528-545). The SDK has NO idempotency for `@callable` RPC — the
client may re-send after reconnect. So a steer dedupes on
`addMessages([{ id: requestId, … }])`, not on a hand-rolled table.

**11. `beforeStep` cannot end a turn.** `StepConfig` has no stop; the
per-turn ceiling is `TurnConfig.stopWhen` / `maxSteps` from `beforeTurn`
(default `maxSteps` is 10). Cumulative usage is already on
`PrepareStepContext.steps[].usage` — no DB read needed for a spend preflight.

**12. `createExecuteRuntime` hardcodes `maxExecutions: 50`** and passes no
override through, and `cm_log` stores connector `args` and `result` verbatim.
So "cm_log is the audit trail" (decision B) is bounded to the newest 50
terminal executions per DO, and every large read result (Better Stack logs,
Supabase rows, sandbox file reads) is persisted in DO SQLite although this
project never pauses/replays. `replay: "reexecute"` on a tool makes
`recordResult` store `null` for it.

**13. A custom `description` on the codemode tool DISCARDS `connectorHints`.**
`buildDescription` (codemode `dist/index.js:1629`) returns the custom string
verbatim; hints render only into the default description. Decision A must
pass hints and NO description.

**14. `createSandboxTools()` in `@cloudflare/think/tools/sandbox` is a no-op**
that returns `{}` and `console.warn`s once. The docs' "sandbox tool" is
`getSandbox()` from host code. Browser Rendering (`createExecuteTool`'s
`browser` option → `cdp.*`) runs off-container, reaches public URLs only, and
its `session.recording` produces rrweb JSON readable via the REST API after
the session closes — not a video file. Neither replaces the per-run container
+ Playwright → mp4 → R2 proof path.

**15. Chat SDK's Slack adapter is not a fit.** `@chat-adapter/slack` via
`chatSdkMessenger` posts only with the bot token, routes DMs by default, wakes
the model on every matching event, and keeps thread state in DO SQLite. Four
hard rules of this brief in one package. The webhook → queue → ingest → triage
path and the `slack.reply` capability stay.

**16. The SDK emits GenAI OTLP spans natively.** Think imports `wrapAISDK`
from `agents/observability/ai` and emits `gen_ai.*` attributes (usage, tool
name/args/result, messages) gated by `storeTools` / `storeMessages`
(defaults false, all-or-nothing). Workers traces export over OTLP to a
dashboard-configured destination; LangSmith ingests OTLP at
`/otel/v1/traces` with `x-api-key` + `Langsmith-Project` headers. This can
replace the hand-written tracer — at the cost of the `redacted` payload mode,
which the SDK has no equivalent of. Left as an explicit decision on Task 26.

**17. `configureChannels()` is the delivery-label mechanism.** A channel of
`kind: "custom"` with websocket ingress has no out-of-turn delivery surface,
so its final assistant text goes to the transcript only — which is exactly
"Slack final text is internal narration". `kind: "web"` is the visible
surface. `instructions(ctx)` is prepended per turn; `maxTurns` caps steps per
channel; `this.activeChannel` is readable in hooks. `deliverNotice` to a
custom channel throws — customer posting stays a capability.

**18. Approval — three independent verified grounds** for keeping it a
model-called capability: Think `approveExecution(executionId: string)` and
codemode `approve({ executionId })` both take only an id (no edit path);
codemode `requiresApproval` is a static boolean (gates every call, which the
brief forbids); a Think `action()` can gate on a function of input but is a
second outer tool that bypasses the write guard. The only payload-carrying
approve in the SDK is Workflows' `approveWorkflow({ metadata })`, which would
move the parked step out of the DO/D1 CAS model.

### What stands (verified against the SDK alternative)

| Custom piece | SDK alternative considered | Why ours stays |
| --- | --- | --- |
| `effects.ts` cross-execution ledger | codemode replay; Think action ledger | codemode replay keys `(execution_id, seq)` within one execution; the action ledger covers outer actions, not connector calls. Two `run_code` calls sending the same reply both execute without ours. |
| `write-guard.ts` | — | App policy; nothing comparable. |
| `guarded-loader.ts` | `DynamicWorkerExecutorOptions` | Has no `limits` field; the loader wrapper is the only injection point. |
| `connector.ts` + `schema.ts` | `ToolSetConnector` | Converts correctly via `asSchema`, but drops `outputSchema`, surfaces raw Zod errors (ours: `invalid_input` naming paths, never values), has no `unrepresentable: "any"` escape for `files.publish`, and memoises identically. Thin layer, documented reasons — keep. |
| `execution.ts` budget / freshness / customer refs | — | No SDK equivalent for any of the three. |
| Slack ingest + `slack.reply` | Chat SDK Slack adapter | §15. |
| Container + Playwright proofs | `createSandboxTools`, Browser Rendering | §14. |
| `model.ts` (BYO `LanguageModel` via gateway URL) | `"anthropic/…"` slug over `env.AI` | Documented BYO path; keeps `AGENT_MODEL_DISABLED` and the `vi.mock` seam. Did not verify how the slug path picks a gateway id — do not switch on the docs alone. |
| `memory` namespace over Zep + D1 outbox | Session memory, `Agent.queue()` | Session memory is per-DO, no org scope, no citations. `queue()` would duplicate the outbox. |


## Wave 3 implementation notes (2026-08-27)

Tasks 13–18 landed. Gate at the end: **64 files / 936 tests passed**, `tsc
--noEmit` clean, `capabilities:dts:check` in sync. Baseline before the wave was
58 files / 862.

### Invented or corrected APIs (continued from §1–18)

**19. `TurnConfig.instructions` REPLACES the assembled system prompt.**
`think.js:2678` is `config.instructions ?? config.system ?? …`, so returning the
per-turn text alone from `beforeTurn` silently drops every context block AND
Think's own capability preamble. The plan said "beforeTurn returns
`{ instructions: turnInstructions(...) }`", which would have shipped a run with
no policy, no voice and no capability rules. The agent appends to `ctx.system`
(`composeInstructions`). Same for `StepConfig.instructions` in `beforeStep`,
which is why the turn's composed text is cached on the instance.

**20. `createExecuteRuntime` does not forward `connectorHints`.** Decision A
was "pass hints, no description". The option does not exist on Think's wrapper:
`think/dist/tools/execute.js:113` derives hints only for the namespaces it
wires itself (`tools`, `state`, `cdp`), all of which this agent passes as
`undefined`, and `CreateExecuteToolOptions` has no hints field to pass through.
So the tool is built with NO `description` (keeping Code Mode's workflow and
discovery text, per §13) and the eleven one-line namespace hints moved into
`CAPABILITY_RULES_BLOCK` in the system prompt. Same tokens, stable across turns.

**21. Anthropic caching on this chassis is REQUEST-level, not per block.** Think
hands `streamText` a single `system` STRING, so the old two-breakpoint layout
(`SystemModelMessage[]` with `providerOptions` per block) has nowhere to live.
`@ai-sdk/anthropic` accepts a call-level `providerOptions.anthropic.cacheControl`
and puts it at the top of the request body (`dist/index.js:3954`). Anthropic
builds its prefix tools → system → messages, so the `run_code` description stays
cached across turns even though the per-turn instructions change, and within one
turn every step after the first reuses the whole system prefix.

**22. `runTurn` from a scheduled callback is fine; from an RPC it deadlocks.**
The Phase 25 note said "never call `runTurn` from inside a DO RPC method — it
deadlocks even unawaited". Confirmed the hard way: `steer()` is reached as an
RPC from every caller, and calling `runTurn` inline wedged the object with no
error (the test run had to be killed). `this.schedule(0, "startSteerTurn", …)`
runs the submit from the alarm instead and returns immediately.

**23. `activeTurnMetadata` is NOT an AsyncLocalStorage read.** The Task 15
caveat asked whether it survives the connector's RPC boundary. It does:
`think.js:1754` is a plain getter over `this.messages`, reading the metadata
stamped on the turn's user message. The revision is still snapshotted into an
instance field in `beforeTurn`, because a RECOVERED turn must be judged against
the revision it was started for, not the current one.

### Harness limits found, not defects

**A turn with no model wedges the object.** The pool binds
`AGENT_MODEL_DISABLED=true`, so any real `runTurn` fails inside Think's fiber
and the DO stops answering RPC. `test/run-agent-steering.test.ts` therefore
asserts only `steer`'s return value on the wake path and nothing after it. The
wake path's own behaviour is Task 19's, against a model seam it can control —
worth planning a fake `LanguageModel` there rather than relying on the disable
flag.

**A throw crossing an RPC stub is logged as an uncaught exception** even when the
caller handles the rejection, which turns one deliberate assertion into
permanent suite noise. Two places now keep the throw inside the object:
`stepEndOutcomeForTest` (invariant 17) and `steerText` (extracted to
`agent-steering.ts` so the refusal is a pure unit test). The two
"Network connection lost" lines at pool boot are the pre-existing noise recorded
above and are unchanged.

### Files added

`src/run/agent-prompt.ts`, `agent-voice.ts`, `agent-channels.ts`,
`agent-spend.ts`, `agent-projection.ts`, `agent-steering.ts`; tests
`test/run-agent-{prompt,spend,freshness,projection,outcome,steering}.test.ts`.
`agent-voice.ts` is one file beyond the plan's list for Task 13: the frozen
engineer-voice resolution is 180 lines with its own D1 query and freeze
reasoning, and folding it into `agent-prompt.ts` would have buried it.

`casRunStatus` was added to `src/run/repository.ts` rather than reusing
`setRunStatus`: the unconditional version cannot be safe on the projection path
(two racing projections would both validate against `live` and the loser would
overwrite the winner).

### Still open

- Tracing (Task 26) is still an open decision.
- Tasks 2 and 28 are blocked on the first deploy (0 Workers on the account).

## Wave 4 implementation notes (2026-08-27)

Gate before: 64 files / 936 tests. After: **67 files / 986 tests**, `tsc
--noEmit` clean, `capabilities:dts:check` in sync.

**24. THE HARNESS LIMIT FROM WAVE 3 IS GONE, and it was the biggest single
unlock in this wave.** `src/run/model.ts` now carries `installTestModel` /
`resetTestModel` — one nullable module variable, the same shape as
`installApprovalApiPorts`, read at the top of `buildModel` so it takes
precedence over `AGENT_MODEL_DISABLED`. `test/helpers/canned-model.ts` builds a
`MockLanguageModelV4` from `ai/test` that emits one text step and a `finish`,
never touching the network. With it a submitted turn actually completes: submit
→ alarm drain → `beforeTurn` → model → `onStepEnd` → usage row in D1, all
assertable from a test. Everything Wave 3 could only assert up to the submit is
now asserted past it.

Two details the mock had to get right against the installed spec: `ai` 7's
`LanguageModelV4FinishReason` is an OBJECT (`{ unified, raw }`), not a string;
and `@ai-sdk/provider` has no direct dependency entry, so the stream-part type
is derived from `MockLanguageModelV4["doStream"]` rather than imported.

**25. `runTurn({ mode: "submit" })` returns before the turn runs.**
`think.js:5429` inserts the `cf_think_submissions` row, emits, and calls
`schedule(0, "_drainThinkSubmissions")` — so a wake from the Worker is three
fast RPCs and the model work happens on the object's own alarm. That is why the
new suites poll (`test/helpers/wait.ts`) rather than awaiting the wake: the
usage row, the projected status and the resolution turn all land after the call
the test awaited. It is also why `wakeRun` is safe to call from a queue
consumer.

**26. Idempotency is `accepted: false`, and it is exact.** A repeat
`idempotencyKey` returns the EXISTING submission's inspection with
`accepted: false` and schedules a drain if it is still pending
(`think.js:5443-5451`). So the D1 `triage_decisions` belt upstream and the
submission row downstream are two independent guarantees, and the wake path
needs no delivered-CAS of its own. Task 21's notifier relies on the same thing:
the cron re-submits `approval:{id}` unconditionally.

**27. `onStart` is the self-healing half of `bindRun`, not a replacement.**
The wake path binds the run id explicitly, but a dashboard socket, an approval
resolution and a scheduled callback after an eviction all reach the object
without going through a wake. `onStart` resolves `runs.key === this.name`
through D1 and binds. It is deliberately caught rather than thrown: a throw out
of `onStart` is terminal (partyserver resets its init state and the next
request re-runs the same failing start), so a D1 blip would make the object
permanently unreachable rather than temporarily unbound.

**28. The turn id was stamped and never read.** `#turnId()` returned `"boot"`
for every run, so every `RunScope`, usage row and capability audit was
attributed to a turn that does not exist. `beforeTurn` now adopts
`activeTurnMetadata.turnId` into `this.state.turnId` and `onChatResponse`
clears it. Every entry point mints ONE id and passes it as both the
`idempotencyKey` and the `turnId`, so a redelivery refused as a duplicate was
never given a second identity.

**29. `state.lastApprovalId` is new, and `withdraw` needs it.** The resolution
clears `openApprovalId` to unpark the run, which leaves a withdraw arriving
microseconds later with nothing to look at — and the old stub answered
`withdrawn: true` unconditionally, telling the model it had retracted a message
that may already have gone to the customer (defects 4-6). The last id is never
cleared, so the port can ask D1 what actually happened.

**30. Delivery moved out of the DO and into the notifier.** In the deleted
build `RunDO.resolveApproval` ran the delivery sub-machine because the
destination came from DO run state. It now comes from the D1 `runs` row, which
is host state either way (invariant 10), so the whole machine — the shadow OR,
the `none -> sending` CAS that is the only guard against a second send, the
re-read on a refused CAS — lives in `src/approval/notifier.ts`. The order is
unchanged and still load-bearing: settle delivery, unpark, submit.

### Decisions made here, not in the plan

**An expiry does not decide for the human.** The plan said to schedule
`approvalExpired` and did not say what it should do. It withdraws the card —
losing gracefully to a decision that landed first — and sets the run `failed`.
`failed` rather than `idle` on purpose: a failed run releases its Slack thread,
and triage's abandoned-thread override reads exactly that status to re-wake a
thread whose run died, so a customer who follows up after a timeout is answered
instead of reasoned into silence. `APPROVAL_TTL_SECONDS` is 6 hours, a reviewed
default and not a vendor constant.

**The nudge is scheduled, not awaited.** `open()` writes the card and then
schedules `nudgeApproval`; awaiting `sendNudge` would put its eight-second
Slack timeout inside the model's own `run_code` execution. The alarm cannot run
until the turn ends, which is exactly when the run actually parks.

**`makeProductionSender` has one implementation.** `makeUserTokenSender`
already answers `blocked: no fire-fighter has connected Slack` without making a
request, so an unconfigured deployment and a configured one take the same path
and the same code decides. Composing `makeIdentityRefusingSender` behind an env
check would have been a second way to reach the same answer.

### Files added

`src/run/wake.ts`, `src/approval/port.ts`, `src/approval/notifier.ts`; tests
`test/run-wake.test.ts`, `test/approval-port.test.ts`,
`test/approval-resolution.test.ts`; helpers `test/helpers/canned-model.ts`,
`test/helpers/wait.ts`.

Two re-pins the plan asked for are restored: the "no run session state was
written" half of `test/approval-api.test.ts`'s D1-only claim (now assertable —
reading the state is what wakes the object for the first time), and the three
`approval_card` projection properties from `test/notify-nudge.test.ts`, which
moved to `test/approval-port.test.ts` because the projection job is gone and
`ApprovalPort.open` writes the card itself.

### Noise, not failures

A completed suite now logs `disconnected: pump canceled` and
`fixed-length pipe ended prematurely` from workerd. They appear only since real
turns run under the pool — Think's UI stream is torn down when a turn ends —
and no test fails on them. Worth a look if they ever coincide with a failure.


## Wave 5 implementation notes (2026-08-27)

Gate before: worker 67 files / 987 tests, dashboard 4 files / 26 tests. After:
worker **69 / 1014**, dashboard **6 / 59**, `tsc --noEmit` clean in both,
`capabilities:dts:check` in sync.

**31. THE FRAME FILTER MUST BE INSTALLED IN `onStart`, NOT THE CONSTRUCTOR —
and this one shipped broken before it was measured.** The plan says to re-wrap
`onMessage` "after `super()`". That is wrong for this pin: Think installs its
own protocol `onMessage` wrapper from `_setupProtocolHandlers()`
(`think.js:1036`), which runs **during `onStart`**, i.e. after every constructor
in the chain. A filter wrapped around `this.onMessage` in the constructor
therefore sits UNDERNEATH Think's and never sees a protocol frame at all —
Think handles `chat-request` and returns without delegating.

Not deduced: the first run of `test/agents-route.test.ts` sent a
`cf_agent_use_chat_request` frame over a real socket and got back a completed
turn with the client's text in it, plus a `cf_agent_chat_clear` that wiped a
transcript. `RunAgent.onStart` runs at `think.js:1039`, three lines after that
setup, so `#filterClientFrames()` is called from there and is re-applied per
wake because Think re-installs its wrapper per wake.

**32. `shouldConnectionBeReadonly` gates ONE thing.** It refuses client
`cf_agent_state` frames and throws out of `setState` inside a
connection-scoped invocation (`agents/dist/index.js:865, 1133`). It does not
gate `@callable` RPC and does not gate a single chat frame. So readonly and the
frame filter are two controls with no overlap, and the five frames in
`BLOCKED_CLIENT_FRAMES` are each a way to drive a run around everything this
codebase enforces.

**33. That readonly rule broke `steer`, which is the one thing a browser MAY
do.** `steer` is `@callable`, so it runs inside `runInInvocation({ connection })`
— and it called `noteInput()`, which calls `setState`, which throws "Connection
is readonly" in exactly that context. The revision is now minted inside
`startSteerTurn`, which runs from the alarm outside any connection. That is also
the more honest place for it: the revision belongs to the turn that actually
starts.

**34. The transport is `/api/runs/:id/agent/*` and `getAgentByName().fetch()`,
not `routeAgentRequest`.** `routePartykitRequest` names the object with
`idFromName(<path segment>)` verbatim, so the previous build resolved the id to
the key and REWROTE the path — which put the private run key in the URL the
object reads back as `connection.uri`. `getAgentByName` takes the key as an
argument, so it never appears in a URL. partysocket builds the socket URL as
`${host}/${basePath}` (`partysocket/dist/index.js:50`), which is why the route
answers both the bare path and `/*`, and why `basePath` carries no leading
slash. Think serves `/get-messages` off the same path
(`think.js:6136`), so the transcript read inherits the gate rather than needing
one of its own.

**35. The identity header is delete-then-set.** The agent cannot verify an
identity that crossed a Durable Object boundary, so a client-supplied
`x-firefighter-identity` would be indistinguishable from the one the route
writes. `src/api/agents.ts` deletes any inbound copy before setting its own,
after `requireTeamMember` has verified the Access JWT.

### Decisions made here, not in the plan

**A retried create resolves to the same run.** The plan specifies
`idempotencyKey: clientRequestId` on the submission, which dedupes the opening
TURN inside a run that has already been created — so a client retrying a POST it
never saw the response to would leave a second, half-empty run in the dashboard
list every time. `createRunFromChat` now derives the `chat:{uuid}` key from
SHA-256 over the actor and the request id, so the retry resolves to the same
run. The actor is in the digest so two people whose clients mint the same id
cannot land in one conversation.

**The two idempotency rules are OPPOSITES, on purpose.** A steer that failed may
never have arrived, so re-asserting it mints a fresh request id — reusing one
would have the agent refuse a steer it never took. A create that failed may
already have written a run, so re-asserting it reuses the id. Both are pure
functions (`makeSteerSender`, `makeChatStarter`) precisely so the difference is
testable and stated rather than implied.

**The composer has ONE verb.** The view this replaces had two — `sendMessage`
when idle, `steer` when busy. `sendMessage` sends `cf_agent_use_chat_request`,
which the frame filter now drops, so that path would fail silently. Every send
is a steer.

**`GET /api/runs` and `/runs/:id/usage` are still gated by Access alone.** The
new routes take the inner `requireTeamMember` check; those two pre-date it and
were not touched. Worth resolving one way or the other in Task 28's security
table rather than leaving a half-gated router.

### Files added

`apps/worker/src/api/agents.ts`, `src/run/transport.ts`; tests
`test/agents-route.test.ts`, `test/api-runs.test.ts`.
`apps/dashboard/src/runs/use-run-agent.ts`, `src/runs/run-view.tsx`,
`src/chat/api.ts`, `src/chat/chat-page.tsx`; tests `test/run-view.test.tsx`,
`test/chat-page.test.tsx`.

`src/run/transport.ts` is one file beyond the plan's list: the header constant
and the blocked-frame list are needed by BOTH `src/api/agents.ts` and
`src/run/agent.ts`, and putting them in either would have made the two import
each other.

### The dashboard's harness, restated

`apps/dashboard` has **no DOM** — `vite.config.ts` is the whole vitest config,
there is no jsdom and no testing-library, and rendering is
`renderToStaticMarkup`, which cannot run effects. Every component this wave adds
is therefore split in two: a pure view that takes what it draws as props, and a
four-line container that wires the hook. That is what makes the four states and
both idempotency rules assertable at all; a single component calling `useAgent`
would have been untestable in this package.

### Still open

- `dev-stubs.ts` does not stub the three new Access-gated surfaces, and says so
  in a comment. `wrangler dev` has no Access in front of it, so the create, the
  run detail and the socket all answer 401 on localhost. A fake create would
  hand back an id whose socket then refuses; a stubbed socket would be a fiction
  of a live transcript. They are exercised against a deployed Worker.


## Wave 6 implementation notes (2026-08-27)

Gate before: worker 69 files / 1014 tests, dashboard 6 / 59. After: worker
**72 / 1036**, dashboard unchanged, `tsc` clean in both,
`capabilities:dts:check` in sync.

**36. `agentId` on a trace span defaults to the PRIVATE run key.** Think's
`_turnTelemetry` stamps `agentId: this.name` (`think.js:2548`), and on `ai` 7
the v7 path spreads caller `metadata` into the runtime context before deleting
the key from the forwarded options (`think.js:2569, 2593`). Left alone, every
customer conversation would put `slack:{channel}:{thread_ts}` into a
third-party trace store — invariant 10 broken somewhere nobody greps.
`beforeTurn` overrides it with the public `runs.id`.

**37. `TurnConfig.telemetry` does not type the shape Think honours.** It is
`streamText`'s `experimental_telemetry`, which on `ai` 7 is `TelemetryOptions`
— and that type has no `metadata` (v7 replaced it with `runtimeContext`). Think
reads `settings.metadata` at runtime regardless. `turnTelemetry()` carries the
cast and the reason, rather than the field being dropped silently.

**38. `storeMessages` / `storeTools` are the whole payload policy, and it is
all-or-nothing.** Both go straight to `wrapAISDK` (`think.js:2827`). There is no
per-field switch, which is what settled Task 26's trade-off: tool payloads on
(our program, our results), messages off (the customer's thread, the triage
briefing, recalled memory).

**39. Codemode's `cm_log` stores a call's args AND its result verbatim**, for
replay to return on a resume pass. `replay: "reexecute"` marks a call ephemeral
so its result is never stored (`codemode/dist/base-BqhlNCSH.js:80`). The rule
adopted is the effect classification rather than a per-method judgement: EVERY
`read` is ephemeral, because a read's result is the one unbounded thing in this
system made entirely of other people's data. Writes stay logged — re-executing
one would do it twice. The runtime refuses `requiresApproval` combined with
`reexecute`, which this repo never sets anyway.

**40. `_cf_KV` and `_cf_METADATA` refuse SQL with `SQLITE_AUTH`.** The canary
sweep enumerates `sqlite_master` and would otherwise die on the first one. The
DO's key-value surface is where `this.state` and every scheduled payload live,
so it is swept through `ctx.storage.list()` instead — the hole is covered, not
excused. D1's `_cf_METADATA` is its own bookkeeping and is skipped by an
explicit rule, with an assertion that every application table this run wrote to
was actually read, so that rule cannot quietly grow.

### The canary sweep drives a real run

`test/canary-secrets.test.ts` is not a unit test with a mock. It wakes a Slack
run, has the model call `run_code`, executes the model-authored program in a
Worker Loader isolate, calls `approval.escalate` through the connector, writes
the D1 card, decides it as a human, delivers the resolution — and then sweeps
every table in D1 and in the agent's own SQLite for every secret-shaped binding
on `env`.

Two properties of it are the point:

- **The canaries are the pool's OWN bindings**, enumerated off `env` by a NAME
  pattern at runtime — the synthetic `not-a-real-*` fixtures and whatever a
  developer's `.dev.vars` supplies. A planted value would only prove the planted
  value did not leak; this covers the credentials the code actually holds,
  including ones added after the file was written.
- **Failures name the binding, never the value.** The subject of the file is
  that credential values do not belong in durable places, and a test report is
  one of those places.

`toolCallingModel` in `test/helpers/canned-model.ts` is what made this possible:
two passes, the first ending in a `run_code` tool call with
`finishReason: "tool-calls"`, the second the answer.

### Decisions made here, not in the plan

**The memory episode is built from four host-held values, not filtered out of
the transcript.** `asked` is read in `beforeTurn` (the transcript ends with this
turn's user message there, and by `onChatResponse` the reply is on the end of
it); `draft` is the selected final assistant text the hook hands over; `actions`
are capability names and error codes off the audit sink; sources are
host-produced ids. Reasoning is absent because no field reads a reasoning part
at all — the exclusion list is structural rather than a filter.

**`Agent.queue()` is deliberately not used for memory.** The D1 outbox already
owns cross-DO durability and has a one-minute cron sweep behind it. A second
durable queue for the same job would be two protocols that only work if there is
one.

**A turn with nothing asked, nothing done and nothing drafted writes no
episode.** That is what a failure before the model looks like, and an episode of
it is noise a future recall has to read past.

**One `subscribe("chat", …)` at module scope**, logging event types only.
`subscribe` registers a process-wide listener, so a per-request call would
attach a new one every time; and the payload of a chat event can carry request
metadata, so nothing but the type is logged — Workers Logs is a durable sink and
invariant 39 applies to it exactly as it applies to a D1 row.

### Files added

`apps/worker/src/run/agent-memory.ts`; tests `test/run-agent-memory.test.ts`,
`test/run-agent-tracing.test.ts`, `test/canary-secrets.test.ts`.

Removed: `LANGSMITH_TRACING`, `LANGSMITH_TRACE_PROJECT` and
`LANGSMITH_TRACE_PAYLOADS` from `wrangler.jsonc`, `src/index.ts` and
`vitest.config.ts` — the writer that read them is gone.

### Still open

- **`worker-configuration.d.ts` still declares `LANGSMITH_TRACE_PAYLOADS`.** It
  is generated by `pnpm cf-typegen`, which is machine-dependent on the local
  `.dev.vars`, so it was NOT regenerated here — that belongs to whoever next
  runs it legitimately. Nothing reads the field, so the staleness is cosmetic.
- **The drill dry run needs the deploy**, which is the human's. Four scenarios
  in `#test-firedrill` per `docs/drill.md`; record the outcomes here.
- **`GET /api/runs` and `/runs/:id/usage` are gated by Access alone**, while
  every route Phase 26 added also takes the inner roster check. Worth settling
  one way or the other.
