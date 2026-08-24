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
