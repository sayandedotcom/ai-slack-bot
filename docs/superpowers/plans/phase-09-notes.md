# Phase 09 notes — verification record

Companion to `phase-09-code-mode-tier-1.md`. Records what was checked, when,
and against what. Task 0 produces this file; later tasks append to it.

---

## Task 0 — 2026-08-12

### Step 1: prerequisites are real, not planned

| Claim | Evidence | Verdict |
| --- | --- | --- |
| `RUNS` SQLite DO binding exists | `wrangler.jsonc` → `durable_objects.bindings: [{ name: "RUNS", class_name: "RunDO" }]` and `migrations: [{ tag: "v1", new_sqlite_classes: ["RunDO"] }]` | PASS |
| `RunDO` exposes the promised RPC | `src/run/do.ts`: `initialize`, `state`, `snapshot`, `cursor`, `turns`, `toolCalls`, `appendTurn`, `appendToolCallUpdate`, `setStatus`, `setSummary` | PASS |

`new_sqlite_classes` (not `new_classes`) is what makes `ctx.storage.sql` and
`transactionSync` available. Phase 09's effect ledger depends on it.

### Step 2: Cloudflare docs (queried via docs MCP, 2026-08-12)

- `https://developers.cloudflare.com/dynamic-workers/getting-started/`
- `https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/`
- `https://developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta/`

Confirmed, unchanged from the Phase 00 spike:

- binding config is exactly `"worker_loaders": [{ "binding": "LOADER" }]`;
- `load(code)` is one-shot; `get(id, cb)` caches by id and can hand back a warm
  isolate. **Code Mode must never use `get()`** — model-authored code differs
  every call, and a name collision would run stale code. Task 4a's guard throws
  on `get()` for this reason;
- `globalOutbound: null` is documented as "block all outbound network access";
- there is no build step — modules are strings, so TypeScript never reaches the
  isolate.

Product status: **open beta** since 2026-03-24. Not GA. Worth restating in the
Phase 09 handoff, because an open-beta dependency is a real risk to name rather
than discover.

### Step 3: `@cloudflare/codemode@0.5.1` re-verified against installed code

```
pnpm add @cloudflare/codemode@0.5.1 --save-exact   # installed 0.5.1
```

Every findings-table row re-checked against `node_modules`, not memory:

| # | Finding | Probe result | Holds? |
| --- | --- | --- | --- |
| P1 | Two `resolveProvider`s; the base one skips validation | `dist/resolve-34dC47Il.js:30` — "This version does NOT perform schema validation on inputs." | YES |
| P2 | Timeout runs **inside** the sandbox | `dist/index.js:303` — the `Promise.race` against `"Execution timed out"` is concatenated into the generated module string | YES |
| P3 | Bundle compat date is hardcoded | `dist/index.js:333` — `compatibilityDate: "2025-06-01"` | YES |
| P4 | Generated type names carry no namespace | `dist/ai.js:120` + 3 more — `toPascalCase(safeName)` | YES |

Three further facts read out of the same `load()` call site
(`dist/index.js:329–341`), each confirming a plan decision:

1. **`load()` is called with no `limits` field at all.** The package never sets
   `cpuMs` or `subRequests`. If our guard does not inject them, nothing does.
2. **`entrypoint.evaluate(dispatchers, connectorBindings)`** — the
   `ToolDispatcher` instances cross as a **call argument**, never on `env`.
   This is the spike's `RpcTarget`-placement correction, confirmed in shipped
   code.
3. **`catch (err) { return { result: undefined, error: err.message, logs } }`**
   — only `.message` survives the isolate boundary. Not `name`, not `stack`,
   not the class. Any error *code* we want the model to see must be inside the
   message string. Instanceof checks across that boundary are worthless.

Also noted: `globalOutbound: this.#globalOutbound` and `env: hasEnv ? env : void 0`
are both taken from constructor config, so a misconfigured executor can hand the
isolate an open network and a populated env. Task 4a's guard forces both.

### Step 4: external integration docs

Already completed ahead of this task; the results are recorded as annotations in
`apps/worker/.dev.vars.example` (auth header shape, endpoint origin, credential
class, and the security caveat per provider). Summary of what was pinned:

| Provider | Auth | Pinned server-side |
| --- | --- | --- |
| Linear | bare `Authorization: lin_api_…`, **no `Bearer`** | `LINEAR_TEAM_ID` |
| LangSmith | `x-api-key` header, not `Authorization` | project + workspace id |
| Better Stack logs | HTTP **Basic** against a region-scoped ClickHouse endpoint | `BETTERSTACK_LOG_SOURCE_IDS` |
| Better Stack uptime | Bearer, separate product, separate credential | — |
| Supabase | `apikey:` **and** `Authorization: Bearer` | `SUPABASE_URL` |

Two credential facts that change task design, carried forward:

- The Better Stack SQL connection is **region-scoped** (`eu-central-1a`). A
  source in another region returns `NAMED_COLLECTION_DOESNT_EXIST`, not an empty
  result. Task 11 must not treat "no rows" and "wrong region" alike.
- The Supabase key is the **publishable** one, so RLS is enforced by the
  database. Consequence: with no SELECT policy, reads return **empty rather than
  erroring**. Task 9 must not read an empty array as "no matching rows".

Residual risk, not blocking: the LangSmith key is workspace-Admin where Task 10
needs `runs:read` alone, and the Better Stack uptime token is read-write and
returns monitor secrets (`auth_password`, `request_headers`,
`environment_variables`, `playwright_script`) in `GET /monitors`. Task 11's
field **allowlist** is therefore load-bearing, not cosmetic.

### Step 5: baseline preserved

```
pnpm test                        → 23 files, 305 tests, all passing
pnpm typecheck                   → exit 0
pnpm exec wrangler deploy --dry-run → exit 0
```

Zero pre-existing failures. Any red after this point is Phase 09's doing.

### Go / no-go

**GO.** No finding moved, no prerequisite is missing, and the baseline is clean.

---

## Task 1 — 2026-08-12

The phase's de-risk gate. **PASS**, all three cases:

1. `env.LOADER` exists and exposes `load` and `get`;
2. a real Dynamic Worker loads and returns over RPC **inside the vitest
   runtime** — pool-workers 0.21.0 / miniflare `5.20260804.0-alpha` does parse
   `worker_loaders` into a `workerLoaders` record;
3. `globalOutbound: null` refuses `fetch` on **invocation**, with `fetch` still
   defined. Absence of the global would have been the wrong claim.

Tasks 4b, 12, 13 and 14 therefore keep their test strategy. Nothing needs
re-planning around `wrangler dev` or deployed-only probes on account of the
runtime.

`wrangler types` produced a one-line diff (`LOADER: WorkerLoader;`) plus the
hash. No spurious secret drift, because `.dev.vars` is fully populated — the
`phase-08-notes.md` item 7 trap did not fire here.

---

## Task 4b — 2026-08-12

### The CPU-burn case cannot be verified locally, and running it wedges the suite

Measured, not assumed. `while (true) {}` inside a Dynamic Worker under
`@cloudflare/vitest-pool-workers`:

- the **parent-side race behaves correctly** — `execute()` returns
  `execution_timeout` on schedule, so the assertion in the plan's Task 4b Step 1
  would pass;
- but the isolate **is never killed**. `limits.cpuMs` is not enforced in the
  vitest pool any more than under `wrangler dev`. Measured `workerd` at ~75% CPU
  indefinitely after the race returned;
- the spinning isolate then starves the workerd process, so every later test in
  that runtime hangs — **including vitest's own `--testTimeout`**, which needs
  that runtime to fire. Confirmed by running the single case in isolation with
  `--testTimeout=20000`: still wedged.

There is no host-side remedy. `DynamicWorkerExecutor.execute()` creates and owns
the `WorkerStub` internally and returns only an `ExecuteResult`, so the parent
has no handle to dispose. Only a real workerd CPU limit ends that isolate.

**Resolution:** the case is `it.skip` in `test/codemode-executor.test.ts` with
the reason inline, and the claim is verified **deployed** in Task 14 Step 7 —
which is where the plan's own Task 4b Step 6 table already assigns it. A local
replacement test covers the safe half: a busy loop that *yields* is bounded by
the parent race and leaves nothing spinning.

> **Plan inconsistency to fix:** Task 4b Step 1 asks for a local test of exactly
> the claim Step 6 marks "deployed only". The two steps contradict each other;
> Step 6 is the correct one.

Three claims, three different proofs, still not interchangeable:

| Claim | Proved by | Status |
| --- | --- | --- |
| the bundle carries `limits.cpuMs` | Task 4a unit test | PASS (local) |
| a runaway program always returns to the caller | parent race | PASS (local, yielding case) |
| workerd itself kills a CPU burn | Task 14 Step 7 | **NOT YET PROVEN** |

Never report the parent race's success as evidence that `cpuMs` works.

### The log cap is a context bound, not a memory bound

Confirmed by reading the generated module (`dist/index.js:289–305`): `__logs` is
an array built **inside** the sandbox and returned whole in the RPC value. Any
host-side cap runs after the entire array has already crossed the boundary, so
it bounds what reaches the model's context window and nothing else. A sandbox
that logs 200MB still sends 200MB across RPC. Do not describe `maxConsoleChars`
as protection against memory exhaustion.

Console output does **not** travel through `tails`, so the Phase 00 spike's
~200KB silent-tail ceiling does not apply here.

---

## Task 5 — 2026-08-12

### Production must use the NON-validating resolver

Counter-intuitive, and measured rather than reasoned. The `/ai` resolver
validates **before** our `execute` and throws `JSON.stringify(zodIssues)` as the
error message. Since only `message` survives the isolate boundary, the model
receives a raw JSON array:

```json
[{ "expected": "string", "code": "invalid_type", "path": ["text"],
   "message": "Invalid input: expected string, received number" }]
```

Three problems with that: it is not the `code: message` wire format, so the
model cannot branch on a code; it echoes submitted values back for some issue
types (`"keys": ["teamId"]`), bypassing the "name the path, never the value"
rule `formatZodIssues` exists to enforce; and it bypasses our error text
entirely.

The **bare** resolver does not validate at all, so `defineCapability`'s parse is
the only one and every rejection is a well-formed `invalid_input: …`. Task 13
must therefore resolve providers with the bare `resolveProvider` from the main
entry — the opposite of the intuitive choice.

> **Plan correction:** Task 5 Step 2's `rejects a wrong-typed field through the
> /ai resolver` asserts `/invalid_input/i`. That fails: the /ai path never
> produces that string. Both resolvers reject, which is what the security
> invariant needs, but only the bare one produces our format. The test now
> asserts each resolver's real behaviour separately.

### `generateTypes` degrades a whole capability to `unknown`, silently

An input field JSON Schema cannot express does not raise an error — it renders
the ENTIRE capability's input type as `type PublishInput = unknown`, so the
model is told nothing about *any* of its arguments. Reproduced with
`z.instanceof(Uint8Array)`, `z.custom()`, and `.meta({type:"string"})`; all three
produce the same silent blanking.

The `files` namespace therefore ships explicit declarations
(`FILES_DECLARATIONS`), and `CapabilityProvider.types` exists solely for that.
A test asserts **no other** namespace renders `= unknown`, so a future schema
change cannot blank a capability's guidance without failing the build.

Related, and confirmed by reading the codec: **binary genuinely survives the
boundary**. `stringifyForCodemode` base64-tags `Uint8Array` as
`__codemode_binary_v1__` and `parseForCodemode` decodes it back to a real
`Uint8Array` on the host. Arguments cross as a JSON string
(`ToolDispatcher.call(name, argsJson)`), so this codec — not structured clone —
is why `files.publish({ bytes })` works.

## Task 8 — 2026-08-12

### Linear has a real idempotency facility; the plan's fallback is unnecessary

`IssueCreateInput` accepts a client-supplied `id`. Verified live in the
project's own `fire-fighter-testing` team (probe issue created, then deleted —
the team is empty again):

- first create with a fresh UUID → `{ success: true, issue: { id, identifier: "FIR-1", url } }`;
- second create with the **same** id → `conflict on insert of Issue`,
  `extensions.code = "INPUT_ERROR"`, `"Entity Issue with id … already exists."`

So the issue id is derived deterministically from the effect key, and the
conflict is the **reconciliation signal**, not an error to surface. This is
strictly better than Task 8 Step 5's fallback of a host-owned marker in the
description: no marker to strip, no search that can match the wrong issue.

`IssueFilter` does expose `description`, so the marker approach would have
worked — it is simply not needed.

### Upstream failures split by "could the server have processed this?"

Not by HTTP class. Rejected at the door — 401, 403, 429, or no response at all
— proves nothing was filed, so those map to `capability_unavailable`, which the
ledger treats as proven and permits a retry. A 5xx, or a 200 with an unreadable
body, might have been processed with the response lost, so those stay
`upstream_unavailable` and become `effect_in_doubt`.

`LinearGateway.findIssue` then makes that decidable: because the create supplies
its own id, "did this get filed?" is an exact lookup rather than a guess.

Also confirmed: `Authorization` is sent **bare**. With a `Bearer ` prefix every
query silently returns `null` rather than erroring.

---

## Task 9 — 2026-08-12

### The Supabase project is empty, and that changes the design

Probed live: every plausible table (`users`, `invoices`, `orders`, `customers`,
`profiles`, `tickets`, `events`, `subscriptions`) returns **404**. The PostgREST
schema root returns `{"message":"Secret API key required","hint":"Only secret
API keys can be used for this endpoint."}` — introspection needs the **secret**
key, the one that bypasses row-level security entirely and which this project
deliberately does not hold.

Two consequences:

1. **The allowlist is a reviewed constant, not runtime introspection.** That was
   already the safer choice — a credential being able to see a table is not a
   reason to show it to a model — and the credential shape now makes it the only
   choice. `supabase.schema()` returns the allowlist.
2. **`PRODUCTION_ALLOWLIST` is empty, accurately.** Naming tables that do not
   exist would be a lie that typechecks. While empty, `schema()` returns `[]` and
   every `select()` refuses with `invalid_input`. That is correct fail-closed
   behaviour — but this capability answers nothing useful until real resources
   are added.

> **OPEN GAP, not a defect:** the four drill scenarios that need product data
> have nothing to read. This is the same shape as the Better Stack question —
> a capability is only as useful as the data behind it. Adding a product schema
> is a decision outside Phase 09.

### Task 9 Step 5 cannot be completed yet

Step 5 asks for a live negative test proving the database role rejects insert,
update, delete, DDL and writable RPC even if application validation were
bypassed. With zero tables there is nothing to attempt it against: a write to a
nonexistent table returns 404, which proves nothing about the role.

**Not done, deliberately not faked.** Re-run it as written once a real resource
exists. Until then the read-only guarantee rests on the reader exposing no write
method and issuing only GET — both of which *are* tested — rather than on the
database-level backstop the publishable key is supposed to provide.

---

## Task 10 — 2026-08-12

Endpoint shape verified live: `POST /runs/query` with `{ session: [projectId], … }`
and the `x-api-key` header. An `Authorization: Bearer` is ignored and the
request fails unauthenticated.

`trace()` returns a **flat node list with `parentId` links**, per the plan's own
warning — a nested tree cannot survive `RunDO.appendToolCallUpdate`, and that is
a typecheck failure vitest cannot observe.

> **OPEN GAP:** the pinned project `tweakleaf`
> (`647f1d2e-bb76-48b3-adad-1d196ca0debe`) exists and is the workspace's only
> project, but contains **zero runs**. Task 10 Step 4 — "verify against one
> known trace, compare with the LangSmith UI" — therefore **could not be done**.
> The normalization is built against LangSmith's documented run shape and is
> covered by mocked-transport tests; it has never seen a real run. Re-run Step 4
> once something traces into that project.

---

## Task 11 — 2026-08-12

### The pinned log collection name was wrong

`BETTERSTACK_LOG_SOURCE_IDS` was `t582255_firefighter_worker` — that is the
**source** name, not a queryable collection, and it resolves as
`CLUSTER_DOESNT_EXIST`. The source exposes three collections:

| Collection | Contents |
| --- | --- |
| `remote(t582255_firefighter_worker_logs)` | recent logs, hot storage |
| `s3Cluster(primary, t582255_firefighter_worker_s3, …)` | historical logs |
| `remote(t582255_firefighter_worker_metrics)` | aggregated metrics |

Corrected to the `_logs` one. Source `firefighter-worker` (id 2670566) is
active, in `eu-central-1a` — matching the SQL endpoint — with **3-day** log
retention, which is why the query window caps at 7 days rather than 30.

### ACTION REQUIRED: the SQL connection cannot see the source

Diagnosed by elimination against the live endpoint:

- `SELECT 1` → **works**, so the credentials authenticate and the endpoint and
  region are right;
- every collection for this source — `_logs`, `_metrics`, `_s3` — fails;
- `system.named_collections` → `Not enough privileges`, so it cannot be
  enumerated from this connection;
- Better Stack's own tooling fails identically, so it is not a query-syntax
  problem.

The connection predates the source (source created 2026-08-11 20:34 UTC) and was
never granted it. **Fix: create a new SQL connection at telemetry.betterstack.com
→ Integrations → SQL API, then update `BETTERSTACK_SQL_USERNAME` and
`BETTERSTACK_SQL_PASSWORD`.** The password is shown once. Until then
`betterstack.logs()` returns `upstream_unavailable` — correctly, and without
leaking the ClickHouse exception, which names internal collections and the
connection user.

### The monitor allowlist is not theoretical

Confirmed against the live Uptime API: a monitor record really does carry
`auth_username`, `auth_password`, `request_headers`, `request_body`,
`environment_variables` and `playwright_script` — the credentials each monitor
uses against whatever it watches. Passing the record through, or denylisting
today's known-bad fields, would hand those to model code the first time upstream
adds a field. `monitors()` builds its result field by field from a four-name
allowlist and spreads nothing.

### Credentials that appeared in tooling output

While diagnosing, two values were echoed by Better Stack's own tooling into this
session's transcript: the **source ingest token** for `firefighter-worker`, and
the **SQL connection username** (in a privileges error). Neither is the SQL
password. Rotate them if the transcript is shared; the SQL connection is being
recreated anyway.

---

## Task 12 — 2026-08-12

### Decision D3: artifacts are PRIVATE

The R2 bucket `firefighter-artifacts` has no public origin. Objects are served
only through the Worker's own `/api/artifacts/` path, which sits behind whatever
guards the app — confirmed live: `https://firefighter.sayandeten.workers.dev`
answers `302` to Cloudflare Access.

Rationale: these artifacts are customer and production debug output. If one
policy cannot serve both that and Phase 19's proof recordings, the recordings
get their own prefix and a deliberate decision — this one is not widened.

Objects are stored `Content-Disposition: attachment`, never inline. A file
served from the app's own origin that renders in the browser is stored XSS, and
`image/svg+xml` is excluded from the allowlist for the same reason.

### The 5 MiB cap is measured, not assumed

Task 12 Step 6 required timing a round trip before trusting the cap, because the
codec base64-encodes bytes into a JSON string that crosses `ToolDispatcher`
twice. Measured through a real Dynamic Worker in the vitest runtime:

| Payload | Round trip |
| --- | --- |
| 256 KiB | 19 ms |
| 1 MiB | 39 ms |
| **5 MiB** | **190 ms** |

Linear at roughly 38 ms/MiB, with no RPC size error at the cap. **5 MiB stands.**
It is not raised: Phase 19's large recordings have a trusted non-Code-Mode path
to R2 precisely so nobody is tempted.

Also confirmed end to end, through a real isolate rather than a direct provider
call: a `Uint8Array` written in sandbox code arrives host-side as a real
`Uint8Array` with its bytes intact, including high values (250, 255).

---

## Task 14 — 2026-08-12

### The isolation claim, with its control

Verbatim from the runtime, for the README to quote rather than paraphrase:

```text
This worker is not permitted to access the internet via global functions like
fetch(). It must use capabilities (such as bindings in 'env') to talk to the
outside world.
```

Inside a correctly isolated isolate `typeof fetch === "function"` and
`typeof WebSocket === "function"`. **The claim is refusal, not absence.** A test
or README sentence asserting the globals are missing is wrong and would fail
against a correct configuration.

The control makes it causal rather than observational. The same loader, the same
compatibility date, one field removed:

| Configuration | Result |
| --- | --- |
| `globalOutbound: null` | refused, message above |
| field omitted | **`reached:200`** from `https://example.com` |

`guardLoader` forces `null` and there is no call site that can opt out, so the
right-hand row is unreachable from the deployed application.

### The plan's enumeration probe reports 15 leaks that do not exist

Task 14 Step 3's probe reads `await slack[n]` and treats any non-undefined value
as a leak. Run as written it reports `DB:rpc`, `SLACK_BOT_TOKEN:rpc`,
`ANTHROPIC_API_KEY:rpc` and twelve more.

All false. `slack` in the sandbox is **not an RPC stub** — it is the package's
`Proxy`, whose `get` trap returns a dispatch function for *every* string key
(`dist/index.js`, `proxyInits`). So a property read yields a function for any
name at all, and the probe's comment about "a lazy thenable" describes a
different object than the one it is testing.

The corrected probe **invokes**: `await slack[n]()` reaches `ToolDispatcher`,
which answers `Tool "DB" not found`, and the call throws. With that change the
found list is empty and the control still detects a genuine planted capability.

This matters beyond the test: the probe as written would either alarm a reviewer
into thinking credentials leak, or get "fixed" by weakening the assertion. The
shape of the true claim is the same as the outbound one — **the handle exists,
the call is refused.**

### A throwing getter is the model's bug, not an upstream failure

`safeMessage` collapses anything unrecognised to `upstream_unavailable`, which is
right for a vendor whose errors carry connection strings. It was wrong at the
executor's catch site, which only ever sees the sandbox failing to compile,
start, or serialise **model-authored** code — provider failures arrive through
`ExecuteResult.error`, not as a throw. Telling the model "the upstream service
failed" when it wrote a throwing accessor sends it debugging the wrong system.
That catch now defaults to `invalid_input` with the real message.

### What is proven locally vs deployed

| Claim | Where |
| --- | --- |
| outbound refused through the production path | local ✅ |
| omitting `globalOutbound` reaches the internet (control) | local ✅ |
| no credential, binding or host env reachable | local ✅ |
| policy cannot be argued out of (11 attacks) | local ✅ |
| serialization fails safely (10 shapes) | local ✅ |
| one effect for a duplicated call inside one program | local ✅ |
| wall-clock and never-resolving-capability timeouts | local ✅ |
| **workerd terminates a CPU burn** | **deployed only — still unproven** |

---

## Task 15 — handoff — 2026-08-12

### Versions

| Thing | Version |
| --- | --- |
| `@cloudflare/codemode` | `0.5.1` (exact, `--save-exact`) |
| `wrangler` | 4.120.1 |
| `@cloudflare/vitest-pool-workers` | 0.21.x → miniflare `5.20260804.0-alpha` |
| workerd (test runtime) | 25.12.3.21 |
| Worker `compatibility_date` | `2026-08-01`, flags `["nodejs_compat"]` |
| **Loaded bundle** compat date | `2026-08-01`, forced by `guardLoader` over the package's hardcoded `2025-06-01` |
| Dynamic Workers product status | **open beta** since 2026-03-24 — not GA |

### Current network refusal wording

```text
This worker is not permitted to access the internet via global functions like
fetch(). It must use capabilities (such as bindings in 'env') to talk to the
outside world.
```

### Why dispatchers are call arguments, not loaded-Worker env

`entrypoint.evaluate(dispatchers, connectorBindings)` — verified in shipped code
at `dist/index.js:346`. The `RpcTarget` subclass crosses as an **argument**, and
`env` is passed as `undefined` whenever empty. Placement, not type, is what
decides: an `RpcTarget` put on `env` does not work, which is the correction the
Phase 00 spike recorded and this phase confirmed against the real package.
`guardLoader` asserts the env is empty on every load so this cannot drift.

### Why the stateless path, not the durable approval runtime

`@cloudflare/codemode` ships a `CodemodeRuntime` with durable pause/resume for
approvals. Phase 09 deliberately uses only `runCode` + `DynamicWorkerExecutor`:

- approval is a **model decision** here (Phase 11), not a tool annotation. The
  package's resolver silently **drops** any tool carrying `needsApproval`, so
  adopting that model would make a capability vanish with no error — there is a
  test asserting no annotation exists;
- the durable runtime owns its own storage and lifecycle, which would compete
  with the Phase 08 `RunDO` that is already the system of record.

### Limits as shipped

| Limit | Value | Basis |
| --- | --- | --- |
| `maxCodeChars` | 24 000 | reviewed |
| `wallTimeMs` | 20 000 (hard max 60 000) | parent-side race |
| `cpuMs` | 500 | bundle limit; **enforcement unverified** (deployed only) |
| `subRequests` | 32 | bundle limit |
| `maxResultChars` | 24 000 | context bound |
| `maxConsoleChars` | 32 000 | context bound, **not** a memory bound |
| `maxCapabilityCalls` | 40 | per execution, shared across namespaces |
| artifact size | 5 MiB | measured: 190 ms round trip |

### Blocked on later phases or on data that does not exist yet

| Capability | State |
| --- | --- |
| `slack.reply` | always `identity_unavailable`. Phase 12 supplies the per-engineer token; it must never fall back to `SLACK_BOT_TOKEN` |
| `supabase.*` | correct but **answers nothing**: the project has no tables, so `PRODUCTION_ALLOWLIST` is empty |
| `langsmith.*` | correct but the pinned project has **zero runs**; normalization has never seen a real trace |
| `betterstack.logs` | correct but the **SQL connection cannot see the source** — recreate the connection (Task 11) |
| `betterstack.monitors` | working against the live account |
| `linear.*` | working; verified live including duplicate-id reconciliation |
| `slack.thread` / `searchMessages` | working, but two of three channels have ingested **zero** messages — the bot is likely not a member |

### Invented or corrected APIs encountered

Nothing invented. Four plan statements were corrected against measured
behaviour, each recorded in its own section above: the `/ai` resolver's error
format, the CPU-burn test's local runnability, `generateTypes` silently blanking
a capability, and the environment probe's false positives.

### What the Phase 10 prompt must teach the agent

- Errors are `code: message`; the code is stable and worth branching on.
- There is no network. `fetch` exists and every call is refused.
- `slack.reply` currently always refuses — draft the reply in the answer instead.
- `supabase` and `langsmith` may legitimately return nothing; that is missing
  data, not a bug to work around.
- Only facts returned by `memory.recall` **in this execution** can be cited.

### Remaining gate

**Task 15 Step 3, the deployed smoke check, has not been run.** It needs a probe
surface (decision D5: a separate smoke Worker, or an Access-protected staging
route) and the Phase 09 secrets installed in production with
`wrangler secret put`. It is the only place `limits.cpuMs` enforcement can be
proven; every other exit-criterion claim is verified locally.

---

### `generateTypes` cannot render an index signature

`z.record`, `z.looseObject`, and `z.object().catchall()` all emit `{}`. So
`supabase.select` is declared as `Promise<{}[]>`. This costs nothing at runtime
— the sandbox runs JavaScript, not TypeScript — but it means the row shape is
communicated in the method description rather than the type. Not worth an
override; recorded so nobody re-investigates it.
