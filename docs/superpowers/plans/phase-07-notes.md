# Phase 07 notes — live triage verification

Phase 07 shipped with `makeTriageRunner()` and the real Haiku call **never
executed**. Every suite injects a fake `TriageRunner`, and `.dev.vars` declared
`ANTHROPIC_API_KEY=` with an empty value — enough for `wrangler types` to emit
`ANTHROPIC_API_KEY: string`, so typecheck and tests were both green against a
credential that did not exist.

The key was filled in on 2026-08-12 and the live path was exercised once.

---

## What was verified

One throwaway script called `makeTriageRunner({ ANTHROPIC_API_KEY })` directly
under `tsx --env-file=.dev.vars`, with two realistic inputs. Deleted after the
run; only these results survive.

**1. The model id resolves.** `TRIAGE_MODEL = "claude-haiku-4-5"` is a current
model — no date suffix needed, no 404.

**2. Structured output honours the schema.** `generateObject` returned exactly
`wake`, `why`, `opening_prompt` and nothing else; the outcome carries those
three plus the three the runner adds (`model`, `cost_usd`, `latency_ms`). No
`type`/`category` field appeared, which is the guard the schema-shape test
asserts statically.

**3. The token→cost mapping is real, not assumed.** This was the open question,
and it is the one that mattered: `haikuCostUsd` reads `usage.inputTokens` and
`usage.outputTokens`, both `number | undefined` in `ai@7`, with `?? 0`
fallbacks. Had those field names been wrong, every stored `cost_usd` would have
been `0` and nothing would have failed — the D1 column would just fill with
zeroes and the $500 reconciliation would silently read as free.

They populate:

| Input | wake | cost_usd | latency_ms |
|---|---|---|---|
| "our CSV exports have been coming through empty since yesterday afternoon" | `true` | `0.000917` | 4875 |
| "haha nice one 😄" (after an engineer shipped something) | `false` | `0.000636` | 2063 |

Both non-zero and finite. `haikuCostUsd({ inputTokens: 1e6, outputTokens: 1e6 })`
returns `6`, matching Haiku 4.5 list price of $1/MTok input and $5/MTok output.

**4. The behavioural exit criterion holds.** Phase 07's exit criteria are
"banter in a test channel does not wake anything; a question does." The
actionable message woke with a briefing that pulled in the recalled fact about
the customer's nightly export job; the banter did not wake and returned an
empty `opening_prompt` (which satisfies the `NOT NULL` column — it is `""`,
not null).

---

## Observations worth carrying forward

**Triage latency is 2–5 seconds per decision.** Fine where it runs — the triage
queue consumer, not the webhook, which still has its 3-second Slack budget.
Worth remembering when Phase 21 scores the eval set: a few hundred stored
decisions replayed serially is a coffee break, not a loop to watch.

**Cost per decision is ~$0.0006–0.0009.** At that rate triage is not what
threatens the $500 ceiling; Phase 10's agent loop on Fable 5 is.

**No prompt caching on the triage call.** Not a problem at this prompt size,
but Phase 10 explicitly plans caching against the ceiling, and `haikuCostUsd`
has no notion of cache reads or writes. If caching is ever added to triage, the
cost function needs the cache-token fields too or it will over-report.

**The AI Gateway path is still unexercised.** `makeTriageRunner` sets `baseURL`
when `AI_GATEWAY_ANTHROPIC_URL` is present; it is absent from `.dev.vars`, so
this run went straight to Anthropic. The gateway branch has never executed.

---

## The suite still makes no live calls

Worth stating explicitly now that a working key exists, because the failure
mode inverted: with an empty key a stray live call failed loudly, and with a
real one it would quietly succeed and bill.

The proof is in the before/after. The full suite passed with 305 tests both
when `ANTHROPIC_API_KEY` was empty and after it was filled in, with the same
duration (~24s) — a suite that reached Anthropic could not have passed under
the empty key. Phase 08's exit criterion ("no test may depend on `.dev.vars`
secret values or a live Zep/Anthropic call") therefore still holds.

---

## Still outstanding

`wrangler secret put ANTHROPIC_API_KEY` for the deployed Worker. `.dev.vars` is
local only — a deployed triage consumer without it fails on the first
actionable message. This is separate from the four deploy-time items listed in
`phase-08-notes.md` and belongs with them.
