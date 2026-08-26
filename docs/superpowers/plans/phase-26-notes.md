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
