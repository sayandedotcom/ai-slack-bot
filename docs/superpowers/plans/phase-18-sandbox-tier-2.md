# Phase 18 — Sandbox Tier 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent boots its own machine. From model-authored code inside the one `run_code` tool, a run provisions a container carrying `Zellify/web2app-rebuild`, brings a dev server up on it, reaches it over a public URL, and runs the test suite — with no write credential anywhere inside the container.

**Architecture:** One `@cloudflare/sandbox` container per run, keyed `run:{runId}`, provisioned from a **fully baked image** (repo pre-cloned at `staging`, `pnpm install` done, `pnpm build-packages` output present, Chromium ready). A ninth Code Mode namespace, `sandbox`, exposes it. Because a Tier 1 execution is bounded at 20 s wall time and container work is measured in tens of seconds, **every long operation returns a handle instead of blocking** — `boot` is a poll, `spawn`+`checkProcess` replace a blocking `exec` for anything slow. The container's git remote is a sentinel host whose credential is swapped Worker-side on egress; dev-server secrets are injected per-process by the Worker, never baked and never typed by the model.

**Tech Stack:** `@cloudflare/sandbox` (pinned to the image tag), `@cloudflare/containers` (`interceptHttps`, `setOutboundByHost`, `sleepAfter`), Cloudflare Containers `standard-4`, Docker BuildKit secrets, D1, R2.

**Spec:** `docs/superpowers/specs/2026-08-10-firefighter-agent-design.md` §6, §8.2, §8.3, §11.1. Roadmap entry: `00-roadmap.md` Phase 18. Spike: `docs/superpowers/spikes/2026-08-10-sandbox.md` (**read it before Task 2** — every platform trap below was paid for there). Prior art: `docs/inspired-from-ronit.md` §7.

## Global Constraints

All of `00-roadmap.md` "Global Constraints" apply. The ones that bite here:

- **The Tier 2 sandbox holds no write credentials.** It emits artifacts; the Worker performs every write. Phase 18 adds one honest nuance, recorded in §"The dev-env caveat" below and destined for the README: a *running dev server* legitimately holds dev-tier read secrets.
- **No secret values in the repo, ever.** Two new secret names appear (`MONOREPO_PAT`, `MONOREPO_DEV_ENV`); no value does. The image build takes the PAT through a BuildKit `--mount=type=secret`, which never lands in a layer.
- **Product PRs target `staging`.** The image clones `staging`, and boot resets to `origin/staging`. Phase 20 opens against it.
- **One generic agent.** `boot` deliberately does not start a dev server, install anything app-specific, or know what a bug is. Which app to run is the model's judgment, expressed as a command.
- **Commit after every task.** Conventional prefixes.

## Depends on

Phase 00 Task 1 **GO** (recorded in the spike), Phase 09 (the registry, `auditedCapability`, the write guard, the generated `.d.ts`), and read access to `Zellify/web2app-rebuild`. Phase 19 and 20 consume this phase's output and are not started here.

## Ground truth about the monorepo — read before anything

Established by reading the repo on 2026-08-14. Several of these contradict what the roadmap assumed:

1. **There is no root `AGENTS.md`.** The brief's instruction resolves to **`CLAUDE.md`** (529 lines) at the repo root. That file is the source for everything below.
2. **pnpm is pinned to `9.12.2`** (`packageManager`, Volta, and `.npmrc` `engine-strict=true`). The spike's image baked `10.33.4`; that pin now fails the engine check. The image must ship 9.12.2.
3. **Node**: `engines.node: ">=18"`, Volta pins 22.22.3. The base image's Node 22.23.2 satisfies both.
4. **`pnpm build-packages` MUST run before the first dev or build** — workspace packages resolve from built `dist/`, not source. This is the expensive step baking exists to eliminate.
5. **Every `dev` script is Infisical-wrapped**: `infisical run --env=dev --path=/apps/<app> -- next dev --port <n>`. The container has no Infisical auth. The dev server is started by running the *inner* command directly, with env supplied by the Worker.
6. **`apps/web`'s dev script binds port 3000** — the sandbox's own control-server port, and the spike's worst trap (`waitForPort(3000)` succeeds against the sandbox itself and reports a server that was never running). Every server this agent starts must pass an explicit non-3000 `--port`.
7. **Ports:** web 3000, auth 3001, dashboard 3002, template-landing 3003, standalone-api 3005, docs 3010, attribution-worker 5555, storybook 6006. Use **4100+** for anything we start, to stay clear of both 3000 and the repo's own conventions.
8. **Redis is the only local service** (`docker/docker-compose.yml`). Docker-in-container is not available, so `redis-server` is baked and started as a plain process when something needs it. Supabase is remote — there is no local Supabase lane in the container.
9. **`apps/dashboard` dev asks for a 6 GB heap** (`NODE_OPTIONS=--max-old-space-size=6144`). `standard-4` has 12 GiB, so exactly one such server fits at a time. This is a real ceiling, not a comfortable one.
10. **Lint is Biome via Ultracite**, with a lefthook pre-commit hook. We never commit inside the container, so the hook never runs — which means edited files must be passed through `pnpm exec biome check --write` explicitly or the PR arrives unformatted.
11. **Branch flow:** `apps/agent` and sandbox-stack work merges to `staging`, which is deliberately not promoted to prod. `staging` exists and is the PR base.
12. **`pnpm check-types` is slow and the repo asks you not to run it unattended.** Prefer `pnpm --filter <pkg> check-types` on the touched package.

## The two findings that shaped this design

### 1. A Tier 1 execution has 20 seconds; container work does not

`PRODUCTION_LIMITS.wallTimeMs` is `20_000` and `MAX_WALL_TIME_MS` is `60_000`. The spike measured a *baked* boot at ~9.4 s to useful work on a stand-in repo, before any monorepo-specific catch-up, and `pnpm test` on a monorepo is minutes. A blocking `exec("pnpm test")` cannot fit and never will.

**Decision: do not raise the limits — change the shape.** Every slow operation returns a handle and the model polls it on a later `run_code` call, each with its own fresh budget. `boot()` is idempotent and *is* the poll (`provisioning` → `ready`). `spawn()` starts a process and returns immediately; `checkProcess()` reports on it. The agent loop already does multi-call reasoning, so "still building, check again" is a natural turn rather than an error path. Raising `wallTimeMs` toward the 60 s ceiling would buy one `pnpm install` and still lose to the test suite, while weakening a reviewed constant that protects every other namespace.

### 2. The full diff must never round-trip through the model

`toSafeJson` caps a result at `maxResultChars: 24_000`, and a real fix's diff plus context can exceed that. More importantly Phase 20 needs the diff to be **byte-exact** to build a commit, and anything that passes through the model's context can come back subtly altered.

**Decision: `diff()` returns a bounded preview plus an opaque `diffRef`.** The full diff is stored server-side in R2 under an internal prefix the public artifacts route refuses to serve. Phase 20's `github.openPR({ diffRef, … })` takes the ref, so the bytes travel Worker→Worker and the model never holds them. This also keeps `github.openPR`'s spec §6 signature honest — it takes a diff, not a repo handle; it just takes it by reference.

## Outcome

- `sandbox.boot()` from model-authored code returns `provisioning`, then `ready` with the checked-out commit, in seconds rather than minutes.
- `sandbox.spawn()` starts a dev server with Worker-injected dev env; `sandbox.preview(port)` returns a public URL that serves 200.
- `sandbox.spawn("pnpm test …")` + `sandbox.checkProcess()` runs the suite to completion across several agent turns.
- `sandbox.diff()` returns a preview and a `diffRef` that Phase 20 can turn into a PR.
- A run reaching a terminal status destroys its container; a crashed run's container is destroyed by the sweeper; neither leaks budget.
- The container holds no PAT, no Slack token, no GitHub token, no firefighter secret. `git fetch` works anyway.

## What this phase deliberately does not do

- **No Playwright, no recording, no R2 proof upload** — Phase 19. Chromium is *baked* here (a later image rebuild costs ~7 minutes) but nothing drives it.
- **No `github` namespace, no commit, no PR, no Linear ship-loop writes** — Phase 20. `diffRef` is the seam.
- **No `proxyToSandbox()` in the Worker's fetch handler.** Preview URLs come from `tunnels`, which bypass our origin entirely. Adding a host-matching interceptor in front of a `/slack/events` route that must answer inside 3 seconds is real risk for zero benefit. Recorded as a decision, not an omission.
- **No per-app knowledge in the binding.** No app registry, no "start the dashboard" capability, no port map in code. The port advice lives in `.d.ts` prose the model reads and may ignore.
- **No sandbox snapshots.** The spike measured image rebuild at ~57 s for a cached single-layer change; snapshots are the fallback the spec named and are not needed.
- **No multi-container fan-out.** One run, one container.

## Non-negotiable invariants

1. **No write credential enters the container.** The only credential it can reach is a placeholder; the real PAT is substituted in a Worker-side `outboundByHost` handler at egress, exactly as the spike proved.
2. **`boot` is idempotent.** Two concurrent `boot()` calls in one run produce one container and one provisioning job. A second call after `ready` is a cheap status read, not a re-provision.
3. **A sandbox belongs to exactly one run** (`run:{runId}`) and is never shared, reused across runs, or addressable by a model-supplied id. The model cannot name a container at all.
4. **Every container is destroyed.** Terminal run status destroys it; the sweeper destroys orphans; `sleepAfter` is the last backstop, never the plan.
5. **Dev-env values are supplied by the Worker, never by the model.** The model sets a boolean; it cannot read, print, or choose the values, and they are absent from the container's ambient environment.
6. **`exec` is bounded and truncating.** A hard `timeoutMs` ceiling well inside the execution budget, and output tailed to a documented cap with a visible marker. Unbounded output is how a capability result blows `maxResultChars` at the worst moment.
7. **The full diff never enters a model-visible value**, and its R2 key is never served by the public artifacts route.
8. **No secret material in any capability result, error, audit arg, or log** — including the dev-env keys' *values*; key *names* are fine and useful.

## The dev-env caveat — for the README's security section

The security model's claim is "the container holds no write credentials," and that stays exactly true. But a Next.js dev server cannot start without dev-tier read secrets, so while it runs, those values exist inside the container and model-authored `exec` could read them out of `/proc`. This is the same exposure as an engineer running `pnpm dev` on a laptop, it is dev-tier and not prod, and it is disjoint from every write path — but it must be written down rather than discovered, because the README's security section has to match the code. Mitigations that are real: values are injected per-process rather than into the container environment, they are never baked into the image, and they arrive from a Worker secret the model cannot name.

## Public contracts

```ts
// src/sandbox/lifecycle.ts
export type BootState = "provisioning" | "ready" | "failed";
export type BootStatus = {
  state: BootState;
  /** Commit the working tree is on, once ready. */
  commit: string | null;
  /** Absolute path of the checkout inside the container. */
  repoPath: string;
  elapsedMs: number;
  /** One human-readable line: which provisioning step is running, or why it failed. */
  note: string;
};
export interface SandboxLifecycle {
  /** Idempotent. First call provisions; later calls report. Never blocks on provisioning. */
  boot(runId: string): Promise<BootStatus>;
  /** Idempotent and safe on a run that never booted. */
  teardown(runId: string): Promise<void>;
  /** TCP-mode readiness. Rejects 3000 and anything outside 1024–65535. */
  waitForPort(runId: string, port: number, timeoutMs: number): Promise<boolean>;
  /** Tunnel URL, probed until it actually serves (~10 s) rather than on creation. */
  preview(runId: string, port: number): Promise<{ url: string }>;
}
export function makeSandboxLifecycle(env: Env): SandboxLifecycle;

/** Destroy containers for runs that are terminal or abandoned. Sweeper-driven. */
export async function sweepSandboxes(env: Env): Promise<{ destroyed: number }>;

// src/sandbox/env.ts
/** Parsed from the MONOREPO_DEV_ENV secret. Values never leave this module's callers. */
export function devEnvFor(env: Env): Record<string, string>;
/** Key names only — safe to log, safe to show the model. */
export function devEnvKeyNames(env: Env): string[];

// src/sandbox/diff.ts
export type DiffResult = { preview: string; truncated: boolean; filesChanged: number;
                           insertions: number; deletions: number; diffRef: string | null };
/** Stores the full diff under an internal R2 prefix and returns the ref. */
export async function captureDiff(env: Env, runId: string, raw: string): Promise<DiffResult>;
/** Phase 20's reader. Not reachable from any model-facing capability. */
export async function readDiff(env: Env, diffRef: string): Promise<string | null>;
```

### The `sandbox` namespace (nine methods)

Appended to `PHASE_09_NAMESPACES` — appended, never inserted, so the committed `.d.ts` diff stays readable. Method names are globally unique after PascalCase derivation; `test/codemode-dts.test.ts`'s uniqueness test will fail loudly the moment this namespace lands, which is exactly the moment the 2026-08-11 decision note predicted.

```ts
declare const sandbox: {
  boot(): Promise<BootStatus>;                       // idempotent; poll until ready
  exec(a: { cmd: string; cwd?: string; timeoutMs?: number; injectDevEnv?: boolean }):
    Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }>;
  spawn(a: { cmd: string; cwd?: string; injectDevEnv?: boolean }): Promise<{ processId: string }>;
  checkProcess(a: { processId: string }):
    Promise<{ running: boolean; exitCode: number | null; stdoutTail: string; stderrTail: string }>;
  killProcess(a: { processId: string }): Promise<{ killed: boolean }>;
  readFile(a: { path: string }): Promise<{ content: string; truncated: boolean }>;
  writeFile(a: { path: string; content: string }): Promise<{ bytesWritten: number }>;
  preview(a: { port: number }): Promise<{ url: string }>;
  diff(): Promise<DiffResult>;
};
```

### The fourth effect class

`CAPABILITY_EFFECTS` gains `sandbox_write`: *mutates an ephemeral machine this run owns; invisible to every customer and colleague; gated by neither channel policy nor shadow.* `assertEffectPermitted` already passes through everything that is not `external_write`, so the guard needs no new branch — but the class must exist rather than being smuggled in as `read`, because `read` promises "changes nothing there" and `exec` plainly does.

**Shadow runs may boot containers.** A shadow bug run that cannot reproduce produces a draft worth nothing, and measuring the real draft is the entire point of Phase 21's shadow corpus. The cost lever, if the drill shows pain, is one line in `assertEffectPermitted` — named here so it is a choice rather than a rediscovery.

### Secrets and configuration

Secrets (`wrangler secret put`, names only):
- `MONOREPO_PAT` — fine-grained, `Zellify/web2app-rebuild`, Contents: read-only. Used by the egress swap at runtime and by the image build as a BuildKit secret.
- `MONOREPO_DEV_ENV` — JSON object of dev-tier env values for the monorepo's apps.

Vars (`wrangler.jsonc`, non-secret): `SANDBOX_REPO_PATH` (`/workspace/web2app-rebuild`), `SANDBOX_GIT_HOST` (the sentinel), `SANDBOX_SLEEP_AFTER` (`45m`), `SANDBOX_MAX_INSTANCES`.

## File structure

- Create: `apps/worker/sandbox/Dockerfile`, `apps/worker/sandbox/provision.sh`, `apps/worker/src/sandbox/class.ts`, `src/sandbox/lifecycle.ts`, `src/sandbox/env.ts`, `src/sandbox/diff.ts`, `src/codemode/bindings/sandbox.ts`
- Create tests: `test/sandbox-lifecycle.test.ts`, `test/sandbox-env.test.ts`, `test/sandbox-diff.test.ts`, `test/codemode-sandbox.test.ts`
- Modify: `src/codemode/write-guard.ts` (fourth effect), `src/codemode/registry.ts` (namespace + build), `src/codemode/generated/*.d.ts` (regenerated), `src/index.ts` (export `Sandbox`/`ContainerProxy`; sweeper), `src/api/artifacts.ts` (refuse the internal prefix), `src/run/do.ts` (terminal status → teardown), `apps/worker/wrangler.jsonc` (containers, DO binding, migration `v2`, vars), `.dev.vars.example`
- Extend: `test/codemode-dts.test.ts`, `test/codemode-contracts.test.ts`, `test/codemode-security.test.ts`
- Docs: `docs/superpowers/plans/phase-18-notes.md` (measurements + invented APIs)

The Dockerfile sits under `apps/worker/` because wrangler resolves `image` relative to its own config file. The roadmap's `sandbox/Dockerfile` meant the same thing before the worker moved into `apps/`.

## Execution speed rules — READ BEFORE DISPATCHING ANY TASK

1. **Focused tests by exact path:** `cd apps/worker && pnpm exec vitest run test/<exact-file>.test.ts`. Never a pattern.
2. **One `pnpm exec tsc --noEmit -p tsconfig.json` per task**, at the end.
3. **The full suite runs exactly once** — Task 8, before the live proof.
4. **Container I/O is stubbed in every unit test.** No test boots a real container; Tasks 1 and 8 are the only places real containers run, and both are manual.
5. **Read the installed `.d.ts` before writing any SDK call.** `@cloudflare/sandbox`'s docs pages are hubs; the spike found the type declarations were the only reliable source, and `interceptHttps`/`sleepAfter`/`outboundByHost` live on `Container` in `@cloudflare/containers`, not on `Sandbox`. Every API the model invents goes in `phase-18-notes.md`.
6. **Review depth:** deep for Tasks 2, 3 and 5 (credential path, env injection); medium for 4, 6, 7; light for 1.

### Parallel wave schedule

| Wave | Tasks (concurrent) | Why safe |
|---|---|---|
| A | **1** (manual/external) ∥ **2** | the ask + measurement is human-paced; the Dockerfile needs only the PAT |
| B | **3** ∥ **6** | worker wiring vs the diff module + artifacts guard — disjoint files |
| C | **4** ∥ **5** | lifecycle owns `src/sandbox/lifecycle.ts`; env owns `src/sandbox/env.ts` |
| D | **7** | the namespace, assembled over modules that already exist |
| E | **8** | full gate, then live proof — serial by nature |

**The namespace is built last, on purpose.** Tasks 4, 5 and 6 produce pure, independently testable modules (`lifecycle.ts`, `env.ts`, `diff.ts`) and **none of them touches `bindings/sandbox.ts`**. Task 7 is the only writer of that file, so three subagents can run without a merge conflict and the binding is assembled once, over surfaces that already have tests.

## Task order

### Task 1 — External unblocks and ground-truth measurement

Human-paced and started first, because everything downstream is cheaper once the numbers are real. No code.

- [ ] **Step 1: Post the env ask in `#eng-firefighter`.** Request either an Infisical machine identity with read on `dev` for `/shared`, `/apps/web` and `/apps/dashboard`, or a one-time `infisical export --env=dev` for those paths — stating that it is stored as a Worker secret and injected into a sandbox at boot, never baked into an image and never committed. Record the answer and its date in `phase-18-notes.md`.
- [ ] **Step 2: Create the fine-grained PAT** on your own account: resource owner Zellify, only `web2app-rebuild`, Contents read-only. If the org blocks or holds fine-grained tokens for approval, ask in the same channel; note in `phase-18-notes.md` whether a classic PAT had to be used and what that widens.
- [ ] **Step 3: `wrangler secret put MONOREPO_PAT`.** Confirm by name only.
- [ ] **Step 4: Re-run the spike's six numbers against the real monorepo.** Point `spikes/sandbox`'s `TARGET_REPO` at `web2app-rebuild` (with the PAT as a BuildKit secret), rebuild, and measure: cold boot, `git fetch`, `pnpm install --prefer-offline`, `pnpm build-packages` (cold **and** warm — this is the number that decides whether baking is sufficient), a dev server reaching listening state on port 4100, and image build+push time. This is the roadmap's named unknown — *can a `standard-4` run Zellify's monorepo* — being answered.
- [ ] **Step 5: Record disk and memory headroom** after a full install plus one dev server. 18 GB disk and 12 GiB memory are the ceilings; `apps/dashboard` alone asks for a 6 GB heap.
- [ ] **Step 6:** Write everything into `phase-18-notes.md` under "Measured against the real monorepo". If `build-packages` cold exceeds ~3 minutes, say so explicitly — it is the number that justifies the full bake. Commit: `docs(sandbox): measure the real monorepo on a standard-4 container`

### Task 2 — The baked image

**Files:** create `apps/worker/sandbox/Dockerfile`, `apps/worker/sandbox/provision.sh`.

- [ ] **Step 1: Read** `docs/superpowers/spikes/2026-08-10-sandbox.md` §1 and §3, and `spikes/sandbox/Dockerfile`. Start from that file rather than from memory.
- [ ] **Step 2: Write the multi-stage Dockerfile.**
  - Base tag **must equal the installed `@cloudflare/sandbox` version exactly** — a mismatch is a silent protocol skew, not a build error.
  - Stage 1 clones `web2app-rebuild` at `staging`, depth 1, using `RUN --mount=type=secret,id=monorepo_pat` so the credential never lands in a layer.
  - Final stage: copy the checkout in, `npm i -g pnpm@9.12.2` (**not** 10.x — `engine-strict=true` plus the `packageManager` pin), `pnpm install`, `pnpm build-packages`, `npm i -g playwright@<pinned>` + `playwright install --with-deps chromium`, `apt-get install redis-server`, `ENV NODE_PATH=/usr/local/lib/node_modules`, `EXPOSE 4100 4101 4102` (never 3000).
  - Repo path `/workspace/web2app-rebuild`, matching `SANDBOX_REPO_PATH`.
- [ ] **Step 3: Write `provision.sh`** — the boot-time catch-up the lifecycle invokes: `git fetch` + `reset --hard origin/staging`, `pnpm install --prefer-offline`, incremental `pnpm build-packages`, each step echoing a single parseable progress line so `BootStatus.note` can report which one is running. It must be idempotent and safe to re-run.
- [ ] **Step 4: Build it** with `DOCKER_BUILDKIT=1 --secret id=monorepo_pat,env=...` and confirm the PAT appears in **no** layer: `docker history --no-trunc` plus a `grep` across an exported filesystem. This assertion is the whole point of the multi-stage build; record the result in the notes.
- [ ] **Step 5: Record the image size and build time** in `phase-18-notes.md`. Commit: `feat(sandbox): baked image with the monorepo, pnpm 9.12.2 and Chromium`

### Task 3 — Worker-side wiring and the credential swap

**Files:** create `apps/worker/src/sandbox/class.ts`; modify `src/index.ts`, `apps/worker/wrangler.jsonc`, `.dev.vars.example`.

- [ ] **Step 1: Read** `spikes/sandbox/src/sandbox-class.ts` and `docs/inspired-from-ronit.md` §7.
- [ ] **Step 2: The `Sandbox` class.** Extend `BaseSandbox<Env>`, `interceptHttps = true`, `sleepAfter: string | number = SANDBOX_SLEEP_AFTER` — **keep the `string | number` type**; narrowing to `string` breaks assignability to `SandboxEnv<Sandbox<any>>` and surfaces the error far from the cause. Re-export `ContainerProxy` from the Worker entrypoint or interception fails at runtime.
- [ ] **Step 3: The git credential swap.** A sentinel host (`git.firefighter.local`) whose handler rewrites the request to `https://github.com/...` carrying `Authorization: Basic base64("x-access-token:" + MONOREPO_PAT)`. Prefer the runtime **`setOutboundByHost`** per-instance API over agent-os's module-scope static — the spike found it and our credential is per-run. Registered **only** for the sentinel; no catch-all `outbound`, no `allowedHosts`/`deniedHosts`, so R2, npm and apt flow direct through the container's own namespace.
- [ ] **Step 4: wrangler config.** `containers` entry (`class_name: "Sandbox"`, `image: "./sandbox/Dockerfile"`, `instance_type: "standard-4"`, `max_instances` from the budget), DO binding `SANDBOX`, `migrations` gains `{ "tag": "v2", "new_sqlite_classes": ["Sandbox"] }` alongside RunDO's `v1`, plus the four vars. **Do not** add `proxyToSandbox` to the fetch handler — see "What this phase deliberately does not do".
- [ ] **Step 5: Deploy and verify the swap live** — from a container, `git ls-remote` through the sentinel succeeds; then `grep` `/workspace`, `/tmp`, `/etc/environment` and the process environment for the PAT and assert **zero** occurrences. Mirror the spike's discipline: the container receives a verdict, never a reflection of its own egress.
- [ ] **Step 6: Typecheck + `wrangler deploy --dry-run`.** Commit: `feat(sandbox): container class, sentinel-host credential swap, wrangler wiring`

### Task 4 — Lifecycle: idempotent boot, teardown, sweeper, readiness

**Files:** create `src/sandbox/lifecycle.ts`, `test/sandbox-lifecycle.test.ts`; modify `src/run/do.ts`, `src/index.ts`. **Does not touch `bindings/sandbox.ts`.**

- [ ] **Step 1: Failing tests** against a stubbed sandbox SDK. `boot`: first call returns `provisioning` and starts provisioning exactly once; a concurrent `Promise.all` pair still starts it once (single-flight); polling returns `ready` with a commit once `provision.sh` exits 0; a failing provision returns `failed` with the failing step in `note` and does **not** retry forever; `boot` after `ready` performs no provisioning work. `teardown`: destroys, is idempotent, and is safe for a run that never booted. `sweepSandboxes`: destroys containers for runs whose D1 status is terminal, leaves live runs alone, and tolerates a destroy that throws (one bad container must not stop the sweep).
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** `getSandbox(env.SANDBOX, \`run:${runId}\`, { transport: "rpc" })` — **`transport: "rpc"` is required for `tunnels.*`** and throws at call time, not construction, without it. Provisioning runs `provision.sh` as a background process; state is read from the process rather than stored anywhere new. `killAllProcesses()` before any server start, since a process that failed `waitForPort` is not reaped and holds its port, masking the real error with `EADDRINUSE`.
- [ ] **Step 4:** Wire terminal run status in `src/run/do.ts` to `teardown`, and `sweepSandboxes` into the existing scheduled sweep via `Promise.allSettled` alongside the memory, approval and nudge sweeps.
- [ ] **Step 5: Readiness and preview helpers**, exported from the same module for the namespace to call later. `waitForPort` in **`mode: 'tcp'`**: the default `http` mode demands a success status, so an app that 500s on missing config is listening but reads as dead — precisely the state we most need to distinguish. `preview` uses `tunnels.get(port)` under the RPC transport and **retries the probe for ~10 s**, because a fresh tunnel returns 530 while it propagates and a single probe reads as a broken tunnel. Both rejected for port 3000 and for anything outside 1024–65535.
- [ ] **Step 6: Run tests + typecheck, verify PASS.** Commit: `feat(sandbox): per-run lifecycle with single-flight boot and swept teardown`

### Task 5 — Dev env injection

**Files:** create `src/sandbox/env.ts`, `test/sandbox-env.test.ts`. **Pure module — touches nothing else.**

- [ ] **Step 1: Failing tests.** `devEnvFor` parses `MONOREPO_DEV_ENV`, rejects a malformed blob loudly at composition rather than at first use, and returns `{}` when unset (so `injectDevEnv: true` later fails readably instead of starting a server that dies on missing config). `devEnvKeyNames` returns names only. The injection helper produces a per-process env record and **never** a container-wide mutation — assert the container-wide setter is not called. No value appears in any return, error, or log: assert over `JSON.stringify` of every outcome, including failure paths.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests + typecheck, verify PASS.** Commit: `feat(sandbox): per-process dev env injection, values never model-visible`

### Task 6 — Diff capture and the internal artifact prefix

**Files:** create `src/sandbox/diff.ts`, `test/sandbox-diff.test.ts`; modify `src/api/artifacts.ts`. **Does not touch `bindings/sandbox.ts`.**

- [ ] **Step 1: Read** `src/api/artifacts.ts` and `src/codemode/bindings/files.ts` to learn the existing R2 key scheme, so the internal prefix cannot collide with a published artifact.
- [ ] **Step 2: Failing tests.** `captureDiff` stores the full text in R2 and returns a preview bounded well inside `maxResultChars` with `truncated: true` and correct file/insertion/deletion counts; an empty diff returns `diffRef: null` and a preview saying so (an empty change is a fact the model must be able to act on, not an error); a diff beyond a hard ceiling is refused with a readable reason rather than silently truncated into a broken patch. `readDiff` round-trips the exact bytes. The artifacts route returns 404 for any key under the internal prefix — **the leak test**: a private monorepo's diff must not be fetchable from the public artifacts URL.
- [ ] **Step 3: Run, verify FAIL.**
- [ ] **Step 4: Implement.** The in-container command is `git add -A -N && git diff` — intent-to-add so new files appear in the diff without staging their content, which is what makes a from-scratch file survive to Phase 20.
- [ ] **Step 5: Run tests + typecheck, verify PASS.** Commit: `feat(sandbox): diff capture by reference, never through the model`

### Task 7 — The `sandbox` namespace

Assembles Tasks 4–6 into the model-facing surface. The only writer of `bindings/sandbox.ts`.

**Files:** create `src/codemode/bindings/sandbox.ts`, `test/codemode-sandbox.test.ts`; modify `src/codemode/write-guard.ts`, `src/codemode/registry.ts`; regenerate `src/codemode/generated/*.d.ts`; extend `test/codemode-dts.test.ts`, `test/codemode-contracts.test.ts`.

- [ ] **Step 1: Failing tests.** The fourth effect: `CAPABILITY_EFFECTS` contains `sandbox_write`; `assertEffectPermitted` passes it through for both a shadow run and an `observe` channel (assert explicitly — this is the deliberate call, so it earns a test that states it); `assertClassified` still rejects an unbranded descriptor. The namespace: every method is `sandbox_write`; `exec` truncates over-long stdout with a visible marker and returns `truncated: true`; `exec` rejects a `timeoutMs` above the ceiling rather than clamping silently; `readFile` truncates; `preview` rejects port 3000 and any port outside 1024–65535 with a readable reason naming the control-server trap; a capability call before `boot` fails with a code telling the model to boot first; `PHASE_09_NAMESPACES` gained `sandbox` at the **end**; the generated `.d.ts` has globally unique method names and no `= unknown` block.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** Every method through `auditedCapability`. Write the doc comments as guidance the model will actually act on: never port 3000; dev scripts are Infisical-wrapped so run the inner command and pass `injectDevEnv`; `spawn`+`checkProcess` for anything over a few seconds; run `pnpm exec biome check --write` on edited files before `diff()`; prefer `pnpm --filter <pkg> check-types` over the repo-wide one.
- [ ] **Step 4: Regenerate the `.d.ts`** with `pnpm codemode:dts` and verify `pnpm codemode:dts:check` is clean.
- [ ] **Step 5: Run tests + typecheck, verify PASS.** Commit: `feat(codemode): the sandbox namespace and the sandbox_write effect class`

### Task 8 — Full gate and live integrated proof

- [ ] **Step 1: Full gate, once:** `cd apps/worker && pnpm exec vitest run && pnpm exec tsc --noEmit -p tsconfig.json && pnpm lint && pnpm exec wrangler deploy --dry-run`.
- [ ] **Step 2: Deploy**, confirm `/api/health`, and put both secrets in production.
- [ ] **Step 3: Hand-written snippet first.** One `run_code` block through the existing execution path: `boot()` polled to `ready`, `exec("git log -1 --oneline")`, `spawn` a dev server on 4100 with `injectDevEnv`, `preview(4100)` probed to 200, `spawn("pnpm --filter @web2app/<app> test")` polled to exit 0, `writeFile` a trivial change, `diff()` returning a preview and a ref. Record wall-clock per step.
- [ ] **Step 4: Then a real agent run** in `#test-firedrill` — the model reaching for the sandbox on its own, from a message that needs it. This is the exit criterion the roadmap wrote: *all from model-authored code*. Watch it in the Phase 15 drawer.
- [ ] **Step 5: Prove teardown.** Terminal status destroys the container; kill a run mid-flight and confirm the sweeper destroys the orphan. Note the container-hours spent so far against the $500 ceiling.
- [ ] **Step 6: Record** measurements, every invented API, and the live evidence in `phase-18-notes.md`. Commit: `docs(sandbox): record phase 18 live verification`

## Test matrix

| Row | Proven by |
|---|---|
| PAT absent from every image layer and from the running container | Task 2 Step 4, Task 3 Step 5 |
| `git fetch` works with no credential inside | Task 3 Step 5 |
| Boot is single-flight and idempotent under concurrency | Task 4 |
| Every container is destroyed — terminal, orphan, and backstop | Task 4, Task 8 Step 5 |
| Long work survives the 20 s execution budget | Task 7 (`spawn`/`checkProcess`), Task 8 Step 3 |
| Port 3000 refused with the reason named | Task 4 (readiness/preview), Task 7 (the schema) |
| Dev-env values never reach the model, the logs, or the ambient env | Task 5 |
| A tunnel is not called dead before it has propagated | Task 4 Step 5 |
| The full diff is byte-exact, bounded, and not publicly fetchable | Task 6 |
| The generated `.d.ts` stays unique and typechecks | Task 7 Step 4 |

## Exit criteria

The agent boots a machine, gets the monorepo dev server serving, and runs the test suite — all from model-authored code, on a deployed Worker, in a live `#test-firedrill` run. The container holds no write credential, proven by grep. Boot to useful work is measured and recorded. The full local gate is green and `phase-18-notes.md` carries the numbers, the invented APIs, and the live evidence.

## Downstream handoff

- **Phase 19** inherits Chromium already baked (no image rebuild), `spawn`/`checkProcess` for a Playwright run that outlives one execution, and `files.publish` for the recording. Its only image change should be the transcode tool.
- **Phase 20** consumes `diffRef` — `github.openPR` reads the diff Worker-side via `readDiff` and never asks the model for bytes. `staging` is confirmed as the base branch, and the repo's PR conventions live in `CLAUDE.md`.
- **Phase 21** gets sandbox-capable shadow runs, and the cost lever named in "The fourth effect class" if the corpus proves expensive.
- **Phase 23** gets the dev-env caveat as written prose for the README's security section, plus container-hours for the cost breakdown.
