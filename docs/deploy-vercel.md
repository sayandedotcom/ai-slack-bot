# Deploying the Next.js front-end to Vercel

**Status: `apps/web` is on `main` as of 2026-08-27. The Vercel project is still
not created — everything below is now safe to do, and none of it has been done.**

The blocker this document was written under is gone: `worktree-next-frontend`
fast-forwarded into `main`, so a Vercel project whose Root Directory is
`apps/web` will build. What has NOT happened is the project itself, the
environment variables, or the Ignored Build Step.

## Read this before wiring anything

Two facts that a Vercel deployment does not change:

1. **`docs/tech-stack.md` lists "Vercel + Next 16" under _Deliberately not
   used_, and that rejection still stands for the product surface.** Every
   pixel of the dashboard is live socket state, so SSR earns nothing; two
   origins means cross-origin WebSocket auth against Cloudflare Access and a
   second deploy target. `apps/worker` keeps serving `apps/dashboard` from one
   origin. When `apps/web` ships, amend that table row — do not delete it — to
   record that an additive marketing/demo surface was adopted while the
   single-origin decision holds for the product.

2. **Cross-origin Access authentication is unsolved.** The spec on that branch
   is explicit: the Access cookie is issued for
   `firefighter.sayandeten.workers.dev` and is not sent to a `*.vercel.app`
   origin, and a `next.config` rewrite does not help — a rewrite proxies the
   *request*, and the request never carried the cookie. So **live mode 401s,
   and demo mode is what renders on Vercel.** Deploying is fine; claiming the
   dashboard is on Vercel is not.

## Why the native Git integration, not a GitHub Action

Recommended: connect the repository in Vercel's dashboard.

|  | Native Git integration | `vercel` CLI in a workflow |
|---|---|---|
| Credentials added to this repo | **none** | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` |
| Preview deploy per pull request | automatic, with the PR comment | hand-wired |
| Skip when `apps/web` untouched | first-class Ignored Build Step | hand-rolled `git diff` |
| Gate behind this repo's CI | no — builds independently | yes |

The gating advantage is the only real argument for the Action, and it does not
apply while the surface renders in demo mode. Adding a fourth long-lived
credential to a repository that already holds a Worker-deploying Cloudflare
token is the larger risk.

## Project settings, for when the branch merges

| Setting | Value | Why |
|---|---|---|
| Root Directory | `apps/web` | |
| **Include files outside of the Root Directory** | **ON** | **Mandatory.** `apps/web` depends on `@workspace/ui` and `@workspace/typescript-config` via `workspace:*`. With this off, install fails with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`. |
| Framework Preset | Next.js | |
| Node.js Version | 22.x | matches `.nvmrc` (22.20.0) |
| Install Command | *default* | Vercel reads `packageManager` and installs from the repo root |
| Production Branch | `main` | |

**Ignored Build Step** (Settings → Git):

```bash
npx turbo-ignore @workspace/web --fallback=HEAD^
```

`turbo-ignore` reads `turbo.json` and the workspace graph, so it correctly
rebuilds when **`packages/ui`** changes and correctly skips when only
`apps/worker` does. A hand-rolled `git diff --quiet HEAD^ -- apps/web` would
miss that transitive edge. `--fallback=HEAD^` covers the shallow-clone case.

## Was required at merge time — all four are done

Kept as the record of what the merge had to carry, not as a to-do list.

1. ~~**Drop ESLint from `apps/web/package.json`**~~ — done in `a635828`. The
   `lint` script, the `eslint` devDependency and `"@workspace/eslint-config":
   "workspace:*"` are gone; `git grep -i eslint -- apps/web packages/ui` is
   empty. That package no longer exists, and a `workspace:` protocol pointing at
   a missing one is a hard `pnpm install` failure rather than a warning, so this
   was forced rather than tidy. Biome covers `apps/web` through
   `files.includes`, and it found five real errors ESLint's ruleset did not.
2. ~~**Expect a formatting commit**~~ — done, same commit.
3. ~~**`apps/web/.env.example`**~~ — the variable is `NEXT_PUBLIC_DEMO=1`, not
   `NEXT_PUBLIC_DEMO_MODE=true`. The file has always said so; this item was
   written against a draft. The auth note above still stands.
4. ~~**Amend `docs/tech-stack.md`**~~ — done. The "Vercel + Next 16" rejection
   row now carries an adopted-as-additive parenthetical and states that the
   single-origin decision holds for the product surface; the cost table's
   Vercel line reads "$0 — Hobby, and demo mode makes no outbound request".

## What is already in place

`turbo.json`'s `build.outputs` already includes `.next/**` and
`!.next/cache/**`, and its `build` and `dev` tasks now declare
`NEXT_PUBLIC_DEMO`, `NEXT_PUBLIC_WORKER_ORIGIN` and `WORKER_ORIGIN` in `env`.
That last part is not cosmetic: unlisted, turbo would hand back a build made
under different values, which for a `NEXT_PUBLIC_` variable means shipping the
wrong constant inside the bundle.

The gate covers it. `pnpm check` at the repository root runs `apps/web`'s 82
tests and its `tsc --noEmit` alongside the Worker's, and `.github/workflows/ci.yml`
runs the same four jobs — so a Vercel build failing is a signal about Vercel,
not about the app.
