# Deploying the Next.js front-end to Vercel

**Status: not set up, deliberately. Do not create the Vercel project yet.**

`apps/web` does not exist on `main`. It lives only on `worktree-next-frontend`
(locked, ahead of `main`, and dirty at the time of writing). A Vercel project
whose Root Directory is `apps/web` fails **every** build until that branch
merges — including builds of `main`. This document is the wiring written down
so it does not have to be rediscovered; it is not a description of something
that exists.

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

## Also required at merge time

1. **Drop ESLint from `apps/web/package.json`** — the `lint` script, the
   `eslint` devDependency, and `"@workspace/eslint-config": "workspace:*"`.
   That package no longer exists, and a `workspace:` protocol pointing at a
   missing package is a hard `pnpm install` failure, not a warning. The same
   applies to that branch's copy of `packages/ui/package.json`. Biome already
   covers `apps/web` through `files.includes`.
2. **Expect a formatting commit.** `apps/web` has never been linted or
   formatted; run `pnpm format` and land it as its own `style:` commit.
3. **`apps/web/.env.example`** — `NEXT_PUBLIC_DEMO_MODE=true` is not a
   placeholder. See the auth note above.
4. **Amend `docs/tech-stack.md`** as described at the top of this file.

## What is already in place

`turbo.json`'s `build.outputs` already includes `.next/**` and
`!.next/cache/**`, so nothing has to change there when `apps/web` lands.
