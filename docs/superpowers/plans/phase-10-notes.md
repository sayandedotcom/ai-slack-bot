# Phase 10 notes — verification record

Companion to `phase-10-agent-loop.md`. Task 0 produces this file before any
loop code is written; later tasks append to it. All facts below were checked
on 2026-08-12 against this worktree, its installed `node_modules`, live
Cloudflare/Anthropic/Zep documentation (via MCP doc search and `WebFetch`
where those tools worked), and the two named reference repositories.

**Operator decision, recorded verbatim:** this implementation run is
**local + automated only**. No live Anthropic API call was made, no deploy was
run, no remote D1 migration was applied, and no Cloudflare account state (Worker
status, deployment revision, secrets) was read. This was an explicit operator
instruction for this run, not a shortcut chosen by the implementer. Every claim
below is marked either "verified locally/via docs" or "NOT RUN — deferred live
proof," and nothing live is implied to have passed.

---

## Baseline

### Commit and package versions

| Thing | Value |
| --- | --- |
| Worktree branch | `worktree-phase-10-agent-loop` |
| HEAD at Task 0 start | `41db32d` (`docs(agent): add the phase 10 agent loop plan`) |
| Branch base (Phase 08/09 code) | `bf9a30b` |
| `git status --short` | clean — nothing pending, nothing untracked |
| `ai` | `7.0.59` |
| `@ai-sdk/anthropic` | `4.0.37` |
| `@cloudflare/codemode` | `0.5.1` (exact, matches Phase 09) |
| `wrangler` (from Phase 09 notes, not re-run here) | `4.120.1` |
| Node / pnpm | `>= 20` / `10.33.4` per roadmap constraints |
| `compatibility_date` (`apps/worker/wrangler.jsonc`) | `2026-08-01`, flags `["nodejs_compat"]` |

### Test / typecheck counts — reproduced, not taken on faith

```
pnpm --filter @workspace/worker typecheck   → tsc --noEmit, exit 0, no output
pnpm --filter @workspace/worker test        → vitest run
  Test Files  38 passed (38)
  Tests       712 passed | 2 skipped (714)
  Duration    43.72s
```

This matches the counts the controller stated (712 passed / 2 skipped / 0
failed, 38 files). Reproduced independently in this worktree, not copied from
the brief. The known flake named in the brief — `test/codemode-security.test.ts
> "omitting globalOutbound reaches the internet"` timing out at 5000ms in the
*original* checkout — did **not** occur in this run; the suite was fully green.
That test is a network-dependent CONTROL case (it asserts the isolate *can*
reach `https://example.com` when `globalOutbound` is intentionally omitted), so
its flakiness is a timing/network property of the control assertion, not a
regression in guarded code. Record it as a known flake to watch for, not a
defect to fix in Phase 10.

### Live Worker URL and deployment revision

- Live Worker URL, as recorded by Phase 09 Task 12 (`phase-09-notes.md`):
  `https://firefighter.sayandeten.workers.dev`, answering `302` to Cloudflare
  Access. That record is carried forward from Phase 09, not re-checked here.
- **Current deployment revision: NOT CHECKED.** Reading Cloudflare account/
  deployment state is out of scope for this local-only run per the operator
  decision above. Do not treat "recorded in Phase 09" as "current."

### Fable access status

**NOT VERIFIED THIS RUN.** No live call was made to Anthropic or through AI
Gateway (operator decision; this is Step 5's deferred proof, see below).
Whether `claude-fable-5` is actually enabled on the account is therefore
**unknown** as of this document. This is a real open gate for whoever runs the
deferred live proof — do not build later tasks as though this is settled.

### Fable's 30-day retention — acknowledged

Verified live against
`https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5`
(fetched 2026-08-12):

> Claude Fable 5 and Claude Mythos 5 carry 30-day data retention and are not
> available under zero data retention: both are designated Covered Models.

This is unchanged from the phase-10 plan's own claim. **Acknowledgement, not a
new decision:** using Fable on real Slack-origin/customer-channel runs means
accepting Anthropic's 30-day provider-side retention of that content, on top of
whatever AI Gateway payload logging is configured (see next item — currently
nothing is configured). The manager's explicit sign-off that this is acceptable
for real customer data is a precondition the plan already calls out
(`## Data-retention gate`); Task 0 does not have and cannot manufacture that
sign-off. Recording the fact here so it isn't silently assumed later.

### AI Gateway configuration — GAP

There is currently **no AI Gateway configured anywhere in this repository.**
Evidence:

- `apps/worker/wrangler.jsonc` `vars` block has no `AI_GATEWAY_ANTHROPIC_URL`,
  `AI_GATEWAY_ID`, or any `cf-aig-*`-shaped key.
- `apps/worker/.dev.vars` defines no AI-Gateway-related secret (see the secret
  name list below).
- The only trace of Gateway plumbing in source is an **optional, unused-in-
  practice** env field: `apps/worker/src/triage/run.ts` and
  `apps/worker/src/index.ts` both declare `AI_GATEWAY_ANTHROPIC_URL?: string`
  on their `Env` type and conditionally pass it as `baseURL` if present. Since
  it is never set, Phase 09/triage currently talks to Anthropic directly, not
  through Gateway.

This is recorded as a **gap**, not a Phase 10 Task 0 defect: standing up an
authenticated AI Gateway (ID, base URL, `cf-aig-authorization` token as a
Worker secret, payload logging explicitly disabled per the plan's
`## Data-retention gate`) is live account configuration that later Phase 10
tasks (specifically the provider-factory task) must create and this document
must not claim already exists. No secret/token value is recorded anywhere in
this file, only presence/absence of configuration.

### Phase 09 Loader deployed smoke / CPU-runaway probe — honest status

Read directly from `docs/superpowers/plans/phase-09-notes.md`, not upgraded:

- **Local claims proven** (Task 4b, Task 14): the *parent-side* race for a
  runaway (`while (true) {}`) program correctly returns `execution_timeout` on
  schedule under `@cloudflare/vitest-pool-workers`. This is proven locally.
- **The isolate itself is not killed locally.** Phase 09's own notes state
  measured `workerd` CPU at ~75% indefinitely after the race returns, under the
  vitest pool — `limits.cpuMs` is not enforced there. Running that case wedges
  the whole test runtime, so it is `it.skip` with the reason recorded inline in
  `test/codemode-executor.test.ts`.
- **"Workerd itself kills a CPU burn" is explicitly marked "deployed only —
  still unproven"** in Phase 09's own handoff table (Task 14, "What is proven
  locally vs deployed"), and Task 15's own "Remaining gate" section says the
  deployed smoke was never run: *"Task 15 Step 3, the deployed smoke check, has
  not been run."*
- Phase 09's `wrangler deploy --dry-run` passed (exit 0) at its own Task 0, but
  that is a bundling check, not a live deploy or a live CPU-limit proof.

**Conclusion carried into Phase 10: the CPU-runaway enforcement claim remains
unverified end-to-end.** Phase 10 must not assume `limits.cpuMs` actually stops
a runaway model-authored program in production; it inherits Phase 09's
open item, does not close it, and this document is not the place that closes
it either (see "Deferred live proofs" below, which restates it as a proof
still owed).

### Vendor readiness

All facts below are carried forward from `phase-09-notes.md`, cross-checked
against the actual source files listed, and **not re-probed live** in this run
(no live vendor calls were made for Task 0; the phase-09 record is the most
recent live evidence that exists).

| Vendor | Status | Evidence |
| --- | --- | --- |
| Slack | Channel-policy table (`channels`, via `apps/worker/src/db/channels.ts`) exists with `mode: "observe" \| "live" \| "internal"` and fail-closed `getChannelPolicy`/`canPost`. **Row contents (which channels are currently `live`, including `#test-firedrill`) were NOT queried this run** — that is live D1 state, out of scope per the operator decision. Phase 09 also recorded that 2 of 3 probed Slack channels had ingested zero messages, "the bot is likely not a member." |
| Supabase | `PRODUCTION_ALLOWLIST` is a reviewed constant and is currently **empty** — the project has no tables reachable by the publishable key. `supabase.*` is correct but answers nothing useful yet (Phase 09 Task 9). Not re-probed live this run. |
| Linear | Working against the live `fire-fighter-testing` team (`LINEAR_TEAM_ID` pinned in `wrangler.jsonc`), including verified duplicate-id reconciliation (Phase 09 Task 8). Not re-probed live this run. |
| LangSmith | Working endpoint shape, but the pinned project `tweakleaf` has **zero runs** — normalization has never seen a real trace (Phase 09 Task 10, still an open gap as of that record). Not re-probed live this run. |
| Better Stack (logs) | Working live as of Phase 09 Task 11, after fixing the `param_*` URL-vs-body placement bug, but **nothing currently ships Worker logs into the source** (no Logpush job, no tail Worker) — so it searches near-empty data. Not re-probed live this run. |
| Better Stack (monitors) | Working against the live account with a 4-field allowlist (Phase 09 Task 11). Not re-probed live this run. |
| R2 bucket | `firefighter-artifacts`, private (no public origin), served only through the Worker's own `/api/artifacts/` path behind Access; objects stored `Content-Disposition: attachment` (Phase 09 Task 12). Not re-probed live this run. |

### Vendor secret readiness — names only, no values

`apps/worker/.dev.vars` in this worktree defines these secret names (values
never inspected or recorded):

```
ANTHROPIC_API_KEY
BETTERSTACK_SQL_PASSWORD
BETTERSTACK_SQL_USERNAME
BETTERSTACK_UPTIME_TOKEN
LANGSMITH_API_KEY
LINEAR_API_KEY
SLACK_BOT_TOKEN
SLACK_SIGNING_SECRET
SUPABASE_KEY
ZEP_API_KEY
```

No `AI_GATEWAY_*` secret is present — consistent with the "AI Gateway
configuration — GAP" item above.

Non-secret pins live in `apps/worker/wrangler.jsonc` `vars`: `BETTERSTACK_SQL_
ENDPOINT`, `BETTERSTACK_LOG_SOURCE_IDS`, `LINEAR_TEAM_ID`/`LINEAR_TEAM_NAME`,
`LANGSMITH_ENDPOINT`/`LANGSMITH_WORKSPACE_ID`/`LANGSMITH_PROJECT_ID`/
`LANGSMITH_PROJECT_NAME`, `SUPABASE_URL`. No `AI_GATEWAY_ID` or `AI_GATEWAY_
ANTHROPIC_URL` value is pinned there either.

### D1 migrations present

`apps/worker/migrations/`: `0001_init.sql`, `0002_memory.sql`,
`0003_triage.sql`, `0004_runs.sql`, `0005_codemode_effects.sql`. Confirms the
plan's claim that `0006` is the next free number for Phase 10's
`0006_agent_loop.sql`, `0007` for Phase 11 approvals, `0008` for Phase 12
identities.

---

## Step 3 — installed API verification (the load-bearing table)

The plan's "Installed API findings that are load-bearing" table was checked
line by line against the **installed** `.d.ts` files, not memory and not the
public AI SDK website (which can lag the installed major, per the plan's own
warning). Every claim in the plan's table **holds**.

### `ai@7.0.59` (`apps/worker/node_modules/ai/dist/index.d.ts`)

| Plan claim | Verified against installed types | Holds? |
| --- | --- | --- |
| `streamText()` exposes `stream` (current) | `readonly stream: AsyncIterableStream<TextStreamPart<TOOLS>>;` on `StreamTextResult` | YES |
| `fullStream` is deprecated | Same interface, immediately followed by `/** ... @deprecated Use \`stream\` instead. */ readonly fullStream: ...` | YES |
| `usage` is current | `readonly usage: PromiseLike<LanguageModelUsage>;` | YES |
| `totalUsage` is deprecated | Next property: `/** @deprecated Use \`usage\` instead. */ readonly totalUsage: ...` | YES |
| `onEnd` is current, `onStepEnd` is current | `streamText()` JSDoc: "`onStepEnd` - Callback ... when each step ... ends" / "`onEnd` - Callback ... when all steps are finished" | YES |
| `onFinish`/`onStepFinish` are deprecated aliases | JSDoc: "`onStepFinish` - Deprecated alias for `onStepEnd`." / "`onFinish` - Deprecated alias for `onEnd`." and matching `@deprecated Use \`onStepEnd\`/\`onEnd\` instead.` on the property declarations | YES |
| `prepareStep` (`PrepareStepFunction`/`PrepareStepResult`) exists | `type PrepareStepFunction<...>` at line 1637, `type PrepareStepResult<...>` at line 1692 | YES |
| `stepCountIs()` exists | Exported as `isStepCount as stepCountIs` in the package's public export list | YES |
| `TimeoutConfiguration` exists | `type TimeoutConfiguration<TOOLS extends ToolSet> = number \| {...}` at line 597 | YES |
| `TextStreamPart`, `StepResult`, `ResponseMessage` exist | `type ResponseMessage = AssistantModelMessage \| ToolModelMessage;` (176); `type StepResult<...>` (1395); `TextStreamPart` exported | YES |
| `LanguageModelUsage` carries classified token fields | `inputTokenDetails: { noCacheTokens, cacheReadTokens, cacheWriteTokens }`, `outputTokenDetails: { reasoningTokens }` all present | YES |

**Plan verdict: no drift found.** Every "use"/"do not use" pairing in the
plan's table matches the installed package exactly, including the exact
deprecation wording. This is the opposite of what Task 0 was primed to expect
("the plan asserts specific API facts... verify each... if the plan is wrong,
write it down clearly") — nothing was wrong. Recording the clean result
explicitly rather than skipping the table because it passed.

### `ai/test` (`apps/worker/node_modules/ai/dist/test/index.d.ts`)

- `MockLanguageModelV4` is exported (`declare class MockLanguageModelV4
  implements LanguageModelV4`), alongside `MockLanguageModelV3` and mock
  provider/embedding/image/rerank/speech/transcription/video variants.
- The brief also asked to check the bundled
  `docs/03-ai-sdk-core/55-testing.mdx` "if present." **It is not present** —
  `find node_modules/ai -iname "*.mdx"` returns zero files in this install.
  Do not cite a bundled testing guide that does not exist in this dependency
  tree; `MockLanguageModelV4`'s own `.d.ts` signatures are the only installed
  authority for its usage shape.

### `@ai-sdk/anthropic@4.0.37` (`apps/worker/node_modules/@ai-sdk/anthropic/dist/index.d.ts`)

- `AnthropicModelId` union **includes `'claude-fable-5'`** verbatim (also
  `'claude-sonnet-5'`, `'claude-opus-5'`, and several dated Opus/Sonnet/Haiku
  IDs, plus `(string & {})` for forward compatibility). Confirms the plan's
  model ID.
- `anthropicLanguageModelOptions` (the provider-options Zod schema) declares,
  exactly as the plan's "Provider options" block uses them:
  - `thinking`: discriminated union of `{ type: 'adaptive', display?: 'omitted'
    | 'summarized' }`, `{ type: 'enabled', budgetTokens? }`, `{ type:
    'disabled' }`. The plan's `{ type: "adaptive", display: "omitted" }` is a
    legal member of this union.
  - `disableParallelToolUse?: boolean`.
  - `cacheControl?: { type: 'ephemeral', ttl?: '5m' | '1h' }` — exactly the
    plan's `{ type: "ephemeral", ttl: "5m" }` shape.
  - `effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'` — the plan's
    `effort: "high"` is a legal member.

**Plan verdict: no drift found** on any of the four reviewed option names.

### `@cloudflare/codemode@0.5.1`

Re-checked against `apps/worker/node_modules/@cloudflare/codemode/package.json`
(`"version": "0.5.1"`) and its `dist/` contents. No new findings beyond what
Phase 09's own notes already recorded against this exact installed version
(P1–P4 in `phase-09-notes.md` Task 0 Step 3, plus the `load()`
no-`limits`-field, `entrypoint.evaluate(dispatchers, ...)` argument-not-`env`
placement, and `.message`-only error surface facts). Phase 10 inherits those
findings unchanged; nothing in this task required re-deriving them.

---

## Step 3 — Cloudflare/Anthropic/Zep doc verification

Cloudflare docs were reachable via `mcp__plugin_cloudflare_cloudflare-docs__
search_cloudflare_documentation`; Zep docs via `mcp__zep-docs__search_
documentation`; Anthropic's platform docs via `WebFetch` (not an MCP tool, but
worked). All three tools worked in this run — no tool-unavailability gap to
report here.

### Alarm retry/limit and constructor re-arming

Source: `https://developers.cloudflare.com/durable-objects/api/base/`
(fetched via Cloudflare docs MCP, 2026-08-12).

> The `alarm()` handler has guaranteed at-least-once execution and will be
> retried upon failure using exponential backoff, starting at two second
> delays for up to six retries. Retries will be performed if the method fails
> with an uncaught exception.

This confirms the plan's "Cloudflare's six automatic retries" claim and its
at-least-once framing exactly (invariant 9 in the plan). The `alarm(alarmInfo)`
callback also receives `retryCount`/`isRetry`, which the plan does not
currently use but could for backoff-aware logging.

**"Whether constructor re-arming can overwrite a newer alarm" — NOT directly
documented.** Cloudflare's docs describe `setAlarm(timestamp)` as scheduling
"the `alarm()` handler to run at any time in the future" and state plainly that
"Each Durable Object" has essentially one pending alarm slot (this is also
already an explicit Phase 10 invariant: "One DO has one alarm slot"). No
fetched page states the specific ordering guarantee the plan's own Step 3 asks
about — i.e., whether a short `blockConcurrencyWhile()` constructor recovery
that calls `setAlarm()` to "re-arm a pending/stale driver" could race with, and
clobber, an alarm time that was set moments earlier by a legitimate newer input
(e.g., a steer that arrived and called `setAlarm(Date.now())` between the
object's eviction and its next wake). This is a real open question for Task 3
(the alarm-driven driver), not resolved by documentation. **Do not assume it
away — design the constructor recovery path to only set the alarm when none is
currently pending (`getAlarm() === null`), or to `setAlarm` no later than
whatever is already scheduled**, and prove the chosen behavior with a test in
Task 3, because the platform docs do not give this guarantee explicitly.

### AI Gateway Anthropic base URL and header names

Source: `https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/`
and `https://developers.cloudflare.com/ai-gateway/usage/rest-api/` (Cloudflare
docs MCP, 2026-08-12).

- Base URL shape: `https://gateway.ai.cloudflare.com/v1/{accountId}/{gatewayId}/anthropic`.
- The Anthropic-provider page's own SDK example authenticates to **Cloudflare**
  with `Authorization: Bearer {cf_api_token}` as a `defaultHeaders` entry
  alongside the Anthropic SDK's own `apiKey`.
- A different, also-current Cloudflare doc (the Claude Code / AI Gateway
  integration page) instead names **`cf-aig-authorization`** as "what
  authenticates your request to AI Gateway," used when routing through
  `ANTHROPIC_CUSTOM_HEADERS`.

**These two header names are not obviously the same mechanism, and this run
did not resolve which one an AI SDK `createAnthropic({ baseURL, headers })`
composer should send for an *authenticated* gateway versus an *unauthenticated
default* one.** The phase-10 plan's own "Provider factory" section already
specifies `cf-aig-authorization: Bearer <AI_GATEWAY_TOKEN>` — consistent with
the second doc, not the first — but since no AI Gateway is actually configured
in this repo yet (see the GAP above), this header choice has never been
exercised end-to-end. Record as **an open item for the Task 5 provider-factory
work**: confirm the header name against the actual Gateway instance once one
exists, with a real 401 test if the wrong header is sent.

### Fable `thinking`, refusal, model ID, and prices

Source: `https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5`
(`WebFetch`, 2026-08-12).

- Model ID: `claude-fable-5` (table: "Claude Fable 5 | `claude-fable-5`").
  Matches the installed `@ai-sdk/anthropic` union exactly.
- Pricing: **$10 / million input tokens, $50 / million output tokens.** Matches
  the plan's cost table's uncached-input (10,000 nano-USD/token) and output
  (50,000 nano-USD/token) rows exactly.
- Thinking: "Adaptive thinking is always on... passing `thinking: {"type":
  "disabled"}` is not supported... `thinking.display` ... `"omitted"` (the
  default) returns thinking blocks with an empty `thinking` field... Pass
  thinking blocks back unchanged in multi-turn conversations on the same
  model." This directly supports the plan's provider option
  `thinking: { type: "adaptive", display: "omitted" }` and invariant 17 (pass
  the opaque block back unchanged).
- Refusal: "When Claude Fable 5 declines a request, the Messages API returns
  `stop_reason: "refusal"` as a successful HTTP 200 response, not an error."
  Matches the plan's refusal handling exactly (invariant 30).
- Billing on refusal: "You are not billed for a request that is refused before
  any output is generated." Matches the plan's "pre-output refusal: ... cost is
  zero" rule.
- **Retention:** "Claude Fable 5 and Claude Mythos 5 carry 30-day data
  retention and are not available under zero data retention" — see the
  retention section above.

Cache-write/cache-read multipliers were **not** stated on the Fable 5 launch
page itself, so they were separately verified against
`https://platform.claude.com/docs/en/build-with-claude/prompt-caching`
(`WebFetch`, 2026-08-12), which states the multipliers apply "consistently
across all Claude models":

> 5-minute cache write tokens are 1.25 times the base input tokens price; 1-hour
> cache write tokens are 2 times the base input tokens price; cache read tokens
> are 0.1 times the base input tokens price.

Applied to Fable 5's $10/M input rate: 5-minute cache write = $12.50/M,
1-hour cache write = $20.00/M, cache read = $1.00/M. **This is an exact match**
for every row in the plan's "Fable 5 cost table" (12,500 / 20,000 / 1,000
nano-USD/token respectively). No drift found in the cost table.

### AI SDK callback/property deprecations

Covered above under the installed-types section; the doc-verification pass
added nothing beyond what the `.d.ts` files already prove, since the installed
declarations are the implementation authority per the plan's own instruction
("The public AI SDK website can lag the installed major").

### Zep `graph.add` metadata and idempotency key

Source: `mcp__zep-docs__search_documentation`, queried 2026-08-12 for episode
metadata and idempotency.

- Metadata shape confirmed: "Metadata values must be scalars (string, number,
  or boolean) or non-empty arrays of such scalars... A maximum of 10 keys are
  allowed per episode. Nested objects are not supported, and empty arrays or
  arrays containing null are rejected." Matches the plan's "Keep metadata
  within Zep's verified maximum of ten scalar/non-empty scalar-array tags"
  claim exactly.
- **No client-supplied episode idempotency key was found.** The batch-add
  response example shows Zep assigning `"uuid"` server-side
  (`"uuid": "a1b2c3d4-..."`), and the docs explicitly say, for the related
  `graph.add_nodes` call, that "a request that includes a node `uuid` is
  rejected with a `400`... Every accepted node is a new node." Nothing found in
  the docs search grants `graph.add` (episode creation) a caller-supplied ID
  that would make retries idempotent. This **confirms** the plan's own stated
  limitation verbatim: "without a client-supplied episode ID, a crash after
  `graph.add` and before D1 mapping can create a duplicate semantic episode."
  Do not invent an episode idempotency field later — this was checked, not
  assumed.

---

## Step 4 — reference-repo inspection (current revisions)

Both repos were reachable via `WebFetch` in this run (their READMEs), so the
adopt/reject lists below reflect the **current** upstream revision as fetched
2026-08-12, not a stale copy of the plan's own list.

### `cloudflare/agents-starter`

Fetched confirms, as of now: it uses `AIChatAgent` ("Streaming responses
powered by Workers AI via `AIChatAgent`"), exposes several flat tools (weather,
timezone, calculations, task scheduling, vision) as a plain tools object, and
demonstrates `needsApproval` explicitly ("add `needsApproval` to gate
execution").

**Adopt:**
- the current `streamText()` streaming pattern and a finite `stopWhen`-style
  step bound;
- explicit `abortSignal` propagation;
- operational broadcasts kept outside the model's conversation;
- its UI tool-state taxonomy and chronological rendering ideas.

**Reject, with the concrete Phase 08 features that make each rejection
non-taste** (read from `apps/worker/src/run/do.ts` and
`apps/worker/src/run/session.ts` in this worktree, not asserted from memory):

- **`AIChatAgent` persistence** — Phase 08's `RunDO` already owns:
  - **hibernating sockets**: `fetch()` calls `this.ctx.acceptWebSocket(server)`
    (never `server.accept()`, which the code comments explain "yields a working
    socket that pins the object in memory"), and `webSocketMessage()` is a
    class handler specifically because "an ordinary `addEventListener` ...
    works right up until the object hibernates."
  - **a replay cursor**: `fetch()` accepts `?since=` and drains
    `listEvents(storage, cursor, SYNC_CHUNK)` in bounded `SYNC_CHUNK = 200`
    pages, and `#broadcast` uses each socket's own
    `deserializeAttachment().lastSeq` (survives hibernation) to avoid
    re-delivering or dropping events on reconnect.
  - **public IDs distinct from the storage key**: `run/keys.ts`'s own header
    comment states "the public `runs.id` in dashboard URLs is a UUID, and the
    Worker looks the key up in D1 rather than letting a browser hand us a
    Durable Object name," and `run/repository.ts`'s `RunListItem` type
    explicitly omits `key` ("Note the absence of `key` — see invariant 10").
  - **a D1 run index**: `run/repository.ts` is described inline as "D1-only
    operations on the run index... `GET /api/runs` must be able to render the
    dashboard without waking a single Durable Object."
  - **thread-scoped SQLite**: one `RunDO` per `slack:{channel}:{thread}` or
    `chat:{uuid}` origin key (`run/keys.ts`), with its own private
    `ensureSchema()`-managed tables (`session.ts`: `stream_events`, `turns`,
    `tool_calls`, `run_state`), synchronous by construction so a commit and its
    broadcast happen in one uninterrupted DO event.

  Adopting `AIChatAgent` now would mean running two persistence and concurrency
  models side by side for the same session — the exact "second session store"
  the plan's invariant 1 forbids, not a stylistic preference.
- its chat-recovery/reconnect implementation as proof for Phase 10's own
  replay design, because it is built on `AIChatAgent`'s persistence and cannot
  be tested as evidence for a `RunEvent`-cursor design that is deliberately
  separate;
- the starter's multiple flat tools, because Phase 09 already ships exactly
  one (`run_code`) and this remains a Phase 10 invariant (invariant 5);
- `needsApproval`, confirmed present in the current README exactly as the plan
  described — reject because the assignment requires model-authored escalation
  with one dashboard approval writer (Phase 11), not a per-tool annotation;
- reasoning display — not applicable to an internal customer-data product per
  the plan, and contrary to Fable's own default `display: "omitted"` safety
  posture.

### `rtpa25/self-syncing-agent`

Fetched confirms, as of now: one Durable Object per user supervises a "sync
registry" with per-sync facet SQLite storage; nine tools split across
inspection/query/discovery/mutation groups (a multi-tool shape, not Phase 09's
flat single tool); the README lists "No rate limiting" and "Rate limiting +
cost guards" under future work; and it documents, close to verbatim, the exact
failure the plan cites: *"`AI_MissingToolResultsError` fires intermittently
when the main agent makes parallel tool calls — a known AI SDK interaction with
the approval-gated flow. Retry the message; no data loss."* The README also
notes the author tried and reverted a server-side retry guard because it
"silenced legitimate assistant messages."

**Adopt:**
- stable prompt instructions ordered before dynamic context;
- explicit prompt-cache breakpoints;
- a finite step stop with structured abort/error/finally cleanup;
- the documented missing-tool-result failure as evidence for Phase 10's own
  `disableParallelToolUse: true` decision — this is a **measured** upstream
  failure mode, not a hypothetical one.

**Reject:**
- its session model (one DO per user with per-sync facets) — Phase 10 keeps
  RunDO's one-thread-per-object model, unrelated shape;
- any synthetic repair that invents a missing tool result — the plan already
  forbids fabricating a tool result (see the model-transcript-contract
  section: "Never fabricate a tool result to repair a malformed history");
- any tool map that bypasses Phase 09's reviewed capability boundary — its 9
  flat tools are exactly the shape Phase 09 deliberately avoided;
- assumptions that a browser remains connected while the agent works — RunDO's
  alarm-driven design has no such assumption.

**Confirmed as current, not stale:** the repo's README still lists rate/cost
guards as unimplemented future work, so the plan's claim that "the repository
does not supply Phase 10's output, wall-time, spend, or single-Code-Mode-tool
guarantees" remains accurate at the fetched revision.

---

## Step 5 — deferred live proofs (NOT RUN, by explicit operator decision)

**None of the following was executed in this run.** The operator decided this
implementation pass is local + automated only: no Anthropic API call, no
spend, no deploy, no remote D1 migration, no Cloudflare account read. This
section exists so the next session (or a human) can run each proof exactly as
written, with a defined pass condition, instead of re-deriving the shape of
the check from scratch.

### 1. `claude-fable-5` is accepted by the actual Anthropic account

**Command shape** (throwaway script, never committed with a real key; reads
`ANTHROPIC_API_KEY` from the environment, e.g. via `.dev.vars` sourced into the
shell — never printed):

```ts
// scratch-fable-smoke.ts — DO NOT COMMIT
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";

const result = await generateText({
  model: anthropic("claude-fable-5"),
  prompt: "Reply with exactly the word: pong",
  providerOptions: {
    anthropic: { thinking: { type: "adaptive", display: "omitted" } },
  },
});
console.log(JSON.stringify({
  text: result.text,
  finishReason: result.finishReason,
  rawFinishReason: (result.providerMetadata as any)?.anthropic?.stopReason,
  usage: result.usage,
}, null, 2));
```

Run with `pnpm --filter @workspace/worker exec tsx scratch-fable-smoke.ts`
(or equivalent), sourcing `ANTHROPIC_API_KEY` from `.dev.vars` into the process
environment without echoing it.

**Passing result:** the call resolves (no 404/model-not-found error), `text`
is non-empty (absent a refusal), and `usage` reports `inputTokens`/
`outputTokens`. **Failing result requiring a stop, per the brief:** any
model-not-found/entitlement error. Per the task brief, if Fable access is
missing, stop and ask in `#eng-firefighter` — do not silently substitute
another model.

### 2. `thinking: adaptive` / `display: omitted` behaves as documented

Same script as above; inspect the raw response for a `thinking` content block.

**Passing result:** if a thinking block is present in the raw provider
response, its `thinking` text field is empty/absent (never a readable
chain-of-thought) and it carries an opaque `signature` (or `redactedData`
metadata) field. **Failing result:** any non-empty readable reasoning text —
per plan invariant 17, that must be treated as a safety failure, not silently
passed through.

### 3. Raw stop reason and usage/cache fields are observable

Same script; assert the shape of `result.providerMetadata.anthropic` (or the
equivalent raw provider response captured via a `LanguageModelMiddleware` or
direct `doGenerate` call) exposes the raw Anthropic `stop_reason` string
(distinct from the AI SDK's normalized `finishReason`), and that
`result.usage.inputTokenDetails.{noCacheTokens,cacheReadTokens,
cacheWriteTokens}` and `outputTokenDetails.reasoningTokens` are present (even
if zero) rather than absent.

**Passing result:** all fields present and typed as expected from the
installed `.d.ts` (see the Step 3 verification above). **Failing result:** a
field silently missing from the real response despite being declared in
`LanguageModelUsage` — would mean the installed types describe an aspirational
shape rather than the actually-returned one, and the cost-accounting design
would need to add defensive handling before Task 5 builds on it.

### 4. Response messages retain the opaque thinking block for tool continuation

Extend the smoke test to a second, tool-using turn: call `generateText` (or
`streamText`) with one trivial tool once, capture `result.response.messages`,
then replay those messages (unmodified) as the `messages` input to a follow-up
call on the same model.

**Passing result:** the follow-up call succeeds without Anthropic rejecting the
history (no "thinking block signature invalid" or similar 400). **Failing
result:** the second call is rejected — would mean the AI SDK's
`ResponseMessage` shape for Fable's thinking blocks does not round-trip
losslessly through `response.messages`, which would force Task 4 (transcript
recovery) to special-case a raw-provider-level replay stitch instead of using
`response.messages` directly.

#### 4a. Status after Task 4 — the automated half is done, the LIVE half is NOT RUN

Task 4 built the serialize → deserialize → continue proof as an **automated**
test over realistic fixtures, because this run remains local + automated only by
the same operator decision recorded at the top of this file. What that test
proves, and what it does not, stated exactly:

**Proven, locally, in `apps/worker/test/agent-transcript.test.ts`:**

- A Fable-shaped tool-use step — an omitted-thinking `reasoning` part with
  `text: ""` and an opaque `providerOptions.anthropic.signature`, plus the
  `run_code` tool call it accompanies, plus the matching tool result — survives
  `normalizeResponseMessages` → `checkpointStepMessages` → `readModelTranscript`
  **byte-identically** (`JSON.stringify` equality on the whole message array).
- The same holds for the `redactedData` variant.
- The recovered history is accepted by the AI SDK's own prompt standardization:
  `generateText` against `MockLanguageModelV4` builds a request from it without
  raising a missing-tool-result error, and the signature arrives at
  `doGenerateCalls[0].prompt` unchanged.
- Persisted thinking display text is empty, and checkpointing a step emits **no
  RunEvent at all**, so no signature or reasoning reaches the replayable stream.

**NOT RUN — still owed, and not implied by any of the above:** whether
*Anthropic itself* accepts the replayed signature. No live call was made. A
mock model cannot reject a signature it never verified, so the automated test
cannot and does not stand in for deferred proof #4 above. Run it as:

```ts
// scratch-fable-continue.ts — DO NOT COMMIT
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, tool } from "ai";
import { z } from "zod";

const model = anthropic("claude-fable-5");
const providerOptions = {
  anthropic: { thinking: { type: "adaptive", display: "omitted" }, effort: "high" },
};
const tools = {
  ping: tool({
    description: "Returns pong.",
    inputSchema: z.strictObject({}),
    execute: async () => ({ pong: true }),
  }),
};

// 1. Provoke one tool-use step.
const first = await generateText({ model, tools, providerOptions, stopWhen: () => true,
  prompt: "Call the ping tool once, then say done." });

// 2. Round-trip its response messages through the real code path.
import { normalizeResponseMessages } from "./src/agent/transcript";
const normalized = normalizeResponseMessages(first.response.messages);
if (normalized.outcome !== "normalized") throw new Error(normalized.reason);
const recovered = JSON.parse(JSON.stringify(normalized.messages));

// 3. Continue from the recovered history.
const second = await generateText({ model, tools, providerOptions,
  messages: [{ role: "user", content: "Call the ping tool once, then say done." }, ...recovered] });
console.log(second.text, second.finishReason);
```

**Passing result:** step 3 resolves. **Failing result requiring a stop:** any 400
mentioning a modified/invalid thinking block signature, or a missing tool result
— either would mean `normalizeResponseMessages` drops or alters something
Anthropic requires, and Task 7 must not be built on it until that is fixed.

### 5. Prompt-cache proof (from the plan's own "Prompt-cache proof" section)

Run the smoke script's first request once, then a second request that repeats
the exact same stable prefix (system/instructions block) with `cacheControl:
{ type: "ephemeral", ttl: "5m" }` set on that block.

**Passing result:** the second response's
`usage.inputTokenDetails.cacheReadTokens > 0`, and (if AI Gateway is stood up
by then) the Gateway log for that request shows a cache hit. **Failing
result:** `cacheReadTokens` stays `0` on the repeat call — would mean the
cache-control placement (which message/block it's attached to) is wrong and
needs to move before Task 5 is considered done.

### 6. AI Gateway header authentication (new item, surfaced by this task's Step 3 doc check)

Once an AI Gateway is actually provisioned (out of scope for Task 0 — see the
"AI Gateway configuration — GAP" section): send one request through
`https://gateway.ai.cloudflare.com/v1/{accountId}/{gatewayId}/anthropic` with
`cf-aig-authorization: Bearer <token>` as the plan specifies, and confirm it is
accepted (not a 401), resolving the `Authorization` vs `cf-aig-authorization`
ambiguity found in the docs during this task.

### 7. Phase 09's CPU-runaway probe, deployed (inherited open item, restated here)

Not attempted this run — inherits Phase 09's own unresolved "Task 15 Step 3"
gate. **Passing result** (as Phase 09 itself defines it): a deployed
`run_code` call executing `while (true) {}` is terminated by `workerd` itself
(not merely returned-to-caller by the parent-side race, which is already
proven locally) within the configured `cpuMs` bound. This is a prerequisite
Phase 10 inherits rather than one it introduces.

---

## API drift and AI-mistakes table

For the README's AI-tool section, per the plan's Step 3 checklist item
("Record every stale/deprecated/invented API in `docs/superpowers/plans/
phase-10-notes.md`").

| Source | Claim checked | Outcome |
| --- | --- | --- |
| Phase 10 plan's "Installed API findings" table | `stream`/`fullStream`, `usage`/`totalUsage`, `onEnd`/`onFinish`, `onStepEnd`/`onStepFinish`, `prepareStep`, `stepCountIs`, Anthropic `thinking`/`effort`/`disableParallelToolUse`/`cacheControl`, `claude-fable-5` model ID | **No drift.** Every claim verified against installed `.d.ts` exactly as stated. |
| Phase 10 plan's Fable cost table | $10/$50 per-million base rates; 5m/1h cache write and cache read rates | **No drift.** Base rates match the Fable 5 launch doc; cache multipliers (1.25x/2x/0.1x) match the prompt-caching doc and multiply out to the plan's exact nano-USD figures. |
| Phase 10 plan's alarm retry claim | "not depending solely on Cloudflare's six automatic retries" | **No drift.** Docs confirm exactly six retries, exponential backoff from 2s. |
| Phase 10 plan's Zep episode-idempotency limitation | "without a client-supplied episode ID... Zep delivery is at-least-once and may contain a physical duplicate" | **No drift, actively confirmed.** Docs show `graph.add_nodes` explicitly rejects a caller UUID (400) and the batch-add response shows a server-assigned `uuid`; no episode idempotency key exists to invent. |
| This task's own doc search (new finding, not in the plan) | AI Gateway request-authentication header name | **Ambiguous, unresolved.** Two current Cloudflare docs use `Authorization: Bearer {cf_api_token}` (Anthropic-provider page) and `cf-aig-authorization` (Claude Code integration page) for what appears to be the same "authenticate to the gateway" concern. The plan already picked `cf-aig-authorization`, consistent with the second doc, but this was never exercised live because no Gateway is configured yet. Flagged as deferred live proof #6 above, not resolved here. |
| This task's own doc search (new finding, not in the plan) | Whether DO constructor re-arming can clobber a newer `setAlarm()` | **Not documented either way.** No Cloudflare doc states the specific race explicitly. Recorded as a design obligation for Task 3, not a documentation gap that further searching will close. |
| Phase 09 notes, carried forward | `limits.cpuMs` enforcement | **Still "deployed only — unproven."** Not something this task's local-only scope could change; restated as deferred proof #7. |

| Task 4, new finding | `ResponseMessage` is exported from `ai` | **Drift.** `ai@7.0.59` DECLARES `type ResponseMessage = AssistantModelMessage \| ToolModelMessage` at `dist/index.d.ts:176` but does **not** export it (`TS2459: declares 'ResponseMessage' locally, but it is not exported`). `agent/transcript.ts` derives it from the exported `PrepareStepFunction`'s `responseMessages` parameter instead of hand-copying it, so a future change to the union breaks the build. |
| Task 4, new finding | Provider-level `finishReason` is a string | **Drift against the obvious reading.** `LanguageModelV4FinishReason` (`@ai-sdk/provider@4.0.7`) is an OBJECT: `{ unified: 'stop' \| 'length' \| 'content-filter' \| 'tool-calls' \| 'error' \| 'other'; raw: string \| undefined }`. Good news for the plan's raw-stop-reason requirement — the raw provider reason is structurally available at the provider layer, not only via `providerMetadata`. Task 5 should read it from here. |
| Task 4, new finding | `LanguageModelV4Usage` matches the flat `LanguageModelUsage` in the plan's table | **Two different types, similar names.** The AI-SDK-level `LanguageModelUsage` is flat (`inputTokens`, `inputTokenDetails.{noCache,cacheRead,cacheWrite}Tokens`) exactly as the plan's Step 3 table records. The PROVIDER-level `LanguageModelV4Usage` nests instead: `inputTokens: { total, noCache, cacheRead, cacheWrite }` and `outputTokens: { total, text, reasoning }`. Neither is wrong; Task 5 must not assume one shape when reading the other. |

**Nothing was invented.** Every table row above is either a confirmation of an
existing plan claim against a primary source (installed `.d.ts` or live docs),
or a new item this task's own verification pass surfaced and explicitly could
not resolve locally — never presented as resolved when it wasn't.

---

## Go / no-go

**GO, with two explicit carry-forward gates, both already true before this
task and unclosed by it:**

1. Fable API access on the real account is unverified (Step 5 deferred).
2. `limits.cpuMs` enforcement in a deployed `workerd` is unverified
   (inherited from Phase 09, restated as deferred proof #7).

Neither gate blocks writing Phase 10's loop code against mocked
`MockLanguageModelV4` providers and the existing local test suite, which is
what Task 1 onward should do; both gates block calling this phase "verified in
production" before someone runs the deferred live proofs in this document.

---

## Task 5 — provider, Gateway, retry and spend

### RESOLVED: the AI Gateway auth-header conflict

Task 0 recorded this as "ambiguous, unresolved" (see the drift table above).
**It is now resolved, and the two docs were never actually in conflict** — they
describe two different endpoint families:

| Endpoint family | Base | Auth header |
| --- | --- | --- |
| REST API | `api.cloudflare.com/client/v4/accounts/<id>/ai/...` | `Authorization: Bearer <CF API token>` |
| Provider-native | `gateway.ai.cloudflare.com/v1/<id>/<gateway>/anthropic` | `cf-aig-authorization: Bearer <token>` |

Source: [AI Gateway →
Authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/),
which states it directly: "When using the REST API, pass your Cloudflare API
token in the standard `Authorization` header. When using provider-native
endpoints at `gateway.ai.cloudflare.com`, use the `cf-aig-authorization` header
instead." On provider-native routes `Authorization` already belongs to the
upstream provider, which is why a second header name exists at all.

This system routes Anthropic **natively**, so the Anthropic SDK keeps sending
its own credential and the Gateway is authenticated separately. That is the
provider-native family, so **the plan's `cf-aig-authorization` is correct** and
no plan change is needed.

To stop the two from ever drifting apart, `agent/model.ts` refuses to compose a
model unless `AI_GATEWAY_ANTHROPIC_URL` is an `https://gateway.ai.cloudflare.com`
URL. Pointed at the REST host, `cf-aig-authorization` would be silently ignored
and the request would authenticate as nobody — so the header choice and the
endpoint choice are now enforced together rather than merely documented
together.

Still **unverified live**: no request has been sent. Deferred proof, below.

### DEFERRED OPERATOR STEP: the Gateway does not exist yet

Task 0 confirmed by grep that no AI Gateway is configured anywhere in this repo,
and that is still true. `AI_GATEWAY_ANTHROPIC_URL` and `AI_GATEWAY_TOKEN` do not
exist in `.dev.vars`, `wrangler.jsonc`, or the account. Creating the gateway,
issuing a `Run`-scoped token, and setting both as **Worker secrets** is a
deferred operator step.

No URL was invented and no check was weakened to make a test pass. The composer
**fails closed** instead: with no Gateway URL it throws `missing_gateway_url`
rather than calling Anthropic directly. Local unit tests never enter the
production composer — they inject `MockLanguageModelV4` — which is why the whole
task is testable with no Gateway in existence.

Deliberately **not** added to `wrangler.jsonc`: the Gateway URL embeds an
account ID and gateway name, but it is inseparable from the secret token that
authenticates to it, and it does not vary by environment today. Both live as
secrets. `pnpm --filter @workspace/worker cf-typegen` was rerun and produced
**no diff** to `worker-configuration.d.ts`, which is the expected result of
adding no non-secret var.

### CONFIRMED: which usage type `streamText` actually hands you

The operator brief flagged the plan's cost table as describing the wrong type.
**Re-checked against both installed declarations, and the plan's table is
correct** for the callback path this task uses. The confusion is real but it
lands one layer down:

| Type | Package | Shape | Where it appears |
| --- | --- | --- | --- |
| `LanguageModelUsage` | `ai@7.0.59` `dist/index.d.ts:320`, **exported** (in the export list at :9320) | **FLAT**: `inputTokens`, `inputTokenDetails.{noCacheTokens,cacheReadTokens,cacheWriteTokens}`, `outputTokens`, `outputTokenDetails.{textTokens,reasoningTokens}`, `totalTokens`, `raw?` — every field `number \| undefined` | `StepResult.usage` (`:1484`), and therefore `onStepEnd` |
| `LanguageModelV4Usage` | `@ai-sdk/provider@4.0.7` `dist/index.d.ts:2573` | **NESTED**: `inputTokens: { total, noCache, cacheRead, cacheWrite }`, `outputTokens: { total, text, reasoning }`, `raw?` — and **no `totalTokens` field at all** | what a `LanguageModelV4` implementation emits in its `finish` stream part |

`streamText`'s `onStepEnd` receives `GenerateTextStepEndEvent`, which is
`StepResult<TOOLS, RUNTIME_CONTEXT>` (`:3872`), whose `usage` is
`LanguageModelUsage` — the **flat** one. So `agent/cost.ts#normalizeSdkUsage`
reads the flat shape, as the plan's Step 2 says.

This is not taken on faith. `agent-gateway.test.ts` emits the **provider**
(nested) shape from a `MockLanguageModelV4` and asserts that what arrives at
`step.usage` is the **flat** shape — `typeof step.usage.inputTokens === "number"`
and `step.usage.inputTokens.total === undefined`. The SDK does the conversion.
The absent `totalTokens` on the provider type is a second, compile-time proof:
adding one to the mock is a `TS2353` type error.

### CONFIRMED: the raw finish reason is structurally available

`LanguageModelV4FinishReason` is the object `{ unified, raw }`
(`@ai-sdk/provider@4.0.7:2536`) as Task 4 recorded. The AI SDK **splits it in
two** before a callback sees it: `StepResult.finishReason` is the unified enum
(`FinishReason`, `ai:124`) and `StepResult.rawFinishReason` is
`string | undefined`. So Anthropic's raw `refusal` stop reason is read
structurally from `rawFinishReason`, with no `providerMetadata` digging — as the
brief hoped, just via a different field than expected.

### The reviewed numbers, and the exact overshoot bound

Price table (nano-USD per token, integers only — invariant 29): uncached input
10,000; 5-minute cache write 12,500; 1-hour cache write 20,000; cache read
1,000; output 50,000. An **unknown model throws `UnknownModelPriceError`** and is
never charged at Fable's rate — including on an unbilled refusal, so an unpriced
model cannot slip through the zero-cost path.

The pre-step guard's conservative byte→token floor is
`CONSERVATIVE_BYTES_PER_TOKEN = 2`. Real traffic runs nearer 3–4 bytes/token, so
this over-estimates by roughly 2x, in the direction that protects the cap.

**Maximum overshoot: zero, while the byte estimate holds.** The guard reserves
the full worst case of every billable Gateway attempt before admitting a step,
so output and attempts contribute nothing to overshoot. The single residual term
is an input under-estimate:

```
overshoot <= gatewayAttempts x max(inputRate, cacheWrite1hRate)
             x max(0, actualInputTokens - ceil(promptBytes / 2))
```

For the pathological all-single-byte-token prompt at 40,000 bytes, that is
`2 x 20,000 x 20,000` = **$0.80**. Both halves are asserted in
`agent-cost.test.ts`.

**Measured evidence is still owed** on the byte ratio: no real Fable prompt has
been tokenized yet. If measurement shows the floor is far from 2, that is a
reviewed change to this constant with the evidence recorded here, per the plan's
"starting values, not sacred numbers" rule.

### Fixed: a third control-byte incident, found by the new guard

The machine guard added this task (`.gitattributes` + `check-text-files.mjs`,
wired into `codemode:dts:check`) failed on its first run against a **real,
pre-existing** occurrence: `apps/worker/src/files/r2.ts:69` contained the raw
bytes `0x00 0x2d 0x1f 0x7f` inside a regex character class. `git grep -I`
confirmed the file was being treated as **binary**, meaning that Phase 09
filename-validation control has been unreviewable in every diff since it landed.
Replaced with the equivalent escaped `/[\x00-\x1f\x7f]/`; behaviour is
unchanged and the file now renders as a normal text diff.

One subtlety worth keeping: in `.gitattributes`, `text` alone does **not** fix
this. `text` controls end-of-line normalization; the attribute that overrides
git's NUL-byte binary auto-detection for diffs is `diff`. Both are set. Getting
this wrong is likely why the problem kept recurring.

### Deferred live proofs added by this task

8. **The Gateway itself.** Create the AI Gateway, issue a `Run`-scoped token,
   set `AI_GATEWAY_ANTHROPIC_URL` and `AI_GATEWAY_TOKEN` as Worker secrets.
9. **`cf-aig-authorization` accepted live.** Resolved on paper above; one real
   provider-native request must confirm a 200 rather than a 401.
10. **Prompt-cache proof.** Per the plan: run a second turn with the stable
    prefix unchanged and assert `cacheReadTokens > 0` in both local telemetry
    and the AI Gateway log, recording both requests' token classes and cost
    here. Nothing in this task claims caching works because a header was set.
11. **Byte-per-token ratio.** Measure real prompts against
    `CONSERVATIVE_BYTES_PER_TOKEN`.
12. **Billing cross-check.** A crash after provider billing but before the local
    step checkpoint still undercounts; the AI Gateway log remains the external
    reconciliation source for a final cost report (invariant 32).

---

## Task 9 — agent-side memory

### What was verified, and how

**The Zep docs MCP was REACHABLE** (`mcp__zep-docs__search_documentation`,
2026-08-13) and was checked before `MemoryStore` changed, as the plan's Step 2
requires. Everything below is confirmed twice — against the MCP and against the
installed `@getzep/zep-cloud@3.27.0` declarations — except where noted:

- `graph.add(request, requestOptions?)`. The complete `AddDataRequest` body is
  `data`, `type`, `createdAt?`, `graphId?`, `metadata?`, `sourceDescription?`,
  `strictOntology?`, `userId?`.
- **There is no client-supplied episode id, uuid, or idempotency key**, in the
  types or in the REST reference. The only caller-influenced UUID anywhere is
  the separate Batch API's `source_uuid`, which `graph.add` does not have. This
  is the fact the whole claim protocol is designed around; it was NOT invented.
- `metadata`: "Max 10 keys. Values must be strings, numbers, booleans, or
  arrays of scalars." Empty arrays and arrays containing null are rejected, and
  nested objects are unsupported. Enforced locally by `boundedMetadata`.
- `sourceDescription`: the REST reference carries an explicit `<=500 characters`
  constraint that **Fern drops from the generated TypeScript**, so the compiler
  will not catch a violation. Enforced locally by `boundedSourceDescription`.
- The returned episode's id field is `uuid` (required), not `uuid_`.
- `RequestOptions` accepts `timeoutInSeconds`, `maxRetries`, `abortSignal`,
  `headers`, and **`maxRetries` defaults to 2**. That default is a silent
  duplicate-episode source on a non-idempotent call, so `addEpisode` passes
  `maxRetries: 0` and lets the durable outbox own retrying.

### The duplicate window, stated exactly

D1 is exact: one outbox row per `(run, generation)`, one recorded episode uuid,
one set of source rows. **Zep delivery is at-least-once and may contain a
physical duplicate.** The window is:

> between `graph.add` returning and the fenced `recordEpisodeUuid` committing.

A crash there leaves a real episode in Zep that D1 has no record of; the lease
expires, a later claim finds no uuid, and the episode is added again. The same
applies when a claimant's lease expires while its request hangs and the
abandoned call later resolves. This is **not** exactly-once projection and is
not described as such anywhere in the code.

It is narrowed, not closed, by two deliberate choices: `maxRetries: 0` on the
vendor call, and recording the uuid as its own fenced write BEFORE the source
resolution, so a claim that finds a uuid resumes instead of re-adding.

### Deferred live proofs added by this task

All **NOT RUN** — no network call, no deploy, no live Zep request, and no spend
was involved in Task 9, by explicit operator decision. Nothing below is implied
by any automated test: the Zep client is faked at the `MemoryStore` seam
throughout, and a fake cannot fail to extract, cannot lag, and cannot duplicate.

13. **A real agent episode is ingested and becomes searchable.** Project one
    settled generation to a scratch graph and confirm extraction actually
    happens — `graph.add` returning an episode does **not** mean the fact is
    searchable, and Phase 06 measured roughly 5.5 minutes of lag.

    ```ts
    // scratch-zep-agent-episode.ts — DO NOT COMMIT
    import { ZepClient } from "@getzep/zep-cloud";
    const zep = new ZepClient({ apiKey: process.env.ZEP_API_KEY! });
    const graphId = `scratch-agent-${Date.now()}`;
    await zep.graph.create({ graphId, name: graphId });

    const episode = {
      asked: "why are PulseFit exports empty",
      actions: ["slack.thread", "supabase.query", "linear.createIssue"],
      draft: "the 04:12 deploy dropped the export worker; issue FF-123 filed",
      outcome: "completed",
      run_id: "run_scratch",
      agent_turn_id: "agent:gen_scratch",
    };
    const added = await zep.graph.add(
      {
        graphId,
        type: "json",
        data: JSON.stringify(episode),
        metadata: { source: "firefighter_agent", outcome: "completed" },
        sourceDescription: "Firefighter agent turn (completed).",
      },
      { timeoutInSeconds: 20, maxRetries: 0 },
    );
    console.log("uuid", added.uuid, "processed", added.processed);

    // Poll for extraction rather than asserting immediately.
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 30_000));
      const res = await zep.graph.search({ graphId, query: "export worker", scope: "edges" });
      console.log(i, (res.edges ?? []).length);
      if ((res.edges ?? []).length > 0) break;
    }
    ```

    **PASS:** `added.uuid` is a non-empty string; within 10 minutes at least one
    edge is returned whose `fact` refers to the export worker / the deploy, and
    whose `episodes` array contains `added.uuid`.
    **FAIL:** the call is rejected (recheck `metadata`/`sourceDescription`
    bounds), or no edge appears within 10 minutes — in which case the episode
    body is too terse or too structured for extraction and `EPISODE_LIMITS`
    needs revisiting. Record the observed latency here either way.

14. **Metadata and `sourceDescription` limits are enforced by the SERVER as
    documented.** The 10-key limit is in the TypeScript docstring; the
    500-character `sourceDescription` limit is **not in the types at all**, so
    only a live call can confirm it.

    ```ts
    // Eleven keys, and a 501-character description. Both should be rejected.
    await zep.graph.add({ graphId, type: "json", data: "{}",
      metadata: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, i])) });
    await zep.graph.add({ graphId, type: "json", data: "{}",
      sourceDescription: "x".repeat(501) });
    ```

    **PASS:** both raise `BadRequestError` (400). **FAIL:** either is accepted —
    which means our local bound is stricter than the server and can be relaxed,
    or the server silently truncates, which we would want to know before relying
    on a description being complete.

15. **A recall on a real graph resolves to a real permalink end to end.** The
    provenance chain — `memory.recall` → registered episode uuid →
    `zep_episodes` / `memory_episode_sources` → `messages.permalink` — is proven
    locally against seeded D1 rows, but never against uuids Zep itself minted.

    Run one real message projection and one real agent projection into the same
    graph, then call `memory.recall` followed by `memory.cite` through a Chat
    run. **PASS:** every returned citation's permalink opens the Slack message
    the fact came from. **FAIL:** any citation is returned with a permalink that
    404s, or a fact that was clearly derived from an ingested message returns no
    citation at all (the second is safe but means provenance is not being
    registered on the live path).

16. **The one-minute Cron Trigger actually fires in production.** `triggers.crons`
    is local configuration; no deployment has been made. After deploying, confirm
    with `npx wrangler deployments list` that the trigger is attached, then watch
    two consecutive minutes of `scheduled()` invocations in the Worker logs.
    **PASS:** an invocation per minute, each completing without error, and a row
    left `pending` by a deliberately failed queue send reaches `projected`
    within two minutes with no alarm involvement. **FAIL:** no scheduled
    invocations appear — the recovery backstop does not exist and DLQ'd
    projections are unrecoverable.

## Task 10 — wiring both surfaces to one loop

### The first deploy under this wiring will kill runs, and how they come back

Wiring `productionRunPorts` up changed what an unconfigured deployment does with
model work. It used to PARK (`continuation: null`): the generation stayed
`scheduled`, and the first alarm after the Gateway existed picked it up. It now
COMPOSES and FAILS, because plan lines 965-966 require absence to fail and a
dashboard full of `live` runs with `error: null` is not a failure anybody sees.

That failure is terminal and `requires_operator_config`, which is deliberately
**not** input-resumable (`INPUT_RESUMABLE_POLICIES`). So between the first
deploy of this commit and the operator step still open above ("DEFERRED OPERATOR
STEP: the Gateway does not exist yet"), **every run claimed is failed with
`missing_gateway_url`, and no customer message and no human steer will revive
it.** That is intended. What is *not* intended — and what
`resumeAfterOperatorConfig` fixes — is that it used to stay dead even after the
operator did the thing the error code asked for.

**What an on-call person needs to know:**

- The reset is automatic once the configuration lands. Supplying
  `ANTHROPIC_API_KEY`, `AI_GATEWAY_ANTHROPIC_URL` and `AI_GATEWAY_TOKEN` as
  Worker secrets redeploys the Worker, every RunDO is reconstructed, and
  `RunDO`'s constructor allocates a fresh generation for the input the dead one
  was holding. No D1 edit, no backfill tool, no support ticket.
- It is a CONSTRUCTION-time reset, not a timer. A run comes back the first time
  anything touches its object after the deploy: a customer message, a Slack
  event, or a dashboard read of that run (`GET /api/runs/:id` resolves the
  stub). A run nobody ever touches again stays failed — which is exactly the
  reach the old parking behaviour had, since a parked run armed no alarm either.
  If a sweep is ever wanted, it is a new operator tool, not a cadence.
- It only undoes ABSENCE. `ABSENT_MODEL_CONFIGURATION_CODES` is the whole list:
  `missing_anthropic_key`, `missing_gateway_url`, `missing_gateway_token`. A run
  spend ceiling (`cost_limit`) carries the same `requires_operator_config`
  policy and is **not** revived by this — raising a cap is still a deliberate
  act. Neither is `invalid_gateway_url`: the value was present and wrong, a
  presence check cannot tell it got better, and reviving on it would re-fail on
  every wake.
- Nothing is re-billed. `createProductionModelFactory` throws before any
  provider request, before `makeAgentTools` and before a single token, so a
  config-killed generation holds no usage rows and no effects. The dead
  generation stays terminal (it already froze its episode and enqueued its
  memory-outbox job); a FRESH generation answers the still-pending input.
- The operator-facing reason code never changes and never carries a value.
  `driver.error` reads `missing_gateway_url`; `/api/health` and every run
  snapshot carry `model.status` and `model.missingConfiguration` — setting
  NAMES only (invariant 39).

### The test pool cannot spend money ON THE MODEL, and the reason is not `AGENT_MODEL_DISABLED`

> **Scope, added by the final-review fixes.** This section is about the MODEL
> path and nothing else. When it was written, the non-model vendors — Linear,
> Supabase, LangSmith, Better Stack — were isolated from this pool only by
> convention. They are configuration now; see "The non-model vendors are
> configuration too" below.

`AGENT_MODEL_DISABLED: "true"` in `vitest.config.ts` only stops ports composed
from the POOL env from installing a continuation. Any test may install the
production continuation from an env it built itself — key-scoped or GLOBAL — and
several in `agent-ports.test.ts` and `run-telemetry.test.ts` do; the continuation
still resolves its env at call time from the Durable Object, so the flag does
nothing for them. Deliberately stated as a mechanism and not as a count of call
sites: the count goes stale the next time somebody adds a case, and it has
already done so once. The guarantee is instead
`AI_GATEWAY_ANTHROPIC_URL: ""` and `AI_GATEWAY_TOKEN: ""`, bound in the same
miniflare block: a binding overrides `.dev.vars`, so composition refuses before
`createAnthropic` even when a developer machine later fills the Gateway settings
in locally. Pinned by `agent-ports.test.ts` > "binds the pool's Gateway settings
empty", which asserts `""` rather than falsiness so deleting either line fails
the suite.

---

## Task 11 — the failure, recovery, concurrency and security matrix

Same operator constraint as every task before it: **local + automated only.** No
Anthropic call, no AI Gateway call, no deploy, no remote D1 migration, no spend.
`wrangler deploy --dry-run` was run as a build check and is not a deploy.

### A defect the matrix found: a provider timeout was reported as a cancellation

`streamText()` is handed both this loop's steering `AbortSignal` and the reviewed
`timeout` policy. When a `firstChunkMs` / `chunkMs` / `stepMs` timer fires, the
SDK aborts its **own** combined signal and delivers an `abort` stream part — at
the `consumeStream` seam that is byte-for-byte what a human steer looks like. The
loop read "abort, with nothing pending" as `run_cancelled`, which is a **visible
terminal** outcome, so:

- an operator was told a human cancelled a run that had in fact timed out; and
- the run did **not** get the bounded retry the plan's failure matrix requires
  for the timeout row.

`agent-loop.test.ts` did not catch it because its timeout case throws an error
whose *message* contains "timed out" — that reaches `classifyThrown`, a different
path from the one a real SDK timer takes.

Fixed in `agent/loop.ts` by asking the one question that separates the two: this
loop's own controller. A steer (and the external signal, which is forwarded into
the same controller) always leaves `steering.signal.aborted === true`; an abort
arriving with it `false` can only be a configured timeout. Pinned by
`agent-failure-matrix.test.ts` > "gives up on a provider that never sends a first
chunk" and "gives up on a stream that stalls after its first chunk", which drive
the SDK's real timers with wall-clock delays (the injected `StreamClock` cannot
move a `setTimeout` inside `ai@7.0.59`).

### Step 8 mutation review — one real gap, found and closed

Ten mutations, each applied, run against the focused suite, and reverted. Nine
failed a test as required. **One did not:**

> **`disableParallelToolUse: true` → `false` left the ENTIRE suite green** —
> 68 files / 1296 passed / 2 skipped / 0 failed with the mutation in place.

Invariant 6 was therefore configuration nobody read. That matters more than a
missing assertion usually does: the plan's own reference-repo survey records
`AI_MissingToolResultsError` in `rtpa25/self-syncing-agent` as a **measured**
consequence of allowing parallel outer calls, not a hypothetical one.

Closed by `agent-prompt.test.ts` > "the reviewed Anthropic provider options",
which pins all four values by equality and then asserts the loop sends exactly
that object on every provider invocation. The mutation now fails.

A second, narrower finding from mutation 10: `slack.reply` refuses through **two
independent gates** — `codemode/bindings/slack.ts#assertMayReply` (no resolved
actor) and `slack/gateway.ts#reply` (the Phase 12 placeholder). Removing only the
gateway one leaves `agent-composer.test.ts` and `agent-surface-parity.test.ts`
green, because the binding gate still refuses; six tests fail once both are
removed. Defence in depth, working as intended, but worth knowing that the
composer-level tests are not by themselves a guard on the gateway.

### Step 9 — NOT RUN, and why

**Step 9 (the minimum Fable behavior acceptance set) was NOT RUN.** It requires
live model calls against the reviewed prompt, which the operator decision for
this implementation run forbids. Nothing in this task's evidence stands in for
it, and no test here should be read as behavioural acceptance: every provider in
these suites is a `MockLanguageModelV4` reading a script this repository wrote,
and a scripted model cannot fail to answer directly, cannot produce an AI tell,
and cannot ask a bad follow-up question.

**Runnable command shape** (throwaway script, never committed; reads
`ANTHROPIC_API_KEY`, `AI_GATEWAY_ANTHROPIC_URL` and `AI_GATEWAY_TOKEN` from the
environment, never printed — and deferred proof #8 above must be done first,
because the composer fails closed without a Gateway):

```ts
// scratch-fable-acceptance.ts — DO NOT COMMIT
import { streamText } from "ai";
import { createProductionModelFactory } from "./src/agent/model";
import { buildAgentPrompt, ANTHROPIC_PROVIDER_OPTIONS } from "./src/agent/prompt";
import { modelCallOptions } from "./src/agent/model";

const handle = createProductionModelFactory(process.env as never)({
  runId: "run_acceptance", generationId: "gen:acceptance", attempt: 1, surface: "chat",
});

// Case A — a how-to question. Answer directly, with evidence, no AI tells.
// Case B — a large request. Ask useful follow-ups; surface value, blocking and
//          customer weight; promise no date.
for (const ask of [
  "how do I re-run a failed export for one customer without touching the others?",
  "can you rebuild the whole export pipeline so it never drops a job again?",
]) {
  const prompt = buildAgentPrompt({ context: /* a real TrustedContext */ null as never, messages: [
    { role: "user", content: [{ type: "text", text: ask }] },
  ] });
  const result = streamText({
    model: handle.model,
    instructions: prompt.instructions,
    messages: prompt.messages,
    tools: { run_code: /* the real one-tool map, against SAFE FAKE capabilities */ null as never },
    providerOptions: ANTHROPIC_PROVIDER_OPTIONS,
    ...modelCallOptions(),
  });
  for await (const part of result.stream) void part;
  console.log(await result.text);
}
```

**What a future operator must check, per case:**

| Case | PASS | FAIL |
| --- | --- | --- |
| A — how-to question | Answers the question in the first sentence. Names the concrete evidence it used (a log line, a row, a thread), not "I looked into it". No opening pleasantry ("Great question!"), no closing paragraph restating the answer, no "As an AI". Reads as though the on-duty engineer typed it. | Any AI tell; a preamble; an answer that restates the question; a claim with no named evidence; an answer that is a plan to answer. |
| B — large request | Asks follow-up questions that a reader can see the point of. States platform value, what it is blocking, and customer weight, with the evidence for each. Says explicitly that it will not commit to a date. | Any date, "by end of week", or "soon". A confident single answer with no clarification. Value/blocking/customer-weight judgment omitted or asserted with no evidence. |

Capabilities must be **safe fakes** for this run — the point is the model's
judgment, not a live write. Store only scores and safe excerpts here; no customer
content and no raw transcript. Phase 21 expands this into the full evaluation
harness.

### Honest gaps left by this task

1. **Step 9 is not run** (above). Fable behavioural acceptance remains unproven.
2. **The canary sweep proves less than "the host holds every credential and
   leaks none of them".** `agent-canaries.test.ts` injects a synthetic
   credential into every host env field and sweeps the model call, the RunEvent
   stream, the turns, the transcript, `agent_model_calls`, the D1 `runs` row,
   the frozen episode, its source mapping and all five console levels. But the
   harness injects BOTH `dependencies` and `modelFactory`, and those two are the
   only readers of the eleven canaries in production: `agent/dependencies.ts:170`
   reads `LINEAR_API_KEY`, `:195` reads `BETTERSTACK_SQL_PASSWORD`, and
   `makeCapabilityDependencies` as a whole is bypassed, as is
   `createProductionModelFactory`. **In that run no production code reads any of
   the eleven canaries at all.** What the sweep genuinely proves is narrower and
   still worth having: nothing in the non-faked composition — prompt assembly,
   the Gateway metadata document, the event stream, the D1 telemetry rows, the
   memory episode, the logs — copies an arbitrary env field into its output. It
   is a regression guard against a new sink learning to read `env`, not evidence
   that a credential-holding adapter keeps its credential. It also does **not**
   exercise the real Slack/Zep/Linear/Supabase/LangSmith/Better Stack HTTP
   adapters, so a real adapter echoing its own credential into an error string
   would not fail there. That half is covered by `agent-composer.test.ts` >
   "reaches no credential by walking the whole dependency object graph" and
   `codemode-security.test.ts` > "exposes no credential, binding or host env to
   model code" — but neither is a live-response test, and no live response has
   ever been observed.
3. **`gatewayHeaders` validates identifier SHAPE, not secrecy.** `OPAQUE_ID` is
   `[A-Za-z0-9:_.-]{1,128}`, which most credential formats satisfy. The metadata
   document is safe because the composer never reads a credential into it, not
   because the validator would catch one. Written into the test rather than
   asserted away.
4. **Crash window 3 is simulated by lease expiry, not by a killed process** —
   which is how windows 1, 2 and 4 are simulated too, so it is a property of the
   pool rather than a hole in this row. `agent-failure-matrix.test.ts` >
   "reclaims the parked step, re-runs it whole, and files the issue exactly
   once" parks the first attempt's provider stream inside the `run_code`
   argument with the harness's `holdAfterToolInput` — the program is on the
   wire, the tool has not been called, nothing about the step exists durably —
   then advances the clock past the 150-second lease and lets a second alarm
   delivery reclaim. Both attempts are the real loop against the real isolate.
   The observed recovery result: the lost attempt reports `aborted_stale_claim`
   and settles nothing, one generation and one stable agent turn id survive, the
   successor re-runs the whole step, `linear.createIssue` reaches the vendor
   exactly once, and the transcript holds one tool message with no trace of the
   lost attempt. The cost of the window is the lost attempt's provider call,
   which is billed unfenced — three usage rows for two logical steps. What is
   still NOT observed is a process actually dying mid-`await`; the vitest pool
   cannot do that, and no test in this repository claims otherwise.
5. **The two timeout cases use wall-clock delays.** 1,500 ms of real time against
   an injected 50 ms limit. That is a 30x margin, not a synchronized clock; on a
   catastrophically loaded machine they could in principle race. They are the
   only tests in these suites that are not driven by the injected `FakeClock`,
   because the SDK's timers are its own `setTimeout` calls.
6. ~~An unknown tool name is refused, but the path is not pinned.~~ **Closed,
   and it stopped being SDK-internal.** The thrown half of the same matrix row —
   the registered tool's own host prologue dying, in `codemode/tool.ts`'s
   unguarded window before either `try` — turned out to be a real defect: the
   SDK answers an `execute` throw with a synthetic
   `{ type: "error-text", value: <raw thrown message> }` tool result, the loop
   ignored `tool-error` entirely, `normalizeResponseMessages` stored the
   synthetic result, and the model answered on top of it and reached
   `completed`. `agent/loop.ts`'s `onStepEnd` now refuses a step whose
   `tool-error` came from a THROW, AFTER the response allowlist so an
   unregistered tool name keeps its precise `malformed_response:unsupported_tool`
   diagnosis and its `requires_input` settlement. Both halves are pinned:
   `agent-failure-matrix.test.ts` > "fails the step rather than fabricating a
   result for an unknown tool" and > "retries the generation rather than letting
   the model answer over the failure".

   The refusal was first written to catch ANY `tool-error`, which was too broad
   — see gap 7.

   What remains open, and it is smaller: `withOuterToolEvents` writes the outer
   `run_code` `started` event but has no `catch`, so a thrown `execute` leaves
   that tool-call event in `running` forever. The generation itself is settled
   correctly and the retry writes its own lifecycle, but a dashboard replaying
   the failed attempt's events sees a call that never ends. Not fixed here
   because the fix belongs with the outer-event mapper rather than the loop.
7. **The over-long-program check exists twice, and only the outer one runs.**
   `codemode/tool.ts:168` caps `code` at `input.limits.maxCodeChars` in the zod
   input schema; `codemode/executor.ts:200-205` caps it again against the same
   `limits.maxCodeChars` and returns a `CapabilityError("invalid_input", …)` as
   a VALUE. The schema fires first, at the AI SDK layer, so the executor's branch
   is unreachable through the outer tool and its intended error-as-value never
   runs.

   The two are now BEHAVIOURALLY consistent even though the code is still
   duplicated. `agent/loop.ts`'s `onStepEnd` recognises the SDK's
   `InvalidToolInputError` / `NoSuchToolError` on the `invalid: true` `tool-call`
   part and replaces the SDK's synthetic result with a host-authored
   `CodeModeOutput` — `result: null`, `error` in the tool's documented
   `code: message` wire format, carried as `error-json` so Anthropic receives it
   with `is_error: true` — so the model reads a schema refusal exactly the way it
   reads a capability error and corrects its own call. Pinned by
   `agent-failure-matrix.test.ts` > "lets the model correct its own call instead
   of retrying the generation".

   The duplication is left in place deliberately: the executor cap is the
   defence for any future caller that does not go through the outer tool's
   schema, and deleting it would remove a bound rather than a copy. What is NOT
   consistent is the wording — the executor's message quotes the actual lengths,
   the loop's does not, because the loop is not the owner of `maxCodeChars` and
   importing `PRODUCTION_LIMITS` there would be a second source of truth for a
   number that is injectable.

   One thing this case genuinely does not produce: an outer `tool_call` event.
   The SDK never calls `execute` for a call it refused, so `withOuterToolEvents`
   never runs and no lifecycle is written. That is honest — no tool ran — but it
   means the failure matrix row's "failed tool event" half is satisfied by the
   transcript rather than by the event stream.

---

## Task 12 — the honest Phase 10 exit record

Task 12's ten steps are almost entirely live-infrastructure work: deploy, remote
D1 migration, live AI Gateway inspection, live Zep, live Slack, real Fable calls.
Under the same operator constraint that has governed every task in this phase —
**local + automated only** — **not one of Steps 1 through 10 was run.** No
deploy, no remote migration, no Anthropic call, no Gateway call, no Zep call, no
Slack post, no Cloudflare account state read or changed, no spend.
`wrangler deploy --dry-run` was run as a BUILD check and is not a deploy.

So this task does not claim to have executed Task 12. It produces the exit
record: the deferred steps written so somebody else can run them, the 19-row
test matrix adjudicated row by row against tests that were opened and read, the
ten exit criteria adjudicated bluntly, and the one part of Step 9 that is
genuinely local — the record of AI-suggested APIs that were wrong.

### The final local gate — measured 2026-08-13, not assumed

Every command run in this worktree at HEAD `6ed8caf`, tree clean.

| Command | Started | Result |
| --- | --- | --- |
| `pnpm --filter @workspace/worker test` | 15:55:23 +05:30 | **68 files / 1305 passed / 2 skipped / 0 failed**, 110.14 s, exit 0 |
| `pnpm --filter @workspace/worker codemode:dts:check` | 15:57:31 | exit 0 — "no control bytes in tracked source", "capability declarations are up to date" |
| `pnpm --filter @workspace/worker typecheck` | 15:57:32 | `tsc --noEmit`, exit 0, no output |
| `pnpm typecheck` | 16:02:44 | 3/3 tasks, **0 cached**, 7.048 s, exit 0 |
| `pnpm lint` | 16:02:52 | 2/2 tasks, **0 cached**, 3.936 s, exit 0 |
| `pnpm build` | 16:02:57 | 1/1 task, **0 cached**, 6.758 s, exit 0 |
| `pnpm --filter @workspace/worker exec wrangler deploy --dry-run` | 15:57:40 | built, printed the binding table, "--dry-run: exiting now.", exit 0 |

**The baseline held exactly: 68 / 1305 / 2 / 0**, matching Task 11's final
measurement. Nothing dropped, so there is no line-by-line drop to explain. The
known `codemode-security.test.ts > "omitting globalOutbound reaches the
internet"` flake did not fire.

One honesty note on the last three rows: `pnpm typecheck`, `pnpm lint` and
`pnpm build` were first served entirely from the Turbo cache (`FULL TURBO`,
25 ms each), because the tree is byte-identical to the one Task 11 measured.
They were re-run with `--force` at the timestamps above so the numbers in this
table are measured work, not a cache hit. `pnpm lint` reporting 2 tasks rather
than 3 is pre-existing: the worker package defines no `lint` task.

### Step 9's local half — every AI-suggested API that was wrong, and the source that corrected it

This is the one Step 9 bullet that needs no live call, and it is the most
valuable record this phase produced. Every citation below was **re-resolved
against the installed packages during Task 12**, not copied forward from the
ledger. Installed versions at the time of checking: `ai@7.0.59`,
`@ai-sdk/provider@4.0.7`, `@ai-sdk/anthropic@4.0.37`, `@getzep/zep-cloud@3.27.0`.

| # | The wrong claim, and who made it | What is actually true | The installed source that settled it |
| --- | --- | --- | --- |
| A1 | **A controller instruction told Task 5 that the plan's cost table described the wrong usage type, and that `StepResult.usage` was the nested provider `LanguageModelV4Usage`.** The implementer refused and re-read both declarations; the reviewer independently confirmed. | `StepResult.usage` is the **FLAT** `LanguageModelUsage`. The nested provider type never reaches a callback — the SDK converts it. | `ai/dist/index.d.ts:1395` declares `StepResult`; `:1484` types its `usage` as `LanguageModelUsage`; `:320` shows that type is flat (`inputTokens`, `inputTokenDetails.{noCacheTokens,cacheReadTokens,cacheWriteTokens}`). The nested one is `LanguageModelV4Usage` at `@ai-sdk/provider@4.0.7/dist/index.d.ts:2574`, a different package and a different shape. |
| | **Cost of having complied: every cost row in Phase 10 would have read as a free request.** `normalizeSdkUsage` would have read `usage.inputTokens.total` off a plain number, yielding `undefined → 0` for every token class, on every step, forever. | Pinned so it cannot regress: `apps/worker/test/agent-gateway.test.ts:655` emits the NESTED shape from a `MockLanguageModelV4` and asserts the FLAT shape arrives at `step.usage`; `apps/worker/test/agent-cost.test.ts:501` asserts the adapter reads the flat shape. | |
| A2 | `ResponseMessage` can be imported from `ai`. | It is **declared but not exported**. `agent/transcript.ts` derives it from the exported `PrepareStepFunction` instead of hand-copying the union, so a future change to the union breaks the build rather than drifting silently. | Declared at `ai/dist/index.d.ts:176` (`type ResponseMessage = AssistantModelMessage \| ToolModelMessage`). The export list at `:9320` does **not** contain it — it does export `PrepareStepFunction`, `StepResult` and `LanguageModelUsage`, so the omission is specific, not a bundling artefact. |
| A3 | The provider-level `finishReason` is a string. | It is an **object** `{ unified, raw }`. Good news rather than bad: Anthropic's raw `refusal` stop reason is structurally available, with no `providerMetadata` digging. The AI SDK splits it before a callback sees it — `StepResult.finishReason` is the unified enum and `StepResult.rawFinishReason` is `string \| undefined`. | `@ai-sdk/provider@4.0.7/dist/index.d.ts:2536` declares the object, `unified` constrained to six literals. `ai/dist/index.d.ts:1480` is `readonly rawFinishReason: string \| undefined`. |
| A4 | A throw out of `onStepEnd` will surface to the caller. | **It is completely swallowed.** This was originally established by a reviewer probe; Task 12 found the structural proof, which is stronger. Mitigation in `agent/loop.ts`: record the decided outcome BEFORE throwing and check it after the stream drains. | `ai/dist/index.js:2732-2741` — `notify()` maps every callback through `try { await callback(event) } catch (e) {}`, an **empty catch**. `:9239-9242` is the step-end dispatch that goes through it. |
| A5 | A `prepareStep` throw behaves the same way as an `onStepEnd` throw. | It does **not**. It is not swallowed; it surfaces as a `TextStreamPart` of `type: "error"` carrying the original error, which the loop's `consumeStream` recovers through `classifyThrown`. | `ai/dist/index.js:9671` is the streaming `await prepareStep(...)` inside `streamStep`. A throw out of `streamStep` is enqueued as `{ type: "error", error }` — `:10054-10059` for a subsequent step, `:10092-10105` for the first step. |
| A6 | Two current Cloudflare docs contradict each other on the AI Gateway auth header (`Authorization: Bearer` vs `cf-aig-authorization`). | **They were never in conflict** — they describe two different endpoint families. REST API (`api.cloudflare.com/client/v4/...`) takes `Authorization: Bearer <CF API token>`; provider-native (`gateway.ai.cloudflare.com/v1/...`) takes `cf-aig-authorization`, because on that route `Authorization` already belongs to the upstream provider. **This project routes natively**, so the plan's `cf-aig-authorization` is correct. | Cloudflare's [AI Gateway → Authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/) page (fetched during Task 5). Enforced in code so the header and the endpoint cannot drift apart: `apps/worker/src/agent/gateway.ts:185-199` and `apps/worker/src/agent/model.ts:97-98,133-137`, which refuse a Gateway URL that is not an `https://gateway.ai.cloudflare.com` host. **Still unverified live** — deferred proof #9. |
| A7 | `graph.add` retries are safe. | `@getzep/zep-cloud` defaults to **`maxRetries: 2`**, retrying on 408, 429 and any status `>= 500` — precisely the ambiguous statuses where the upstream write may already have succeeded — on a call that has **no idempotency key**. A silent duplicate-episode source. Set to `0` on the real call path; the durable outbox owns retrying instead. | `apps/worker/node_modules/@getzep/zep-cloud/dist/cjs/core/fetcher/requestWithRetries.js:15` (`const DEFAULT_MAX_RETRIES = 2`) and `:26` (`if ([408, 429].includes(response.status) \|\| response.status >= 500)`). |
| A8 | **A controller instruction told Task 11 that the `tool-error` stream part carries the error object to discriminate on.** The implementer refused and proved otherwise against the installed runtime; the re-reviewer verified and recorded that its own brief had been wrong. | For a call the SDK refused against the tool schema, `tool-error` carries a **STRING**. The deciding error **object** hangs off the `tool-call` part, with `invalid: true`. Only the execute-**throw** path puts a real error object on `tool-error`. | Invalid-call path: `ai/dist/index.js:5818-5823` builds `tool-error` with `error: getErrorMessage4(toolCall.error)`, and `getErrorMessage` is declared `(error: unknown \| undefined): string` at `@ai-sdk/provider@4.0.7/dist/index.d.ts:801`. The object lives on the tool-call part at `ai/dist/index.js:3893-3906`, where `invalid: true` is set at `:3903` — **the only site in the whole bundle**. Throw path: `:3042-3050` puts the real `error` on `tool-error`. |

Two of these eight (A1 and A8) are cases where **an implementer correctly refused
a controller's SDK claim and was right**, and in both cases complying would have
shipped a real defect — a phase-wide zero-cost telemetry bug, and a
misclassification that turned recoverable model self-correction into a burned
retry budget. The `.d.ts` files alone could not have settled A8; both fields are
`unknown` there, and the runtime sources are the evidence.

Two more corrections are worth recording even though they are not API drift:

- **`vitest run -- <name>` does not filter in this project** (`npx vitest run
  <path>` does). Every "focused test" claim before Task 5 was really a
  full-suite claim — safer, not weaker, but the framing was wrong.
- **`.gitattributes` needs `diff`, not just `text`.** `text` controls end-of-line
  normalization only; `diff` is what overrides git's NUL-byte binary
  auto-detection. Getting this wrong is why control bytes recurred four times,
  including in `src/files/r2.ts`, a Phase 09 filename-validation regex that had
  been **binary and unreviewable in every diff since it landed**.

### Steps 1-10 — NOT RUN, recorded as deferred proofs 18-27

Continuing the numbering already used in this file (#1-#7 Task 0, #8-#12 Task 5,
#13-#16 Task 9, #17 Task 11 — see the reconciliation below). Every entry names
its prerequisites, a runnable command shape, and a PASS/FAIL rubric precise
enough to execute. **No secret VALUE appears anywhere below — names only.**

#### 18. Apply the schema safely (Step 1)

**NOT RUN.** Reason: applying a remote D1 migration mutates account state and is
forbidden by the operator decision for this run.

**Prerequisites:** Cloudflare account authorization; `0006_agent_loop.sql`
unchanged since review.

```
# 1. local first
pnpm --filter @workspace/worker exec wrangler d1 migrations list  <DB_NAME> --local
pnpm --filter @workspace/worker exec wrangler d1 migrations apply <DB_NAME> --local
# 2. inspect what is PENDING remotely before touching it
pnpm --filter @workspace/worker exec wrangler d1 migrations list  <DB_NAME> --remote
# 3. export the tables 0006 touches, if the current workflow supports it
pnpm --filter @workspace/worker exec wrangler d1 export <DB_NAME> --remote --output ./pre-0006.sql
# 4. only then
pnpm --filter @workspace/worker exec wrangler d1 migrations apply <DB_NAME> --remote
```

**PASS:** step 2 lists `0006_agent_loop.sql` and nothing numbered above it; step
4 applies exactly that one file; a follow-up `list --remote` shows zero pending.
The `runs` repair statement in 0006 (bulk `UPDATE runs SET status='idle' WHERE
status='live'`) leaves no run stuck `live`.
**FAIL:** any already-applied migration is re-listed as pending (means the
tracking table disagrees with the files — **stop**, do not force); any CHECK
constraint violation; any migration number above 0006 appears, which would mean
Phase 11 work leaked into this deploy.
**Never** reuse or edit an applied migration number, and nothing from Phase 11
(`0007_approvals.sql`, `escalate`, `withdraw`) may be present.

#### 19. Configure secrets/pins and Gateway privacy (Step 2)

**NOT RUN.** Reason: reading and writing Worker secrets and Gateway settings is
account state.

**Prerequisite: deferred proof #8 — the AI Gateway does not exist yet.** There
is still **no AI Gateway configured anywhere in this repository**, which Task 0
established by grep and Task 5 confirmed. #19 cannot start before #8 is done.

Verify **by name only**, never printing a value:

```
pnpm --filter @workspace/worker exec wrangler secret list
```

| What to confirm | PASS | FAIL |
| --- | --- | --- |
| Anthropic key present | `ANTHROPIC_API_KEY` appears in the name list | absent |
| Gateway URL/auth present | `AI_GATEWAY_ANTHROPIC_URL` and `AI_GATEWAY_TOKEN` appear | either absent — the composer fails closed with `missing_gateway_url` / `missing_gateway_token` and every run dies `requires_operator_config` |
| Payload logging disabled per request | the Gateway dashboard shows log payload collection OFF, **and** the per-request header wins regardless: `cf-aig-collect-log-payload: "false"` is sent on every call | any entry in #23 carrying a request or response body |
| Metadata logs retained | Gateway entries exist and carry token/model/status/cost/duration | no entries at all — then #23 cannot be checked |
| Model exactly `claude-fable-5` | the Gateway log's model field reads `claude-fable-5` on every entry | any other model id, or a fallback id |
| Gateway max attempts matches code | dashboard/entry retry count agrees with `cf-aig-max-attempts: "2"` | a dashboard default silently replacing the reviewed policy |
| No fallback configured | the Gateway has no fallback/universal-endpoint provider chain | any configured fallback — invariant: a refusal must be a visible failure, never a quiet second model |

The header values above are not aspirational; they are pinned by
`apps/worker/test/agent-gateway.test.ts:114` as an exact map.

#### 20. Deploy and run the real Tier 1 smoke again (Step 3)

**NOT RUN.** Prerequisites: #18, #19.

```
pnpm --filter @workspace/worker exec wrangler deploy
# then, through the deployed Worker behind Access, start a run whose program
# performs a bounded multi-capability read and one direct network attempt.
```

**PASS:** `run_code` executes a bounded multi-capability read and returns; a
direct `fetch` from inside the isolate fails in the **loaded** Worker (not only
under the vitest pool); and the deployed CPU-runaway probe terminates a
`while (true) {}` program at the configured `cpuMs`.
**FAIL:** any direct network egress succeeds; or the runaway program is not
killed by `workerd` itself — that is Phase 09's inherited open item (**deferred
proof #7**), still unclosed, and Phase 10 must not assume `limits.cpuMs` stops a
model-authored runaway in production.

#### 21. A real Chat-origin loop (Step 4)

**NOT RUN.** Prerequisites: #18-#20, and #1 (Fable access on the account has
never been proven).

Start with `POST /api/runs` carrying `firstMessage`; attach two WebSocket
clients to **`/ws/run/:id`** (the route is `src/api/runs.ts:212`, mounted at
`src/index.ts:89` — outside `/api` because it is not JSON, and behind the same
Cloudflare Access application as the dashboard), one from seq 0 and one from a
mid-stream cursor; disconnect one and reconnect it with `?since=`.

**PASS, all six:** assistant/tool updates stream to both clients; `run_code`
executes; transcript and usage are checkpointed (`model_messages`,
`model_step_usage`, and an `agent_model_calls` row in D1); exactly one final
Chat answer settles; the reconnecting client resumes with no gap and no
duplicate across a hibernation; exactly one `memory_outbox` projection row
exists for the generation.
**FAIL:** two final turns; a gap or a duplicate frame on reconnect; more than
one outbox row; a `usage` row whose token classes are all zero (that is the A1
failure mode, and it would mean the flat/nested confusion has re-entered).

This is the live counterpart of `apps/worker/test/agent-e2e.test.ts:53` and
`:193`, which prove the same sequence against `MockLanguageModelV4`.

#### 22. Live steering (Step 5)

**NOT RUN.** Prerequisite: #21.

Start a deliberately multi-step read; inject a steer through
`POST /api/runs/:id/turns` (or the WebSocket) **while the first step is still
streaming**; save the full event timeline. Then repeat with the steer arriving
during the final text.

**PASS:** the steer is incorporated in order at the next `prepareStep`, and the
saved timeline shows it; the late steer marks the in-flight draft `superseded`
and produces **exactly one** same-generation continuation.
**FAIL:** a steer is dropped, applied twice, or applied out of order; a late
steer produces a second generation or a second final turn.

Note the automated counterpart is genuinely strong here (`agent-steering.test.ts`
covers all seven plan rows) — what live running adds is a real provider stream,
whose timing the harness cannot reproduce.

#### 23. AI Gateway privacy and cache behaviour (Step 6)

**NOT RUN.** Prerequisites: #8, #19, #21. **This is the single most important
deferred proof in the phase**, because it is the only one that can answer the
plan's own review question "Are Gateway payloads definitely absent, not merely
assumed absent?" — today they are assumed.

Inspect the actual Gateway log entries for the runs from #21.

| Item | PASS | FAIL |
| --- | --- | --- |
| Metadata contains only opaque scalar IDs | exactly the four keys `run`, `generation`, `attempt`, `surface`, all scalars | any customer slug, email, Slack coordinate, prompt fragment or credential-shaped value |
| Payload bodies absent | no request body and no response body on any entry | any prompt or completion text present — **stop and treat as an incident**; Fable's 30-day provider retention is already accepted, Gateway payload retention is not |
| Gateway response caching skipped | entries show cache skipped (this is `cf-aig-skip-cache: "true"`, and is unrelated to Anthropic prompt caching) | any entry served from the Gateway response cache — one customer's answer could reach another |
| Metadata retained | token counts, model, status, cost and duration all present | missing, which would make invariant 32's reconciliation source useless |
| A second stable-prefix turn reports cache-read tokens | see #10 | see #10 |
| D1 usage ≈ Gateway billing | the two agree, or every difference is explained | an unexplained difference — expect and document the known ones: a crash between provider billing and the local checkpoint undercounts locally (see #12), and a reclaimed stale attempt legitimately produces more usage rows than logical steps |

#### 24. `#test-firedrill` Slack-origin safety smoke (Step 7)

**NOT RUN.** Prerequisites: #18-#20. **Use the ungated test channel only.**

Post a triage-shaped message in `#test-firedrill` and let it wake the loop.

**PASS:** the run enters the identical loop/session shape as a Chat run; a
useful internal draft and tool trace stream to the dashboard; a `slack.reply`
attempt stops at **`identity_unavailable`**; **no customer-visible message is
posted by the bot.** Save this evidence for the Phase 12 handoff.
**FAIL:** any bot-posted reply in any channel; a `slack.reply` that succeeds by
falling back to the bot token; or a run shape that differs from Chat's.

`identity_unavailable` is the **correct** Phase 10 result, not a defect. It is
refused through two independent gates —
`apps/worker/src/codemode/bindings/slack.ts#assertMayReply` (no resolved actor)
and `apps/worker/src/slack/gateway.ts#reply` (the Phase 12 placeholder) — and
removing only one leaves the other refusing.

#### 25. Verify memory (Step 8)

**NOT RUN.** Prerequisites: #21, plus a real `ZEP_API_KEY` on the deployed
Worker. Subsumes and supersedes nothing; it is the end-to-end version of #13 and
#15, which remain the narrower component proofs.

After Zep extraction latency (Phase 06 measured roughly 5.5 minutes; poll, do
not assert immediately), recall the completed Chat/test run.

**PASS:** the bounded action/outcome episode exists in the right graph; a
`memory.recall` returns it; every citation `memory.cite` resolves to a **real
stored Slack permalink that opens the message the fact came from**. Record the
observed extraction lag here.
**FAIL:** no episode; a citation whose permalink 404s; or a fact clearly derived
from an ingested message that returns no citation at all (safe, but means
provenance is not being registered on the live path).
**Record the lag; do not write a timing assertion that will flake.**

#### 26. Record measured cost and operational gaps (Step 9)

**PARTIALLY DONE.** The last bullet — "every AI-suggested API that was wrong and
the source used to correct it" — is fully local and is the table above. The rest
needs the live runs from #20-#25 and is **NOT RUN**:

- prompts / steps / token classes / cache hit / cost for each smoke;
- observed first-token and total latency;
- the Gateway-versus-local telemetry discrepancy;
- retry and refusal behaviour actually observed;
- remaining vendor readiness gaps.

**PASS:** every bullet above has a recorded value — a measured number, an
observed behaviour, or an explicit "none observed" — written into this file.
**FAIL:** any bullet left blank, or filled in from expectation rather than from
a run.

Also still owed and cheap once a live prompt exists: **#11, the byte-per-token
ratio.** `CONSERVATIVE_BYTES_PER_TOKEN = 2` has never been measured against a
real Fable prompt, and the densest real input this agent handles (Better Stack
log rows, ClickHouse result sets) lands near 2.0-2.5 B/tok — against the floor,
not comfortably above it. The overshoot is bounded at $0.80 either way, so this
is a number to confirm, not a hole. Store **only scores and safe excerpts** —
never a secret value, never a raw customer prompt body.

The separate behavioural acceptance set (**#17**, the two Fable judgment cases
with their PASS/FAIL table) is recorded above under "Task 11 — Step 9 — NOT RUN,
and why" and is unchanged.

#### 27. The final gate against the deployed revision (Step 10)

**NOT RUN** as a *deployed* gate. The **local** half is done and its exact
numbers and timestamps are in the table at the top of this section.

What is still owed: run the seven commands against the deployed revision's
commit, and save the deployment version, the run IDs from #21-#25, and log
references. **Never save a secret value or a raw customer prompt body here.**

**Run the Turbo-backed three with `--force`** — `pnpm typecheck --force`,
`pnpm lint --force`, `pnpm build --force`. This is not a style preference: at
the deployed commit the tree is typically byte-identical to one already built,
so all three return `FULL TURBO` in about 25 ms and exit 0 **without compiling
anything**. That happened during Task 12's own local gate (see the honesty note
under "The final local gate" above) and would have been recorded as a pass that
measured nothing.

**PASS:** all seven exit 0 at the deployed commit, **and the three cached tasks
were forced — each reports `0 cached` and a real duration, not `FULL TURBO`** —
and the deployment version recorded matches the commit the smokes ran against.
**FAIL:** any command fails; any of the three reports a cache hit, which is a
non-result and must be re-run with `--force`; or the recorded version cannot be
tied to a commit.

### Reconciliation of the deferred-proof list

The list had drifted. Three things were fixed, and nothing was deleted:

1. **#5 and #10 are the same proof.** Both are "run a second turn with the
   stable prefix unchanged and assert `cacheReadTokens > 0`". #10 is the
   stronger statement because it also requires the AI Gateway log half.
   **#5 is superseded by #10.** Run #10.
2. **#6 and #9 are the same proof, written on either side of a resolution.** #6
   was raised in Task 0 while the header name was still ambiguous; Task 5
   resolved the ambiguity on paper (see A6 above) and restated the live check as
   #9. **#6 is superseded by #9.** Run #9.
3. **Task 11's Step 9 was recorded correctly but never numbered**, so it was
   invisible to anyone reading the list. It is now **#17 — the minimum Fable
   behavioural acceptance set**, with its script shape and per-case PASS/FAIL
   table already written above.

Also worth stating so it is not re-raised: Task 10's "DEFERRED OPERATOR STEP:
the Gateway does not exist yet" is **#8**, not a separate item, and Task 10's
dynamic-import concern was **closed**, not deferred — the `--dry-run` build
showed esbuild inlines both modules, so there is no chunk to fail to resolve.

**Count: 27 numbered entries, of which 2 are superseded, leaving 25 live
actions.**

### The consolidated operator runbook — work top to bottom

An operator picking this up should not have to read six task sections. This is
every outstanding live proof in dependency order.

| Order | # | What | Depends on |
| --- | --- | --- | --- |
| 1 | **8** | Create the AI Gateway; issue a `Run`-scoped token; set `AI_GATEWAY_ANTHROPIC_URL` and `AI_GATEWAY_TOKEN` as Worker secrets | — |
| 2 | **1** | `claude-fable-5` is accepted by the actual Anthropic account | key present |
| 3 | **2** | `thinking: adaptive` / `display: "omitted"` behaves as documented — no readable reasoning | #1 |
| 4 | **3** | Raw stop reason and the classified usage/cache fields are actually present on a real response | #1 |
| 5 | **9** | `cf-aig-authorization` is accepted live — a 200, not a 401 | #8 |
| 6 | **19** | Secrets/pins verified by name; Gateway privacy settings; no fallback | #8 |
| 7 | **18** | Apply `0006_agent_loop.sql` remotely, after inspecting pending | — |
| 8 | **20** | Deploy; real Tier 1 smoke; direct network still fails in the loaded Worker | #18, #19 |
| 9 | **7** | Phase 09's deployed CPU-runaway probe (inherited, still open) | #20 |
| 10 | **21** | A real Chat-origin loop, two clients, six required outcomes | #20, #1 |
| 11 | **4 / 4a** | Anthropic itself accepts the replayed omitted-thinking signature | #21 |
| 12 | **22** | Live steering: mid-step, and the late-final `superseded` case | #21 |
| 13 | **10** | Prompt-cache proof — `cacheReadTokens > 0` on the second turn, in both local telemetry and the Gateway log (supersedes #5) | #21 |
| 14 | **23** | Gateway privacy and cache behaviour, inspected on real entries | #21 |
| 15 | **12** | Billing cross-check: D1 usage against Gateway billing, differences explained | #23 |
| 16 | **11** | Measure the byte-per-token ratio against `CONSERVATIVE_BYTES_PER_TOKEN` | #21 |
| 17 | **24** | `#test-firedrill` Slack safety smoke — must stop at `identity_unavailable` | #20 |
| 18 | **13** | A real agent episode is ingested by Zep and becomes searchable; record the lag | live `ZEP_API_KEY` |
| 19 | **14** | Zep enforces the metadata (10 keys) and `sourceDescription` (500 chars) limits server-side | #13 |
| 20 | **15** | A recall on a real graph resolves to a real permalink end to end | #13 |
| 21 | **25** | The end-to-end memory verification for a completed run | #21, #13 |
| 22 | **16** | The one-minute Cron Trigger actually fires in production | #20 |
| 23 | **17** | The minimum Fable behavioural acceptance set (two judgment cases) | #8, #1 |
| 24 | **26** | Record measured cost, latency, telemetry discrepancy, retry/refusal behaviour, vendor gaps | #20-#25 |
| 25 | **27** | The final gate against the deployed revision | all above |

Superseded and not in the table: **#5** (folded into #10), **#6** (folded
into #9).

### The Phase 10 test matrix — all 19 rows

The brief's rule: *the phase is not complete unless each row has an automated or
explicitly live proof.* Every citation below was opened and read during Task 12.
Where a row is partial, what is covered and what is not is stated separately.
Paths are relative to `apps/worker/`.

| # | Area | Required proof | Verdict | Evidence |
| --- | --- | --- | --- | --- |
| 1 | one generic agent | no classifier/handler branch; Chat and Slack shape-equivalence | **PROVEN (automated)** | `test/agent-surface-parity.test.ts:153` produces both traces and compares them after normalizing only origin-specific trusted metadata; `:186` does the same for failure semantics. The file's own header (`:17-36`) states the property: driver/generation transitions, transcript roles, the assistant-update protocol, the tool-update structure and the usage schema must be byte-identical, and origin may change only how the final text is LABELLED. |
| 2 | one tool | model request has only `run_code`; declarations occur once | **PROVEN (automated)** | `test/agent-composer.test.ts:92` (exposes `run_code` and nothing else), `:98` (none of the seven namespaces is an outer tool), `:106` (declarations exactly once, in the tool description); `test/agent-prompt.test.ts:267` (exactly once in the whole model request); `test/agent-e2e.test.ts:127` (one entry through the shipping composition). **Do not cite `test/agent-surface-parity.test.ts:208` for this** — despite its title it filters the calls actually MADE, so it passed with seven extra tools installed under Task 11's mutation 4. |
| 3 | Phase 09 isolation | two executions from one tool instance have isolated counters/cache/audit | **PROVEN (automated)** | `test/codemode-isolation.test.ts:70` (own capability counter), `:88` (per-execution call budget restarts), `:109` (a fact recalled in one execution cannot be cited in another), `:140` (nested capability ids scoped to their outer tool call), `:219` (two concurrent executions of one tool stay independent), `:282` (a customer reference minted in execution A is refused in B). |
| 4 | durable scheduling | commit-before-alarm failure heals; duplicate alarms single-flight | **PROVEN (automated)** | Healing: `test/agent-driver.test.ts:152` (an idempotent duplicate re-arms, healing a lost post-commit schedule), `test/agent-recovery.test.ts:340` (the alarm re-arms for a job the best-effort kick left behind). Single-flight: `test/agent-concurrency.test.ts:34` (one continuation, every input still pending in order), `:96` (exactly one of two concurrent alarms reclaims an expired lease), `test/agent-isolation.test.ts:373` (a duplicated alarm before, during and after the answer changes nothing). |
| 5 | stable side effects | exact canonical key dedupes; changed/in-doubt action pauses/reconciles | **PROVEN (automated)** | Dedupe: `test/codemode-effects.test.ts:102` (replays a completed effect without calling upstream), `:113` (two concurrent identical reservations produce exactly one call), `:187` (a later turn may deliberately repeat the same semantic effect — the key includes the turn), `test/agent-recovery.test.ts:134` (one effect across both attempts of a reclaimed generation). In-doubt — **back in `test/codemode-effects.test.ts`**, not the recovery file: `:145` (`effect_in_doubt` when the outcome cannot be proven), `:163` (reconcile resolves it), `:175` (keeps refusing when reconcile proves nothing). Pause: `test/agent-driver.test.ts:349` (an ordinary message may **not** resume an ambiguous mutation). |
| 6 | transcript recovery | eviction after tool result resumes provider-valid history | **PARTIAL, and weaker than it first reads — the two halves never meet: no test feeds an EVICTED history through the SDK at all (#4/#4a)** | Covered: `test/agent-transcript.test.ts:532` (never splits a tool call from its result), `:558` (never separates a thinking block from its call), `:572` (evicts oldest-first), `:580`/`:594` (protects the unsettled generation, returns `context_limit` rather than truncating it), `:612` (refuses rather than repairing an orphan result), `:632` (never opens on an assistant message), `:732` (evicts a stranded prefix rather than failing the turn), `:348`/`:361` (byte-identical round trip through durable storage), `:373` (continues from the recovered history). **Not covered, and the gap is bigger than the live one:** the required proof is a single sequence — *evict, then resume validly* — and **no test performs it**. Every eviction test above lives in the `bounded history selection` block (`:518-765`) and is a pure `selectModelHistory()` call that never constructs a model; the one SDK-acceptance test, `:373`, feeds `generateText` a **non-evicted** single-step history checkpointed directly, with no selection in the path. The only loop-level test that narrows `historyBounds` at all (`test/agent-failure-matrix.test.ts:455`, `maxBytes: 1`) takes the `context_limit` refusal branch and never reaches the provider. So eviction is proven safe and replay is proven SDK-shaped, as two disjoint halves. On top of that, even `:373`'s "provider-valid" is only the **AI SDK's own prompt standardization against `MockLanguageModelV4`** — a mock cannot reject a signature it never verified. Whether Anthropic accepts a replayed evicted history is deferred proof #4/#4a. |
| 7 | Fable thinking | omitted signature/redacted data private; no reasoning stream | **PARTIAL — automated over fixtures; no live response observed (#2, #3)** | Covered: `test/agent-transcript.test.ts:125` (signature preserved unmodified), `:143` (the `redactedData` variant), `:159` (a step carrying readable reasoning is rejected outright), `:170` (an empty block with no continuation metadata is dropped), `:430` (no reasoning and no signature reaches the RunEvent stream — checkpointing a step emits no event at all); `test/agent-loop.test.ts:313` (the step fails safely when readable thinking arrives). **Not covered:** the fixtures are this repository's model of Fable's shape. No Fable response has ever been seen. |
| 8 | streaming | batched replay, reconnect without gap, final exactly once | **PROVEN (automated)** | Batching: `test/agent-stream.test.ts:54` (not a row per token), `:69` (flushes on the time threshold), `:89` (a 10,000-token stream stays bounded), `test/agent-e2e.test.ts:282`. Reconnect: `test/agent-e2e.test.ts:193` (mid-stream cursor, no gap, no duplicate), `test/agent-isolation.test.ts:411` (from **every** cursor). Final exactly once: `test/agent-loop.test.ts:616` (a redelivered finalization appends no second turn), `test/agent-e2e.test.ts:115`. |
| 9 | steering | two ordered steers next step; late steer supersedes and continues | **PROVEN (automated)** | `test/agent-steering.test.ts:153` (both steers taken exactly once, in RunEvent order, at the next `prepareStep`), `:590` (a steer during the final text supersedes the draft, keeps the generation, and answers once **after** the steer), `:812` (ten steers cost one continuation and arrive in order); `test/agent-loop.test.ts:540`/`:591`. **Stated limit:** rows 2 and 8 cannot distinguish "ordered by sequence" from "ordered by arrival", because the RPC assigns `event_seq` at commit so the two coincide; the underlying guarantee rests on `listPendingInputTurns`' `ORDER BY event_seq ASC` plus the unique index on `source_event_seq`. |
| 10 | concurrency | two runs interleave with no scope, event, usage, or memory leak | **PROVEN (automated)** | `test/agent-isolation.test.ts:58` holds both provider calls open and releases them together so every callback interleaves, then asserts transcript, scope, ids and money stay apart — **including memory** at `:243-289` (each frozen episode carries its own `run_id`, remembers only its own question and only its own actions, projects into a different graph, and names only its own source event). `:292` adds that a steer aimed at one run does not cut the other's stream short. |
| 11 | budgets | time/step/generation spend/run spend all stop before next call | **PARTIAL — three of four stop before the call; the time bound does not, and one field is dead** | Step: `test/agent-loop.test.ts:59`/`:68` (`step_limit` returned **before the provider is invoked**, because `stepCountIs(0)` would never fire), `:93`, `test/agent-failure-matrix.test.ts:393`. Spend, generation and run: `test/agent-cost.test.ts:783`/`:791`/`:803`/`:818` (refuses the step before the call), `:833` (**maximum overshoot is zero** while the byte estimate holds), `test/agent-loop.test.ts:411`. **Time — say this plainly:** there is **no pre-step elapsed-time check in the loop**. `src/run/do.ts:800-805` computes `deadlineAt` and passes it into `continuation.run(...)`, and `src/agent/driver.ts:43` declares it — but **nothing in `src/agent/` reads it**. The wall clock is enforced two other ways: the SDK's own `timeout.totalMs` (`src/agent/model.ts:229`, 8 minutes), and `do.ts:841-855`'s `#withDeadline`, which **abandons** the in-flight continuation rather than stopping it. **First-chunk and inter-chunk** timers ARE proven to fire and be classified correctly (`test/agent-failure-matrix.test.ts:136`, a provider that never sends a first chunk under `firstChunkMs: 50`; `:157`, a stream that stalls after its first chunk under `chunkMs: 50` — both drive the SDK's real timers). `totalMs` and `stepMs` are configured and their ordering is asserted (`src/agent/model.ts:229-230`; `test/agent-gateway.test.ts:485-486`), but **no test drives either of them to fire** — nothing exercises a per-step timeout. |
| 12 | retries | SDK zero, Gateway bounded, driver explicit and idempotent | **PROVEN (automated)** | SDK zero: `test/agent-gateway.test.ts:465`. Gateway bounded: `:142` and `:114` pin `cf-aig-max-attempts`, `-retry-delay`, `-backoff` and `-request-timeout` as an exact map, so a dashboard default cannot replace the reviewed policy. Driver explicit: `test/agent-driver.test.ts:363` (backs off, persists a safe error, re-arms, fails visibly when exhausted), `:433` (bounded by retries, never by how many times work was claimed). Idempotent: `test/agent-recovery.test.ts:134`, `:286` (billed usage from a superseded attempt recorded exactly once). |
| 13 | refusal | HTTP-200 refusal is visible failure, no fallback | **PARTIAL — behaviour proven over a fixture; the HTTP-200 fact is doc-verified, never observed (#1, #3)** | Covered: `test/agent-gateway.test.ts:545` (pre-output — raw refusal surfaced structurally from `rawFinishReason`, usage retained, **cost zero**, and the refusal's terminal handling pinned as constants — `REFUSAL_GENERATION_STATE` is `"refused"` and `REFUSAL_RESUME_POLICY` is `"requires_input"`, i.e. it asserts the state a refusal lands in, not that a fallback-model path was looked for and found absent), `:579` (mid-stream — real usage charged, every partial draft discarded), `:606` (neither refusal completes), `:619` (`REFUSAL_SAFE_MESSAGE`'s own content is safe — it names a human and contains no refusal prose; the constant is what is asserted, not that it reaches the operator), `:624` (a refusal whose raw reason is lost but whose unified reason survives), `:633` (ordinary stop/tool-call/length left alone). **Not covered:** that Anthropic really returns `stop_reason: "refusal"` as HTTP 200 is verified from the Fable 5 launch doc (quoted earlier in this file), not from a response this system received. |
| 14 | telemetry | all token classes/cost/latency/reason stored idempotently | **PARTIAL — every field but latency is asserted** | Covered: `test/agent-cost.test.ts:197` inserts once, reports the replay as `duplicate`, and reads the D1 row back asserting `input_tokens`, `cache_read_tokens`, `cache_write_tokens`, `output_tokens`, `reasoning_tokens`, `total_tokens`, `cost_nano_usd`, `finish_reason` **and** `raw_finish_reason`; `:155`/`:169` (local ledger refuses to double a replayed step, treats a different attempt or step as distinct); `:305` (D1 `UNIQUE`, not only local); `:323` (negative tokens/cost refused); `:230` (no prompt, completion, reasoning or tool-body column exists at all). **Not covered:** `latency_ms` is produced (`src/agent/loop.ts:628`), stored (`src/agent/usage.ts:132`, `migrations/0006_agent_loop.sql:46`) and constrained `>= 0`, but **no test asserts its value** — the readback at `test/agent-cost.test.ts:210-227` omits it. Observed first-token and total latency is live work anyway (#26). |
| 15 | Gateway privacy | metadata-only log, no prompt/completion payload | **PARTIAL — the REQUEST side is proven; what the Gateway RETAINS is not (#23)** | Covered — what we send: `test/agent-gateway.test.ts:114` (the exact reviewed header map), `:127` (payload collection off as the **string** `"false"`, since a boolean could stringify to `"true"` under some serializers), `:135` (response caching skipped), `:152` (at most five scalar metadata values, keys exactly `attempt`/`generation`/`run`/`surface`), `:167` (bounded and byte-stable), `:178` (a customer slug, email, Slack coordinate, prompt or secret is refused as an id), `:202` (the rejected value is not echoed into the error), `:231` (never emits an `authorization` header of any kind); `test/agent-canaries.test.ts:202-243`. **Not covered:** no Gateway log entry has ever been inspected. Two honest limits recorded in Task 11's gaps still stand: `gatewayHeaders` validates identifier **shape**, not secrecy (`OPAQUE_ID` is `[A-Za-z0-9:_.-]{1,128}`, which most credential formats satisfy), and the canary sweep injects both `dependencies` and `modelFactory`, so in that run no production code reads any canary. |
| 16 | cache | real second turn has cache-read tokens | **AWAITS LIVE — no automated proof exists, and none can (#10)** | A cache read is a provider fact; a `MockLanguageModelV4` reports whatever the fixture says. What IS proven is every **precondition**: `test/agent-prompt.test.ts:199` (stable blocks kept separate from the dynamic one so a prefix can be cached), `:214` (the breakpoint is marked on the **last stable block**), `:407` (the stable prefix is byte-identical regardless of what the customer asked); and the pricing that will consume the result, `test/agent-cost.test.ts:588`/`:604`. Nothing here claims caching works because a header was set. |
| 17 | memory | one logical outbox; at-least-once Zep, exact permalink source | **PARTIAL — the D1 half is proven end to end; the Zep half is entirely faked (#13, #14, #15, #25)** | Covered: one logical outbox — `test/agent-memory.test.ts:366` (exactly one episode and one outbox job per completed generation), `:476` (re-finalizing changes and duplicates nothing), `test/agent-isolation.test.ts:397-404`. At-least-once with a named duplicate window — `test/memory-outbox.test.ts:147` (exactly one of two concurrent deliveries calls the vendor), `:186` (an expired claimant's completion is refused), `:216` (resumes from a recorded uuid instead of adding twice), `:264` (warns when a retried claim may have left a duplicate). Exact source — `:387` resolves a recalled episode uuid through `zep_episodes` → `memory_episode_sources` → `permalink` and asserts `cite()` returns it; `:420` cites the evidence a Slack run READ rather than the question it answered; `:509` drops a source that resolves to nothing rather than inventing a link. **Not covered:** the Zep client is faked at the `MemoryStore` seam everywhere, and the permalink in `:387` is a **seeded fixture value** (`https://slack.example/...`). A fake cannot fail to extract, cannot lag, and cannot duplicate. |
| 18 | Slack safety | no actor means no send; bot token never substitutes | **PROVEN (automated); the live channel smoke is #24** | `test/agent-composer.test.ts:223` (`identity_unavailable` on a fully permitted **live** run through the **production** composer), `:238` (**builds no `chat.postMessage` request and never touches the bot token**), `:264` (a shadow run is refused even earlier); `test/agent-surface-parity.test.ts:252`; `test/agent-e2e.test.ts:157` (the shipping composition cannot bypass the host write guard). Defence in depth confirmed by Task 11's mutation 10: removing only `slack/gateway.ts`'s gate leaves the composer tests green because the binding gate still refuses; six tests fail once both are removed. |
| 19 | failures | every error path leaves terminal update and legal driver/run state | **PROVEN (automated)** | `test/agent-loop.test.ts:432` maps **each path to exactly one driver commitment**; `:367` (refusal → refused generation a steer may resume), `:390` (provider stream error → bounded retry), `:403`, `:411` (spend cap stops rather than buying another step); `test/agent-driver.test.ts:268` (failed on terminal refusal, budget or infrastructure outcome), `:305-360` (the resume-policy gate). The matrix rows themselves: `test/agent-failure-matrix.test.ts:66`/`:102` (a provider error after visible text never promotes the draft), `:136`/`:157` (real provider timers), `:181` (unknown tool → no fabricated result), `:237` (a tool that **threw** → the step is refused, not answered over), `:317` (a schema-refused call → model self-correction with a host-authored output), `:393` (still bounded), `:449` (`context_limit` instead of malformed history), `:568` (crash window 3: reclaim, re-run, file the issue exactly once). **One known incompleteness, already recorded as gap 6:** `withOuterToolEvents` has no `catch`, so a thrown `execute` leaves that outer tool-call event `running` forever — the generation settles correctly and the retry writes its own lifecycle, but a dashboard replaying the failed attempt sees a call that never ends. |

**Matrix summary: 12 rows proven by automated tests; 6 partial with the covered
and uncovered halves stated; 1 (cache) awaiting live proof entirely.** No row is
without an automated or explicitly-live proof, which is the brief's bar — but
seven of the nineteen cannot be called finished until the runbook above is
executed.

### The ten exit criteria — adjudicated

Blunt, because several of these are written in terms of live behaviour and
**cannot** honestly be claimed from a local run.

| # | Criterion | Verdict |
| --- | --- | --- |
| 1 | A human-first Chat run automatically wakes **Fable 5**, streams to two clients, executes the real Phase 09 `run_code` isolate, and settles one durable answer | **NOT SATISFIED — harness only.** Everything except the provider is proven: `test/agent-e2e.test.ts:53` runs mock model → `run_code` → **real Tier 1 isolate** → result → final answer; `:193` and `test/agent-isolation.test.ts:411` prove two-cursor replay; `test/agent-loop.test.ts:616` proves one durable answer. **"Fable 5" is not proven at any level** — every provider in this repository is a `MockLanguageModelV4`, no Anthropic call has ever been made, and whether `claude-fable-5` is even enabled on the account is unknown (#1). Awaiting #20, #21. |
| 2 | A triage-woken `#test-firedrill` run enters the identical loop/session shape and safely refuses a customer send; no bot-token fallback | **PARTIALLY SATISFIED — the refusal half is proven, the woken-by-Slack half is not.** Shape equivalence: `test/agent-surface-parity.test.ts:153`. Safe refusal with no bot-token fallback: `test/agent-composer.test.ts:223`, `:238`. **No Slack message has ever woken this loop.** Awaiting #24. |
| 3 | Steering in order before the next step; a steer during final output marks the draft superseded and causes exactly one same-generation continuation | **SATISFIED by automated proof.** `test/agent-steering.test.ts:153`, `:590`, `:812`; `test/agent-loop.test.ts:540`, `:591`. This is the strongest automated area of the phase — all seven plan rows are covered. Live confirmation against a real provider stream is #22, but the criterion as written is met. |
| 4 | Duplicate input, alarms, callbacks, reconnects and a simulated crash do not duplicate a final turn, model-step row, logical memory job or exact canonical effect key; changed/ambiguous effects pause | **SATISFIED by automated proof, with one stated limit.** `test/agent-isolation.test.ts:373`, `:411`, `:447`; `test/agent-concurrency.test.ts:34`, `:96`; `test/agent-loop.test.ts:616`; `test/agent-cost.test.ts:197`, `:305`; `test/codemode-effects.test.ts:145`, `:163`; `test/agent-driver.test.ts:349`. **The limit:** "simulated crash" means an expired lease reclaimed by a later alarm (`test/agent-failure-matrix.test.ts:568`, `test/agent-recovery.test.ts:74`/`:106`/`:134`) — the vitest pool cannot kill a Durable Object mid-`await`, and no test in this repository claims otherwise. |
| 5 | A completed tool exchange can resume from the persisted transcript after object re-entry, with Fable's omitted-thinking opaque metadata unchanged | **SATISFIED IN THE HARNESS ONLY.** Byte-identical round trip proven at `test/agent-transcript.test.ts:348`, `:361`, `:373`. **Whether Anthropic accepts the replayed signature has never been tested** — deferred proof #4/#4a. A mock cannot reject a signature it never verified. |
| 6 | Assistant deltas are replayable and batched; no reasoning is exposed | **SATISFIED by automated proof for the parts this system controls.** `test/agent-stream.test.ts:54`/`:69`/`:89`; `test/agent-e2e.test.ts:193`/`:282`; `test/agent-transcript.test.ts:430`; `test/agent-loop.test.ts:313`. The residual dependency is on Fable honouring `display: "omitted"` (#2) — the host refuses readable reasoning if it ever arrives, so this fails safe rather than leaking. |
| 7 | Model/tool/time/refusal/step/cost failures are visible and recoverable | **MOSTLY SATISFIED; the TIME half is the weakest.** Model, tool, refusal, step and cost are all covered (see matrix rows 11, 13, 19). Time: the SDK's first-chunk and chunk timers are proven to fire and to be classified as `provider_timeout` rather than a cancellation (`test/agent-failure-matrix.test.ts:136`, `:157` — a real defect this phase found and fixed), but there is **no loop-level elapsed-time check**, the driver's `deadlineAt` is **never read by the continuation port** (`src/run/do.ts:800` computes it and passes it in; nothing in `src/agent/` reads it), and the one thing that does read it — `#withDeadline` at `src/run/do.ts:845` — abandons rather than stops. See matrix row 11. |
| 8 | D1 contains per-step token/cost telemetry and a bounded agent memory outbox; **Zep receives the semantic episode with exact citation sources** | **HALF SATISFIED.** The D1 half is proven: `test/agent-cost.test.ts:197`, `:305`, `:230`; `test/agent-memory.test.ts:366`. **The Zep half is not satisfied at all — nothing has ever been sent to Zep.** Awaiting #13, #15, #25. |
| 9 | AI Gateway retains metadata but no request/response payload, and **a real second turn proves prompt-cache reads** | **NOT SATISFIED, and not claimable from a local run.** Neither half. There is **no AI Gateway configured anywhere in this repository** (#8 has never been done), so nothing has been retained or not retained, and no second turn has ever happened. What is proven is only that the request asks for no payload logging and carries opaque ids (matrix row 15), and that the cacheable prefix is correctly placed and stable (matrix row 16). Awaiting #8, #10, #23. |
| 10 | Full worker tests, Code Mode declaration drift check, typecheck, lint and build pass, **plus the documented deployed smoke tests** | **HALF SATISFIED.** The local half is done and measured — all seven commands exit 0, 68 files / 1305 passed / 2 skipped / 0 failed, numbers and timestamps in the table at the top of this section. **No deployed smoke test has been run**, including Phase 09's inherited CPU-runaway probe (#7). Awaiting #20, #24, #27. |

**Score: 3 satisfied by automated proof (3, 4, 6); 3 satisfied in the harness
only or half satisfied (2, 5, 8); 2 mostly satisfied with a named weak half (7,
10); 2 not satisfied (1, 9).**

Preserved from the brief, unchanged and not re-argued: **the old exit "a correct
reply arrives in Slack" is intentionally not a Phase 10 criterion.** It would
either fail honestly at `identity_unavailable` or tempt the implementation to
violate the assignment by speaking as the bot. `slack.reply()` returning
`identity_unavailable` until Phase 12 is **correct**, and is itself a proof for
criterion 2. The real user-token Slack send becomes an integrated Phase 13
criterion, after both approval (Phase 11) and identity (Phase 12) exist.

### What this task did not do

It did not deploy, migrate, call a model, call a Gateway, call Zep, post to
Slack, read or change any Cloudflare account state, or spend anything. It did
not touch `apps/worker/src`. It ran no probe. Nothing from Phase 11 is present.
Every claim above is either a test that was opened and read, a declaration
resolved in an installed package, or an explicit statement that something was
not run.

---

## Final review fixes — closing the whole-branch review

Same operator constraint as every task in this phase: **local + automated
only.** No deploy, no migration, no provider call, no Gateway call, no Zep, no
Slack, no Cloudflare account state read or changed, no spend. Nothing from
Phase 11.

The final broad review returned **approved / ready with follow-ups**: zero
Critical, two Important, four Minor. Five of those six are closed here; the
sixth (`projectPendingUsage`) was deferred deliberately by the review itself and
is untouched.

### I1 — a terminal input-resumable failure with unanswered input had no wake source

**Fixed, not recorded.** The gap was real, and it was observed before it was
argued about.

**The observation.** A scripted `MockLanguageModelV4` returning one
`content-filter` step, with a `human_steer` turn committed from inside the
object's own execution context during that step's first `text-delta` — the
window after the last `prepareStep` and before finalization. Then the alarm was
dispatched repeatedly until `nextAlarmAt` returned null, so the projection jobs
that briefly keep an alarm armed could not be mistaken for a model wake. At
rest:

```text
path: 'provider_refusal'   phase: 'failed'   resumePolicy: 'requires_input'
pendingThroughSeq: 4       settledThroughSeq: 0        alarm: null
```

Turn 4 was durable, visible, above the settled watermark, and owned by nobody.
The same steer sent one millisecond LATER took the `scheduleInput` path,
allocated a generation and was answered — verified in the same probe. Same
input, same run, opposite outcome, decided by a race no customer can see.

**Why it contradicted the plan rather than merely underdelivering.** Plan line
470 says a settled generation plus new input creates a new generation/turn, and
the resume table at line 655 says `requires_input` is woken by "a new trusted
human/customer turn". Both were true of this turn. What denied it was purely
positional: `scheduleInput` saw `running` and joined instead of allocating, and
`nextAlarmAt` (`agent/driver.ts`) pushes a model candidate only for `scheduled`
or `running`.

**The fix**, in the failure branch of `finalizeGeneration` (`run/session.ts`),
inside the SAME transaction that commits the failure: allocate a successor
generation when all three of these hold.

1. the resume policy is input-resumable — so `requires_operator_config` (a
   spend cap, a missing secret) and `requires_reconciliation` are untouched and
   still need their explicit human action;
2. the error code is in `UNSEEN_INPUT_WAKE_CODES` (`agent/contracts.ts`), a
   closed list: `provider_refusal`, `provider_refusal_mid_stream`, `step_limit`,
   `run_cancelled`;
3. `pending_through_seq > generation.included_through_seq` — there is input the
   dead generation never READ, not merely never settled.

**The spin argument, answered.** Waking resets `attempt`/`retry_count` to zero
(`session.ts`), so an unconditional wake on a pending cursor would refuse, wake,
refuse, wake, and bill every lap. Guard 3 is what bounds it, and the bound is
structural rather than a counter: a successor takes the unread input at its
first `prepareStep`, which lifts its included cursor to the pending cursor, so
its own identical failure has nothing left unread to wake a third generation.
Guard 2 covers the failures that can occur BEFORE the included cursor moves at
all — every `malformed_history` code is excluded for exactly that reason, and
because an unusable turn is still unusable next time. `driver_attempts_exhausted`
is excluded because handing a fresh crash budget to a run that just exhausted
one is how a transient outage becomes unbounded spend.

Measured, not asserted: with six refusals scripted and twenty alarm deliveries
allowed, the run makes exactly **two** provider calls and comes to rest at
`failed` / `requires_input` with no alarm armed.

The public status follows the DRIVER, not the generation (`run/do.ts`,
`FINALIZED_STATUS`): a settle that left `scheduled` is `live`, because the run
has work to do.

Three copies of the "allocate a scheduled generation" body — ordinary input, the
operator-config reset, and now this — were collapsed into one
`allocateScheduledGeneration` helper, because the fields it resets (no lease, no
heartbeat, no backoff, no inherited error) are what a fresh attempt MEANS, and
three copies is three chances for one to keep a stale lease.

**Tests.** `agent-steering.test.ts` > "failure wins: a steer the refused
generation never read still gets answered" and > "wakes at most ONE successor
per unread input, however often it refuses" (both through the real continuation
and the real isolate); `agent-state.test.ts` > "wakes a successor for input a
terminally refused generation never read", plus four discrimination cases.
Verified to discriminate in BOTH directions: with `wakesOnUnseenInput` forced to
`false`, three fail; forced to `true` for every code, five fail — including two
pre-existing tests, which is the spin the allow-list exists to prevent.

**What is still open.** `hasPendingInput` (`session.ts`) still has no production
consumer; it is used by `steering.ts` and by tests. It is not the mechanism of
this fix and was left alone.

### The non-model vendors are configuration too (I2)

`vitest.config.ts` neutralised the Gateway pair, `ZEP_API_KEY` and the Slack
pair, and nothing else. `LINEAR_API_KEY`, `SUPABASE_KEY`, `LANGSMITH_API_KEY`,
`BETTERSTACK_SQL_USERNAME`, `BETTERSTACK_SQL_PASSWORD` and
`BETTERSTACK_UPTIME_TOKEN` are all read straight off `env` by
`agent/dependencies.ts`, and `agent-composer.test.ts` builds the REAL adapters
from the POOL env twice — so on a developer machine those closures held live
credentials from `.dev.vars`. Nothing invoked them, so nothing leaked. But there
is no `fetchMock` and no miniflare `outboundService` in this pool, so outbound
network is not sealed at pool level, and the only thing between a future test
and the live Linear workspace (`.dev.vars.example` documents that key as
personal, with access to all five teams including live Development) was the
write-guard policy matrix — an AUTHORIZATION check, which cannot help a READ.

All six are now bound to obviously-synthetic fixtures sharing one `not-a-real-`
prefix, in the same miniflare block. A seventh was added beyond the review's
list: **`ANTHROPIC_API_KEY`**. With `AI_GATEWAY_ANTHROPIC_URL` bound empty,
`makeTriageRunner` (`triage/run.ts`) composes `createAnthropic` and falls
STRAIGHT to `api.anthropic.com`; no test composes it today — every triage suite
injects its own runner — but "no test does" is precisely the convention being
replaced, and it is also what makes the credential-walk pin below
machine-independent. The agent path is unchanged either way: it refuses at
`missing_gateway_url` before a provider exists.

Pinned by `agent-composer.test.ts` > "binds every vendor credential the composer
reads to a synthetic fixture", asserting EQUALITY with each value the way the
Gateway pair is asserted — `toBeTruthy()` would pass on a real key, and a
falsiness check would pass on a binding that had vanished.

No test needed a real-looking value; nothing broke.

### The credential walk had no non-vacuity pin (M2)

`agent-composer.test.ts` > "reaches no credential by walking the whole
dependency object graph" builds its search list from pool env values and filters
to non-empty — correctly, since `value.includes("")` matches everything. But an
empty list also finds no credential, perfectly, forever, and six of the eight
came only from `.dev.vars`. On a fresh clone the walk searched for two and
reported success. `expect(secrets).toHaveLength(8)` now pins it, and with the
I2 bindings in place all eight are present on every machine.

### The control-byte guard permitted two control bytes (M1)

`scripts/check-text-files.mjs` read
`byte < 0x09 || (byte > 0x0d && byte < 0x20)`, which permits vertical tab (0x0b)
and form feed (0x0c), while its own docblock said only tab, LF and CR were
excluded. **The code was changed to match the comment**, as an explicit
`ALLOWED_CONTROL_BYTES` set rather than range arithmetic, because this is the
guard that exists BECAUSE a comment was trusted four times.

Verified by construction, in a throwaway git repository outside this worktree:
files containing a raw 0x0b and a raw 0x0c pass the old predicate (exit 0) and
fail the new one (exit 1, both named). Neither byte triggers git's binary
detection — that keys on NUL — so this was never a hole in the review-hiding
failure mode; it was a hole in what the script CLAIMED to check. The tracked
tree contains neither byte.

It was also manual-only, reachable from `codemode:dts:check` alone, from no
turbo task and no CI (this repository has no `.github` directory). It now runs
in front of the worker suite as well — `"test": "node
scripts/check-text-files.mjs && vitest run"` — which costs ~50 ms over the whole
tracked tree. No CI was added; none exists to add to.

### `stale_generation` in `PROVEN_PRE_UPSTREAM` is a seam, not a live path (M3)

`codemode/effects.ts` justified the entry with "the guard runs immediately
BEFORE the capability body", which is true and is exactly why `runEffect`'s own
check can never observe it: `assertFresh` is called in `withCapabilityAudit`
(`bindings/shared.ts`) before the capability body, and `runEffect` is called
from INSIDE that body. `staleGeneration()` has two throw sites — that guard and
the outer tool's pre-check — and neither is downstream of `performClaimed`.
Task 1 deferred this expecting Task 8 to make the guard live per call; Task 8
made it structural instead, which is stronger.

The comment is retitled as a seam. **The set member is kept**: the
classification is correct, it becomes load-bearing the moment any capability
re-checks freshness inside its own `execute`, and the opposite mistake is the
expensive one — without it a superseded write becomes a permanent `in_doubt`
for a human to clear by hand.

### Not fixed, by the review's own instruction

`projectPendingUsage` (`agent/usage.ts`) remains a second implementation with
one wired owner. `usage.ts` documents it honestly. Untouched.
