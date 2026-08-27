# Deploying the Next.js front-end to Vercel

**Status: live at `https://firefighter.sayande.xyz` as of 2026-08-28, in real
mode, not demo.** The repository-side configuration below is committed; the
dashboard-side steps (Cloudflare zone and Access, the Vercel project, the DNS
records, the OAuth callbacks) are done by hand and are recorded here so they can
be repeated.

## Read this before wiring anything

Two facts that a Vercel deployment does not change:

1. **The single-origin decision did not get abandoned — it got kept, on a
   different hostname.** `docs/tech-stack.md`'s objection to Vercel was that
   "two origins means cross-origin WebSocket auth against Cloudflare Access".
   There are not two origins. `firefighter.sayande.xyz` is a Cloudflare-proxied
   CNAME to Vercel, and `apps/worker/wrangler.jsonc` holds one route,
   `firefighter.sayande.xyz/api/*`, so the app and the API answer on the same
   host. Access issues one cookie for it and the run socket is first-party.

2. **The Access application is the load-bearing part, and there is one trap.**
   `firefighter.sayande.xyz` was added as an ADDITIONAL HOSTNAME on the existing
   `firefighter — Dashboard` application. A separate application would have a
   different AUD, and `src/access/jwt.ts` verifies `aud` against
   `ACCESS_APP_AUD` — every request would 401 with `wrong_audience` and no
   obvious cause. Never create a second application for this.

3. **The workers.dev origin still answers, and must keep doing so.**
   `wrangler.jsonc` sets `workers_dev: true` explicitly. It serves the Vite SPA
   (`apps/dashboard`, the rollback), `/proofs/*` — whose Access-bypassed links
   are already pasted into customer Slack threads — and `/slack/events`. None of
   those moved, and `PROOFS_BASE_URL` still points at it.

## Why the native Git integration, not a GitHub Action

Recommended: connect the repository in Vercel's dashboard.

|  | Native Git integration | `vercel` CLI in a workflow |
|---|---|---|
| Credentials added to this repo | **none** | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` |
| Preview deploy per pull request | automatic, with the PR comment | hand-wired |
| Skip when `apps/web` untouched | first-class Ignored Build Step | hand-rolled `git diff` |
| Gate behind this repo's CI | no — builds independently | yes |

The gating advantage is the only real argument for the Action. Adding a fourth
long-lived credential to a repository that already holds a Worker-deploying
Cloudflare token is the larger risk.

## Project settings

| Setting | Value | Why |
|---|---|---|
| Root Directory | `apps/web` | |
| **Include files outside of the Root Directory** | **ON** | **Mandatory.** `apps/web` depends on `@workspace/ui` and `@workspace/typescript-config` via `workspace:*`. With this off, install fails with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`. |
| Framework Preset | Next.js | |
| Node.js Version | 22.x | matches `.nvmrc` (22.20.0) |
| Install Command | *default* | Vercel reads `packageManager` and installs from the repo root |
| Production Branch | `main` | |
| Custom domain | `firefighter.sayande.xyz` | verified by `_vercel` TXT, because the record is Cloudflare-proxied |
| Environment variables | **none** | see below — every absence is deliberate |

**No environment variable is set in production, and that is the configuration,
not an oversight:**

- `NEXT_PUBLIC_DEMO` — unset. The deployment is live.
- `WORKER_ORIGIN` — unset. A Worker route claims `/api/*` on this hostname at
  the edge, so those requests never reach Vercel and the `next.config.ts`
  rewrite has nothing to forward.
- `NEXT_PUBLIC_WORKER_ORIGIN` — unset, so `socketHost()` returns `undefined`
  and the run socket resolves against `window.location`. Setting it would
  point the socket at a second origin and break the handshake.
- `CF_ACCESS_TOKEN` — **never.** It is a bearer credential for one person's
  Access session; a deployment holding one lets every visitor act as them.
  `apps/web/proxy.ts` is a local dev bridge and is inert without it.

**Ignored Build Step** (Settings → Git):

```bash
npx turbo-ignore @workspace/web --fallback=HEAD^
```

`turbo-ignore` reads `turbo.json` and the workspace graph, so it correctly
rebuilds when **`packages/ui`** changes and correctly skips when only
`apps/worker` does. A hand-rolled `git diff --quiet HEAD^ -- apps/web` would
miss that transitive edge. `--fallback=HEAD^` covers the shallow-clone case.

## The dashboard-side steps, in order

None of this is in the repository, so it is written down here instead. The
ordering is load-bearing: each step's prerequisite is the one above it.

1. **Cloudflare zone.** `sayande.xyz` (registrar GoDaddy, unchanged — no
   registrar transfer was needed) had its nameservers repointed to
   `ashton.ns.cloudflare.com` / `jade.ns.cloudflare.com`. It had previously been
   delegated to a Route 53 hosted zone that no longer existed, so the domain
   resolved nothing and there were no records to migrate. Zone SSL/TLS mode is
   **Full (Strict)** — anything less weakens the Cloudflare→Vercel hop.
2. **Vercel project**, with the settings above, and `firefighter.sayande.xyz`
   added as a custom domain. Verified with a `_vercel` TXT record, because a
   Cloudflare-proxied record cannot be verified over HTTP.
3. **DNS**, in the `sayande.xyz` zone:
   `CNAME firefighter → cname.vercel-dns.com`, **Proxied**. Proxying is not
   optional: Access only protects hostnames that pass through Cloudflare.
4. **Access.** `firefighter.sayande.xyz` added as an additional hostname on the
   **existing** `firefighter — Dashboard` application. See the trap in item 2 of
   the preamble. No bypass application is needed on this hostname — `/proofs/*`
   and `/slack/events` did not move.
5. **Worker route**, committed: `firefighter.sayande.xyz/api/*` in
   `wrangler.jsonc`, plus an explicit `workers_dev: true`. Deploying before the
   zone is Active fails, which is why this is step 5 and not step 1.
6. **OAuth callbacks.** `redirectUri` is derived from the request's own origin
   (`src/oauth/slack.ts`, `github.ts`), not from a var, so each origin needs its
   callback registered. Slack allows several redirect URLs, so
   `https://firefighter.sayande.xyz/api/oauth/slack/callback` was **added**
   alongside the workers.dev one. A GitHub OAuth app allows exactly one, so that
   is a **move**, and it is why it belongs to the cutover rather than to the
   additive phase.

## The cutover, and how to undo it

Everything except the two switches below is additive: while only those are
outstanding, both dashboards are live and the Vite SPA is untouched.

| Switch | What it does | Reverting it |
| --- | --- | --- |
| `DASHBOARD_BASE_URL` → `https://firefighter.sayande.xyz` | points every approval DM's Review button at the new dashboard | one var, then `pnpm run deploy` |
| GitHub OAuth callback → the new host | moves Connect-GitHub; existing stored connections are unaffected | repoint it back |

Reverting both restores the Vite SPA as the front door without undoing anything
else. Retiring `apps/dashboard` is a separate, deliberate change — and
`BACKEND-GAPS.md` §12 is blunt that two dashboards should not be permanent.

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
