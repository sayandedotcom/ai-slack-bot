# Phase 13 — Slack Nudge + Real Send — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nobody keeps a tab open to find out the agent is waiting — a phone push lands within seconds of an escalation — and an approved reply finally reaches the customer under the on-duty engineer's own Slack identity, making delivery `sent` reachable and `blocked` extinct.

**Architecture:** Two independent halves sharing one identity source. **Nudge:** the `approval_card` projection completing (Phase 11's hook) triggers a bot-token Block Kit DM to the on-duty engineer, made once-only by a `nudged_at` CAS on the approvals row. **Send:** a `UserTokenSource` (Phase 12's `getDecryptedToken` + `onDuty`) powers both the real `ApprovalSender` and the `slack.reply` identity seam, replacing every `identity_unavailable` refusal.

**Tech Stack:** Slack Web API (`conversations.open`, `chat.postMessage`, `chat.update`), Block Kit, D1.

**Spec:** `docs/superpowers/specs/2026-08-10-firefighter-agent-design.md` §5, §7. Roadmap entry: `00-roadmap.md` Phase 13.

## Global Constraints

All of `00-roadmap.md` "Global Constraints" apply. The ones that bite here:

- **No bot-token fallback for customer messages, ever.** The bot token appears in exactly two places in this phase: the nudge DM to an *engineer*, and `chat.update` of that same DM. A customer-facing send with no user token terminates `blocked` — same as Phase 11.
- **Fail closed.** A channel absent from `channels` is never postable; the sender re-checks nothing Phase 11 already pinned (channel/thread come from the approval row, which the DO minted).
- **No secret values in the repo.** No new secrets; the phase consumes `SLACK_BOT_TOKEN` and Phase 12's `IDENTITY_KEY` by name.
- **Customer-facing copy rules** apply to the outbound text (it is the human-approved draft — send it byte-exact, no decoration).
- **Commit after every task.** Conventional prefixes.

## Depends on

Phase 11 (approvals, `ApprovalSender`, `resolveApproval`, the `approval_card` projection kind, `idx_approvals_*` indexes) and Phase 12 (`onDuty`, `getDecryptedToken`, `identities.external_id` = the engineer's Slack user id). Execute only after both are merged.

## Outcome

- Escalation → `approval_card` projection completes → exactly one Block Kit DM to the on-duty engineer: draft preview, why, a plain URL button to the dashboard. Phone push within seconds.
- If the on-duty engineer has no connected Slack identity (or `NUDGE_MODE=channel`), the nudge is an @-mention in the fallback channel instead — both paths tested, one config var chooses.
- Decision or withdrawal rewrites the DM (best-effort `chat.update`) so no dead link outlives its card.
- `PATCH approve|edit` → the draft posts to the customer thread **as the on-duty engineer** via their user token → delivery `sent` with the real `ts`.
- Model-authorized non-escalated sends (`slack.reply` clarifying questions / status updates) go through the same user token. `identity_unavailable` disappears from the live path.

## What this phase deliberately does not do

- **No interactivity endpoint.** The button is a plain URL button — no Slack action handlers, no signing of interaction payloads.
- **No re-nudge / reminder cadence.** One nudge per approval, full stop (re-nudging is judgment-free spam; revisit only if the drill shows cards rotting).
- **No per-engineer nudge preferences.** On-duty gets the DM; that's the rotation's whole point.
- **No sender retries beyond the Phase 11 state machine.** Ambiguity maps to `in_doubt` for a human, never a second send.

## Non-negotiable invariants

1. **One nudge per approval**, enforced by CAS (`UPDATE approvals SET nudged_at=? WHERE id=? AND nudged_at IS NULL` — proceed only when `changes=1`), not by memory. A crashed worker retrying the projection must not double-DM.
2. **The nudge never blocks the projection.** `approval_card` upsert commits first; a nudge failure is logged state (`nudged_at` stays NULL) retried by the sweeper, never a projection failure.
3. **The send is the human's text byte-exact** — `outboundText(row)`: `edited_text` when edited, else `draft`.
4. **Send outcomes are honest:** definite Slack refusal (`invalid_auth`, `token_revoked`, `channel_not_found`, `not_in_channel`) → `blocked` with the Slack error string as reason; network failure / timeout / unreadable body after the POST was attempted → `in_doubt`. Never map ambiguity to `blocked`.
5. **No token material in logs, errors, ledger entries, or the nudge payload.** The nudge DM contains the draft and why — which the engineer may already read on the dashboard — and nothing else.
6. **`slack.reply` keeps its Phase 09/10 guard rails** (pinned channel/thread, write-guard, effect ledger). Only the credential source changes.

## Public contracts

```ts
// src/identity/user-token.ts  (new home; both consumers import from here)
export type UserToken = { token: string; slackUserId: string; email: string };
export interface UserTokenSource {
  /** The on-duty engineer's decrypted Slack user token, or null when
   *  unconnected. Never throws for "not connected" — null is the honest answer. */
  onDutyToken(nowMs: number): Promise<UserToken | null>;
}
export function makeUserTokenSource(env: Env): UserTokenSource; // onDuty() → getIdentity(email,"slack") → open()

// src/approval/sender.ts (extend Phase 11's file)
export function makeUserTokenSender(source: UserTokenSource, fetchImpl?: typeof fetch): ApprovalSender;
// send(): source.onDutyToken() null → {result:"blocked", reason:"on-duty engineer has not connected Slack"}
//         chat.postMessage(token, channel, thread_ts, text) ok → {result:"sent", ts}
//         Slack ok:false → {result:"blocked", reason:<slack error>}   (definite refusal)
//         thrown fetch / non-JSON → {result:"in_doubt", reason:"send attempted; outcome unknown"}

// src/notify/blocks.ts  (pure builders, no I/O)
export function nudgeBlocks(input: { draft: string; why: string; approvalId: string;
  dashboardUrl: string; channelName: string }): object[]; // draft truncated to 300 chars with marker
export function resolvedBlocks(input: { decision: "approved"|"edited"|"rejected"|"withdrawn";
  decidedBy: string | null }): object[]; // replaces the nudge body; no button

// src/notify/nudge.ts
export async function sendNudge(env: Env, row: ApprovalRow): Promise<"sent"|"skipped"|"failed">;
export async function updateNudge(env: Env, row: ApprovalRow): Promise<void>; // best-effort, never throws

// src/approval/repository.ts (extend)
export async function claimNudge(db: D1Database, id: string, now: number): Promise<boolean>; // the CAS
export async function recordNudgeMessage(db: D1Database, id: string, channelId: string, ts: string): Promise<void>;
```

### Persistence — `migrations/0009_nudges.sql`

No new tables; three columns and one partial index on `approvals`:

```sql
ALTER TABLE approvals ADD COLUMN nudged_at INTEGER;
ALTER TABLE approvals ADD COLUMN nudge_channel_id TEXT;
ALTER TABLE approvals ADD COLUMN nudge_ts TEXT;
CREATE INDEX idx_approvals_unnudged ON approvals(created_at)
  WHERE decision = 'pending' AND nudged_at IS NULL;
```

`idx_approvals_unnudged` is the sweeper's retry feed: a pending card older than 60s with `nudged_at IS NULL` gets one more `sendNudge` attempt per sweep.

### Configuration (wrangler.jsonc `vars` — non-secret)

- `NUDGE_MODE`: `"dm"` (default) or `"channel"` — the Ronit-answer flag from the roadmap.
- `NUDGE_FALLBACK_CHANNEL_ID`: the `#eng-firefighter` channel id, used when mode is `channel` OR the on-duty engineer has no Slack identity row (fallback beats silence).
- `DASHBOARD_BASE_URL`: `"https://firefighter.sayandeten.workers.dev"` — the URL button target is `${DASHBOARD_BASE_URL}/?approval=${id}`.

## File structure

- Create: `src/identity/user-token.ts`, `src/notify/blocks.ts`, `src/notify/nudge.ts`, `migrations/0009_nudges.sql`
- Create tests: `test/notify-blocks.test.ts`, `test/notify-nudge.test.ts`, `test/user-token-sender.test.ts`, `test/slack-reply-identity.test.ts`
- Modify: `src/approval/sender.ts` (add `makeUserTokenSender`), `src/approval/repository.ts` (claim/record), `src/agent/dependencies.ts` (compose real sender + user-token source into `slack.reply`'s identity seam), `src/run/do.ts` (approval_card projection runner calls `sendNudge`; resolution path calls `updateNudge`), `src/index.ts` (sweeper: unnudged retry feed), `apps/worker/wrangler.jsonc` (three vars), `apps/worker/.dev.vars.example`
- Extend: `test/approval-resolution.test.ts` (delivery `sent` now reachable)

## Execution speed rules — READ BEFORE DISPATCHING ANY TASK

Same regime as Phases 11/12; overrides per-step commands wherever they conflict.

1. **Focused tests by exact path:** `cd apps/worker && pnpm exec vitest run test/<exact-file>.test.ts`. Never a pattern.
2. **One `pnpm exec tsc --noEmit -p tsconfig.json` per task**, at the end.
3. **The full suite runs exactly once** — Task 6, before the live proof. Nowhere else.
4. **Dispatch = the task's own text + Public contracts + these rules.** Subagents read only the files their task names plus direct imports. For Tasks 4–5 also grant read of `src/run/do.ts`'s projection-runner region and `src/agent/dependencies.ts` — the integration points Phase 11 built.
5. **Review depth:** deep for Tasks 3 and 5 (credential path, send-outcome honesty); light for 1 and 2; medium for 4.
6. **All Slack I/O is tested with a stubbed `fetch`** (the `vi.stubGlobal` pattern from `test/codemode-langsmith.test.ts`). No live Slack calls before Task 7.

### Parallel wave schedule

| Wave | Tasks (concurrent) | Why safe |
|---|---|---|
| A | **1** ∥ **2** ∥ **3** | pure blocks vs repository columns vs sender+token source — zero shared files |
| B | **4** ∥ **5** | 4 owns `notify/nudge.ts` + do.ts's projection runner; 5 owns dependencies.ts + the reply seam |
| C | **6** | wiring, sweeper, full gate |
| D | **7** | live proof — serial by nature |

## Task order

### Task 1 — Block Kit builders

**Files:** create `src/notify/blocks.ts`, `test/notify-blocks.test.ts`.

- [ ] **Step 1: Failing tests.** `nudgeBlocks`: contains a `section` with the why, a quoted draft preview truncated at 300 chars with a visible `… [truncated]` marker (400-char draft in, assert marker + length), and an `actions` block with ONE `button` whose `url` is exactly `${dashboardUrl}/?approval=${approvalId}` and which has NO `action_id`-triggered behavior beyond the URL (assert no `value` field — URL buttons need no interactivity endpoint); JSON-serializable (round-trip `JSON.parse(JSON.stringify(...))`). `resolvedBlocks`: each of the four decisions renders a one-line status; `decidedBy: null` (withdrawn) omits the name; no button block remains.
- [ ] **Step 2: Run, verify FAIL** (`cd apps/worker && pnpm exec vitest run test/notify-blocks.test.ts`).
- [ ] **Step 3: Implement.** Pure functions returning plain objects. Keep copy direct: `"Waiting on you: reply to #<channel>"` / why / draft quote / `"Review"` button.
- [ ] **Step 4: Run tests, verify PASS.**
- [ ] **Step 5: Commit:** `feat(notify): Block Kit nudge and resolution payloads`

### Task 2 — Nudge bookkeeping

**Files:** create `migrations/0009_nudges.sql` (SQL above, verbatim); modify `src/approval/repository.ts`; extend `test/approval-repository.test.ts`.

- [ ] **Step 1: Failing tests.** Real D1: `claimNudge` returns true once and false on every retry (two sequential calls, then a `Promise.all` pair on a fresh row yields exactly one true); `recordNudgeMessage` stores channel+ts readable via `getApproval`; the unnudged index feed — insert three pending rows, claim one, a `WHERE decision='pending' AND nudged_at IS NULL` query returns the other two oldest-first.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** `claimNudge` is one conditional UPDATE, branch on `meta.changes`. Extend `ApprovalRow` with the three nullable fields.
- [ ] **Step 4: Run tests + typecheck, verify PASS.**
- [ ] **Step 5: Commit:** `feat(approval): once-only nudge bookkeeping on the approvals row`

### Task 3 — User-token source and the real sender

**Files:** create `src/identity/user-token.ts`, `test/user-token-sender.test.ts`; modify `src/approval/sender.ts`.

- [ ] **Step 1: Failing tests.** `makeUserTokenSource`: on-duty email resolved via `onDuty(now)`, row present → decrypted token + `slackUserId` from `external_id`; no row → null; a `SealError` propagates (corrupt ciphertext must be loud). `makeUserTokenSender` with stubbed fetch: null source → `blocked` with the not-connected reason and NO fetch made; ok:true → `sent` with Slack's `ts`, and the request carried `Authorization: Bearer <user token>`, the row's `channel_id`, `thread_ts`, and the text byte-exact; ok:false `invalid_auth` → `blocked` with reason `invalid_auth`; fetch throws → `in_doubt`; non-JSON 200 → `in_doubt`; the returned reasons never contain the token (assert on JSON.stringify of every outcome).
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** `chat.postMessage` POST with JSON body `{channel, thread_ts, text}`. Keep `makeIdentityRefusingSender` — tests and shadow tooling still use it.
- [ ] **Step 4: Run tests + typecheck, verify PASS.**
- [ ] **Step 5: Commit:** `feat(approval): send approved replies under the on-duty engineer's token`

### Task 4 — Nudge orchestration on the projection hook

**Files:** create `src/notify/nudge.ts`, `test/notify-nudge.test.ts`; modify `src/run/do.ts` (approval_card projection runner: after the D1 card upsert commits, fire-and-forget `sendNudge`), `src/index.ts` (sweeper: retry feed).

- [ ] **Step 1: Failing tests.** Stubbed fetch + real D1. `sendNudge` in `dm` mode: claims first (a pre-claimed row → `"skipped"`, zero fetches); on-duty engineer connected → `conversations.open` with their `slackUserId`, then `chat.postMessage` with `nudgeBlocks` to the opened channel, `recordNudgeMessage` stores the ts, returns `"sent"`; engineer NOT connected → posts to `NUDGE_FALLBACK_CHANNEL_ID` with a `<@…>`-less mention of the email (no user id to mention), still once-only; `channel` mode → fallback channel directly with `<@slackUserId>` when known; Slack failure → `"failed"` AND `nudged_at` is rolled back to NULL (unclaim on failure — one UPDATE) so the sweeper retries; the projection runner test: a completed approval_card projection with a failing nudge still completes the projection (nudge failure is not a projection failure).
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** Sweeper extension: one query over `idx_approvals_unnudged` for pending rows older than 60s, at most 10 per sweep, each through `sendNudge` (the claim makes concurrency with a live projection safe).
- [ ] **Step 4: Run tests + typecheck, verify PASS.**
- [ ] **Step 5: Commit:** `feat(notify): one nudge per approval via the card projection hook`

### Task 5 — Wire the sender: resolution path + `slack.reply`

**Files:** modify `src/agent/dependencies.ts` (compose `makeUserTokenSender(makeUserTokenSource(env))` where `makeIdentityRefusingSender` sat; route `slack.reply`'s credential through the same `UserTokenSource`), create `test/slack-reply-identity.test.ts`; extend `test/approval-resolution.test.ts`.

- [ ] **Step 1: Read first.** `src/agent/dependencies.ts` and the `slack.reply` path (`src/codemode/bindings/slack.ts` → `src/slack/gateway.ts`) to locate the exact `identity_unavailable` throw. Do not restructure the gateway — swap the credential source at the seam Phase 10 left.
- [ ] **Step 2: Failing tests.** Resolution: approve on a run whose fake source returns a token → delivery `sent` (extend the Phase 11 matrix rows that asserted `blocked`); approve with a null source → still `blocked` (honest fallback preserved). Reply: a `slack.reply` execution with a connected on-duty engineer posts with the USER token (assert the Authorization header in the stub) and the effect ledger records it exactly as before; with a null source it still throws `identity_unavailable` (a clarifying question with nobody connected must not silently use the bot). Write-guard and channel pinning asserted unchanged (reuse the existing codemode-slack test helpers).
- [ ] **Step 3: Implement.** Composition-only where possible; the gateway change is the credential parameter, nothing else.
- [ ] **Step 4: Run both test files + typecheck, verify PASS.**
- [ ] **Step 5: Commit:** `feat(slack): every customer-facing send goes out as the on-duty engineer`

### Task 6 — Nudge updates, wiring, full gate

**Files:** modify `src/notify/nudge.ts` (`updateNudge`), `src/run/do.ts` (resolution + withdraw paths call `updateNudge` best-effort), `apps/worker/wrangler.jsonc` (three vars), `.dev.vars.example`; extend `test/notify-nudge.test.ts`.

- [ ] **Step 1: Failing tests.** `updateNudge`: with a recorded nudge message → `chat.update` on that channel/ts with `resolvedBlocks`; without one → no fetch; a `chat.update` failure is swallowed (returns void, never throws — a dead DM must not break resolution); withdrawn card → the update names the withdrawal.
- [ ] **Step 2: Implement + wire the vars.**
- [ ] **Step 3: Full gate, once:** `cd apps/worker && pnpm exec vitest run && pnpm exec tsc --noEmit -p tsconfig.json && pnpm lint` and `pnpm exec wrangler deploy --dry-run`.
- [ ] **Step 4: Commit:** `feat(notify): resolved cards rewrite their nudge; no dead links`

### Task 7 — Live integrated proof

- [ ] **Step 1:** Apply `0009` remotely (`pnpm exec wrangler d1 migrations list firefighter --remote` first), deploy, confirm `/api/health`.
- [ ] **Step 2:** Connect your own Slack identity via Phase 12's flow (you are in `FIREFIGHTERS` and — for the test window — adjust nothing: if you are not on duty per `onDuty(now)`, temporarily order yourself first in `ROTATION` locally? **No.** Use the fallback-channel path for the nudge proof and note that the DM path was proven with the on-duty engineer stubbed in tests; OR wait for a shift where the connected account is on duty. Record which in `phase-13-notes.md`.)
- [ ] **Step 3:** Escalate from `#test-firedrill`; verify the nudge (push received, button opens the card), approve on the dashboard; verify the reply lands in the thread **under the user identity**, delivery `sent`, the nudge DM rewritten to "approved".
- [ ] **Step 4:** Second escalation → withdraw path (next customer message makes it moot) → nudge rewritten to withdrawn.
- [ ] **Step 5:** Record evidence (message ts, approval ids, D1 rows) in `phase-13-notes.md`. Commit: `docs(notify): record phase 13 live verification`

## Test matrix

| Row | Proven by |
|---|---|
| One nudge per approval under races and replays | Task 2 CAS + Task 4 skip/unclaim |
| Nudge failure never breaks the projection | Task 4 runner test |
| DM vs channel mode, unconnected fallback | Task 4 |
| Sent/blocked/in_doubt honesty incl. no-token | Task 3 |
| Byte-exact outbound text (edit wins) | Task 5 resolution rows |
| `slack.reply` user-token with `identity_unavailable` preserved when unconnected | Task 5 |
| No token material in any outcome/payload | Tasks 3, 4 stringify asserts |
| Dead-link prevention | Task 6 |

## Exit criteria

An escalation produces a phone push within seconds; its button lands on the right approval card; an approved test-channel reply arrives under an engineer's Slack identity with delivery `sent`; a withdrawn card's nudge says so; the full local gate is green and live proof is recorded in `phase-13-notes.md`.

## Downstream handoff

- **Phase 16:** nothing new to consume — the card UI reads the same rows; `delivery: "sent"` now appears in `GET /api/approvals/:id` responses.
- **Phase 21:** shadow escalations still nudge nobody (delivery `suppressed` short-circuits before the send; the nudge fires regardless of shadow so engineers see drills — if the drill shows that's noise, gate `sendNudge` on `!row.shadow` there, one line).
- **Phase 23:** the drill's click count starts at the nudge push.
