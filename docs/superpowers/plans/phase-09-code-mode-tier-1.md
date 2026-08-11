# Phase 09 — Code Mode Tier 1

> **Implementation plan only.** This document does not implement Phase 09. It
> is written for an engineer or coding agent to execute task-by-task with TDD.
>
> **For agentic workers:** REQUIRED SUB-SKILL: use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

## Global Constraints

Copied verbatim from `00-roadmap.md`. Every task's requirements implicitly
include this section.

- **Node >= 20** (have 22.20.0), **pnpm 10.33.4**, TypeScript `strict: true`.
- **`compatibility_date: "2026-08-01"`**, `compatibility_flags: ["nodejs_compat"]`.
- **Channels only, never DMs.**
- **Fail closed.** A channel absent from the `channels` table is never postable.
- **No secret values in the repo, ever.** Plans and code name variables, never values.
- **Triage never emits a ticket type.** A type field would smuggle the banned
  pipeline back in.
- **Tier 1 outbound calls are runtime-refused.** `fetch`, socket connect, and
  WebSocket globals may exist, but `globalOutbound: null` prevents them reaching
  the network; the isolate's only useful reach is reviewed RPC capabilities in
  the parent Worker.
- **Linear issues are pinned server-side** to team `fire-fighter-testing`.
- **Customer-facing copy:** direct, technical. No preamble, no "Great question!",
  no bulleted recap, no closing paragraph restating the answer.
- **Commit after every task.** Conventional prefixes.

Note the tension the Dynamic Worker introduces: the **loaded** bundle's
compatibility date is set by the Code Mode package, not by `wrangler.jsonc`.
See Task 4a Step 2.

**Goal:** Give the generic agent exactly one model-facing tool,
`run_code({ code })`. The tool executes model-authored code in a fresh Dynamic
Worker whose outbound network globals are runtime-blocked. The code can reach
only typed, schema-validated capabilities that execute in the trusted parent
Worker, where credentials and policy remain.

**Depends on:** Phase 00 Worker Loader Task 2 **GO** and Phase 08 exit criteria

**Day:** 3–4

**Primary package decision:** pin `@cloudflare/codemode@0.5.1` after repeating
the verification gate below. Use its stateless AI SDK path and
`DynamicWorkerExecutor`; do **not** adopt its durable approval runtime in this
phase.

---

## Outcome

At the end of this phase:

- the model sees one AI SDK tool named `run_code`;
- that tool's description contains generated TypeScript declarations for the
  available integration namespaces;
- the submitted program is a JavaScript-compatible async arrow function that
  can call several namespaces in one execution;
- the Dynamic Worker receives no application secret or general outbound
  fetcher;
- `fetch()`, `connect()`, and `new WebSocket()` remain defined by the runtime
  but throw when used for outbound access;
- capability calls return through Workers RPC to trusted, request-scoped host
  functions;
- Slack target and actor, Linear team, customer scope, fixed API origins, and
  read-only database access are chosen by trusted host context, never by model
  arguments;
- logs, results, errors, execution time, and effect attempts are bounded and
  auditable;
- a deployed smoke test proves the same boundary that unit tests assert.

The phase is not complete merely because a hand-written snippet runs. The
security controls must be causal and testable: removing `globalOutbound: null`
must make the network control probe succeed, while the production path must
make it fail.

---

## Explicit non-goals

This phase does **not**:

- call Anthropic or run the model loop — Phase 10 owns that;
- classify a run as a question, feature request, or bug;
- add harness-level approval to capability calls;
- create `escalate` or `withdraw` — Phase 11 adds those as explicit
  model-chosen capabilities;
- resolve the rotating engineer or decrypt Slack/GitHub OAuth tokens — Phase
  12 supplies that adapter;
- boot a cloud machine — Phase 18 adds `sandbox`;
- expose GitHub — Phase 20 adds `github`;
- open or merge a PR;
- add another session store, approval store, WebSocket protocol, page, or
  ticket-type pipeline;
- expose dev-time MCP servers to the product agent.

Phase 09 may define ports that later phases implement, but it must not fake a
production write with the workspace bot token or broaden a credential merely
to make an early demo pass.

---

## Docs and API verification gate

Cloudflare surfaces here are experimental and changed after the original
roadmap was drafted. Do not implement from this document alone.

### Sources already checked while writing this plan

The following were verified on 2026-08-11:

1. Cloudflare docs MCP, `search_cloudflare_documentation`:
   - [Code Mode with the AI SDK](https://developers.cloudflare.com/agents/tools/codemode/ai-sdk/)
   - [Code Mode API reference](https://developers.cloudflare.com/agents/tools/codemode/api-reference/)
   - [Dynamic Workers getting started](https://developers.cloudflare.com/dynamic-workers/getting-started/)
   - [Workers RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/)
   - [`ctx.exports` and `ctx.props`](https://developers.cloudflare.com/workers/runtime-apis/context/)
   - [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
2. `@cloudflare/codemode@0.5.1`, read from the published tarball
   (`npm pack`) — **both `dist/*.d.ts` and the compiled `dist/*.js`**. Several
   findings below are invisible in the declarations and appear only in the
   emitted JavaScript. Peer deps confirmed all `optional: true`; `ai` and `zod`
   are the only ones needed and this repo already satisfies both
   (`ai@^7.0.59`, `zod@^4.4.3`).
   Behaviour marked **[probed]** below was executed, not read.
3. The generated `apps/worker/worker-configuration.d.ts` from Wrangler
   4.120.0, including `WorkerLoader`, `WorkerLoaderWorkerCode`,
   `workerdResourceLimits`, `WorkerEntrypoint`, and `RpcTarget`.
4. The deployed Phase 00 report:
   `docs/superpowers/spikes/2026-08-10-worker-loader.md`.
5. `docs/inspired-from-ronit.md` sections 1–6.

### Findings that determine this plan

| Finding                                                                                                                                              | Consequence                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createCodeTool()` is the current AI SDK entry point; `experimental_codemode()` and `CodeModeProxy` were removed.                                    | Never use the older APIs, even if a model suggests them.                                                                                                  |
| `DynamicWorkerExecutor` dispatches host tools through a `ToolDispatcher extends RpcTarget` passed as an RPC **call argument**.                       | This matches Phase 00's proven placement rule. Do not place an `RpcTarget` in the loaded Worker's `env`.                                                  |
| `DynamicWorkerExecutor` defaults `globalOutbound` to `null` (`options.globalOutbound ?? null`) and disposes its Worker stubs.                          | Reuse it instead of copying its generated executor module. Still set the security-sensitive options explicitly.                                           |
| **Its `timeout` is compiled *into the sandbox module*** as a `Promise.race` against `setTimeout`. There is no parent-side guard.                       | It cannot bound CPU-bound code — `while(true){}` never yields, so that timer never fires. **We must race parent-side as well.** See Task 4b Step 3.       |
| **Console capture does not use `tails`.** The executor overrides `console.log/warn/error` in-sandbox and returns `__logs` in the RPC value.            | The spike's ~200KB silent-tail ceiling does **not** apply. `console.info`/`debug` are not captured. Host-side caps run *after* the array crossed RPC.     |
| **Two different `resolveProvider`s exist.** `@cloudflare/codemode` does *not* validate input; `@cloudflare/codemode/ai` wraps each execute in `asSchema().validate()`. `runCode` is exported only from the index entry. | The natural single import line silently picks the non-validating one. **Our provider helper attaches validation itself** so the boundary cannot depend on a module specifier. Invariant 19. |
| **`generateTypes()` derives type names from the tool name only** — `toPascalCase(sanitizeToolName(toolName))`, no namespace prefix. **[probed]**       | Two namespaces sharing a method name emit the same `type XInput` and the joined `.d.ts` fails to compile. Method names must be globally unique. Invariant 20. |
| **A zero-argument call fails validation. [probed]** The sandbox proxy forwards the args array; `ToolDispatcher.call` spreads it, so `foo()` arrives as `execute(undefined)`, which a Zod object rejects. | Every method callable with no arguments needs `.default({})` on its input schema. Probed: this still renders `type XInput = {}`, not `unknown`.           |
| **`ToolDispatcher.call` forwards only `err.message`**; the sandbox rethrows `new Error(data.error)`.                                                   | A `code`, `retryable` flag or `details` object does not survive. Error serialization must be `"code: message"` — see [Safe errors](#safe-errors).         |
| **The Dynamic Worker bundle hardcodes `compatibilityDate: "2025-06-01"`.**                                                                            | Against the global constraint of `2026-08-01`. The loader adapter is the only place this can be overridden. Task 4a Step 2.                               |
| `resolveProvider` silently drops any tool carrying `needsApproval` (`filterTools()`), with no warning.                                                 | We use no approval annotations, so assert their absence in the registry test rather than relying on a silent drop. Task 5 Step 1.                         |
| Version 0.5.1 does not expose Dynamic Worker CPU/subrequest limits as executor options.                                                              | Wrap the `WorkerLoader` binding with a fail-closed adapter that injects `limits` into every `load()` call.                                                |
| Dynamic Workers execute JavaScript; Worker Loader has no TypeScript build step. The current tool description explicitly prohibits TypeScript syntax. | The model sees TypeScript declarations but submits JavaScript-compatible code. Do not silently add a runtime TypeScript compiler.                         |
| Code Mode can provide its own durable approval/runtime layer.                                                                                        | Do not use it here. RunDO is the session authority and the assignment requires the model to decide when to escalate, not tool annotations to gate writes. |
| `generateTypes()` derives declarations from the same Zod/AI SDK schemas used to validate calls.                                                      | Make the provider schemas the one contract source; generated declarations are a checked artifact, not a second hand-maintained API.                       |
| Worker Loader `load()` is uncached and measured at about 8 ms deployed.                                                                              | Use a fresh Worker for every execution. Never use `get()` for model-authored code.                                                                        |
| With `globalOutbound: null`, network globals exist but refuse calls.                                                                                 | Tests and README wording must assert refusal, not `typeof fetch === "undefined"`.                                                                         |
| Phase 00 proved `limits.cpuMs` is not enforced by local `wrangler dev`, although it is enforced when deployed.                                       | Keep unit/local tests, but make the CPU-runaway probe a required deployed test.                                                                           |

### Repeat before implementation

- [ ] Search the Cloudflare docs MCP again for Code Mode, Dynamic Workers,
      Worker Loader, and RPC lifecycle changes.
- [ ] Run `pnpm view @cloudflare/codemode version` and inspect the exact
      installed package's `dist/index.d.ts`, `dist/ai.d.ts`, and package docs.
- [ ] Read `apps/worker/node_modules/wrangler/config-schema.json` for
      `worker_loaders`, R2, compatibility flags, and limits.
- [ ] Run `pnpm cf-typegen` after config changes and use the generated types;
      never hand-write a substitute `WorkerLoader` type.
- [ ] Confirm Phase 08's actual exported `RunDO` RPC surface against its plan.
- [ ] Verify the live APIs for Slack, Linear, Supabase, LangSmith, and Better
      Stack from official docs or their docs/API MCP servers before writing each
      real adapter. If no appropriate MCP is attached, ask for one rather than
      guessing request paths or response shapes.
- [ ] Record API drift and every model-invented API in
      `docs/superpowers/plans/phase-09-notes.md` for the README's AI-tool notes.

Stop and update this plan if the installed Code Mode executor no longer uses
RPC call-argument dispatch, if `globalOutbound` semantics change, or if
Worker Loader no longer accepts per-bundle resource limits.

---

## Central implementation decision

Use **stateless Code Mode providers over RPC call arguments**, not Code Mode's
durable connector runtime and not bespoke flat model tools.

```text
RunDO / Phase 10 model loop
  │
  │ exactly one AI SDK tool: run_code({ code })
  ▼
makeRunCodeTool(trustedScope, trustedDependencies, auditSink)
  │
  ├─ generated TypeScript declarations from provider schemas
  ├─ strict, size-bounded code input
  └─ GuardedCodeExecutor
       │
       ├─ DynamicWorkerExecutor
       └─ GuardedWorkerLoader forces:
            globalOutbound: null
            env: absent
            limits: { cpuMs, subRequests }
            load(), never get()
              │
              ▼
        fresh Dynamic Worker
          model code
          slack.*     ─┐
          memory.*    ─┤
          linear.*    ─┤ ToolDispatcher RpcTargets passed to evaluate(...)
          supabase.*  ─┤
          langsmith.* ─┤
          betterstack.*─┤
          files.*     ─┘
              │
              ▼ RPC
        parent-Worker provider closures
          policy + validation + fixed identity + fixed origins
          secrets only inside trusted dependency adapters
```

### Why not the durable Code Mode runtime?

The package's durable runtime is good general infrastructure, but it duplicates
three decisions already fixed for this project:

1. RunDO SQLite is the session and replay authority.
2. Phase 11's approval is an explicit model decision and resolves by appending
   a turn; a sandbox execution cannot remain parked.
3. The dashboard owns the single approval state writer.

No Phase 09 provider receives `needsApproval` or `requiresApproval`. A write can
execute immediately only because the model chose that capability. When the
model believes human judgment is required, Phase 11's `escalate()` creates an
approval and returns immediately.

### Why not raw `ctx.exports.X({ props })` per integration?

That remains a valid Workers RPC shape, but the current Code Mode package
already creates `ToolDispatcher` RPC targets, passes them in the placement
Phase 00 proved safe, validates inputs from the AI SDK schema, captures logs,
and generates declarations. Rebuilding those pieces as seven entrypoints adds
more beta API surface without strengthening the credential boundary.

The word **binding** below means a model-visible typed capability namespace,
not necessarily a Worker `env` binding. The loaded Worker's `env` is kept empty
on purpose. Identity and scope live in the host closures that back the RPC
dispatchers, never in model-controlled arguments.

---

## Load-bearing invariants

1. **Exactly one model-facing tool.** Phase 10 passes
   `{ run_code: makeRunCodeTool(...) }`, not the individual bindings.
2. **One generic agent.** No ticket type, handler registry, or conditional
   provider set based on question/feature/bug classification.
3. **A fresh Dynamic Worker per execution.** Use `LOADER.load()` only.
4. **Outbound network is fail-closed.** The production executor always sets
   `globalOutbound: null`; there is no option at a call site to override it.
5. **No loaded-Worker env capabilities.** Provider RPC targets cross as call
   arguments. The executor rejects unexpected `env` values.
6. **No raw credentials cross RPC.** Tool results are normalized domain data,
   never `Response`, headers, SDK clients, tokens, connection strings, or env
   objects.
7. **Identity is ambient trusted scope.** A model method never accepts Slack
   user ID, GitHub user ID, email, OAuth token, or actor selector.
8. **Targets are ambient wherever possible.** `slack.reply({ text })` replies
   to the current Slack run's thread; it accepts no channel or thread argument.
9. **Policy is inside the write binding.** Unknown, `observe`, `internal`,
   shadow, and Chat-without-target contexts cannot post.
10. **Linear team is pinned server-side.** Create has no team argument; update
    first proves the issue belongs to `fire-fighter-testing`.
11. **Supabase is read-only twice.** The model surface contains only bounded
    reads, and the credential itself is the prod read-only role.
12. **Fixed origins only.** No integration accepts a URL, host, project base
    URL, log source ID, Supabase project, or LangSmith workspace from model
    code.
13. **Every schema is strict and bounded.** Unknown fields are rejected; text,
    arrays, row counts, time windows, code, logs, and results have caps.
14. **Effects are retry-aware.** Slack sends, Linear writes, and file publishes
    use a durable effect key or the upstream API's verified idempotency
    mechanism. Ambiguous effects are never blindly repeated.
15. **Every promise is handled.** Provider work is awaited; non-critical audit
    work uses the supplied execution context's `waitUntil()` explicitly.
16. **No request-scoped global state.** Provider registries and contexts are
    constructed per Code Mode invocation.
17. **Errors are useful but sterile.** The model receives a stable error code
    and safe message, never a stack, query credential, token, or raw upstream
    body.
18. **README claims match tests.** Say “network calls are runtime-refused,” not
    “`fetch` does not exist.”
19. **We own input validation.** The provider-definition helper validates inside
    the `execute` it builds. Correctness must not depend on which
    `resolveProvider` was imported, nor on a future change to the package's
    resolve semantics.
20. **Capability method names are globally unique**, not merely unique per
    namespace, because generated type aliases are not namespaced. Enforced on
    the *derived* name — `toPascalCase(sanitizeToolName(name))` maps both
    `search_messages` and `searchMessages` to `SearchMessages`.
21. **Wall clock is bounded parent-side.** The package's in-sandbox timeout and
    `limits.cpuMs` each fail in a case the other covers, and `limits.cpuMs` does
    not fire under `wrangler dev` at all. All three mechanisms are required;
    none substitutes for another.

---

## Dependency contracts

### What Phase 09 consumes from Phase 08

- one `RunDO` per Slack thread or Chat session;
- an initialized run descriptor containing run ID, origin, Slack coordinates
  when applicable, status, and shadow state;
- `appendToolCallUpdate()` for durable stream/audit updates;
- ordered session turns and the one WebSocket event protocol;
- no model loop yet.

If Phase 08's implementation differs from its plan, adapt to the real typed
surface. Do not introduce an alternate event log or a second DO just for Code
Mode.

### What Phase 09 hands to Phase 10

```ts
export type MakeRunCodeToolInput = {
  scope: CodeModeScope            // validated by Task 2's validateScope()
  deps: CapabilityDependencies    // the gateways; they own every secret
  limits: CodeModeLimits          // the one reviewed production constant
  audit: CapabilityAuditSink      // Phase 10 adapts this to appendToolCallUpdate
  loader: WorkerLoader            // env.LOADER; wrapped by guardLoader() inside
}

/** The ONLY export Phase 10 needs. Returns an AI SDK Tool<{code: string}>. */
export function makeRunCodeTool(input: MakeRunCodeToolInput): Tool

/** Exported for the dts check script and for review; not needed at runtime. */
export function renderCapabilityDeclarations(registry: CapabilityRegistry): string

export type CapabilityRegistry = Array<{
  name: string
  tools: Record<string, ToolDescriptor>   // ToolDescriptor from @cloudflare/codemode
}>
```

Phase 10 passes `env.LOADER` in, rather than Phase 09 reaching for a global. That
is what keeps `guardLoader()` (Task 4a) the single chokepoint: there is no code
path to a raw `WorkerLoader` outside this factory, and no exported constructor
accepts `globalOutbound`.

Phase 10 owns the AI SDK `streamText()` loop, maps the outer `run_code` call and
nested capability audit events into Phase 08 tool updates, and appends the
assistant turn. Phase 09 owns only the tool and its trust boundary.

---

## File structure

```text
apps/worker/package.json
pnpm-lock.yaml
apps/worker/wrangler.jsonc
apps/worker/worker-configuration.d.ts                 regenerate, never edit
apps/worker/migrations/0005_codemode_effects.sql

apps/worker/src/codemode/contracts.ts                 scope, output, limits
apps/worker/src/codemode/errors.ts                    safe capability errors
apps/worker/src/codemode/effects.ts                   effect reservation/replay
apps/worker/src/codemode/guarded-loader.ts            force isolation + limits
apps/worker/src/codemode/executor.ts                  bounded Executor wrapper
apps/worker/src/codemode/registry.ts                  ordered provider registry
apps/worker/src/codemode/dts.ts                       official type generation
apps/worker/src/codemode/tool.ts                      the one run_code tool
apps/worker/src/codemode/bindings/shared.ts            provider/audit helpers
apps/worker/src/codemode/bindings/slack.ts
apps/worker/src/codemode/bindings/memory.ts
apps/worker/src/codemode/bindings/linear.ts
apps/worker/src/codemode/bindings/supabase.ts
apps/worker/src/codemode/bindings/langsmith.ts
apps/worker/src/codemode/bindings/betterstack.ts
apps/worker/src/codemode/bindings/files.ts
apps/worker/src/codemode/generated/capabilities.d.ts   generated, committed

apps/worker/src/slack/messages.ts                     bounded D1 thread/search
apps/worker/src/slack/gateway.ts                      read/send port
apps/worker/src/linear/client.ts                      fixed-team host adapter
apps/worker/src/supabase/reader.ts                    scoped read-only adapter
apps/worker/src/langsmith/client.ts                   fixed-origin read adapter
apps/worker/src/betterstack/client.ts                 fixed-source read adapter
apps/worker/src/files/r2.ts                           bounded R2 publisher

apps/worker/scripts/generate-codemode-dts.ts          write/check generated API
apps/worker/test/helpers/codemode.ts                   TEST_LIMITS, fakes, scopes
apps/worker/test/fixtures/capabilities-fixture.ts      compiled by typecheck
apps/worker/test/codemode-loader.test.ts               Task 1 — binding + de-risk
apps/worker/test/codemode-contracts.test.ts
apps/worker/test/codemode-effects.test.ts
apps/worker/test/codemode-guarded-loader.test.ts       Task 4a — pure unit
apps/worker/test/codemode-executor.test.ts             Task 4b — real isolate
apps/worker/test/codemode-dts.test.ts
apps/worker/test/codemode-slack.test.ts
apps/worker/test/codemode-memory.test.ts
apps/worker/test/codemode-linear.test.ts
apps/worker/test/codemode-supabase.test.ts
apps/worker/test/codemode-langsmith.test.ts
apps/worker/test/codemode-betterstack.test.ts
apps/worker/test/codemode-files.test.ts
apps/worker/test/codemode-security.test.ts
apps/worker/test/codemode-integration.test.ts

docs/superpowers/plans/phase-09-notes.md
```

`0005_codemode_effects.sql` reserves the next migration after Phase 08's
`0004_runs.sql`. Consequently, the stale roadmap placeholders for approvals
and identities must use later numbers when those phases are expanded; never
reuse `0005`.

---

## Public contracts established by this phase

### Trusted execution scope

```ts
export type CodeModeScope = {
  runId: string
  turnId: string
  origin: "slack" | "chat"
  shadow: boolean
  customerSlug: string | null
  slackThread: {
    channelId: string
    threadTs: string
  } | null
  actor: {
    engineerEmail: string
    slackUserId: string | null
  } | null
}
```

It is validated once before provider construction and is never serialized into
the Dynamic Worker. Each field has exactly one trusted source — verified against
the shipped Phase 08 code, because two of them are **not** where the earlier
draft of this plan assumed:

| Field                    | Source                                                            |
| ------------------------ | ----------------------------------------------------------------- |
| `runId`, `origin`        | `RunDO.state()` → `RunState` (`src/run/session.ts`)               |
| `slackThread`            | `RunState.channelId` / `RunState.threadTs`, both nullable         |
| `shadow`                 | **D1 only** — `getRunById(env.DB, runId).shadow` (`repository.ts`) |
| `customerSlug`           | `getChannelPolicy(env.DB, channelId).customer_slug` (`db/channels.ts`) |
| `turnId`                 | supplied by the Phase 10 caller, not generated in a provider      |
| `actor`                  | Phase 12 rotation service; `null` until then                      |

> **`RunState` has no `shadow` field.** It is
> `{ runId, key, origin, channelId, threadTs, status, summary, createdAt, updatedAt }`.
> `shadow` lives only on the D1 `runs` row as `RunRecord.shadow: boolean`. A
> `shadow_write_denied` check that reads it off the descriptor will read
> `undefined` and fail open. This is the single most dangerous wrong assumption
> available in this phase.

`turnId` is the stable model-turn ID, not a random ID generated inside a
provider. It scopes effect deduplication so a retry of one turn does not send
twice, while a later turn may intentionally send the same text.

### Limits

```ts
export type CodeModeLimits = {
  maxCodeChars: number // default 24_000
  wallTimeMs: number // default 20_000, hard max 60_000
  cpuMs: number // default 500; verify deployed
  subRequests: number // default 32
  maxResultChars: number // default 24_000
  maxConsoleChars: number // default 32_000
  maxCapabilityCalls: number // default 40
}
```

Keep one reviewed production constant. Tests may inject smaller limits. Do not
let model input or an HTTP request raise them.

### Execution output

```ts
export type CodeModeOutput = {
  result: JsonValue | string | null
  logs: string[]
  truncation: {
    result: boolean
    logs: boolean
  }
  metrics: {
    durationMs: number
    capabilityCalls: number
  }
}
```

The AI tool returns the result and logs. Metrics and truncation markers also go
to the audit sink. Do not expose the Worker stub, RPC target, `Error`, SDK
object, `Response`, `Request`, stream, or class instance.

> **`JsonValue` is depth-bounded to four levels** (`src/run/protocol.ts`), and
> deliberately so: a recursive JSON type trips `TS2589` across an RPC boundary,
> and `unknown` fails `Rpc.Serializable` and collapses the return type to
> `never`. Anything that reaches `RunDO.appendToolCallUpdate({ input?, output? })`
> inherits that bound. **Task 2's depth cap is therefore 3, not an arbitrary
> number**, and Task 10's trace tree must be flattened to fit rather than nested
> freely. Both failure modes are invisible to `pnpm test` — vitest strips types.
> Only `pnpm typecheck` catches them.

### Safe errors

```ts
export type CapabilityErrorCode =
  | "invalid_context"
  | "invalid_input"
  | "capability_unavailable"
  | "channel_read_only"
  | "slack_context_required"
  | "identity_unavailable"
  | "shadow_write_denied"
  | "linear_team_denied"
  | "customer_scope_required"
  | "read_only_violation"
  | "effect_in_doubt"
  | "output_too_large"
  | "execution_timeout"
  | "execution_cpu_limit"
  | "upstream_unavailable"

export class CapabilityError extends Error {
  readonly code: CapabilityErrorCode
  readonly retryable: boolean
  readonly details?: JsonObject
}
```

Serialize as a short model-readable message such as:

```text
channel_read_only: Slack replies are disabled for #customer-reference (mode=observe).
```

`details` may contain stable IDs and limits but never raw upstream responses or
credentials. Provider adapters translate unknown upstream failures to
`upstream_unavailable`; they log a correlation ID separately.

> **Only `message` survives the boundary.** `ToolDispatcher.call` catches host
> errors and returns `{ error: err.message }`; the sandbox then rethrows
> `new Error(data.error)`. `code`, `retryable` and `details` reach the audit
> sink but **never reach model code**. That is why the wire format is
> `"code: message"` — the code has to be *in* the message to be actionable by
> the next model turn. Anything the model needs in order to recover must be a
> sentence, not a field.

### Capability dependencies

```ts
export type CapabilityDependencies = {
  db: D1Database
  slack: SlackGateway
  memory: MemoryStore
  linear: LinearGateway
  supabase: SupabaseReader
  langsmith: LangSmithReader
  betterstack: BetterStackReader
  files: ArtifactPublisher
  effects: EffectLedger
  audit: CapabilityAuditSink
  clock: () => number
}
```

The gateways own secrets. The provider factories receive only these narrow
interfaces, which makes credential absence testable with fakes.

### Capability audit

```ts
export interface CapabilityAuditSink {
  started(event: CapabilityStarted): Promise<void>
  completed(event: CapabilityCompleted): Promise<void>
  failed(event: CapabilityFailed): Promise<void>
}
```

Every event includes `runId`, `turnId`, a per-execution sequence, namespace,
method, safe arguments, timing, and safe result/error metadata. It never
contains bytes, tokens, SQL credentials, HTTP headers, or an unredacted trace.
Phase 10 adapts these calls to `RunDO.appendToolCallUpdate()`.

---

## Model-visible declarations

These signatures describe the intended surface. They are examples for review;
the committed `.d.ts` must be generated from the real schemas.

Two corrections against what the generator actually emits, both verified by
running it:

1. **`generateTypes` always emits `(input: XInput) => Promise<XOutput>`** — the
   parameter is never rendered optional, whatever the schema says. So the model
   will be shown `thread(input: ThreadInput)` and will pass `{}`. Write the
   illustrative signatures below the same way; do not write `args?:`, because no
   generated declaration will ever look like that.
2. **A bare `thread()` must still work at runtime**, because a model will
   occasionally write one. That needs `.default({})` on the input schema — see
   the zero-argument row in the findings table. The two mechanisms are belt and
   braces: the type teaches `{}`, the default tolerates its absence.

**Method names are globally unique** (invariant 20). That is why the two search
methods below are `searchMessages` and `searchTraces` rather than both being
`search` — a same-named method in two namespaces makes the joined `.d.ts` fail
to compile, since generated type aliases carry no namespace prefix.

```ts
type RecalledFact = {
  factId: string
  fact: string
}

declare const slack: {
  /** Read the current Slack run's thread from the D1 system of record. */
  thread(input: { limit?: number }): Promise<SlackMessage[]>
  /** Search ingested channel messages within the host-selected scope. */
  searchMessages(input: {
    query: string
    limit?: number
  }): Promise<SlackMessage[]>
  /** Reply to the current thread as the host-selected on-duty engineer. */
  reply(input: {
    text: string
  }): Promise<{ ts: string; permalink: string | null }>
}

declare const memory: {
  recall(args: {
    query: string
    scope?: "customer" | "org"
    limit?: number
  }): Promise<RecalledFact[]>
  /** Only IDs returned by recall() in this execution are accepted. */
  cite(args: { factIds: string[] }): Promise<Citation[]>
}

declare const linear: {
  createIssue(args: {
    title: string
    description: string
    assessment: {
      platformValue: "low" | "medium" | "high"
      blocking: "low" | "medium" | "high"
      customerWeight: "low" | "medium" | "high"
      evidence: string
    }
    labels?: string[]
  }): Promise<{ id: string; identifier: string; url: string }>
  updateIssue(args: {
    issueId: string
    title?: string
    description?: string
    state?: string
  }): Promise<{ id: string; url: string }>
}

declare const supabase: {
  schema(input: { resource?: string }): Promise<ResourceDescription[]>
  select(args: {
    resource: string
    columns?: string[]
    filters?: Array<{
      column: string
      op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "is" | "like"
      value: string | number | boolean | null | Array<string | number>
    }>
    order?: { column: string; direction: "asc" | "desc" }
    limit?: number
  }): Promise<Row[]>
}

declare const langsmith: {
  trace(input: { traceId: string }): Promise<Trace>
  searchTraces(input: {
    query?: string
    since?: string
    limit?: number
  }): Promise<TraceRef[]>
}

declare const betterstack: {
  logs(args: {
    query: string
    since: string
    until?: string
    limit?: number
  }): Promise<LogLine[]>
  /** Input schema needs `.default({})` so a bare `monitors()` also works. */
  monitors(input: Record<string, never>): Promise<Monitor[]>
}

declare const files: {
  publish(args: {
    bytes: Uint8Array
    contentType: string
    filename: string
  }): Promise<{ url: string; size: number; sha256: string }>
}
```

Deliberate differences from the old design sketch:

- `slack.reply` has no channel/thread arguments; current-run targeting is a
  security property.
- Supabase does not expose arbitrary SQL. A bounded, allowlisted read surface
  is easier to defend and still composable in code.
- Memory writes are automatic system behavior, not a model tool. This avoids
  teaching durable memory facts the model merely inferred.
- `github`, `sandbox`, `escalate`, and `withdraw` are absent until their owning
  phases.

---

## Effect ledger

The model may retry a Code Mode block after a transport error. Side effects
therefore need a durable reservation separate from the in-memory executor.

```sql
CREATE TABLE codemode_effects (
  effect_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  method TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('reserved', 'completed', 'failed', 'in_doubt')
  ),
  safe_result_json TEXT,
  safe_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (run_id, turn_id, namespace, method, args_hash)
);
```

`effect_key` is a SHA-256 over a canonical versioned envelope, not string
concatenation:

```ts
{
  version: (1, runId, turnId, namespace, method, normalizedArgs)
}
```

Rules:

- reserve before the external call;
- return the recorded result for an already-completed identical effect;
- use the same key as an upstream idempotency token when that API supports it;
- use deterministic R2 object keys for file publication;
- if the Worker can prove the call failed before reaching upstream, mark
  `failed` and permit a deliberate retry;
- if the Worker may have succeeded but crashed before recording the result,
  mark or retain `in_doubt` and return `effect_in_doubt` until reconciled;
- never turn uncertainty into a duplicate customer message or Linear issue;
- prune only after the audit retention policy is defined; do not silently
  delete during this phase.

Read-only calls do not use this table. Their lifecycle still goes to the RunDO
tool-event audit sink.

---

## Task 0: Re-verify the thin APIs and preserve the baseline

**Files:** Create `docs/superpowers/plans/phase-09-notes.md`; inspect only all
other files in this task

**Produces:** a dated compatibility record and a go/no-go decision before code

- [ ] **Step 1: Confirm prerequisites are actually complete**

Read the Phase 00 deployed report and run the Phase 08 exit checks. Confirm the
real Worker config has a `RUNS` SQLite Durable Object binding and that the
`RunDO` RPC type includes the promised snapshot, turn, status, and tool-update
methods. A plan file is not a dependency implementation.

- [ ] **Step 2: Query the Cloudflare docs MCP**

Search, at minimum:

```text
Agents SDK Code Mode createCodeTool DynamicWorkerExecutor AI SDK providers
Dynamic Workers Worker Loader load globalOutbound limits TypeScript
Workers RPC RpcTarget call arguments lifecycle disposal
Workers best practices generated binding types secrets observability
```

Put the returned URLs, current date, and any changed API names in the notes.
MCP here is engineer tooling; do not add an MCP client to the product.

- [ ] **Step 3: Inspect exact package declarations**

```bash
cd apps/worker
pnpm view @cloudflare/codemode version          # expect 0.5.1
pnpm add @cloudflare/codemode@0.5.1 --save-exact
```

**This step is mostly already done.** The 0.5.1 surface was read from the
published tarball — declarations *and* compiled JavaScript — and the results are
in the findings table above. Do not re-derive them; confirm they still hold:

```bash
cd apps/worker
# the two-resolveProvider trap — must still print the "does NOT" comment
rg -n "does NOT perform schema validation" node_modules/@cloudflare/codemode/dist
# the in-sandbox timeout — must still be inside the generated module string
rg -n "Execution timed out" node_modules/@cloudflare/codemode/dist/index.js
# the hardcoded bundle compat date
rg -n "compatibilityDate" node_modules/@cloudflare/codemode/dist/index.js
# type names still unprefixed by namespace
rg -n "toPascalCase\(safeName\)" node_modules/@cloudflare/codemode/dist
```

If the installed version is no longer `0.5.1`, pin the newly inspected version
and re-verify **each** findings-table row before continuing — most of them are
compiled-output behaviour, not API shape, so a patch release can move them
without changing a single type. Never combine a new package version with old
declarations merely because TypeScript accepts an unsafe cast.

- [ ] **Step 4: Verify external integration docs one provider at a time**

Use official docs or attached docs/API MCPs for Slack, Linear, Supabase,
LangSmith, and Better Stack. Record:

- exact API base origin and authentication header;
- read/write endpoint or GraphQL operation names;
- pagination and maximum page size;
- upstream idempotency support;
- error envelope and rate-limit headers;
- which workspace, team, project, source, or resource IDs must be pinned;
- whether the supplied Supabase credential is PostgREST, Postgres, or another
  read-only shape.

Do not design a real client until this is known. If an MCP is missing, ask for
it at this step.

- [ ] **Step 5: Preserve and run the current baseline**

```bash
cd apps/worker
pnpm test
pnpm typecheck
pnpm exec wrangler deploy --dry-run
```

Record pre-existing failures. Do not broaden Phase 09 to repair unrelated
failures unless they block this phase.

- [ ] **Step 6: Commit only the notes and dependency pin**

Suggested implementation commit:

```bash
git add apps/worker/package.json pnpm-lock.yaml \
  docs/superpowers/plans/phase-09-notes.md
git commit -m "chore(codemode): pin verified cloudflare sdk"
```

---

## Task 1: Add Worker Loader config and generated platform types

**Files:** Modify `apps/worker/wrangler.jsonc`,
`apps/worker/worker-configuration.d.ts`, `apps/worker/src/index.ts` (Env); create
`apps/worker/test/codemode-loader.test.ts`

**Consumes:** Task 0 API verification

**Produces:** one typed `LOADER` platform binding, **proven to work inside the
vitest runtime**, with no handwritten substitute

**Interfaces:**

- Produces: `env.LOADER: WorkerLoader` — `load(code: WorkerLoaderWorkerCode) => WorkerStub`
  and `get(name, getCode) => WorkerStub`, from the generated
  `worker-configuration.d.ts`. Every later task consumes this and nothing else.

> **Why this task carries a real execution test.** Nothing in the build has ever
> loaded a Dynamic Worker under `@cloudflare/vitest-pool-workers`. The Phase 00
> spike ran under `wrangler dev` and deployed — never under vitest. Tasks 4b, 12,
> 13 and 14 all assume a real isolate runs in the test runtime. Pool-workers
> 0.21.0 pulls miniflare `5.20260804.0-alpha`, which does parse `worker_loaders`
> into a `workerLoaders` record, so this is expected to pass — but if it does
> not, the entire test strategy for the phase changes and you need to know that
> now, not in Task 13. This is the cheapest possible way to find out.

- [ ] **Step 1: Write the failing binding test**

```ts
// apps/worker/test/codemode-loader.test.ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("LOADER binding", () => {
  it("is present and exposes both Worker Loader methods", () => {
    expect(env.LOADER).toBeDefined();
    expect(typeof env.LOADER.load).toBe("function");
    expect(typeof env.LOADER.get).toBe("function");
  });

  // The de-risk. If this fails, stop and re-plan the phase's test strategy
  // before writing any executor code.
  it("loads and runs a trivial Dynamic Worker in the vitest runtime", async () => {
    const stub = env.LOADER.load({
      compatibilityDate: "2026-08-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "main.js",
      modules: {
        "main.js": `
          import { WorkerEntrypoint } from "cloudflare:workers";
          export default class extends WorkerEntrypoint {
            async ping(value) { return "pong:" + value; }
          }
        `,
      },
      globalOutbound: null,
    });

    const entrypoint = stub.getEntrypoint() as unknown as {
      ping(value: string): Promise<string>;
    };
    await expect(entrypoint.ping("hi")).resolves.toBe("pong:hi");
  });

  // Proves globalOutbound: null is causal in THIS runtime, not just deployed.
  // Task 14 repeats this against the production path and in staging.
  it("refuses outbound fetch when globalOutbound is null", async () => {
    const stub = env.LOADER.load({
      compatibilityDate: "2026-08-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "main.js",
      modules: {
        "main.js": `
          import { WorkerEntrypoint } from "cloudflare:workers";
          export default class extends WorkerEntrypoint {
            async probe() {
              // Assert refusal on INVOCATION. fetch remains defined.
              if (typeof fetch !== "function") return "fetch-missing";
              try { await fetch("https://example.com"); return "reached"; }
              catch (err) { return "refused:" + err.message; }
            }
          }
        `,
      },
      globalOutbound: null,
    });

    const entrypoint = stub.getEntrypoint() as unknown as {
      probe(): Promise<string>;
    };
    const result = await entrypoint.probe();
    expect(result).toMatch(/^refused:/);
    expect(result).not.toBe("fetch-missing"); // absence is the wrong claim
  });
});
```

- [ ] **Step 2: Run it and watch it fail for the right reason**

Run: `pnpm vitest run test/codemode-loader.test.ts`
Expected: FAIL — `env.LOADER` is undefined, because the binding does not exist
yet. If it instead fails inside `load()`, read the error before adding config;
that is the signal this task exists to catch.

- [ ] **Step 3: Assert no handwritten platform types**

Not a vitest assertion — a grep, run in Step 6 and again in Task 15. Both must
return no matches outside `worker-configuration.d.ts`:

```bash
cd apps/worker
rg -n "interface WorkerLoader" src/ test/
rg -n "as unknown as WorkerLoader" src/ test/
```

- [ ] **Step 4: Add the binding using the installed schema**

Verified against this repo's `node_modules/wrangler/config-schema.json`
(`RawConfig.properties.worker_loaders`), so this is the exact shape, not a guess:

```jsonc
"worker_loaders": [{ "binding": "LOADER" }]
```

Do not add a service binding, outbound fetcher, or second Worker for Code Mode.
Do not change the global Worker CPU limit as a substitute for per-Dynamic-
Worker limits.

- [ ] **Step 5: Regenerate types and extend the app Env**

```bash
cd apps/worker
pnpm cf-typegen
```

`wrangler types` reads the *declared names* in `.dev.vars`, not their values, so
regenerating on a machine with a different `.dev.vars` produces a spurious diff.
**Commit only the `LOADER` binding line from this regeneration** — see
`phase-08-notes.md` item 7.

Then add `LOADER: WorkerLoader` to the hand-written `Env` in `src/index.ts`
(which is separate from the generated file and does not inherit from it). Do not
repeat D1, Queue, R2, or DO platform types manually.

- [ ] **Step 6: Run the test and the greps**

```bash
cd apps/worker
pnpm vitest run test/codemode-loader.test.ts   # all three cases PASS
rg -n "interface WorkerLoader" src/ test/      # no matches
rg -n "as unknown as WorkerLoader" src/ test/  # no matches
pnpm exec wrangler deploy --dry-run            # env.LOADER resolves
pnpm typecheck
```

If the second test case fails here, **stop**. Record the failure in
`phase-09-notes.md` and re-plan Tasks 4b, 12, 13 and 14 around
`wrangler dev`/deployed probes before writing any more code.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/wrangler.jsonc \
  apps/worker/worker-configuration.d.ts apps/worker/src/index.ts \
  apps/worker/test/codemode-loader.test.ts
git commit -m "feat(codemode): configure dynamic worker loader"
```

---

## Task 2: Freeze trusted context, safe values, and errors

**Files:** Create `src/codemode/contracts.ts`, `src/codemode/errors.ts`,
`src/codemode/bindings/shared.ts`, `test/codemode-contracts.test.ts`

**Consumes:** Phase 08 run protocol and Task 1 generated types

**Produces:** the request-scoped trust envelope all providers share

**Interfaces:**

- Consumes: `JsonValue`, `JsonObject` from `src/run/protocol.ts` (depth-bounded
  to four levels — this is what fixes Task 2's depth cap at 3).
- Produces, all from `src/codemode/contracts.ts` unless noted:
  - `validateScope(input: unknown): CodeModeScope` — throws `CapabilityError`
    with code `invalid_context`.
  - `toSafeJson(value: unknown, limits: CodeModeLimits): JsonValue` — throws
    `CapabilityError` with code `output_too_large` or `invalid_input`.
  - `CapabilityError` / `CapabilityErrorCode` (`src/codemode/errors.ts`).
  - `safeMessage(err: unknown): string` — the `"code: message"` wire format.
  - `withCapabilityAudit(deps, scope, counter, ns, method, fn)`
    (`src/codemode/bindings/shared.ts`).

- [ ] **Step 1: Write the failing scope validation test**

```ts
// apps/worker/test/codemode-contracts.test.ts
import { describe, expect, it } from "vitest";
import { validateScope } from "../src/codemode/contracts";
import { CapabilityError } from "../src/codemode/errors";

const slackScope = {
  runId: "run_1",
  turnId: "turn_1",
  origin: "slack" as const,
  shadow: false,
  customerSlug: "acme",
  slackThread: { channelId: "C123", threadTs: "1712345678.000100" },
  actor: { engineerEmail: "eng@example.com", slackUserId: "U1" },
};

describe("validateScope", () => {
  it("accepts a well-formed Slack scope unchanged", () => {
    expect(validateScope(slackScope)).toEqual(slackScope);
  });

  it("requires a Slack target when origin is slack", () => {
    expect(() => validateScope({ ...slackScope, slackThread: null }))
      .toThrow(CapabilityError);
  });

  it("allows a Chat run with no Slack target", () => {
    const chat = { ...slackScope, origin: "chat" as const, slackThread: null };
    expect(validateScope(chat).slackThread).toBeNull();
  });

  it("allows a missing actor — Phase 12 supplies it", () => {
    expect(validateScope({ ...slackScope, actor: null }).actor).toBeNull();
  });

  // The smuggling case. An extra field must be rejected, never ignored:
  // silently dropping it invites a later refactor to start reading it.
  it("rejects unknown fields so a caller cannot smuggle a token in", () => {
    expect(() => validateScope({ ...slackScope, slackToken: "xoxp-leak" }))
      .toThrow(/invalid_context/);
  });

  it.each([
    ["blank runId", { runId: "" }],
    ["oversized customerSlug", { customerSlug: "x".repeat(300) }],
    ["non-boolean shadow", { shadow: "false" }],
    ["malformed threadTs", { slackThread: { channelId: "C1", threadTs: "nope" } }],
  ])("rejects %s", (_label, patch) => {
    expect(() => validateScope({ ...slackScope, ...patch })).toThrow(CapabilityError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/codemode-contracts.test.ts`
Expected: FAIL — `Cannot find module '../src/codemode/contracts'`.

- [ ] **Step 3: Write the failing JSON-boundary test**

The depth cap is **3**, not an arbitrary number: results flow into
`RunDO.appendToolCallUpdate({ output?: JsonValue })` and `JsonValue` bottoms out
at four levels. A deeper value is a typecheck failure that no test can see.

```ts
import { toSafeJson } from "../src/codemode/contracts";
import { TEST_LIMITS } from "./helpers/codemode";   // small caps for speed

describe("toSafeJson", () => {
  it("passes small structured values through unchanged", () => {
    const value = { ok: true, count: 2, items: ["a", "b"], nothing: null };
    expect(toSafeJson(value, TEST_LIMITS)).toEqual(value);
  });

  it.each([
    ["bigint", 1n],
    ["function", () => {}],
    ["symbol", Symbol("s")],
    ["Error", new Error("boom")],
    ["Response", new Response("x")],
    ["Request", new Request("https://example.com")],
    ["class instance", new (class Foo { bar = 1 })()],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects %s", (_label, value) => {
    expect(() => toSafeJson(value, TEST_LIMITS)).toThrow(/invalid_input/);
  });

  it("rejects a cyclic value rather than hanging", () => {
    const cycle: Record<string, unknown> = { name: "loop" };
    cycle.self = cycle;
    expect(() => toSafeJson(cycle, TEST_LIMITS)).toThrow(/invalid_input/);
  });

  it("rejects nesting deeper than the protocol's JsonValue allows", () => {
    expect(() => toSafeJson({ a: { b: { c: { d: 1 } } } }, TEST_LIMITS))
      .toThrow(/invalid_input/);
  });

  it("rejects an object whose toJSON() throws", () => {
    const hostile = { toJSON() { throw new Error("nope"); } };
    expect(() => toSafeJson(hostile, TEST_LIMITS)).toThrow(/invalid_input/);
  });

  it("does not let prototype-pollution keys through", () => {
    const parsed = JSON.parse('{"__proto__":{"polluted":true},"ok":1}');
    const safe = toSafeJson(parsed, TEST_LIMITS) as Record<string, unknown>;
    expect(safe).toEqual({ ok: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects Uint8Array as an ordinary result", () => {
    expect(() => toSafeJson(new Uint8Array([1, 2]), TEST_LIMITS))
      .toThrow(/invalid_input/);
  });
});
```

- [ ] **Step 4: Write the failing safe-error test**

```ts
import { CapabilityError, safeMessage } from "../src/codemode/errors";

describe("safeMessage", () => {
  it("serializes a CapabilityError as `code: message`", () => {
    const err = new CapabilityError("channel_read_only", "Slack replies are disabled for #ref (mode=observe).");
    expect(safeMessage(err)).toBe(
      "channel_read_only: Slack replies are disabled for #ref (mode=observe).",
    );
  });

  // Only `message` survives ToolDispatcher, so the code must be IN the message.
  it("keeps the code recoverable after a message-only round trip", () => {
    const err = new CapabilityError("customer_scope_required", "Ask which customer this concerns.");
    const rethrown = new Error(safeMessage(err));       // what the sandbox does
    expect(rethrown.message).toMatch(/^customer_scope_required: /);
  });

  it("maps an unknown error to one safe code and leaks nothing", () => {
    const upstream = new Error("PG connect failed: postgres://user:hunter2@db/prod");
    const out = safeMessage(upstream);
    expect(out).toMatch(/^upstream_unavailable: /);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("postgres://");
    expect(out).not.toContain("at Object.");           // no stack frames
  });
});
```

- [ ] **Step 5: Write the failing audit-wrapper test**

```ts
import { withCapabilityAudit } from "../src/codemode/bindings/shared";
import { fakeAuditSink, newCallCounter, TEST_LIMITS } from "./helpers/codemode";

describe("withCapabilityAudit", () => {
  it("emits started then completed, in order", async () => {
    const audit = fakeAuditSink();
    const run = () => withCapabilityAudit(
      { audit, clock: () => 0 }, slackScope, newCallCounter(TEST_LIMITS),
      "slack", "thread", async () => [{ ts: "1.0", text: "hi" }],
    );
    await expect(run()).resolves.toEqual([{ ts: "1.0", text: "hi" }]);
    expect(audit.events.map((e) => e.kind)).toEqual(["started", "completed"]);
  });

  it("emits started then failed exactly once on throw", async () => {
    const audit = fakeAuditSink();
    const counter = newCallCounter(TEST_LIMITS);
    await expect(withCapabilityAudit(
      { audit, clock: () => 0 }, slackScope, counter, "slack", "reply",
      async () => { throw new CapabilityError("channel_read_only", "no"); },
    )).rejects.toThrow(/channel_read_only/);
    expect(audit.events.map((e) => e.kind)).toEqual(["started", "failed"]);
  });

  it("refuses past maxCapabilityCalls before making the host call", async () => {
    const audit = fakeAuditSink();
    const counter = newCallCounter({ ...TEST_LIMITS, maxCapabilityCalls: 2 });
    let hostCalls = 0;
    const call = () => withCapabilityAudit(
      { audit, clock: () => 0 }, slackScope, counter, "slack", "thread",
      async () => { hostCalls += 1; return []; },
    );
    await call();
    await call();
    await expect(call()).rejects.toThrow(/capability_unavailable/);
    expect(hostCalls).toBe(2);          // the third never reached the host
  });

  it("counts correctly when reads run concurrently", async () => {
    const audit = fakeAuditSink();
    const counter = newCallCounter({ ...TEST_LIMITS, maxCapabilityCalls: 10 });
    await Promise.all([1, 2, 3, 4].map(() => withCapabilityAudit(
      { audit, clock: () => 0 }, slackScope, counter, "slack", "thread",
      async () => [],
    )));
    expect(audit.events.filter((e) => e.kind === "completed")).toHaveLength(4);
  });

  it("never lets a secret-shaped argument into an audit event", async () => {
    const audit = fakeAuditSink();
    await withCapabilityAudit(
      { audit, clock: () => 0 }, slackScope, newCallCounter(TEST_LIMITS),
      "slack", "reply", async () => ({ ts: "1.0" }),
    );
    expect(JSON.stringify(audit.events)).not.toMatch(/xox[bp]-|Bearer |api[_-]?key/i);
  });
});
```

- [ ] **Step 6: Prove concurrent scope isolation**

This guards against a future module-global `currentRun` shortcut — the single
refactor most likely to cross two customers' data.

```ts
it("keeps two interleaved invocations' scopes separate", async () => {
  const a = { ...slackScope, runId: "run_a", customerSlug: "acme",
              slackThread: { channelId: "C_A", threadTs: "1.1" } };
  const b = { ...slackScope, runId: "run_b", customerSlug: "globex",
              slackThread: { channelId: "C_B", threadTs: "2.2" } };

  const auditA = fakeAuditSink();
  const auditB = fakeAuditSink();
  const call = (scope: typeof a, audit: ReturnType<typeof fakeAuditSink>) =>
    withCapabilityAudit({ audit, clock: () => 0 }, scope,
      newCallCounter(TEST_LIMITS), "slack", "thread",
      async () => { await new Promise((r) => setTimeout(r, 1)); return [scope.customerSlug]; });

  const [ra, rb] = await Promise.all([call(a, auditA), call(b, auditB)]);
  expect(ra).toEqual(["acme"]);
  expect(rb).toEqual(["globex"]);
  expect(JSON.stringify(auditA.events)).not.toMatch(/globex|run_b|C_B/);
  expect(JSON.stringify(auditB.events)).not.toMatch(/acme|run_a|C_A/);
});
```

- [ ] **Step 7: Implement until green**

Write `contracts.ts`, `errors.ts` and `bindings/shared.ts` — plus
`test/helpers/codemode.ts` holding `TEST_LIMITS`, `fakeAuditSink()` and
`newCallCounter()` — until every case above passes. Take the smallest
implementation that does it; the caps and policy live in reviewed constants, not
in branching logic.

Redact known secret-name patterns as defense in depth only. The primary
credential boundary is that no credential is ever in scope, not that a regex
caught it.

- [ ] **Step 8: Run and commit**

```bash
cd apps/worker
pnpm vitest run test/codemode-contracts.test.ts
pnpm typecheck     # not optional: the depth cap is invisible to vitest
git add src/codemode/contracts.ts src/codemode/errors.ts \
  src/codemode/bindings/shared.ts test/codemode-contracts.test.ts \
  test/helpers/codemode.ts
git commit -m "feat(codemode): define trusted capability boundary"
```

---

## Task 3: Build the durable effect ledger

**Files:** Create `migrations/0005_codemode_effects.sql`,
`src/codemode/effects.ts`, `test/codemode-effects.test.ts`; modify test setup if
needed

**Consumes:** Task 2 safe values and clock

**Produces:** retry-aware execution for external effects

**Interfaces:**

- Produces (`src/codemode/effects.ts`):
  - `effectKey(scope: CodeModeScope, ns: string, method: string, args: JsonValue): Promise<string>`
    — SHA-256 hex over a canonical versioned envelope.
  - `runEffect<T>(deps, scope, ns, method, args, opts): Promise<T>` where
    `opts = { execute: (idempotencyKey: string) => Promise<T>; reconcile?: (key: string) => Promise<T | null> }`.
    Throws `CapabilityError("effect_in_doubt", …)` when it cannot prove the
    outcome.

> **There is no empty database in this test harness, and there cannot be one.**
> `test/setup.ts` runs `applyD1Migrations` once at module load; storage is shared
> across test cases *and* across files; and `reset()` would wipe the migrated D1
> for all other suites (`phase-08-notes.md`). So this task does **not** assert on
> a fresh store. Instead: every test mints its own `runId`/`turnId` via
> `crypto.randomUUID()`, and no test asserts an absolute row count over the whole
> table. The migration itself is proved by `wrangler deploy --dry-run` plus the
> schema assertion in Step 1.

- [ ] **Step 1: Write the migration and its failing schema test**

Create `migrations/0005_codemode_effects.sql` with the schema in
[Effect ledger](#effect-ledger), plus indexes on `(run_id, created_at)` and
`(state, updated_at)`. Do not rename Phase 08's `0004_runs.sql`.

```ts
// apps/worker/test/codemode-effects.test.ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const newScope = () => ({
  ...slackScope,
  runId: `run_${crypto.randomUUID()}`,
  turnId: `turn_${crypto.randomUUID()}`,
});

describe("codemode_effects schema", () => {
  it("exists with the state check constraint enforced", async () => {
    const row = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='codemode_effects'",
    ).first<{ sql: string }>();
    expect(row?.sql).toContain("effect_key");

    await expect(
      env.DB.prepare(
        `INSERT INTO codemode_effects
           (effect_key, run_id, turn_id, namespace, method, args_hash,
            state, created_at, updated_at)
         VALUES (?, 'r', 't', 'slack', 'reply', 'h', 'bogus_state', 0, 0)`,
      ).bind(`k_${crypto.randomUUID()}`).run(),
    ).rejects.toThrow();          // CHECK constraint refuses the unknown state
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/codemode-effects.test.ts`
Expected: FAIL — `no such table: codemode_effects`, because the migration has
not been applied to the test D1 yet. Re-running vitest picks up the new
migration through `readD1Migrations` in `vitest.config.ts`.

- [ ] **Step 3: Write the failing canonical-hash test**

Use Web Crypto SHA-256. Never `Math.random()`, never a non-cryptographic hash —
the key is a correctness boundary, not a cache tag.

```ts
import { effectKey } from "../src/codemode/effects";

describe("effectKey", () => {
  const scope = newScope();
  const key = (args: unknown, ns = "slack", method = "reply", s = scope) =>
    effectKey(s, ns, method, args as never);

  it("is stable across object key order", async () => {
    expect(await key({ a: 1, b: 2 })).toBe(await key({ b: 2, a: 1 }));
  });

  it("changes with array order, because order is meaningful", async () => {
    expect(await key({ xs: [1, 2] })).not.toBe(await key({ xs: [2, 1] }));
  });

  it("changes with namespace or method", async () => {
    expect(await key({ t: 1 })).not.toBe(await key({ t: 1 }, "linear"));
    expect(await key({ t: 1 })).not.toBe(await key({ t: 1 }, "slack", "thread"));
  });

  it("changes with run or turn, so a later turn may repeat an effect", async () => {
    const other = { ...scope, turnId: `turn_${crypto.randomUUID()}` };
    expect(await key({ t: 1 })).not.toBe(await key({ t: 1 }, "slack", "reply", other));
  });

  it("normalizes Unicode deterministically", async () => {
    expect(await key({ s: "café" })).toBe(await key({ s: "café" }));
  });

  it("rejects an unhashable value before any reservation", async () => {
    await expect(key({ big: 1n })).rejects.toThrow(/invalid_input/);
  });
});
```

- [ ] **Step 4: Write the failing reservation and replay tests**

D1 is the coordination authority. An in-memory `Set` would be empty after a
Worker restart and is not sufficient.

```ts
import { runEffect } from "../src/codemode/effects";

describe("runEffect", () => {
  const deps = () => ({ db: env.DB, clock: () => 1_000 });

  it("executes once and returns the normalized result", async () => {
    let calls = 0;
    const out = await runEffect(deps(), newScope(), "slack", "reply", { text: "hi" }, {
      execute: async () => { calls += 1; return { ts: "1.0", permalink: null }; },
    });
    expect(out).toEqual({ ts: "1.0", permalink: null });
    expect(calls).toBe(1);
  });

  it("replays a completed effect without calling upstream again", async () => {
    const scope = newScope();
    let calls = 0;
    const run = () => runEffect(deps(), scope, "slack", "reply", { text: "hi" }, {
      execute: async () => { calls += 1; return { ts: "1.0", permalink: null }; },
    });
    await run();
    await expect(run()).resolves.toEqual({ ts: "1.0", permalink: null });
    expect(calls).toBe(1);                       // the retry replayed
  });

  it("lets two concurrent identical reservations produce exactly one call", async () => {
    const scope = newScope();
    let calls = 0;
    const run = () => runEffect(deps(), scope, "linear", "createIssue", { title: "t" }, {
      execute: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return { id: "iss_1", identifier: "FF-1", url: "https://x" };
      },
    });
    const [a, b] = await Promise.all([run(), run()]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });

  it("permits a deliberate retry after a proven pre-upstream failure", async () => {
    const scope = newScope();
    let calls = 0;
    const run = (fail: boolean) =>
      runEffect(deps(), scope, "slack", "reply", { text: "hi" }, {
        execute: async () => {
          calls += 1;
          if (fail) throw new CapabilityError("invalid_input", "rejected before send");
          return { ts: "2.0", permalink: null };
        },
      });
    await expect(run(true)).rejects.toThrow(/invalid_input/);
    await expect(run(false)).resolves.toEqual({ ts: "2.0", permalink: null });
    expect(calls).toBe(2);
  });

  // The case that must never duplicate a customer message.
  it("returns effect_in_doubt when the outcome cannot be proven", async () => {
    const scope = newScope();
    await expect(
      runEffect(deps(), scope, "slack", "reply", { text: "hi" }, {
        execute: async () => { throw new Error("network reset mid-flight"); },
      }),
    ).rejects.toThrow(/effect_in_doubt/);

    // And a retry keeps refusing rather than sending a second time.
    let secondAttempt = 0;
    await expect(
      runEffect(deps(), scope, "slack", "reply", { text: "hi" }, {
        execute: async () => { secondAttempt += 1; return { ts: "3.0", permalink: null }; },
      }),
    ).rejects.toThrow(/effect_in_doubt/);
    expect(secondAttempt).toBe(0);
  });

  it("resolves an in-doubt effect through reconcile when one is supplied", async () => {
    const scope = newScope();
    await expect(runEffect(deps(), scope, "linear", "createIssue", { title: "t" }, {
      execute: async () => { throw new Error("timeout after send"); },
    })).rejects.toThrow(/effect_in_doubt/);

    await expect(runEffect(deps(), scope, "linear", "createIssue", { title: "t" }, {
      execute: async () => { throw new Error("should not run"); },
      reconcile: async () => ({ id: "iss_9", identifier: "FF-9", url: "https://x" }),
    })).resolves.toMatchObject({ identifier: "FF-9" });
  });

  it("lets a later turn intentionally repeat the same semantic effect", async () => {
    const base = newScope();
    const later = { ...base, turnId: `turn_${crypto.randomUUID()}` };
    let calls = 0;
    const run = (s: typeof base) =>
      runEffect(deps(), s, "slack", "reply", { text: "same text" }, {
        execute: async () => { calls += 1; return { ts: `${calls}.0`, permalink: null }; },
      });
    await run(base);
    await run(later);
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 5: Implement `runEffect()` until green**

It takes the trusted envelope, a safe argument representation, an execute
function receiving the effect key as an upstream idempotency token, and an
optional reconcile function. It returns only the normalized safe result.

**Never hold a D1 statement open across an external network request.** Reserve
and commit, call upstream, then record completion in a second statement. The gap
between those two writes is exactly the `in_doubt` window, which is why
`in_doubt` is a real state and not an error path.

- [ ] **Step 6: Run and commit**

```bash
cd apps/worker
pnpm vitest run test/codemode-effects.test.ts
pnpm test          # the whole suite: this task touched shared D1 state
pnpm typecheck
pnpm exec wrangler deploy --dry-run
git add migrations/0005_codemode_effects.sql src/codemode/effects.ts \
  test/codemode-effects.test.ts
git commit -m "feat(codemode): make capability effects retry aware"
```

---

## Task 4a: Build the guarded Loader

**Files:** Create `src/codemode/guarded-loader.ts`,
`test/codemode-guarded-loader.test.ts`

**Consumes:** Task 1 `LOADER`, Task 2 limits/errors

**Produces:** a fail-closed `WorkerLoader` adapter — the phase's security gate

**Interfaces:**

- Produces: `guardLoader(real: WorkerLoader, limits: CodeModeLimits): WorkerLoader`.
  Returns something satisfying the full `WorkerLoader` interface, so it can be
  handed straight to `new DynamicWorkerExecutor({ loader })` in Task 4b.

> **Split from the executor deliberately.** This task is a pure function over a
> captured object: no Dynamic Worker runs, no timing, no flakiness. It is where
> invariants 3, 4, 5 and 6 live, and a reviewer can accept it independently of
> everything in 4b. It is also the only place the bundle's `compatibilityDate`
> can be corrected — the package hardcodes `2025-06-01`, against this project's
> `2026-08-01`.

- [ ] **Step 1: Write the failing bundle-inspection test**

```ts
// apps/worker/test/codemode-guarded-loader.test.ts
import { describe, expect, it, vi } from "vitest";
import { guardLoader } from "../src/codemode/guarded-loader";
import { TEST_LIMITS } from "./helpers/codemode";

/** Captures whatever the adapter hands the real binding. */
function fakeLoader() {
  const calls: WorkerLoaderWorkerCode[] = [];
  const loader = {
    load: vi.fn((code: WorkerLoaderWorkerCode) => { calls.push(code); return {} as WorkerStub; }),
    get: vi.fn(() => { throw new Error("get() must never be reached"); }),
  };
  return { loader: loader as unknown as WorkerLoader, calls, spies: loader };
}

const bundle = (patch: Partial<WorkerLoaderWorkerCode> = {}): WorkerLoaderWorkerCode => ({
  compatibilityDate: "2025-06-01",           // what the package sends
  compatibilityFlags: ["nodejs_compat"],
  mainModule: "executor.js",
  modules: { "executor.js": "export default class {}" },
  ...patch,
});

describe("guardLoader", () => {
  it("calls load() exactly once and never get()", () => {
    const { loader, spies } = fakeLoader();
    guardLoader(loader, TEST_LIMITS).load(bundle());
    expect(spies.load).toHaveBeenCalledTimes(1);
    expect(spies.get).not.toHaveBeenCalled();
  });

  // If a future SDK silently switches to cached execution we must fail loudly,
  // not run stale model code. get() is required by the interface; ours refuses.
  it("throws an invariant error if anything calls get()", () => {
    const { loader } = fakeLoader();
    expect(() => guardLoader(loader, TEST_LIMITS).get("name", () => bundle()))
      .toThrow(/never uses get\(\)/i);
  });

  it("forces globalOutbound to null when the caller omitted it", () => {
    const { loader, calls } = fakeLoader();
    guardLoader(loader, TEST_LIMITS).load(bundle());
    expect(calls[0].globalOutbound).toBeNull();
  });

  // The causal control in Task 14 proves omitting the field reaches the
  // internet. Production must make that configuration unreachable.
  it.each([
    ["a Fetcher", {} as Fetcher],
    ["undefined", undefined],
  ])("refuses a caller-supplied globalOutbound of %s", (_label, value) => {
    const { loader, calls } = fakeLoader();
    guardLoader(loader, TEST_LIMITS).load(bundle({ globalOutbound: value as never }));
    expect(calls[0].globalOutbound).toBeNull();      // forced, never inherited
  });

  it("rejects a non-empty loaded-Worker env", () => {
    const { loader } = fakeLoader();
    expect(() => guardLoader(loader, TEST_LIMITS).load(bundle({ env: { DB: {} } })))
      .toThrow(/env must be empty/i);
  });

  it("injects the reviewed limits", () => {
    const { loader, calls } = fakeLoader();
    guardLoader(loader, TEST_LIMITS).load(bundle());
    expect(calls[0].limits).toEqual({
      cpuMs: TEST_LIMITS.cpuMs,
      subRequests: TEST_LIMITS.subRequests,
    });
  });

  it("clamps a call site asking for larger limits", () => {
    const { loader, calls } = fakeLoader();
    guardLoader(loader, TEST_LIMITS).load(
      bundle({ limits: { cpuMs: 999_999, subRequests: 999_999 } }),
    );
    expect(calls[0].limits!.cpuMs).toBe(TEST_LIMITS.cpuMs);
    expect(calls[0].limits!.subRequests).toBe(TEST_LIMITS.subRequests);
  });

  // The package hardcodes 2025-06-01; the global constraint is 2026-08-01.
  it("pins the bundle's compatibility date to the project's", () => {
    const { loader, calls } = fakeLoader();
    guardLoader(loader, TEST_LIMITS).load(bundle());
    expect(calls[0].compatibilityDate).toBe("2026-08-01");
    expect(calls[0].compatibilityFlags).toContain("nodejs_compat");
  });

  it("accepts only the expected executor module", () => {
    const { loader } = fakeLoader();
    expect(() => guardLoader(loader, TEST_LIMITS).load(
      bundle({ modules: { "executor.js": "x", "evil.js": "fetch('https://x')" } }),
    )).toThrow(/unexpected module/i);
  });

  it("does not mutate the caller's object", () => {
    const { loader } = fakeLoader();
    const original = bundle();
    guardLoader(loader, TEST_LIMITS).load(original);
    expect(original.globalOutbound).toBeUndefined();
    expect(original.compatibilityDate).toBe("2025-06-01");
  });

  it("never lets a binding or secret into the bundle", () => {
    const { loader, calls } = fakeLoader();
    guardLoader(loader, TEST_LIMITS).load(bundle());
    const serialized = JSON.stringify(calls[0]);
    for (const forbidden of ["DB", "RUNS", "LOADER", "ARTIFACTS", "QUEUE",
                             "SLACK_BOT_TOKEN", "ANTHROPIC_API_KEY", "ZEP_API_KEY"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/codemode-guarded-loader.test.ts`
Expected: FAIL — `Cannot find module '../src/codemode/guarded-loader'`.

- [ ] **Step 3: Implement the adapter**

Deliberately boring: validate the incoming bundle, construct a **new** object
with the security fields set from trusted constants, call the real
`LOADER.load()`, return its stub. Do not mutate the package's object in place,
and do not export this adapter outside the Code Mode executor factory.

```ts
// apps/worker/src/codemode/guarded-loader.ts  (shape, not the whole file)
export function guardLoader(real: WorkerLoader, limits: CodeModeLimits): WorkerLoader {
  return {
    load(code: WorkerLoaderWorkerCode): WorkerStub {
      assertOnlyExpectedModules(code.modules);
      assertEmptyEnv(code.env);
      return real.load({
        ...code,
        compatibilityDate: PROJECT_COMPAT_DATE,        // never the package's
        compatibilityFlags: PROJECT_COMPAT_FLAGS,
        globalOutbound: null,                          // forced, not defaulted
        env: undefined,
        limits: { cpuMs: limits.cpuMs, subRequests: limits.subRequests },
      });
    },
    get(): never {
      throw new Error(
        "codemode never uses get(): it is cached by name and would run stale model code",
      );
    },
  };
}
```

- [ ] **Step 4: Run, typecheck, commit**

```bash
cd apps/worker
pnpm vitest run test/codemode-guarded-loader.test.ts
pnpm typecheck
git add src/codemode/guarded-loader.ts test/codemode-guarded-loader.test.ts
git commit -m "feat(codemode): force isolation on every dynamic worker load"
```

---

## Task 4b: Bound the executor in wall clock, output and logs

**Files:** Create `src/codemode/executor.ts`, `test/codemode-executor.test.ts`

**Consumes:** Task 4a `guardLoader`, Task 2 limits/errors, the installed
`Executor` declarations

**Produces:** a single fail-closed execution path that always terminates

**Interfaces:**

- Produces: `makeGuardedExecutor(loader: WorkerLoader, limits: CodeModeLimits, clock: () => number): Executor`
  — implements the package's `Executor` interface
  (`execute(code, providers, options?) => Promise<ExecuteResult>`), and **never
  throws across it**; failures come back as `ExecuteResult.error`.

> **The package's timeout cannot bound a runaway loop.** `DynamicWorkerExecutor`
> compiles its `timeout` *into the sandbox module* as a `Promise.race` against
> `setTimeout`. `while (true) {}` never yields, so that timer never fires and the
> host `await` hangs. Deployed, only `limits.cpuMs` stops it; the Phase 00 spike
> proved `limits.cpuMs` does not fire under `wrangler dev` at all. So this task
> adds the parent-side race that `inspired-from-ronit.md` §6 describes. **Three
> mechanisms, none of which substitutes for another** (invariant 21).

- [ ] **Step 1: Write the failing parent-side timeout test**

```ts
// apps/worker/test/codemode-executor.test.ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { guardLoader } from "../src/codemode/guarded-loader";
import { makeGuardedExecutor } from "../src/codemode/executor";
import { TEST_LIMITS } from "./helpers/codemode";

const executor = (patch: Partial<typeof TEST_LIMITS> = {}) =>
  makeGuardedExecutor(
    guardLoader(env.LOADER, { ...TEST_LIMITS, ...patch }),
    { ...TEST_LIMITS, ...patch },
    () => Date.now(),
  );

describe("wall-clock bounding", () => {
  it("returns a fast result well inside the budget", async () => {
    const out = await executor().execute("async () => 41 + 1", []);
    expect(out.error).toBeUndefined();
    expect(out.result).toBe(42);
  });

  it("times out a sandbox that sleeps past the budget", async () => {
    const started = Date.now();
    const out = await executor({ wallTimeMs: 300 }).execute(
      "async () => { await new Promise(r => setTimeout(r, 5000)); return 'late'; }", [],
    );
    expect(out.error).toMatch(/execution_timeout/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("times out when a host capability never resolves", async () => {
    const out = await executor({ wallTimeMs: 300 }).execute(
      "async () => { await slack.thread({}); return 'never'; }",
      [{ name: "slack", fns: { thread: () => new Promise(() => {}) } }],
    );
    expect(out.error).toMatch(/execution_timeout/);
  });

  // The case the package's in-sandbox timer cannot catch: no yield, no timer.
  it("bounds a CPU-bound loop that never yields", async () => {
    const started = Date.now();
    const out = await executor({ wallTimeMs: 500 }).execute(
      "async () => { while (true) {} }", [],
    );
    expect(out.error).toMatch(/execution_timeout|execution_cpu_limit/);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("does not surface the losing race as an unhandled rejection", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent) => { seen.push(e.reason); e.preventDefault(); };
    addEventListener("unhandledrejection", onUnhandled as EventListener);
    await executor({ wallTimeMs: 200 }).execute(
      "async () => { await new Promise(r => setTimeout(r, 2000)); return 1; }", [],
    );
    await new Promise((r) => setTimeout(r, 400));
    removeEventListener("unhandledrejection", onUnhandled as EventListener);
    expect(seen).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/codemode-executor.test.ts`
Expected: FAIL — `Cannot find module '../src/codemode/executor'`. The
CPU-bound case is the one to watch: if it *hangs* rather than failing, that
confirms exactly why this task exists.

- [ ] **Step 3: Implement the wrapper with the parent-side race**

```ts
// apps/worker/src/codemode/executor.ts  (the load-bearing part)
const inner = new DynamicWorkerExecutor({
  loader: guardedLoader,        // Task 4a — already forces isolation + limits
  globalOutbound: null,         // explicit, even though it is the default
  timeout: limits.wallTimeMs,   // in-sandbox guard: catches awaited hangs
});

// Parent-side guard: the ONLY thing that bounds a non-yielding program.
const timeout = new Promise<never>((_, reject) =>
  setTimeout(() => reject(new CapabilityError("execution_timeout",
    `exceeded ${limits.wallTimeMs}ms`)), limits.wallTimeMs));
timeout.catch(() => {});        // swallow the late rejection when we win
return Promise.race([inner.execute(code, providers, options), timeout]);
```

Do **not** pass `bindings` or `modules`, and do not pass a controlled outbound
`Fetcher`, in this phase. Around that core the wrapper also:

- measures duration with the injected clock;
- maps timeout/CPU/resource errors to stable `CapabilityErrorCode`s;
- caps and marks console output and the final result (Steps 4–5);
- returns an `ExecuteResult` and never throws across the `Executor` interface;
- lets the SDK dispose stubs — do not retain them.

- [ ] **Step 4: Write the failing result-cap test**

```ts
describe("result bounding", () => {
  it("preserves a small structured result exactly", async () => {
    const out = await executor().execute(
      "async () => ({ ok: true, items: ['a','b'], n: 3 })", []);
    expect(out.result).toEqual({ ok: true, items: ["a", "b"], n: 3 });
  });

  it("returns a marked preview for an oversized string", async () => {
    const out = await executor({ maxResultChars: 200 }).execute(
      "async () => 'x'.repeat(50000)", []);
    expect(String(out.result)).toContain("TRUNCATED");
    expect(String(out.result).length).toBeLessThan(2000);
  });

  it("returns a marked preview for an oversized object", async () => {
    const out = await executor({ maxResultChars: 200 }).execute(
      "async () => Array.from({length: 5000}, (_, i) => ({ i, pad: 'y'.repeat(50) }))", []);
    expect(String(out.result)).toContain("TRUNCATED");
  });

  it.each([
    ["a cycle", "async () => { const a = {}; a.self = a; return a; }"],
    ["a bigint", "async () => 1n"],
    ["a function", "async () => (() => 1)"],
  ])("turns %s into a readable error, not a crash", async (_label, code) => {
    const out = await executor().execute(code, []);
    expect(out.error).toMatch(/invalid_input|output_too_large/);
  });

  it("refuses a binary final result — files.publish is the only binary path", async () => {
    const out = await executor().execute("async () => new Uint8Array([1,2,3])", []);
    expect(out.error).toMatch(/invalid_input/);
  });
});
```

- [ ] **Step 5: Write the failing log-cap test**

Note what is **not** true here: console output does not travel through `tails`,
so the Phase 00 spike's ~200KB silent-tail ceiling does not apply. The executor
overrides `console.log/warn/error` in-sandbox and returns `__logs` in the RPC
value. Two consequences the tests must encode:

```ts
describe("log bounding", () => {
  it("captures log, warn and error with their level", async () => {
    const out = await executor().execute(
      "async () => { console.log('a'); console.warn('b'); console.error('c'); return 1; }", []);
    expect(out.logs?.join("\n")).toMatch(/a[\s\S]*\[warn\] b[\s\S]*\[error\] c/);
  });

  it("caps many lines and marks the truncation deterministically", async () => {
    const out = await executor({ maxConsoleChars: 500 }).execute(
      "async () => { for (let i = 0; i < 5000; i++) console.log('line ' + i); return 'done'; }", []);
    expect(out.result).toBe("done");
    expect(out.logs!.join("\n").length).toBeLessThan(2000);
    expect(out.logs!.join("\n")).toContain("TRUNCATED");
  });

  it("does not let one enormous line bypass the byte cap", async () => {
    const out = await executor({ maxConsoleChars: 500 }).execute(
      "async () => { console.log('z'.repeat(200000)); return 'done'; }", []);
    expect(out.logs!.join("\n").length).toBeLessThan(2000);
  });

  it("preserves bounded logs even when the run times out", async () => {
    const out = await executor({ wallTimeMs: 300 }).execute(
      "async () => { console.log('before'); await new Promise(r => setTimeout(r, 5000)); }", []);
    expect(out.error).toMatch(/execution_timeout/);
    // Logs may be absent when the parent race wins — assert we never invent them.
    if (out.logs?.length) expect(out.logs.join("\n")).toContain("before");
  });
});
```

> **A host-side cap cannot prevent an oversized RPC response**, because the log
> array is built inside the sandbox and crosses the boundary before our wrapper
> sees it. Record that limitation in `phase-09-notes.md`; do not claim the cap is
> a memory bound. It is a context-window bound.

- [ ] **Step 6: Document the CPU-limit split honestly**

Three different claims, three different places, and they must not be conflated:

| Claim                                    | Proved by                             |
| ---------------------------------------- | ------------------------------------- |
| the bundle carries `limits.cpuMs`        | Task 4a's limits test (unit)          |
| a runaway program always terminates      | Step 1's CPU-bound case (parent race) |
| workerd itself kills a CPU burn          | **Task 14 Step 7, deployed only**     |

`limits.cpuMs` does not fire under `wrangler dev`, so a local pass proves
nothing about it. Never weaken the production CPU limit to make local behaviour
match, and never let the parent race's success be reported as evidence that
`cpuMs` works.

- [ ] **Step 7: Run and commit**

```bash
cd apps/worker
pnpm vitest run test/codemode-executor.test.ts
pnpm typecheck
git add src/codemode/executor.ts test/codemode-executor.test.ts
git commit -m "feat(codemode): bound dynamic execution in time and output"
```

---

## Task 5: Create the provider registry and generated declarations

**Files:** Create `src/codemode/registry.ts`, `src/codemode/dts.ts`,
`src/codemode/generated/capabilities.d.ts`,
`scripts/generate-codemode-dts.ts`, `test/codemode-dts.test.ts`; add package
scripts

**Consumes:** Task 2 provider helper and the installed
`@cloudflare/codemode/ai` declarations

**Produces:** one deterministic contract source for runtime validation and
model context

**Interfaces:**

- Produces:
  - `defineCapability(spec): ToolDescriptor` (`src/codemode/registry.ts`) — the
    single place input validation is attached (invariant 19).
  - `buildRegistry(scope, deps, limits, audit): CapabilityRegistry` — an ordered
    `{ name, tools }[]`.
  - `renderCapabilityDeclarations(registry): string` (`src/codemode/dts.ts`).

- [ ] **Step 1: Write the failing registry-shape test**

Freeze the Phase 09 namespace order:

```text
slack · memory · linear · supabase · langsmith · betterstack · files
```

```ts
// apps/worker/test/codemode-dts.test.ts
import { sanitizeToolName } from "@cloudflare/codemode";
import { describe, expect, it } from "vitest";
import { buildRegistry } from "../src/codemode/registry";
import { fakeDeps, slackScope, TEST_LIMITS, fakeAuditSink } from "./helpers/codemode";

const registry = () => buildRegistry(slackScope, fakeDeps(), TEST_LIMITS, fakeAuditSink());
const toPascal = (s: string) =>
  s.replace(/_([a-z])/g, (_, c) => c.toUpperCase()).replace(/^[a-z]/, (c) => c.toUpperCase());

describe("capability registry", () => {
  it("exposes exactly the Phase 09 namespaces, in order", () => {
    expect(registry().map((p) => p.name)).toEqual([
      "slack", "memory", "linear", "supabase", "langsmith", "betterstack", "files",
    ]);
  });

  it("uses namespaces that are valid identifiers and not reserved", () => {
    // RESERVED_NAMES in the package covers __dispatchers, console, Promise, ...
    const reserved = new Set(["__dispatchers", "__connectors", "__logs", "console",
                              "Promise", "setTimeout", "Error", "WorkerEntrypoint",
                              "CodeExecutor", "codemode"]);
    for (const p of registry()) {
      expect(p.name).toMatch(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/);
      expect(reserved.has(p.name)).toBe(false);
    }
  });

  // Invariant 20. generateTypes derives `type XInput` from the METHOD name with
  // no namespace prefix, so two `search`es would emit two `type SearchInput`
  // and the joined .d.ts would not compile. Assert on the DERIVED name: both
  // `search_messages` and `searchMessages` collapse to `SearchMessages`.
  it("has globally unique method names after PascalCase derivation", () => {
    const derived = new Map<string, string>();
    for (const p of registry()) {
      for (const method of Object.keys(p.tools)) {
        const typeName = toPascal(sanitizeToolName(method));
        const existing = derived.get(typeName);
        expect(existing, `${p.name}.${method} collides with ${existing}`).toBeUndefined();
        derived.set(typeName, `${p.name}.${method}`);
      }
    }
  });

  it("gives every tool a description, a strict input and a bounded output", () => {
    for (const p of registry()) {
      for (const [method, tool] of Object.entries(p.tools)) {
        const label = `${p.name}.${method}`;
        expect(tool.description, label).toBeTruthy();
        expect(tool.inputSchema, label).toBeDefined();
        // An absent outputSchema makes the generated return type `unknown`.
        expect(tool.outputSchema, `${label} needs an outputSchema`).toBeDefined();
        expect(typeof tool.execute, label).toBe("function");
      }
    }
  });

  // resolveProvider silently DROPS tools carrying needsApproval. Approval is a
  // model decision here (Phase 11), never a tool annotation — assert loudly
  // rather than let a future annotation vanish without a trace.
  it("carries no approval annotations", () => {
    for (const p of registry()) {
      for (const [method, tool] of Object.entries(p.tools)) {
        expect(tool, `${p.name}.${method}`).not.toHaveProperty("needsApproval");
        expect(tool, `${p.name}.${method}`).not.toHaveProperty("requiresApproval");
      }
    }
  });

  it("builds the same namespace set regardless of run context", () => {
    const chat = buildRegistry(
      { ...slackScope, origin: "chat", slackThread: null, customerSlug: null },
      fakeDeps(), TEST_LIMITS, fakeAuditSink(),
    );
    expect(chat.map((p) => p.name)).toEqual(registry().map((p) => p.name));
  });
});
```

The registry must not select providers from a ticket type — there is no ticket
type. It may omit a capability only when its trusted deployment dependency is
explicitly disabled, and that difference must also change the generated
declaration artifact.

- [ ] **Step 2: Write the failing validation-ownership test**

This is the test that makes invariant 19 real. It calls through the **resolved
function**, which is the exact path the sandbox proxy takes.

```ts
import { resolveProvider } from "@cloudflare/codemode/ai";
import { resolveProvider as bareResolveProvider } from "@cloudflare/codemode";

describe("input validation is ours, not inherited", () => {
  const slack = () => registry().find((p) => p.name === "slack")!;

  // The trap: two exported resolveProviders, only one validates, and `runCode`
  // lives in the entry that exports the NON-validating one. Our helper must
  // make the boundary hold either way.
  it.each([
    ["the /ai resolver", resolveProvider],
    ["the non-validating resolver", bareResolveProvider],
  ])("rejects an unknown field through %s", async (_label, resolve) => {
    const fns = resolve({ name: "slack", tools: slack().tools }).fns;
    await expect(fns.reply({ text: "hi", channel: "C_OTHER" }))
      .rejects.toThrow(/invalid_input|unrecognized|unknown/i);
  });

  it.each([
    ["the /ai resolver", resolveProvider],
    ["the non-validating resolver", bareResolveProvider],
  ])("rejects a wrong-typed field through %s", async (_label, resolve) => {
    const fns = resolve({ name: "slack", tools: slack().tools }).fns;
    await expect(fns.reply({ text: 42 })).rejects.toThrow(/invalid_input/i);
  });

  // A zero-arg call arrives as execute(undefined) because ToolDispatcher
  // spreads an empty args array. `.default({})` is what makes this work.
  it("accepts a zero-argument call on methods declared callable that way", async () => {
    const fns = resolveProvider({ name: "slack", tools: slack().tools }).fns;
    await expect(fns.thread()).resolves.toBeInstanceOf(Array);

    const bs = registry().find((p) => p.name === "betterstack")!;
    const bsFns = resolveProvider({ name: "betterstack", tools: bs.tools }).fns;
    await expect(bsFns.monitors()).resolves.toBeInstanceOf(Array);
  });
});
```

- [ ] **Step 3: Build the provider-definition helper**

`defineCapability()` makes schema, description, execute function, audit wrapper
and optional effect wrapper reviewable in one place — **and validates the input
itself**, inside the `execute` it builds:

```ts
export function defineCapability<I, O>(spec: {
  description: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  run: (input: I) => Promise<O>;
}): ToolDescriptor {
  return {
    description: spec.description,
    inputSchema: spec.input,
    outputSchema: spec.output,
    // Our own parse. Correctness must not depend on which resolveProvider
    // some later import line happened to pick.
    execute: async (raw: unknown) => {
      const parsed = spec.input.safeParse(raw);
      if (!parsed.success) {
        throw new CapabilityError("invalid_input", formatZodIssues(parsed.error));
      }
      return spec.run(parsed.data);
    },
  };
}
```

Preserve the exact `ToolDescriptor` shape the installed version expects — no
`any`, no double casts. Provider dependencies are constructor arguments; never
import the global Worker `env` from inside a binding file.

- [ ] **Step 4: Generate declarations with the official generator**

For each provider call `generateTypes(provider.tools, provider.name)` and join
in registry order. Prefix a generated-file warning and the package version used.
Do not parse TypeScript or hand-build signatures — Step 1's uniqueness test is
what keeps the naive join valid.

```ts
it("renders one declaration block per namespace with no duplicate type alias", () => {
  const dts = renderCapabilityDeclarations(registry());
  for (const ns of ["slack", "memory", "linear", "supabase",
                    "langsmith", "betterstack", "files"]) {
    expect(dts).toContain(`declare const ${ns}: {`);
  }
  const aliases = [...dts.matchAll(/^type (\w+) =/gm)].map((m) => m[1]);
  expect(new Set(aliases).size).toBe(aliases.length);
});

it("never advertises a target, actor or credential argument", () => {
  const dts = renderCapabilityDeclarations(registry());
  for (const banned of ["channelId", "threadTs", "actor", "token", "apiKey",
                        "teamId", "workspace", "baseUrl", "sql"]) {
    expect(dts).not.toMatch(new RegExp(`\\b${banned}\\b`, "i"));
  }
});
```

The tool description and the committed `.d.ts` call the same render function.
The file exists for review and drift detection, not as a separate source.

- [ ] **Step 5: Add write and check scripts**

Expected package scripts:

```json
{
  "codemode:dts": "tsx scripts/generate-codemode-dts.ts --write",
  "codemode:dts:check": "tsx scripts/generate-codemode-dts.ts --check"
}
```

`--check` renders in memory and exits non-zero on a diff. It does not rewrite
the worktree during CI.

- [ ] **Step 6: Typecheck a representative model program**

A fixture compiled against the generated declarations. It is checked by
`pnpm typecheck`, so it is also the thing that catches a duplicate type alias
if Step 1's uniqueness test were ever deleted.

```ts
// apps/worker/test/fixtures/capabilities-fixture.ts
/// <reference path="../../src/codemode/generated/capabilities.d.ts" />

// Every namespace, at least one return field each — this must compile.
export async function representativeProgram() {
  const thread = await slack.thread({ limit: 20 });
  const hits = await slack.searchMessages({ query: "timeout", limit: 5 });
  const facts = await memory.recall({ query: "billing", scope: "customer" });
  const cites = await memory.cite({ factIds: facts.map((f) => f.factId) });
  const rows = await supabase.select({ resource: "invoices", limit: 10 });
  const traces = await langsmith.searchTraces({ limit: 3 });
  const logs = await betterstack.logs({ query: "level:error", since: "2026-08-11T00:00:00Z" });
  const monitors = await betterstack.monitors({});
  return {
    first: thread[0]?.text ?? null,
    hitCount: hits.length,
    citations: cites.length,
    rowCount: rows.length,
    traceId: traces[0]?.traceId ?? null,
    logLine: logs[0]?.message ?? null,
    monitorCount: monitors.length,
  };
}

// The model must not be able to express these. Each @ts-expect-error FAILS the
// build if the declaration ever starts allowing it.
export async function forbidden() {
  // @ts-expect-error — targeting another channel is not expressible
  await slack.reply({ text: "hi", channel: "C_OTHER" });
  // @ts-expect-error — acting as another user is not expressible
  await slack.reply({ text: "hi", actor: "U_SOMEONE" });
  // @ts-expect-error — the Linear team is pinned server-side
  await linear.createIssue({ title: "t", description: "d", teamId: "T_OTHER" });
  // @ts-expect-error — no arbitrary SQL
  await supabase.select({ resource: "invoices", sql: "DROP TABLE users" });
  // @ts-expect-error — no host or project selection
  await langsmith.searchTraces({ baseUrl: "https://evil.example" });
  // @ts-expect-error — misspelled method
  await slack.serch({ query: "x" });
  // @ts-expect-error — out-of-range enum
  await memory.recall({ query: "q", scope: "everything" });
  // @ts-expect-error — there is no memory write capability in Phase 09
  await memory.remember({ fact: "invented" });
}
```

Runtime Zod tests remain required. Model-visible types are guidance to the
model, **not** a security boundary — the sandbox executes JavaScript and nothing
stops it calling a method the types forbid. Step 2 is the boundary; this is the
signpost.

- [ ] **Step 7: Run and commit**

```bash
cd apps/worker
pnpm codemode:dts
pnpm codemode:dts:check
pnpm vitest run test/codemode-dts.test.ts
pnpm typecheck
git add package.json src/codemode/registry.ts src/codemode/dts.ts \
  src/codemode/generated/capabilities.d.ts \
  scripts/generate-codemode-dts.ts test/codemode-dts.test.ts
git commit -m "feat(codemode): generate typed capability surface"
```

---

## Task 6: Add the Slack binding

**Files:** Create `src/codemode/bindings/slack.ts`,
`src/slack/messages.ts`, `src/slack/gateway.ts`,
`test/codemode-slack.test.ts`; regenerate declarations

**Consumes:** Phase 03 channel policy, D1 messages from Phase 04, Task 2 trusted
scope, Task 3 effect ledger

**Produces:** current-thread reads/search and policy-enforced replies

- [ ] **Step 1: Write failing read tests**

For `slack.thread()` prove:

- Slack context is required;
- the query returns the root plus replies in timestamp order;
- only the current channel and root timestamp are read;
- the limit is clamped and pagination is deterministic;
- an empty thread returns `[]`;
- stored permalinks, authors, timestamps, and message text are normalized;
- no Slack token or raw D1 row is returned.

Read the D1 system of record instead of calling Slack history again. This uses
the data the assignment requires us to ingest and avoids asking for another
Slack scope.

- [ ] **Step 2: Write failing scoped-search tests**

`slack.searchMessages({ query, limit })` uses parameterized D1 queries. For a Slack run,
scope automatically to the current customer slug. For an internal Chat run,
use the host-selected chat scope. The model cannot pass a customer slug,
channel ID, raw SQL fragment, order expression, or wildcard-only query.

If LIKE is too slow on the measured message volume, add an FTS migration in a
separate reviewed task; do not concatenate SQL to gain flexibility.

- [ ] **Step 3: Write the complete write-policy matrix first**

`slack.reply({ text })` must refuse:

| Context                                | Result                                             |
| -------------------------------------- | -------------------------------------------------- |
| unknown channel                        | `channel_read_only`                                |
| `observe` customer channel             | `channel_read_only`                                |
| `internal` channel                     | `channel_read_only` for this customer-reply method |
| shadow run                             | `shadow_write_denied`                              |
| Chat run without attached Slack target | `slack_context_required`                           |
| no resolved on-duty actor/token        | `identity_unavailable`                             |
| known `live` Slack thread + actor      | send through the user-identity gateway             |

No branch may fall back to `SLACK_BOT_TOKEN`. The bot token is for ingestion,
permalinks, and later nudges, not customer speech.

Reuse the shipped policy code rather than re-deriving the rule:
`getChannelPolicy(db, channelId)` and `canPost(policy)` in `src/db/channels.ts`.
`canPost` is already `policy.known && policy.mode === "live"`, which is exactly
the first three rows of this matrix. An unmapped channel resolves to
`mode: "observe", known: false`, so the fail-closed default is inherited, not
reimplemented.

**The shadow check reads D1, not the descriptor.** `RunState` has no `shadow`
field — it is `RunRecord.shadow` from `getRunById(db, runId)`. A check written
against the descriptor reads `undefined`, which is falsy, and the run posts.
Add a test that constructs a shadow run and asserts `shadow_write_denied`, so
this cannot regress into a fail-open.

- [ ] **Step 4: Prove target and actor are unspoofable**

Strict schema tests reject `channel`, `channelId`, `thread_ts`, `threadTs`,
`user`, `actor`, `token`, and unknown fields. Calling the underlying function
with extra JavaScript properties must still fail runtime validation.

The gateway method receives actor and target from `CodeModeScope`, then
re-fetches channel policy immediately before sending to avoid stale policy.

- [ ] **Step 5: Add retry-aware sending**

Use Task 3's effect key as Slack's verified idempotency/client message ID if the
live Slack API supports it. Otherwise implement the documented reconciliation
path. Store only Slack message timestamp and permalink as the safe result.

A timeout after an ambiguous upstream response returns `effect_in_doubt`; it
does not send again.

- [ ] **Step 6: Keep Phase 12's seam honest**

Define `SlackGateway` so Phase 12 supplies the encrypted per-engineer token at
the last trusted moment. Phase 09 unit tests use a fake gateway. Until Phase 12
is implemented, a real reply returns `identity_unavailable`; do not wire the
bot as a temporary production substitute.

- [ ] **Step 7: Regenerate, run, and commit**

```bash
cd apps/worker
pnpm codemode:dts
pnpm vitest run test/codemode-slack.test.ts test/codemode-dts.test.ts
pnpm typecheck
git add src/codemode/bindings/slack.ts src/slack/messages.ts \
  src/slack/gateway.ts src/codemode/generated/capabilities.d.ts \
  test/codemode-slack.test.ts
git commit -m "feat(codemode): add policy-bound slack capability"
```

---

## Task 7: Add the memory binding with exact citations

**Files:** Create `src/codemode/bindings/memory.ts`,
`test/codemode-memory.test.ts`; reuse `src/memory/store.ts`,
`src/memory/graphs.ts`, and `src/memory/cite.ts`; regenerate declarations

**Consumes:** Phase 06 `MemoryStore` and exact D1 citation resolution

**Produces:** scoped recall plus non-fabricated Slack citations

- [ ] **Step 1: Write failing graph-scope tests**

Prove:

- customer recall derives `customer:{customerSlug}` from trusted scope;
- it never accepts a graph ID or customer slug from the model;
- customer recall without a customer returns `customer_scope_required`;
- org recall uses only the literal `org` graph;
- limits are clamped and blank/oversized queries fail;
- Zep failure becomes a safe retryable error.

- [ ] **Step 2: Add an execution-local fact cache**

`recall()` stores the returned `MemoryFact` objects in a Map owned by this one
provider instance and returns safe fact IDs/text. `cite({ factIds })` resolves
only IDs already returned by `recall()` in this execution, then calls the
existing D1 citation resolver with the trusted fact objects.

This prevents model code from inventing episode UUIDs or permalinks. The cache
is request-local and contains no cross-run state.

- [ ] **Step 3: Write citation integrity tests**

Cover:

- one real fact to one stored permalink;
- several requested facts preserving request order;
- duplicate IDs deduplicated deterministically;
- unknown ID rejected or omitted with an explicit miss — never fabricated;
- missing D1 episode/permalink produces no citation;
- citation text comes from the recalled fact, not model input;
- customer facts never cross into another customer's graph.

- [ ] **Step 4: Deliberately omit `remember()`**

Assert the generated declarations have no memory-write method. Ingest already
writes customer messages; Phase 10 records agent runs, drafts, and outcomes.
Allowing arbitrary inferred facts into durable memory would weaken the system
of record and is unnecessary for the assignment.

- [ ] **Step 5: Regenerate, run, and commit**

```bash
cd apps/worker
pnpm codemode:dts
pnpm vitest run test/codemode-memory.test.ts test/codemode-dts.test.ts
pnpm typecheck
git add src/codemode/bindings/memory.ts \
  src/codemode/generated/capabilities.d.ts test/codemode-memory.test.ts
git commit -m "feat(codemode): add cited memory capability"
```

---

## Task 8: Add the pinned-team Linear binding

**Files:** Create `src/codemode/bindings/linear.ts`,
`src/linear/client.ts`, `test/codemode-linear.test.ts`; modify trusted secret
types and test bindings as needed; regenerate declarations

**Consumes:** Task 0 verified Linear API, Task 3 effects

**Produces:** large-feature issue create/update without team spoofing

- [ ] **Step 1: Verify and freeze server-owned configuration**

Resolve the actual team ID for `fire-fighter-testing` once at deploy/setup
time. Keep the human-readable team name in code/config for review and the
opaque ID in a trusted Worker variable or secret as appropriate. Neither is a
model argument.

Pin the Linear API origin in the client. Do not accept an endpoint, workspace,
team, or API key in any public method.

- [ ] **Step 2: Write failing `createIssue` schema tests**

Require title, description, and all three assessment axes plus evidence. Clamp
all lengths and labels. Reject team/workspace/project/customer/token/URL
fields, unknown assessment values, empty evidence, and an issue description
too large for Linear.

The host client renders a stable assessment section so the fire drill cannot
produce an issue that technically exists but omits value, blocking, or
customer weight.

- [ ] **Step 3: Write fixed-team request tests**

Mock the verified transport and assert the exact outgoing create operation
always contains the pinned team. Change every model argument and prove the team
does not change. Normalize the response to `{ id, identifier, url }` only.

- [ ] **Step 4: Write `updateIssue` authorization tests**

Before mutation, fetch the issue and prove it belongs to the pinned team.
Reject an issue in any other team with `linear_team_denied`. Allow only the
reviewed mutable fields and valid states resolved within that team.

- [ ] **Step 5: Add effect and ambiguity behavior**

Use the verified Linear idempotency facility if one exists. If it does not,
reserve through Task 3 and implement a safe reconciliation query using a
host-owned marker in the issue description or metadata. A create that might
have succeeded must not be repeated until reconciled.

No Linear method carries an AI SDK approval annotation. The model decides
whether to call `linear.createIssue` or, after Phase 11, to escalate a draft.

- [ ] **Step 6: Test safe upstream errors and rate limits**

Map auth, validation, rate-limit, unavailable, and malformed-response cases.
Return retry guidance without GraphQL documents, authorization headers, or raw
response bodies.

- [ ] **Step 7: Regenerate, run, and commit**

```bash
cd apps/worker
pnpm codemode:dts
pnpm vitest run test/codemode-linear.test.ts test/codemode-effects.test.ts \
  test/codemode-dts.test.ts
pnpm typecheck
git add src/codemode/bindings/linear.ts src/linear/client.ts \
  src/codemode/generated/capabilities.d.ts test/codemode-linear.test.ts
git commit -m "feat(codemode): add pinned-team linear capability"
```

---

## Task 9: Add the customer-scoped, read-only Supabase binding

**Files:** Create `src/codemode/bindings/supabase.ts`,
`src/supabase/reader.ts`, `test/codemode-supabase.test.ts`; regenerate
declarations

**Consumes:** Task 0's verified credential/API shape and real product schema

**Produces:** bounded production reads without arbitrary SQL or write methods

- [ ] **Step 1: Inventory the minimum real schema**

With the supplied read-only credential, identify the resources needed for the
four drill scenarios, their safe columns, the tenant/customer key, and any
sensitive columns that must never enter model context. Record this allowlist in
the Phase 09 notes.

Do not expose the whole schema merely because the credential can see it. If a
customer slug cannot yet be resolved to the product tenant key, fail customer
reads with `customer_scope_required` rather than running an unscoped query.

- [ ] **Step 2: Write failing schema discovery tests**

`supabase.schema()` returns only allowlisted resource/column metadata. It
never returns connection details, database roles, policies, hidden resources,
functions, or sensitive columns. An unknown resource returns a readable
validation error.

- [ ] **Step 3: Write failing select-builder tests**

Cover every allowed operator and reject:

- unknown resources or columns;
- raw SQL, select fragments, joins, functions, comments, semicolons, and URLs;
- writes or RPC calls;
- unbounded limits and offsets;
- arbitrary sort expressions;
- filters with unsupported value shapes;
- tenant filters that conflict with trusted customer scope.

Build the upstream request from allowlisted identifiers and encoded values;
never concatenate model input into SQL or a URL path.

- [ ] **Step 4: Enforce tenant scope server-side**

For customer-scoped runs, inject the trusted tenant predicate regardless of
model filters. For internal Chat runs, require an explicit trusted scope chosen
when the run is created; do not infer authorization from the question text.

Return at most the reviewed row/byte cap, include a truncation indicator, and
normalize dates/JSON to plain values.

- [ ] **Step 5: Prove the credential is read-only in a live negative test**

Against a dedicated harmless test target or transaction, attempt the verified
equivalents of insert, update, delete, DDL, and writable RPC. Each must be
rejected by the database role even if application validation were bypassed.
Never run this destructive probe against an unidentified production table.

- [ ] **Step 6: Prove fixed origin and credential absence**

Mock requests and assert a URL-like resource/filter cannot redirect the host
client. Enumerate every safe result key and assert the Supabase URL/key,
authorization headers, and client object are absent.

- [ ] **Step 7: Regenerate, run, and commit**

```bash
cd apps/worker
pnpm codemode:dts
pnpm vitest run test/codemode-supabase.test.ts test/codemode-dts.test.ts
pnpm typecheck
git add src/codemode/bindings/supabase.ts src/supabase/reader.ts \
  src/codemode/generated/capabilities.d.ts test/codemode-supabase.test.ts
git commit -m "feat(codemode): add scoped readonly supabase capability"
```

---

## Task 10: Add the fixed-project LangSmith binding

**Files:** Create `src/codemode/bindings/langsmith.ts`,
`src/langsmith/client.ts`, `test/codemode-langsmith.test.ts`; regenerate
declarations

**Consumes:** Task 0 verified LangSmith API and supplied read access

**Produces:** bounded trace lookup/search for “our AI did something weird”

- [ ] **Step 1: Pin the trusted boundary**

Fix the LangSmith API origin, workspace, and allowed project IDs in trusted
configuration. The model may supply a trace ID or query, never a URL, project,
workspace, tenant, or API key.

- [ ] **Step 2: Write failing trace normalization tests**

`trace({ traceId })` returns the minimum useful tree: stable IDs, names,
timestamps, status/error, model metadata, bounded inputs/outputs, and child
relationships. Remove headers, auth, SDK internals, raw attachments, and fields
outside the reviewed response contract.

> **Do not return a freely nested tree.** `JsonValue` bottoms out at four levels
> (`src/run/protocol.ts`), and this result has to survive
> `RunDO.appendToolCallUpdate({ output })`. Return a **flat node list plus
> `parentId` links** — `{ nodes: [{ id, parentId, name, status, ... }] }` — which
> is depth-2, reconstructible in model code, and cheaper to truncate. A nested
> shape fails `pnpm typecheck` and no test will catch it.

Cover a missing trace, malformed ID, deep child tree, huge prompt/output,
partial trace, and upstream rate limit. Depth, node count, and serialized bytes
must all have independent caps and visible truncation markers.

- [ ] **Step 3: Write failing search tests**

`searchTraces({ query, since, limit })` — named to keep method names globally
unique against `slack.searchMessages` (invariant 20). Validate ISO timestamps,
clamp limit and lookback, pin project filters, and normalize to compact
`TraceRef`s. A model query must never become an arbitrary filter expression or
host URL.

Where the API supports customer metadata, inject trusted customer scope rather
than accepting a customer selector. If the real traces do not contain reliable
customer metadata, document that limitation instead of pretending the filter
is secure.

- [ ] **Step 4: Verify against one known trace**

Use a trace selected for the trial, compare the normalized result with the
LangSmith UI, and record its latency and typical byte size without checking
customer content into fixtures. Keep live IDs out of the repo.

- [ ] **Step 5: Regenerate, run, and commit**

```bash
cd apps/worker
pnpm codemode:dts
pnpm vitest run test/codemode-langsmith.test.ts test/codemode-dts.test.ts
pnpm typecheck
git add src/codemode/bindings/langsmith.ts src/langsmith/client.ts \
  src/codemode/generated/capabilities.d.ts test/codemode-langsmith.test.ts
git commit -m "feat(codemode): add bounded langsmith capability"
```

---

## Task 11: Add the fixed-source Better Stack binding

**Files:** Create `src/codemode/bindings/betterstack.ts`,
`src/betterstack/client.ts`, `test/codemode-betterstack.test.ts`; regenerate
declarations

**Consumes:** Task 0 verified Better Stack logs/monitors API and supplied read
access

**Produces:** bounded production logs and uptime state without arbitrary API
access

- [ ] **Step 1: Pin sources and monitors**

Store the allowed log source IDs and monitor group/account scope in trusted
configuration. The model never supplies a source, account, endpoint, or token.

- [ ] **Step 2: Write failing time-window tests**

Require `since`, allow a bounded optional `until`, reject inverted/future/too-
wide windows, and clamp line count. Normalize all times to UTC. Define the
largest production window based on the real API cost and latency measured in
Task 0.

- [ ] **Step 3: Write failing log-query tests**

Allow the documented query language only as a query value to the fixed log
endpoint. Reject control characters, excessive boolean clauses, wildcard-only
queries, unsupported source selectors, and oversized input. Apply trusted
customer/run identifiers when reliable metadata exists.

Normalize each line to timestamp, level, service, message, and a small safe
metadata object. Redact authorization, cookies, tokens, emails, and known
secret fields in returned logs as defense in depth.

- [ ] **Step 4: Write monitor tests**

`monitors()` has an empty strict object input and returns only configured
monitors with status, last check, and safe public name. It cannot enumerate the
entire Better Stack account.

The input schema needs `.default({})`. A bare `monitors()` reaches the host as
`execute(undefined)` — `ToolDispatcher` spreads an empty args array — and a
plain `z.object({}).strict()` rejects that, so the model would be unable to call
a method its own declarations show. Verified: `.default({})` fixes the call and
still renders `type MonitorsInput = {}` rather than degrading to `unknown`.
Cover the bare call in a test.

- [ ] **Step 5: Test pagination and failure**

Bound total pages, stop on byte/call limits, surface partial results with a
marker, and translate auth/rate/unavailable/malformed cases without leaking
the response body or request headers.

- [ ] **Step 6: Regenerate, run, and commit**

```bash
cd apps/worker
pnpm codemode:dts
pnpm vitest run test/codemode-betterstack.test.ts test/codemode-dts.test.ts
pnpm typecheck
git add src/codemode/bindings/betterstack.ts src/betterstack/client.ts \
  src/codemode/generated/capabilities.d.ts test/codemode-betterstack.test.ts
git commit -m "feat(codemode): add bounded better stack capability"
```

---

## Task 12: Add the bounded files binding

**Files:** Create `src/codemode/bindings/files.ts`, `src/files/r2.ts`,
`test/codemode-files.test.ts`; modify `wrangler.jsonc`, generated Worker types,
and test bindings; regenerate declarations

**Consumes:** Task 3 effect ledger and Cloudflare R2 docs/schema

**Produces:** small, content-addressed artifacts without an arbitrary object
store handle

- [ ] **Step 1: Decide artifact exposure before provisioning**

Record the R2 bucket name, public/custom download origin, retention, and who
can fetch an object. Proof recordings eventually need a stable link in GitHub
and Slack, but customer/prod debug artifacts must not accidentally become
public. Prefer separate public-proof and private-debug prefixes or buckets if
one policy cannot serve both.

Do not put credentials in `vars`. R2 access from the Worker uses a binding, not
S3 REST keys.

- [ ] **Step 2: Write failing input tests**

Accept only `Uint8Array`, a safe filename, and allowlisted content types. Cap
Code Mode publication at a small reviewed size, for example 5 MiB. Reject path
separators, control characters, double extensions where policy cares,
executable content, empty bytes, mismatched declared size, and unknown fields.

Large Phase 19 videos should stream from the trusted sandbox/artifact path to
R2 outside a model-code RPC value; do not raise this cap to push a 100 MiB
recording through Code Mode.

- [ ] **Step 3: Add the R2 binding and regenerate platform types**

Use the installed Wrangler schema. Expected shape:

```jsonc
"r2_buckets": [
  { "binding": "ARTIFACTS", "bucket_name": "firefighter-artifacts" }
]
```

Use a non-secret public base URL config only if the chosen exposure model
needs it. Run `pnpm cf-typegen`; never hand-write `R2Bucket` in the Env type.

- [ ] **Step 4: Make publication deterministic and retry-safe**

Compute SHA-256 with Web Crypto and derive an unguessable/deterministic object
key from the effect key plus sanitized extension. Store explicit content type,
hash, run ID, and creation timestamp as safe metadata. A retry returns the same
object and URL; it does not create another object.

The model never chooses bucket, prefix, ACL, cache headers, public origin,
expiration policy, or object key.

- [ ] **Step 5: Write URL and credential tests**

Assert the returned object has only URL, size, and hash. It must not contain an
R2 binding, account ID, access key, bucket credentials, signed-request headers,
internal object prefix, or arbitrary redirect origin.

- [ ] **Step 6: Test binary RPC and caps in the real runtime**

The installed Code Mode codec does support `Uint8Array`/`ArrayBuffer` — verified,
via `__CODEMODE_BINARY_TAG` in the generated sandbox module. Test a small binary
round trip through the Dynamic Worker, not merely by calling the provider
directly. Test the exact maximum and one byte over it.

> **Measure before trusting the 5 MiB cap.** The codec base64-encodes bytes into
> a JSON string, so 5 MiB of payload crosses `ToolDispatcher` as roughly 6.7 MB
> of string, twice (encode host-side, decode sandbox-side). Time a round trip at
> the proposed cap and record it in `phase-09-notes.md`. If it is slow or hits an
> RPC size limit, **lower the cap** — do not widen it, and do not reach for a
> streaming workaround inside model code. Phase 19's large recordings already
> have a trusted non-Code-Mode path for exactly this reason.

- [ ] **Step 7: Regenerate, validate, and commit**

```bash
cd apps/worker
pnpm cf-typegen
pnpm codemode:dts
pnpm vitest run test/codemode-files.test.ts test/codemode-dts.test.ts
pnpm exec wrangler deploy --dry-run
pnpm typecheck
git add wrangler.jsonc worker-configuration.d.ts \
  src/codemode/bindings/files.ts src/files/r2.ts \
  src/codemode/generated/capabilities.d.ts test/codemode-files.test.ts
git commit -m "feat(codemode): add bounded r2 artifact capability"
```

---

## Task 13: Assemble the one `run_code` tool

**Files:** Create `src/codemode/tool.ts`,
`test/codemode-integration.test.ts`; finalize `src/codemode/registry.ts` and
generated declarations

**Consumes:** Tasks 4a–12

**Produces:** the only AI SDK tool Phase 10 may expose

- [ ] **Step 1: Write the exact-one-tool test first**

```ts
// apps/worker/test/codemode-integration.test.ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeRunCodeTool } from "../src/codemode/tool";
import { fakeDeps, slackScope, TEST_LIMITS, fakeAuditSink } from "./helpers/codemode";

const tool = () => makeRunCodeTool({
  scope: slackScope,
  deps: fakeDeps(),
  limits: TEST_LIMITS,
  audit: fakeAuditSink(),
  loader: env.LOADER,
});

describe("the tool surface Phase 10 receives", () => {
  it("is exactly one tool named run_code", () => {
    const tools = { run_code: tool() };
    expect(Object.keys(tools)).toEqual(["run_code"]);
  });

  it("does not expose any provider as a model tool", () => {
    const tools = { run_code: tool() };
    for (const ns of ["slack", "memory", "linear", "supabase",
                      "langsmith", "betterstack", "files"]) {
      expect(Object.keys(tools)).not.toContain(ns);
    }
  });

  it("accepts exactly { code: string } and no execution knobs", async () => {
    const schema = tool().inputSchema;
    await expect(schema.safeParseAsync({ code: "async () => 1" }))
      .resolves.toMatchObject({ success: true });
    for (const knob of ["ts", "timeout", "network", "bindings", "actor", "scope",
                        "globalOutbound", "limits"]) {
      const out = await schema.safeParseAsync({ code: "async () => 1", [knob]: 1 });
      expect(out.success, `${knob} must be rejected`).toBe(false);
    }
  });

  it("refuses oversized code before loading a Worker", async () => {
    const out = await tool().execute!(
      { code: `async () => { /* ${"x".repeat(TEST_LIMITS.maxCodeChars + 1)} */ }` },
      {} as never,
    );
    expect(JSON.stringify(out)).toMatch(/output_too_large|invalid_input/);
  });

  it("embeds the generated declarations in its description", () => {
    const description = tool().description ?? "";
    expect(description).toContain("declare const slack: {");
    expect(description).toContain("declare const files: {");
    expect(description).not.toContain("{{types}}");   // placeholder was replaced
  });
});
```

- [ ] **Step 2: Build the description from generated declarations**

Use a custom description containing `{{types}}` or the verified equivalent,
plus concise execution rules:

- write one async arrow function;
- use JavaScript syntax only despite TypeScript declarations;
- return the final compact result;
- use `console.log` only for useful progress;
- call namespaces directly and compose/filter results in code;
- catch only errors the code can genuinely recover from;
- do not probe hidden variables, network globals, or credentials;
- do not assume a capability absent from the declarations.

The description must say no approval policy. Phase 10's system prompt teaches
the model when to call Phase 11's explicit escalation capability.

- [ ] **Step 3: Resolve providers per invocation**

Construct the registry inside the tool factory from one validated
`CodeModeScope`, one dependency object, one limits constant, and one audit
sink.

**Import `resolveProvider` from `@cloudflare/codemode/ai`, not from
`@cloudflare/codemode`.** The index entry exports a same-named function that
does *not* validate input, and since `runCode` lives only in the index entry,
the natural single import line picks the wrong one. Task 5's helper already
validates independently (invariant 19), so this is defence in depth rather than
the boundary itself — but keep the import paths separate and commented, because
a future refactor that merges them would otherwise be invisible.

Do not cache resolved providers across turns or runs. Their closures contain
trusted scope and an execution-local fact cache/call counter.

- [ ] **Step 4: Call the official `runCode()` path through the guarded executor**

Keep one wrapper around the official function to enforce code length before
loading, normalize thrown errors, attach metrics/truncation, and emit the outer
execution audit. Do not evaluate code in the parent Worker with `eval`,
`Function`, Node `vm`, or an ad hoc parser.

- [ ] **Step 5: Chain at least four capabilities in one test execution**

Fake host gateways, but the **real** Dynamic Worker executor. This is the test
that proves Code Mode earns its place: five capability calls, one model turn.

```ts
it("chains five capabilities in one execution with no model round trip", async () => {
  const audit = fakeAuditSink();
  const deps = fakeDeps({
    slackThread: [
      { ts: "1.0", text: "checkout is timing out", author: "U_CUST", permalink: "https://s/1" },
      { ts: "2.0", text: "started around 09:00", author: "U_CUST", permalink: "https://s/2" },
    ],
    memoryFacts: [{ factId: "f1", fact: "acme uses the legacy checkout", episodeUuids: ["e1"] }],
    supabaseRows: [{ id: 1, status: "failed" }, { id: 2, status: "ok" }],
    logLines: [{ timestamp: "2026-08-11T09:01:00Z", level: "error", service: "checkout",
                 message: "upstream timeout" }],
  });

  const runCodeTool = makeRunCodeTool({
    scope: slackScope, deps, limits: TEST_LIMITS, audit, loader: env.LOADER,
  });

  const program = `async () => {
    const thread = await slack.thread({ limit: 20 });
    const facts  = await memory.recall({ query: "checkout", scope: "customer" });
    const cites  = await memory.cite({ factIds: facts.map(f => f.factId) });
    const rows   = await supabase.select({ resource: "orders", limit: 50 });
    const logs   = await betterstack.logs({ query: "level:error", since: "2026-08-11T00:00:00Z" });
    console.log("gathered", thread.length, rows.length, logs.length);
    // The whole point: join and filter HERE, not across model turns.
    const failed = rows.filter(r => r.status === "failed");
    return {
      messageCount: thread.length,
      failedOrders: failed.length,
      citation: cites[0]?.permalink ?? null,
      firstError: logs[0]?.message ?? null,
    };
  }`;

  const out = await runCodeTool.execute!({ code: program }, {} as never);

  expect(out.result).toEqual({
    messageCount: 2, failedOrders: 1,
    citation: "https://s/1", firstError: "upstream timeout",
  });
  expect(out.logs?.join(" ")).toContain("gathered 2 2 1");

  // Five nested capability calls, in program order, under ONE outer execution.
  const completed = audit.events.filter((e) => e.kind === "completed");
  expect(completed.map((e) => `${e.namespace}.${e.method}`)).toEqual([
    "slack.thread", "memory.recall", "memory.cite",
    "supabase.select", "betterstack.logs",
  ]);
  expect(completed.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);

  // No credential or binding reached the result or the audit trail.
  const serialized = JSON.stringify({ out, events: audit.events });
  for (const forbidden of ["xoxb-", "xoxp-", "Bearer ", "postgres://", "ZEP_API_KEY"]) {
    expect(serialized).not.toContain(forbidden);
  }
});
```

- [ ] **Step 6: Test normal agent mistakes**

Every error here has to be readable enough that the *next* model turn can fix
it. An opaque failure costs a whole round trip, which is the cost Code Mode
exists to avoid.

```ts
it.each([
  ["a syntax error",        "async () => { return ( }",                    /SyntaxError|Unexpected/],
  ["fenced code",           "```js\nasync () => 1\n```",                   /^(?!.*Unexpected).*$/],
  ["a bare expression",     "1 + 1",                                        /arrow function|not a function/i],
  ["a misspelled namespace","async () => await slak.thread({})",            /slak is not defined/],
  ["an unknown method",     "async () => await slack.nope({})",             /not found/i],
  ["invalid provider args", "async () => await slack.reply({ text: 42 })",  /invalid_input/],
  ["a refused write",       "async () => await slack.reply({ text: 'hi' })",/channel_read_only/],
  ["a non-serializable return", "async () => (() => 1)",                    /invalid_input/],
])("returns a correctable error for %s", async (_label, code, pattern) => {
  const out = await tool().execute!({ code }, {} as never);
  const text = out.error ?? JSON.stringify(out.result);
  expect(text).toMatch(pattern);
  expect(text.length).toBeLessThan(2000);      // an error, not a memory dump
  expect(text).not.toMatch(/at Object\.|node_modules|\/src\//);   // no stack paths
});
```

`normalizeCode()` in the package already strips fences and wraps a bare
expression — assert the *behaviour*, not the mechanism, so a package change
surfaces here rather than in production.

- [ ] **Step 7: Hand Phase 10 a narrow factory only**

Export `makeRunCodeTool`, `renderCapabilityDeclarations`, and a clearly named
test executor. Do not export raw gateways, secrets, the real `WorkerLoader`, or
an executor constructor that accepts `globalOutbound`.

- [ ] **Step 8: Run and commit**

```bash
cd apps/worker
pnpm codemode:dts:check
pnpm vitest run test/codemode-integration.test.ts \
  test/codemode-executor.test.ts test/codemode-dts.test.ts
pnpm typecheck
git add src/codemode/tool.ts src/codemode/registry.ts \
  src/codemode/generated/capabilities.d.ts \
  test/codemode-integration.test.ts
git commit -m "feat(codemode): expose one typed run-code tool"
```

---

## Task 14: Prove the security boundary adversarially

**Files:** Create `test/codemode-security.test.ts`; create a staging-only live
probe entry/route or script documented in `phase-09-notes.md`

**Consumes:** assembled production path from Task 13

**Produces:** executable evidence for the README security section

- [ ] **Step 1: Run outbound-refusal probes through the production path**

The claim is **refusal, not absence**. `fetch` and `WebSocket` remain defined
inside a correctly isolated isolate; they throw on invocation. A test written as
`typeof fetch === "undefined"` fails against a correctly-isolated isolate, and
the README must not claim absence either.

```ts
// apps/worker/test/codemode-security.test.ts
const escape = (expr: string) => `async () => {
  const defined = { fetch: typeof fetch, ws: typeof WebSocket };
  try { await (${expr}); return { outcome: "reached", defined }; }
  catch (err) { return { outcome: "refused", message: String(err.message), defined }; }
}`;

it.each([
  ["public https",      `fetch("https://example.com")`],
  ["parent origin",     `fetch("https://firefighter.workers.dev/api/health")`],
  ["bare IP",           `fetch("http://1.1.1.1/")`],
  ["plain http",        `fetch("http://workers.cloudflare.com/")`],
  ["websocket",         `(async () => new WebSocket("wss://example.com"))()`],
])("refuses outbound access via %s", async (_label, expr) => {
  const out = await tool().execute!({ code: escape(expr) }, {} as never);
  const r = out.result as { outcome: string; message?: string; defined: Record<string, string> };
  expect(r.outcome).toBe("refused");
  // The globals EXIST. That is the precise, defensible claim.
  expect(r.defined.fetch).toBe("function");
  expect(r.defined.ws).toBe("function");
  expect(r.message).toMatch(/not permitted to access the internet/i);
});
```

Record the verbatim runtime message in `phase-09-notes.md`; the README quotes it.

- [ ] **Step 2: Keep a causal control**

Without this, the section above is an observation. With it, it is a causal
claim: remove one field and the isolate reaches the open internet.

```ts
// Test-only. NEVER reachable from the deployed application.
it("CONTROL: omitting globalOutbound reaches the internet", async () => {
  const stub = env.LOADER.load({
    compatibilityDate: "2026-08-01",
    compatibilityFlags: ["nodejs_compat"],
    mainModule: "main.js",
    modules: { "main.js": `
      import { WorkerEntrypoint } from "cloudflare:workers";
      export default class extends WorkerEntrypoint {
        async probe() {
          try { const r = await fetch("https://example.com"); return "reached:" + r.status; }
          catch (err) { return "refused:" + err.message; }
        }
      }` },
    // globalOutbound deliberately omitted — this is the control.
  });
  const result = await (stub.getEntrypoint() as unknown as { probe(): Promise<string> }).probe();
  expect(result).toMatch(/^reached:/);
});

it("the production constructor cannot be configured this way", () => {
  // guardLoader forces null; there is no call site that can opt out.
  const { loader, calls } = fakeLoader();
  guardLoader(loader, TEST_LIMITS).load({ ...bundle(), globalOutbound: undefined });
  expect(calls[0].globalOutbound).toBeNull();
});
```

> If the control test is skipped in an offline CI environment, mark it
> `it.skipIf(!process.env.NETWORK_TESTS)` and **run it in the deployed smoke
> check instead** (Task 15 Step 3). A security claim with its control
> permanently skipped is not proved.

- [ ] **Step 3: Enumerate the loaded Worker environment**

```ts
it("exposes no credential, binding or host env to model code", async () => {
  const probe = `async () => {
    const names = ["DB","RUNS","LOADER","ARTIFACTS","INGEST_QUEUE","MEMORY_QUEUE",
      "TRIAGE_QUEUE","SLACK_BOT_TOKEN","SLACK_SIGNING_SECRET","ANTHROPIC_API_KEY",
      "ZEP_API_KEY","LINEAR_API_KEY","SUPABASE_URL","SUPABASE_KEY","env","ctx","props"];
    const found = [];
    for (const n of names) {
      const g = globalThis[n];
      if (g !== undefined) found.push(n + ":global");
      // A property read on an RPC stub returns a lazy thenable rather than
      // throwing, so a typeof check alone reports leaks that do not exist.
      // The await is what settles it — same rule as the Phase 00 probe.
      try { const v = await slack[n]; if (v !== undefined) found.push(n + ":rpc"); }
      catch { /* "does not implement the method" — the expected answer */ }
    }
    return { found, globalKeys: Object.keys(globalThis).length };
  }`;
  const out = await tool().execute!({ code: probe }, {} as never);
  expect((out.result as { found: string[] }).found).toEqual([]);
});

// Without this, a probe that silently checks nothing would also pass.
it("CONTROL: the probe can actually detect a leak", async () => {
  const leaky = makeRunCodeTool({
    scope: slackScope, deps: fakeDeps(), limits: TEST_LIMITS,
    audit: fakeAuditSink(), loader: env.LOADER,
    __testOnlyExtraCapability: { name: "leak", fns: { token: async () => "xoxb-secret" } },
  });
  const out = await leaky.execute!(
    { code: `async () => await leak.token()` }, {} as never);
  expect(out.result).toBe("xoxb-secret");
});
```

`__testOnlyExtraCapability` must be a test-only parameter that no production
call site passes. If wiring one feels too invasive, build the leaky registry
directly in the test instead — but do not drop the control. A probe that cannot
demonstrate a detection is not evidence of absence.

- [ ] **Step 4: Attack provider schemas and fixed policy**

Try to:

- send to another channel/thread or as another actor;
- post to unknown, observe, internal, and shadow contexts;
- create/update a Linear issue in another team;
- change API origins or source/project IDs with URL-shaped input;
- run Supabase writes, raw SQL, hidden resources, or conflicting tenant
  filters;
- publish to another R2 bucket/key or an executable content type;
- exceed call/result/log/row/page/file/code limits;
- access a fact citation not returned by this execution.

Every attempt must fail at a host validation/policy boundary, not only because
the prompt asked nicely.

> These cases are written **with their providers**, in Tasks 6–12, because each
> one needs that provider's real schema. Task 14 is where they are collected and
> run as one adversarial suite, not where they are invented. A case written here
> ahead of its provider would be asserting against a schema nobody has designed.

- [ ] **Step 5: Attack serialization**

Independent of the integration bindings, so it is written here in full.

```ts
it.each([
  ["a cycle",              "async () => { const a = {}; a.self = a; return a; }"],
  ["deep nesting",         "async () => { let v = 1; for (let i=0;i<200;i++) v = { v }; return v; }"],
  ["a huge array",         "async () => Array.from({length: 2_000_000}, (_, i) => i)"],
  ["a bigint",             "async () => 1n"],
  ["an Error",             "async () => new Error('boom')"],
  ["a Response",           "async () => new Response('x')"],
  ["a function",           "async () => (function f(){})"],
  ["a throwing accessor",  "async () => ({ get x() { throw new Error('nope'); } })"],
  ["a throwing toJSON",    "async () => ({ toJSON() { throw new Error('nope'); } })"],
  ["a binary result",      "async () => new Uint8Array([1,2,3])"],
  ["a lone surrogate",     "async () => '\\uD800'"],
])("fails safely on %s", async (_label, code) => {
  const out = await tool().execute!({ code }, {} as never);
  const text = out.error ?? JSON.stringify(out.result);
  expect(text).toMatch(/invalid_input|output_too_large|TRUNCATED/);
  expect(text.length).toBeLessThan(4000);
});

it("leaves no partial effect behind when serialization fails", async () => {
  const audit = fakeAuditSink();
  const deps = fakeDeps();
  await makeRunCodeTool({ scope: slackScope, deps, limits: TEST_LIMITS,
                          audit, loader: env.LOADER })
    .execute!({ code: `async () => { const a = {}; a.self = a; return a; }` }, {} as never);
  expect(deps.slackGateway.sent).toEqual([]);      // nothing was sent
  expect(audit.events.some((e) => e.kind === "completed")).toBe(false);
});

// Prototype pollution must not survive the boundary in either direction.
it("does not let a __proto__ key pollute the host realm", async () => {
  await tool().execute!(
    { code: `async () => JSON.parse('{"__proto__":{"pwned":true},"ok":1}')` },
    {} as never,
  );
  expect(({} as Record<string, unknown>).pwned).toBeUndefined();
});
```

- [ ] **Step 6: Test concurrency and retry attacks**

Interleave two runs with different identities/customers and run duplicate
effects concurrently. Assert scope isolation, one durable effect, and one
upstream call. Simulate a crash after upstream success but before D1 completion
and prove the retry returns `effect_in_doubt` or reconciles — never duplicates.

Task 3 already covers the ledger mechanics in isolation; what is new here is
running them **through the sandbox**, where the model controls call ordering.
Reuse Task 3's `runEffect` cases with the real executor driving them, and add
the two-identity isolation case from Task 2 Step 6 at the full-tool level.

- [ ] **Step 7: Run the timeout matrix**

Test:

| Program                               | Local                                        | Deployed staging      |
| ------------------------------------- | -------------------------------------------- | --------------------- |
| fast return                           | completes                                    | completes             |
| sleeping beyond wall timeout          | times out near budget                        | times out near budget |
| provider never resolves               | times out                                    | times out             |
| CPU loop beyond `cpuMs`               | local result documented as non-authoritative | runtime terminates it |
| many subrequests through capabilities | host call cap/refusal                        | same                  |

The parent wall-clock race is not proof that a CPU-bound child is killed. Keep
the deployed CPU assertion separately.

- [ ] **Step 8: Use a staging-only probe surface**

Do not add a permanent unauthenticated debug endpoint. Acceptable options:

- a separate smoke Worker config/entry deployed only for this test; or
- an Access-protected internal route compiled/registered only in a staging
  environment and absent from production.

Record the exact command, deployment URL, compatibility date, package version,
and summarized results. Do not record customer data or secret values.

- [ ] **Step 9: Commit the tests and evidence**

```bash
cd apps/worker
pnpm vitest run test/codemode-security.test.ts
pnpm typecheck
git add test/codemode-security.test.ts \
  docs/superpowers/plans/phase-09-notes.md
git commit -m "test(codemode): prove tier-one isolation boundary"
```

---

## Task 15: Full verification and handoff

**Files:** All Phase 09 files; update notes and roadmap only if verified facts
changed

- [ ] **Step 1: Run the focused suite**

```bash
cd apps/worker
pnpm vitest run \
  test/codemode-loader.test.ts \
  test/codemode-contracts.test.ts \
  test/codemode-effects.test.ts \
  test/codemode-guarded-loader.test.ts \
  test/codemode-executor.test.ts \
  test/codemode-dts.test.ts \
  test/codemode-slack.test.ts \
  test/codemode-memory.test.ts \
  test/codemode-linear.test.ts \
  test/codemode-supabase.test.ts \
  test/codemode-langsmith.test.ts \
  test/codemode-betterstack.test.ts \
  test/codemode-files.test.ts \
  test/codemode-security.test.ts \
  test/codemode-integration.test.ts
```

- [ ] **Step 2: Run whole-project checks**

```bash
cd apps/worker
pnpm codemode:dts:check
pnpm test
pnpm typecheck
pnpm exec wrangler deploy --dry-run
cd ../..
pnpm typecheck
pnpm build
git diff --check
```

- [ ] **Step 3: Repeat deployed smoke checks**

Run the staging network control, credential probe, four-capability chain,
wall-time timeout, CPU runaway, binary round trip, and one safe real read from
each configured read-only integration. Perform external writes only in the
designated test Slack channel, Linear testing team, and artifact test prefix.

- [ ] **Step 4: Inspect observability**

Confirm Worker logs/traces can correlate by run ID, turn ID, Code Mode
execution ID, and safe capability call ID. Confirm they contain no code body by
default, no customer payload beyond explicitly reviewed fields, and no secret.
Record wall/CPU duration and error category needed for the README cost and
operations sections.

- [ ] **Step 5: Review the final generated API as a security artifact**

Read `generated/capabilities.d.ts` line by line. Confirm no actor/team/channel
target, raw URL, token, arbitrary SQL, general HTTP, shell, GitHub, sandbox,
approval, or hidden admin method has appeared.

- [ ] **Step 6: Write the handoff note**

The notes must state:

- exact package and runtime versions;
- current network refusal wording;
- why RPC dispatchers are call arguments rather than loaded-Worker env values;
- why the stateless Code Mode path was chosen over the durable approval
  runtime;
- the precise limits and deployed results;
- which real adapters remain blocked on Phase 12 identity or later phases;
- invented/deprecated APIs encountered;
- any live API limitation the prompt must teach the agent.

- [ ] **Step 7: Final implementation commit**

```bash
git add apps/worker docs/superpowers/plans/phase-09-notes.md
git commit -m "docs(codemode): record tier-one verification"
```

---

## Phase 09 exit criteria

- [ ] Phase 00 Worker Loader gate remains **GO** and Phase 08 is implemented.
- [ ] Phase 10 receives exactly one model-facing tool named `run_code`.
- [ ] A real Dynamic Worker executes a hand-written program that chains at
      least four capability namespaces without an intermediate model round trip.
- [ ] The loaded Worker is created with `load()`, `globalOutbound: null`, an
      empty app env, and reviewed CPU/subrequest limits.
- [ ] `fetch`, socket connect, WebSocket, parent-origin, and bare-IP attempts
      are runtime-refused in deployed staging; the isolated control proves the
      field causes that result.
- [ ] No raw credential or platform binding is reachable from model code or a
      capability result.
- [ ] Trusted context, actor, target, customer, project/source origins, and
      Linear team cannot be overridden through arguments.
- [ ] Slack policy fails closed and never falls back to the bot identity.
- [ ] Supabase exposes only bounded reads and the live role rejects writes.
- [ ] Memory citations resolve through D1 and cannot be invented.
- [ ] Linear writes are pinned to `fire-fighter-testing` and retry-aware.
- [ ] Files are bounded, deterministic, policy-scoped, and contain no R2
      credentials.
- [ ] Generated declarations come from the runtime schemas and pass a no-drift
      check.
- [ ] Console, results, code, rows, pages, calls, bytes, wall time, CPU, and
      subrequests are bounded with readable errors/truncation.
- [ ] A Worker Loader binding is proved to work **inside the vitest runtime**
      (Task 1), not only under `wrangler dev` and deployed.
- [ ] Wall clock is bounded **parent-side**, so a non-yielding program
      terminates even where `limits.cpuMs` does not fire (invariant 21).
- [ ] Capability input validation holds regardless of which `resolveProvider`
      is imported (invariant 19), proved against both.
- [ ] Every capability method name is globally unique after PascalCase
      derivation, and the joined `.d.ts` compiles (invariant 20).
- [ ] Every method the declarations show as zero-argument callable is callable
      with no arguments at runtime.
- [ ] The Dynamic Worker bundle's `compatibilityDate` is the project's
      `2026-08-01`, not the package's hardcoded `2025-06-01`.
- [ ] The shadow-write check reads `RunRecord.shadow` from D1, and a shadow run
      is proved to fail closed.
- [ ] Nested capability activity can flow into Phase 08's existing tool event
      protocol; no second event/session store exists.
- [ ] Unit, integration, typecheck, dry-run, build, and deployed smoke checks
      pass.
- [ ] `phase-09-notes.md` contains current APIs, measurements, limitations, and
      honest AI-tool mistakes.

---

## Handoff to later phases

- **Phase 10** constructs this tool from RunDO state, runs the AI SDK stream,
  persists outer/nested tool events, and records both sides of each run in
  memory.
- **Phase 11** adds explicit `escalate` and `withdraw` namespaces. It does not
  turn on Code Mode's generic `needsApproval` gate.
- **Phase 12** implements `SlackGateway` with the on-duty engineer's decrypted
  user token. Phase 09 must continue to choose actor/target from trusted scope.
- **Phase 18** adds the `sandbox` namespace through the same registry contract,
  with no write credentials in the container.
- **Phase 19** uses the trusted artifact publisher for large streamed proof;
  it does not push videos through the small Code Mode binary limit.
- **Phase 20** adds `github` and extends Linear for the ship loop, still pinned
  to `staging` and the testing team.
- **Phase 21** uses stored capability/approval outcomes for evals and memory;
  it does not weaken the runtime boundary based on learned preferences.

Do not let later phases add a second general HTTP tool, raw credential, actor
selector, or harness-wide approval switch. Extending the registry should be a
new capability with its own schema, trusted context, TDD cycle, and security
test.
