# Phase 00 — Spikes: Sandbox and Worker Loader

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Written go/no-go findings on the two platform surfaces that decisions D5 and D1 rest on, before a single line of production code depends on either.

**Depends on:** nothing · **Day 1** · **Gates:** Phases 09, 10 (Worker Loader) and 18, 19 (Sandbox)

**Why first:** both surfaces have training data thin enough that a coding agent will confidently invent APIs for them. Discovering on day 5 that the Tier 1 isolate *can* reach the network, or that a container cannot run the monorepo, loses the week. Discovering it today costs half a day and produces a graded deliverable — the README's AI-tool notes are assembled from exactly this material.

**Not blocked on the monorepo invite.** Spike against any mid-sized public pnpm monorepo. What is being measured is the platform's ceiling, not Zellify's code.

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

- [ ] **Step 1: Pick a stand-in repo**

Any mid-sized public pnpm monorepo with a dev server. The monorepo invite has not landed; do not wait for it.

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

- [ ] **Step 1: Understand what is being tested**

This appears in the Claude Code tutorial but **not** in the Sandbox API reference. Treat it as unverified. It is a nice-to-have, not load-bearing: D5 deliberately does not depend on it, because the container holds no write credentials at all.

The one place it would help is `git clone` of a private repo, which is the only unavoidable container-side credential.

- [ ] **Step 2: Try it**

Subclass `Sandbox`, set `interceptHttps = true`, register an `outboundByHost` handler for a host you control, and confirm a placeholder header is swapped for a real value on egress.

- [ ] **Step 3: Record the outcome either way**

If it does not exist as documented, write that down plainly and move on. The fallback ladder is spec §8.3: Worker-side git HTTP proxy via `http.proxy`, then a 1-hour read-only installation token.

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

- [ ] **Step 1: Read before writing**

- https://blog.cloudflare.com/code-mode/ — the `env.LOADER.get(id, async () => ({ mainModule, modules, env }))` shape
- Worker Loader / Dynamic Worker Loader docs on developers.cloudflare.com
- https://blog.cloudflare.com/project-think/ — for the execution-ladder framing this phase validates

- [ ] **Step 2: Confirm the binding is even available on the account**

Worker Loader is beta. Check whether it needs a flag, an allowlist, or a specific wrangler version — **before** building anything on it. If it is gated, request access immediately; that lead time is the risk.

- [ ] **Step 3: Load an isolate that returns a constant**

Minimal proof the binding works: load a module from a string, call it, get a value back through the Worker.

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

- [ ] **Step 1: Hold a secret in the parent Worker**

The parent has a secret. It exposes exactly one method that uses it — say, one that returns a value derived from the secret, never the secret.

- [ ] **Step 2: Inject the binding and call it from inside the isolate**

Confirm the isolate calls the method and receives the result.

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

This is the single most important step in Phase 00. Decision D1's entire security story is this property. Prove it; do not assume it.

- [ ] **Step 1: Attempt an outbound fetch from inside the isolate**

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

- [ ] **Step 3: Find the wall-clock ceiling**

How long can an isolate run before it is killed? This is what makes a blocking `await escalate()` impossible and forces Phase 11's turn-injection design — confirm the number rather than assuming it.

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
