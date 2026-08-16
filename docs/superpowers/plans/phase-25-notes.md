# Phase 25 — Think chassis: verification log

Plan: `docs/superpowers/plans/2026-08-16-think-chassis-migration.md`
Spec: `docs/superpowers/specs/2026-08-16-think-chassis-migration-design.md`

## 2026-08-16 — Task 1 spike: Think + CodemodeRuntime facet under the vitest pool

Installed: `agents@0.20.1`, `@cloudflare/think@0.15.1`, `@cloudflare/codemode@0.5.1`
(all exact pins, no carets). Pool: `@cloudflare/vitest-pool-workers@0.21.0`,
vitest 4.1.10, workerd 1.20260804.1, compat date `2026-08-01`.

**Result: PASS — but only after one wrangler.jsonc line the plan did not
anticipate.** This is the plan's outcome (2): the facet works under the pool,
and the architecture proceeds unchanged; it needed extra config, recorded
verbatim below. The `createCodeTool()` fallback is NOT needed and the
durable-replay halves of Tasks 6/9/15 stay in.

Final run of `pnpm exec vitest run test/spike-think.test.ts`:

```
 RUN  v4.1.10 /home/sayan/Desktop/zellify/firefighter/.claude/worktrees/think-chassis/apps/worker


 Test Files  1 passed (1)
      Tests  2 passed (2)
   Start at  18:52:04
   Duration  9.17s (transform 3.31s, setup 8.61s, import 7ms, tests 51ms, environment 0ms)
```

The two cases were (a) `SpikeAgent extends Think<Env>` boots via
`getAgentByName` and `Object.keys(getTools())` is exactly `["run_code"]`, and
(b) — the case that actually matters — `agent.codemode.executions()` and
`agent.codemode.describe("echo.say")` round-trip through the facet's own
SQLite and return `0` and a descriptor containing the `word` property. Case (a)
alone would have been a false pass: `facets.get()` is lazy, so tool
construction resolves a stub and the failure only surfaces on the first facet
RPC.

### Required wrangler shape (verbatim)

Everything the plan's Step 3 asked for, plus the last line, which is the whole
finding:

```jsonc
// durable_objects.bindings
{ "name": "RUN_AGENTS", "class_name": "RunAgent" }

// vars
"RUN_CHASSIS": "legacy"

// migrations — APPENDED, v1/v2 untouched
{ "tag": "v3", "new_sqlite_classes": ["RunAgent", "CodemodeRuntime"] }
```

and in `src/index.ts`:

```ts
export { CodemodeRuntime } from "@cloudflare/codemode";
```

`CodemodeRuntime` gets **no** `durable_objects.bindings` entry. Nothing
addresses it from outside; it is reached only through its host DO's `facets`
map, where it gets an isolated SQLite database of its own. The migration entry
alone was verified sufficient.

### The failure this fixes, and why

With `CodemodeRuntime` merely exported (what `@cloudflare/codemode`'s docs and
its Vite plugin do, and all the plan assumed), the first facet RPC dies:

```
uncaught exception; source = Uncaught; stack = TypeError: Incorrect type for the 'class' field on 'StartupOptions': the provided value is not of type 'DurableObjectClass or LoopbackDurableObjectNamespace or LoopbackColoLocalActorNamespace'.

 FAIL  test/spike-think.test.ts > spike: Think + CodemodeRuntime facet under the vitest pool > reaches the facet's own SQLite through the runtime handle
TypeError: Incorrect type for the 'class' field on 'StartupOptions': the provided value is not of type 'DurableObjectClass or LoopbackDurableObjectNamespace or LoopbackColoLocalActorNamespace'.
```

`createCodemodeRuntime` reaches its facet through
`ctx.facets.get("codemode:<name>", () => ({ class: ctx.exports.CodemodeRuntime }))`
(`node_modules/@cloudflare/codemode/dist/index.js`, `getRuntime`). A probe of
`ctx.exports` inside the running agent showed exactly why that argument was
rejected:

```
ctor:RunDO              LoopbackDurableObjectNamespace
ctor:Sandbox            LoopbackDurableObjectNamespace
ctor:SpikeAgent         LoopbackDurableObjectNamespace
codemodeRuntimeCtor     LoopbackServiceStub          <-- before the fix
codemodeRuntimeCtor     LoopbackDurableObjectNamespace <-- after
exportKeys              default,CodemodeRuntime,ContainerProxy,RunAgent,RunDO,Sandbox,SpikeAgent,__VITEST_POOL_WORKERS_RUNNER_DURABLE_OBJECT__
```

workerd hands you a `LoopbackDurableObjectNamespace` for an export it has been
told is a Durable Object class, and a plain `LoopbackServiceStub` otherwise.
Declaring the class is the only way to tell it. This is **not** a pool artifact
— it is the same `ctx.exports` rule a deployed Worker runs under — so the line
is required in production too, not just for the tests. It is also not the same
situation as the `ContainerProxy` export three lines above it in
`src/index.ts`: that one is consumed as a *fetcher*, where a service stub is
the correct thing.

### Open issue the spike created, and it is deliberate

`RUN_AGENTS` now points at `RunAgent`, which **Task 5 has not written yet**.

- The vitest pool does not care: `pnpm exec vitest run test/run-do.test.ts` →
  17 passed, and `test/access-jwt.test.ts` → 17 passed, both after the spike
  code was deleted. Miniflare tolerates a binding to an unexported class until
  something actually addresses it.
- **`wrangler deploy` and `wrangler dev` do not.** Verified:

  ```
  ✘ [ERROR] Your Worker depends on the following Durable Objects, which are not exported in your entrypoint file: RunAgent.

    You should export these objects from your entrypoint, src/index.ts.
  ```

  So the tree is un-deployable between this commit and Task 5. That is the
  plan's intended sequence (Task 1 lands the config, Task 5 lands the class),
  but nobody should try to deploy in the gap, and Task 5 must land before any
  live drill.

### Side finding: `worker-configuration.d.ts` was stale, and needs `.dev.vars`

`pnpm cf-typegen` in a fresh worktree with no `.dev.vars` deletes every secret
from `Cloudflare.Env` — the machine-dependence CLAUDE.md warns about, and it
turns into 20+ `tsc` errors in `src/agent/dependencies.ts` and
`test/agent-composer.test.ts`. `.dev.vars` was copied into this worktree from
the main checkout (gitignored on both sides; nothing was written to `main`) and
the file regenerated from that.

The regenerated file therefore also picks up drift that predates this task:
`PROOFS_BASE_URL`, `GITHUB_REPO`, `GITHUB_BASE`, `GITHUB_AUTHOR` (all already
in `wrangler.jsonc`) and `MONOREPO_DEV_ENV`, `NUCLEO_LICENSE_KEY`,
`MONOREPO_PAT` (all already in `.dev.vars`) were missing from the committed
copy. They are now required rather than optional in `Cloudflare.Env`, which is
strictly more accurate; `pnpm exec tsc --noEmit` is clean with them.
`durableNamespaces` becomes `"RunDO" | "Sandbox" | "RunAgent" |
"CodemodeRuntime"`.

### Invented or corrected APIs

Facts 1–13 in the plan's "Verified package facts" were re-checked against the
installed copies. **Facts 1, 2, 5, 6, 7, 8, 9 confirmed verbatim** — including
fact 8's `toolInputSchema` trap, which is exactly as described at
`node_modules/@cloudflare/codemode/dist/base-BqhlNCSH.js:4-8`, and fact 9's
throw at `base-BqhlNCSH.js:74`. Corrections and additions:

1. **Fact 3 is incomplete in the way that matters (correction).** It lists the
   options but not their *defaults*. `createExecuteTool(agent)` calls
   `optionsFromAgent(agent)`, which derives `state` from `this.workspace` —
   and `Think.workspace` **defaults to a full DO-SQLite-backed `Workspace`**,
   not `undefined` — and `browser` from `env.BROWSER`. The merge is
   `{...optionsFromAgent(agent), ...overrides}`, so the *only* way to honour
   the plan's "no `state`/`browser` on the execute tool" constraint is to pass
   them explicitly:

   ```ts
   createExecuteTool(this, { state: undefined, browser: undefined, connectors, loader })
   ```

   Omitting them silently ships a `state.*` filesystem namespace to the model.
   Task 5+6 must do this. (`env.BROWSER` is not bound in this Worker, so the
   `browser` half is currently moot — but it is one wrangler line away from
   not being.)

2. **`createExecuteTool` is `createExecuteRuntime(...).tool` (addition to fact
   4).** It is not a lighter path: it builds the same runtime and assigns
   `agent.codemode` just the same, so `this.codemode` is available after a
   plain `createExecuteTool(this, …)`. `isAgent(source)` is
   `"env" in source && !("executor" in source) && !("loader" in source)` — note
   that passing `loader`/`executor` as a *second-argument override* keeps the
   agent path, but putting them in a single options object does not.

3. **`getRuntime` is called eagerly at tool construction, but `facets.get` is
   lazy (addition).** `runtime.tool()` → `createProxyTool` → `getRuntime(ctx)`
   runs while `getTools()` is building, yet a broken facet class does not throw
   until the first facet RPC. Any future test that means to prove the facet
   works must call something on `this.codemode`, not just count tool names.

4. **The `CodemodeRuntime` migration entry (new, load-bearing).** Documented
   above. Neither the package README, the `.d.ts` comment, nor
   `@cloudflare/codemode/vite` mentions it; the plugin only injects the
   `export` line (`dist/vite.js`).

5. **Fact 2's `Think extends Agent` confirmed, with the type bound worth
   noting:** `declare class Think<Env extends Cloudflare.Env = Cloudflare.Env,
   State = unknown, Props = ...> extends Agent<Env, State, Props>`. This
   repo's `Env` (`Omit<Cloudflare.Env, "MEMORY_QUEUE" | "TRIAGE_QUEUE"> & {…}`)
   satisfies that bound — `Think<Env>` typechecks with no cast.
   `getModel(): ThinkModel` is a plain method, not `abstract`.

6. **Fact 1 confirmed with its exact strings:** `agents/codemode/ai` throws
   *"This entrypoint has been removed. Use createCodeTool() from
   @cloudflare/codemode/ai instead."*; `agents/ai-chat-agent` throws *"All the
   AI Chat related modules are now in @cloudflare/ai-chat. …"*. Both entries
   are still present in `agents`' `exports` map, so a bad import fails at
   module-evaluation time, not at resolution time.

Nothing else was invented.

## 2026-08-16 — Task 12: `wakeRun()` façade and the chassis switch

### Invented or corrected APIs

7. **`Think.runTurn` is overloaded, and a Durable Object RPC stub keeps only
   the LAST overload.** `runTurn(RunTurnWait)` / `runTurn(RunTurnSubmit)` /
   `runTurn(RunTurnStream)` collapse, through `DurableObjectStub<RunAgent>`, to
   the `RunTurnStream` signature alone — so the plan's own Task 12 snippet
   (`agent.runTurn({ mode: "submit", … })` on the value `getAgentByName`
   returns) does **not** typecheck: `Type '"submit"' is not assignable to type
   '"stream"'`, then `Property 'accepted' does not exist on type 'void'`. The
   runtime behaviour is correct; only the mapped type is wrong.
   `src/run/chassis.ts` narrows the stub to a local
   `{ runTurn(options: RunTurnSubmit): Promise<SubmitMessagesResult> }` built
   from the package's own exported types, rather than reaching for `any`.

8. **Fact 10 confirmed by execution, not by reading.** `submitMessages`
   (`dist/think.js`) looks the submission up by `idempotency_key` before
   inserting and returns `{ …inspection, accepted: false }` when one already
   exists, in any status. The drain that follows a wake with no model
   configured fails inside `_executeSubmission`, which catches it and records
   `status: "error"` on the row — it does not reject the caller and does not
   disturb the second call's `accepted: false`.

## 2026-08-16 — Task 15: thinking-block passthrough and ledger/replay agreement

Both properties were measured against the installed packages, not reasoned
about. Neither test needed a change in `src/` — no defect was found.

### The invariant-17 answer (the one this task was written to get)

**Think's message sanitiser does NOT strip an omitted-thinking block's
`signature` or `redactedData`. Verified by round trip, not by reading.**

`agents@0.20.1`'s `sanitizeMessage` (`dist/chat/index.js:22-42`) does exactly
two things, and both leave an Anthropic thinking block untouched:

1. it strips `itemId` / `reasoningEncryptedContent` **only** from
   `providerMetadata.openai` / `callProviderMetadata.openai` — a metadata bag
   keyed `anthropic` is never entered;
2. it drops a `reasoning` part whose text is empty **unless** that part still
   carries a non-empty `providerMetadata` — an omitted-thinking block is
   precisely that exception, so it survives.

Think applies it at one write boundary, `_rowSafe` (`dist/think.js:1389`) =
`enforceRowSizeLimit(sanitizeMessage(message))`, which every history write goes
through (`_appendMessageToHistory`, `_updateMessageInHistory`,
`_upsertMessageInHistory`, `_orphanStore`). `enforceRowSizeLimit` only engages
above 1.8 MB.

Measured end to end in `test/run-agent-thinking.test.ts`: an assistant message
carrying a signed omitted-thinking part, a `redactedData` part and a readable
reasoning part is written with `addMessages`, the Durable Object is evicted,
and the message comes back **byte-identical** — both from Think's rehydrated
cache and from the `assistant_messages` row the session stored. The fixture's
signature deliberately contains `+`, `/`, `=` and a non-ASCII glyph, so a
re-encode or an NFC normalisation would fail the comparison.

### Invented or corrected APIs

9. **Trap: `getMessages()` on a freshly evicted object answers `[]`, not the
   stored history (new).** Think hydrates `_cachedMessages` in `onStart`
   ("transcript-hydration", `dist/think.js:1028`) and `getMessages()` merely
   returns that cache (`dist/think.js:3816`). A bare RPC against an evicted
   object does not run `onStart`, so a persist → evict → `getMessages()` test
   passes vacuously against an empty array. Re-acquire the stub with
   `getAgentByName` after the eviction. For the same reason `instance.session`
   is `undefined` inside `runInDurableObject` until the object has been
   initialised.

10. **`Think.getMessages()` types as `never` through a DO stub (new).**
    `UIMessage[]` does not survive the RPC type mapper, so
    `(await stub.getMessages()).find(...)` is a compile error and any
    assertion chained off it would be silently typed away. Cast at the call
    site, naming why.

### Codemode replay is UNREACHABLE in this configuration (D4)

The plan's Task 15 Step 3 asks for a pause → resume → replay pass. It cannot
happen here, and the cause is spec decision D4 rather than a bug. Read from
`@cloudflare/codemode/dist/index.js` on 2026-08-16:

- `CodemodeRuntime.decide(...)` is the only writer of `status = 'paused'`, in
  exactly one branch — `if (requiresApproval)` (`dist/index.js:679-690`).
- `requiresApproval` arrives from
  ``setup.annotations[`${name}.${method}`]?.requiresApproval ?? false`` in
  `buildConnectorBindings` (`dist/index.js:1573-1575`), i.e. straight off the
  connector's own `describe()`.
- `runtime.resume(id)` returns `null` for anything not `paused`
  (`dist/index.js:616-625`), and `resumeCodemode` turns that into
  *"…is not paused (status: …); only a paused run can be approved."*
  (`dist/index.js:1817-1826`). `runPass` is the only thing that calls the
  connectors, so no second pass ever runs.
- The other `{ kind: "pause" }` returns are dead ends, not routes into replay:
  `#fail`/`#diverge` mark the execution `error` first
  (`dist/index.js:923-936`), and the "already not running" guard at the top of
  `decide` can only fire after something else has already paused the run.

This project sets `requiresApproval` on nothing (verified fact 5, D4;
`test/codemode-connectors.test.ts` sweeps all eleven namespaces for it), so no
execution can pause and none can be resumed. A "pause, resume, assert once"
test would be asserting against an error string.

`test/run-agent-replay.test.ts` therefore proves the property directly, at the
seam a replay pass would actually cross twice: `connector.executeTool(method,
args, { executionId })` — what `buildConnectorBindings` calls on every pass,
with the id the package documents as "stable across a run's pause/resume
passes". Two identical `linear.createIssue` calls in one turn produce **one**
vendor call, **one** `completed` row in `codemode_effects`, and the second call
returns the recorded result. The row's `effect_key` equals the
`idempotencyKey` the vendor was called with, which is what makes "the ledger
and the vendor agree on what the same effect is" a checked statement rather
than an assumption.

**If `requiresApproval` is ever set on a connector tool**, the pause/resume
pass becomes reachable and this test should be upgraded to the pause/resume
form the plan describes.
