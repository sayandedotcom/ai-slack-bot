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

<!-- G2-TEMP-OVERRIDE -- grep this exact string (also in roster.ts and phase-11-notes.md)
     to find every tag of release gate G2 in one search. -->

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

## What the sandbox is allowed to know

The Tier 2 container holds **no write credentials**. It emits artifacts — a diff, a
recording, logs — and the Worker performs every write. There is no Slack token, no GitHub
token and no Linear key inside it to exfiltrate. Its one credential-shaped need, cloning a
private monorepo, is met without a credential: git's remote points at a sentinel host, and
the real PAT is substituted Worker-side on egress, so the container only ever sees a
placeholder.

A dev server is the exception that has to be stated rather than glossed. `apps/web` and
`apps/dashboard` validate their environment with zod at startup and will not boot without
real values, so while one runs, those values exist inside the container.

**The container receives 28 environment variables, not the 115 the dev environment
contains.** The excluded 87 are the ones that could do damage and that a dev server
rendering a funnel page has no use for: both Stripe secret keys, every payment provider's
credentials, the Discord webhooks, the Tinybird token, the analytics database URLs, the
Meta/TikTok/Snapchat tokens, `ANTHROPIC_API_KEY`. What is included is every `NEXT_PUBLIC_*`
(they ship in the client bundle and are public by construction), the Supabase pair,
`REDIS_URL`, and the S3 trio.

The selection is an allowlist with a deny-list on top, and it was **verified against the
apps' own zod modules** — `apps/web/lib/env.{client,server}.ts` and
`apps/dashboard/src/_lib/env.client.ts` — so every variable those modules require is
present. It deliberately errs wide *within* the harmless set: a missing variable at drill
time is a worse failure than a slightly larger payload.

Cloudflare's 5.1 kB limit on a text binding is what surfaced this — the full 115-key blob is
8.2 kB and was refused. **The limit is not the reason to keep the curation.** Least privilege
is. Splitting the secret across two bindings would have satisfied the platform and left the
container holding a payment credential it never needed.

Two limits stated plainly rather than implied away:

- **Per-process injection is a reduction in blast radius, not a boundary.** Values are passed
  to the process that needs them rather than into the container's ambient environment, but
  `exec({ cmd: "env", injectDevEnv: true })` returns stdout to the model. Known dev-env values
  are therefore redacted from every output that crosses back — `stdout`, `stderr`, process
  tails, file reads. That defeats the case that actually happens: a value landing in a run
  transcript, then in memory, then conceivably in a customer-facing draft.
- **Redaction does not stop deliberate encoding.** A model that runs `env | base64` defeats it;
  both `base64` and `rev` are in the image. Values shorter than 16 characters are also left
  alone, because redacting every occurrence of `dev` would destroy the build logs it appears in.

These are dev-tier read credentials, disjoint from every write path, never baked into the
image, and sourced from a Worker secret the model cannot name or enumerate. The exposure is
the same shape as an engineer running `pnpm dev` on a laptop.

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
