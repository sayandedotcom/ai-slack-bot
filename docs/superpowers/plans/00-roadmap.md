# Fire-Fighter Agent — Phase Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each phase task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Source spec:** `docs/superpowers/specs/2026-08-10-firefighter-agent-design.md`

## Repos and access — the canonical list

Two different GitHub repos are in play and confusing them wastes real time. **This is the only place they are defined; everything else points here.**

| Repo | What it is | Role in the build |
|---|---|---|
| **[`Zellify/firefighter`](https://github.com/Zellify/firefighter)** | **This repo.** The deliverable. | Everything we write. Already `origin` locally. |
| **[`Zellify/web2app-rebuild`](https://github.com/Zellify/web2app-rebuild)** | **The product monorepo.** Zellify's actual codebase — what customers use and what bugs live in. | The agent clones this in the sandbox, fixes bugs in it, and opens PRs **against its `staging` branch**. Read its root `AGENTS.md` first — the brief says so, and it documents local dev setup and PR conventions. |

Private, so unauthenticated tooling gets a 404 on both. Confirm your invite to `web2app-rebuild` landed by opening it in a browser while signed in.

**What depends on `web2app-rebuild`:** Phases 18, 19, 20 only — the sandbox, the ship loop, and the PR writes. Phases 00–17 need nothing from it. That separation is deliberate: if the invite is slow, the build runs out of order rather than stalling.

**Reference repos** (read for prior art, not dependencies) — see `docs/inspired-from-ronit.md`: [`rtpa25/agent-os`](https://github.com/rtpa25/agent-os), [`rtpa25/self-syncing-agent`](https://github.com/rtpa25/self-syncing-agent).

**Goal:** Twenty-four phases from empty repo to a system that hears every Slack message the team hears, wakes one generic agent on the ones that matter, lets it fix bugs on a cloud machine and open PRs under the on-duty engineer's name, and gates everything committal behind one dashboard click.

**Architecture:** One Worker, one origin. Slack events → queue → D1 (system of record) + Zep (recall). Triage wakes a thread-scoped Durable Object running one agent with one tool: write TypeScript. That code executes in a network-isolated Worker Loader isolate whose only reach is RPC bindings; when it needs a shell it boots a Cloudflare Sandbox that holds no write credentials and emits diffs, which the Worker turns into PRs.

**Tech Stack:** TypeScript strict · Cloudflare Workers, Durable Objects, Queues, D1, R2, Workers Assets, Worker Loader, Sandbox, AI Gateway · Hono · Vercel AI SDK + `@ai-sdk/anthropic` · Vitest + `@cloudflare/vitest-pool-workers` · Vite + React + shadcn · Zep V3 · Claude Fable 5 (agent) / Haiku 4.5 (triage) · Playwright

**Prior art:** `docs/inspired-from-ronit.md` records what was adopted from `rtpa25/agent-os` and `rtpa25/self-syncing-agent` — both run Worker Loader and `@cloudflare/sandbox` in production. Read it before Phases 00, 09 and 18.

---

## Global Constraints

Every phase's requirements implicitly include this section. Values are copied verbatim from the spec.

- **Node >= 20** (have 22.20.0), **pnpm 10.33.4**, TypeScript `strict: true`.
- **`compatibility_date: "2026-08-01"`**, `compatibility_flags: ["nodejs_compat"]`.
- **Channels only, never DMs.** `channel_type` of `im` or `mpim` is dropped at ingest, unconditionally. **The installed app *does* hold `im:history` and `im:read`** (verified against `auth.test` on 2026-08-11 — see spec §15). The drop is therefore the only thing keeping DMs out of D1, not defense in depth behind a scope wall. Never relax it on the assumption that scopes would catch it.
- **Fail closed.** A channel absent from the `channels` table is never postable.
- **No secret values in the repo, ever.** `.dev.vars` locally (gitignored as of `74383cc`), `wrangler secret put` in production. Plans and code name variables, never values.
- **The webhook does no I/O beyond the queue send.** Slack demands 200 within 3 seconds and retries three times otherwise.
- **All ingest writes are idempotent on `event_id`.**
- **Triage never emits a ticket type.** It emits `{ wake, why, opening_prompt }`. A type field would smuggle the banned pipeline back in.
- **The Tier 1 isolate has no `fetch`.** Its only reach is RPC bindings held by the parent Worker.
- **The Tier 2 sandbox holds no write credentials.** It emits artifacts; the Worker performs every write.
- **Linear issues are pinned server-side** to team `fire-fighter-testing`. The agent cannot choose the team.
- **Product PRs target `staging`**, link the Linear issue so it closes on merge, and carry the proof recording.
- **Customer-facing copy:** direct, technical. No preamble, no "Great question!", no bulleted recap, no closing paragraph restating the answer.
- **Commit after every task.** Conventional prefixes.

---

## Verify before you invent

Three surfaces have training data thin enough that a coding agent will confidently produce APIs that do not exist. Where a phase touches these, read the installed `.d.ts` and the live docs first — never write from memory:

| Surface | Phases | Why it bites |
|---|---|---|
| **Worker Loader** | 09, 10 | Beta. Substantially de-risked by `docs/inspired-from-ronit.md` — the API shape, `globalOutbound: null`, the `ctx.exports`/`RpcTarget` marshalling rules and the cache semantics all come from working code. What remains unknown is whether *your* account has beta access. |
| **Cloudflare Sandbox** | 18, 19 | `interceptHttps` and `outboundByHost` are confirmed real and in production use. The genuine unknown is whether a `standard-4` container can run **Zellify's** monorepo — nobody has tried. |
| **Zep V3** | 06, 07, 21 | V2's "groups" became V3 "graphs"; the Feb 2026 deprecation wave removed `min_score` from `graph.search()`. V2-shaped code looks correct and fails. |

Every invented API found during a phase goes into that phase's notes. The README's AI-tool notes are a graded deliverable, and this is the raw material.

---

## Docs / API MCP servers — attach per phase

**This is dev-time tooling for the engineer, not the product's tool surface.** The agent being built deliberately does **not** reach its integrations over MCP — it writes TypeScript against generated typed bindings (Code Mode, decision D1). These two uses of "MCP" must not get confused six days from now.

The point of attaching a docs or API MCP server during a phase is to stop the coding agent writing plausible-looking APIs from memory. Every row below is a place where that failure is likely and expensive.

Fill in the **Server** column as you find them.

Cloudflare's own MCP servers and skills are already available in this workspace and cover most of the high-risk rows — noted below. The rest are yours to find.

| Phase | What needs live docs / API access | Why it bites | Server |
|---|---|---|---|
| **00** | Cloudflare Workers — Worker Loader, `WorkerLoaderWorkerCode`, `ctx.exports`, `RpcTarget` | Beta surface. Partly de-risked by `inspired-from-ronit.md`, but the docs are the tiebreaker when his code and the types disagree. | `cloudflare-docs` · skill `cloudflare:workers-best-practices` |
| **00** | Cloudflare Sandbox / Containers — SDK methods, instance types, `interceptHttps`, `outboundByHost`, `tunnels` | Newest product in the stack; the API reference and the tutorials already contradict each other. **Decide `@cloudflare/sandbox` stable vs `@next` (SDK 1.0 preview) in Task 1** — there is a skill for each, and picking wrong means reading the wrong docs all week. | skills `cloudflare:sandbox-stable` / `cloudflare:sandbox-next` |
| **01** | Wrangler config schema — D1, Queues, Assets, migrations | Config keys move between wrangler minors and fail late, at deploy. | skill `cloudflare:wrangler` |
| **01** | `@cloudflare/vitest-pool-workers` — `applyD1Migrations`, `readD1Migrations`, `SELF`, `fetchMock` | Exports genuinely move between minor versions. Named in Phase 01 Task 5 Step 4. | `cloudflare-docs` |
| **02** | Slack Web API — Events API envelopes, signature scheme, `message.channels`, subtypes | Subtype list is long and undocumented in one place; getting it wrong silently ingests noise. | |
| **04** | Slack Web API — `chat.getPermalink` | Small surface; low risk. | |
| **05** | Cloudflare Access — self-hosted apps, policy ordering, bypass on paths, `Cf-Access-Jwt-Assertion` + JWKS | Policy **ordering** is the trap. A misordered bypass kills ingest silently. | skill `cloudflare:cloudflare-one` |
| **06** | **Zep V3** — `graph.create` / `graph.add` / `graph.search`, episode metadata | Highest-risk docs dependency in the build. V2→V3 renamed groups→graphs; the Feb 2026 wave removed params. V2-shaped code looks right and fails. | |
| **07** | Anthropic Messages API — structured output, Haiku 4.5 model id, token/cost fields | Model ids and cost accounting; cost is a graded deliverable. | |
| **07, 10** | Cloudflare AI Gateway — routing, cost/observability | Adopted late (from `agent-os`); no plan detail written yet. | |
| **08** | Durable Objects — WebSocket **hibernation** API, DO SQLite, `idFromName` | Hibernation handlers differ from plain WebSocket handling; getting it wrong burns duration cost silently. | skills `cloudflare:durable-objects`, `cloudflare:agents-sdk` |
| **09** | Vercel AI SDK + `@ai-sdk/anthropic` — tool loop, streaming | Adopted late; the agent loop's whole shape depends on it. | |
| **09** | Same Cloudflare Worker Loader surface as Phase 00, now in anger | | |
| **10** | Anthropic — Fable 5 model id, streaming, prompt caching | Prompt caching matters against the $500 ceiling once voice few-shots and memory recall bloat the system prompt. | |
| **12** | Slack OAuth v2 — `authed_user` scopes, install flow | | |
| **12** | GitHub OAuth / GitHub Apps — user-to-server tokens | Two similar flows with different token semantics; easy to build the wrong one. | |
| **13** | Slack Block Kit — URL buttons, `conversations.open`, `im:write` | Block Kit JSON is fiddly and fails at runtime, not build time. | |
| **17, 09** | Supabase — read-only role, query surface | | |
| **09** | LangSmith — trace fetch / search API | | |
| **09** | Better Stack — logs query + monitors API | | |
| **18** | **`Zellify/web2app-rebuild` root `AGENTS.md`** — local dev setup, PR conventions | Not an MCP server, but the same class of dependency: the ship loop has to follow conventions we cannot guess. The brief says read it first. | *(GitHub MCP, or just clone it)* |
| **19** | Playwright — `recordVideo`, browser contexts, headless in container | | |
| **20** | GitHub REST — blobs → tree → commit → ref → PR | Six chained calls with easy-to-get-wrong SHA plumbing. Worth live docs. | |
| **20** | Linear API — issue create/update, team scoping | | |

**Still to find:** Slack (02, 04, 12, 13), **Zep (06)**, Anthropic (07, 10), GitHub (12, 20), Linear (20), Supabase / LangSmith / Better Stack (09), Playwright (19).

**If you only chase two:** **Zep** and **GitHub**. Cloudflare is already covered above, and those two are where an invented API costs the most hours — Zep because V2-shaped code compiles and fails, GitHub because the blobs→tree→commit→ref→PR chain has SHA plumbing that is easy to get subtly wrong.

---

## Phase graph

```
        ┌──────────────────────────────────────────┐
   D1 ← │ 00 SPIKES (sandbox · worker loader)      │ → D5
        └────────┬──────────────────────┬──────────┘
                 │ gates 09,10          │ gates 18,19
                 │                      │
  ┌──────────────▼──────────────┐       │
  │ 01 worker foundation        │       │
  │ 02 slack ingress            │       │   ← DAY 1-2: nothing here is
  │ 03 channel policy           │       │      blocked on Ronit
  │ 04 ingest pipeline          │       │
  │ 05 counters + access        │       │
  └──────────────┬──────────────┘       │
                 │                      │
  ┌──────────────▼──────────────┐       │
  │ 06 zep memory               │       │   ← DAY 2-3
  │ 07 triage                   │       │
  └──────────────┬──────────────┘       │
                 │                      │
  ┌──────────────▼──────────────┐       │
  │ 08 run DO + streaming       │       │   ← DAY 3-4
  │ 09 code mode tier 1         │       │
  │ 10 agent loop               │       │
  └──────────────┬──────────────┘       │
                 │                      │
  ┌──────────────▼──────────────┐       │
  │ 11 approval                 │       │   ← DAY 4-5
  │ 12 identity + oauth         │       │
  │ 13 slack nudge              │       │
  │ 14 dashboard shell          │       │
  │ 15 run list + live drawer   │       │
  │ 16 approval card            │       │
  │ 17 chat + citations         │       │
  └──────────────┬──────────────┘       │
                 │      ┌───────────────▼──────────────┐
                 │      │ 18 sandbox tier 2            │ ← DAY 5-6
                 │      │ 19 ship loop + proof         │   ALSO BLOCKED ON
                 │      │ 20 pr + linear writes        │   MONOREPO INVITE
                 │      └───────────────┬──────────────┘
                 └──────────────┬───────┘
  ┌──────────────────────────────▼─────┐
  │ 21 voice + eval + shadow           │   ← DAY 6-7
  │ 22 handoff + states polish         │
  │ 23 drill dry-run + README + Loom   │
  └────────────────────────────────────┘
```

**The critical insight in this ordering:** phases 01–17 are entirely unblocked by `Zellify/web2app-rebuild`. Only 18–20 need it. If the invite is slow, the build does not stall — it runs out of order.

---

## Phase index

| # | Phase | Detail | Depends on | Day |
|---|---|---|---|---|
| 00 | Spikes — sandbox and worker loader | [full](phase-00-spikes.md) | — | 1 |
| 01 | Worker foundation | [full](phase-01-worker-foundation.md) | — | 1 |
| 02 | Slack ingress | [full](phase-02-slack-ingress.md) | 01 | 1 |
| 03 | Channel policy | [full](phase-03-channel-policy.md) | 01 | 1 |
| 04 | Ingest pipeline | [full](phase-04-ingest-pipeline.md) | 02, 03 | 2 |
| 05 | Counters and the Access gate | [full](phase-05-counters-and-access.md) | 04 | 2 |
| 06 | Zep memory layer | [full](phase-06-zep-memory.md) | 04 | 2 |
| 07 | Triage | [full](phase-07-triage.md) | 06 | 3 |
| 08 | RunDO session core + streaming | below | 05 | 3 |
| 09 | Code Mode Tier 1 | below | 00·T2, 08 | 3 |
| 10 | Agent loop | below | 09 | 4 |
| 11 | Approval | below | 10 | 4 |
| 12 | Identity, OAuth, rotation | below | 01 | 4 |
| 13 | Slack nudge | below | 11, 12 | 4 |
| 14 | Dashboard shell | below | 05 | 5 |
| 15 | Run list + live run drawer | below | 08, 14 | 5 |
| 16 | Approval card | below | 11, 14 | 5 |
| 17 | Chat page + citations | below | 06, 08, 14 | 5 |
| 18 | Sandbox Tier 2 | below | 00·T1, **monorepo** | 5 |
| 19 | Ship loop + proof capture | below | 18 | 6 |
| 20 | PR + Linear writes → `web2app-rebuild` `staging` | below | 19 | 6 |
| 21 | Voice, eval harness, shadow mode | below | 10, 07 | 6 |
| 22 | Handoff summary + states polish | below | 15, 16, 17 | 7 |
| 23 | Drill dry-run, README, Loom | below | all | 7 |

---

# Phases 06–23

Expanded to full TDD detail as each dependency clears. Each entry below carries the goal, file plan, task breakdown, and exit criteria — enough to start, and enough to sequence against.

---

## Phase 06 — Zep memory layer

**Goal:** Every ingested message reaches the right Zep graph, and facts can be recalled and resolved back to real Slack permalinks through D1.

**Depends on:** Phase 04 · **Day 2**

**Files:** `src/memory/zep.ts` (client wrapper), `src/memory/graphs.ts` (graph naming and routing), `src/memory/cite.ts` (fact → D1 → permalink), `src/ingest/consumer.ts` (modify: fan out to Zep), `test/memory.test.ts`, `test/cite.test.ts`

**Tasks:**
1. **Verify the V3 API before writing.** One throwaway round-trip: `graph.create` → `graph.add` → `graph.search`. Record every V2-shaped API the model suggests that no longer exists.
2. **Graph routing.** `graphIdFor(policy)` → `customer:{slug}` for customer channels, `org` for internal. Pure function, fully tested.
3. **Ensure-graph-exists**, idempotent and cached per isolate.
4. **Ingest fan-out.** Zep write happens *after* the D1 commit and never blocks it — D1 is the system of record and Zep is a rebuildable projection. Failures retry via the queue; a permanently failing Zep write must not poison the message.
5. **Citation resolution.** `cite(factIds)` maps Zep episode metadata back to `messages.event_id`, then returns stored permalinks. Test the miss path explicitly: a fact with no matching D1 row returns no citation rather than a fabricated URL.
6. **Backfill script** for messages ingested before this phase landed.

**Exit criteria:** A message posted in a test channel appears in `customer:{slug}` within seconds. `cite()` returns real permalinks. Killing Zep entirely does not lose a single message.

---

## Phase 07 — Triage

**Goal:** A cheap model decides what wakes the agent, and writes the opening prompt.

**Depends on:** Phase 06 · **Day 3**

**Files:** `src/triage/prompt.ts`, `src/triage/run.ts`, `src/triage/consumer.ts`, `migrations/0002_triage.sql` (`triage_decisions` table), `src/db/counters.ts` (modify: real `triaged` count), `test/triage.test.ts`

**Tasks:**
1. **`triage_decisions` table:** `event_id` PK, `wake`, `why`, `opening_prompt`, `model`, `cost_usd`, `latency_ms`, `created_at`. Storing the decision is what makes the eval set possible.
2. **Prompt builder.** Message + thread so far + compact Zep recall for that customer. Pure function over fetched inputs so it is testable without a model call.
3. **Structured output.** `{ wake: boolean, why: string, opening_prompt: string }` via Haiku 4.5. **Assert in a test that the schema has no `type`/`category` field** — this is the guard against the banned pipeline reappearing.
4. **Route on `shouldTriage(policy)`** from Phase 03. Internal and unknown channels never reach the model.
5. **Skip triage when a live run already owns the thread** — the message becomes a turn instead (wired in Phase 08).
6. **Cost telemetry** per decision, so the $500 ceiling is observable rather than estimated.
7. **Real `triaged` counter** replacing the Phase 05 zero.

**Exit criteria:** Banter in a test channel does not wake anything. A question does. Every decision is stored with its cost. Reference channels accumulate decisions for the Phase 21 eval set.

---

## Phase 08 — RunDO session core + streaming

**Goal:** The one session shape, watchable live over WebSocket.

**Depends on:** Phase 05 · **Day 3**

**Files:** `src/run/do.ts` (the Durable Object), `src/run/session.ts` (turn storage in DO SQLite), `src/run/protocol.ts` (typed client events), `src/api/runs.ts`, `wrangler.jsonc` (modify: DO binding + migration), `migrations/0003_runs.sql`, `test/run-session.test.ts`, `test/run-ws.test.ts`

**Tasks:**
1. **DO keyed by origin:** `slack:{channel}:{thread_ts}` or `chat:{uuid}`. One `idFromName` helper, tested for both shapes producing the same class.
2. **Session storage** in DO SQLite: turns with role, content, tool calls, timestamps.
3. **The one inbox.** `appendTurn(turn)` is the single entry point, and it is what an approval resolution, a human steering message, and the customer's next Slack message all call. Test all three paths converging on it.
4. **WebSocket upgrade** at `/ws/run/:id` with hibernation-compatible handlers, broadcasting turn and tool-call deltas.
5. **`runs` index table in D1** — id, key, origin, channel, thread_ts, status, shadow, summary — so the dashboard can list runs without waking every DO.
6. **Status transitions:** `live | awaiting_approval | idle | done | failed`, with the legal set asserted in tests.
7. **Resumption:** a client connecting mid-run receives the backlog then live deltas, with no gap and no duplicate.

**Exit criteria:** Two browser tabs on the same run see identical streams. A DO that hibernates and wakes loses nothing.

---

## Phase 09 — Code Mode Tier 1

**Goal:** One tool. Model-authored TypeScript executing in a network-isolated isolate whose only reach is RPC bindings.

**Depends on:** Phase 00 Task 2 **GO**, Phase 08 · **Day 3**

**Files:** `src/codemode/loader.ts`, `src/codemode/bindings/*.ts` (one per integration), `src/codemode/dts.ts` (generate the `.d.ts` injected into the prompt), `src/codemode/execute.ts`, `test/codemode-*.test.ts`

**Read `docs/inspired-from-ronit.md` §1–§6 before starting.** Binding construction, boundary marshalling, cache semantics and the timeout race are all documented there from working code.

**Tasks:**
1. **Loader wrapper** over the verified Phase 00 shape: `LOADER.load(code)` with `globalOutbound: null`, capabilities on `env` (never on `globalOutbound`), constructed via `ctx.exports.X({ props })`, DO reach-back wrapped in `RpcTarget`, and the wall-clock race around `entrypoint.run()`.
2. **Binding-by-binding, each its own TDD cycle:** `slack` (Phase 03 policy enforced *inside* it), `memory`, `linear` (team id pinned), `supabase` (read-only role), `langsmith`, `betterstack`, `files`. `github` and `sandbox` arrive in Phases 20 and 18. Identity travels in `props`, never in arguments — the agent cannot spoof who it is acting as if it never states it.
3. **`.d.ts` generation** from the binding definitions, so the types the model sees cannot drift from the types that exist. This is the whole reason Code Mode beats flat schemas — the contract is generated, not maintained.
4. **Result plumbing:** `console.log` output plus return value, serialized back as the tool result.
5. **The security test that matters.** Assert from inside the isolate that `fetch` is unavailable, that `new WebSocket` fails, and that no binding leaks a raw credential. **This test is the README's security section.** If it cannot be written, decision D1 is wrong.
6. **Error surfacing:** a thrown `ChannelReadOnly` returns to the model as a readable error it can reason about, not a stack trace.
7. **Timeout and runaway-loop guards.**

**Exit criteria:** A hand-written snippet chains four bindings in one execution. The network-isolation test passes. The generated `.d.ts` typechecks against the real implementations.

---

## Phase 10 — Agent loop

**Goal:** Claude Fable 5 driving Phase 09's single tool inside Phase 08's session.

**Depends on:** Phase 09 · **Day 4**

**Files:** `src/agent/loop.ts`, `src/agent/prompt/system.ts`, `src/agent/prompt/voice.ts`, `src/agent/prompt/escalation.ts`, `src/agent/model.ts`, `test/agent-*.test.ts`

**Tasks:**
1. **Model client** with streaming, wired to broadcast deltas through Phase 08's protocol.
2. **System prompt assembly**, in composable sections: identity and on-duty engineer, the generated `.d.ts`, escalation judgment, voice rules, customer memory, thread context.
3. **The agentic loop:** call → tool → result → call, with a step ceiling and a cost ceiling.
4. **Both invocation surfaces** proven to produce identical session shapes — a triage-woken run and a human-typed chat run differ only in who wrote turn one.
5. **Mid-flight steering:** a turn appended while the model is generating is picked up on the next step rather than dropped.
6. **Cost and token telemetry per run**, surfaced to the dashboard.
7. **Failure paths:** model error, tool error, and timeout each leave the run in a legible state with something useful on screen.

**Exit criteria:** Ask a question in a `live` test channel; a correct, human-sounding reply arrives in-thread within minutes. Steering mid-run visibly changes what it does next.

---

## Phase 11 — Approval

**Goal:** The agent decides when to ask. What it escalates gates on the dashboard alone.

**Depends on:** Phase 10 · **Day 4**

**Files:** `src/approval/escalate.ts`, `src/approval/transitions.ts`, `src/api/approvals.ts`, `migrations/0004_approvals.sql`, `src/db/counters.ts` (modify: real `escalated`), `test/approval-*.test.ts`

**Tasks:**
1. **`approvals` table** per spec §9.
2. **`escalate()` returns immediately.** It does not block — a Worker Loader isolate cannot be parked for hours. Test that the code block completes and the run transitions to `awaiting_approval`.
3. **Disjoint transitions, one module:** `pending` written by the DO; `approved | edited | rejected` only by `PATCH /api/approvals/:id`; `withdrawn` only by the DO. Test that each illegal transition is rejected.
4. **Resolution injects a turn** via Phase 08's `appendTurn`. A rejection with a reason becomes something the agent answers.
5. **The Worker performs the send** on approve/edit, using the on-duty engineer's user token. The agent never sends escalated content itself.
6. **Interruption behavior:** a new customer message on a run with a pending approval wakes the agent immediately and offers `withdraw(id)`.
7. **Rejections write to both stores** — D1 keeps draft, edit diff and reason; Zep's org graph keeps the derived lesson.
8. **Real `escalated` counter.**

**Exit criteria:** A committal reply parks; a clarifying question sends. Four scoping messages cost zero clicks. An edit sends the edited text and stores the diff.

---

## Phase 12 — Identity, OAuth, rotation

**Goal:** The customer never sees a bot.

**Depends on:** Phase 01 · **Day 4**

**Files:** `src/identity/roster.ts`, `src/identity/rotation.ts`, `src/identity/crypto.ts`, `src/oauth/slack.ts`, `src/oauth/github.ts`, `src/db/identities.ts`, `migrations/0005_identities.sql`, `test/rotation.test.ts`, `test/oauth-*.test.ts`

**Tasks:**
1. **Hardcoded roster:** four fire-fighters, three viewers, seven emails to roles.
2. **`onDuty(t)` as a pure function** — `ROSTER[floor((t - EPOCH) / 3d) % 4]`. Test boundaries exhaustively: exact rollover instants, DST-irrelevance (UTC), and the wrap at index 3→0. **An EPOCH off by a day silently sends every nudge to the wrong person**, so this gets more tests than its line count suggests.
3. **Token encryption at rest** — AES-GCM via WebCrypto, key from a Worker secret. Round-trip tested; ciphertext asserted to differ across calls.
4. **Slack OAuth v2** with `authed_user` scopes, state parameter validated against CSRF.
5. **GitHub OAuth**, per-engineer, tokens encrypted identically.
6. **`identities` table** and a connect-status API for the dashboard.
7. **Access JWT → role mapping**, validating `Cf-Access-Jwt-Assertion` against the team JWKS as defense in depth behind Access itself.

**Exit criteria:** Two accounts connect end to end. `onDuty` matches the real rotation. No token is readable in D1 without the key.

---

## Phase 13 — Slack nudge

**Goal:** Nobody keeps a tab open to find out the agent is waiting.

**Depends on:** Phases 11, 12 · **Day 4**

**Files:** `src/notify/nudge.ts`, `src/notify/blocks.ts`, `test/nudge.test.ts`

**Tasks:**
1. **Bot-token DM** to the on-duty engineer. A self-DM sent with the user's own token does not push-notify — that is exactly what the bot token is for.
2. **Block Kit payload:** draft preview, why the agent escalated, and a **plain URL button** to the dashboard. A URL button needs no interactivity endpoint and no handler code.
3. **`im:write` fallback**, decided by whatever Ronit answers: if the scope is unavailable, the nudge becomes an @-mention in `#eng-firefighter`, which needs only `chat:write`. Both paths implemented and tested; one config flag chooses.
4. **Deduplication** — one nudge per approval, no re-nudge on reconnect.
5. **Withdrawal updates the nudge** rather than leaving a dead link to a resolved card.

**Exit criteria:** An escalation produces a phone push within seconds, and its button lands on the right approval card.

---

## Phase 14 — Dashboard shell

**Goal:** A cold visitor understands the page in 30 seconds.

**Depends on:** Phase 05 · **Day 5**

**Files:** `apps/dashboard/` (new Vite + React + shadcn app), `src/api/roster.ts`, `apps/worker/wrangler.jsonc` (modify: assets point at the built SPA). Delete `apps/web` (the Next 16 scaffold) — decision D2.

**Tasks:**
1. **Vite + React + Tailwind 4 + shadcn**, consuming the existing `packages/ui`.
2. **Build output wired into Workers Assets**, so `pnpm build && wrangler deploy` ships both halves as one origin.
3. **Rotation strip:** on duty now, when it changes, who is next.
4. **Per-engineer connect status** with Slack and GitHub connect buttons.
5. **Four counters**, live.
6. **Loading, empty and error states for every panel.** Not a polish pass — they are part of the phase, because the grading criteria name them explicitly.
7. **Access identity** surfaced in the header so a viewer knows which account they are.

**Exit criteria:** Deployed behind Access. Someone who has never seen it can say what it does.

---

## Phase 15 — Run list + live run drawer

**Goal:** Watch and steer any run.

**Depends on:** Phases 08, 14 · **Day 5**

**Files:** `apps/dashboard/src/runs/*`, `src/api/runs.ts` (modify)

**Tasks:**
1. **Run list:** status, customer, one-line summary, live indicator, sorted by activity.
2. **Drawer over the dashboard, not a third page.** Renders the same session component the chat page uses — "two pages" holds honestly rather than by relabeling.
3. **WebSocket client** with backlog-then-live, reconnect with backoff, and a visible disconnect banner.
4. **Tool calls stream** collapsed by default, expandable to arguments and results.
5. **Steering composer** — type into a live run.
6. **Shadow-run affordance** on reference-channel threads (Phase 21 uses it).

**Exit criteria:** Open a running bug fix, watch the tool calls, type a correction, see the agent change course.

---

## Phase 16 — Approval card

**Goal:** One click, where the engineer already was.

**Depends on:** Phases 11, 14 · **Day 5**

**Files:** `apps/dashboard/src/approvals/*`

**Tasks:**
1. **Card pinned above the fold** — draft, why, thread context, target channel.
2. **Approve / Edit / Reject.** Edit is inline, not a modal.
3. **Reject requires a reason** — that reason is training data for Phase 21, not paperwork.
4. **Optimistic update with rollback** on failure.
5. **Live withdrawal handling.** A card can vanish under the cursor when the agent withdraws it (spec §5.3); it must disappear with an explanation, never silently.
6. **Empty state** that reads as reassurance rather than absence.

**Exit criteria:** An escalation appears within a second of `escalate()`. Approve sends as the on-duty engineer. Reject reaches memory.

---

## Phase 17 — Chat page + citations

**Goal:** "What happened with X?" answered with links to the actual threads.

**Depends on:** Phases 06, 08, 14 · **Day 5**

**Files:** `apps/dashboard/src/chat/*`, `src/api/chat.ts`

**Tasks:**
1. **Chat session list and composer**, same session component as runs.
2. **Human-first runs** keyed `chat:{uuid}`.
3. **Citation rendering** — Zep facts resolved through D1 to real permalinks, displayed as clickable sources.
4. **"Ship the copy-ID button Priya asked for"** starts a run by hand from the chat page.
5. **Viewer role** works fully here with no OAuth.

**Exit criteria:** Ask about a real past thread; get an answer whose citations open the actual Slack messages.

---

## Phase 18 — Sandbox Tier 2

**Goal:** The agent boots its own machine.

**Depends on:** Phase 00 Task 1 **GO** and access to **[`Zellify/web2app-rebuild`](https://github.com/Zellify/web2app-rebuild)** · **Day 5**

**Files:** `sandbox/Dockerfile`, `src/codemode/bindings/sandbox.ts`, `src/sandbox/lifecycle.ts`, `test/sandbox-*.test.ts`

**Tasks:**
1. **Read `web2app-rebuild`'s root `AGENTS.md` first** — the brief says so, and local dev setup is documented there. Everything in this phase and the next two depends on conventions written down in that file.
2. **Baked image:** `web2app-rebuild` pre-cloned, pnpm store warm, Chromium preinstalled. This is the difference between a one-minute and an eight-minute repro, and the drill is timed by a human watching a thread.
3. **`sandbox` binding** exposing `boot`, `exec`, `read`, `write`, `preview`, `diff` — the Phase 09 surface.
4. **Lifecycle tied to the run**, with idle teardown so a forgotten container does not eat the budget.
5. **Private clone without a container-held write token**, following the spec §8.3 ladder in order.
6. **Dev server as a long-running process**, with `tunnels.get(port)` yielding a reachable preview URL.

**Exit criteria:** The agent boots a machine, gets the monorepo dev server serving, and runs the test suite — all from model-authored code.

---

## Phase 19 — Ship loop + proof capture

**Goal:** Reproduce, fix, verify in a real browser, record the proof.

**Depends on:** Phase 18 · **Day 6**

**Files:** `sandbox/playwright/`, `src/sandbox/record.ts`, `src/files/r2.ts`, `wrangler.jsonc` (modify: R2 binding)

**Tasks:**
1. **Playwright in the image**, driven from model-authored code via `exec`.
2. **`browser.record(fn)`** wrapping a context with `recordVideo` — no screen-capture rig.
3. **webm → mp4 transcode** so the link previews usefully.
4. **R2 upload returning a public URL.** This sidesteps the `files:write` scope question entirely: a link needs no Slack file scope.
5. **The verify cycle:** repro fails → apply fix → repro passes → record the passing run.
6. **`diff()` returns the change as a string** — the container's entire output, per D5.

**Exit criteria:** A planted bug is reproduced, fixed, re-verified, and a playable recording sits at an R2 URL.

---

## Phase 20 — PR and Linear writes

**Goal:** Worker-side writes under the fire-fighter's own identity.

**Depends on:** Phase 19 · **Day 6**

**Files:** `src/codemode/bindings/github.ts`, `src/git/commit.ts`, `src/codemode/bindings/linear.ts`, `test/github-*.test.ts`, `test/linear.test.ts`

**Tasks:**
1. **Diff → PR entirely Worker-side:** blobs → tree → commit → ref → PR via REST, authored as the on-duty engineer with their token. The sandbox never holds it.
2. **Repo PR conventions** honored — base `staging`, Linear issue linked so it closes on merge, proof link in the body.
3. **Linear binding with the team id pinned server-side.** Test that a model-supplied team id is ignored, not merely discouraged.
4. **Large-feature-request issue shape:** value, blocking, and customer-weight assessment as structured fields.
5. **Idempotency** — a retried run updates its PR rather than opening a second one.

**Exit criteria:** A PR appears under the on-duty engineer's GitHub identity with the recording attached and its Linear issue linked.

---

## Phase 21 — Voice, eval harness, shadow mode

**Goal:** Replies indistinguishable from the on-duty engineer's own. This is where the drill catches prompt work that stopped at correctness.

**Depends on:** Phases 10, 07 · **Day 6**

**Files:** `src/agent/prompt/voice.ts` (modify), `src/eval/triage-eval.ts`, `src/eval/voice-samples.ts`, `src/run/shadow.ts`

**Tasks:**
1. **Few-shot the voice with the engineer's own real messages.** D1 already holds every message they have sent in these channels; sample ~20 recent customer-channel replies into the prompt. "Reads as though they wrote it" stops being an instruction and becomes imitation of a specific person — and it re-tunes itself on rotation.
2. **Triage eval:** score stored decisions against what the humans actually did in the reference channels. Report precision and recall on `wake`.
3. **Shadow mode:** force every outbound to escalate, and make approval produce a draft that is never sent.
4. **Side-by-side view** — agent draft against the human's actual reply.
5. **Iterate the voice prompt against real drafts**, not invented ones.
6. **AI-tell checklist as a test:** no preamble, no "Great question!", no bulleted recap, no closing restatement.

**Exit criteria:** Ten shadow drafts on real threads read as though a Zellify engineer wrote them. Triage precision and recall are numbers, not vibes.

---

## Phase 22 — Handoff summary + states polish

**Goal:** Memory outlives the shift, and nothing on screen is ever blank without explanation.

**Depends on:** Phases 15, 16, 17 · **Day 7**

**Files:** `src/handoff/summary.ts`, `apps/dashboard/src/handoff/*`, plus a sweep across all dashboard components

**Tasks:**
1. **Handoff summary** over the org graph and the run list: what the last three days taught the agent, what is still open, what got rejected and why.
2. **Rendered on the dashboard** at rotation, and posted to `#eng-firefighter`.
3. **State sweep:** every panel has loading, empty and error states, and every error offers a way forward.
4. **WebSocket reconnection** under real network loss.
5. **Cold-open test** — hand it to someone who has never seen it and time how long until they can say what it does. Target: under 30 seconds.

**Exit criteria:** A new fire-fighter reads the handoff and knows where things stand without asking anyone.

---

## Phase 23 — Drill dry-run, README, Loom

**Goal:** The deliverables.

**Depends on:** everything · **Day 7**

**Files:** `README.md`, `docs/architecture.md`

**Tasks:**
1. **Dry-run all four drill scenarios cold** in own test channels: how-to question, small feature request, planted bug, large feature request. Count the clicks on the fourth — gating every reply fails it.
2. **README:** architecture with a diagram, the security model (**which must match the code** — cross-check §8 against what Phase 09's isolation test actually proves), cost breakdown for the week, AI-tool notes, and what another week would buy.
3. **AI-tool notes** assembled from every phase's record of invented APIs, with particular attention to Agents SDK and Worker Loader — the brief says this is where the training data is thinnest and it is what they most want to read.
4. **Access policy documented**, including the personal-email override and how to remove it.
5. **Loom, ≤5 minutes**, walking the loop end to end.
6. **Cost reconciliation** against the $500 ceiling, with receipts.

**Exit criteria:** All four scenarios pass in a dry run. The README's security claims are each traceable to a test.
