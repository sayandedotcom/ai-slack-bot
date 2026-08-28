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

## The dashboard-side steps, as built

None of this is in the repository, so it is written down here instead. Done
2026-08-28; the ordering is load-bearing and two steps are traps.

1. **Cloudflare zone.** `sayande.xyz` (registrar GoDaddy, unchanged — no
   registrar transfer was needed) had its nameservers repointed to
   `ashton.ns.cloudflare.com` / `jade.ns.cloudflare.com`. It had previously been
   delegated to a Route 53 hosted zone that no longer existed, so the domain
   resolved nothing and there were no records to migrate. Zone SSL/TLS mode was
   `full` and was changed to **Full (Strict)**.

2. **Vercel project — now `ai-slack-bot-web`** (`prj_3vPGGd9EbJZQmFENscbrq8PE8NZo`,
   team `sayandedotcom-6343`), linked to `sayandedotcom/ai-slack-bot`, Root
   Directory `apps/web`.

   It was originally `slack-bot-web` on team `sayande2002s-projects`, and the
   move is worth recording because it will happen again to somebody.
   **That account's billing lapsed and Vercel began answering `402 Payment
   Required` for every request** — the dashboard went down while the API,
   which is the Worker and was never on Vercel, kept serving perfectly. Adding
   the domain came back **`verified: true` immediately** in both accounts, so
   **no `_vercel` TXT record was needed** either time. Add one only if Vercel
   reports the domain as unverified.

   **Moving a hostname between Vercel accounts, in order.** A domain can only
   be claimed by one account, so:
   `DELETE /v9/projects/{old}/domains/{host}`, then
   `DELETE /v6/domains/{host}` to release it from the old account's domain list
   as well — the second is the one people forget, and without it the new
   account cannot add the host. Then add it on the new project. **Grey-cloud the
   CNAME before adding it**, for exactly the reason in step 3: the new project
   has to issue its own certificate, and Cloudflare's proxy eats the challenge.
   Re-proxy once the host serves a certificate whose CN is the hostname.
   Nothing on the Cloudflare or Access side changes — not the route, not the
   AUD, not the application. Only which Vercel project answers.

   **The current team is on the Hobby plan, whose terms forbid commercial
   use.** Recorded as a known exposure rather than a recommendation: it is the
   same class of interruption that caused this move.

3. **DNS, and this is the first trap.** Create the CNAME **DNS-only (grey
   cloud) first**:
   `CNAME firefighter → cname.vercel-dns.com`, TTL 60.
   Vercel has to issue its own TLS certificate for the hostname, and it does
   that with an ACME challenge against the public record — **which Cloudflare's
   proxy intercepts**. Proxy first and the certificate never issues. This is the
   "cert-issuance friction" `docs/tech-stack.md` refers to. Wait until Vercel
   reports `misconfigured: false` and the host serves a certificate whose CN is
   the hostname, **then** flip the record to **Proxied**.
   (A stale, expired `*.sayande.xyz` Let's Encrypt certificate was being served
   at first — renewal had been failing since April because of the dead Route 53
   delegation. It cleared once DNS resolved again.)

4. **Access.** `firefighter.sayande.xyz` was added as an additional destination
   on the **existing** `firefighter — Dashboard` application
   (`689056b1-33a4-402b-ae15-ae80716948d7`), so the AUD is still
   `1adc17dd…` and `ACCESS_APP_AUD` did not change. See the trap in item 2 of
   the preamble. No bypass application is needed on this hostname — `/proofs/*`
   and `/slack/events` did not move.

   **API note:** `PATCH /accounts/{id}/access/apps/{app}` is refused with
   `10405: Method not allowed for this authentication scheme`. Use `PUT` with
   the full object. `PUT` replaces the application, so **verify afterwards that
   the policy survived** — an application with no policy is an outage. It did
   survive here, but check rather than assume.

5. **Cloudflare's own edge certificate, the second trap.** On a zone activated
   the same day, Universal SSL sits at `pending_validation` and **every TLS
   handshake to the proxied hostname fails** (`sslv3 alert handshake failure`)
   until it issues. Nothing is misconfigured; it took about eight minutes here.
   `GET /zones/{id}/ssl/verification` is where to watch it.

6. **Worker route**, committed: `firefighter.sayande.xyz/api/*` in
   `wrangler.jsonc`, plus an explicit `workers_dev: true`. Deploying before the
   zone is Active fails, which is why this is last and not first.

7. **OAuth callbacks.** `redirectUri` is derived from the request's own origin
   (`src/oauth/slack.ts`, `github.ts`), not from a var, so each origin needs its
   callback registered. **Both providers accept several**, so both are
   **additions** rather than moves — each app now lists the workers.dev callback
   and `https://firefighter.sayande.xyz/api/oauth/…/callback` side by side, and
   Connect-Slack and Connect-GitHub work from either dashboard. (GitHub marks
   one of its callback URLs *Default*; that only picks which is used when a
   request omits `redirect_uri`, and this Worker always sends one.)

### Verified after the fact

```
NEW  /              302 -> …/cdn-cgi/access/login/…?kid=1adc17dd…   (right app)
NEW  /api/identity  302 -> same AUD
OLD  /              302 -> same AUD                                 (unchanged)
OLD  /proofs/x      404 from the Worker, NOT a redirect             (bypass intact)
OLD  /slack/events  200,                 NOT a redirect             (bypass intact)
```

### Known deviations from this document

- Project **node version is 24.x**, not the 22.x in the table above. `engines`
  is `>=22.20.0`, so it satisfies it and the build is green; left alone rather
  than changed under a working deployment.
- The project is named `slack-bot-web` and is linked to
  `sayandedotcom/ai-slack-bot`, not `Zellify/firefighter`. That is what this
  checkout's `origin` points at.

## The cutover — DONE 2026-08-28

Everything except the switches below was additive, and in the end the OAuth
half turned out to be additive too — both providers accept multiple callback
URLs, so both dashboards kept every capability. **`firefighter.sayande.xyz` is
now the front door**, and the only thing the old one lost is being what Slack
points at.

| Switch | State | Reverting it |
| --- | --- | --- |
| `DASHBOARD_BASE_URL` → `https://firefighter.sayande.xyz` | **done** — every approval DM's Review button now deep-links into the Next app, where `?approval=` rings the named card | one var, then `pnpm run deploy` |
| GitHub OAuth callback → the new host | **done, and additively** — GitHub accepts several callback URLs, so both hosts are registered and Connect-GitHub works from either. Nothing was taken away. | remove the new URL |

**The Vite SPA at `firefighter.sayandeten.workers.dev` still works and still
serves from `assets`.** It simply stopped being what Slack sends people to.
Reverting the two rows above makes it the front door again, and nothing else
needs undoing.

What deliberately did **not** move, and should not be moved casually:
`PROOFS_BASE_URL` and `/slack/events`. Proof links are already pasted into
customer Slack threads and resolve against the workers.dev origin, and the
Slack webhook is HMAC-verified and gains nothing from a prettier hostname.
Both depend on `workers_dev: true` staying true.

Retiring `apps/dashboard` altogether is a separate, deliberate change — and
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
