# Phase 00 — Spikes: Sandbox and Worker Loader

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Written go/no-go findings on the two platform surfaces that decisions D5 and D1 rest on, before a single line of production code depends on either.

**Depends on:** nothing · **Day 1** · **Gates:** Phases 09, 10 (Worker Loader) and 18, 19 (Sandbox)

**Docs MCP:** Cloudflare Workers (Worker Loader, `ctx.exports`, `RpcTarget`) · Cloudflare Sandbox / Containers. See `00-roadmap.md` → *Docs / API MCP servers*. This phase is the single strongest case for attaching them — both surfaces are exactly where the model invents APIs.

**Why first:** both surfaces have training data thin enough that a coding agent will confidently invent APIs for them. Discovering on day 5 that the Tier 1 isolate *can* reach the network, or that a container cannot run the monorepo, loses the week. Discovering it today costs half a day and produces a graded deliverable — the README's AI-tool notes are assembled from exactly this material.

**Not blocked on the monorepo invite.** If [`Zellify/web2app-rebuild`](https://github.com/Zellify/web2app-rebuild) isn't accessible yet, spike against any mid-sized public pnpm monorepo — what is being measured is the platform's ceiling, not Zellify's code. See `00-roadmap.md` → *Repos and access*.

**Global constraints** from `00-roadmap.md` apply.

---

## File Structure

```
spikes/sandbox/                              throwaway worker, committed for the AI-tool notes
spikes/worker-loader/                        throwaway worker, committed
docs/superpowers/spikes/2026-08-10-sandbox.md        findings — GO/NO-GO on D5
docs/superpowers/spikes/2026-08-10-worker-loader.md  findings — GO/NO-GO on D1
```

Spike code is committed deliberately. It is evidence for the interview and raw material for the README, and it costs nothing to keep.

---

### Task 1: Read the Sandbox docs and scaffold the spike

**Files:** Create `spikes/sandbox/`

**Interfaces:**
- Consumes: nothing
- Produces: a deployable spike worker that can boot a container

- [ ] **Step 1: Read, in this order — do not write code from memory**

- https://developers.cloudflare.com/sandbox/ — overview
- https://developers.cloudflare.com/sandbox/api/ — the actual method surface
- https://developers.cloudflare.com/containers/platform-details/limits/ — instance types
- https://developers.cloudflare.com/agents/tools/sandbox/ — `getSandbox(this.env.Sandbox, name)` binding shape

Record any API you expected to exist that does not. That list is a deliverable.

- [ ] **Step 2: Scaffold**

```bash
mkdir -p spikes/sandbox && cd spikes/sandbox
pnpm init
pnpm add @cloudflare/sandbox
pnpm add -D wrangler@4.120.0
```

- [ ] **Step 3: Read the installed types — these are ground truth**

```bash
find node_modules/@cloudflare/sandbox -name '*.d.ts' | head -20
```

The `.d.ts` files outrank any blog post, tutorial, or model recollection. Where they disagree with Step 1's docs, the types win.

- [ ] **Step 4: Configure `wrangler.jsonc`**

Container with instance type `standard-4` (4 vCPU / 12 GiB / 20 GB), a Dockerfile on a Node 22 base, and the Sandbox Durable Object binding. Exact shape from Steps 1 and 3.

- [ ] **Step 5: Boot a container and run one command**

Prove the whole chain works before measuring anything: `exec("echo hello")` returning `hello` through the Worker.

- [ ] **Step 6: Commit**

```bash
git add spikes/sandbox
git commit -m "spike(sandbox): scaffold and first container boot"
```

---

### Task 2: Measure the six numbers that decide D5

**Files:** Modify `spikes/sandbox/`

**Interfaces:**
- Consumes: Task 1's booting container
- Produces: six wall-clock measurements

- [ ] **Step 1: Pick the repo to measure against**

The real target is **[`Zellify/web2app-rebuild`](https://github.com/Zellify/web2app-rebuild)** — the product monorepo the agent fixes bugs in. If your invite has landed, use it and the numbers are real.

If it hasn't, **do not wait.** Use any mid-sized public pnpm monorepo with a dev server; what this task measures is the platform's ceiling, not Zellify's code. Re-run against the real repo in Phase 18 and record both numbers.

- [ ] **Step 2: Measure cold, in order, recording wall-clock seconds for each**

1. Container cold boot — first request, image already pushed
2. `git clone` of the target repo
3. `pnpm install` with no store
4. Dev server up and serving HTTP 200 on its port
5. Chromium launch + navigate + `recordVideo` producing a playable file

- [ ] **Step 3: Bake the image and measure warm**

Rebuild the Dockerfile with the repo pre-cloned, the pnpm store warm, and Chromium preinstalled. Re-measure:

6. `pnpm install --prefer-offline` against the warm store

**This is the number Phase 18 lives or dies on.** The drill is timed by a human watching a Slack thread. Eight minutes is a fail; one minute is fine.

- [ ] **Step 4: Record image rebuild time**

How long a Dockerfile change takes to rebuild and push. If it is slow, Phase 18 needs to treat the image as near-frozen.

- [ ] **Step 5: Commit**

```bash
git add spikes/sandbox
git commit -m "spike(sandbox): cold and warm timings for the repro loop"
```

---

### Task 3: Test the three capabilities Phase 19 depends on

**Files:** Modify `spikes/sandbox/`

**Interfaces:**
- Consumes: Task 2's baked image
- Produces: pass/fail on each capability

- [ ] **Step 1: Preview URLs**

`sandbox.tunnels.get(port)` returns a URL that is actually reachable from outside. Fetch it and assert a 200.

- [ ] **Step 2: Long-running process alongside exec**

Start the dev server as a background process, then run `exec` calls against the container while it stays up. Confirm the server survives and the exec calls return.

This is the shape of the entire repro loop — a server running while Playwright drives it.

- [ ] **Step 3: Diff extraction**

Make a file edit, run `git diff`, and return the output to the Worker as a string.

**This is the whole credential story from D5.** The container emits a diff; the Worker opens the PR. If a diff cannot cross that boundary cleanly, Phase 20's design changes.

- [ ] **Step 4: Record results and commit**

```bash
git add spikes/sandbox
git commit -m "spike(sandbox): preview urls, long-running processes, diff extraction"
```

---

### Task 4: Probe `interceptHttps` / `outboundByHost`

**Files:** Modify `spikes/sandbox/`

**Interfaces:**
- Produces: a verified-or-not verdict on the credential-swap primitive

**This is now adaptation, not discovery.** `rtpa25/agent-os` runs it in production — see `docs/inspired-from-ronit.md` §7. The known-good shape:

```ts
import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";

export const PD_PROXY_HOST = "proxy.firefighter.local";

export class Sandbox extends BaseSandbox<Env> {
  sleepAfter = SLEEP_AFTER_MS;   // SDK default is '10m' — too short for a repro
  interceptHttps = true;          // without this, only http:// routes through outbound
}

// STATIC field, set at module scope. The SDK reads it at construction time.
Sandbox.outboundByHost = { [PD_PROXY_HOST]: async (request, env) => { /* ... */ } };
```

- [ ] **Step 1: Adopt the sentinel-host pattern, not a catch-all**

Configuring **only** `outboundByHost` — no static `outbound`, no `allowedHosts`/`deniedHosts` — puts the SDK in per-host mode. Hosts outside the registry (R2, GitHub, npm, apt mirrors) flow direct through the container's network namespace and never enter Worker fetch.

That matters: **Worker fetch normalizes `Content-Length` on HEAD responses.** agent-os confirmed on a dedicated probe branch that the SDK overwrites it even when the handler sets it explicitly, which broke their s3fs-on-R2 mount. Route the minimum through interception.

- [ ] **Step 2: Confirm the swap works**

Register a handler for one sentinel host, send a request through it from inside the container with a placeholder credential, and confirm the real value is substituted on egress and never visible inside.

- [ ] **Step 3: Set `sleepAfter` deliberately**

The SDK default is 10 minutes. A container that naps mid-repro is a drill failure. Pick a value against the Task 2 timings.

- [ ] **Step 4: Record the outcome**

If the primitive behaves differently than agent-os found, write that down — it means a version drift worth knowing about. The fallback ladder remains spec §8.3: Worker-side git HTTP proxy via `http.proxy`, then a 1-hour read-only installation token.

- [ ] **Step 4: Commit**

```bash
git add spikes/sandbox
git commit -m "spike(sandbox): interceptHttps credential swap probe"
```

---

### Task 5: Write the Sandbox findings and call D5

**Files:** Create `docs/superpowers/spikes/2026-08-10-sandbox.md`

**Interfaces:**
- Consumes: Tasks 1–4
- Produces: **GO or NO-GO on decision D5**, consumed by Phase 18

- [ ] **Step 1: Write the findings document**

It must contain, concretely:

- The six timings from Task 2, cold and warm
- Image rebuild time
- Pass/fail on each Task 3 capability, with the failure mode where it failed
- The `interceptHttps` result from Task 4
- **A GO or NO-GO on decision D5**, stated in one line
- If NO-GO: which fallback (E2B) and precisely what changes in Phases 18–20
- **Every API the model confidently invented that did not exist** — this feeds the README's AI-tool notes, a graded deliverable

- [ ] **Step 2: If NO-GO, update the roadmap**

Amend `00-roadmap.md` Phase 18 to name the replacement provider. Do not leave two designs in flight.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/spikes/2026-08-10-sandbox.md
git commit -m "spike(sandbox): findings and go/no-go on tier 2 provider"
```

---

### Task 6: Read the Worker Loader docs and load an isolate

**Files:** Create `spikes/worker-loader/`

**Interfaces:**
- Produces: an isolate loaded from a string, returning a value

**Read `docs/inspired-from-ronit.md` first.** Ronit runs Worker Loader in production in both his repos, and §1–§6 there record the API shape and four failure modes already paid for. This task is now largely confirmation.

The real type, from `worker-configuration.d.ts`:

```ts
interface WorkerLoader {
  get(name: string | null, getCode: () => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>): WorkerStub;
  load(code: WorkerLoaderWorkerCode): WorkerStub;
}

interface WorkerLoaderWorkerCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, WorkerLoaderModule | string>;
  env?: any;
  globalOutbound?: Fetcher | null;
  limits?: { cpuMs?: number; subRequests?: number };
}
```

- [ ] **Step 1: Confirm the binding is available on YOUR account**

This is the one part Ronit's repos cannot answer — his account has beta access, yours may not. Worker Loader is beta; check whether it needs a flag or an allowlist **before** building on it. If gated, request access immediately; that lead time is the entire risk.

Wrangler config is one line:

```jsonc
"worker_loaders": [{ "binding": "LOADER" }]
```

- [ ] **Step 2: Load an isolate that returns a constant**

Minimal proof: load a module from a string, call it, get a value back through the Worker.

- [ ] **Step 3: Use `load()`, not `get()`, and understand why**

`get(name, cb)` caches by name and **only invokes the callback on a miss**. Reuse a name with different code and you silently execute the *old* bundle — which presents as "my edit didn't take effect," the worst symptom to debug under time pressure. Ronit's convention is a version-bumped key: `sync:<id>:v<version>`.

Agent-authored code is unique per execution and has nothing to cache, so Phase 09 uses `load()`. Confirm both APIs behave as typed.

- [ ] **Step 4: Commit**

```bash
git add spikes/worker-loader
git commit -m "spike(loader): scaffold and load an isolate from a string"
```

---

### Task 7: Inject an RPC binding and prove credentials stay out

**Files:** Modify `spikes/worker-loader/`

**Interfaces:**
- Produces: the confirmed `env` injection shape that Phase 09 generates `.d.ts` against

Two rules from `docs/inspired-from-ronit.md` §2–§4, both paid for in someone else's debugging time:

> **Stubs go on `env`, never on `globalOutbound`.** A service stub set as `globalOutbound` on a bundle invoked via `entrypoint.run()` trips workerd's result-marshalling — every call fails with *"This ServiceStub cannot be serialized"* before user code runs. The same stubs on the isolate's `env` are fine.

> **Raw DO stubs cannot cross the boundary. `RpcTarget` subclasses can.** Passing a DO stub directly fails with an opaque `"internal error; reference = ..."`.

And the canonical construction shape is `ctx.exports`, not raw service bindings:

```ts
env: {
  SLACK: ctx.exports.SlackBinding({ props: { runId, onDutyUserId } }),
}
```

- [ ] **Step 1: Hold a secret in the parent Worker**

The parent has a secret. Expose one `WorkerEntrypoint` method that uses it and returns a derived value — never the secret.

- [ ] **Step 2: Inject via `ctx.exports.X({ props })` and call it from inside the isolate**

Confirm the isolate calls the method and receives the result. Note that props are how a binding learns *which engineer it acts as* — the agent never passes an identity, so it cannot spoof one.

- [ ] **Step 3: Wrap a DO stub in an `RpcTarget` and cross the boundary with it**

Phase 09's `memory` and `escalate` bindings reach back into `RunDO`. Prove the pattern now:

```ts
import { RpcTarget } from "cloudflare:workers";

class RunBridge extends RpcTarget {
  #run: DurableObjectStub;
  constructor(run: DurableObjectStub) { super(); this.#run = run; }
  async escalate(draft: unknown, why: string) { return this.#run.escalate(draft, why); }
}
```

- [ ] **Step 4: Test against DEPLOYED, not just `wrangler dev`**

agent-os hit a binding that **`wrangler dev` accepted and production rejected** — the raw `env.BROWSER` stub, which needed wrapping in a `WorkerEntrypoint` to survive marshalling. Any binding validated only locally is unvalidated. Deploy the spike and run it remotely before recording a pass.

- [ ] **Step 3: Try to read the secret from inside the isolate**

Enumerate `env`, walk the binding object, attempt property access. **The secret value must be unreachable.** Record exactly what is visible from inside — that inventory is what spec §8.1 claims, and the README must not claim more than this step proves.

- [ ] **Step 4: Record the exact injection shape**

Phase 09 generates `.d.ts` against this. Write down the real signature, not the remembered one.

- [ ] **Step 5: Commit**

```bash
git add spikes/worker-loader
git commit -m "spike(loader): rpc binding injection, secret unreachable from isolate"
```

---

### Task 8: Prove the isolate cannot reach the network

**Files:** Modify `spikes/worker-loader/`

**Interfaces:**
- Produces: the empirical basis for spec §8.1 — or its refutation

Decision D1's entire security story is this property. `docs/inspired-from-ronit.md` §1 found that it is **a first-class field**, not an emergent behavior:

```ts
globalOutbound: null,   // native fetch stays blocked
```

So this task is now "set one field and assert it," not "discover what happens." The assertion still gets written and still gets its own commit — **it is the README's security section**, and a security claim with no test behind it is a claim you cannot make.

Note where our design is narrower than agent-os: theirs sets `globalOutbound: null` and then hands the isolate `env.PROXY`, a general credentialed fetch surface, because its agent needs arbitrary outbound HTTP. Ours gets typed per-integration bindings and **no general fetch surface at all**.

- [ ] **Step 1: Set `globalOutbound: null` and attempt an outbound fetch from inside the isolate**

```js
await fetch("https://example.com");
```

Record **exactly** what happens: throws (with what message), hangs, or succeeds.

- [ ] **Step 2: Attempt the other escape routes**

```js
new WebSocket("wss://example.com");
```

Plus a `fetch` to a Cloudflare-internal address, and a `fetch` to the parent Worker's own hostname.

- [ ] **Step 3: If any of these succeed, stop and escalate**

**A successful fetch means decision D1's security model is wrong.** The fallback in spec §12 applies: run the code-mode isolate as a separate Worker with no outbound bindings and a service binding back. Amend the roadmap before continuing.

- [ ] **Step 4: Commit**

```bash
git add spikes/worker-loader
git commit -m "spike(loader): network isolation verified empirically"
```

---

### Task 9: Measure what the agent loop will pay

**Files:** Modify `spikes/worker-loader/`

**Interfaces:**
- Produces: latency budget for Phase 10's loop

- [ ] **Step 1: Time isolate load + execute, cold and warm**

The agent may run several code blocks per turn. If cold load is slow, Phase 10 needs to keep isolates warm per run.

- [ ] **Step 2: Confirm `console.log` capture**

Phase 09 feeds both logged output and the return value back to the model as the tool result. Confirm both can be captured, and note the size ceiling on each.

- [ ] **Step 3: Find the wall-clock ceiling, using the race pattern**

Worker Loader's own cap is **CPU time, not wall time**, so it can fire lower or later than expected. agent-os enforces wall-clock by racing `entrypoint.run()` against a `setTimeout` rejection — and swallows the late rejection so a lost race doesn't surface as an unhandled rejection in `wrangler tail` (`docs/inspired-from-ronit.md` §6). Their defaults: **30s default, 60s max**.

```ts
const runPromise = entrypoint.run();
const timeoutPromise = new Promise<never>((_, reject) =>
  setTimeout(() => reject(new Error(`exec_timeout: exceeded ${timeoutMs}ms`)), timeoutMs),
);
timeoutPromise.catch(() => {});          // belt and braces
const res = await Promise.race([runPromise, timeoutPromise]);
```

Also set `limits: { cpuMs, subRequests }` on the bundle and record what each actually enforces.

**This number is load-bearing for Phase 11.** It is why an isolate cannot be parked for hours waiting on a click, and therefore why `escalate()` returns immediately and approval resolution arrives as an injected turn. Write down the measured ceiling so that argument rests on a number rather than an assumption.

- [ ] **Step 4: Commit**

```bash
git add spikes/worker-loader
git commit -m "spike(loader): load/execute timings, log capture, wall-clock ceiling"
```

---

### Task 10: Write the Worker Loader findings and call D1

**Files:** Create `docs/superpowers/spikes/2026-08-10-worker-loader.md`

**Interfaces:**
- Consumes: Tasks 6–9
- Produces: **GO or NO-GO on decision D1**, consumed by Phases 09 and 10

- [ ] **Step 1: Write the findings document**

- Availability: gated or open, and what it took to enable
- **The network-isolation result, verbatim** — the exact error or the exact success
- What is visible from inside `env`, enumerated
- The confirmed injection shape
- Load and execute timings, cold and warm
- `console.log` capture behavior and size limits
- The wall-clock ceiling, and its consequence for Phase 11
- **A GO or NO-GO on decision D1**
- Every API the model invented that did not exist

- [ ] **Step 2: If NO-GO, amend the roadmap**

Update Phases 09 and 10 to the separate-Worker fallback before any code assumes otherwise.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/spikes/2026-08-10-worker-loader.md
git commit -m "spike(loader): findings and go/no-go on code mode tier 1"
```

---

## Exit criteria

- [ ] Both findings documents exist and each states GO or NO-GO in one line
- [ ] The network-isolation result is recorded verbatim, not paraphrased
- [ ] Warm `pnpm install` time is a number, and Phase 18 can be budgeted against it
- [ ] Every invented API is written down for the README's AI-tool notes
- [ ] If either is NO-GO, `00-roadmap.md` has been amended and there is only one design in flight
