# Phase 21 — Voice, Eval, Shadow — Execution Notes

Branch: `phase-21`, executed in place from BASE `537564e`.
Baseline before any work: `pnpm exec vitest run` → 90 files, 1681 passed, 2 skipped.

Tasks 1-6 are complete and reviewed. **Task 7 is partially complete: the offline gate ran,
but the live steps (2-5) are blocked and are listed under DEFERRED GATE below.** The phase's
exit criteria are NOT yet met, and this document does not claim otherwise.

## Commits

| Task | Commit | Subject |
|---|---|---|
| 1 | `e8bc21d` | `feat(eval): triage precision/recall with honest nulls` |
| 2 | `b157184` | `feat(eval): mechanical AI-tell detection matching the spec's copy rules` |
| 3 | `0c6afc3` | `feat(prompt): few-shot the on-duty engineer's own voice, frozen per shift` |
| 3 | `5845976` | `fix(prompt): carry the engineer voice block on the production prompt path` |
| 5 | `36d020e` | `feat(api): triage scores and the shadow corpus, D1-only` |
| 5 | `7d01727` | `fix(api): score only ripe decisions, and say what was excluded` |
| 3 | `de77788` | `fix(prompt): close the freeze holes around queue lag and identity churn` |
| 4 | `e5f4ddb` | `feat(prompt): shadow runs draft for approval instead of fighting denied sends` |
| 6 | `a0a68e3` | `feat(dashboard): shadow drafts side by side with the human's actual reply` |

## The corrections that mattered

### The voice block was inert in production (Task 3, `5845976`)

The feature passed its own 15/15 tests and was still dead. `loop.ts:536` called
`buildAgentPrompt({context, messages})` with no `voice` argument, so the engineer's samples
never reached a real request. Tests exercised the builder directly and so could not see it.
Worth remembering as a shape: a unit-tested module can be fully correct and fully unreachable.

### The cache key had a modulo collision (Ruling 2)

The plan said key the voice cache on `onDuty().index`. That is the roster slot **modulo the
roster length**, so shift N and shift N+len share a key: a long-lived isolate would serve a
previous engineer's writing samples under the current engineer's name, with no error — the
freeze would break in the flattering direction. The key is now a monotonic shift ordinal,
`Math.floor((nowMs - ROTATION_EPOCH_MS) / SHIFT_MS)`.

This got stronger later. `ROTATION` currently has **five** entries, index 0 being a trial
override slated for removal before handover. Under the plan's key the collision period would
have been 5 today and would have silently *changed to 4* the moment that entry is deleted.

### The exemplars contradicted the rule they taught (Ruling 5)

`policy.ts:146` reads "Never use an em dash". Two of the four `VOICE_EXAMPLES[].good`
entries — the copy the model is explicitly told to imitate — each contained one, inside the
same cached prefix. Example `[3]` had been added on 2026-08-14 precisely because a real send
read as generated, and its own comment names an em dash as the tell.

The detector was right and the fixtures were wrong. Task 2 quarantined the two entries behind
a temporary exclusion rather than softening the detector to match broken data; Task 4 rewrote
both strings and removed the exclusion, so the "every good exemplar is clean" guard is now
total. Weakening the detector would have inverted the phase's entire point.

### A ruling of mine silently disarmed existing tests (Task 3, caught in re-review)

Ruling 6 introduced a 5-minute grace window on the freeze bound. Rows seeded 500ms-4s before
a shift boundary then fell inside the new window and were excluded — which would have made
pre-existing assertions vacuous **without failing**. The re-review grepped every seed
timestamp in both files and confirmed the knock-on was caught everywhere. This was the single
most valuable catch of the phase: nothing would have gone red.

### Ripeness must key off message arrival, not decision time (Ruling 9 + Task 5 deviation)

Decisions younger than 24h were scored before their engagement window had elapsed, so a
decision made an hour ago could score FP today and flip to TP tomorrow — biasing downward, but
making `?days=1` incomparable to `?days=30`. Excluding them alone would have quietly shrunk
`n`, so the route also returns `unripeExcluded` and `truncated`.

I instructed the implementer to key ripeness off `t.created_at`. It used `m.received_at`
instead and was right: the engagement window is bound from the message's own arrival, so
`received_at <= now-24h` is algebraically the same as "the window's upper bound has passed".
Keying off decision time would have been wrong for any decision made after its message landed.

## Product risks to decide (human calls, not code fixes)

1. **The typography tells have no code-snippet exemption.** `semicolon`, `exclamation` and
   `emoji` are unconditional character matches, so a draft quoting `!==`, a CSS rule, or a
   shell one-liner gets flagged. `policy.ts:129-148` states those bans unqualified, so the
   detector is faithfully implementing the policy — but customer replies in this product
   routinely carry code. The honest fix is a **policy-level** carve-out ("inside backticks
   does not count"), decided by a person. Do not patch the detector to paper over it.
2. **A window whose decisions are all fresh reports `n: 0`** with a non-zero `unripeExcluded`.
   That is correct, but any surface rendering only `n` shows an empty eval without saying why.
   Relevant to the README material.
3. **`n` is expected to be small.** Per the plan's own instruction: a rate over a dozen
   decisions is a direction, not a grade. Whatever number lands below must be quoted **with
   its `n` and its window**, never alone.

## Gate (offline)

Run once at the end of the phase, from the repo root:

| Gate | Command | Result |
|---|---|---|
| Worker typecheck | `cd apps/worker && pnpm typecheck` | exit 0, no output |
| Worker suite | `cd apps/worker && pnpm test` | **95 files, 1779 passed, 2 skipped**, exit 0, 165.6s |
| Dashboard build | `cd apps/dashboard && pnpm build` | tsc + vite, 87 modules, built in 1.20s, exit 0 |
| Repo lint | `pnpm lint` | exit 0 — but see the caveat below |

Against the pre-phase baseline of 90 files / 1681 passed / 2 skipped, that is **+5 files and
+98 tests with zero regressions and zero failures**. The worker's `test` script also runs
`scripts/check-text-files.mjs` ahead of vitest, so the text-file lint passed too.

**The `pnpm lint` green is close to meaningless and should not be quoted as coverage.**
Turbo reports "Running lint in 5 packages" but then "Tasks: 1 successful, 1 total" — only
`@workspace/ui` defines a lint task, and that run was a *cache hit replaying logs from a
different worktree path* (`../firefighter/packages/ui`). Neither `@workspace/worker` nor
`@workspace/dashboard` has a lint script at all. **Nothing this phase changed was linted.**
Type-checking and the suite are doing all the real work; treat the lint row as a no-op until
the two app packages get lint tasks.

## DEFERRED GATE — everything requiring a live origin

Task 7's steps 2-5 cannot be executed from this environment. They are **not** done, and the
phase's exit criteria depend on them. Following the precedent set by `phase-16-notes.md`,
they are recorded here as owed rather than quietly dropped.

Blockers, in order of hardness:

- **Deploying is not mine to do.** It is an outward-facing action that was never authorised
  for this run.
- **Cloudflare Access.** Every eval route is behind `requireTeamMember`, and a valid Access
  JWT cannot be minted locally — the verifier checks Cloudflare's JWKS for the real team
  domain. Phase 16 hit exactly this wall and recorded the same deferral.
- **There is no substitute for real traffic.** Steps 3-4 need actual observe-mode threads
  with actual human replies to compare against. Seeded fixtures would prove the renderer
  works, which is already tested, and would prove nothing about the voice.
- **Step 4 is explicitly a human-judgment step,** timeboxed to an hour, ending at "reads as
  though a Zellify engineer wrote it". That is not a judgment an agent should make about its
  own output.

Owed before Phase 21 can be called done:

- [ ] Deploy; hit `GET /api/eval/triage?days=30` on the live origin with an Access session.
      Record the score **with its `n`, its window, and `unripeExcluded`** in this file. If
      `n < 20`, say so here and in the README material.
- [ ] Confirm observe-mode threads are producing suppressed drafts via `GET /api/eval/shadow`.
- [ ] Read ten drafts in the side-by-side panel against the human replies.
- [ ] Iterate the voice where drafts diverge — adjust the `STABLE_POLICY_SECTIONS` voice text
      or the contrast examples, re-read, stop at ten drafts that read as the engineer's own.
      **Where the tell detector still flags, the prompt gets the fix, not the detector.**
- [ ] Two runs in the same shift → confirm `cacheReadTokens > 0` on the second, proving the
      provider accepted the shift-stable block boundary. Record the numbers.

On that last item: the two-breakpoint layout is **mechanically** confirmed — a review traced
the installed SDK (`ai` copies `providerOptions` per system message; `@ai-sdk/anthropic` emits
one text part per message with its own `cache_control`; the validator caps at 4 breakpoints and
this uses 2). What remains unproven is only provider-*reported* reuse. A layout claim is not a
measurement.

## Deferred minors

Carried from task reviews; none blocking.

- Timestamps (`createdAt`, `humanReply.ts`) are fetched by the shadow panel but used only for
  sort order, never rendered — so a reader gets relative order but no "how long ago" cue.
  ~10 lines. This mildly undercuts the 30-second-comprehension criterion.
- `context.ts:277`'s own shadow notice contains an em dash. It is internal trusted-context
  text, not customer-facing copy, so `policy.ts:146`'s ban does not govern it.
- Voice block: the 6,000 bound is on raw sample text rather than the rendered block (escaping
  can roughly double it); `slice(0,300)` can split a UTF-16 surrogate pair; no in-flight
  promise memo, so two concurrent cold resolves each hit D1 once per isolate per shift; the
  shift-ordinal expression is duplicated between `voice.ts` and `rotation.ts` (it cannot drift
  silently — same imported constants — but exporting `shiftOrdinal()` would make Ruling 2
  structural rather than repeated).
- A row DELETED mid-shift has no timestamp to gate on, so Ruling 7's identity freeze has that
  one irreducible hole. Documented, not claimed closed.
- `truncated` is `rows.length === MAX_DECISIONS`, which cannot distinguish "exactly 5000 in
  window" from "clipped". Pre-existing bound-representation limit.
- `outcome='ingested'` lives in two SQL constants by design (they answer different questions,
  and the mutation test bites on both) — recorded so a future refactor does not consolidate
  one away without re-running it.
- Task 1's FN-preference test feeds FNs before FPs only; bucketing makes order-independence
  structural, but no test proves it by feeding FPs first.

## Downstream handoff

- **Phase 22:** the shadow panel joins the state sweep; nothing else.
- **Phase 23:** the README's eval section quotes this file verbatim (score, `n`, window) —
  which means the DEFERRED GATE above must be closed first, or the README has nothing real to
  quote. The drill's how-to-question scenario benefits directly from the voice block.
  Rejection-reason training data (Phase 16) and the suppressed corpus are the "what another
  week buys" evidence.
- **For any later phase writing DO-invocation tests:** reuse Task 5's Proxy-based proof in
  `test/`. The helper the plan pointed at does not exist; `test/approval-api.test.ts:187-199`
  only checks `stub.state()` is null, and its own comment concedes that proves no DO *state*
  was written, not that no DO was woken.
