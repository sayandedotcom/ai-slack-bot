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
