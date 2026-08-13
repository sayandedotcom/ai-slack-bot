# Fire-Fighter Agent

One agent that hears every message the team hears in Slack, wakes on the ones that matter,
fixes bugs on a cloud machine, and opens PRs under the on-duty engineer's name — with
everything committal gated behind one dashboard click.

Spec: `docs/superpowers/specs/2026-08-10-firefighter-agent-design.md`
Phase plans: `docs/superpowers/plans/`

- **Origin:** https://firefighter.sayandeten.workers.dev
- **Stack:** Cloudflare Workers · D1 · Queues · Workers Assets · Hono · Vitest (`@cloudflare/vitest-pool-workers`)

> Architecture diagram, cost breakdown, AI-tool notes, and "what I'd do with another week"
> land here before day 7. This file currently documents only what is already live.

---

## Access and the temporary override

> **ACTION REQUIRED AFTER THE TRIAL — remove the personal-email override.**

The origin sits behind **Cloudflare Access** (Zero Trust team `zellify-firefighter.cloudflareaccess.com`).
Login is Cloudflare one-time PIN by email; no external identity provider is configured.

Three Access applications, because **path scoping in Access is a property of the application,
not of the policy** — a policy cannot be limited to a path, and Access matches the most
specific application:

| Application | Domain | Policy |
|---|---|---|
| `firefighter - Dashboard` | `firefighter.sayandeten.workers.dev` | **Allow** — `@zellify.app`, **plus `sayandeten@gmail.com`** |
| `firefighter - Slack webhook (bypass)` | `…/slack` | **Bypass** — Everyone |
| `firefighter - OAuth callbacks (bypass)` | `…/oauth` | **Bypass** — Everyone |

**`sayandeten@gmail.com` is the deliberate, documented hole.** The trial brief asks for it
because the author has no `@zellify.app` address. Remove it from the *Dashboard* application's
policy when the trial ends and the gate becomes `@zellify.app` only.

The same override also lives one layer down, in the Worker's own approval roster
(`apps/worker/src/access/roster.ts`, Phase 11): it is listed in `FIREFIGHTERS`, not `VIEWERS`,
because the trial's live proof requires it to `PATCH` an approval. Pull it from **both**
places — the Access policy above and that file — together.

### Why the two bypasses are not security holes

Slack cannot authenticate to Access, so a gated `/slack/events` would silently drop every
event — no error, no alert, just an ingest pipeline that goes quiet. The bypass is safe
because the Worker verifies Slack's `v0` HMAC signature itself, with a 300-second replay
window, before doing anything (`src/slack/verify.ts`). Bypassed requests are **not** logged by
Access, which is the trade-off accepted here.

`/oauth/*` is bypassed ahead of Phase 12 for the same reason: OAuth callbacks arrive from
GitHub and Slack, which also cannot authenticate to Access. It is protected by OAuth `state`.

### Verifying the gate still lets ingest through

Any change to Access must be followed by this check. A `302` on the second line means
**ingest is dead**:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://firefighter.sayandeten.workers.dev/api/counters
# 302 -> Access login. Correct.

curl -s -o /dev/null -w '%{http_code}\n' -X POST -d '{}' \
  https://firefighter.sayandeten.workers.dev/slack/events
# 401 from OUR signature check. Correct. 302 means the bypass is broken.
```

A 401 alone only proves the request reached the Worker. Confirm a row still lands in D1
afterwards — post in `#ff-test` and check `events_seen` grows.

---

## Channel policy

Posting permission is a property of the API surface, not of a prompt. `canPost()` is called
**inside** the Slack binding, so the agent is structurally unable to post where it should not.

| mode | ingest | triage | postable |
|---|---|---|---|
| `observe` | yes | yes | **no** — reference customer channels |
| `live` | yes | yes | yes — our own test channels only |
| `internal` | yes | no | bot nudges only |
| *(unmapped)* | yes | no | **no** — fails closed |

Every channel the team is in is ingested (core requirement 1); only *triage* is restricted to
customer channels. Seeding attaches a `customer_slug` — see `apps/worker/scripts/seed-channels.sh`.
`test/policy-live-rows.test.ts` pins the production rows so no `ext-*` channel can be made
postable without failing the suite.

---

## Development

```bash
pnpm install
cd apps/worker
cp .dev.vars.example .dev.vars   # fill in Slack secrets; gitignored
pnpm test                        # runs in workerd against real D1
pnpm typecheck
npx wrangler deploy
```

Production secrets are set with `wrangler secret bulk` — **not** bare `wrangler secret put`
from a non-interactive shell, which uploads an empty string and reports success. See spec §15.
