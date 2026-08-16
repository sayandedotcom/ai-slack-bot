# Think Chassis Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Fire-Fighter run session from a hand-built `RunDO extends DurableObject` + AI SDK `streamText()` loop onto `@cloudflare/think` (Project Think, which `extends Agent` from the Cloudflare Agents SDK), with the single `run_code` tool served by `createExecuteTool` on the durable codemode runtime — preserving all 39 load-bearing invariants and every README security claim.

**Architecture:** A new `RunAgent extends Think<Env>` Durable Object lands *beside* the existing `RunDO` behind a `RUN_CHASSIS=think|legacy` env var (strangler). The 11 typed capability namespaces become `CodemodeConnector` subclasses shared by both chassis. The existing guarded Worker Loader (forced `globalOutbound: null`, empty env, clamped limits, project compat date) and parent-side timeout race are handed to Think via the `executor` option. Approval stays a model-called capability with host-owned state, because the codemode runtime offers approve/reject but no *edit*. Cutover flips the default, runs the drill scenarios, then deletes the legacy chassis.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects (SQLite), `@cloudflare/think` (exact pin), `agents` (exact pin), `@cloudflare/codemode@0.5.1`, `ai@7` + `@ai-sdk/anthropic@4` through AI Gateway, Zod 4, Hono, D1, Queues, R2, `@cloudflare/sandbox`, Vitest via `@cloudflare/vitest-pool-workers`, React/Vite dashboard.

**Spec:** `docs/superpowers/specs/2026-08-16-think-chassis-migration-design.md` (Decisions log D1–D13 — every task below cites the decision it implements).

## Global Constraints

- **Branch/worktree:** all work happens on `worktree-think-chassis` at `.claude/worktrees/think-chassis`. `main` (the trial deliverable, commit `5ee6c5b`) must never be modified. (Spec D1.)
- **Verified baseline on this branch (2026-08-16):** `pnpm test` → **104 files, 2133 passed, 2 skipped, 0 failed**; `pnpm typecheck` → pass; `pnpm codemode:dts:check` → pass. Re-establish this before judging any change; do not trust the README's older "598 passed".
- **The gate** is all three, run from `apps/worker`: `pnpm test`, `pnpm typecheck`, `pnpm codemode:dts:check`. There is no CI. `apps/dashboard/dist` must be built (`cd apps/dashboard && pnpm build`) before the worker test pool will run.
- **Exact version pins** for `@cloudflare/think`, `agents`, `@cloudflare/codemode` — no caret ranges. (D13.)
- **Exactly one model-facing tool**, `run_code`. `workspaceBash = false`, `fetchTools = false`, `includeMcpTools = false`, and no `state`/`browser` on the execute tool. (Invariant 5, invariant 38, D8, D3.)
- **The isolate's posture is non-negotiable:** `globalOutbound: null` forced, env asserted empty, no tails, clamped `cpuMs`/`subRequests`, project compat date `2026-08-01`, plus a parent-side wall-clock race. Always via `guardLoader` + `makeGuardedExecutor` handed in as `executor`. (D5.)
- **Migrations are append-only:** `apps/worker/migrations/*.sql` and the `migrations` tags in `wrangler.jsonc`. A new DO class needs a new tag; `v1`/`v2` are live in production.
- **Generated files are never hand-edited:** `worker-configuration.d.ts` (`pnpm cf-typegen`) and `src/codemode/generated/capabilities.d.ts` (`pnpm codemode:dts`).
- **Secrets never enter** prompts, Gateway metadata, events, tool output, logs, or memory (invariant 39). Code names variables, never values, in errors/logs/health.
- **Test harness rules:** workerd pool, storage shared across tests and files (no `isolatedStorage`) — mint a fresh run key per case (`chat:${crypto.randomUUID()}`), never assert absolute `seq`, never call `reset()`, never assume an empty DB.
- **Commit after every task** with conventional prefixes (`feat(scope):`, `fix(scope):`, `docs:`), ending with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.
- **Never commit** `docs/things-to-remember.md` (gitignored private notes).
- **Verify before you invent:** `@cloudflare/think`, `agents`, `@cloudflare/codemode` have thin training data. Read the installed `.d.ts` *and* `dist/*.js` before writing against them; record every mismatch in `docs/superpowers/plans/phase-25-notes.md` and traps in `docs/things-to-remember.md`.

---

## Execution speed rules — READ BEFORE DISPATCHING ANY TASK

Same regime as Phases 11–19; **overrides the per-step commands wherever they conflict.** Nothing in this phase builds a container image or pushes to a registry — the whole build surface is Worker TypeScript plus one Vite SPA — so the waves are wide and the wall-clock ceiling is the cutover drill, not the build.

1. **Pre-flight runs alone and first.** Task 1's spike is the one 3-minute check that can invalidate the phase's architecture (if the `CodemodeRuntime` facet cannot boot under `@cloudflare/vitest-pool-workers@0.21`, Task 6 falls back to stateless `createCodeTool()` and the durable-replay half of Tasks 9 and 15 is dropped). It also installs `agents` and `@cloudflare/think`, which every later task imports. Nothing dispatches until it lands.
2. **Wave A is four writers wide** — Tasks 2, 3, 4, and 5+6 merged. File sets are disjoint (see the table); the cross-task signatures are pinned below. **Do not serialise for a pinned signature** — a task writes against the pin and the merge proves it.
3. **Task 5 and Task 6 dispatch as ONE subagent** and that subagent owns `src/run/agent.ts` outright. It also creates the four hook modules as **stubs with the exact exported signatures pinned below**. This is what makes Wave B parallel: Tasks 8–11 each fill in exactly one stub file and touch `agent.ts` never.
4. **Wave B is five writers wide** — Tasks 7, 8, 9, 10, 11 — plus Task 12, which is disjoint from all of them. Six subagents, one file each.
5. **Wave C is two writers** — Task 13 (dashboard) and Task 15 (correctness proofs).
6. **Focused tests by exact path only:** `cd apps/worker && pnpm exec vitest run test/<exact-file>.test.ts`. Never a pattern, never bare `pnpm test` inside a task.
7. **One `pnpm exec tsc --noEmit -p tsconfig.json` per task**, at the end of that task. A task whose pinned import does not exist yet typechecks against the pin — a red `tsc` naming *only* a not-yet-merged sibling file is expected in Wave A and is resolved at the wave close, not by the task.
8. **`tsc` and the full suite run once per wave close**, by me, on the merged tree. **The full worker suite runs exactly once more at the Gate**, before Task 14. `codemode:dts:check` regenerates inside Task 7, so declaration drift never blocks a suite run.
9. **Review depth:** *deep* for Task 3 (verified fact 8 lives here — a connector that passes raw Zod silently destroys the model-facing API with no error anywhere) and Task 9 (approval is the requirement most likely to regress, and the edit path has no upstream equivalent); *medium* for Tasks 5+6, 11, 12 and 15; *light* for Tasks 2, 4, 7, 8, 10.
10. **Dispatch = the task's own text + Global Constraints + Verified package facts + the pinned interfaces + these rules.** Task 3's subagent additionally gets verified fact 8 verbatim as a requirement, not background. Task 9's reads `src/approval/sender.ts` and `src/api/approvals.ts` for the CAS idiom it mirrors. Task 5+6's reads `src/agent/dependencies.ts:380-440` and `src/codemode/tool.ts:85-170`. **No wider exploration than that.**
11. **No new runtime dependencies beyond the three named in Task 1** (`agents`, `@cloudflare/think`, already-present `@cloudflare/codemode`). `@types/json-schema` as a dev dependency is the only permitted addition. No new test library, no diff library, no octokit.
12. **Task 14 is NOT subagent-drivable.** It needs a deployed Worker, four live drill scenarios in `#test-firedrill`, and a human confirming before any deletion. Run it interactively and record what actually happened.
13. **Commit after every task**, conventional prefixes, with this repo's `Co-Authored-By` trailer. Never commit `docs/things-to-remember.md`.
14. **`main` is never touched.** All work is on `worktree-think-chassis`.

### Wave plan

| Wave | Tasks (one subagent each unless noted) | Files owned — disjoint by construction |
|---|---|---|
| Pre-flight | **1** | `package.json`, `wrangler.jsonc`, `worker-configuration.d.ts`, `src/index.ts` (exports only), `phase-25-notes.md` |
| A | **2** · **3** · **4** · **5+6 (one agent)** | `codemode/schema.ts` · `codemode/connectors/base.ts` + `codemode/registry.ts` · `codemode/connectors/index.ts` · `run/agent.ts` + 4 stub modules + `src/index.ts` |
| — | *wave close: merge, `tsc`, full suite* | |
| B | **7** · **8** · **9** · **10** · **11** · **12** | `codemode/dts.ts` + generator · `run/agent-prompt.ts` · `run/agent-approvals.ts` (+`api/approvals.ts`) · `run/agent-steering.ts` · `run/agent-projection.ts` · `run/chassis.ts` (+ triage/ingest call sites) |
| — | *wave close: merge, `tsc`, full suite* | |
| C | **13** · **15** | `apps/dashboard/**` + `src/index.ts` route mount · two new test files |
| Gate | full suite + `tsc` + `codemode:dts:check` once | |
| Cutover | **14** — interactive, human-gated | |

### Pinned interfaces (write against these; do not wait for the sibling task)

```ts
// Task 2 → src/codemode/schema.ts
export function toJsonSchema(schema: z.ZodType): JSONSchema7;

// Task 3 → src/codemode/connectors/base.ts
export type CapabilityNamespace = {
  name: string;
  instructions?: string;
  tools: Record<string, ToolDescriptor & { effect: CapabilityEffect }>;
};
export class FirefighterConnector extends CodemodeConnector<Env> {
  constructor(ctx: DurableObjectState | ExecutionContext, env: Env, ns: CapabilityNamespace);
  name(): string;
}
// Task 3 also adds to src/codemode/registry.ts (it owns that file):
export function buildNamespaces(scope, deps, limits, execution): CapabilityRegistry;
export const buildRegistry = buildNamespaces;   // old name kept, no caller changes
export type { ToolDescriptor };

// Task 4 → src/codemode/connectors/index.ts
export function buildConnectors(
  ctx: DurableObjectState | ExecutionContext,
  scope: CodeModeScope,
  deps: CapabilityDependencies,
  limits: CodeModeLimits,
  execution: CodeExecution,
  env: Env,
): CodemodeConnector[];

// Task 5+6 → the four stub modules it creates, filled in by Wave B.
// Each stub compiles, returns a safe default, and is marked TODO(Task N).
export function withFirefighterContext(session: Session, agent: RunAgent): Session;      // agent-prompt.ts  (Task 8)
export function firefighterSystemBlocks(agent: RunAgent): SystemModelMessage[];          // agent-prompt.ts  (Task 8)
export function ensureApprovalSchema(agent: RunAgent): void;                             // agent-approvals.ts (Task 9)
export function escalate(agent: RunAgent, input: EscalateInput): Promise<{ approvalId: string }>;
export function resolveApproval(agent: RunAgent, input: ResolveInput): Promise<ResolveResult>;
export function pendingApprovals(agent: RunAgent, opts?: { includeResolved?: boolean }): Promise<Approval[]>;
export function ensureSteerSchema(agent: RunAgent): void;                                // agent-steering.ts (Task 10)
export function queueSteer(agent: RunAgent, text: string): Promise<{ queued: number }>;
export function drainSteers(agent: RunAgent, messages: ModelMessage[]): Promise<ModelMessage[]>;
export function projectTurn(agent: RunAgent, input: ProjectionInput): Promise<void>;     // agent-projection.ts (Task 11)
export function recordUsage(agent: RunAgent, input: UsageInput): Promise<void>;
```

**Task 5+6 additionally:** `agent.ts` calls each stub from the real hook (`configureSession` → `withFirefighterContext`, `beforeStep` → `firefighterSystemBlocks` + `drainSteers`, `onStepFinish` → `projectTurn`/`recordUsage`, `@callable steer` → `queueSteer`, `escalate`/`resolveApproval`/`pendingApprovalsForRun` → the approvals module). Wave B changes **only** the stub bodies and their tests.

---

## Verified package facts (read from dist on 2026-08-16 — do not re-derive, do not contradict)

These were measured, not assumed. Tasks below depend on them.

1. **`agents@0.20.1`**: `agents/codemode/ai` is **removed** — importing it throws *"This entrypoint has been removed. Use createCodeTool() from @cloudflare/codemode/ai instead."* `AIChatAgent` is also removed from `agents` (moved to `@cloudflare/ai-chat`). Do not import either.
2. **`@cloudflare/think@0.15.1`** peers on `agents >=0.18.0 <1.0.0` — `agents` must be installed explicitly. `Think extends Agent`, so `this.sql`, `this.schedule()`, `this.setState()`, `@callable`, `this.mcp` are all available.
3. **`createExecuteTool(source, overrides?)`** and **`createExecuteRuntime(source, overrides?)`** from `@cloudflare/think/tools/execute`. Options: `ctx` (DurableObjectState — required when not passing the agent), `tools`, `state`, `browser`, `session`, `connectors`, `executor`, `loader`, `timeout`, `globalOutbound`, `description`, `name`. **`timeout` and `globalOutbound` are ignored when `executor` is given** — which is why the guarded executor must carry them itself.
4. **`createExecuteRuntime` returns `{ runtime, connectors, tool }`** and assigns the handle to `agent.codemode`. `runtime` exposes `approve({executionId})`, `reject({seq, executionId})`, `executions()`, `expirePaused()`, `saveSnippet()`.
5. **`CodemodeApproveOptions = { executionId }` only — there is no "edit" or arg-override on approve.** This is the measured reason approval stays host-owned (D4).
6. **`CodemodeConnector`** (from `@cloudflare/codemode`) is an abstract class extending `WorkerEntrypoint`; constructor is `(ctx: DurableObjectState | ExecutionContext, env)` — pass `this.ctx` from inside the DO with no cast. Implement `name()`, optionally `instructions()`, and `protected tools(): ConnectorTools`. `tool(name, t)` is the per-tool decoration hook. `executeTool` / `describe` / `revertAction` / `getTypeScriptTypes` are plumbing you do not implement.
7. **`ConnectorTool` = `{ description?, inputSchema?: JSONSchema7, outputSchema?, requiresApproval?, replay?, execute(args, ctx?), revert? }`.** `execute` receives **raw, unvalidated** args — our Zod parse inside `defineCapability` remains the real boundary.
8. **TRAP (measured, load-bearing).** The base class derives descriptors with `toolInputSchema(t)`, which accepts `t.inputSchema` only if it has `type`, `properties`, or `$ref`. A **Zod v4 schema has `.type === "object"`, so it passes that check and is used verbatim as if it were JSON Schema** — it has no `.properties`, so the generated API degrades to `unknown` *and the description is lost*. Proven with `generateTypesFromJsonSchema`:

   ```
   === built from RAW ZOD (naive port) ===        === built from z.toJSONSchema() ===
   type ReplyInput = unknown                      type ReplyInput = { channel: string; text: string; }
   type ReplyOutput = unknown                     type ReplyOutput = { ts: string }
   /** reply */                                   /** Post a reply */
   ```

   **Therefore every connector tool must set `inputSchema`/`outputSchema` to `z.toJSONSchema(...)` output, never the raw Zod schema.** Keep the Zod schema separately for the runtime parse.
9. **`requiresApproval` + `replay: "reexecute"` together throw** at `describe()` time. We set neither.
10. **`runTurn(options)`** on Think: `mode: "wait" | "submit" | "stream"`. `submit` takes `idempotencyKey` and returns `{accepted, status}` — re-submitting a known key returns `accepted: false` without starting a second turn. **Blocking modes cannot nest**: calling `wait`/`stream` from inside a tool's `execute` throws; from inside a turn use `mode: "submit"` or `addMessages()`.
11. **Hooks**: `configureSession(session)` (once, at `onStart`), `beforeTurn(ctx) → TurnConfig` (fields incl. `system`, `messages`, `tools`, `activeTools`, `maxSteps`, `maxRetries`, `providerOptions`, `maxOutputTokens`), `beforeStep(ctx) → StepConfig` (forwarded to AI SDK `prepareStep`; **accepts `system: SystemModelMessage[]`** — this is how the two Anthropic cache breakpoints survive — and `messages`), `beforeToolCall`, `afterToolCall`, `onStepFinish`, `onChunk`, `onChatResponse`, `onChatError`, `classifyChatError`.
12. **`includeMcpTools = false`** suppresses only Think's automatic `this.mcp.getAITools()` merge; `beforeTurn({activeTools: []})` does **not** work for this because tool conversion happens before `beforeTurn`.
13. **`messageConcurrency`** governs only overlapping *user submits*, not mid-turn injection — hence the per-step steer splice (D9).

---

## File Structure

**New files**

| Path | Responsibility |
|---|---|
| `apps/worker/src/codemode/connectors/base.ts` | `FirefighterConnector` — the shared `CodemodeConnector` subclass: holds a `CapabilityNamespace`, converts Zod→JSON Schema (fact 8), wires audit/effect-guard/ledger in `tool()`. |
| `apps/worker/src/codemode/connectors/index.ts` | `buildConnectors(ctx, scope, deps, limits, execution)` → `CodemodeConnector[]`; `assertClassified` over connector instances. |
| `apps/worker/src/codemode/schema.ts` | `toJsonSchema(zod)` — memoised `z.toJSONSchema` wrapper with the trap documented. |
| `apps/worker/src/run/agent.ts` | `RunAgent extends Think<Env>` — the new session DO. |
| `apps/worker/src/run/agent-approvals.ts` | `RunAgent`'s approval table + `resolveApproval` (approve/edit/reject). |
| `apps/worker/src/run/agent-steering.ts` | `pending_steers` table + `steer()` callable + `beforeStep` splice. |
| `apps/worker/src/run/agent-projection.ts` | D1 projection writes from `onStepFinish`/`onChatResponse`/`onChatError`. |
| `apps/worker/src/run/agent-prompt.ts` | `configureSession` context blocks + `beforeTurn` assembly (reuses `src/agent/prompt/*`). |
| `apps/worker/src/run/chassis.ts` | `RUN_CHASSIS` resolution + `wakeRun()` façade both chassis share. |
| `apps/worker/test/run-agent*.test.ts`, `test/codemode-connectors.test.ts` | New coverage. |
| `docs/superpowers/plans/phase-25-notes.md` | Dated verification log + invented-API list for this phase. |

**Modified**

| Path | Change |
|---|---|
| `apps/worker/package.json` | Add `agents`, `@cloudflare/think` (exact pins). |
| `apps/worker/wrangler.jsonc` | `RUN_AGENTS` DO binding + migration tag `v3`; `RUN_CHASSIS` var. |
| `apps/worker/src/index.ts` | Export `RunAgent` + `CodemodeRuntime`; mount `routeAgentRequest`; `Env` additions. |
| `apps/worker/src/codemode/registry.ts` | `buildRegistry` refactored to expose namespaces both chassis consume. |
| `apps/worker/src/codemode/dts.ts`, `scripts/generate-codemode-dts.ts` | Render from connectors. |
| `apps/worker/src/triage/*`, `src/ingest/consumer.ts` | Wake through `wakeRun()`. |
| `apps/worker/src/api/approvals.ts` | Route to the active chassis. |
| `apps/dashboard/src/**` | `useAgentChat` behind the flag. |
| `README.md` | Architecture, security table code column, AI-tool notes (Think section), decisions. |

**Deleted at cutover (Task 14):** `src/run/do.ts`, `src/run/session.ts`, `src/run/coordinator.ts`, `src/agent/loop.ts`, `src/agent/ports.ts`, `src/agent/driver.ts`, `src/agent/steering.ts`, `src/agent/stream.ts`, the `/ws` server, and their tests.

---

## Task 1: Spike — Think + codemode runtime facet under the vitest pool

Spec §10 names this the top risk: if the `CodemodeRuntime` facet does not work under `@cloudflare/vitest-pool-workers@0.21`, the fallback is stateless `createCodeTool()`. Find out before building anything on it. **This task's deliverable is an answer plus a committed note, not production code.**

**Files:**
- Modify: `apps/worker/package.json` (deps)
- Modify: `apps/worker/wrangler.jsonc` (binding + migration + var)
- Create: `apps/worker/src/run/spike-agent.ts` (throwaway, deleted in Step 9)
- Create: `apps/worker/test/spike-think.test.ts` (throwaway, deleted in Step 9)
- Create: `docs/superpowers/plans/phase-25-notes.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a recorded yes/no on the facet under test, and the exact `wrangler.jsonc` shape Task 5 will reuse.

- [ ] **Step 1: Install the two packages at exact pins**

```bash
cd apps/worker
pnpm add agents@0.20.1 @cloudflare/think@0.15.1
```

Then confirm the pins are exact (no `^`):

```bash
grep -E '"(agents|@cloudflare/think|@cloudflare/codemode)"' package.json
```
Expected: `"agents": "0.20.1"`, `"@cloudflare/think": "0.15.1"`, `"@cloudflare/codemode": "0.5.1"`.

- [ ] **Step 2: Read the installed surface before writing against it**

```bash
ls node_modules/@cloudflare/think/dist
sed -n 1,140p node_modules/@cloudflare/think/dist/tools/execute.d.ts
sed -n 1,60p node_modules/@cloudflare/think/docs/getting-started.md
```
You are checking that facts 2–4 in "Verified package facts" still hold for the installed copy. Any mismatch goes into `phase-25-notes.md` in Step 8 and **supersedes this plan**.

- [ ] **Step 3: Add the binding, migration tag, and var**

In `apps/worker/wrangler.jsonc`, add to `durable_objects.bindings`:

```jsonc
{ "name": "RUN_AGENTS", "class_name": "RunAgent" }
```

Append to `migrations` (append-only — do not touch `v1`/`v2`):

```jsonc
{ "tag": "v3", "new_sqlite_classes": ["RunAgent"] }
```

Add to `vars`:

```jsonc
"RUN_CHASSIS": "legacy"
```

`worker_loaders` already contains `{ "binding": "LOADER" }` — leave it as is.

- [ ] **Step 4: Regenerate Worker types**

```bash
pnpm cf-typegen
```
Expected: `worker-configuration.d.ts` regenerates with `RUN_AGENTS` present. (It is machine-dependent on `.dev.vars`; commit it only from a real regeneration.)

- [ ] **Step 5: Write the throwaway spike agent**

Create `apps/worker/src/run/spike-agent.ts`:

```ts
// THROWAWAY — deleted at the end of Task 1. Exists only to answer:
// does a Think agent + the CodemodeRuntime facet boot under the vitest pool?
import { Think } from "@cloudflare/think";
import { createExecuteTool } from "@cloudflare/think/tools/execute";
import { CodemodeConnector, type ConnectorTools } from "@cloudflare/codemode";
import { z } from "zod";
import type { Env } from "../index";

class EchoConnector extends CodemodeConnector<Env> {
  name() {
    return "echo";
  }
  protected tools(): ConnectorTools {
    return {
      say: {
        description: "Echo a word back",
        // JSON Schema, NOT raw Zod — see verified fact 8.
        inputSchema: z.toJSONSchema(z.object({ word: z.string() })) as never,
        outputSchema: z.toJSONSchema(z.object({ word: z.string() })) as never,
        execute: async (args: unknown) => args,
      },
    };
  }
}

export class SpikeAgent extends Think<Env> {
  workspaceBash = false;
  includeMcpTools = false;

  getModel() {
    throw new Error("spike does not call a model");
  }

  getTools() {
    return {
      run_code: createExecuteTool(this, {
        connectors: [new EchoConnector(this.ctx, this.env)],
        loader: this.env.LOADER,
      }),
    };
  }
}
```

Export it and the runtime from `apps/worker/src/index.ts` (both are DO classes the runtime resolves by name):

```ts
export { SpikeAgent } from "./run/spike-agent";
export { CodemodeRuntime } from "@cloudflare/codemode";
```

Add `SpikeAgent` to the `v3` migration's `new_sqlite_classes` array temporarily, alongside `RunAgent`.

- [ ] **Step 6: Write the spike test**

Create `apps/worker/test/spike-think.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { SpikeAgent } from "../src/run/spike-agent";

describe("spike: Think + CodemodeRuntime facet under the vitest pool", () => {
  it("boots an agent and exposes exactly one tool", async () => {
    const agent = await getAgentByName<Env, SpikeAgent>(
      // biome-ignore lint: spike
      (env as never)["RUN_AGENTS"],
      `spike:${crypto.randomUUID()}`,
    );
    const names = await agent.toolNamesForSpike();
    expect(names).toEqual(["run_code"]);
  });
});
```

Add to `SpikeAgent`:

```ts
  async toolNamesForSpike(): Promise<string[]> {
    return Object.keys(this.getTools());
  }
```

- [ ] **Step 7: Run the spike and record what actually happens**

```bash
npx vitest run test/spike-think.test.ts
```

There are three possible outcomes; **all are useful** — record whichever occurs:
- **PASS** → the facet works under the pool; the plan proceeds unchanged.
- **FAIL on a missing binding/migration for the facet** → note the exact error; try exporting `CodemodeRuntime` and adding a matching `new_sqlite_classes` entry, re-run, and record what was required.
- **FAIL structurally** (the facet cannot exist under this pool version) → **stop and record it**; Task 6 switches to `createCodeTool()` from `@cloudflare/codemode/ai` with the same connectors, and the durable-replay parts of Tasks 6/9 are dropped. Flag this to the human before continuing.

- [ ] **Step 8: Write the phase notes**

Create `docs/superpowers/plans/phase-25-notes.md`:

```markdown
# Phase 25 — Think chassis: verification log

Plan: `docs/superpowers/plans/2026-08-16-think-chassis-migration.md`
Spec: `docs/superpowers/specs/2026-08-16-think-chassis-migration-design.md`

## 2026-08-16 — Task 1 spike: Think + CodemodeRuntime facet under the vitest pool

Installed: `agents@0.20.1`, `@cloudflare/think@0.15.1`, `@cloudflare/codemode@0.5.1`.

Result: <PASS / FAIL — paste the exact vitest output>

Required wrangler shape: <what the facet actually needed, verbatim>

### Invented or corrected APIs

<one line per mismatch between this plan's "Verified package facts" and the
installed packages; "Nothing invented." if none>
```

- [ ] **Step 9: Delete the throwaway code, keep the config and the notes**

```bash
cd apps/worker
rm src/run/spike-agent.ts test/spike-think.test.ts
```
Remove the `SpikeAgent` export from `src/index.ts` and from the `v3` migration array (leave `RunAgent`). Keep: the two dependencies, the `RUN_AGENTS` binding, the `v3` tag, `RUN_CHASSIS`, the `CodemodeRuntime` export, and `phase-25-notes.md`.

- [ ] **Step 10: Run the full gate**

```bash
cd apps/worker
pnpm test
pnpm typecheck
pnpm codemode:dts:check
```
Expected: 104 files / 2133 passed / 2 skipped, typecheck clean, dts in sync — the untouched baseline.

- [ ] **Step 11: Commit**

```bash
git add apps/worker/package.json apps/worker/wrangler.jsonc apps/worker/worker-configuration.d.ts apps/worker/src/index.ts docs/superpowers/plans/phase-25-notes.md ../../pnpm-lock.yaml
git commit -m "feat(run): add agents + think deps and the RunAgent binding, with the facet spike recorded

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Zod→JSON Schema conversion helper

Verified fact 8 is the single highest-risk detail in the port: raw Zod passed to a connector silently destroys the typed API the model depends on. Isolate the conversion in one tested place before any connector uses it.

**Files:**
- Create: `apps/worker/src/codemode/schema.ts`
- Test: `apps/worker/test/codemode-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `toJsonSchema(schema: z.ZodType): JSONSchema7` — memoised per schema object; used by every connector in Task 3.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/test/codemode-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toJsonSchema } from "../src/codemode/schema";

describe("toJsonSchema", () => {
  it("produces a JSON Schema object with properties, not the Zod instance", () => {
    const zod = z.object({ channel: z.string(), text: z.string() });
    const json = toJsonSchema(zod);

    expect(json).not.toBe(zod);
    expect(json.type).toBe("object");
    // The whole point: a raw Zod schema also has `.type === "object"` but no
    // `.properties`, which is what silently degrades generated types to
    // `unknown` inside @cloudflare/codemode's toolInputSchema().
    expect(Object.keys(json.properties ?? {})).toEqual(["channel", "text"]);
    expect(json.required).toEqual(["channel", "text"]);
  });

  it("returns the same object for repeated calls on one schema", () => {
    const zod = z.object({ a: z.string() });
    expect(toJsonSchema(zod)).toBe(toJsonSchema(zod));
  });

  it("handles a zero-arg capability schema", () => {
    const json = toJsonSchema(z.object({}).default({}));
    expect(json.type).toBe("object");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd apps/worker
npx vitest run test/codemode-schema.test.ts
```
Expected: FAIL — cannot resolve `../src/codemode/schema`.

- [ ] **Step 3: Write the minimal implementation**

Create `apps/worker/src/codemode/schema.ts`:

```ts
import type { JSONSchema7 } from "json-schema";
import type { z } from "zod";

/**
 * Convert a Zod schema to the JSON Schema a `ConnectorTool` must carry.
 *
 * Load-bearing, and not obvious. `@cloudflare/codemode`'s connector base
 * derives its descriptors with:
 *
 *   for (const candidate of [t.inputSchema, t.parameters])
 *     if (candidate && typeof candidate === "object" &&
 *         ("type" in candidate || "properties" in candidate || "$ref" in candidate))
 *       return candidate;
 *   return { type: "object" };
 *
 * A Zod v4 schema has `.type === "object"`, so it PASSES that check and is
 * used verbatim as if it were JSON Schema — but it has no `.properties`, so
 * `generateTypesFromJsonSchema` renders `type XInput = unknown` and drops the
 * description. Measured 2026-08-16; see phase-25-notes.md.
 *
 * The Zod schema itself stays the runtime boundary (the parse inside
 * `defineCapability`); this is only what the model is shown.
 */
const cache = new WeakMap<object, JSONSchema7>();

export function toJsonSchema(schema: z.ZodType): JSONSchema7 {
  const cached = cache.get(schema as unknown as object);
  if (cached) return cached;
  const json = z.toJSONSchema(schema, { io: "input" }) as JSONSchema7;
  cache.set(schema as unknown as object, json);
  return json;
}
```

Note: import `z` as a value (`import { z } from "zod"`) if `z.toJSONSchema` is not available on the type-only import — check `node_modules/zod/package.json` version is 4.4.3 and adjust the import accordingly.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/codemode-schema.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

```bash
pnpm typecheck
```
Expected: clean. If `JSONSchema7` is unresolved, add `@types/json-schema` as a dev dependency at the exact version already in the lockfile (it ships transitively with `@cloudflare/codemode`).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/codemode/schema.ts apps/worker/test/codemode-schema.test.ts
git commit -m "feat(codemode): add Zod to JSON Schema conversion for connector descriptors

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: `FirefighterConnector` base class

Turn one capability namespace into a `CodemodeConnector` while keeping the audit sink, the effect guard, the budget, and the redaction that `auditedCapability` provides today.

**Files:**
- Create: `apps/worker/src/codemode/connectors/base.ts`
- Read first: `apps/worker/src/codemode/registry.ts:172-262` (`defineCapability`, `auditedCapability`), `src/codemode/bindings/shared.ts:284-356` (`withCapabilityAudit`), `src/codemode/write-guard.ts:101-163`
- Test: `apps/worker/test/codemode-connector-base.test.ts`

**Interfaces:**
- Consumes: `toJsonSchema` (Task 2); existing `CapabilityEffect`, `withCapabilityAudit`, `assertEffectPermitted`, `CapabilityError`.
- Produces:
  ```ts
  type CapabilityNamespace = {
    name: string;
    instructions?: string;
    tools: Record<string, ToolDescriptor & { effect: CapabilityEffect }>;
  };
  class FirefighterConnector extends CodemodeConnector<Env> {
    constructor(ctx: DurableObjectState | ExecutionContext, env: Env, ns: CapabilityNamespace);
    name(): string;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/worker/test/codemode-connector-base.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FirefighterConnector } from "../src/codemode/connectors/base";

const ctx = { waitUntil() {} } as unknown as ExecutionContext;

function namespace() {
  return {
    name: "demo",
    instructions: "A demo namespace.",
    tools: {
      echo: {
        effect: "read" as const,
        description: "Echo a word back",
        inputSchema: z.object({ word: z.string() }),
        outputSchema: z.object({ word: z.string() }),
        execute: async (raw: unknown) => raw,
      },
    },
  };
}

describe("FirefighterConnector", () => {
  it("names the namespace", () => {
    const c = new FirefighterConnector(ctx, env as never, namespace());
    expect(c.name()).toBe("demo");
  });

  it("describes tools with real JSON Schema, not the Zod instance", async () => {
    const c = new FirefighterConnector(ctx, env as never, namespace());
    const described = await c.describe();
    const input = described.descriptors.echo.inputSchema as {
      properties?: Record<string, unknown>;
    };
    // Guards verified fact 8: a raw Zod schema here would have no properties.
    expect(Object.keys(input.properties ?? {})).toEqual(["word"]);
    expect(described.descriptors.echo.description).toBe("Echo a word back");
    expect(described.instructions).toBe("A demo namespace.");
  });

  it("never marks a tool as requiring approval", async () => {
    const c = new FirefighterConnector(ctx, env as never, namespace());
    const described = await c.describe();
    expect(described.annotations?.echo?.requiresApproval).toBeUndefined();
  });

  it("executes through the namespace descriptor", async () => {
    const c = new FirefighterConnector(ctx, env as never, namespace());
    await expect(c.executeTool("echo", { word: "hi" })).resolves.toEqual({ word: "hi" });
  });

  it("refuses an unknown method", async () => {
    const c = new FirefighterConnector(ctx, env as never, namespace());
    await expect(c.executeTool("nope", {})).rejects.toThrow(/not found/);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run test/codemode-connector-base.test.ts
```
Expected: FAIL — cannot resolve `../src/codemode/connectors/base`.

- [ ] **Step 3: Write the implementation**

Create `apps/worker/src/codemode/connectors/base.ts`:

```ts
import { CodemodeConnector, type ConnectorTools } from "@cloudflare/codemode";
import type { Env } from "../../index";
import { toJsonSchema } from "../schema";
import type { CapabilityEffect } from "../write-guard";
import type { ToolDescriptor } from "../registry";

/**
 * One capability namespace as the connector layer sees it. Built by
 * `buildConnectors` from the same `make*Tools(ctx)` factories the legacy
 * registry uses, so both chassis execute identical capability code.
 */
export type CapabilityNamespace = {
  name: string;
  instructions?: string;
  tools: Record<string, ToolDescriptor & { effect: CapabilityEffect }>;
};

/**
 * The project's only `CodemodeConnector`.
 *
 * Everything security-relevant already lives inside the descriptor's
 * `execute` (Zod parse, `withCapabilityAudit`, `assertEffectPermitted`, the
 * effect ledger, budget, redaction) because `auditedCapability` wired it
 * there. This class does not re-implement any of it; it only presents those
 * descriptors to the codemode runtime in the shape the runtime needs.
 *
 * `requiresApproval` is deliberately never set: approval is a model decision
 * routed through the `approval` namespace, and the runtime's approve path
 * takes only an `executionId` — it cannot carry the dashboard's edited text.
 * See spec decision D4.
 */
export class FirefighterConnector extends CodemodeConnector<Env> {
  readonly #ns: CapabilityNamespace;

  constructor(
    ctx: DurableObjectState | ExecutionContext,
    env: Env,
    ns: CapabilityNamespace,
  ) {
    super(ctx, env);
    this.#ns = ns;
  }

  name(): string {
    return this.#ns.name;
  }

  protected instructions(): string | undefined {
    return this.#ns.instructions;
  }

  protected tools(): ConnectorTools {
    const out: ConnectorTools = {};
    for (const [method, descriptor] of Object.entries(this.#ns.tools)) {
      out[method] = {
        description: descriptor.description,
        // JSON Schema, never the Zod instance — see `toJsonSchema`.
        inputSchema: toJsonSchema(descriptor.inputSchema) as never,
        outputSchema: toJsonSchema(descriptor.outputSchema) as never,
        // Raw args: the descriptor's own Zod parse is the boundary.
        execute: (args: unknown) => descriptor.execute(args),
      };
    }
    return out;
  }
}
```

Adjust the `ToolDescriptor` import to whatever `registry.ts` actually exports (read it first); if the type is not exported, export it there in this step.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/codemode-connector-base.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full gate**

```bash
pnpm test
pnpm typecheck
```
Expected: baseline + 5 new tests, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/codemode/connectors/base.ts apps/worker/test/codemode-connector-base.test.ts apps/worker/src/codemode/registry.ts
git commit -m "feat(codemode): add FirefighterConnector wrapping a capability namespace

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: `buildConnectors` over all 11 namespaces

Expose the existing registry as connector instances without changing any capability behaviour, and keep `assertClassified` refusing an unclassified method.

**Files:**
- Create: `apps/worker/src/codemode/connectors/index.ts`
- Modify: `apps/worker/src/codemode/registry.ts:283-339` (extract the namespace list so both `buildRegistry` and `buildConnectors` use one source)
- Test: `apps/worker/test/codemode-connectors.test.ts`

**Interfaces:**
- Consumes: `FirefighterConnector`, `CapabilityNamespace` (Task 3); `buildRegistry`'s existing `(scope, deps, limits, execution)` arguments.
- Produces: `buildConnectors(ctx, scope, deps, limits, execution): CodemodeConnector[]` — order matches `PHASE_09_NAMESPACES` (that order is the rendered `.d.ts` order).

- [ ] **Step 1: Write the failing test**

Create `apps/worker/test/codemode-connectors.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildConnectors } from "../src/codemode/connectors";
import { makeTestScope, makeTestDeps, makeTestExecution } from "./helpers/codemode";
import { PRODUCTION_LIMITS } from "../src/codemode/contracts";

const ctx = { waitUntil() {} } as unknown as ExecutionContext;

function build() {
  return buildConnectors(
    ctx,
    makeTestScope(),
    makeTestDeps(),
    PRODUCTION_LIMITS,
    makeTestExecution(),
  );
}

describe("buildConnectors", () => {
  it("builds all eleven namespaces in declaration order", () => {
    expect(build().map((c) => c.name())).toEqual([
      "slack",
      "memory",
      "linear",
      "supabase",
      "langsmith",
      "betterstack",
      "files",
      "approval",
      "sandbox",
      "browser",
      "github",
    ]);
  });

  it("gives every method a JSON Schema with properties", async () => {
    for (const connector of build()) {
      const described = await connector.describe();
      for (const [method, descriptor] of Object.entries(described.descriptors)) {
        const input = descriptor.inputSchema as { type?: string };
        expect(input.type, `${connector.name()}.${method}`).toBe("object");
      }
    }
  });

  it("marks no method as requiring approval", async () => {
    for (const connector of build()) {
      const described = await connector.describe();
      for (const annotation of Object.values(described.annotations ?? {})) {
        expect(annotation.requiresApproval).toBeUndefined();
      }
    }
  });

  it("keeps method names globally unique across namespaces", async () => {
    const seen = new Set<string>();
    for (const connector of build()) {
      for (const method of Object.keys((await connector.describe()).descriptors)) {
        expect(seen.has(method), `duplicate method ${method}`).toBe(false);
        seen.add(method);
      }
    }
  });
});
```

Reuse whatever helper names `test/helpers/codemode.ts` already exports — read it first and adapt the three `makeTest*` calls to the real API rather than adding new helpers.

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run test/codemode-connectors.test.ts
```
Expected: FAIL — cannot resolve `../src/codemode/connectors`.

- [ ] **Step 3: Extract the shared namespace list in `registry.ts`**

Replace the body of `buildRegistry` so the array of namespaces is built once and reused:

```ts
export function buildNamespaces(
  scope: CodeModeScope,
  deps: CapabilityDependencies,
  limits: CodeModeLimits,
  execution: CodeExecution,
): CapabilityRegistry {
  const ctx: BindingContext = { scope, deps, limits, execution };

  return assertClassified([
    { name: "slack", tools: makeSlackTools(ctx) },
    { name: "memory", tools: makeMemoryTools(ctx) },
    { name: "linear", tools: makeLinearTools(ctx) },
    { name: "supabase", tools: makeSupabaseTools(ctx) },
    { name: "langsmith", tools: makeLangSmithTools(ctx) },
    { name: "betterstack", tools: makeBetterStackTools(ctx) },
    { name: "files", tools: makeFilesTools(ctx), types: FILES_DECLARATIONS },
    { name: "approval", tools: makeApprovalTools(ctx) },
    { name: "sandbox", tools: makeSandboxTools(ctx) },
    { name: "browser", tools: makeBrowserTools(ctx) },
    { name: "github", tools: makeGithubTools(ctx) },
  ]);
}

export const buildRegistry = buildNamespaces;
```

Keep `buildRegistry` exported under its old name so no existing caller or test changes in this task.

- [ ] **Step 4: Write `buildConnectors`**

Create `apps/worker/src/codemode/connectors/index.ts`:

```ts
import type { CodemodeConnector } from "@cloudflare/codemode";
import type { Env } from "../../index";
import type { CodeExecution } from "../bindings/shared";
import type { CodeModeLimits, CodeModeScope } from "../contracts";
import type { CapabilityDependencies } from "../gateways";
import { buildNamespaces } from "../registry";
import { FirefighterConnector } from "./base";

/**
 * The 11 capability namespaces as codemode connectors, in declaration order
 * (that order is the rendered `.d.ts` order, so it is load-bearing).
 *
 * Both chassis call `buildNamespaces`, so the capability code the model
 * reaches is byte-identical on either path — only the presentation differs.
 */
export function buildConnectors(
  ctx: DurableObjectState | ExecutionContext,
  scope: CodeModeScope,
  deps: CapabilityDependencies,
  limits: CodeModeLimits,
  execution: CodeExecution,
  env: Env,
): CodemodeConnector[] {
  return buildNamespaces(scope, deps, limits, execution).map(
    (ns) => new FirefighterConnector(ctx, env, ns),
  );
}
```

Match the real parameter order used by the existing `buildRegistry` call sites; if `env` is already reachable through `deps`, take it from there instead of adding a parameter, and update the test accordingly.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run test/codemode-connectors.test.ts
```
Expected: PASS (4 tests). If the "globally unique" test fails, that is a real finding — the `.d.ts` generator derives type names from the method name alone; fix the collision rather than the test.

- [ ] **Step 6: Run the full gate**

```bash
pnpm test
pnpm typecheck
pnpm codemode:dts:check
```
Expected: baseline + new tests; dts unchanged (this task does not alter rendering).

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/codemode/connectors apps/worker/src/codemode/registry.ts apps/worker/test/codemode-connectors.test.ts
git commit -m "feat(codemode): build the eleven capability namespaces as connectors

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: `RunAgent` skeleton — one tool, no model

> **Dispatch note (speed rules 3):** Tasks 5 and 6 are ONE subagent. It owns `src/run/agent.ts` outright and additionally creates the four hook-module **stubs** with the exact signatures pinned in "Pinned interfaces" — each compiling, each returning a safe default, each marked `// TODO(Task N)`. Wave B fills in the stub bodies and never edits `agent.ts`.

Land the class, the tool surface, and the "no second tool" guarantee before any model or session behaviour exists.

**Files:**
- Create: `apps/worker/src/run/agent.ts`
- Modify: `apps/worker/src/index.ts` (export `RunAgent`, `CodemodeRuntime`; `Env` gains `RUN_AGENTS`, `RUN_CHASSIS`)
- Test: `apps/worker/test/run-agent-surface.test.ts`

**Interfaces:**
- Consumes: `buildConnectors` (Task 4); existing `guardLoader`, `makeGuardedExecutor`, `PRODUCTION_LIMITS`, `renderCapabilityDeclarations`, `RULES` from `src/codemode/tool.ts`.
- Produces: `class RunAgent extends Think<Env>` with `getTools(): { run_code: Tool }`, and `readonly codemode` assigned by `createExecuteRuntime`.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/test/run-agent-surface.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { RunAgent } from "../src/run/agent";

async function agentFor(key = `chat:${crypto.randomUUID()}`) {
  return getAgentByName<Env, RunAgent>(env.RUN_AGENTS, key);
}

describe("RunAgent tool surface", () => {
  it("exposes exactly one tool, run_code", async () => {
    const agent = await agentFor();
    expect(await agent.toolNames()).toEqual(["run_code"]);
  });

  it("disables Think's own bash, fetch, and MCP tool merges", async () => {
    const agent = await agentFor();
    const flags = await agent.harnessFlags();
    expect(flags).toEqual({
      workspaceBash: false,
      fetchTools: false,
      includeMcpTools: false,
    });
  });

  it("puts the generated declarations in the tool description only", async () => {
    const agent = await agentFor();
    const description = await agent.runCodeDescription();
    expect(description).toContain("declare const slack");
    expect(description).toContain("declare const github");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run test/run-agent-surface.test.ts
```
Expected: FAIL — cannot resolve `../src/run/agent`.

- [ ] **Step 3: Write the skeleton**

Create `apps/worker/src/run/agent.ts`:

```ts
import { Think } from "@cloudflare/think";
import { createExecuteRuntime } from "@cloudflare/think/tools/execute";
import type { Tool } from "ai";
import type { Env } from "../index";
import { buildConnectors } from "../codemode/connectors";
import { PRODUCTION_LIMITS } from "../codemode/contracts";
import { makeGuardedExecutor } from "../codemode/executor";
import { guardLoader } from "../codemode/guarded-loader";

/**
 * The run session on the Project Think chassis.
 *
 * Think extends the Agents SDK `Agent`, so this class owns the agentic loop,
 * tree-structured session storage, durable turns, stream resumption and
 * hibernation; D1 `runs` stays a projection. See spec decision D2.
 */
export class RunAgent extends Think<Env> {
  // Invariant 5 and invariant 38: `run_code` is the only tool the model sees,
  // and every capability behind it goes through the write guard. Think would
  // otherwise merge a `bash` tool, HTTP fetch tools, and MCP tools that the
  // guard never sees. See spec decision D8 and D3.
  workspaceBash = false;
  fetchTools = false as const;
  includeMcpTools = false;

  #runCode: Tool | undefined;

  getModel() {
    // Task 8 replaces this with the AI Gateway model.
    throw new Error("model_not_configured");
  }

  getTools(): { run_code: Tool } {
    return { run_code: this.#executeTool() };
  }

  #executeTool(): Tool {
    if (this.#runCode) return this.#runCode;

    const limits = PRODUCTION_LIMITS;
    // The guarded loader forces the project compat date, `globalOutbound:
    // null`, an empty env, no tails and clamped cpu/subrequests; the guarded
    // executor adds the parent-side wall-clock race. `createExecuteTool`'s
    // own `timeout`/`globalOutbound` options are ignored once `executor` is
    // supplied, which is exactly why both must live in ours. See D5.
    const executor = makeGuardedExecutor(
      guardLoader(this.env.LOADER, limits),
      limits,
      () => Date.now(),
    );

    const { tool } = createExecuteRuntime(this, {
      connectors: this.#connectors(),
      executor,
      description: this.#description(),
      name: "run_code",
    });

    this.#runCode = tool;
    return tool;
  }

  #connectors() {
    // Task 7 supplies the real scope/deps/execution for this run.
    throw new Error("connectors_not_configured");
  }

  #description(): string {
    // Task 7 renders RULES + {{types}} here (invariant 24: the generated
    // declarations live in the tool description and nowhere else).
    throw new Error("description_not_configured");
  }

  // --- test surface -------------------------------------------------------

  async toolNames(): Promise<string[]> {
    return Object.keys(this.getTools());
  }

  async harnessFlags() {
    return {
      workspaceBash: this.workspaceBash,
      fetchTools: this.fetchTools,
      includeMcpTools: this.includeMcpTools,
    };
  }

  async runCodeDescription(): Promise<string> {
    return this.#description();
  }
}
```

The three `throw`s are placeholders **within this task only** — Task 7 replaces `#connectors()` and `#description()`, Task 8 replaces `getModel()`. The surface test's third assertion will therefore fail until Task 7; mark it `it.skip` here with the comment `// unskipped in Task 7` and unskip it there.

- [ ] **Step 4: Export the classes**

In `apps/worker/src/index.ts`, add:

```ts
export { RunAgent } from "./run/agent";
export { CodemodeRuntime } from "@cloudflare/codemode";
```

and extend the `Env` interface with:

```ts
  RUN_AGENTS: DurableObjectNamespace<import("./run/agent").RunAgent>;
  RUN_CHASSIS?: "think" | "legacy";
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run test/run-agent-surface.test.ts
```
Expected: PASS (2 tests, 1 skipped).

- [ ] **Step 6: Run the full gate**

```bash
pnpm test
pnpm typecheck
pnpm codemode:dts:check
```

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/run/agent.ts apps/worker/src/index.ts apps/worker/test/run-agent-surface.test.ts
git commit -m "feat(run): add the RunAgent skeleton with a single run_code tool

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: Per-run scope, connectors, and the tool description

Give `RunAgent` the run-scoped capability wiring the legacy chassis builds in `src/agent/dependencies.ts`, so `run_code` actually works.

**Files:**
- Modify: `apps/worker/src/run/agent.ts`
- Read first: `apps/worker/src/agent/dependencies.ts:380-440` (how scope/deps/limits/execution are assembled today), `src/codemode/tool.ts:85-170` (`RULES`, `{{maxCodeChars}}`, `{{types}}`, the declaration-only registry)
- Test: `apps/worker/test/run-agent-codemode.test.ts`

**Interfaces:**
- Consumes: `buildConnectors`, `renderCapabilityDeclarations`, `RULES`, `newCodeExecution`, `makeCapabilityDependencies`.
- Produces: `RunAgent.#scope()` from the DO name via `src/run/keys.ts`; a working `run_code` whose description carries all 11 namespaces.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/test/run-agent-codemode.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { RunAgent } from "../src/run/agent";

describe("RunAgent code mode", () => {
  it("runs model-authored code and returns its value", async () => {
    const agent = await getAgentByName<Env, RunAgent>(
      env.RUN_AGENTS,
      `chat:${crypto.randomUUID()}`,
    );
    const out = await agent.executeForTest("return 2 + 3");
    expect(out.result).toBe(5);
    expect(out.error).toBeUndefined();
  });

  it("captures console.log alongside the result", async () => {
    const agent = await getAgentByName<Env, RunAgent>(
      env.RUN_AGENTS,
      `chat:${crypto.randomUUID()}`,
    );
    const out = await agent.executeForTest('console.log("hello"); return 1');
    expect(out.logs.join("\n")).toContain("hello");
  });

  it("refuses to reach the internet from the isolate", async () => {
    const agent = await getAgentByName<Env, RunAgent>(
      env.RUN_AGENTS,
      `chat:${crypto.randomUUID()}`,
    );
    const out = await agent.executeForTest(
      'try { await fetch("https://example.com"); return "reached"; }' +
        ' catch (e) { return "refused"; }',
    );
    // `globalOutbound: null` leaves fetch defined and throws on invocation —
    // asserting absence would fail against a correct configuration.
    expect(out.result).toBe("refused");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run test/run-agent-codemode.test.ts
```
Expected: FAIL — `connectors_not_configured`.

- [ ] **Step 3: Implement scope, connectors, and description**

In `apps/worker/src/run/agent.ts` replace `#connectors()` and `#description()`:

```ts
  #scope(): CodeModeScope {
    // `this.name` is the DO name minted by src/run/keys.ts — the only place a
    // run key is built. Slack runs carry a pinned customer; chat runs resolve
    // one per execution (invariants 35 and 36).
    return scopeFromRunKey(this.name);
  }

  #connectors() {
    return buildConnectors(
      this.ctx,
      this.#scope(),
      makeCapabilityDependencies(this.env),
      PRODUCTION_LIMITS,
      newCodeExecution(),
      this.env,
    );
  }

  #description(): string {
    // Substituted BEFORE {{types}} so nothing in the generated declarations
    // can be read as a placeholder. Invariant 24: this is the declarations'
    // only home — they are not in the system prompt.
    return RULES.replace(
      "{{maxCodeChars}}",
      String(PRODUCTION_LIMITS.maxCodeChars),
    ).replace("{{types}}", renderCapabilityDeclarations(this.#declarationOnly()));
  }
```

`#declarationOnly()` mirrors `tool.ts`'s declaration-only registry: build the namespaces with a discarding audit sink so rendering can never reach a vendor. Copy that construction from `src/codemode/tool.ts:144-155`.

Add the test hook:

```ts
  async executeForTest(code: string) {
    const tool = this.#executeTool();
    return (await tool.execute?.({ code }, { toolCallId: "test", messages: [] })) as {
      result: unknown;
      logs: string[];
      error?: string;
    };
  }
```

Match the real `execute` signature from the installed `ai@7` types; read them rather than guessing.

- [ ] **Step 4: Unskip the description assertion from Task 5**

In `apps/worker/test/run-agent-surface.test.ts`, change `it.skip` back to `it` for "puts the generated declarations in the tool description only".

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run test/run-agent-codemode.test.ts test/run-agent-surface.test.ts
```
Expected: PASS (6 tests). The internet-refusal test may be environment-dependent under the pool — if it times out rather than refusing, mark it skipped with a comment pointing at the existing known-failing `codemode-security` control test and record it in `phase-25-notes.md`.

- [ ] **Step 6: Run the full gate**

```bash
pnpm test
pnpm typecheck
pnpm codemode:dts:check
```

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/run/agent.ts apps/worker/test/run-agent-codemode.test.ts apps/worker/test/run-agent-surface.test.ts
git commit -m "feat(run): wire per-run scope, connectors and declarations into RunAgent

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: Declarations rendered from connectors

Keep one source of truth for the generated `.d.ts` now that connectors exist, so `codemode:dts:check` still guards the model-facing API.

**Files:**
- Modify: `apps/worker/src/codemode/dts.ts`, `apps/worker/scripts/generate-codemode-dts.ts`
- Test: `apps/worker/test/codemode-dts.test.ts` (extend the existing file if present)

**Interfaces:**
- Consumes: `buildConnectors`, `describe()`.
- Produces: unchanged `src/codemode/generated/capabilities.d.ts` bytes.

- [ ] **Step 1: Capture the current generated file as the oracle**

```bash
cd apps/worker
cp src/codemode/generated/capabilities.d.ts /tmp/capabilities.before.d.ts
```

- [ ] **Step 2: Write the failing test**

Add to `apps/worker/test/codemode-dts.test.ts`:

```ts
it("renders the same declarations from connectors as from the registry", async () => {
  const fromConnectors = await renderDeclarationsFromConnectors();
  const fromRegistry = renderCapabilityDeclarations(declarationOnlyRegistry());
  expect(fromConnectors).toBe(fromRegistry);
});
```

- [ ] **Step 3: Run it to make sure it fails**

```bash
npx vitest run test/codemode-dts.test.ts
```
Expected: FAIL — `renderDeclarationsFromConnectors` is not defined.

- [ ] **Step 4: Implement connector-based rendering**

In `src/codemode/dts.ts`, add a function that takes connectors, calls `describe()` on each, and feeds `generateTypesFromJsonSchema(descriptors, name)` per namespace — joining in the same order, preserving the hand-written `FILES_DECLARATIONS` override. Note `generateTypesFromJsonSchema` is exported from `@cloudflare/codemode` (index), whereas the existing `generateTypes` comes from `@cloudflare/codemode/ai` and takes Zod tools; both exist, and this is the JSON-Schema-side twin.

- [ ] **Step 5: Regenerate and diff against the oracle**

```bash
pnpm codemode:dts
diff /tmp/capabilities.before.d.ts src/codemode/generated/capabilities.d.ts
```
Expected: **no diff**. Any diff means the connector path changed the model-facing API — investigate before proceeding; a `type XInput = unknown` appearing is verified fact 8 biting.

- [ ] **Step 6: Run the tests and the gate**

```bash
npx vitest run test/codemode-dts.test.ts
pnpm test
pnpm typecheck
pnpm codemode:dts:check
```

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/codemode/dts.ts apps/worker/scripts/generate-codemode-dts.ts apps/worker/test/codemode-dts.test.ts
git commit -m "feat(codemode): render capability declarations from connectors

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: Model, prompt blocks, and per-turn assembly

Give `RunAgent` the Fable 5 / AI Gateway model and reproduce today's prompt structure — cached stable prefix, dynamic per-run block, untrusted evidence envelope, two Anthropic cache breakpoints.

**Files:**
- Create: `apps/worker/src/run/agent-prompt.ts`
- Modify: `apps/worker/src/run/agent.ts`
- Read first: `apps/worker/src/agent/prompt/index.ts:50-100`, `src/agent/model.ts:200-250`, `src/run/coordinator.ts` (policy re-read + shadow ratchet)
- Test: `apps/worker/test/run-agent-prompt.test.ts`

**Interfaces:**
- Consumes: existing `buildPolicyBlock`, `buildVoiceBlock`, `buildContextBlock`, `buildEvidenceEnvelope`, `modelCallOptions`.
- Produces: `RunAgent.getModel()`, `configureSession()`, `beforeTurn()`, `beforeStep()`.

- [ ] **Step 1: Write the failing test**

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { RunAgent } from "../src/run/agent";

describe("RunAgent prompt assembly", () => {
  it("keeps generated declarations out of the system prompt", async () => {
    const agent = await getAgentByName<Env, RunAgent>(
      env.RUN_AGENTS,
      `chat:${crypto.randomUUID()}`,
    );
    const system = await agent.systemForTest();
    expect(system).not.toContain("declare const slack");
    expect(system).toContain("exactly one tool");
  });

  it("emits the stable prefix before any dynamic block", async () => {
    const agent = await getAgentByName<Env, RunAgent>(
      env.RUN_AGENTS,
      `chat:${crypto.randomUUID()}`,
    );
    const blocks = await agent.systemBlocksForTest();
    expect(blocks.map((b) => b.id)).toEqual([
      "policy",
      "voice",
      "engineer",
      "trusted-context",
    ]);
  });

  it("disables parallel tool use and provider retries", async () => {
    const agent = await getAgentByName<Env, RunAgent>(
      env.RUN_AGENTS,
      `chat:${crypto.randomUUID()}`,
    );
    const config = await agent.turnConfigForTest();
    expect(config.maxRetries).toBe(0);
    expect(
      (config.providerOptions?.anthropic as { disableParallelToolUse?: boolean })
        ?.disableParallelToolUse,
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run test/run-agent-prompt.test.ts
```
Expected: FAIL — `model_not_configured`.

- [ ] **Step 3: Implement `getModel()` through AI Gateway**

```ts
  getModel() {
    // A LanguageModel, never a model-id string: a string routes through
    // Think's own resolver (workers-ai-provider / Gateway defaults), and the
    // mandatory-Gateway, no-direct-Anthropic rule has to stay enforced in
    // code. See spec decision D11 and invariant 27.
    return makeGatewayModel(this.env);
  }
```

Reuse the existing model construction from `src/agent/model.ts` rather than rebuilding it; export a `makeGatewayModel(env)` from there if it is currently inlined.

- [ ] **Step 4: Implement `configureSession` and `beforeTurn`/`beforeStep`**

In `src/run/agent-prompt.ts`, build the four context blocks in order and return them; in `agent.ts`:

```ts
  configureSession(session: Session) {
    return withFirefighterContext(session, this);
  }

  async beforeTurn(ctx: TurnContext) {
    // Channel policy and the shadow ratchet are re-read on every wake, not
    // cached at composition time (invariant 37, and src/run/coordinator.ts's
    // job on the legacy chassis).
    await this.refreshChannelPolicy();
    return {
      maxSteps: STEP_CEILING,
      maxRetries: 0,
      providerOptions: { anthropic: { disableParallelToolUse: true } },
      ...modelCallOptions(this.env),
    };
  }

  async beforeStep(ctx: PrepareStepContext) {
    // `system` accepts SystemModelMessage[], which is how the two Anthropic
    // cache breakpoints survive (invariant 26: caching never justifies data
    // leakage — dynamic customer content follows the stable prefix).
    return { system: this.#systemBlocks(), messages: this.#withSteers(ctx.messages) };
  }
```

`#withSteers` is a pass-through until Task 10 implements steering.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run test/run-agent-prompt.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 6: Run the full gate**

```bash
pnpm test
pnpm typecheck
pnpm codemode:dts:check
```

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/run/agent-prompt.ts apps/worker/src/run/agent.ts apps/worker/src/agent/model.ts apps/worker/test/run-agent-prompt.test.ts
git commit -m "feat(run): give RunAgent the gateway model and the cached prompt blocks

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: Approvals — escalate, resolve, edit, reject

Approval is the requirement most likely to regress, and the codemode runtime cannot express it (approve takes only an `executionId`). Keep it host-owned.

**Files:**
- Create: `apps/worker/src/run/agent-approvals.ts`
- Modify: `apps/worker/src/run/agent.ts`, `apps/worker/src/api/approvals.ts`
- Read first: `apps/worker/src/approval/*`, `src/codemode/bindings/approval.ts`
- Test: `apps/worker/test/run-agent-approvals.test.ts`

**Interfaces:**
- Consumes: `runTurn({mode:"submit"})`; existing `sendApproved` from `src/approval/sender.ts`; the D1 CAS in `src/api/approvals.ts`.
- Produces:
  ```ts
  RunAgent.escalate(input: { draft: string; why: string; kind: string }): Promise<{ approvalId: string }>
  RunAgent.resolveApproval(input:
    | { id: string; decision: "approve" }
    | { id: string; decision: "edit"; text: string }
    | { id: string; decision: "reject"; reason: string }): Promise<{ ok: true } | { ok: false; code: string }>
  RunAgent.pendingApprovalsForRun(): Promise<Approval[]>
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { RunAgent } from "../src/run/agent";

async function agentFor() {
  return getAgentByName<Env, RunAgent>(env.RUN_AGENTS, `chat:${crypto.randomUUID()}`);
}

describe("RunAgent approvals", () => {
  it("records a pending approval and returns immediately", async () => {
    const agent = await agentFor();
    const { approvalId } = await agent.escalate({
      draft: "We shipped the fix.",
      why: "closes the thread",
      kind: "slack_reply",
    });
    const pending = await agent.pendingApprovalsForRun();
    expect(pending.map((p) => p.id)).toContain(approvalId);
    expect(pending[0].state).toBe("pending");
  });

  it("approves once and is idempotent on a second call", async () => {
    const agent = await agentFor();
    const { approvalId } = await agent.escalate({
      draft: "Fixed.",
      why: "closes the thread",
      kind: "slack_reply",
    });
    expect(await agent.resolveApproval({ id: approvalId, decision: "approve" })).toEqual({
      ok: true,
    });
    const second = await agent.resolveApproval({ id: approvalId, decision: "approve" });
    expect(second).toEqual({ ok: false, code: "already_resolved" });
  });

  it("carries the edited text, not the draft", async () => {
    const agent = await agentFor();
    const { approvalId } = await agent.escalate({
      draft: "Original draft.",
      why: "closes the thread",
      kind: "slack_reply",
    });
    await agent.resolveApproval({
      id: approvalId,
      decision: "edit",
      text: "Edited by the engineer.",
    });
    const [record] = await agent.pendingApprovalsForRun({ includeResolved: true });
    expect(record.sentText).toBe("Edited by the engineer.");
    expect(record.state).toBe("edited");
  });

  it("keeps the rejection reason for memory", async () => {
    const agent = await agentFor();
    const { approvalId } = await agent.escalate({
      draft: "Too promisey.",
      why: "closes the thread",
      kind: "slack_reply",
    });
    await agent.resolveApproval({
      id: approvalId,
      decision: "reject",
      reason: "overpromises a date",
    });
    const [record] = await agent.pendingApprovalsForRun({ includeResolved: true });
    expect(record.state).toBe("rejected");
    expect(record.reason).toBe("overpromises a date");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run test/run-agent-approvals.test.ts
```
Expected: FAIL — `agent.escalate is not a function`.

- [ ] **Step 3: Create the approvals table and methods**

In `src/run/agent-approvals.ts`, create the table in the agent's own SQL (one writer — the dashboard decides, Slack only nudges):

```ts
export function ensureApprovalSchema(agent: { sql: SqlFn }): void {
  agent.sql`
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      draft TEXT NOT NULL,
      why TEXT NOT NULL,
      state TEXT NOT NULL,          -- pending | approved | edited | rejected
      sent_text TEXT,
      reason TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    )`;
}
```

`resolveApproval` does a conditional update (`WHERE id = ? AND state = 'pending'`) and returns `{ ok: false, code: "already_resolved" }` when it affects no row — that is the CAS. On success it sends under the on-duty engineer's user token via the existing `src/approval/sender.ts`, writes the D1 projection, and re-enters the loop:

```ts
    await agent.runTurn({
      mode: "submit",
      input: approvalOutcomeMessage(record),
      idempotencyKey: `approval:${record.id}`,
    });
```

`mode: "submit"` is required, not stylistic: blocking modes throw when called from inside an active turn, and this can be called from either side.

- [ ] **Step 4: Point the API route at the active chassis**

In `src/api/approvals.ts`, keep the Access JWT + roster check and the D1 CAS exactly as they are; branch only on `RUN_CHASSIS` for which object receives the resolve call.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run test/run-agent-approvals.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 6: Run the full gate**

```bash
pnpm test
pnpm typecheck
pnpm codemode:dts:check
```

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/run/agent-approvals.ts apps/worker/src/run/agent.ts apps/worker/src/api/approvals.ts apps/worker/test/run-agent-approvals.test.ts
git commit -m "feat(run): host-owned approvals with approve, edit and reject on RunAgent

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 10: Steering spliced per step

**Files:**
- Create: `apps/worker/src/run/agent-steering.ts`
- Modify: `apps/worker/src/run/agent.ts`
- Read first: `apps/worker/src/agent/steering.ts` (today's semantics)
- Test: `apps/worker/test/run-agent-steering.test.ts`

**Interfaces:**
- Consumes: `beforeStep` (Task 8).
- Produces: `RunAgent.steer(text: string): Promise<{ queued: number }>`; `#withSteers(messages)` drains in insertion order.

- [ ] **Step 1: Write the failing test**

```ts
describe("RunAgent steering", () => {
  it("queues a steer and splices it before the next step, in order", async () => {
    const agent = await agentFor();
    await agent.steer("check the staging logs first");
    await agent.steer("and mention the workaround");
    const spliced = await agent.spliceForTest([]);
    expect(spliced.map((m) => m.content)).toEqual([
      "check the staging logs first",
      "and mention the workaround",
    ]);
  });

  it("drains each steer exactly once", async () => {
    const agent = await agentFor();
    await agent.steer("only once");
    await agent.spliceForTest([]);
    expect(await agent.spliceForTest([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run test/run-agent-steering.test.ts
```
Expected: FAIL — `agent.steer is not a function`.

- [ ] **Step 3: Implement**

Table `pending_steers (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created_at INTEGER NOT NULL)`; ordering is by `id`, never by timestamp (invariant 12). `steer()` is a `@callable` so the dashboard can reach it over the agent socket. `#withSteers` selects, appends as user messages, deletes the drained rows in the same call (invariant 13: never dropped, exactly once).

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/run-agent-steering.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full gate + commit**

```bash
pnpm test && pnpm typecheck && pnpm codemode:dts:check
git add apps/worker/src/run/agent-steering.ts apps/worker/src/run/agent.ts apps/worker/test/run-agent-steering.test.ts
git commit -m "feat(run): splice dashboard steering into the next model step

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 11: D1 projection from the Think hooks

**Files:**
- Create: `apps/worker/src/run/agent-projection.ts`
- Modify: `apps/worker/src/run/agent.ts`
- Read first: `apps/worker/src/run/repository.ts` (the `runs` projection contract, `projection_seq`)
- Test: `apps/worker/test/run-agent-projection.test.ts`

**Interfaces:**
- Consumes: `onStepFinish`, `onChatResponse`, `onChatError`, `classifyChatError`.
- Produces: projection rows in D1 `runs` + usage rows in nano-USD.

- [ ] **Step 1: Write the failing test**

```ts
it("advances the projection only when the sequence increases", async () => {
  const agent = await agentFor();
  await agent.projectForTest({ seq: 5, status: "running" });
  await agent.projectForTest({ seq: 4, status: "failed" });
  const row = await readRunRow(env, await agent.runId());
  expect(row.projection_seq).toBe(5);
  expect(row.status).toBe("running");
});

it("stores cost as integer nano-USD", async () => {
  const agent = await agentFor();
  await agent.recordUsageForTest({ inputTokens: 1000, outputTokens: 100 });
  const [usage] = await readUsageRows(env, await agent.runId());
  expect(Number.isInteger(usage.cost_nano_usd)).toBe(true);
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run test/run-agent-projection.test.ts
```
Expected: FAIL — `agent.projectForTest is not a function`.

- [ ] **Step 3: Implement**

Write the agent's own SQLite step record **first**, then the D1 projection (invariant 32: a D1 outage must never force another billed provider call). Guard with `WHERE projection_seq < ?`. Reuse `src/run/repository.ts` and `src/agent/usage.ts` rather than duplicating the cost maths.

- [ ] **Step 4–6: Verify and commit**

```bash
npx vitest run test/run-agent-projection.test.ts
pnpm test && pnpm typecheck && pnpm codemode:dts:check
git add apps/worker/src/run/agent-projection.ts apps/worker/src/run/agent.ts apps/worker/test/run-agent-projection.test.ts
git commit -m "feat(run): project RunAgent turns into D1 from the Think hooks

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 12: `wakeRun()` façade and the chassis switch

Route ingest/triage/chat through one entry point so the switch is a single decision, and Slack `event_id` idempotency moves onto `runTurn`.

**Files:**
- Create: `apps/worker/src/run/chassis.ts`
- Modify: `apps/worker/src/triage/*` (the wake call site), `src/ingest/consumer.ts`, `src/api/*` (chat run creation)
- Test: `apps/worker/test/run-chassis.test.ts`

**Interfaces:**
- Consumes: `RunAgent.runTurn`, legacy `RunDO.appendTurn`.
- Produces: `wakeRun(env, key, input, opts: { idempotencyKey: string }): Promise<{ accepted: boolean }>`.

- [ ] **Step 1: Write the failing test**

```ts
it("routes to the Think chassis when RUN_CHASSIS=think", async () => {
  const key = `slack:C1:${Date.now()}.1`;
  const first = await wakeRun({ ...env, RUN_CHASSIS: "think" }, key, "opening prompt", {
    idempotencyKey: "Ev123",
  });
  expect(first.accepted).toBe(true);
});

it("is idempotent on the Slack event id", async () => {
  const key = `slack:C1:${Date.now()}.2`;
  const e = { ...env, RUN_CHASSIS: "think" };
  await wakeRun(e, key, "opening prompt", { idempotencyKey: "Ev456" });
  const second = await wakeRun(e, key, "opening prompt", { idempotencyKey: "Ev456" });
  expect(second.accepted).toBe(false);
});

it("routes to the legacy chassis by default", async () => {
  const key = `slack:C1:${Date.now()}.3`;
  const out = await wakeRun({ ...env, RUN_CHASSIS: "legacy" }, key, "opening prompt", {
    idempotencyKey: "Ev789",
  });
  expect(out.accepted).toBe(true);
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run test/run-chassis.test.ts
```
Expected: FAIL — cannot resolve `../src/run/chassis`.

- [ ] **Step 3: Implement the façade**

```ts
export async function wakeRun(env: Env, key: string, input: string, opts: { idempotencyKey: string }) {
  if (env.RUN_CHASSIS === "think") {
    const agent = await getAgentByName<Env, RunAgent>(env.RUN_AGENTS, key);
    // `submit` is durable and idempotent: a repeated Slack event_id returns
    // accepted:false instead of starting a second turn.
    const out = await agent.runTurn({ mode: "submit", input, idempotencyKey: opts.idempotencyKey });
    return { accepted: out.accepted };
  }
  return legacyAppendTurn(env, key, input, opts);
}
```

Keep the existing D1 wake-dedupe as belt-and-braces; do not remove it.

- [ ] **Step 4–6: Verify and commit**

```bash
npx vitest run test/run-chassis.test.ts
pnpm test && pnpm typecheck && pnpm codemode:dts:check
git add apps/worker/src/run/chassis.ts apps/worker/src/triage apps/worker/src/ingest/consumer.ts apps/worker/test/run-chassis.test.ts
git commit -m "feat(run): add the wakeRun facade and the RUN_CHASSIS switch

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 13: Dashboard on `useAgentChat`

**Files:**
- Modify: `apps/dashboard/src/**` (run view, chat view, approvals card), `apps/dashboard/src/dev-stubs.ts`
- Modify: `apps/worker/src/index.ts` (mount `routeAgentRequest` behind Access)
- Test: `apps/dashboard/src/**/*.test.tsx`

**Interfaces:**
- Consumes: `useAgentChat` from `@cloudflare/think/react`; `RunAgent.steer`, `RunAgent.resolveApproval`.
- Produces: run and chat pages on one session shape.

- [ ] **Step 1: Install the client dependency**

```bash
cd apps/dashboard
pnpm add @cloudflare/think@0.15.1 agents@0.20.1
```

- [ ] **Step 2: Mount the agent route behind Access**

In `apps/worker/src/index.ts`, before the asset fallthrough and after the Access gate, add `routeAgentRequest(request, env)` for `/agents/*`. Confirm the Access gate still covers it — `/proofs/*` is the only deliberate bypass.

- [ ] **Step 3: Write the failing UI test**

Assert the run view renders streaming tool calls from a fake agent socket and that the steer box calls `steer`. Follow the existing dashboard test patterns; do not introduce a new testing library.

- [ ] **Step 4: Implement behind the flag**

Keep the legacy `/ws` view mounted when `RUN_CHASSIS=legacy` so both work until cutover. Loading, error, and empty states must exist on the new view — the brief grades them.

- [ ] **Step 5: Verify**

```bash
cd apps/dashboard && pnpm test && pnpm typecheck && pnpm build
cd ../worker && pnpm test
```

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard apps/worker/src/index.ts
git commit -m "feat(dashboard): run and chat pages on useAgentChat behind the chassis flag

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 14: Cutover, deletion, and README

Only start this once Tasks 1–13 are green and the human has confirmed the drill scenarios pass against a deployed `RUN_CHASSIS=think`.

**Files:**
- Modify: `apps/worker/wrangler.jsonc` (`RUN_CHASSIS: "think"`)
- Delete: `src/run/do.ts`, `src/run/session.ts`, `src/run/coordinator.ts`, `src/agent/loop.ts`, `src/agent/ports.ts`, `src/agent/driver.ts`, `src/agent/steering.ts`, `src/agent/stream.ts`, the `/ws` server and their tests
- Modify: `README.md`, `docs/superpowers/plans/phase-25-notes.md`

- [ ] **Step 1: Flip the default and run the gate**

```bash
cd apps/worker
pnpm test && pnpm typecheck && pnpm codemode:dts:check
```

- [ ] **Step 2: Deploy and drill (human-confirmed)**

```bash
pnpm run deploy
```
Then run the four drill scenarios in `#test-firedrill`. **Do not proceed to deletion until a human confirms all four pass.**

- [ ] **Step 3: Delete the legacy chassis**

```bash
cd apps/worker
git rm src/run/do.ts src/run/session.ts src/run/coordinator.ts \
       src/agent/loop.ts src/agent/ports.ts src/agent/driver.ts \
       src/agent/steering.ts src/agent/stream.ts
```
Delete their tests too. Keep every migration tag (append-only) and keep `RUN_CHASSIS` in the config for one release before removing it.

- [ ] **Step 4: Run the gate and record the new baseline**

```bash
pnpm test && pnpm typecheck && pnpm codemode:dts:check
```
Record the new counts in `phase-25-notes.md`.

- [ ] **Step 5: Update the README**

Four edits, each factual: the architecture diagram and topology paragraph; the security-model table's *code* column (the claims do not change, the paths do); a new AI-tool-notes section on `@cloudflare/think` and `agents` written like the existing Worker Loader one — what the packages really do, what was read from `dist/`, what the model invented and how it was corrected (start from `phase-25-notes.md`); and the decisions block from spec §3.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(run): cut over to the Think chassis and delete the legacy run loop

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage.** §4.1 topology → Tasks 5, 11, 12, 14. §4.2 tool surface → Tasks 2, 3, 4, 6, 7. §4.3 approvals/steering → Tasks 9, 10. §4.4 prompt/memory → Task 8 (Zep is untouched by design, D6 — no task needed). §4.5 ingest/dashboard/API → Tasks 12, 13. §5 security → Tasks 3, 6, 9 plus the Task 14 README pass. §6 verify-before-invent → Task 1 Step 2 and the "Verified package facts" block. §7 invariant map → cited inline per task. §8 migration → Tasks 12, 14. §9 testing → every task's test step. §10 risks → Task 1 (facet spike). The spec's second named spike, **invariant 17 (Fable omitted-thinking blocks through Think's message sanitiser)**, is covered by the added task below.
- **Known gap made explicit:** the effect-ledger-vs-replay agreement check (spec §4.2 last paragraph) is a Task 9 concern but only becomes testable once a paused execution exists; it is folded into Task 15.

---

## Task 15: Thinking-block passthrough and ledger/replay agreement

Two correctness properties the spec calls out that no earlier task proves.

**Files:**
- Test: `apps/worker/test/run-agent-thinking.test.ts`, `apps/worker/test/run-agent-replay.test.ts`
- Modify: `apps/worker/src/run/agent.ts` (only if a defect is found)

- [ ] **Step 1: Write the thinking-block test**

Assert that an assistant message carrying an omitted-thinking block with a `signature` survives a Think persist→reload round trip byte-identically, and that no readable reasoning text reaches the transcript, D1, or a Zep payload (invariants 17 and 18).

- [ ] **Step 2: Run it**

```bash
npx vitest run test/run-agent-thinking.test.ts
```
If Think's sanitiser strips the signature, that is a blocking defect — record it in `phase-25-notes.md`, and handle it in `beforeStep`/`onStepFinish` by re-attaching the provider metadata rather than mutating the signed block.

- [ ] **Step 3: Write the ledger/replay test**

Drive one execution that performs an `external_write`, pause it, resume it, and assert the capability ran **once**: the effect ledger shows a single `completed` row and the vendor gateway saw one call (invariant 7). This is the check that the durable runtime's replay and the D1 ledger never disagree.

- [ ] **Step 4: Run it**

```bash
npx vitest run test/run-agent-replay.test.ts
```
Expected: PASS. A second vendor call means replay is re-executing a logged effect — fix by ensuring the effect ledger is consulted inside the capability's `execute`, which it already is; if it still double-fires, record the finding and gate the connector's `replay` policy explicitly.

- [ ] **Step 5: Run the full gate and commit**

```bash
pnpm test && pnpm typecheck && pnpm codemode:dts:check
git add apps/worker/test/run-agent-thinking.test.ts apps/worker/test/run-agent-replay.test.ts apps/worker/src/run/agent.ts docs/superpowers/plans/phase-25-notes.md
git commit -m "test(run): prove thinking-block passthrough and ledger/replay agreement

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
