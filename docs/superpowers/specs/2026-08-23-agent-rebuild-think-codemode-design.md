# Agent layer rebuild on `@cloudflare/think` + Code Mode — design

Date: 2026-08-23. Status: approved in brainstorming, awaiting spec review.
Supersedes the chassis parts of `2026-08-16-think-chassis-migration-design.md`
(D1, D7 are moot; every other decision is re-affirmed or amended below).

## 1. Context

Commit `2698e88` (2026-08-23) removed the whole agent layer: `src/agent`,
`src/codemode`, both run chassis (`RunDO` + `session.ts`, `RunAgent extends
Think`), the agent-side approval plumbing, the LangSmith tracer, and the `/ws` +
`/agents` transports with their dashboard views. Migration `v4` deleted the DO
classes; `SANDBOX` is the only Durable Object left. The platform underneath
survives and is green (44 test files, `tsc` clean): Slack webhook and ingest,
triage and its eval corpus, D1 (`runs`, `approvals`, `channels`, `messages`,
memory outbox), Zep memory, Access gate and roster, per-engineer OAuth and
identity, the nudge DM, the sandbox container, the git/PR ship path, and the
vendor clients. Three Code-Mode-independent seams were kept in `src/gateways`
(`errors.ts`, `ports.ts` with `CapabilityDependencies`, `scope.ts` with
`RunScope`, `hash.ts`).

Two prose holes name where the new layer plugs in:
`src/index.ts` (`NO WAKE`, triage consumer) and `src/api/approvals.ts:100`
(`NO PRODUCTION NOTIFIER`).

The previous Think attempt (Phase 25) was never activated. Its 14 `it.fails`
pins were all by-construction omissions in hook bodies, not SDK limits. This
design closes each of them by construction and names which section does so.

Timeline: post-trial, no hard date. Optimise for a chassis the README can
defend, not for speed back to a drill.

## 2. Decisions

| # | Decision |
|---|---|
| R1 | **Chassis = `RunAgent extends Think<Env>`** (`@cloudflare/think` 0.15.1, `agents` 0.20.1, `@cloudflare/codemode` 0.5.1, exact pins). Think supplies session store, compaction, chat protocol, `runTurn`, hooks, recovery fibers. Rejected: bare `Agent` + own `streamText` loop (re-implements the 5k lines just deleted); `ThinkWorkflow` step chains (a per-ticket-type pipeline, which the brief fails). |
| R2 | **Integrations reach the model only as Code Mode connectors.** Eleven namespaces, one tool `run_code`. `includeMcpTools = false`, `workspaceBash = false`, `fetchTools = false`, execute tool built with `state: undefined, browser: undefined`. No MCP connector is mounted. (Re-affirms D3, D8.) |
| R3 | **One Worker, one origin, measure first.** `RunAgent` and `CodemodeRuntime` are exported from `src/index.ts`. A startup gate in wave W0 records gzip size (`wrangler deploy --dry-run --outdir`), the platform's 1 s startup limit on deploy, and a live p95 of `POST /slack/events` probes. Contingency if the gate fails: a second Worker `firefighter-agent` holding the DO, reached over a service binding (WS upgrade passes through). |
| R4 | **Every external entry into a run is `runTurn({ mode: "submit", idempotencyKey })`**: triage wake (`slack:{event_id}`), owned-thread reply (`slack:{event_id}`), chat first message (`chat:{uuid}`), steer (`steer:{requestId}`), approval resolution (`approval:{id}`). Blocking modes cannot nest (documented), so no `schedule(0, …)` workaround. Same key twice → `accepted: false`, harmless. |
| R5 | **Approval is the model-called `approval.escalate` capability** with host-owned state (re-affirms D4). Think's `action({kind: "durable-pause"})` / `approveExecution()` (present in 0.15.1) was considered and rejected: the brief forbids harness gating and it has no edit path — the dashboard's approve / **edit** / reject must send the edited text. What is adopted from Think: a turn that escalated simply ends; the decision re-enters as a submit. |
| R6 | **Steering is spliced per step** (re-affirms D9), deduped on `steer:{requestId}`, and a steer on an idle run is itself the wake. |
| R7 | **Dashboard speaks Think's `cf_agent_chat_*` protocol via `useAgentChat`** (re-affirms D10) for both run view and chat page. |
| R8 | **`getModel()` returns a built `LanguageModel` through AI Gateway** with `maxRetries: 0`, loaded via `await import()` in the constructor (re-affirms D11; mock-ability trap). |
| R9 | **Zep stays the only memory; LangSmith tracer is hook-fed, never a capability** (re-affirms D6; restores the deleted tracer). |
| R10 | **No chassis flag.** `RUN_CHASSIS` does not return. `src/run/wake.ts` addresses `RUN_AGENTS` directly. |

## 3. Chassis and topology

`src/run/agent.ts` — `export class RunAgent extends Think<Env>`; one DO per run
named by `slackRunKey(channel, threadTs)` or `chatRunKey(uuid)` from
`src/run/keys.ts` (only `idFromName` site). Public `runs.id` is a separate UUID
in D1 and is the only id the browser ever sees.

`wrangler.jsonc`: `worker_loaders: [{ binding: "LOADER" }]`;
`durable_objects.bindings += { name: "RUN_AGENTS", class_name: "RunAgent" }`;
`migrations += { tag: "v5", new_sqlite_classes: ["RunAgent", "CodemodeRuntime"] }`
(append-only; `CodemodeRuntime` must be in the migration or `facets.get`
throws). `src/index.ts`: `export { RunAgent }`, `export { CodemodeRuntime } from
"@cloudflare/codemode"`. New var `RUN_SPEND_CEILING_NANO_USD`.

Class fields: `workspaceBash = false; fetchTools = false; includeMcpTools =
false; sendReasoning = false; messageConcurrency = "queue"; maxSteps` from a
var. `getTools()` returns `{ run_code }`. Constructor, inside
`ctx.blockConcurrencyWhile`: dynamic-import the model factory; build the
guarded executor; `createExecuteRuntime(this, { state: undefined, browser:
undefined, executor, connectors, name: "run_code" })`; self-check that the
**merged** tool map (workspace → getTools → extensions → session → skills → MCP
→ client) is exactly `{ run_code }` and that `this.codemode.executions()`
resolves; throw otherwise.

`getModel()`: `createAnthropic({ apiKey, baseURL: AI_GATEWAY_ANTHROPIC_URL,
headers: { "cf-aig-authorization": … } })(model)` wrapped with `maxRetries: 0`;
a missing gateway URL throws (no direct-Anthropic fallback), the same rule
`src/triage/run.ts` enforces.

**Amendment (2026-08-23, found while planning).** The self-check above cannot be
"the merged tool map is exactly `{ run_code }`". `think.js:2628` calls
`createWorkspaceTools(this.workspace, { bash: this.workspaceBash })`
unconditionally and `tools/workspace.js:72` always returns `read, write, edit,
list, find, grep, delete`; `this.workspace` is auto-created in `onStart` if
unset, so zero workspace tools is unreachable. The enforceable invariant is two
parts: `beforeTurn` returns `activeTools: ["run_code"]` (the control Think
forwards to `streamText` at `think.js:2729`, so the provider sees nothing else),
and a test pins the merged map to the exact allowlist
`{read, write, edit, list, find, grep, delete, run_code}` (the tripwire — a
session block auto-wiring `set_context`, a skill, an extension or MCP changes
that set and fails).

## 4. Capabilities — `src/capabilities/`

- `define.ts` — `auditedCapability({ namespace, method, effect, input: ZodObject, describe, run })`. `effect ∈ read | external_write | control_write | sandbox_write`, required, no default. Zero-arg inputs use `z.object({}).default({})`.
- `registry.ts` — `NAMESPACES = ["slack","memory","linear","supabase","langsmith","betterstack","files","approval","sandbox","browser","github"]` (order = rendered `.d.ts` order). Every implementation takes `(deps: CapabilityDependencies, scope: RunScope, input)`; `Env` never appears under `src/capabilities/`. Method names globally unique (the generator types by method name alone). A bare descriptor or a duplicate method name throws at registry construction.
- `connector.ts` — `class FirefighterConnector extends CodemodeConnector`, one instance per namespace. Each tool sets `inputSchema = z.toJSONSchema(zod)` (never the raw Zod schema — it is accepted silently and degrades the model-facing type to `unknown`) and keeps the Zod schema for the runtime parse. `execute` wraps, in order: stale-generation check (turn revision), `assertEffectPermitted` (write guard: for `external_write` re-read `runs.shadow` and channel policy from D1 at call time; `canPost()` for Slack), effect ledger (`effects` table, at-most-once on `(run_id, turn_id, namespace, method, sha256(args))`; `in_doubt` on ambiguous failure), budget + audit row via `shared.ts`, error serialisation as `"code: message"`. `requiresApproval` and `needsApproval` are never set (registry test sweeps for both).
- `executor.ts` — `DynamicWorkerExecutor` over a wrapper implementing the full `WorkerLoader` interface (`get` and `load`) that injects `limits: { cpuMs, subRequests }`, forces `compatibilityDate: "2026-08-01"`, `globalOutbound: null`; plus a parent-side wall-clock race with the late rejection swallowed. Model code always goes through `load()`.
- The D1 table keeps its existing name `codemode_effects` — migrations are append-only, so the module moves but the schema does not.
- `dts.ts` + `scripts/generate-capabilities-dts.ts` → `src/capabilities/generated/capabilities.d.ts`; `pnpm capabilities:dts` / `capabilities:dts:check`. The `.d.ts` appears only in the `run_code` tool description.

Silent-ship tests, written before any namespace is ported: raw Zod → `unknown`
degradation is detected; `createExecuteTool(this)` without `state: undefined`
exposes `state.*`; "exactly one tool" read from the merged map, not
`getTools()`; every method classified; no approval flags.

## 5. Turn lifecycle on Think hooks

**Amended 2026-08-24 after the docs audit** (`phase-26-notes.md` §"Docs audit
before Wave 3"). The original table assumed context blocks re-render per turn,
that recovery had to be built, and named a deprecated hook. Verified hook
signatures for 0.15.1: `beforeTurn(ctx: TurnContext)`, `beforeStep(ctx:
PrepareStepContext)`, `beforeToolCall(ctx: ToolCallContext)`,
`afterToolCall(ctx: ToolCallResultContext)`, `onStepEnd(ctx: StepContext)`
(`onStepFinish` is deprecated), `onChatResponse(result)`,
`onChatError(error, ctx)`, `onSubmissionStatus(...)`.

**Where each kind of fact lives** — this is the part the first draft got wrong:

| Kind | Home | Why |
|---|---|---|
| Static text (policy, engineer voice, capability rules) | get-only `withContext` blocks + `withCachedPrompt()` | Rendered once per isolate and cached; `getSystemPrompt()` is ignored once any block exists |
| Per-turn facts (`RunScope`, thread, recall, pending approval) | `beforeTurn → { instructions }` and the channel's `instructions(ctx)` | Re-evaluated every turn; a context block would freeze the first turn's scope |
| Per-turn identifiers (`turnId`, Slack `event_id`, `approvalId`) | `runTurn({ mode: "submit", metadata })` → `this.activeTurnMetadata` | Persisted on the user message; client-supplied keys are stripped at intake |
| Run-scoped durable state (`runId`, status, open approval) | `this.state` / `setState` | SQLite-backed, survives hibernation, broadcast to connections. `this.configure()` does not exist |
| Delivery label (Slack final = narration, Chat final = visible) | `configureChannels()`: `slack` = `kind: "custom"` (transcript-only), `web` = `kind: "web"`; `channel` passed on every submit | A custom channel has no out-of-turn delivery surface, which IS "internal narration" |

| Hook | `RunAgent` behaviour | Invariants / defects |
|---|---|---|
| `configureSession` | get-only blocks `policy`, `voice`, `capabilities`; `withCachedPrompt()`; `refreshSystemPrompt()` on UTC-day change for the frozen voice block | 23–26 |
| `configureChannels` | `slack` (custom, websocket ingress, `maxTurns`, per-turn `instructions(ctx)` = the delivery label) and `web` | 4; defect 9 |
| `beforeTurn` | resolve `RunScope` from D1 + `activeTurnMetadata` (new `turnId` per settled input, reused across continuation); shadow ratchet false→true only; `instructions` = untrusted-evidence envelope (thread, recall, pending approval); `activeTools: ["run_code"]`; `stopWhen` from the nano-USD ceiling + explicit `maxSteps`; `providerOptions.anthropic.disableParallelToolUse`; `telemetry.metadata { runId, turnId }`; `headers` for gateway attribution | 3, 6–8, 23, 25, 26, 28, 35, 37 |
| `beforeStep` | splice pending steers via `{ messages }`; spend preflight from `ctx.steps[].usage` → `activeTools: []` + a system note when the next step would cross the ceiling (`beforeStep` cannot end a turn; `stopWhen` does) | 12–14, 28, 29; defect 8 |
| `beforeToolCall` | revision check → `{ action: "substitute", output: { error: "stale_generation" } }`; `block` while parked on an approval | 15; defects 10, 13 |
| `afterToolCall` | LangSmith `tool` span only (no second audit store — `cm_log` is the durable record); `makeRedactor` already applied by the sandbox gateway | 18, 39 |
| `onStepEnd` | usage row nano-USD keyed on `response.id`; refusal = `finishReason === "content-filter"` → visible failed outcome; omitted-thinking passthrough check; `this.queue("projectStatus", …)` for the D1 projection through `evaluateTransition` | 9, 17, 21, 22, 29, 30, 32; defects 7, 11 |
| `onChatResponse` | terminal status from `result.status` (`completed` / `error` / `aborted`) → `idle` / `awaiting_approval` / `failed`; memory episode; terminal → sandbox teardown | 21, 33; defect 3 |
| `onChatError` | **returns scrubbed text** — its return value is the client-visible error, so provider bodies must never pass through | 39 |
| `chatRecovery` (class field) | Think's own recovery stays on; `onExhausted` → `failed`; `shouldKeepRecovering` → the spend ceiling keyed by `recoveryRootRequestId`; `contextOverflow = { reactive: true }` + `defaultContextOverflowClassifier` | 27, 31 |
| `onMessage` (re-wrapped after `super()`) | drop `clear`, `cancel`, `tool-approval`, `tool-result` and `chat-request` frames — Think honours them from ANY connection and readonly does not gate them; human input enters only via `steer` | security |

Not built: interruption recovery (Think's), stall watchdog (`chatStreamStallTimeoutMs` stays 0 — sandbox-backed `run_code` gaps would trip it), a second audit log.

Steering: `@callable steer(text, requestId)` → `addMessages([{ id: requestId, … }])` (idempotent by message id across the session tree — the SDK has no RPC dedupe) → if idle, `runTurn({ mode: "submit", idempotencyKey: "steer:" + requestId })` (defects 1, 12). Active turn: a `pending_steers` row keyed `requestId`, spliced at the next `beforeStep` via `{ messages }`. Parked on approval: stored, surfaced after the decision (defect 13).

## 6. Wake paths and approval

`src/run/wake.ts`:
- `wakeRun(env, { channelId, threadTs, eventId, openingPrompt })` — `createOrGetRunUnderPolicy` (seeds `shadow` from policy; observe channels wake in shadow only, 37) → stub by `slackRunKey` → submit `slack:{eventId}`.
- `routeToOwnedRun(env, msg)` — `findOwnedSlackRun` over `ACTIVE_RUN_STATUSES`; owned → submit, no triage model call (defect 14). Called from `handleTriageBatch` before triage.
- `createRunFromChat(env, { firstMessage, actor })` — D1 row `origin: "chat"`, `chatRunKey(uuid)`, submit. Chat customer access stays host-mediated (36).

Approval:
1. `approval.escalate({ kind, text, context })` (`control_write`): `insertApproval` (one open card per run, existing partial unique index), local `pending_approval` row, nudge enqueued; returns `{ approvalId, status: "pending" }`. The turn ends; `onChatResponse` projects `awaiting_approval`.
2. `PATCH /api/approvals/:id` (Access + roster + D1 CAS, unchanged) → `RunAgentNotifier` in `src/approval/notifier.ts`: card `run_id` → `runs.key` → submit `approval:{id}` with `resolutionTurnContent(row)` (approved/edited text verbatim). Undelivered → the cron sweep re-submits with the same key.
3. `approval.withdraw({ approvalId })`: `withdrawApproval` CAS (a later human decision 409s), local row cleared, nudge released; returns the human's real decision if the human won the race (defects 4–6).
4. Rejections and edits → memory episodes.

Customer sends stay inside the `slack` capability: `canPost()` + shadow re-read,
speaker from `src/identity/speaker.ts`, `identity_unavailable` fails safe (34).

## 7. Transport and dashboard

**Amended 2026-08-24.** The first draft rewrote the third path segment before
`routeAgentRequest`. That works, but partyserver computes `idFromName` before
`onBeforeConnect`/`onBeforeRequest` run (they cannot remap the instance), and
the rewritten URL still reaches the DO as `connection.uri`. The built-in
indirection is used instead, and `/agents/*` is not mounted at all.

Server (`src/api/agents.ts`, mounted under the Access-gated `/api`):
`/api/runs/:id/agent/*` for both the WebSocket upgrade and HTTP. Resolve
`runs.id → runs.key` via `getRunById` (404 on miss), `assertRunKey`, stamp the
verified identity onto the forwarded Request as a header, then
`(await getAgentByName(env.RUN_AGENTS, key)).fetch(request)`. Think's own
`onRequest` serves `…/get-messages` (the full transcript) on the same path, so
it sits behind the same gate. The private key never appears in any URL.
`static options = { sendIdentityOnConnect: false }` stays (defect 2). In
`onConnect`, `connection.setState({ email })` from the header so steers are
attributable; `shouldConnectionBeReadonly()` returns true for every connection
so no browser can write `this.state`.

Client (`apps/dashboard`): `useAgent({ agent: "run-agent", basePath:
\`api/runs/${runId}/agent\` })` + `useAgentChat` from
`@cloudflare/think/react` with `getInitialMessages: null` — the transcript
arrives as the `cf_agent_chat_messages` connect frame, which removes the
Suspense throw the error boundary existed for. Steer via
`agent.stub.steer(text, requestId)`; approval via the REST `PATCH`, never
`addToolApprovalResponse`. One transcript component used by:
- run view (`src/runs/run-view.tsx`): tool parts as "ran code → result" rows, status pill from `this.state`, steer box, `run-approvals.tsx` inline; loading / empty / error / disconnected states;
- chat page (`src/chat/chat-page.tsx`): `POST /api/runs { firstMessage }` → `createRunFromChat` → submit on channel `web` → run view; citations as permalinks.
`dev-stubs.ts` returns for identity/roster/approvals.

## 8. Memory, tracing, cost

- Memory: `onChatResponse` → one bounded episode per turn → D1 outbox → `MEMORY_QUEUE` → Zep; approval outcomes are episodes; citations via `src/memory/cite.ts` (33). Shift handoff = a chat prompt over memory. `Agent.queue()` is not used for episodes — the outbox already owns cross-DO durability.
- Tracing — **open decision, Task 26.** Think emits GenAI OTLP spans natively (`wrapAISDK`, `gen_ai.*` attributes, gated by `storeTools` / `storeMessages`), and LangSmith ingests OTLP. That deletes the hand-written tracer, the `dotted_order` trap and the `waitUntil` flush — but the SDK has no `redacted` payload mode; `storeMessages` is all-or-nothing. Either (a) SDK-native: `storeTools = true`, `storeMessages = false`, `beforeTurn → telemetry.metadata { runId, turnId }`, OTLP destination = LangSmith project `fire-fighter`; or (b) keep `src/langsmith/tracer.ts` and `LANGSMITH_TRACE_PAYLOADS=redacted`, fed from `onStepEnd` / `afterToolCall` / `onChatResponse`. Either way it is not a capability. `vitest.config.ts` keeps `LANGSMITH_TRACING: "false"`.
- Cost: `agent_model_calls` rows in nano-USD (`src/run/money.ts`) written from `onStepEnd` keyed on `response.id`, read by `GET /api/runs/:id/usage`; ceiling enforced by `stopWhen` in `beforeTurn` with a `beforeStep` preflight.
- Audit trail: `cm_log` (codemode's own durable log) is the per-call record; no second store. Bounded to the newest 50 terminal executions per DO (`createExecuteRuntime` hardcodes `maxExecutions`). Large reads carry `replay: "reexecute"` so their results never land in SQLite.

## 9. Testing and build order

Gate: `pnpm test`, `pnpm typecheck`, `pnpm capabilities:dts:check` in
`apps/worker`, plus dashboard `pnpm test` + `pnpm typecheck`. Baseline first.
Keep a test only if it catches a silent failure; the deleted tests' "re-pin"
comments (`git show c9c53f7:apps/worker/test/<file>`) are the checklist.

Waves, each committed on a green gate:
- **W0 Shell + gate** — wrangler changes, `RunAgent` with `getModel` and no connectors, `CodemodeRuntime` export, `cf-typegen` (with `.dev.vars` present), startup measurement and its recorded result; contingency R3.
- **W1 Capabilities core** — `define/registry/connector/executor/dts`, write guard, effect ledger, silent-ship tests, invariant-39 canary sweep over Think session tables and the codemode execution log.
- **W2 Namespaces** — the eleven bindings on the surviving gateways, `test/capabilities-<ns>.test.ts` each.
- **W3 Lifecycle** — §5 hooks, steering, spend preflight, projection, omitted-thinking pin.
- **W4 Wake + approval** — `wake.ts`, triage re-wired, notifier, withdraw, cron re-submit.
- **W5 Transport + dashboard** — `/agents` route, identity-frame strip, run view, chat page, dev stubs.
- **W6 Memory/tracing/cost + docs** — tracer, episodes, usage; README security table and AI-tool notes against the new paths; `CLAUDE.md` architecture section; `docs/superpowers/plans/phase-26-notes.md` for invented APIs.

End-to-end: the four drill scenarios in `#test-firedrill` on the deployed
Worker; `live-drill-readonly.mjs` for the ship path.

## 10. Verified package facts this design relies on

From installed `dist/` and Cloudflare docs (2026-08-23):
- `createExecuteTool` / `createExecuteRuntime` live in `@cloudflare/think/tools/execute`; codemode's own adapter is `createCodeTool` in `@cloudflare/codemode/ai`. `toolInputSchema` is internal.
- Think runtime exports are eight values (`Session, Think, Workspace, action, defaultContextOverflowClassifier, isAction, messengerChannel, skills`); everything else is type-only.
- `agents/ai-chat-agent`, `agents/ai-react`, `agents/codemode/ai` throw at import.
- `runTurn` overloads: wait / submit / stream; a DO stub keeps only the last overload — narrow to a local interface.
- `createSandboxTools()` in `@cloudflare/think/tools/sandbox` is a no-op stub; sandbox access is our connector.
- `outboundByHost` is a static on `Container` from `@cloudflare/containers`, already used in `src/sandbox/class.ts`.
- Worker startup limit 1 s, gzip bundle limit 10 MB (Workers Paid).

Added 2026-08-24 (see `phase-26-notes.md` §"Docs audit" items 4–18 for the evidence):
- `this.configure()` / `getConfig()` do not exist on Think 0.15.1; durable per-run state is `this.state`.
- Context blocks render once and are cached; `getSystemPrompt()` is ignored once any block exists; a channel's `instructions(ctx)` and `beforeTurn → instructions` are the per-turn surfaces.
- `onStepFinish` is deprecated → `onStepEnd`.
- `chatRecovery` is on by default; refusal arrives as `finishReason: "content-filter"`, not an error; `onChatError`'s return value is client-visible.
- Readonly connections do not gate chat frames; `clear` / `cancel` / `chat-request` are honoured from any connection.
- `routeAgentRequest` hooks cannot remap the instance; `useAgent({ basePath })` + `getAgentByName().fetch()` is the id→name indirection.
- `addMessages` is idempotent by message id; `@callable` has no dedupe.
- `beforeStep` cannot end a turn; `stopWhen` / `maxSteps` in `beforeTurn` can.
- `createExecuteRuntime` hardcodes `maxExecutions: 50`; `cm_log` stores args and results verbatim; a custom tool `description` discards `connectorHints`.
- `configureChannels()`: a `custom` channel's final text is transcript-only.

## 11. Amendment log

- **2026-08-23** — §3: "exactly one tool" → `activeTools: ["run_code"]` + merged-map allowlist. §7: identity frame via `sendIdentityOnConnect: false`, not a relay.
- **2026-08-24** — §5, §7, §8, §10 rewritten after the pre-Wave-3 docs audit. Decisions R1–R10 unchanged; every one of them was re-tested against the SDK alternative and stands (`phase-26-notes.md` §"What stands"). Two bugs in committed code found and fixed the same day (§"Bugs in committed code").
- **2026-08-27** — Wave 3 implemented; §5's "where each fact lives" table holds, with three mechanics corrected against the pin (`phase-26-notes.md` §19–23). Per-turn text is APPENDED to `ctx.system`, because `TurnConfig.instructions` replaces the assembled prompt rather than extending it. Decision A ships as "no `description`" alone: `createExecuteRuntime` has no `connectorHints` to pass, so the namespace hints moved into the frozen capability block. Prompt caching on this chassis is the request-level `cacheControl`, not per-block breakpoints — Think hands `streamText` one `system` string, and Anthropic's tools → system → messages prefix order is what keeps the `run_code` description cached across turns.
