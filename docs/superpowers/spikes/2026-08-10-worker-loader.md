# Spike findings — Worker Loader (decision D1)

**Run:** 2026-08-11 · **Spike code:** `spikes/worker-loader/` · **Consumed by:** Phases 09, 10, 11

**Environment:** wrangler 4.120.0, workerd 1.20260801.1, `compatibility_date` 2026-08-01, `nodejs_compat`.

---

## Verdict

> **GO on D1, conditional.** Every property the design depends on holds: the isolate is network-isolated by a first-class field, capabilities inject cleanly via `ctx.exports`, parent credentials are unreachable, identity cannot be spoofed, and cold load costs ~4ms. **Two conditions remain open** — the spike has not run on a deployed Worker, and account-level beta availability is unconfirmed because the account is not authenticated. Neither is expected to fail; both are cheap to close and must be closed before Phase 09 writes production code.

Two corrections to the plan came out of this, both listed under [What the plan got wrong](#what-the-plan-got-wrong). One of them — where an `RpcTarget` may be placed — would have broken Phase 09 Task 1 as written.

---

## 1. Availability

| | |
|---|---|
| Binding config | `"worker_loaders": [{ "binding": "LOADER" }]` — one line, exactly as `inspired-from-ronit.md` §9 records |
| Local (`wrangler dev`) | **Available.** No flag, no allowlist, no experimental opt-in. `env.LOADER` resolves with both `load` and `get`. |
| **This account** | **UNVERIFIED — `wrangler whoami` reports not authenticated.** |

**This is the phase's one remaining lead-time risk.** The plan calls it out for exactly this reason: if the binding is gated on the account, the access request has to go in immediately. Local availability says nothing about it. `GET /available` answers it in one request once deployed.

---

## 2. Network isolation — the README's security section

**Verdict: ISOLATED.** With `globalOutbound: null`, all five escape routes throw. The error is identical in every case, verbatim:

```
Error: This worker is not permitted to access the internet via global functions
like fetch(). It must use capabilities (such as bindings in 'env') to talk to
the outside world.
```

| Attempt | `globalOutbound: null` | Control: field omitted |
|---|---|---|
| `fetch("https://example.com")` | throws | **200** |
| `fetch(parentWorkerOrigin + "/available")` | throws | **200** |
| `fetch("http://workers.cloudflare.com/")` | throws | **200** |
| `fetch("http://1.1.1.1/")` (bare IP) | throws | **200** |
| `new WebSocket("wss://example.com")` | throws | **constructed** |

The control run matters: it is what makes this a causal claim rather than an observation. Omit the one field and the isolate reaches the open internet, a bare IP, and the parent Worker. Set it and nothing gets out.

Our design is **narrower than agent-os's**, which pairs `globalOutbound: null` with `env.PROXY`, a general credentialed fetch surface. Ours has no general fetch surface at all — only typed per-integration bindings — because our integration set is closed.

### The wording correction that matters

`fetch` and `WebSocket` **remain defined** inside the isolate:

```js
typeof fetch      // "function"
typeof WebSocket  // "function"
```

They throw on **invocation**. Spec §8.1 says the isolate "has no `fetch`" and Phase 09 Task 5 says to assert `fetch` is "unavailable". Written literally as `typeof fetch === "undefined"`, **that test fails against a correctly-isolated isolate**. The assertion must be that invocation throws. The README must not claim absence when what is proven is refusal — the security property is equally strong either way, and the precise claim is the defensible one.

---

## 3. What crosses into the isolate — corrects §4

Bisected one `env` member at a time, because a single `DataCloneError` at `load()` aborts the whole run and attributes nothing.

| Placement | Result |
|---|---|
| `env: { X: ctx.exports.X({ props }) }` | **works** — the Phase 09 shape |
| `env: { X: rawDurableObjectStub }` | **works**, and is callable (`turnCount()` → `0`) |
| `env: { X: anyRpcTargetSubclass }` | **fails** — `DataCloneError: Remote RPC references can only be serialized for RPC.` at `LOADER.load()` |
| `entrypoint.runWithBridge(rpcTarget)` (call **argument**) | **works** — returned `"arg:hello"` |

The `RpcTarget` failure is **not** about what it wraps. A bridge holding only a string fails identically to one wrapping a `DurableObjectStub` and one wrapping the `DurableObject` instance. All three were tested.

`inspired-from-ronit.md` §4 says raw DO stubs cannot cross while `RpcTarget` subclasses can. **Both halves are wrong for `env`, and §4 is right about arguments** — its source is `entrypoint.run(facet)`, which is a call argument, a different boundary. The split is by *placement*, not by type.

> **Action for Phase 09.** Roadmap Phase 09 Task 1 currently says "DO reach-back wrapped in `RpcTarget`" among "capabilities on `env`". As written that throws at `load()` before any agent code runs. Either pass the `RpcTarget` as a call argument to the entrypoint method, or reach the DO through a `ctx.exports` `WorkerEntrypoint` that holds the stub internally. The second matches every other binding and is the recommendation.

A failure inside `LOADER.load()` surfaces at the **RPC caller**, so it presents as a Worker-level error with a stack pointing at `fetch`. Bracket the steps or you will debug the wrong file.

---

## 4. Credential boundary — every non-control path fails

Injected as `ctx.exports.SecretBinding({ props: { runId, onDutyUserId } })`, where the parent holds `SPIKE_SECRET` and exposes only `sign()` (HMAC, derived) and `whoAmI()`.

**Visible from inside `env`, enumerated in full:**

```
envKeys       : ["RUN_ID", "SECRET", "RAW_DO"]
bindingShapes : { RUN_ID: "string", SECRET: "object", RAW_DO: "object" }
SECRET own props   : []
SECRET proto props : ["fetch", "connect", "constructor"]
```

**Exfiltration attempts:**

| Attempt | Result |
|---|---|
| `env.SPIKE_SECRET` / `env.secret` / `env.SECRET_VALUE` | not present |
| `SECRET.env` | `undefined` |
| `SECRET.ctx` | `undefined` |
| `SECRET.SPIKE_SECRET` (property read) | returns `[object JsRpcProperty]` — a lazy handle, **does not throw** |
| `await SECRET.SPIKE_SECRET` | `TypeError: The RPC receiver does not implement the method "SPIKE_SECRET".` |
| `await SECRET.env` | `TypeError: ... does not implement the method "env".` |
| `await SECRET.env.SPIKE_SECRET` | `TypeError: ... does not implement the method "env".` |
| `await SECRET.ctx.props` | `TypeError: ... does not implement the method "ctx".` |
| `__leakControl()` (**deliberate control**) | returns the secret — proves the probe could detect a leak |

**Why it holds:** `WorkerEntrypoint`'s `env` and `ctx` are `protected`. The generated types say it outright — *"`protected` fields don't appear in `keyof`s, so can't be accessed over RPC."* The boundary is a language-level property of the class, not a denylist.

Note the shape of the near-miss: property access returns a thenable rather than throwing. A probe that only checked `typeof SECRET.SPIKE_SECRET !== "undefined"` would report a leak that does not exist. The `await` is what settles it.

**Identity cannot be spoofed.** `whoAmI()` returns the `props` value; calling `whoAmI("U_SOMEONE_ELSE")` still returns `U_ONDUTY_ALICE`. The agent never states who it acts as, so it cannot state it falsely.

### Confirmed injection shape — what Phase 09 generates `.d.ts` against

```ts
// In the DO (ctx.exports lives on DurableObjectState):
const stub = this.env.LOADER.load({
  compatibilityDate: "2026-08-01",
  compatibilityFlags: ["nodejs_compat"],
  mainModule: "main.js",
  modules: { "main.js": code },
  globalOutbound: null,                         // the isolation field
  env: {
    SLACK: this.ctx.exports.SlackBinding({ props: { runId, onDutyUserId } }),
  },
  tails: [this.ctx.exports.LogCollector({ props: { runId } })],  // console capture
});
const result = await (stub.getEntrypoint() as ...).run(...args);
```

The real `WorkerLoaderWorkerCode` has fields the plan's quoted copy omits — `allowExperimental`, `tails`, `streamingTails` — and `limits` is `workerdResourceLimits`. **`props` belongs on `getEntrypoint(name, { props, limits })`, not on the code bundle**; the plan's snippet implies otherwise.

---

## 5. Latency (15 iterations)

| Path | min | median | mean | max |
|---|---|---|---|---|
| `load()`, unique code each time | 3ms | **4ms** | 4.2ms | 12ms |
| `get()`, cached by name | 0ms | **0ms** | 0.4ms | 3ms |

Covers `load()` + `getEntrypoint()` + `run()` round trip.

**Consequence:** cold load is cheap enough that Phase 09 can `load()` per execution without keeping isolates warm per run. The plan's contingency — "if cold load is expensive, add two or three flat primitives instead of one tool" (`inspired-from-ronit.md` §12.1) — **is not triggered**. One tool stands.

### Cache semantics confirmed (§5)

Reusing one name with different code: `get()` returned the **stale** bundle; `load()` did not. This is the "my edit didn't take effect" trap, reproduced deliberately. Phase 09 uses `load()`.

---

## 6. `console.log` capture

**Works**, via `tails` on the bundle — a `WorkerEntrypoint` with a `tail(events)` method, injected like any other binding:

```ts
tails: [ctx.exports.LogCollector({ props: { runId } })]
```

`log`, `warn` and `error` all arrive with their level. **The return value is a separate channel from console output**, so Phase 09 can feed the model both, as designed. Delivery is out-of-band: the collector parks events and the caller drains after the run.

### Size ceiling — silent truncation

| Emitted | Captured |
|---|---|
| 1000 lines × 100B (~100KB) | 1002 of 1002 |
| 5000 lines × 200B (~1MB) | 1041 of 5002 |
| 200 lines × 10KB (~2MB) | 27 of 202 |
| 50 lines × 100KB (~5MB) | 3 of 52 |

Truncation is by **bytes, not lines**, landing around **200–300KB**, with **no error and no truncation marker**.

> **Action for Phase 09 Task 4.** Cap and mark tool-result output explicitly. Silent upstream truncation is indistinguishable, to the model, from the code never having logged — which is a debugging trap for the agent itself, not just for us.

---

## 7. The wall-clock ceiling — the important negative result

| Configuration | Outcome |
|---|---|
| `limits: { cpuMs: 50 }`, burn 1000ms of CPU | **completed** (1004ms) |
| `limits: { cpuMs: 200 }`, burn 1000ms of CPU | **completed** (1011ms) |
| `limits: { cpuMs: 50 }`, sleep 2000ms | completed (2014ms) |
| Race guard: 3000ms of work, 500ms budget | **threw at 502ms** — `exec_timeout: exceeded 500ms` |

**`limits.cpuMs` did not fire at all.** `inspired-from-ronit.md` §6 warns it "may fire lower or later than expected"; here it did not fire whatsoever, at 50ms against a 1000ms burn. The wall-clock race is therefore **not** belt-and-braces — it is the only enforcement demonstrated to work.

```ts
const timeout = new Promise<never>((_, reject) =>
  setTimeout(() => reject(new Error(`exec_timeout: exceeded ${ms}ms`)), ms));
timeout.catch(() => {});                      // swallow the late rejection
return Promise.race([runPromise, timeout]);
```

> **Do not rely on `limits.cpuMs` to bound a runaway loop.** Whether it is enforced in production is one of the open questions below.

### Consequence for Phase 11

The argument now rests on a measurement rather than an assumption: an isolate is bounded only by a guard we impose, and nothing keeps one alive across a human's approval latency. **`escalate()` must return immediately** and the approval resolution must arrive as an injected turn. Phase 11's design is unchanged — it is now justified.

---

## What the plan got wrong

Both are corrections to inherited material, not to the architecture.

1. **`RpcTarget` on `env` throws.** Phase 09 Task 1 says to put the DO reach-back there. It must move to a call argument or behind a `ctx.exports` entrypoint. (§3)
2. **"The isolate has no `fetch`" is imprecise.** `fetch` exists and refuses. Spec §8.1 and Phase 09 Task 5 need rewording, and the Phase 09 test needs to assert a throw rather than `undefined`. (§2)

## APIs the model expected that do not exist

Kept for the README's AI-tool notes.

| Expected | Reality |
|---|---|
| `interceptHttps` / `outboundByHost` on `@cloudflare/sandbox`'s `Sandbox` | Inherited from `Container` in `@cloudflare/containers`. Grepping the sandbox package finds nothing and reads as "removed". |
| `props` on `WorkerLoaderWorkerCode` | Belongs on `getEntrypoint(name, { props, limits })`. |
| `limits.cpuMs` bounds execution | Did not fire at all locally. |
| `@cloudflare/workers-types` as the type source | Superseded by `wrangler types` → `worker-configuration.d.ts`. `ctx.exports` cannot typecheck without the generated `Cloudflare.GlobalProps`. |
| Docs pages carry the API surface | `/sandbox/`, `/sandbox/api/`, `/sandbox/configuration/` are hub pages; the surface is only on subpages. |

## Open — must close before Phase 09

- [ ] **Account beta availability.** `GET /available` on a deployed Worker. The one genuine lead-time risk.
- [ ] **Re-run every result deployed.** agent-os hit a binding `wrangler dev` accepted and production rejected; any binding validated only locally is unvalidated. Highest-value targets: the `RpcTarget`-on-`env` failure (§3) and `limits.cpuMs` (§7), where local and production could plausibly differ.
- [ ] **Confirm the isolation error text in production** before quoting it verbatim in the README.

## Reproducing

```bash
cd spikes/worker-loader
cp dev.vars.example .dev.vars
pnpm install && npx wrangler types && npx wrangler dev --port 8790

curl 'localhost:8790/available'
curl 'localhost:8790/isolation'                       # and ?outbound=inherit
curl 'localhost:8790/bindings?include=secret,raw,argbridge'
curl 'localhost:8790/timings?mode=latency&n=15'       # and mode=logs, mode=ceiling
```
