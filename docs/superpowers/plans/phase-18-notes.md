# Phase 18 — notes

Raw material for the README's AI-tool notes (a graded deliverable) and for the
interview. Written as things were found, not tidied afterwards.

---

## The expensive mistake: I read the wrong branch

The plan's first "Ground truth about the monorepo" section was derived from
`Zellify/web2app-rebuild`'s **default branch**. The sandbox runs `staging`, and
PRs target `staging`. They differ materially.

| Claim from the default branch | Truth on `staging` |
|---|---|
| There is no root `AGENTS.md`; the brief is wrong | **`AGENTS.md` exists** (678 lines). The brief was right. `CLAUDE.md` is a one-line pointer to it. |
| pnpm `9.12.2` | **`11.17.0`** |
| Node `>=18` | **`>=22`** (`.nvmrc` and volta both 22.22.3) |
| `.npmrc` sets `engine-strict=true` | **No `.npmrc` anywhere.** `engineStrict: true` lives in `pnpm-workspace.yaml` |
| One app binds port 3000 | **Three do** — `web` (explicit flag), `landing` and `storybook` (Next's default) |

Baking pnpm 9.12.2 would have failed slowly and confusingly, at `pnpm install`
inside a container, minutes into a build.

**The general lesson, worth more than the specific facts: the branch is part of
the question.** "Read the repo" is under-specified when the repo has a release
ladder. `git clone` gives you HEAD of the default branch, which is exactly the
branch that does *not* matter here.

I also wrote a confident correction into the plan and the roadmap — "there is no
`AGENTS.md`, the brief means `CLAUDE.md`" — and committed it. Being wrong is
cheap; being wrong *and* authoritative in a document other agents then read as
ground truth is what actually costs time.

---

## Two blockers nobody had looked for

**1. `pnpm install` fails without `NUCLEO_LICENSE_KEY`.** `apps/dashboard`
depends on `nucleo-ui-outline-18`, whose preinstall verifies a license. Without
the key, pnpm 11 fails with `ERR_PNPM_IGNORED_BUILDS`. Both
`pnpm-workspace.yaml` and `.github/workflows/pr-checks.yml` say so in comments —
so it was discoverable, but only by reading the config rather than the docs.

`--ignore-scripts` dodges it and is the wrong fix: the `allowBuilds` list covers
`esbuild`, `sharp`, `workerd`, `@prisma/engines`, `unrs-resolver` and a dozen
more that fetch or compile platform binaries. Skipping scripts yields a
`node_modules` that installs cleanly and then fails at the first build.

**2. The repo's `.dockerignore` is `*`** plus an allowlist of built output
(`.next/standalone`, `.next/static`, `public`, `deploy`). A build context rooted
at the repo copies **no source, no lockfile, no `package.json`** — you get an
empty image and a baffling error. Cloning inside a build stage sidesteps it
entirely, which is what our Dockerfile does for the credential reason anyway.

---

## APIs the model expected that do not exist, or behave differently

Continues the spike's table. Every row cost real time.

| Expected | Reality |
|---|---|
| Runtime `setOutboundByHost` is a strict improvement on the module-scope static | **It silently promotes the container to intercept-all.** `setOutboundByHost` writes `outboundByHostOverrides` → `hasMutableOutboundConfiguration()` true → `shouldInterceptAllOutbound()` true → `interceptOutboundHttps('*')`, and the SDK's own comment says it stays there until restart. That re-exposes the HEAD `Content-Length` normalisation that broke agent-os's R2 mount. **None of this is in the `.d.ts`** — only the compiled `container.js`. The plan preferred the runtime API on a rationale ("our credential is per-run") that was also false: `MONOREPO_PAT` is one Worker secret, identical for every run. |
| `sandbox.waitForPort(port, { mode: 'tcp' })` | `waitForPort` is declared **only on the `Process` handle** returned by `startProcess`, not on the sandbox. The spike used `proc.waitForPort(...)` and the distinction did not register. A lifecycle-level port check has to be an in-container TCP connect loop via one bounded `exec`. |
| `ProcessOptions.autoCleanup` defaults to `false` | **It defaults to `true`**, and this is the single most load-bearing detail in the phase. With the default, a finished provision's record is *deleted*, so `getProcess` returns null, every `boot()` poll relaunches `provision.sh`, a failure retries forever, and `ready` is never reachable. `autoCleanup: false` is what makes the process *be* the state. In neither the docs nor the spike. |
| `ContainerProxy` from `@cloudflare/sandbox` is the one from `@cloudflare/containers` | It is a **subclass** that dispatches SDK-internal mount hosts (`r2.internal`, `s3-credential-proxy.internal`) directly, because the outbound handler registry is not shared between the DO's execution context and the `ContainerProxy` `WorkerEntrypoint` context. Import it from `@cloudflare/sandbox`, never from `@cloudflare/containers`. |
| A missing container image is a deploy-time problem | It is a **config-parse** problem. `wrangler.jsonc` naming a Dockerfile path that does not exist takes down `wrangler types` **and the entire vitest pool** — every test dies at pool start with `config wrangler validation failed`, before a single test loads. This blocked concurrent agents for a while and looked like anything but its cause. |
| `wrangler deploy --dry-run` is a fast, local sanity check | With a Dockerfile-path `image`, **it actually builds the container image**. The Task 8 gate is therefore a multi-minute step unless `image` points at a registry URI. |
| `wrangler deploy` can pass a BuildKit secret to a Dockerfile-path build | It cannot. The documented path is `docker build --secret` locally → `wrangler containers push` → reference the printed `registry.cloudflare.com/<account>/…` URI. Better anyway: an explicit tag per build makes a stale container visible, and the spike found that deploying a new image does **not** recycle a running one. |
| `Process.startTime` is a `Date` | Typed `Date`, and it is one over the RPC transport — but a plain ISO **string** under the HTTP transport, and the transport is a call-site option rather than a type. A transport change would silently make an elapsed-time calculation `NaN`. |
| `JSON.stringify(err)` is a reasonable basis for a "no secret leaked" assertion | It returns `{}`. `message` and `stack` are **non-enumerable** on `Error`, so a leak sweep built on `JSON.stringify` passes while the secret sits in the exact field the model receives. The sweep has to read `message`, `stack`, `String(err)` and own properties explicitly. |
| `JSON.parse`'s error message is safe to propagate | **It quotes the input it choked on.** For a secret-valued env blob, that means quoting a credential into an error string that also reaches a log. Catch and replace with a fixed message. |

---

## Design corrections made during implementation

**Per-process env injection is not a security boundary, and the plan implied it
was.** The original caveat said model code "could read the values out of
`/proc`". Task 5's implementer found a far more direct path:
`exec({ cmd: "env", injectDevEnv: true })` returns stdout straight to the model,
and `spawn` + `checkProcess` does the same through `stdoutTail`.

The resolution was to **redact** every known dev-env value from all
model-visible output rather than to remove the capability. That defeats the case
that actually happens — a value landing in a run transcript, then in memory,
then conceivably in a customer-facing draft — without pretending to stop a model
that deliberately encodes a value before printing it. The README must state the
limit rather than imply a guarantee.

**The `diff` design survived contact.** Returning a bounded preview plus an
opaque ref, with the bytes held server-side, was written into the plan before
implementation and needed no change. Content-addressing the ref
(`diff_<sha256>`) was an implementer's improvement: a retried `diff()` writes one
object instead of two near-identical patches for Phase 20 to choose between.

**A model-visible ref must be validated into a key, not pasted into one.**
`readDiff` takes a ref the model has seen. Interpolating it into an R2 key would
let `../../` or a crafted string reach a published artifact. It parses.

---

## Open, to settle at Task 8

- **The sweeper destroys a container for every terminal run, booted or not.**
  Bounded to `updated_at >= now - 15min` and `LIMIT 50`. A precise sweep needs a
  "this run booted" marker; `auditedCapability` does not write to
  `codemode_effects`, so the `sandbox_write` methods leave no ledger row. If the
  redundant destroys prove expensive, the fix is a small `sandbox_runs` table.
- **Whether git's TLS verification accepts the intercepted sentinel
  connection.** The spike proved `curl https://…` through interception and git
  uses the same CA bundle, so it should hold — but it is unproven *with git*,
  and it would fail at Task 8 rather than at `tsc`.
- **Whether a `standard-4` can actually run this monorepo** — the roadmap's named
  unknown. Blocked on `NUCLEO_LICENSE_KEY`.

---

## Measured against the real monorepo

_Pending `NUCLEO_LICENSE_KEY`. The base stage (toolchain only, no repo) builds
without credentials and is being timed separately._
