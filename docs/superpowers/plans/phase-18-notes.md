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

**Base stage (toolchain only, no repo), built without credentials: 2.06 GB.**
Verified inside the running container: Node 22.23.2, pnpm 11.17.0, Infisical CLI
0.43.65, redis 6.0.16, Chromium 1208 + headless shell, git 2.34.1. This is the
half of the image that has nothing to do with Zellify, and it is worth knowing
it stands alone: every failure after this point is about the monorepo, not the
toolchain.

**Cold install of the monorepo: ~13 minutes, 3217 packages**, across three
attempts on a domestic link, including dependency build scripts. This is the
number that justifies baking rather than installing at boot.

### Three things about `pnpm install` on this monorepo

**1. It needs retries, not a longer timeout.** pnpm's store is populated
incrementally, so an install killed by a tarball timeout leaves everything it
already fetched behind and the next attempt resumes. Measured: 3114 packages,
then 3202, then the tail and the build scripts. A single-shot install fails at
the 97% mark and discards the whole build; three attempts converge. The
Dockerfile loops.

**2. pnpm 11 type-checks its config, so flags lie.**
`--config.network-concurrency=6` arrives as the **string** `"6"` and dies with
``Expected `concurrency` to be a number from 1 and up, got `6` (string)``. The
npmrc parser coerces properly, so the settings live in `/root/.npmrc` — which
also puts them where `provision.sh`'s `git clean` cannot remove them and where
they can never be committed into a PR.

**3. `NUCLEO_LICENSE_KEY` is real, and confirmed working.** The install reaches
`nucleo-ui-outline-18 preinstall$ node ./account-check.js` and passes it with
the key present. **Honest caveat:** the earlier runs *without* the key never
reached the preinstall — they died on network timeouts first — so "install fails
without it" rests on the repo's own config comments and CI workflow, not on a
failure observed here.

### Disk: the failure that had nothing to do with the code

The first full build died with no error line, ~68 seconds into the install. The
cause was the host at **100% disk** (1.2 GB free of 147 GB). Worth recording
because the symptom — a build that stops mid-progress, exit 1, no message — is
indistinguishable from a dozen other things, and Docker reports nothing useful.

**`docker images` sizes overcount badly for estimating reclaim.** Deleting eight
Phase 00 spike images that `docker images` totalled at ~7 GB freed **1.9 GB**,
because those tags shared layers with the base image still in use. Estimate
reclaim from `docker system df`'s RECLAIMABLE column, never by summing image
sizes.

**Hardlinks do not dedupe across overlayfs layers.** The natural Dockerfile —
COPY the lockfile, `pnpm fetch`, COPY the tree, `pnpm install` — caches better
and costs roughly **twice** the disk. pnpm hardlinks `node_modules` entries to
the store, and a hardlink to a file in a *lower* layer forces a copy-up, so the
~4 GB store is paid for twice. Fetch and install were merged into one RUN: worse
caching, half the peak disk. On a machine with 8 GB free that is the difference
between a build and an ENOSPC three quarters of the way in.

**Bind-mounted host directories break the root `postinstall`.** Probing the
install against a bind-mounted checkout failed at the very end — after every
package was on disk — with git's dubious-ownership refusal
(`safe.directory /workspace/web2app-rebuild`), because the mount is host-owned
and the container runs as root. It does not affect the real build, where the
repo is COPYed and root-owned, but the Dockerfile sets `safe.directory` anyway:
the failure arrives at the most expensive possible moment and reads like nothing
to do with the install. Note this also contradicts the earlier finding that
`agents sync` "never throws on a normal run" — it throws when git refuses.

### Infisical

The CLI installed locally was **0.38.0**, below the **0.43.99 floor the
monorepo's own docs set**. Under that floor a personal override silently
resolves to the *shared* value with no error — a wrong value, not a crash, which
is the worst shape a configuration bug can have. Upgraded before use.
