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
