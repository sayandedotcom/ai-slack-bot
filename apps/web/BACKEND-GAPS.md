# Backend gaps

Everything `apps/web` needs that `apps/worker` does not provide today.

This file is the deliverable half of a front-end-only change: nothing here has
been built, no Worker file has been touched, and each item states what the
front-end already does, what is missing, and the exact contract that would
close it. Verified against `apps/worker/src` at commit `a4faa2d` on 2026-08-26.

Ordered by what blocks what. §1 blocks every live request; §2–§4 block whole
features; §5 onward are degradations the UI already handles honestly.

---

## 1. The Access cookie does not cross origins — this blocks everything

**Status: blocking. Demo mode is what renders on Vercel until this is answered.**

Cloudflare Access gates `firefighter.sayandeten.workers.dev` and sets
`CF_Authorization` scoped to that hostname. `apps/worker/src/access/jwt.ts`
verifies a real JWT against Cloudflare's JWKS and has no dev bypass and no
alternative credential: an unauthenticated `/api/identity` is a 401, always.

A browser loading `firefighter.vercel.app` holds no cookie for the Worker's
hostname. It never did, so there is nothing for the request to carry.

**`next.config.ts`'s rewrite does not fix this and is not meant to.** A rewrite
proxies the *request* — it keeps CORS out of the bundle and keeps every path in
`lib/api` relative, which is worth having on its own. But the request it
forwards has no Access cookie in it, so the Worker answers 401 exactly as it
should.

**What the front-end does today.** `AppShell` reads `/api/identity` once. On
401 it replaces the entire page with "Signed out — Access didn't recognise this
session", rather than rendering eight panels that each fail the same way.
That is the correct behaviour and it is what a live Vercel deployment will show
right now.

**Three ways out, in the order I would consider them.** None is mine to pick.

1. **Put the Vercel hostname behind the same Access application.** Point a
   Cloudflare-proxied CNAME at Vercel and add the hostname to the existing
   "firefighter — Dashboard" application. The cookie is then issued for the
   host the browser is actually on, every existing route works unchanged, and
   no Worker code changes at all. Cheapest, and the only option that keeps
   `src/access/jwt.ts` as the single authority on identity.
2. **A session exchange.** Add `POST /api/session` on the Worker: presented with
   a valid Access JWT it mints a short-lived, `SameSite=None; Secure` cookie or
   a bearer token scoped to the roster email. The front-end would need a
   sign-in step, the Worker a second credential path, and `requireIdentity`
   would stop being one function with one input. More moving parts, and a new
   thing to get wrong.
3. **Do not deploy the front-end separately.** Keep serving it from the Worker
   (`next build` → static export → `ASSETS`), which is what `apps/dashboard`
   does today. This forfeits the reason for the move but is free.

**Until then:** set `NEXT_PUBLIC_DEMO=1` on the Vercel project. The app renders
completely from fixtures and labels itself "Demo data" in the header.

---

## 2. There is no CORS on `/api/*`

**Status: blocking, if §1 is answered by anything other than option 1 or 3.**

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

## 3. Chat has no backend route at all

**Status: blocking. The page ships as a fixture and says so on screen.**

Commit `2698e88` (`feat!: remove the agent layer, to be rebuilt on the Agents
SDK`) removed it. As of `a4faa2d`, `apps/worker/src/index.ts` mounts
`/slack`, `/api` (counters, backfill, runs, approvals, artifacts, identity,
both OAuth routers, eval) and `/proofs`. There is **no** `/agents/*`, **no**
`/ws/run/:id`, and no route that creates a chat run or appends a turn.
`grep -rn "createRunFromChat\|routeAgentRequest" apps/worker` returns nothing,
though `CLAUDE.md` still describes both.

Note that `apps/dashboard/vite.config.ts` still proxies `/agents` and `/ws` to
`wrangler dev`. Those proxies currently forward to a 404.

**What the front-end does today.** `lib/api/chat.ts` exposes
`chatIsDemoOnly(): boolean`, hardcoded `true`. `getChatThread()` returns the
fixture and the live branch is an explicit `Promise.reject` rather than a fetch
of a path that 404s, so wiring a real transport is a deliberate edit in one
place. The composer is disabled with a tooltip naming the reason, and the page
carries a banner naming the commit.

**Contract needed.** Whatever the rebuilt agent layer settles on, the minimum
this page consumes is:

```
POST /api/chat                 -> 201 { runId: string }
POST /api/chat/:runId/turns    -> 201 { turnId: string }   body: { text: string }
GET  /api/chat/:runId          -> 200 { messages: ChatMessage[] }
```

with `ChatMessage` as declared in `lib/api/chat.ts` — `{ id, author: "user" |
"agent", name, role, at, text, citations?, toolCalls? }`. Citations must carry
the Slack permalink; a memory answer with no way back to the thread is not
checkable, which is most of what the page is claiming.

Streaming is a nice-to-have, not a requirement: the transcript renders whole
turns. If a socket comes back, `useQuery` on `queryKeys.chat` is the seam to
replace.

---

## 4. There is no run transcript

**Status: blocking for the run detail sheet's most useful content.**

Same cause as §3. `GET /api/runs` returns summaries and
`GET /api/runs/:id/usage` returns a cost total. Nothing returns a run's turns,
tool calls, or stream events.

**What the front-end does today.** The `?run=` sheet shows the meta and the
spend, then one line: *"There is no transcript here because the Worker exposes
no route that returns one."* A "Transcript" tab that rendered a permanent
spinner would be worse than the sentence.

**Contract needed:** `GET /api/runs/:id/turns -> 200 { turns: Turn[] }`, where a
turn carries at least `{ id, at, role, text, toolCalls }`. Secrets must be
redacted server-side before this is exposed — invariant 39 applies to a
transcript at least as much as to a log.

---

## 5. There is no `GET /api/runs/:id`

**Status: degradation. The UI works; it is doing more work than it should.**

`src/api/runs.ts` mounts `/runs` (list) and `/runs/:id/usage`. There is no
single-run read.

**What the front-end does today.** `RunSheet` finds its run inside the cached
list from `useRuns()`. This is fine while the list is capped at 50 and the sheet
is opened from a row, and it costs nothing extra. It breaks the moment somebody
pastes a `?run=<id>` URL for a run that has fallen off the end of the list —
the sheet then shows a skeleton that never resolves. Which is exactly the case
the shareable URL exists for.

**Contract needed:** `GET /api/runs/:id -> 200 { run: RunDetail }` / `404`.
`RunDetail` already exists in the old SPA's types — the list row plus
`threadTs`, minus the joined display names.

---

## 6. Nothing counts cost per message

**Status: degradation, already handled.**

The prototype's funnel line read `triage ≈ $0.0003/msg`. `GET /api/counters`
returns `{ seen, triaged, woken, escalated }` and `since`, and nothing else.
`/api/runs/:id/usage` gives a per-run total, but no endpoint aggregates spend
over a window or divides it by message count.

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

## 12. Deployment overlap, once §1 is answered

Not a missing endpoint — a decision that has to be made once, and is not mine.

The Worker still serves `apps/dashboard/dist` as its `ASSETS` bundle, with
`not_found_handling: "single-page-application"` in `wrangler.jsonc`. Nothing in
this change touched that: `pnpm run deploy` in `apps/worker` still builds and
ships the Vite SPA, and it keeps working.

So after a Vercel deployment there are two front-ends against one API. That is
fine and even useful while the new one is being judged, but it should not be
permanent — two dashboards that disagree during an incident is worse than
either one alone. Retiring `apps/dashboard` is a separate, deliberate change.

---

## What was verified, and how

Every claim above was checked against the tree rather than against `CLAUDE.md`,
which is ahead of the code in places (it describes `RunDO`, `createRunFromChat`
and a `/ws/run/:id` socket that `apps/worker/src` no longer contains).

- Route inventory: `apps/worker/src/index.ts` mounts, plus `.get(`/`.post(`/
  `.patch(` across `src/api/*.ts` and `src/oauth/*.ts`.
- CORS: `grep -rn "cors\|Access-Control" apps/worker/src` — no matches.
- The 409 body: `src/api/approvals.ts`, the `already_decided` branch.
- Access has no bypass: `src/access/jwt.ts`, and the comment at the top of
  `apps/dashboard/dev-stubs.ts` which exists precisely because of it.
- Speaker selection and the absence of rotation: `src/access/roster.ts` and
  `src/identity/speaker.ts`.

Baseline at the time of writing, run in this worktree: `apps/worker` 860 tests
in 58 files passing, `apps/dashboard` 26 passing, all four workspaces
typechecking. None of them were touched by this change except one corrected
Tailwind `@source` glob in `packages/ui` — see the design spec §8.
