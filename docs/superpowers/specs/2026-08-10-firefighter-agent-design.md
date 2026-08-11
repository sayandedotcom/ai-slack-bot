# Fire-Fighter Agent — Design

**Date:** 2026-08-10
**Repo:** `Zellify/firefighter`
**Status:** approved spine, subsystems to be specced individually

---

## 1. What this is

Zellify's customers live in external Slack channels. Every three days one engineer becomes
the fire-fighter and owns everything customer-facing. Today that shift is copy-paste: the
customer's message goes into a coding agent verbatim, the answer comes back to Slack
verbatim, and the human supplies routing, judgment, and approval.

This system removes the routing. The human supplies judgment and approval only.

Three message shapes arrive — questions, feature requests, bug reports — but **nothing in
this design knows those categories exist.** There is one agent with one tool. What
distinguishes a bug from a question is which capabilities the agent happens to reach for,
not which branch the harness took.

---

## 2. Decisions

Six decisions form the spine. Each is defensible in one sentence; the reasoning is in the
sections that follow.

| # | Decision | One-line defense |
|---|---|---|
| D1 | **Two execution tiers, one agent.** Model gets one tool: write TypeScript. Tier 1 is a Worker Loader isolate; Tier 2 is a Cloudflare Sandbox the agent boots itself. | This is Cloudflare's own published execution ladder (Project Think), and it means the agent escalates its *execution tier* because work needs a shell — not because a classifier said "bug". |
| D2 | **Single origin.** One Worker serves the SPA, the API, the Slack webhook, the OAuth callbacks, and the WebSocket upgrade. No Vercel. | Every pixel is live socket state, so SSR buys nothing; single origin collapses Access to one app, makes the WebSocket same-origin, and reduces deploy to one command. |
| D3 | **Runs are thread-scoped, and a run has one inbox.** Approval resolutions, human steering, and the customer's next message are the same event: a turn appended to the session. | You cannot suspend a code-mode isolate for four hours, so blocking `await escalate()` is a lie at runtime. Turn-injection is honest *and* removes the separate resume path. |
| D4 | **Two stores.** D1 is the system of record; Zep is the recall layer, partitioned per customer plus one org graph. | Graph memory is lossy and probabilistic; citations must be exact. Citations resolve through D1, so they are correct by construction rather than by the model's good behavior. |
| D5 | **Cloudflare Sandbox, holding zero write credentials.** The container emits artifacts — a diff, an mp4, logs. Every outbound write happens Worker-side. | "Model-authored code never touches raw credentials" holds at both tiers by topology, not policy, and it makes the sandbox provider swappable. |
| D6 | **Policy lives in the bindings, not the prompt.** Channel posting mode and the Linear team id are enforced by the API surface the model calls. | A boundary in a system prompt holds until the one time it doesn't, and that failure posts to a real customer under an engineer's name. |

### Deliberately not chosen

- **`@cloudflare/think`** — its execution ladder is the right model and is cited as prior
  art, but it is a preview release. A preview base class on a 7-day clock is where the
  week disappears. Build on stable `agents` + `@cloudflare/codemode` + `@cloudflare/sandbox`.
- **Socket Mode**, despite the app carrying a `connections:write` app-level token. A Worker
  already has a public HTTPS endpoint; Socket Mode would need a Durable Object holding a
  persistent WebSocket to Slack for no benefit.
- **Honcho** — built around modeling an individual person's psychology. The wrong shape for
  "what did we learn about this account."
- **MCP servers as the integration surface.** See §6.

---

## 3. Architecture

```
                    Slack (customer channels + #eng-firefighter)
                              │  every message, channels only, never DMs
                              ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ WORKER  firefighter.<domain>        ← Cloudflare Access (1 app)  │
  │                                       bypass: /slack/*, /oauth/* │
  │  /slack/events   verify sig → enqueue → 200      (<3s, no I/O)   │
  │  /oauth/slack    per-engineer user token → encrypted in D1       │
  │  /oauth/github   per-engineer token      → encrypted in D1       │
  │  /api/*          approvals · counters · roster · runs            │
  │  /ws/run/:id     ─────────────────────────────┐                  │
  │  /*              Vite SPA (Workers Assets)    │                  │
  └───────────┬───────────────────────────────────┼──────────────────┘
              ▼ QUEUE                             │
    ┌────────────────────────┐                    │
    │ ingest   (all messages)│──► D1   system of record
    │                        │──► Zep  customer:{slug} | org
    │ triage   (customer     │                    │
    │           channels)    │  Haiku 4.5 · ~$0.0003/msg
    │  → { wake, why,        │  ▸ emits NO ticket type
    │      opening_prompt }  │                    │
    └───────────┬────────────┘                    │
                │ wake                            │
                ▼                                 ▼
    ┌───────────────────────────────────────────────────────────┐
    │ RunDO    slack:{channel}:{thread_ts}  |  chat:{uuid}      │
    │ one session shape · hibernates at zero cost               │
    │ ONE INBOX: customer msg ≡ approval outcome ≡ human steer  │
    │                                                           │
    │ model: Claude Fable 5 ── one tool: run_code({ ts })        │
    └───────────────────────┬───────────────────────────────────┘
                            ▼
    ┌───────────────────────────────────────────────────────────┐
    │ TIER 1   Worker Loader isolate            no fetch(). ever.│
    │   env = { slack, github, linear, supabase(ro), langsmith,  │
    │           betterstack, memory, files, sandbox,             │
    │           escalate, withdraw }                             │
    │   all bindings are RPC stubs → parent Worker, where the    │
    │   secrets live and never leave                             │
    └───────────────────────┬───────────────────────────────────┘
                            │ the agent decides: sandbox.boot()
                            ▼
    ┌───────────────────────────────────────────────────────────┐
    │ TIER 2   Cloudflare Sandbox   standard-4 (4vCPU/12GiB/20GB)│
    │   baked image: monorepo cloned · pnpm store warm ·         │
    │                chromium preinstalled                       │
    │   git fetch → dev server → playwright repro → fix →        │
    │   verify → recordVideo → emit { diff, mp4, logs }          │
    │   holds ZERO write credentials                             │
    └───────────────────────┬───────────────────────────────────┘
                            ▼  artifacts only
       Worker performs every write, as the on-duty engineer:
       R2 upload · GitHub blobs→tree→commit→ref→PR · Linear · Slack
```

---

## 4. Ingest and triage

### 4.1 Webhook

`POST /slack/events` does exactly three things, in this order:

1. Verify the `v0=` HMAC signature against the signing secret, rejecting timestamps older
   than 300 seconds (replay window).
2. Enqueue the raw envelope.
3. Return `200`.

No database write, no network call. Slack requires a 200 within 3 seconds and retries up to
three times otherwise; a webhook that does work in-band eventually produces duplicate
processing under load. Retries dedupe downstream on `event_id`.

`url_verification` challenges are answered inline. Events with `channel_type` of `im` or
`mpim` are dropped at the door as defense in depth — the app has no DM history scopes, but
the code should not depend on that remaining true.

### 4.2 Ingest consumer

Idempotent insert into D1 keyed on `event_id`. Resolves the message permalink via
`chat.getPermalink` (bot token) and stores it — citations must not be constructed by string
formatting at read time. Fans out to Zep asynchronously; a Zep failure retries without
blocking the D1 write, because D1 is the system of record and Zep is a projection that can
always be rebuilt from it.

### 4.3 Triage

Runs on customer channels only. Cheap model (Haiku 4.5), ~$0.0003/message.

**Input:** the message, the thread so far, and a compact recall block from that customer's
Zep graph.

**Output:** `{ wake: boolean, why: string, opening_prompt: string }`

Triage **never emits a ticket type.** This is load-bearing. A triage step that returned
`{type: "bug"}` would have smuggled the pipeline back in through the front door — every
downstream consumer would eventually branch on it. Triage decides *whether this deserves a
human-grade response* and writes the opening prompt. What kind of thing it is, is the
agent's problem.

If a run already exists for the thread, the message is appended to that run's session as a
turn and triage is skipped entirely. Triage only adjudicates threads with no live run.

### 4.4 Channel policy

A per-channel mode, resolved from D1, enforced inside the `slack` binding:

| mode | ingest | triage | agent wakes | `slack.reply()` |
|---|---|---|---|---|
| `observe` | yes | yes | only on manual shadow-run | **throws `ChannelReadOnly`** |
| `live` | yes | yes | yes | sends as on-duty engineer |
| `internal` | yes | no | no | bot nudges only |
| *(unknown)* | yes | no | no | **throws** — fail closed |

Reference customer channels are `observe`. Own test channels and `#test-firedrill` are
`live`. `#eng-firefighter` is `internal`. An unmapped channel fails closed.

`ChannelReadOnly` surfaces to the model as an ordinary error it can reason about, not a
crash — the agent learns it cannot post here and adapts.

### 4.5 Shadow mode

Reference channels are an eval set. Triage runs live on them from day one, so within two
days there is a real precision/recall dataset on *wake vs. banter*, ground-truthed against
what the humans actually did. The triage prompt gets tuned against reality instead of
against guesses.

The expensive agent wakes on a reference thread only when a human clicks **shadow-run** on
the dashboard. In shadow, every outbound force-escalates and an approval produces a draft
that is **never sent**, displayed beside what the engineer actually replied. This is not a
third invocation surface — it is the chat surface pointed at a Slack thread, same session
shape, same DO key.

---

## 5. Runs

### 5.1 Identity and lifecycle

A run is a `RunDO` keyed by origin: `slack:{channel_id}:{thread_ts}` or `chat:{uuid}`. Same
class, same session shape, same WebSocket protocol. "Two invocation surfaces, one session
shape" is satisfied structurally — there is no second code path that could drift.

Thread-scoped rather than message-scoped. A four-message scoping conversation is one run
with one continuous session, so the agent sees its own prior reasoning about what it already
asked. Message-scoped runs would spawn four cold sessions and could double-reply on one
thread.

`status: live | awaiting_approval | idle | done | failed`

### 5.2 One inbox

> An approval resolution, a human steering from the dashboard, and the customer's next
> message in the thread are the same event: **a turn appended to the run's session.**

Consequences: watching and steering a live run needs no new machinery; hibernation with
pending work is the normal case rather than a special case; there is no separate resume
path to keep correct.

### 5.3 Approval

`escalate({ kind, draft, why })` **registers a pending approval, returns an id, and lets the
code block finish.** It does not block.

This is forced by the runtime and is better anyway. A Worker Loader isolate is ephemeral and
bounded by request duration — you cannot park one for four hours waiting on a click. A
blocking `await escalate()` reads beautifully in a prompt and cannot exist. Instead the run
transitions to `awaiting_approval`, the DO hibernates at zero cost, and when the dashboard
writes a decision the outcome is injected as a new turn. A rejection with a reason becomes a
conversational turn the agent responds to, not a dead end.

**Interruption.** If the customer posts again while an approval is pending, the agent wakes
immediately and is told it holds a pending draft. It may `withdraw(id)` and redraft — the
card disappears from the dashboard. The customer just changed the situation; sending the
stale draft would embarrass the engineer whose name is on it. Accepted cost: a card can
vanish under an engineer's cursor.

**What escalates, what sends.** This judgment lives in the model and the prompt, and it will
sometimes be wrong. Best effort is the bar.

- **Send:** clarifying questions, "we're on it while a fix is in review", anything
  reversible and non-committal.
- **Escalate:** committing Zellify to something, closing a thread, telling a customer no,
  anything that would embarrass the person whose name is on it.

Four messages of scoping cost zero clicks. The one committal reply costs one.

**Single writer.** The brief's "one writer of approval state" means *one surface decides* —
the dashboard, never Slack. Concretely: approvals live in D1 and every mutation goes through
one module with explicit, disjoint transitions. `pending` is written by the DO on create;
`approved | edited | rejected` only by `PATCH /api/approvals/:id`; `withdrawn` only by the
DO. No Slack interactivity endpoint exists, so there is no second surface to sync.

On approve or edit, **the Worker performs the send** using the on-duty engineer's user
token. The agent never sends escalated content itself.

Rejections write to both stores: D1 keeps the draft, the edit diff, and the reason; Zep's
org graph keeps the derived lesson. That is what makes "the agent learns what this team
won't send" real rather than aspirational.

---

## 6. The tool surface — Code Mode

The brief calls this the central decision. The answer: **the model gets one tool.**

```ts
run_code({ ts: string })   // executed in a Worker Loader isolate
```

Not flat tool schemas (dozens of them, and LLMs have trained on synthetic tool-call examples
but real-world code). Not MCP servers exposed directly to the model (same problem, plus a
round-trip through the model for every intermediate result). The isolate approach lets the
agent chain ten operations — pull the thread, query Supabase for that org, fetch the
LangSmith trace, correlate, draft — without any intermediate result passing back through the
neural network.

The isolate has **no `fetch`**. Its entire outside world is RPC bindings injected as live
objects in `env`, implemented in the parent Worker where the secrets live. Generated `.d.ts`
for these bindings is injected into the system prompt so the model writes against typed APIs
with doc comments.

```ts
declare const slack: {
  /** Post as the on-duty engineer. Throws ChannelReadOnly outside `live` channels. */
  reply(a: { channel: string; thread_ts: string; text: string }): Promise<{ ts: string }>;
  thread(a: { channel: string; thread_ts: string }): Promise<Message[]>;
  search(query: string): Promise<Message[]>;
};

/** Park a draft for human approve/edit/reject. Returns immediately; the run suspends
 *  after this code block and resumes when a human decides. */
declare const escalate: (a: {
  kind: "slack_reply" | "linear_issue" | "pr" | "other";
  draft: unknown;
  why: string;
}) => Promise<{ id: string }>;
declare const withdraw: (id: string) => Promise<void>;

declare const memory: {
  recall(query: string, o?: { graph?: "customer" | "org" }): Promise<Fact[]>;
  remember(text: string, o?: { graph?: "customer" | "org" }): Promise<void>;
  /** Resolve facts to real Slack permalinks via D1. Never construct citations by hand. */
  cite(factIds: string[]): Promise<Citation[]>;
};

/** Team id is pinned server-side to `fire-fighter-testing`; the agent cannot choose it. */
declare const linear: {
  createIssue(a: { title: string; description: string; labels?: string[] }): Promise<{ id: string; url: string }>;
  updateIssue(id: string, a: { title?: string; description?: string; state?: string }): Promise<void>;
};
declare const github: {
  openPR(a: { branch: string; title: string; body: string; diff: string; base: "staging" }): Promise<{ url: string; number: number }>;
};
/** Runs as the read-only prod role. Writes are rejected by the database, not by us. */
declare const supabase:    { query(sql: string, params?: unknown[]): Promise<Row[]> };
declare const langsmith:   { trace(id: string): Promise<Trace>; search(a: { query: string; since?: string }): Promise<TraceRef[]> };
declare const betterstack: { logs(a: { query: string; window: string }): Promise<LogLine[]>; monitors(): Promise<Monitor[]> };
declare const files:       { publish(a: { bytes: ArrayBuffer; contentType: string }): Promise<{ url: string }> };

declare const sandbox: { boot(o?: BootOpts): Promise<Machine> };
type Machine = {
  exec(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  write(path: string, content: string): Promise<void>;
  read(path: string): Promise<string>;
  preview(port: number): Promise<string>;
  browser: { record<T>(fn: (page: Page) => Promise<T>): Promise<{ result: T; video: ArtifactRef }> };
  diff(): Promise<string>;
};
```

`console.log` output and the block's return value flow back as the tool result.

Note `github.openPR` takes a **diff**, not a repo handle. That is the credential topology of
§8 expressed in a type signature.

### Delegation, not branching

`machine.exec("claude -p ...")` remains available for deep multi-file edits. Delegating to a
sub-agent is a *capability the agent may reach for*, identical in shape to running the test
suite. It is not a pipeline, because nothing outside the model decides when it happens.

---

## 7. Voice

Every reply must be indistinguishable from one the on-duty engineer typed. Direct,
technical, no preamble, no "Great question!", no bulleted recap of what was just said, no
closing paragraph restating the answer.

Rules in a prompt get you most of the way. The rest comes from a trick the ingest pipeline
makes free:

> **Few-shot the voice with the on-duty engineer's own real messages.** D1 holds every
> message they have ever sent in these channels. Sample ~20 of their recent replies in
> customer channels into the system prompt.

"Reads as though the on-duty engineer wrote it" stops being an instruction and becomes
imitation of a specific person, and it re-tunes itself automatically when the shift rotates.

---

## 8. Security model

The README's security section must match the code. It does, because these are properties of
the topology rather than rules anyone has to follow.

1. **Tier 1 has no network.** The Worker Loader isolate cannot `fetch`. It reaches the world
   only through RPC bindings that are already authenticated. Model-authored code cannot read
   a credential because no credential is present in its address space.
2. **Tier 2 holds no write credentials.** The container emits a diff, an mp4, and logs. Every
   commit, push, PR, Linear issue, and Slack message is performed Worker-side. There is no
   token in the container to exfiltrate.
3. **The one unavoidable container credential** is `git clone` of a private monorepo.
   Priority order: `interceptHttps` + `outboundByHost` swap (container sees a placeholder;
   the Worker substitutes the real secret on egress) → a Worker-side git HTTP proxy via
   `http.proxy` → worst case, a 1-hour read-only installation token. *Not yet verified —
   see §12.*
4. **Per-engineer tokens are encrypted at rest** in D1 (AES-GCM, key in Workers secrets).
   Slack user tokens and GitHub tokens are never exposed to any surface the model reaches.
5. **Policy is in the API surface.** Channel posting mode and the Linear team id are enforced
   inside the bindings. The agent physically cannot post to a reference customer channel or
   file an issue outside `fire-fighter-testing`.
6. **The dashboard sits behind Cloudflare Access** — one self-hosted application, policy
   `@zellify.app` plus the seven named emails plus one temporary personal override
   (documented in the README for removal). The Worker additionally validates the
   `Cf-Access-Jwt-Assertion` JWT against the team JWKS and maps email → role from a hardcoded
   map of seven addresses.
7. **`/slack/events` and `/oauth/*` are Access-bypassed** by path policy — Slack cannot
   authenticate to Access. They are protected by signature verification and OAuth state
   respectively.
8. **Secrets never enter the repo.** `.dev.vars` locally, `wrangler secret put` in
   production. `.gitignore` covers `.dev.vars*` and `.wrangler` (added 2026-08-10 — `.env*`
   alone does not cover the file Wrangler actually reads).

---

## 9. Data model

**D1 — system of record**

```
channels    channel_id PK · name · customer_slug · mode
messages    event_id PK · channel_id · ts · thread_ts · user_id · text
            · subtype · permalink · customer_slug · received_at
runs        id PK · key UNIQUE · origin · channel_id · thread_ts · status
            · shadow · summary · created_at · updated_at
approvals   id PK · run_id · kind · payload_json · why · status
            · decided_by · decided_text · decided_reason · created_at · decided_at
identities  email PK · role · slack_user_id · slack_token_enc
            · github_login · github_token_enc · connected_at
artifacts   id PK · run_id · kind · r2_key · url · created_at
```

**RunDO SQLite — the live session.** Turns, tool calls, streaming state. Local, fast,
hibernation-friendly. Not mirrored to D1; nothing outside the run needs turn-level detail,
and duplication would create a sync problem for no consumer.

**Zep — recall.** `customer:{slug}` graphs plus one `org` graph holding internal channels,
runs, drafts, and approval outcomes.

> **Zep V3 renamed V2's "groups" to "graphs"** (`graph.create()` for arbitrary knowledge
> graphs), and the February 2026 deprecation wave removed parameters such as `min_score`
> from `graph.search()`. Any V2-shaped code a coding agent produces will look correct and
> fail. Flag in the AI-tool notes.

**Counters** are D1 aggregates over `messages`, `runs`, and `approvals`, scoped to the
current day, with a daily rollup table if the live query gets slow. Defined precisely so the
four numbers on the dashboard mean something specific:

| counter | definition |
|---|---|
| **heard** | envelopes accepted by the webhook (post-signature, post-dedupe) |
| **ingested** | rows committed to `messages` — heard minus dropped DMs, bot echoes, and subtypes |
| **triaged** | messages a triage decision ran on (customer channels only) |
| **escalated** | approvals created today, regardless of current status |

`heard > ingested` is normal and healthy. `heard == ingested` means the drop filters aren't
running.

---

## 10. Identity, rotation, notification

**One Slack app, two tokens.** The workspace bot token is stored once. Each rotating
engineer completes OAuth granting `authed_user` scopes; their user token is encrypted into
`identities`. Customer replies go out under their own account. PRs open under their own
GitHub identity via per-engineer OAuth.

**Rotation is a pure function.** No cron, no stored state, no drift:

```
onDuty(t) = ROSTER[floor((t - EPOCH) / 3 days) % 4]
```

`EPOCH` is a single hardcoded UTC timestamp: the start of a shift the team agrees on, so the
computed rotation lines up with the real one. Confirm the current on-duty engineer and shift
start date before setting it — an EPOCH that is off by a day sends every nudge to the wrong
person, silently.

Fire-fighters: `ronit@`, `luka@`, `mikheil@` (Misho), `zurab@`.
Viewers (dashboard + chat, no rotation, no OAuth): `marcus@`, `nils@`, `eric@`.

**Notification.** When an approval is created, the **bot token** DMs the on-duty engineer: a
preview of the draft and a plain URL button to the dashboard. A self-DM sent with the user's
own token does not push-notify — that is precisely what the bot token is for. A URL button
needs no interactivity endpoint and no handler code.

*Open:* DMing a user with a bot token needs `im:write` (for `conversations.open`) in addition
to `chat:write`. If `im:write` is not grantable, the nudge becomes an @-mention in
`#eng-firefighter`, which needs only `chat:write`. Confirm on day 0.

---

## 11. Shipping and the dashboard

### 11.1 Ship loop

Issue → boot → fix → verify → prove → PR. The agent chooses this path; nothing routes it here.

**Boot time is the drill risk, not capability.** A cold `pnpm install` plus a Playwright
browser download on the monorepo is minutes that do not exist while a customer watches the
thread. Mitigation: a baked image with the repo pre-cloned, the pnpm store warm, and
Chromium preinstalled. Runtime becomes `git fetch` plus a delta install — roughly eight
minutes down to one. Sandbox snapshots (copy-on-write) are the fallback if image rebuilds
prove slow.

**Proof capture** is Playwright's `recordVideo` on the browser context — no screen-capture
rig. webm → mp4, upload to R2, and the same link goes in the PR body and the Slack reply.
This also sidesteps a scope problem: the app is locked to channel history and `chat:write`,
so `files:write` for a native Slack upload is likely unavailable. **A public R2 link needs no
scope.**

PRs open against `staging`, follow the monorepo's PR conventions, link the Linear issue so
it closes on merge, and carry the proof link. Review and merge happen on GitHub. The
dashboard approves Slack messages and nothing else.

Large feature requests produce follow-up questions to the customer (sent, not escalated), a
Linear issue in `fire-fighter-testing` carrying a value / blocking / customer-weight
assessment, and an honest acknowledgment in the thread that does not overpromise.

### 11.2 Dashboard

Two pages. Someone opening it cold understands it in 30 seconds.

**`/` — Dashboard**
- Rotation strip: who is on duty now, when it changes, who is next.
- Per-engineer connect status: Slack ✓ / GitHub ✓, or a Connect button.
- Four counters, today: heard · ingested · triaged · escalated.
- Approval cards, pinned to the top: draft, why the agent escalated, thread context,
  approve / edit / reject. This is the only thing on the page that needs a decision, so it
  is the only thing above the fold.
- Run list: status, customer, one-line summary, live indicator.

**`/chat` — Chat**
- Same session component the runs use. "Did PulseFit complain about checkout before, and
  what did we do?" answers with citations resolving to real Slack permalinks. "Ship the
  copy-ID button Priya asked for" starts a run by hand.

**Run detail is a drawer over the dashboard, not a third page.** It renders the same session
component as chat — tool calls streaming, and a composer to steer mid-flight. "Two pages"
holds honestly rather than by relabeling.

**States exist.** Loading skeletons on every panel. Empty states that say something useful
("nothing needs you right now" beats a blank card). A WebSocket disconnect banner with
retry. Optimistic approval with rollback on failure.

**Shift handoff:** on rotation, a summary of what the last three days taught the agent,
generated from the org graph and the run list.

---

## 12. Risks and day-1 spikes

Two surfaces have training data thin enough that a coding agent will confidently invent
APIs. Both get spiked before anything is built on them.

| Risk | Spike | Fallback |
|---|---|---|
| **Cloudflare Sandbox cannot run the monorepo** — highest-impact risk in the build; kills drill scenarios 2 and 3 | Boot `standard-4`, clone, `pnpm install`, `next dev`, drive Chromium, record video. Time every step. | E2B. The Worker-does-the-writes topology means only the exec surface moves. |
| **`interceptHttps` / `outboundByHost` may not exist as documented** — it appears in the Claude Code tutorial but not the Sandbox API reference | Subclass `Sandbox`, set `interceptHttps`, swap a placeholder header for `github.com` | Worker-side git HTTP proxy via `http.proxy`; else a 1-hour read-only installation token |
| **Worker Loader is beta and thinly documented** | Load an isolate with one RPC binding, confirm `fetch` is absent, confirm generated `.d.ts` round-trips | Run the code-mode isolate as a separate Worker with no outbound bindings and a service binding back |
| **Next 16 / React 19 / Tailwind 4 are ahead of training data** | Not on the critical path — D2 removed Next entirely | — |
| **Zep V3 API drift** (groups→graphs, Feb 2026 deprecations) | Write one `graph.create` + `graph.add` + `graph.search` round-trip before wiring | — |
| **Slack `im:write` not grantable** | Ask day 0 | @-mention the on-duty engineer in `#eng-firefighter` |

---

## 13. Cost

Ceiling is $500 all-in for the week, tokens included.

| Item | Estimate |
|---|---|
| Triage — Haiku 4.5, ~150–300 msg/day across customer + reference channels @ $0.0003 | < $1 / week |
| Main agent — Claude Fable 5, ~40 runs | $20 – 80 |
| Zep Flex | $25 / month |
| Cloudflare Workers paid | $5 |
| Cloudflare Containers usage | $10 – 40 |
| D1 / R2 / Queues / DO | < $5 |
| Vercel | $0 — not used (D2) |
| **Total** | **~$70 – 160** |

Comfortably inside the ceiling. The brief's instruction stands: spend tokens on the
strongest model rather than optimizing the bill. Ping Ronit *before* crossing $500.

---

## 14. Build order

Day 1 is today (2026-08-10). Repo and Slack credentials are live; the Linear team
`fire-fighter-testing` exists.

| Day | Work |
|---|---|
| **1** | Rotate leaked Slack secrets. Spike A (Sandbox) and Spike B (Worker Loader) in parallel — *before* committing to D1/D5. Ship `/slack/events` + Queue + D1 `messages`. **Ingest starts banking real traffic immediately**, so everything after is built against real data. |
| **2** | Zep ingest, per-customer graphs, triage consumer, counters. Cloudflare Access in front. SPA skeleton showing live counters. |
| **3** | RunDO, Tier 1 code mode, generated `.d.ts`, WebSocket streaming, chat page, steering. |
| **4** | `escalate` / `withdraw`, approval card, single-writer transitions, Slack bot nudge, Slack + GitHub OAuth, rotation. |
| **5** | Tier 2 end to end: baked image, repro, fix, `recordVideo` → R2, Linear issue, PR as fire-fighter with proof. |
| **6** | Voice tuning against the reference-channel eval set. Shadow runs. Handoff summary. Loading / empty / error states. Dry-run all four drill scenarios in own test channels. |
| **7** | Fire drill. README (architecture diagram, security model, cost, AI-tool notes, next-week). Loom (≤5 min). |

Spikes on day 1 rather than day 4 is the single most important sequencing choice here: both
D1 and D5 rest on surfaces that may not behave as documented, and discovering that on day 4
loses the week.

---

## 15. Blockers and open questions

**Blocking — ask today:**

1. **Product monorepo access — [`Zellify/web2app-rebuild`](https://github.com/Zellify/web2app-rebuild).**
   Not to be confused with `Zellify/firefighter`, which is this repo, the deliverable.
   `web2app-rebuild` is Zellify's actual product codebase: the agent clones it in the sandbox,
   fixes bugs in it, and opens PRs against its `staging` branch. Drill scenarios 2 and 3 both
   require this, and the brief says to read its root `AGENTS.md` first.
   **Without it the entire Tier 2 path is unbuildable.** Only Phases 18–20 depend on it, so a
   slow invite reorders the build rather than stalling it.
2. **Supabase prod read-only, LangSmith, Better Stack** credentials — not yet confirmed
   received.
3. **`im:write` and `files:write`** grantability on the Slack app (§10, §11.1).

**Non-blocking:**

4. The wireframe artifact renders empty. Proceeding from the brief's enumeration of panels;
   it is explicitly illustrative and CSS is not graded.
5. `#test-firedrill` and own test channels need creating and mapping to `live` mode.
6. **Rotation `EPOCH`** — confirm who is on duty right now and when that shift started, so
   the computed rotation matches the real one (§10).

---

## 16. Out of scope

DM and group-DM ingestion (no scopes requested, channels only). Multi-tenant or
multi-workspace anything. Billing, teams. Ungated autonomy in real customer channels. Visual
design beyond working states. Anything IAM-shaped past the domain gate — seven hardcoded
emails is the whole authorization model.
