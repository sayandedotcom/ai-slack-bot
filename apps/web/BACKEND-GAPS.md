# Backend gaps

Everything `apps/web` needs that `apps/worker` does not provide today.

This file is the deliverable half of a front-end-only change: nothing here has
been built, no Worker file has been touched, and each item states what the
front-end already does, what is missing, and the exact contract that would
close it.

First written against `apps/worker/src` at `a4faa2d` on 2026-08-26. **Re-checked
on 2026-08-27** against the Agents-SDK run chassis, which has since been
committed to `main` (`ebb1fb4`…`10bc64c`, Phase 26). That pass closed §3, §4 and
§5, and opened §13 and §14. The three route files it depends on —
`src/api/agents.ts`, `src/api/runs.ts`, `src/run/transport.ts` — were re-read at
`df5e4e8` and are byte-identical to what this app was written against.

Ordered by what blocks what, which is how it read while §1 was still open.
**§1 was answered on 2026-08-28** and took §2 and §4's caveat with it, so
nothing here blocks a live deployment any more; everything from §6 on is a
degradation the UI already handles honestly. Closed sections are kept rather
than deleted: what closed them, and what the front-end now does about it, is
the useful record.

---

## 1. The Access cookie does not cross origins — RESOLVED 2026-08-28

**Status: closed, by option 1 below. `apps/web` is served from
`firefighter.sayande.xyz` and is no longer in demo mode.**

The problem, kept because it is the reason the whole app was built the way it
was. Cloudflare Access gates a hostname and sets `CF_Authorization` scoped to
it. `apps/worker/src/access/jwt.ts` verifies a real JWT against Cloudflare's
JWKS — signature, issuer, audience and expiry, with no dev bypass and no
alternative credential — so a browser on an origin Access never issued a cookie
for is a 401, always. And `next.config.ts`'s rewrite was never a fix for it: a
rewrite proxies the *request*, and the request never carried the cookie.

**What was done.** Option 1, unchanged from how it was written here:
`firefighter.sayande.xyz` is a Cloudflare-proxied CNAME to Vercel, added as an
additional hostname on the **existing** `firefighter — Dashboard` Access
application — so the AUD is the same one `ACCESS_APP_AUD` already pins, and no
Worker code and no var changed. `apps/worker/wrangler.jsonc` gained one route,
`firefighter.sayande.xyz/api/*`, which puts the dashboard and the API on one
origin. Everything else on that hostname has no route and is served by Vercel.

Three consequences, and they are the reason this option was preferred:

- **§2 (CORS) never has to be answered.** The browser makes same-origin
  requests, exactly as it does for the Vite SPA.
- **§4's socket caveat closes.** The run socket resolves against
  `window.location`, so `NEXT_PUBLIC_WORKER_ORIGIN` stays empty and the
  handshake is first-party. This is the only one of the three options that
  achieved that.
- **`GET /api/counters`, `GET /api/runs` and `GET /api/runs/:id/usage` stay
  protected.** Those three have no in-code auth and are gated by Access alone;
  an answer that weakened Access would have exposed them.

**A fourth option was considered and rejected**, because at the time this was
answered there was no Cloudflare zone: having the Worker itself reverse-proxy to
Vercel on the `*.workers.dev` host. It works, but it needs a file whose job is
to strip `Cf-Access-Jwt-Assertion` and the `CF_Authorization` cookie before
forwarding to a third party, and a missed strip leaks a live Access credential
with nothing failing loudly. A domain removed the need for it.

**What did NOT move**, deliberately: `/proofs/*` and `/slack/events` stay on
`firefighter.sayandeten.workers.dev` with their existing bypass applications,
and so does the Vite SPA (`apps/dashboard`), which is the rollback.
`wrangler.jsonc` sets `workers_dev: true` explicitly so that origin keeps
answering.

The two remaining options are recorded for the same reason the problem is —
option 2 was a session exchange (`POST /api/session`, a second credential path
on the Worker, and CORS with it); option 3 was static-exporting the app into the
Worker's `ASSETS`, which would have forfeited Vercel and needed
`generateStaticParams` for `/runs/[id]`.

---

## 2. There is no CORS on `/api/*` — MOOT 2026-08-28

**Status: closed by §1's answer, not by a change. §1 was answered by option
1, so the browser is same-origin with the Worker and no CORS is reachable.**

Still true, and still worth knowing if anything ever puts a browser on a
different origin from `/api/*`: the Worker has no CORS of any kind.

`grep -rn "cors\|Access-Control" apps/worker/src` returns nothing. The Worker
has never needed CORS because the SPA it serves shares its origin.

`next.config.ts`'s rewrite means the browser sees a same-origin request, so the
bundle as written needs no CORS at all. This becomes a gap only if a future
change has the browser call the Worker directly.

**Contract, if it is ever needed:**

```
Access-Control-Allow-Origin: <the exact deployed origin, never *>
Access-Control-Allow-Credentials: true
Access-Control-Allow-Methods: GET, POST, PATCH, OPTIONS
Access-Control-Allow-Headers: content-type, accept
```

plus an `OPTIONS /api/*` preflight handler mounted above the 404 catch-all in
`src/index.ts`. `*` is not usable here: it is incompatible with
`Allow-Credentials`, and the whole point is a credentialed request.

---

## 3. Starting a run — RESOLVED 2026-08-27

**Status: closed. `POST /api/runs` exists and this app calls it.**

This section previously read *"chat has no backend route at all"*, because
commit `2698e88` (`feat!: remove the agent layer, to be rebuilt on the Agents
SDK`) had removed one and not yet replaced it. The Agents-SDK chassis has since
landed on `main`, and with it:

```
POST /api/runs   body { firstMessage: string, clientRequestId?: string }
                 -> 201 { id: string }        // the public run id, never the key
                 -> 422 { code: "invalid_body", ... }
```

Verified in `apps/worker/src/api/runs.ts`. It runs `requireTeamMember` and then
`createRunFromChat`; **viewers may reach it**, deliberately — a chat run has no
customer thread, nothing it says goes out under anyone's name, and every
committal write is still gated by `PATCH /api/approvals/:id`. The opening
message is bounded at `CHAT_FIRST_MESSAGE_MAX_CHARS` (4 000).

**What the front-end does.** `/chat` is a create form and nothing else.
`lib/api/chat.ts` posts, and `makeChatStarter` holds the idempotency rule:
**one `clientRequestId` per text, reused across retries**, because a create
that failed may have arrived and written a run. The Worker derives the run's
key from that id, so a retry resolves to the same run instead of leaving the
human with two conversations for one question. On success the page routes to
`/runs/:id` and the run view takes over — there is no second session shape.

Note the opposite rule for steering, one section down. They are opposites on
purpose and both are pinned in `test/run-idempotency.test.ts`.

---

## 4. The run transcript — RESOLVED 2026-08-27, its caveat RESOLVED 2026-08-28

**Status: closed on the Worker, and the deployment caveat below is closed too —
see §1.**

This section previously read *"there is no run transcript"*. There is one now,
and it is a live WebSocket rather than a poll:

```
ALL /api/runs/:id/agent      -> the Agents SDK transport for RunAgent
ALL /api/runs/:id/agent/*    -> /get-messages and anything else Think serves
```

Verified in `apps/worker/src/api/agents.ts`. Two properties worth naming,
because they shape what this app is allowed to do:

- **Mounted under `/api`, not `/agents/*`.** `/api` is already behind Access.
  `/proofs/*` is the one path Access must let through unauthenticated, and it
  stays the only one.
- **`getAgentByName`, not `routePartykitRequest`.** The browser addresses
  `runs.id`; D1 answers with the Durable Object key; the key never appears in a
  URL (invariant 10). The route also strips any inbound copy of
  `x-firefighter-identity` before stamping the verified one.

`apps/worker/src/run/transport.ts` drops five client frames from every
connection — `cf_agent_use_chat_request`, `cf_agent_chat_clear`,
`cf_agent_chat_request_cancel`, `cf_agent_tool_result`,
`cf_agent_tool_approval` — so **the only write a browser has is the `steer`
RPC**. `lib/hooks/use-run-agent.ts` therefore exposes exactly one verb, and
`makeSteerSender` mints a **fresh** request id per retry: a steer that failed
may never have arrived, and reusing the id would have the agent refuse it as a
duplicate of something that never happened.

### The caveat: a WebSocket does not travel through a Next rewrite

`next.config.ts` proxies `/api/*` to the Worker, which is what keeps every REST
path relative and CORS out of the bundle. **It cannot do that for the socket.**
Next's rewrites proxy an HTTP request; they do not carry a WebSocket upgrade,
and on Vercel there is no upgrade path at all.

So the socket needs the Worker's own host in the bundle, which is
`NEXT_PUBLIC_WORKER_ORIGIN` (`lib/api/socket-host.ts`). That variable carries no
credential and the Worker still gates the socket, so publishing it is safe.

What it does **not** fix is §1, and here §1 bites harder: a WebSocket handshake
is a subresource request, so a `SameSite=Lax` `CF_Authorization` cookie is not
attached to it even when the reader is signed in on that hostname in another
tab. That was the blocker, and **it closed on 2026-08-28**: §1 was answered by
option 1, so the app is served from the same hostname the Worker answers on,
`NEXT_PUBLIC_WORKER_ORIGIN` is empty, the socket resolves against
`window.location`, and the handshake is first-party. The view says so — `RunView` renders "the run socket was refused"
rather than spinning — and demo mode renders a fixture transcript in the
socket's own wire shape.

Serving this app from the Worker's own origin (§1 option 1) removes both
problems at once, which is another argument for that option.

---

## 5. `GET /api/runs/:id` — RESOLVED 2026-08-27

**Status: closed.**

```
GET /api/runs/:id -> 200 { run: PublicRun } | 404 { code: "not_found" }
```

Verified in `apps/worker/src/api/runs.ts`. D1 only — rendering a run must not
wake it — and `publicRun` omits `key`, so the browser keeps addressing runs by
UUID.

**What the front-end does.** `/runs/[id]` reads it directly rather than hunting
the run inside the cached list, which is what makes a pasted `?run=<id>` URL
work for a run that has fallen off the end of the 50-row list. The header
renders from this read alone, so it still draws when the socket cannot connect.

One field it returns is always empty; see §13.

---

## 6. Nothing counts cost per message — RESOLVED 2026-08-28 (shape); the per-message cost figure remains unbuilt

**Status: degradation, partially closed.**

The prototype's funnel line read `triage ≈ $0.0003/msg`. `GET /api/counters`
returns `{ counters: { heard, ingested, triaged, woken, dropped, escalated },
since, window }`. `dropped` is now computed server-side (`triaged - woken`,
clamped at zero, in `src/db/counters.ts`), and `window` (`24h` or `7d`, via
`?window=`) is honoured rather than assumed. `/api/runs/:id/usage` gives a
per-run total, but no endpoint aggregates spend over a window or divides it by
message count.

**What the front-end does today.** The funnel shows no cost figure. `dropped`
is derived as `triaged - woken`, clamped at zero, labelled in italics, and its
tooltip says the endpoint does not count it — a number nobody counted should not
look like one somebody did.

**Contract, if it is wanted:** add `costUsd: string` (decimal string, never a
float) to the `/api/counters` body, covering the same 24h window as the
counters. The front-end has `usd()` in `lib/format.ts` and never parses it.

---

## 7. There is no rotation, and the UI no longer implies one

**Status: not a gap. Recorded so nobody re-adds it from the old screenshots.**

The prototype showed a three-day shift with a countdown ("Luka is on duty · 31h
12m left"), a rotation schedule, and a "last shift" column. Rotation was removed
on 2026-08-17; `src/identity/speaker.ts` picks the first fire-fighter in roster
order who has connected Slack, and `/api/roster` returns `speaker`,
`githubSpeaker`, `pool`, `engineers`. There is no shift, no clock, no history.

**What the front-end does today.** The hero says *"luka speaks by default"* and
explains that an approved reply goes out as whoever approved it. The roster card
lists the pool in tie-break order with connect state — which *is* the selection
rule, not a description of it. No countdown exists anywhere in the codebase.

If a rotation is ever wanted again it needs a real source
(`GET /api/rotation -> { current, until, next[] }`) and a scheduler behind it.
It should not be reconstructed in the browser.

---

## 8. "Agent may act as me" has no write endpoint

**Status: degradation, deliberately not built.**

The prototype's team table had a per-person toggle. No route writes such a flag;
`src/db` has no column for it, and `src/identity/speaker.ts` consults only
whether an OAuth token exists.

**What the front-end does today.** The team table renders Slack and GitHub as
connect state, not as a switch. Connecting **is** the consent, and revoking the
token in Slack is how it is withdrawn. A toggle that wrote nowhere would be a
lie about who is in control of a customer-facing account.

**If it is genuinely wanted** it needs a column, a `PATCH /api/roster/me`
scoped to the caller's own row (never anyone else's), and
`src/identity/speaker.ts` must consult it — otherwise the switch is decorative
and the agent speaks as someone who switched it off.

---

## 9. A run carries no PR or issue

**Status: degradation.**

The prototype showed `PR #1414 open` and `scoped · ZEL-2041 filed` on run rows.
`RunSummary` from `GET /api/runs` has `id, origin, status, shadow, summary,
channelId, channelName, customerSlug, createdAt, updatedAt` and nothing else.
The agent does open PRs (`src/git/commit.ts`) and file Linear issues, but the
run row does not carry the result.

**What the front-end does today.** Neither is shown. Nothing is fabricated.

**Contract needed:** add `artifacts?: { kind: "pr" | "issue"; ref: string; url:
string; state: string }[]` to the run summary. `ref` is what to render
(`#1414`, `ZEL-2041`), `url` is where to send the click.

**RESOLVED 2026-08-28:** `GET /api/runs/:id/effects` exposes the effect
ledger's `safe_result_json`; the UI links a PR/issue/post only when that
payload carries a URL. Nothing is fabricated.

---

## 10. A 409 on an approval never says who won

**Status: degradation, already worked around at real cost.**

`src/api/approvals.ts:288` answers a lost CAS with
`{ ...fail("already_decided", …), decision }` — the winning decision, and no
`decidedBy`. The decider's name exists only on `GET /api/approvals/:id`.

**What the front-end does today.** It renders *"Someone else approved this
first"* on the 409 alone, then fires one opportunistic detail read whose only
permitted effect is filling in the name on an already-resolved card. It cannot
change the decision or un-resolve the card, and its failure is invisible. See
`lib/hooks/use-approvals.ts` and the `nameDecider` action in
`lib/store/approvals-overlay.ts`, which refuses to touch anything but a
`resolved` card with a `null` name.

That extra request exists only because of this gap. Adding `decidedBy` to the
409 body removes a network round trip and a whole branch of client state.

**Contract needed:** `{ code: "already_decided", message, decision, decidedBy }`.

**RESOLVED 2026-08-28 (backend):** the 409 body carries `decidedBy`. The
front-end has not caught up yet — `nameDecider` and the `reconciled` set in
`lib/store/approvals-overlay.ts` still exist and are still exercised by
`use-approvals.ts`'s opportunistic detail read. That workaround is now
provably redundant and a later task (the `apps/web` rewrite) should delete it
rather than keep both paths.

---

## 11. The nudge preview is reconstructed, not read

**Status: cosmetic.**

`src/notify/nudge.ts` composes the Block Kit DM server-side. No endpoint returns
what was actually sent, so the dashboard's "The nudge, as it arrives" card
rebuilds an approximation from the oldest open approval.

It can therefore drift from the real message without anything failing. If that
matters, `GET /api/approvals/:id/nudge -> { blocks, deliveredAt, channel }`
would make it a read rather than a re-render.

---

## 12. Deployment overlap — now live, and still a decision to make

Not a missing endpoint — a decision that has to be made once, and is not mine.
§1 is answered, so this is no longer hypothetical: **both front-ends are
deployed.**

The Worker still serves `apps/dashboard/dist` as its `ASSETS` bundle, with
`not_found_handling: "single-page-application"` in `wrangler.jsonc`. Nothing in
this change touched that: `pnpm run deploy` in `apps/worker` still builds and
ships the Vite SPA, and it keeps working.

So after a Vercel deployment there are two front-ends against one API. That is
fine and even useful while the new one is being judged, but it should not be
permanent — two dashboards that disagree during an incident is worse than
either one alone. Retiring `apps/dashboard` is a separate, deliberate change.

The two front-ends are now genuinely equivalent in what they can do: both start
runs, both stream a transcript over the same socket, both decide approvals
through the same audited route. The Vite SPA renders a run inline under the
runs list; this one gives it a URL at `/runs/:id`. That is the only behavioural
difference, and it is deliberate.

(`apps/web` itself grew from three routes to six in the 2026-08-28 redesign —
`/`, `/runs` [+ `/runs/[id]`], `/approvals`, `/team`, `/channels`, `/eval` — but
that is a routing change, not a new backend surface; every route still reads
through the same endpoints this document tracks.)

Environment, for the record — there are two Worker-origin variables and they do
different jobs:

| Variable | Scope | What it is for |
| --- | --- | --- |
| `WORKER_ORIGIN` | server-only | `next.config.ts` rewrites `/api/*` and `/proofs/*` here |
| `NEXT_PUBLIC_WORKER_ORIGIN` | in the bundle | where the run socket dials (§4) |
| `NEXT_PUBLIC_DEMO` | in the bundle | `1` serves everything from fixtures |

Both origin variables are empty and unused when `NEXT_PUBLIC_DEMO=1`, and both
are unnecessary when the app is served from the Worker's own host.

---

## 13. `runs.summary` is never written — RESOLVED 2026-08-27

**Status: closed the same day this section was written, by a change this
document then failed to record. Everything below describes the old state.**

`beforeTurn` now queues `applySummaryProjection`, which writes the turn's own
`asked` text through `projectSummary` (`src/run/agent-projection.ts`) —
redacted BEFORE it is truncated, whitespace collapsed to one line, bounded at
`RUN_SUMMARY_LIMIT`. The first turn's question wins permanently, because
`setRunSummaryIfAbsent` carries `AND summary IS NULL`: a list whose rows rewrite
themselves every turn cannot be scanned.

`runs` has a `summary` column, `GET /api/runs` and `GET /api/runs/:id` both
return it, and the runs list and the run header are built to show it. Nothing
populates it. `createOrGetRunUnderPolicy` inserts `summary` as `NULL`
(`src/run/repository.ts`), `setRunSummary` in the same file has **no callers**,
and `grep -rn "setRunSummary" apps/worker/src` returns only its declaration.
`projectRunSnapshot` writes a summary it is handed, and the projection path on
the new chassis never hands it one.

So on a live Worker every run renders the empty-summary fallback, and the runs
list is a wall of statuses with no way to tell one thread from another.

**What the front-end does.** Both surfaces say it plainly rather than rendering
a blank: *"No summary — the agent was woken but has not written one yet."* That
sentence is now literally true of every run, which is worse than it sounds.

**Contract needed:** nothing new — the column, the read and the writer all
exist. Something on the run path has to call `setRunSummary`, most naturally
once the model has taken its first look at the thread. Until then this is the
single highest-value thing the backend could do for either dashboard.

---

## 14. Nothing behind Access can be exercised on localhost

**Status: not a gap in the Worker — a fact about the gate, worth writing down.**

`requireTeamMember` verifies a real Access JWT off `Cf-Access-Jwt-Assertion`
(`src/api/identity.ts`), and `wrangler dev` has no Cloudflare Access in front of
it. So `POST /api/runs`, `GET /api/runs/:id`, the run socket and **both channel
routes** answer 401 against a local Worker. The runs list, counters, roster and
approvals are reachable; starting a run, opening a transcript and correcting a
channel are not.

This is not new and it is not this app's doing — `apps/dashboard/dev-stubs.ts`
stubs identity, roster and approvals for exactly this reason, and deliberately
**refuses** to stub these three. Its argument is worth repeating: a faked create
hands back an id whose socket then refuses, which reads as a bug in the run view
rather than as the absence of Access, and a stubbed socket would be a fiction of
a live transcript.

**What it means here.** `WORKER_ORIGIN=http://localhost:8787 pnpm dev` is still
the right way to develop the dashboard against real D1 data. It is *not* a way
to develop the run surfaces. Those are `NEXT_PUBLIC_DEMO=1`, or a deployed
Worker behind the real Access application.

---

## 15. The channel registry — RESOLVED on arrival

**Status: closed. It landed with a control surface already attached.**

Never a gap: `GET /api/channels` and `PATCH /api/channels/:id` arrived on the
Worker (`src/api/channels.ts`) at the same time as the auto-registration that
made them necessary, and this app consumes both. Recorded here because the
authorization split is unusual and easy to get wrong from the front-end side:

```
GET   /api/channels        -> 200 { channels: Channel[] }   any rostered member
PATCH /api/channels/:id    -> 200 Channel                   FIRE-FIGHTERS ONLY
                              422 invalid_patch · 404 unknown_channel
```

The read is any team member; the write is fire-fighters, checked **before** the
body is parsed or D1 is touched — the same ordering as
`PATCH /api/approvals/:id`, and for the same reason: `mode` decides what the
agent may say and `customerSlug` decides whose data it may read.

**What the front-end does.** `ChannelsPanel` renders the table for everyone and
the controls for fire-fighters only. Hiding the controls is not the enforcement
— the Worker refuses a viewer's write regardless — it just avoids offering an
action that will 403.

Two things it deliberately does not do. It never predicts `slugSource`:
confirming a slug promotes it to `human` and clearing it drops back to
`derived`, and both happen in the Worker's single statement, so the row it
returns is what gets written into the cache. And it offers no create and no
delete, because the route has neither — registration is the registrar's job,
and a channel the bot was removed from keeps its row (Slack refuses the post
with `not_in_channel`, which is a better enforcement point than a row somebody
has to keep in sync).

---

## 16. Runs list — RESOLVED 2026-08-28

**Status: closed. Recorded because the shape is new since this file's last
pass and nothing above described it.**

`GET /api/runs` accepts `status, origin, channelId, shadow, q, cursor, limit`
as query parameters (`src/api/runs.ts`) and returns `{ runs, nextCursor }`
(`src/run/repository.ts`, `RunListPage`). Each row (`RunListItem`) is `id,
origin, status, shadow, summary, channelId, channelName, customerSlug,
createdAt, updatedAt` plus the three this branch added: `costUsd` (a decimal
string, never a float — the same invariant as `/api/runs/:id/usage`), `turns`,
and `openApprovalId` (`string | null`). Note this is NOT the same shape as
`GET /api/runs/:id` (`publicRun()` in `src/api/runs.ts`), which carries
`threadTs` instead of `channelName`/`customerSlug` and has no `costUsd`,
`turns` or `openApprovalId` — the list row is a join across `channels`,
`agent_model_calls` and the open `approvals` row that the single-run read
does not do. `cursor` is opaque and only ever round-tripped from a previous
`nextCursor`; an unrecognized value is a 400, not a silent reset to page one.

`GET /api/runs/:id/approvals` returns that run's approval history —
`src/api/runs.ts`. `GET /api/approvals?state=decided&since=` extends the
existing queue read (`src/api/approvals.ts`) with a decided-only view bounded
by a timestamp, alongside the pre-existing `state=open` default.

---

## What was verified, and how

Every claim above was checked against the tree rather than against `CLAUDE.md`.

The 2026-08-27 pass first read the Worker in the main working tree, before that
work was committed; it was re-checked at `main` `df5e4e8` and the three files it
turns on had not moved. Anything below that names a file is a file that was
read, not a route inferred from a description.

- Route inventory: `apps/worker/src/index.ts` mounts, plus `.get(`/`.post(`/
  `.patch(` across `src/api/*.ts` and `src/oauth/*.ts`.
- The run socket: `src/api/agents.ts` in full, and `src/run/transport.ts` for
  `BLOCKED_CLIENT_FRAMES` and `AGENT_IDENTITY_HEADER`.
- `POST /api/runs`: `src/api/runs.ts`, `parseChatCreate` and the handler.
- The empty summary (§13): `createOrGetRunUnderPolicy`'s INSERT and the absent
  callers of `setRunSummary`, both in `src/run/repository.ts`.
- The localhost gate (§14): `requireTeamMember` in `src/api/identity.ts`, and
  the comment block in `apps/dashboard/dev-stubs.ts` that names the same
  routes and says why it will not stub them.
- The channel routes and their split authorization (§15): `src/api/channels.ts`
  in full — the `member.role !== "firefighter"` check on the PATCH, the slug
  regex, and the single UPDATE that moves `customer_slug` and `slug_source`
  together.
- That a Next rewrite cannot carry a WebSocket upgrade: `next.config.ts`
  rewrites are HTTP proxies, and the `host` option this app passes instead is
  `PartySocketOptions.host`, resolved in
  `partysocket/dist/index.js` (it strips the scheme and picks `ws`/`wss` from
  whether the host looks local).
- CORS: `grep -rn "cors\|Access-Control" apps/worker/src` — no matches.
- The 409 body: `src/api/approvals.ts`, the `already_decided` branch.
- Access has no bypass: `src/access/jwt.ts`, and the comment at the top of
  `apps/dashboard/dev-stubs.ts` which exists precisely because of it.
- Speaker selection and the absence of rotation: `src/access/roster.ts` and
  `src/identity/speaker.ts`.

Baseline when this file was first written, run in this worktree: `apps/worker`
860 tests in 58 files passing, `apps/dashboard` 26 passing, all four workspaces
typechecking. Nothing outside `apps/web` was touched except one corrected
Tailwind `@source` glob in `packages/ui` (design spec §8) and two env names
added to `turbo.json`. That is still true after the 2026-08-27 pass: closing
§3–§5 was a change to `apps/web` alone, reading a Worker somebody else wrote.
