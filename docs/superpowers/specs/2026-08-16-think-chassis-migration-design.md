# Fire-Fighter on `@cloudflare/think` — chassis migration design

Date: 2026-08-16. Status: design, approved in conversation; implementation plan follows.

## 1. Context

The trial brief lists four "read before you architect" sources: Code Mode, Project
Think, MCP tools in the Agents SDK, and the Agents SDK docs. The shipped build follows
Code Mode as a design (one `run_code` tool, generated TypeScript API, model code in a
Dynamic Worker with `globalOutbound: null`, capabilities as RPC call arguments) but on a
hand-built chassis: `RunDO extends DurableObject`, a plain AI SDK `streamText()` loop,
`@cloudflare/codemode`'s stateless `runCode` behind a guarded loader, and hand-rolled
session/approval/projection state. `agents` (the Agents SDK) is not a dependency.

Since the design spec was written (2026-08-10) the recommended stack has moved, verified
from published tarballs on 2026-08-16:

- `agents@0.20.1` — `agents/codemode/ai` is **removed** (the entrypoint throws
  *"Use `createCodeTool()` from `@cloudflare/codemode/ai` instead"*). `AIChatAgent`
  moved to `@cloudflare/ai-chat@0.10.1`.
- `@cloudflare/codemode@0.5.1` (already installed) — stateless `createCodeTool()`, or
  the durable `CodemodeRuntime` (a DO facet: replay, pause/approve, audit, snippets).
- `@cloudflare/think@0.15.1` — **Project Think shipped as a package.** An opinionated
  `Think<Env>` base class that `extends Agent` (peer `agents >=0.18`), owning the
  agentic loop, tree-structured sessions, durable turns (`runTurn`), fibers, hooks,
  `createExecuteTool()` (code mode on the durable runtime), and `useAgentChat` for
  React. Marked *Experimental*.

The current build re-implements most of what Think provides. This document designs the
port of the run/agent/approval layer onto Think while keeping every load-bearing
invariant (phase-10 plan §"Load-bearing invariants", 1–39) and every security claim in
`README.md` §Security model. The port happens **after** the day-7 fire drill, on a
branch; the current build remains the trial deliverable.

## 2. Goals and non-goals

Goals

- `RunAgent extends Think<Env>` is the run session (Slack-woken and chat-started alike:
  one session shape, requirement 2).
- Exactly one model tool, `run_code`, produced by `createExecuteTool` on the durable
  codemode runtime; the 11 capability namespaces reach the sandbox as
  `CodemodeConnector`s.
- The guarded loader (`globalOutbound: null` forced, empty env, no tails, clamped
  cpu/subrequests, project compat date) and the parent-side wall-clock race survive.
- Approval stays a model decision with dashboard approve / **edit** / reject and one
  writer of approval state.
- Ingest, triage, channel policy, Access gate, roster, OAuth, Sandbox container, Zep
  memory, effect ledger, write guard, redaction: unchanged in substance.
- Every one of invariants 1–39 has a named new home (§7).
- The README's AI-tool notes gain a Think section written the same way as the existing
  Worker Loader section: what the package really does, what was read from `dist/`, what
  was invented and corrected.

Non-goals

- MCP connectors (deferred, see Decision D3).
- Think workspace filesystem tools (`state.*`), Browser Rendering (`cdp.*`), Think
  messengers, sub-agents, skills, x402. Not needed; each is an explicit later option.
- Changing the dashboard's page count, the ingest pipeline, or the Slack/GitHub/Linear
  contracts.
- Any change to the deliverable before the drill.

## 3. Decisions log

Every decision taken while designing this, with the reason and the rejected alternative.
Later phases append here; nothing is deleted.

| # | Decision | Why | Rejected |
|---|---|---|---|
| D1 | **Timing: after the drill, on a branch.** The current build stays the trial deliverable; this is the "with another week" work. | Replacing the run/approval/tool chassis on an *Experimental* package with 598 tests bound to the current shape is multi-day work with real regression risk; drill scenarios 1–2 already passed live on the current build. | (a) Land before the drill — regression risk on the graded surface. (c) Treat the trial as over — it isn't; the README/interview still describe the current build. |
| D2 | **Chassis: `@cloudflare/think`** (`RunAgent extends Think<Env>`), not bare `Agent`/`AIChatAgent` + own loop, not "swap `run_code` only". | Think *is* Project Think: durable turns, sessions, hooks, `createExecuteTool` on the durable codemode runtime, `runTurn({mode:"submit", idempotencyKey})` for webhook-driven turns. It subsumes the other options and gives the strongest interview story ("built by hand, ported onto Think, here is exactly where Think was and wasn't enough"). Think `extends Agent`, so the Agents SDK is adopted by construction. | (B) `Agent` + own loop + `createCodeTool()` — adopts the SDK but keeps re-implementing sessions/approvals Think already provides. (C) keep `DurableObject`, only swap `run_code` — does not adopt the Agents SDK at all. |
| D3 | **MCP: none in this port.** All 11 namespaces stay typed Zod capabilities as connectors; `includeMcpTools = false` is set explicitly. MCP read-only connectors are a named later phase. | Typed capabilities carry what the write guard and effect ledger depend on: an `effect` class, at-call-time channel-policy/shadow checks, argument redaction, `code: message` errors. An MCP tool arrives as JSON Schema with none of that; auth is per-connection (Linear MCP is OAuth). One big change at a time. | (ii) MCP for read-only vendors — adds OAuth/token plumbing per DO and a second schema authority for reads; deferred, not rejected. (iii) MCP incl. writes — puts vendor writes outside the effect ledger and write guard. |
| D4 | **Approval is a model-called capability (`approval.escalate`, `effect: control_write`) with host-owned state, not `requiresApproval`/`action({approval})`.** | The brief forbids harness gating ("the agent decides when to ask"). And `CodemodeApproveOptions = { executionId }` — the durable runtime is approve-as-is or reject; there is **no edit**, while the dashboard must offer approve/edit/reject. Rejections must carry a reason into memory. | `requiresApproval` on connector tools / `action({kind:"durable-pause"})` — harness gating, no edit path, approval state would live in the runtime facet instead of one host-owned table. |
| D5 | **Guarded loader and parent-side race are kept and handed to Think via `executor:`.** | Read from `@cloudflare/codemode` `dist/index.js`: `load()` hardcodes `compatibilityDate: "2025-06-01"`, passes no `limits`, and the package `timeout` runs *inside* the sandbox. Think's one-liner (`createExecuteTool(this)`) inherits all three. Nothing in Think changes this. | Trust the one-liner — loses cpu/subrequest clamps, project compat date, and the parent-side wall clock. |
| D6 | **Zep remains the only memory; Think context blocks are prompt sections, not memory.** | The brief requires a graph memory engine and org-scoped durability with citations to threads; Zep + D1 citations already do that. Two memory systems would split "what did we learn" across stores. | Use Think context blocks as LLM-writable memory — per-DO, not org-scoped, no citations. |
| D7 | **Strangler migration:** `RunAgent` lands beside `RunDO` behind `RUN_CHASSIS=think\|legacy`; parity tests run both; cut over; delete `RunDO`. New DO class ⇒ new append-only migration tag `v3`. | Lets each invariant be moved and proven one at a time; the legacy path is the oracle. | Big-bang rewrite — no oracle, one giant diff. |
| D8 | **`run_code` stays the single outer tool; Think's own `bash`/workspace/fetch tools are disabled** (`workspaceBash = false`, `fetchTools = false`, no `state`/`browser` on the execute tool). | Invariant 5 (exactly one outer tool) and invariant 38 (write policy covers every capability): any second tool is a path around the write guard. Tier 2 stays the Sandbox container reached only through the `sandbox.*` connector. | Accept Think's defaults — silently adds a `bash` tool and a filesystem the write guard does not see. |
| D9 | **Steering is spliced per step, not queued as a new turn.** A `@callable steer(text)` stores the message; `beforeStep` inserts pending steers into `messages` before the next model call. `messageConcurrency = "queue"` for ordinary chat submits. | Preserves today's semantics (invariants 13–15: inputs never dropped, ordered, final-call steering explicit). Think's concurrency strategies only govern *user submits*, not mid-turn injection. | `messageConcurrency = "merge"` — merges only overlapping *submits*, still waits for the running turn to end. |
| D10 | **The dashboard adopts Think's `cf_agent_chat_*` protocol via `useAgentChat` (`@cloudflare/think/react`) for both the run page and the chat page.** The custom `/ws` server goes away. | One session shape (requirement 2), stream resumption and hibernation for free, and it is what "use the Agents SDK" means on the client. | Keep the custom `/ws` protocol and adapt Think to emit it — doubles the streaming code for no gain. |
| D11 | **Model is returned from `getModel()` as a `LanguageModel` built through AI Gateway, never a string slug.** | Think resolves string slugs through `workers-ai-provider`/AI Gateway defaults; the mandatory-Gateway, no-direct-Anthropic rule (spec §8, invariant 27) must stay enforced in code, with `maxRetries: 0`. | String slug — routes through Think's resolver, whose retry/gateway behavior is not ours to pin. |
| D12 | **Prompt structure preserved:** context blocks in today's order (`policy`, `voice`, `engineer`, `trusted-context`) via `configureSession().withContext(...).withCachedPrompt()`; per-turn dynamic block and untrusted evidence envelope in `beforeTurn`; the two Anthropic cache breakpoints via `beforeStep` `system: SystemModelMessage[]`. | `beforeStep` accepts `SystemModelMessage[]` and per-step `providerOptions`, so invariants 23–26 (evidence untrusted, declarations only in the tool description, caching never leaks) map 1:1. | Collapse to a single `getSystemPrompt()` string — loses cache breakpoints and the trusted/untrusted split. |
| D13 | **Package pins are exact** (`@cloudflare/think`, `agents`, `@cloudflare/codemode`). | All three are experimental or fast-moving (`agents/codemode/ai` was removed between minor versions). Traps recorded in `docs/things-to-remember.md` are per-version. | Caret ranges. |

## 4. Architecture

### 4.1 Topology

| Today | After |
|---|---|
| `RunDO extends DurableObject` (`src/run/do.ts`, `session.ts`; hand-rolled turns, stream events, alarm, projection) | `RunAgent extends Think<Env>` (`src/run/agent.ts`); Think/Agent owns turns, persistence, stream resumption, WebSocket hibernation, alarms, fibers. `wrangler.jsonc` migration `v3: new_sqlite_classes ["RunAgent"]`. |
| `runs.id` UUID ↔ DO name `slack:{ch}:{ts}` / `chat:{uuid}` resolved through D1 | Unchanged. `getAgentByName(env.RUNS, key)`; `src/run/keys.ts` remains the only name builder. |
| RunDO SQLite authority; D1 `runs` projection when `projection_seq` increases | Think session SQLite is authority; D1 projection written from `onStepFinish` / `onChatResponse` / `onChatError` with the same `projection_seq` rule. |
| `Sandbox extends BaseSandbox` container DO | Unchanged. |
| Triage → `RunDO.appendTurn()`; `routeToOwnedRun` for owned threads | Triage → `agent.runTurn({ mode: "submit", input, idempotencyKey: event_id })`. Owned-thread absorb: same call, `input` = the thread message; still no model call at triage. |
| `/ws/*` custom stream protocol | Think `cf_agent_chat_*`; dashboard `useAgentChat`. Hono mounts Think via `routeAgentRequest()` behind the Access gate. |
| Cron: memory outbox, undelivered approvals, nudges, orphan sandboxes | Kept (D1/queue sweeps). Per-run nudge retry moves to `this.schedule()`. |
| `Env`, Access, roster, OAuth, Slack events, `canPost`, channel policy | Unchanged. |
| `src/agent/ports.ts` module-scope registry (`installRunPorts`) | Removed: a Think agent holds live objects in-DO; tests inject through the agent's constructor deps / env. |
| `src/run/coordinator.ts` (policy re-read on wake, shadow ratchet false→true) | Moves into `beforeTurn`. |
| `src/agent/loop.ts` (`streamText`, step ceiling, refusal handling, schema-refusal replacement) | Think's loop + hooks: `maxSteps`, `beforeStep`, `afterToolCall`, `onChatError`/`classifyChatError`; the SDK-schema-refusal replacement (host-authored `CodeModeOutput`) is done in `afterToolCall`. |

### 4.2 Tool surface (code mode on Think)

- One tool: `getTools()` returns `{ run_code: createExecuteTool(this, opts) }` from
  `@cloudflare/think/tools/execute`. `index.ts` re-exports
  `CodemodeRuntime` from `@cloudflare/codemode` (the runtime is a facet of `RunAgent`'s
  DO; no extra binding/migration for a facet, per Think docs — verify in the plan).
- `opts`:
  - `connectors`: 11 `CodemodeConnector` subclasses (`slack`, `memory`, `linear`,
    `supabase`, `langsmith`, `betterstack`, `files`, `approval`, `sandbox`, `browser`,
    `github`), each returning today's Zod-described methods from `tools()`, and each
    overriding `tool(name, t)` to wrap execution in `withCapabilityAudit` +
    `assertEffectPermitted` + the effect ledger — exactly what `auditedCapability` does
    today. `requiresApproval` is never set (D4).
  - `executor`: `makeGuardedExecutor(guardLoader(env.LOADER, PRODUCTION_LIMITS), …)`
    (D5).
  - `description`: today's `RULES` with `{{types}}` = `renderCapabilityDeclarations`
    (invariant 24: declarations only here); `connectorHints` for one-line namespace
    hints.
  - No `tools`, `state`, `browser` (D8).
- Sandbox globals stay `slack.thread({...})`, `memory.recall({...})`, …; Think adds
  `codemode.search/describe/step/run` — additive, allowed.
- The declaration generator (`scripts/generate-codemode-dts.ts`, `codemode:dts[:check]`)
  reads connectors instead of the registry; output file and check script unchanged.
- `write-guard.ts`, `effects.ts`, `bindings/shared.ts` (budget, audit, redaction,
  customer-ref resolver), `errors.ts`, `contracts.ts`: unchanged in substance.
  `registry.ts`'s `buildRegistry`/`assertClassified` become `buildConnectors` /
  `assertClassified` over connector instances.
- The durable runtime's replay log is an *additional* audit trail; the D1 effect ledger
  stays the at-most-once authority (invariant 7). The plan proves the two never disagree
  on a replayed call: a replayed connector call must hit the ledger's `completed` row
  and return the recorded result, not re-run.

### 4.3 Approvals and steering

- `approval.escalate` (connector method) writes the pending approval into `RunAgent`'s
  own SQL (`this.sql`, table `approvals`), enqueues the D1 projection + the nudge job,
  and returns immediately; the model ends its turn (the pause latches at turn end, as
  today).
- `PATCH /api/approvals/:id` (Access JWT + roster) → `RunAgent.resolveApproval(...)`
  (RPC via `getAgentByName`) → local CAS in `this.sql` → D1 projection CAS →
  `runTurn({ mode: "submit", input: <approval-outcome message>, idempotencyKey:
  "approval:"+id })`.
  - approve → host sends the draft under the on-duty engineer's user token
    (`src/approval/sender.ts`), model told "sent".
  - edit → host sends the edited text, model told "sent (edited)" with the diff.
  - reject → reason to the memory outbox, model told "rejected: reason".
- Undelivered resolutions: cron sweep unchanged; per-run retry via `this.schedule()`.
- Steering: `@callable steer(text)` stores into `this.sql` `pending_steers`;
  `beforeStep` splices them into `messages` (invariants 12–15). Chat submits use
  `messageConcurrency = "queue"`.
- Watchers: `useAgentChat` streaming; tool events stay tool events (invariant 19).

### 4.4 Prompt, memory, sessions

- `configureSession(session)`: `.withContext("policy")`, `.withContext("voice")`,
  `.withContext("engineer")`, `.withContext("trusted-context")` in that order,
  `.withCachedPrompt()`, `.compactAfter(N)` with a summariser that runs through the same
  Gateway model (invariant 18: no reasoning persisted; invariant 33: Zep bounded).
- `beforeTurn`: re-read channel policy + shadow ratchet (from `coordinator.ts`), assemble
  the per-run dynamic block and the untrusted evidence envelope (`prompt/evidence.ts`),
  set `maxSteps`, `maxOutputTokens`, `providerOptions` (`disableParallelToolUse: true`,
  invariant 6), `maxRetries: 0` (invariant 27).
- `beforeStep`: `system: SystemModelMessage[]` with the two cache breakpoints;
  pre-step spend ceiling (invariant 28); splice steers (D9).
- `afterToolCall`: replace SDK schema refusals with host-authored `CodeModeOutput`;
  strip anything that echoes submitted code.
- `onStepFinish` / `onChatResponse`: D1 projection, usage rows in nano-USD (invariant
  29), Zep outbox jobs. `onChatError` + `classifyChatError`: refusal → paused/failed
  outcome, visible (invariants 30–31).
- Zep unchanged (D6).

### 4.5 Ingest, dashboard, API

- `POST /slack/events` → queue only. Ingest consumer, rules, `ingested_self` loop guard,
  channel policy: unchanged. Triage emits `{wake, why, opening_prompt}`; wake calls
  `runTurn({mode:"submit"})` (idempotent on `event_id`, so the D1 wake-dedupe row becomes
  belt-and-braces, kept).
- Hono keeps `/slack/events`, `/api/*`, OAuth, `/proofs/*`, assets; `routeAgentRequest`
  handles `/agents/*` behind Access.
- Dashboard: run page and chat page on `useAgentChat`; approvals card keeps
  `PATCH /api/approvals`; counters/rotation/connect status unchanged; `dev-stubs.ts` gains
  a stubbed agent WebSocket for local SPA work.
- Chat page "start a run by hand": creates `chat:{uuid}` and submits the first message —
  same shape as a Slack-woken run.

## 5. Security model after the port

Every row of `README.md` §Security model keeps its claim; the code column changes as
follows. The plan carries the full 15-row re-mapping; the load-bearing ones:

- Tier 1 isolate: `globalOutbound: null` forced, env empty, no tails, clamped limits —
  `guarded-loader.ts` unchanged, reached via `createExecuteTool({ executor })` (D5).
- `canPost()` enforced host-side inside the shared guard for every `external_write` —
  now in each connector's `tool()` override; the model still cannot reach a namespace
  that skips it because `assertClassified` runs at connector construction.
- Effect ledger at-most-once — unchanged; replay from the durable runtime must consult
  it (4.2).
- Secrets never enter prompts/events/tool output/logs/memory (invariant 39): the
  Think session store is now an "event" surface — the canary test extends to
  `RunAgent`'s SQL tables and to the codemode runtime's replay log.
- Approval state one writer — `RunAgent.approvals` (4.3).
- Container holds no write credentials; PAT swap at Worker egress — unchanged.

## 6. Verify-before-you-invent list (must be read from `node_modules`/`npm pack` before code)

- `@cloudflare/think`: `Think` class members actually present (`runTurn`, `configureSession`,
  `beforeTurn/beforeStep/afterToolCall/onStepFinish/onChatResponse/onChatError`,
  `messageConcurrency`, `workspaceBash`, `fetchTools`, `includeMcpTools`, `maxSteps`);
  `createExecuteTool` option names (`connectors`, `executor`, `description`,
  `connectorHints`); whether the `CodemodeRuntime` facet needs any wrangler entry under
  `@cloudflare/vitest-pool-workers`; `useAgentChat` import path and connect options.
- `@cloudflare/codemode`: `CodemodeConnector` (`name/instructions/tools/tool/revertAction`),
  `ConnectorTool` shape (`inputSchema/outputSchema/execute/revert/requiresApproval`),
  replay semantics of `approve`, whether `executor` given to the runtime is used for
  every replay pass.
- `agents`: `getAgentByName`, `routeAgentRequest`, `@callable`, `this.sql`,
  `this.schedule`, hibernation behaviour under the vitest pool.
- Record every mismatch in `docs/superpowers/plans/phase-25-notes.md` and traps in
  `docs/things-to-remember.md`.

## 7. Invariant map (1–39 → new home)

| Inv. | New home |
|---|---|
| 1 | Think session SQLite in `RunAgent` is the only session authority; D1 stays a projection. |
| 2 | One inbox: `runTurn()` (triage, thread messages, approval outcomes) + `steer()` (spliced per step). |
| 3, 4 | Prompt/policy unchanged; no branch on ticket type; origin is presentation only. |
| 5 | `getTools()` returns exactly `{ run_code }`; `workspaceBash=false`, `fetchTools=false`, `includeMcpTools=false`. Test asserts the merged tool set has one key. |
| 6 | `beforeTurn` `providerOptions.anthropic.disableParallelToolUse = true`. |
| 7, 8 | Effect ledger unchanged; `scope.turnId` = Think turn/request id allocated before provider I/O; runtime replay consults the ledger. |
| 9, 10, 11 | Think fibers + `runTurn` admission (one active turn per agent); at-least-once alarm assumptions hold; no long input gate. |
| 12–15 | `pending_steers` ordered by rowid; `beforeStep` splice; capabilities check the input revision via `guard.assertFresh()` (unchanged). |
| 16, 17 | Think persists assistant tool-call and tool-result messages; Fable omitted-thinking blocks pass through untouched — verify Think's message sanitiser does not strip provider metadata (plan task). |
| 18, 19, 20 | `sendReasoning=false`; tool events unchanged; Think batches deltas. |
| 21, 22 | Final assistant message id from Think turn id; operational events via `this.setState`/observability, not the transcript. |
| 23–26 | D12. |
| 27–31 | D11 (`maxRetries: 0`), pre-step spend ceiling in `beforeStep`, nano-USD usage rows, refusal via `classifyChatError`, no fallback model. |
| 32, 33 | `onStepFinish` writes local first, projection second; Zep bounded and unchanged. |
| 34–36 | Identity/customer-scope rules live in the connectors (unchanged code). |
| 37 | Shadow ratchet in `beforeTurn`. |
| 38 | Every connector wraps `assertEffectPermitted`; `assertClassified` at construction. |
| 39 | Canary test extended to `RunAgent` SQL and runtime replay log. |

## 8. Migration strategy (D7)

1. Branch `feat/think-chassis` in a worktree. Add deps (exact pins). `RunAgent` +
   `v3` migration beside `RunDO`. `RUN_CHASSIS` var (default `legacy`).
2. Port connectors (pure refactor of `registry.ts` + `bindings/*`); both chassis use them.
3. `RunAgent` loop, hooks, approvals, steering; parity tests against the legacy driver
   fixtures.
4. Dashboard on `useAgentChat` behind the same flag.
5. Flip default to `think` in the test env; run the full gate; deploy to the worker with
   `RUN_CHASSIS=think`; run the drill scenarios in `#test-firedrill`.
6. Delete `RunDO`, `session.ts`, `coordinator.ts`, `loop.ts`, `ports.ts`, `/ws`; keep
   migration tags; update README (architecture diagram, security table code column,
   AI-tool notes Think section, decisions block).

## 9. Testing

- Gate unchanged: `pnpm test`, `pnpm typecheck`, `pnpm codemode:dts:check` in
  `apps/worker`; baseline established before the branch.
- New: `test/run-agent.test.ts` (turn admission, idempotent submit, steer splice,
  approval resolve/edit/reject, projection), `test/codemode-connectors.test.ts` (one tool,
  effect classification, ledger-vs-replay agreement), `test/agent-surface-parity.test.ts`
  extended to both chassis while both exist, canary test extended (inv. 39).
- Existing `test/codemode-*.test.ts` and `test/agent-*.test.ts` are re-pointed at the
  connector API; tests asserting `RunDO` internals are deleted with `RunDO`.

## 10. Risks and open questions

- Think is Experimental; API drift between minors is real (`agents/codemode/ai` removal).
  Mitigation: exact pins, D13; the verify list in §6 before each task.
- Facet + vitest pool: whether `CodemodeRuntime` as a facet works under
  `@cloudflare/vitest-pool-workers 0.21` is unverified. First plan task is a spike; if it
  fails, fallback is `createCodeTool()` (stateless) inside `getTools()` with the same
  connectors — same tool surface, no runtime replay.
- Fable omitted-thinking blocks through Think's sanitiser (inv. 17): spike early.
- Cost: Think turns add session/compaction writes; measure against the current
  per-run cost table in README §Cost.

## 11. Out of scope

MCP (D3), workspace/browser tools (D8), messengers, sub-agents, skills, dashboard
redesign, any change to the pre-drill deliverable.
