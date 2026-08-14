# Phase 21 — Voice, Eval Harness, Shadow Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replies indistinguishable from the on-duty engineer's own — few-shot from their real messages, cache-safely; triage precision/recall as numbers, not vibes; shadow drafts accumulating as an eval corpus with a side-by-side view against what the human actually sent.

**Architecture:** Three pure cores (a triage scorer, an AI-tell detector, a per-shift voice sampler) composed by two read-only eval API routes and one dashboard panel. The prompt gains one new block — **engineer voice samples** — placed between Phase 10's stable blocks and the dynamic context, frozen per rotation shift so the prompt cache invalidates exactly once per shift and never mid-shift. Shadow needs no new machinery: the write-guard already denies external writes and Phase 11 already made shadow escalations terminate `suppressed` — this phase adds the *posture* (the model knows it is shadowing and escalates drafts instead of fighting denied sends).

**Tech Stack:** D1 (all reads), the existing prompt assembly (`src/agent/prompt/*`), Hono, Phase 14's dashboard primitives.

**Spec:** `docs/superpowers/specs/2026-08-10-firefighter-agent-design.md` §11, §13. Roadmap entry: `00-roadmap.md` Phase 21.

## Global Constraints

All of `00-roadmap.md` "Global Constraints" apply. The ones that bite here:

- **Prompt cache safety (invariant 26):** blocks before the dynamic context must be byte-identical across requests. The new voice block is allowed to change **only at a shift boundary** — never within one.
- **Eval routes are D1-only.** No Durable Object wakes, no vendor calls — scoring a month of decisions must cost indexed reads.
- **Reference-channel data never reaches a customer.** Everything here reads; the only writes are the shadow escalations Phase 11 already suppresses.
- **AI-tell rules are the spec's copy rules** (no preamble, no "Great question!", no bulleted recap, no closing restatement) — the detector encodes exactly those, not new taste.
- **Commit after every task.** Conventional prefixes.

## Where to execute this — READ FIRST

**In a worktree, not the main checkout.** Phase 18 is executing on `main`, and a
second lane committing into the same working tree tangles both: commits
interleave onto whichever branch was last checked out, and a `git add -A` in
one lane sweeps the other's half-finished files. That happened on 2026-08-14
and cost a commit rescue.

```bash
git worktree add ~/Desktop/zellify/firefighter-p21 -b phase-21 main
cd ~/Desktop/zellify/firefighter-p21 && pnpm install
```

**The two files both phases touch**, each an additive line, so the rebase is
mechanical:

| File | Phase 18 adds | Phase 21 adds |
|---|---|---|
| `src/agent/dependencies.ts` | composes the `sandbox` namespace | threads `resolveEngineerVoice` into prompt assembly |
| `src/index.ts` | sandbox configuration fields | mounts `evalApi` under `/api` |

**Boundaries for this lane, non-negotiable:**

- **Never touch `src/sandbox/**`, `src/codemode/**`, or `sandbox/Dockerfile`.**
  Those are Phase 18's, and this phase needs none of them.
- **Never regenerate `src/codemode/generated/capabilities.d.ts`.** Phase 18 owns
  it this week because it is adding a namespace; regenerating from a tree
  without those changes silently reverts them, and the CI drift check would
  then fail on Phase 18's branch rather than here.
- **Never deploy.** Phase 18's Task 8 and this phase's Task 7 both want a live
  proof, and only one deploy can win. Record the live steps as gates in
  `phase-21-notes.md` and let the operator serialise them.
- **Never `git add -A` or `git add .`** — stage only the paths the task names.

**Merge order:** Phase 18 first, since it has the larger surface and owns the
generated `.d.ts`; this phase then rebases its two lines on top. If Phase 18
stalls on the monorepo invite, merge this one first instead — nothing here is
blocked on anybody.

## Depends on

Phases 07 (stored `triage_decisions`), 10 (prompt assembly, shadow wakes), **11** (`suppressed` delivery corpus, escalate-allowed-in-shadow, `requireTeamMember`'s underpinnings), **12** (`identities.external_id` = the engineer's Slack user id, for sampling; `onDuty` for the shift key), 14 (dashboard panel). Execute after the `phase-12-14` merge. The old roadmap sketch's "10, 07" undersold this — corrected in the roadmap.

Not blocked on Phase 18 in either direction.

## Outcome

- The system prompt carries up to 20 of the on-duty engineer's real customer-channel messages, sampled deterministically from D1 as of the **shift start**, so every request in a shift bears identical bytes and the block re-tunes itself at rotation.
- `GET /api/eval/triage` returns precision/recall on `wake` against what humans actually did in the reference channels — with `n`, the confusion counts, and the disagreement list, so the number cannot oversell itself.
- `GET /api/eval/shadow` returns recent suppressed drafts paired with the human's actual in-thread reply, each draft annotated with detected AI tells.
- A "Shadow drafts" panel on the dashboard renders those pairs side by side.
- The AI-tell checklist is a test: the policy prompt bans the tells, and the detector proves drafts against them.

## What this phase deliberately does not do

- **No new shadow machinery.** `write-guard.ts` already denies every external namespace for shadow runs and permits `escalate`/`withdraw`; channel policy already wakes observe channels as shadow. Only prompt posture and visibility change.
- **No automated voice scoring.** The side-by-side view plus the tell detector inform the human iteration loop (Task 7); a "voice similarity metric" would be a number pretending to be taste.
- **No third dashboard page.** The side-by-side view is a panel on the existing dashboard grid — the "two pages" claim survives untouched.
- **No re-labeling UI.** Ground truth is derived from D1; disputes are read in the disagreement list, not adjudicated in a tool.

## Non-negotiable invariants

1. **The voice block is frozen per shift.** Samples come only from messages with `received_at < shiftStartMs`, ordered and limited deterministically, cached per isolate keyed by shift index. A message arriving mid-shift MUST NOT change the block's bytes.
2. **Voice sampling is bounded:** ≤ 20 samples, each trimmed to 300 chars, total ≤ 6,000 chars; fewer than 5 usable samples ⇒ the block renders as the empty string (Phase 10's static contrast examples still teach the register). Empty is also byte-stable.
3. **Sampled text is the engineer's own authored messages only:** `user_id` = their `identities.external_id`, customer channels only (`customer_slug IS NOT NULL`), `subtype IS NULL`. Never another user's text, never DMs (none exist in D1 by the ingest drop), never bot messages.
4. **Prompt authority is unchanged:** the voice block is host-written instructions (it precedes the dynamic context and carries no untrusted framing beyond quoted sample text, delimited as data exactly like the existing `VOICE_EXAMPLES` quoting).
5. **Ground truth is one written definition:** a triage decision counts as `humanEngaged` iff **a genuinely human** message by a different `user_id` exists in the same channel and thread within 24 h after the triggering message. It lives in ONE SQL query with a comment; the scorer never re-derives it.
7. **Never read `messages` without excluding the agent's own posts.** Since 2026-08-14 the agent's replies are ingested (`events_seen.outcome = 'ingested_self'`) and they carry **the on-duty engineer's `user_id`**, because that is whose identity they were sent under. Every query in this phase therefore reads

   ```sql
   FROM messages m JOIN events_seen e ON e.event_id = m.event_id
   WHERE e.outcome = 'ingested'   -- humans only; 'ingested_self' is us
   ```

   and never `FROM messages` alone. Two things break without it, both silently and both in the flattering direction — see "Validation" below.
6. **Eval responses carry `n` beside every rate**, and rates over an empty class are `null`, never `0` or `100` — a recall of `null` says "no positives existed", which is the honest answer.

## Validation against shipped code, 2026-08-14

Re-checked after Phases 12–17 merged and after the day's live fixes. Three
findings, two of which would have produced numbers that flatter the system.

**1. Ground truth was contaminated (invariant 5, Task 5).** The original
definition — "a message by a different `user_id` in the same thread within
24 h" — was written when only humans reached `messages`. The agent's replies
now land there too, under the on-duty engineer's `user_id`. On any woken run
the agent replies, that reply satisfies "a different user engaged", and the
decision scores as a **true positive by construction**. Precision would have
climbed toward 1.0 as a direct function of the agent replying more, which is
the one thing an eval must never reward. Fixed by invariant 7's join.

**2. Voice sampling would have trained the agent on itself (invariant 3,
Task 3).** The sampler selects `messages` where `user_id` equals the on-duty
engineer's Slack id — which is exactly what the agent's own sends carry. Left
alone, each rotation would few-shot the model on its previous output rather
than on the human's writing, and the drift would compound every shift while
looking like it was working. This is the more damaging of the two: a bad
number is visible, an imitation loop is not. Fixed by the same join.

**3. `VOICE_EXAMPLES` is at its ceiling.** A fourth contrast pair landed on
2026-08-14 (the em-dash rewrite), so the array is now 4 of
`VOICE_EXAMPLE_MAX_COUNT = 4`, asserted by a test. Task 3 adds engineer samples
as their **own block**, not as entries here, so nothing collides — but any task
that wants a fifth static example must raise the cap deliberately and say why.

**Still accurate:** the prompt block order and cache marks, `triage_decisions`'
columns, the write-guard's shadow denial, `suppressed` as the shadow delivery
terminal, and `escalate` remaining permitted in shadow. The AI-tell detector's
rule list should now be cross-checked against the typography rules added to
`policy.ts` on 2026-08-14 (no em dash, no semicolon, no emoji, no exclamation
marks) — the detector and the policy must ban the same things, or the drafts
will pass one and fail the other.

## Public contracts

```ts
// src/eval/triage-eval.ts  (pure)
export type TriageOutcomeRow = { eventId: string; wake: boolean; humanEngaged: boolean;
  why: string; text: string; permalink: string | null };
export type TriageScore = { n: number; truePos: number; falsePos: number; falseNeg: number; trueNeg: number;
  precision: number | null; recall: number | null; disagreements: TriageOutcomeRow[] };
export function scoreTriage(rows: TriageOutcomeRow[], maxDisagreements?: number): TriageScore; // default 25

// src/eval/ai-tells.ts  (pure)
export type AiTell = "preamble" | "great_question" | "bulleted_recap" | "closing_restatement" | "exclaimed_thanks";
export function detectAiTells(text: string): AiTell[];  // empty array = clean

// src/agent/prompt/voice.ts
export const ENGINEER_VOICE_MAX_COUNT = 20;
export const ENGINEER_VOICE_SAMPLE_MAX_CHARS = 300;
export const ENGINEER_VOICE_MAX_TOTAL_CHARS = 6_000;
export const ENGINEER_VOICE_MIN_USABLE = 5;
export type EngineerVoice = { shiftIndex: number; email: string; samples: { text: string; ts: string }[] };
/** Deterministic as of the CURRENT SHIFT START; per-isolate cached by shiftIndex. */
export async function resolveEngineerVoice(db: D1Database, nowMs: number): Promise<EngineerVoice>;
export function renderEngineerVoice(voice: EngineerVoice): string;  // "" below MIN_USABLE

// src/api/eval.ts  (both routes requireTeamMember; D1-only)
// GET /api/eval/triage?days=30  → { score: TriageScore, windowDays: number }
// GET /api/eval/shadow?limit=20 → { pairs: Array<{ approvalId: string; draft: string; why: string;
//   createdAt: number; channelId: string; threadTs: string; tells: AiTell[];
//   humanReply: { text: string; permalink: string | null; ts: string } | null }> }
```

Prompt assembly change (`src/agent/prompt/index.ts`): the order becomes
1 stable policy · 2 stable voice contrast · **2b engineer voice (shift-stable, its own cache mark)** · 3 dynamic trusted context · 4 untrusted messages.
Blocks 1–2 keep their existing cache mark (reused across shifts); 2b carries a second breakpoint (reused within a shift). Anthropic allows four breakpoints; this uses two.

## File structure

- Create: `src/eval/triage-eval.ts`, `src/eval/ai-tells.ts`, `src/agent/prompt/voice.ts`, `src/api/eval.ts`
- Create tests: `test/triage-eval.test.ts`, `test/ai-tells.test.ts`, `test/prompt-voice.test.ts`, `test/api-eval.test.ts`
- Modify: `src/agent/prompt/index.ts` + `policy.ts` (block 2b wiring; shadow posture section), `src/agent/prompt/context.ts` (shadow visibility in trusted context, if absent), `src/agent/dependencies.ts` (thread `resolveEngineerVoice` into prompt assembly), `src/index.ts` (mount `evalApi`); extend `test/agent-prompt.test.ts`
- Dashboard: create `apps/dashboard/src/shadow/api.ts`, `src/shadow/shadow-panel.tsx`; modify `src/app.tsx` (mount, below the fold)

## Execution speed rules — READ BEFORE DISPATCHING ANY TASK

Same regime as Phases 11–13; overrides per-step commands wherever they conflict.

1. **Focused tests by exact path:** `cd apps/worker && pnpm exec vitest run test/<exact-file>.test.ts`. Never a pattern. Dashboard task: build + typecheck are the gates.
2. **One `pnpm exec tsc --noEmit -p tsconfig.json` per task**, at the end.
3. **The full worker suite runs exactly once** — Task 7. Nowhere else.
4. **Dispatch = the task's own text + Public contracts + these rules.** Task 3's subagent additionally reads `src/agent/prompt/policy.ts` + `index.ts` (the caching comments are the requirements); Task 5's reads `src/api/identity.ts` (authz helper) and `migrations/0007_approvals.sql` (join columns). No wider exploration.
5. **Review depth:** deep for Task 3 (cache safety — the one place this phase can silently cost real money) and Task 5 (authz + query shape); light for 1, 2, 6; medium for 4.
6. **Pure cores get exhaustive tests; I/O shells get thin ones.** The scorer/detector/sampler carry the coverage; routes assert authz, shape, and D1-only-ness, not re-proofs of the cores.
7. **Within a wave, run the subagents CONCURRENTLY.** The file sets are disjoint by construction (see the table below); dispatching them serially doubles wall-clock for no safety gain. This phase is fully subagent-drivable — unlike Phase 18, every task here has a fast local feedback loop.
8. **Seed fixtures in code, never by hand.** Tasks 1, 2 and 5 all need `triage_decisions` + `messages` rows. Write ONE helper in `test/helpers/` that inserts a scored scenario (woken + human reply, woken + silence, not-woken + human reply, not-woken + silence) and have all three tasks import it. Three subagents inventing three fixture builders is the most likely duplicated work in this phase.
9. **No new dependencies.** No stats library, no NLP, no date library. The scorer is arithmetic and the detector is a pattern table.
10. **The live numbers in Task 7 are not a gate.** If `n` is small, record it and move on — the deliverable is an honest number with its sample size, not a good one. Do not spend the tail of the week generating synthetic traffic to make a rate look better.
11. **Commit after every task**, conventional prefixes.

### Parallel wave schedule

| Wave | Tasks (concurrent) | Why safe |
|---|---|---|
| A | **1** ∥ **2** ∥ **3** | scorer, detector, and voice sampler share zero files (3 owns the prompt files this wave) |
| B | **4** ∥ **5** | 4 touches policy/context AFTER 3 released them; 5 owns `api/eval.ts` consuming waves A's pure cores |
| C | **6** | dashboard panel over 5's route |
| D | **7** | gate + live numbers — serial by nature |

## Task order

### Task 1 — Triage scorer

**Files:** create `src/eval/triage-eval.ts`, `test/triage-eval.test.ts`.

- [ ] **Step 1: Failing tests.** Hand-built row sets covering: all four confusion cells counted correctly; precision `null` when `wake` was never true, recall `null` when nothing was `humanEngaged` (and 1.0/0.0 cases distinguished from them); `disagreements` contains exactly the false positives and false negatives, capped at `maxDisagreements` with false negatives kept preferentially (a missed wake costs more than a spurious one); `n` equals the input length; an empty input yields `n: 0` and all-null rates.
- [ ] **Step 2: Run, verify FAIL** (`cd apps/worker && pnpm exec vitest run test/triage-eval.test.ts`).
- [ ] **Step 3: Implement.** One pass, no I/O.
- [ ] **Step 4: Run + typecheck; PASS. Commit:** `feat(eval): triage precision/recall with honest nulls`

### Task 2 — AI-tell detector

**Files:** create `src/eval/ai-tells.ts`, `test/ai-tells.test.ts`.

- [ ] **Step 1: Failing tests.** Each tell detected and each near-miss left alone: `preamble` ("Thanks for reaching out!", "I'd be happy to help" openers — but not a reply that merely starts with "Thanks" before substance? No: keep the rule mechanical — flag greeting-openers from a fixed list, and document that the list is the rule); `great_question` (case-insensitive "great/good question"); `bulleted_recap` (a bullet list whose intro line contains "to summarize/recap"); `closing_restatement` ("Let me know if you have any other questions", "Hope this helps" closers); `exclaimed_thanks` ("Thanks for flagging!" — exclamation-marked gratitude). A clean, direct reply (use `VOICE_EXAMPLES[0].good` verbatim) returns `[]`. Multiple tells all reported.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** Fixed pattern tables, case-insensitive; comment each pattern with the spec line it encodes. No NLP, no scoring — present/absent.
- [ ] **Step 3b: Cross-check against `policy.ts`.** The typography rules added on 2026-08-14 ban an em dash, a semicolon, an emoji and an exclamation mark in customer-facing text. The detector must flag exactly what the policy bans, or a draft passes one and fails the other. Add `em_dash`, `semicolon`, `emoji` and `exclamation` to `AiTell` with the same patterns, and assert in a test that `VOICE_EXAMPLES[].good` — the copy we hold up as correct — returns `[]` for every entry.
- [ ] **Step 4: Run + typecheck; PASS. Commit:** `feat(eval): mechanical AI-tell detection matching the spec's copy rules`

### Task 3 — Engineer voice, frozen per shift

**Files:** create `src/agent/prompt/voice.ts`, `test/prompt-voice.test.ts`; modify `src/agent/prompt/index.ts`, `src/agent/dependencies.ts`.

- [ ] **Step 1: Read the caching comments** in `prompt/index.ts` ("THE ORDER IS THE DELIVERABLE") and `STABLE_PREFIX_CACHE_OPTIONS` in `policy.ts`. They are requirements.
- [ ] **Step 2: Failing tests.** Real D1: seed messages for a connected engineer (identity row + authored customer-channel messages before and after a shift boundary). Assert: `resolveEngineerVoice` at two instants **within the same shift** returns byte-identical `renderEngineerVoice` output even though a new message landed between the calls (the freeze — invariant 1); at an instant in the **next shift** the new message may appear; only that engineer's messages are sampled (another user's seeded rows never appear); trimming to 300 chars, total ≤ 6,000, count ≤ 20; 4 usable samples ⇒ `""`; unconnected engineer ⇒ `""`; `subtype`-marked and non-customer-channel rows excluded; assembled prompt: `buildPrompt` (or the assembly seam in `index.ts`) places the block after the stable pair and before trusted context, with a cache mark on it — extend the existing prompt-order test rather than writing a parallel one.
- [ ] **Step 3: Run, verify FAIL.**
- [ ] **Step 4: Implement.** One SQL — note the join, which is what keeps the model from few-shotting on its own prior output (invariant 7):

  ```sql
  SELECT m.text, m.ts
    FROM messages m
    JOIN events_seen e ON e.event_id = m.event_id
   WHERE e.outcome = 'ingested'        -- NOT 'ingested_self': that is us
     AND m.user_id = ?                 -- the engineer's Slack external_id
     AND m.customer_slug IS NOT NULL
     AND m.subtype IS NULL
     AND length(m.text) >= 40
     AND m.received_at < ?             -- shiftStartMs: this bound IS the freeze
   ORDER BY m.received_at DESC
   LIMIT 20
  ```

  Per-isolate `Map<number, EngineerVoice>` keyed by `shiftIndex` (from `onDuty(nowMs)`); `external_id` via `getIdentity(db, onDuty(nowMs).email, "slack")`. Render mirrors `renderVoiceExamples`' quoting (samples are data, JSON-stringified).
- [ ] **Step 5: Run + typecheck; PASS. Commit:** `feat(prompt): few-shot the on-duty engineer's own voice, frozen per shift`

### Task 4 — Shadow posture

**Files:** modify `src/agent/prompt/policy.ts` (shadow section in the stable block), `src/agent/prompt/context.ts` (trusted context states `shadow: true` when the run is shadow — verify first whether it already does; add only if absent); extend `test/agent-prompt.test.ts`.

- [ ] **Step 1: Failing tests.** Policy snapshot: the stable block explains shadow — "in a shadow run, external sends are denied by the platform; produce your best draft via `approval.escalate` instead of attempting `slack.reply`" — and stays byte-identical across two builds (it is constants; the shadow text is unconditional policy, present for all runs, which keeps block 1 stable). Trusted context: a shadow run's context contains the shadow notice; a non-shadow run's contains nothing about shadow. The write-guard's `shadow_write_denied` message mentions escalation as the path forward (read `write-guard.ts` first; if the current copy already steers, assert it and change nothing).
- [ ] **Step 2: Run, verify FAIL (or confirm the existing-copy asserts pass and skip the edit).**
- [ ] **Step 3: Implement.** Text only. No control-flow changes — the guard already enforces; the prompt now explains.
- [ ] **Step 4: Run + typecheck; PASS. Commit:** `feat(prompt): shadow runs draft for approval instead of fighting denied sends`

### Task 5 — Eval API

**Files:** create `src/api/eval.ts`, `test/api-eval.test.ts`; modify `src/index.ts` (mount under `/api`).

- [ ] **Step 1: Failing tests.** Through `SELF.fetch` with the injected fake verifier (the Phase 11/12 pattern): 401/403 for outsiders on both routes; **triage** — seed `triage_decisions` + `messages` fixtures covering all four cells (a woken message with a 25-hour-later reply is a false positive — the 24 h window is asserted; a same-author follow-up does not count as engagement); response carries `score.n` and nulls per invariant 6; `days` clamped to 1..90; **shadow** — seed suppressed approvals + a human reply in one thread and none in another; pairs carry the reply where it exists and `null` where not, `tells` populated by the detector, newest first, `limit` clamped to 1..50; a `pending` or `sent` approval never appears; **zero DO invocations for both routes** (assert via the run-layer test helper the API tests already use).
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** The ground-truth SQL (invariants 5 and 7) as one commented query. Both halves of this route must exclude the agent's own posts, and for the same reason:

  ```sql
  -- humanEngaged: did a REAL person reply in this thread within 24h?
  -- The e.outcome filter is load-bearing. Without it the agent's own reply
  -- counts as engagement and every woken run scores true-positive.
  SELECT 1
    FROM messages m
    JOIN events_seen e ON e.event_id = m.event_id
   WHERE e.outcome = 'ingested'
     AND m.channel_id = ?
     AND m.thread_ts  = ?
     AND m.user_id   != ?           -- not the person who triggered it
     AND m.received_at BETWEEN ? AND ? + 86400000
   LIMIT 1
  ```

  The shadow join reads `approvals WHERE delivery='suppressed'` and, per row, the first later message in `(channel_id, thread_ts)` that carries the same `e.outcome = 'ingested'` filter — a shadow draft compared against the agent's own send would be comparing the model to itself.
- [ ] **Step 4: Run + typecheck; PASS. Commit:** `feat(api): triage scores and the shadow corpus, D1-only`

### Task 6 — Side-by-side panel

**Files:** create `apps/dashboard/src/shadow/api.ts`, `src/shadow/shadow-panel.tsx`; modify `src/app.tsx`.

- [ ] **Step 1: Implement.** `api.ts`: `fetchShadowPairs()` over the Phase 14 client (no test file — one-liner over tested layers). `shadow-panel.tsx`: `Panel` titled "Shadow drafts", `usePoll` at 30 s; each pair two columns — "Agent drafted" (the draft, tell badges beneath, e.g. `preamble`) and "Human sent" (the reply, permalink-linked, or "no human reply yet"); empty hint "No shadow drafts yet — observe-mode channels fill this as threads happen." Mount below the fold on the dashboard grid.
- [ ] **Step 2: Dashboard build + typecheck. Commit:** `feat(dashboard): shadow drafts side by side with the human's actual reply`

### Task 7 — Gate, live numbers, voice iteration

- [ ] **Step 1: Full gate, once:** `cd apps/worker && pnpm exec vitest run && pnpm exec tsc --noEmit -p tsconfig.json && pnpm lint`, dashboard build.
- [ ] **Step 2: Deploy;** hit `GET /api/eval/triage?days=30` on the live origin (Access session). Record the score WITH `n` in `phase-21-notes.md`. If `n < 20`, say so in the notes and in the README material — a rate over a dozen decisions is a direction, not a grade.
- [ ] **Step 3: Shadow corpus pass.** Confirm observe-channel threads are producing suppressed drafts (`/api/eval/shadow`); read ten in the side-by-side panel against the human replies.
- [ ] **Step 4: Iterate the voice** (the human-judgment step — timebox one hour): where drafts diverge from the human replies, adjust `STABLE_POLICY_SECTIONS` voice text / the contrast examples; re-read; stop at "reads as though a Zellify engineer wrote it" on ten drafts. The tell detector must return `[]` on all ten — where it doesn't, the prompt (not the detector) gets the fix.
- [ ] **Step 5: Verify the voice block live:** two runs in the same shift → `cacheReadTokens > 0` on the second (the shift-stable block cached); record the numbers. Commit: `docs(eval): record phase 21 live scores and voice iteration`

## Test matrix

| Row | Proven by |
|---|---|
| Rates with honest nulls and visible `n` | Task 1 |
| Every AI tell caught; clean copy passes | Task 2 |
| Voice block byte-frozen within a shift, re-tuned across | Task 3 |
| Only the engineer's own authored customer-channel text | Task 3 |
| Cache order/marks preserved (invariant 26) | Task 3 prompt-order test + Task 7 live cacheRead check |
| Shadow posture taught, guard copy steers | Task 4 |
| 24 h ground-truth window, same-author excluded | Task 5 |
| Eval routes: team-only, D1-only | Task 5 |
| Suppressed-only corpus, honest missing-reply | Task 5 + Task 6 render |

## Exit criteria

Ten shadow drafts on real threads read as though a Zellify engineer wrote them, with zero detector flags. Triage precision and recall are recorded numbers with their `n`. The voice block demonstrably caches within a shift and re-tunes at rotation. Full gate green; everything recorded in `phase-21-notes.md`.

## Downstream handoff

- **Phase 22:** the shadow panel joins the state sweep; nothing else.
- **Phase 23:** the README's eval section quotes `phase-21-notes.md` verbatim (score, `n`, window); the drill's how-to-question scenario benefits directly from the voice block; rejection-reason training data (Phase 16) and the suppressed corpus are the "what another week buys" evidence.
