# Inspired from Ronit

Everything in this build that came from reading Ronit's own repos, with attribution and file references. Kept as a separate document so the README's AI-tool notes and the interview can both draw on it honestly: **these are not things I discovered, they are things I adopted.**

**Sources**

| Repo | What it is | Read on |
|---|---|---|
| [`rtpa25/agent-os`](https://github.com/rtpa25/agent-os) | "Cloudflare-native agent OS for code-first autonomous work." DO kernel + Worker Loader + `@cloudflare/sandbox`, AI SDK, Ink TUI. Closest sibling to this build. | 2026-08-10 |
| [`rtpa25/self-syncing-agent`](https://github.com/rtpa25/self-syncing-agent) | Agent that writes its own webhook handlers into isolated DO Facets. Worker Loader + facets + approval-gated writes. | 2026-08-10 |

Both cloned at `--depth 1` and read directly; the summaries below cite real files, not READMEs.

---

## 1. The single most valuable finding: `globalOutbound: null`

The spec's decision D1 claims the Tier 1 isolate "has no `fetch`." Before reading these repos that was a hope with a spike attached. It is in fact a **first-class field on the Worker Loader bundle**:

```ts
// @cloudflare/workers-types — WorkerLoaderWorkerCode
interface WorkerLoaderWorkerCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, WorkerLoaderModule | string>;
  env?: any;
  globalOutbound?: Fetcher | null;   // ← null = no network. Full stop.
  limits?: { cpuMs?: number; subRequests?: number };
}
```

`agent-os/apps/kernel/src/exec-runner/bundle.ts:101` sets it explicitly:

```ts
// Native fetch stays blocked. env.PROXY remains the only outbound HTTP path
globalOutbound: null,
```

**What this changes for us:** spec §8.1's security claim moves from "verify the isolate can't reach the network" to "set one field and assert it." Phase 00 Task 8 still runs — the assertion belongs in a test either way, because it *is* the README's security section — but it is now a confirmation rather than a discovery.

**Where our design diverges, deliberately:** agent-os sets `globalOutbound: null` and then hands the isolate `env.PROXY`, a single credentialed fetch surface, because its agent needs arbitrary outbound HTTP. We don't. Our isolate gets typed per-integration bindings and **no general fetch surface at all** — strictly narrower. Worth saying out loud in the interview: same primitive, tighter blast radius, because our integration set is closed.

---

## 2. The gotcha that would have cost a day: stubs must go on `env`, never `globalOutbound`

From the comment block at the top of `agent-os/apps/kernel/src/exec-runner/bundle.ts:17-27`:

> Hard-won rule (PR #6 / commit c4bea9c): a service stub set as `globalOutbound` on a Worker Loader bundle invoked via `entrypoint.run()` trips workerd's result-marshalling — every call fails with **"This ServiceStub cannot be serialized"** before user code returns. The same stubs placed on the loaded isolate's `env` are fine.

So the working shape is: `globalOutbound: null` **and** capabilities on `env`. Which is exactly what Phase 09 needs.

There is a second, nastier version of the same trap further down the same file:

> The raw `env.BROWSER` stub does **NOT** survive Worker Loader's marshalling boundary in prod. Wrapping it in `BrowserBridge` gives us the same `ctx.exports.X({props})` shape as PROXY/FS, which empirically round-trips fine. **(Wrangler dev accepts the raw binding, hence the long detour to find this.)**

**A binding that works in `wrangler dev` and fails in production.** That is precisely the class of bug that surfaces at the fire drill.

---

## 3. `ctx.exports.X({ props })` is the canonical way to build isolate bindings

Not raw service bindings. From the same comment block:

> Worker Loader env stubs come from `ctx.exports` (DurableObjectState's exports) — the canonical CF pattern for a DO to obtain stubs to its sibling WorkerEntrypoints. This is the shape that empirically worked end-to-end.

```ts
env: {
  PROXY: ctx.exports.PipedreamProxy({ props: {} }),
  BROWSER: ctx.exports.BrowserBridge({ props: {} }),
}
```

There is even a recorded dead end worth not repeating — commit `e2e060f` tried swapping `ctx.exports` for the `exports` import from `cloudflare:workers`, guessing the stub flavour was the bug. It wasn't; both round-trip identically.

**Adopted:** every Phase 09 binding is a `WorkerEntrypoint` on the Worker, handed to the isolate as `ctx.exports.SlackBinding({ props: { runId, onDutyUserId } })`. Props are how the binding knows which engineer it is acting as — which means the agent cannot spoof identity by passing a different user id, because it never passes one.

---

## 4. `RpcTarget` is what crosses the isolate boundary

`self-syncing-agent/src/execrunner/facet-bridge.ts:1-20`:

> Cloudflare's Worker Loader can't marshal raw DurableObject stubs across isolate boundaries — passing a facet stub directly to `entrypoint.run(facet)` fails with an opaque `"internal error; reference = ..."` before our code runs. The canonical fix (see cloudflare/agents codemode example) is to wrap capabilities in `RpcTarget` subclasses, which ARE crossable.

```ts
import { RpcTarget } from "cloudflare:workers";

export class FacetBridge extends RpcTarget {
  #facet: Fetcher;
  constructor(facet: Fetcher) { super(); this.#facet = facet; }
  async __query(sql: string): Promise<unknown> { /* forwards to the real stub */ }
}
```

**Adopted:** any Phase 09 binding that needs to reach a Durable Object — notably the `memory` and `escalate` bindings reaching back into `RunDO` — wraps it in an `RpcTarget` subclass rather than passing the stub.

---

## 5. `codeId` is a cache key, not a label

`self-syncing-agent/src/facet/loader.ts:4-9`:

```ts
/**
 * codeId convention: `sync:<syncId>:v<version>` — bumps on every update
 * to force Worker Loader cache miss.
 */
export function syncCodeId(sync: Pick<Sync, "id" | "version">): string {
  return `sync:${sync.id}:v${sync.version}`;
}
```

The two APIs differ in exactly this respect:

```ts
interface WorkerLoader {
  get(name: string | null, getCode: () => WorkerLoaderWorkerCode | Promise<...>): WorkerStub;  // cached by name
  load(code: WorkerLoaderWorkerCode): WorkerStub;                                              // no cache
}
```

`get()` only invokes the callback on a cache miss. Reuse a `codeId` with different code and you silently execute the **old** bundle — which presents as "my edit didn't take effect," the worst possible symptom to debug under time pressure.

**Adopted:** Phase 09 uses `LOADER.load(code)` for agent-authored code, since every execution is unique and there is nothing to cache. `get()` is reserved for anything we ever want warm, with `{runId}:{turn}:{blockIndex}` as the key.

---

## 6. Wall-clock timeouts must be enforced by racing

`agent-os/apps/kernel/src/tools/exec-code.ts:405-425` races `entrypoint.run()` against a `setTimeout` rejection, because Worker Loader's own cap is CPU time rather than wall time and may fire lower or later than expected. It also swallows the late rejection so a lost race doesn't surface as an unhandled rejection in `wrangler tail`.

Their defaults: **30s default, 60s max**, with the note that browser scripts need the higher value.

**Adopted:** Phase 09's execution wrapper races the same way, and `limits: { cpuMs, subRequests }` gets set on the bundle. This also confirms the number Phase 11 depends on — **an isolate cannot be parked for hours**, which is why `escalate()` returns immediately and approval resolution arrives as an injected turn rather than a blocked `await`.

---

## 7. `interceptHttps` + `outboundByHost` are real — and subtler than the tutorial

The spec listed this as unverified. It exists. `agent-os/apps/kernel/src/sandbox/sandbox-class.ts`:

```ts
export class Sandbox extends BaseSandbox<Env> {
  sleepAfter = SLEEP_AFTER_MS;   // '1h' vs SDK default '10m'
  interceptHttps = true;         // without this, only http:// is routed through outbound
}

Sandbox.outboundByHost = { [PD_PROXY_HOST]: async (request, env) => { /* ... */ } };
```

Three things the tutorial doesn't tell you:

- **`outboundByHost` is a STATIC field**, set at module scope. The SDK reads it at construction time and registers `interceptOutboundHttps(host, ...)` per key.
- **Configuring *only* `outboundByHost`** — no static `outbound` catch-all, no `allowedHosts`/`deniedHosts` — puts the SDK in per-host mode. Hosts not in the registry (R2, GitHub, npm, apt mirrors) flow direct through the container's network namespace and never enter Worker fetch.
- **Worker fetch normalizes `Content-Length` on HEAD responses**, which broke their s3fs-on-R2 mount. They confirmed via a dedicated probe branch that the SDK overwrites it even when the handler sets it explicitly. Anything routed through Worker fetch inherits this.

They route credentialed calls through a **sentinel hostname** (`https://pd-proxy.agent-os.local/<target-host>/<path>`) so only that one host is intercepted.

**Adopted:** Phase 18's private-repo clone uses the sentinel-host pattern rather than a catch-all interceptor, and `sleepAfter` gets set deliberately instead of inheriting the 10-minute default — a container that naps mid-repro is a drill failure.

---

## 8. npm packages inside the isolate

`agent-os/apps/kernel/src/exec-runner/bundle.ts` uses `@cloudflare/worker-bundler`:

```ts
import { createWorker, installDependencies, DurableObjectKVFileSystem } from "@cloudflare/worker-bundler";
```

A DO-storage-backed filesystem seeds the module map, `installDependencies` resolves npm at runtime, `createWorker` bundles with esbuild, and the result feeds `LOADER.load()`.

**Noted, not adopted for now.** Our Tier 1 surface is a closed set of typed bindings, so arbitrary npm is scope we don't need — and Tier 2 has a real container with a real `node_modules` when it does. Worth knowing it exists if a Phase 09 task turns out to want a parser or a date library.

---

## 9. Wrangler config, verbatim

```jsonc
"worker_loaders": [{ "binding": "LOADER" }]
```

That's it. Also present in `agent-os/apps/kernel/wrangler.jsonc`: `r2_buckets`, `browser` (Browser Rendering), `vectorize`, and Queues — a useful confirmation that these bindings coexist in one Worker.

---

## 10. Architectural validation (not code, but load-bearing)

Things this build had already decided, which Ronit independently arrived at. Adopted as **confidence**, not as changes.

| Our decision | His implementation |
|---|---|
| **D1 — two execution tiers, one agent** | agent-os is exactly this: "Worker Loader for lightweight JavaScript execution, containerized Linux via `@cloudflare/sandbox` for heavier workloads." |
| **Code-first agent** | "The agent's primary action is **writing and running code**, not calling primitive tools." |
| **Credentials never enter the sandbox** | Same principle; his mechanism is Pipedream minting per-call tokens, ours is simpler because the Worker performs every write. |
| **DO supervisor with SQLite state** | `apps/kernel` — DO per user, SQLite-backed threads/runs/tool-calls/audit. |
| **Hibernatable WebSockets for streaming** | Same. |
| **Hono routing** | Same, both repos. |
| **Cloudflare Access for auth** | Same (self-syncing-agent uses Access OTP). |
| **Approval-gated writes** | self-syncing-agent gates every state mutation; agent-os has an HIL rail for tools tagged `needsApproval: true`. |
| **Turborepo + pnpm** | agent-os: `apps/kernel`, `apps/cli`, `packages/protocol`, `packages/models`. |
| **Spec + numbered phase plans** | Both repos ship `docs/superpowers/` — self-syncing-agent has 22 implementation plans **with rejection logs**. |

---

## 11. Three concrete adoptions into our stack

| Adopted | From | Why |
|---|---|---|
| **Vercel AI SDK + `@ai-sdk/anthropic`** | `agent-os/apps/kernel/src/turn.ts:1` | Streaming, the tool loop, and structured output come free, and the Cloudflare Agents SDK expects it. Our plan had left the client unspecified. |
| **Cloudflare AI Gateway** in front of Anthropic | agent-os routes Anthropic through it | Near-free cost tracking, caching and observability — and a cost breakdown is a graded README deliverable against a $500 ceiling. |
| **`packages/protocol` for wire types** | `agent-os/packages/protocol/src/index.ts` | Shared types across the dashboard↔Worker WebSocket boundary. This is the one thing that genuinely justifies keeping the monorepo. Their frames are named constants (`agent_os.run.resume`) dispatched on `msg.type` — same shape our run protocol needs. |

**Considered and declined:** Drizzle ORM (`packages/models`). Nice, but raw D1 prepared statements are zero-risk and our schema is seven tables. Not worth the setup on a 7-day clock.

---

## 12. Where we deliberately differ

Worth being able to defend these, since the reviewer wrote the thing we're diverging from.

1. **Tool surface.** agent-os uses **flat schemas via the AI SDK** — `exec_code` is one tool among ~14 (`read_file`, `write_file`, `web_search`, `computer_bash`, `computer_use`, …). Our spec gives the model **one tool** and a generated `.d.ts`. The reason is our workload: chaining Slack + Supabase + LangSmith + memory in a single execution without round-tripping every intermediate result through the model. If Phase 00 Task 9 shows isolate cold-load is expensive, adding two or three flat primitives is the right correction — decided on the measurement, not the principle.
2. **No general fetch surface in the isolate.** He needs `env.PROXY`; we don't, because our integration set is closed. Strictly narrower.
3. **No credential broker.** Pipedream Connect solves per-call token minting for arbitrary third-party APIs. Our writes all happen Worker-side, so the problem doesn't arise.
4. **No DO Facets.** self-syncing-agent gives each sync its own facet with isolated SQLite. Our runs are thread-scoped DOs; per-run SQLite in the DO itself is sufficient, and facets add a boundary we'd have to justify.

---

## 13. What this changed in the plan

- **Phase 00 Task 4** — `interceptHttps` moved from "probe whether it exists" to "adapt the known-good static `outboundByHost` shape."
- **Phase 00 Task 7** — the RPC binding task now names `ctx.exports.X({props})` and `RpcTarget`, and explicitly tests the prod marshalling path rather than trusting `wrangler dev`.
- **Phase 00 Task 8** — network isolation is now "set `globalOutbound: null` and assert," not "discover what happens."
- **Phase 00 Task 9** — the wall-clock ceiling is measured with the race pattern, and the finding feeds Phase 11's non-blocking `escalate()`.
- **Phase 09** — binding construction, `RpcTarget` wrapping, `load()` vs `get()`, and the timeout race are all specified rather than left to discovery.
- **Tech stack** — AI SDK, AI Gateway, and `packages/protocol` added.

**Net effect: Phase 00's Worker Loader half went from "spike and hope" to "confirm and adapt."** The Sandbox half is still a genuine unknown, because nobody has run Zellify's monorepo in one.
