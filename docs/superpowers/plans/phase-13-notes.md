# Phase 13 — Notes

## Status

Tasks 1–6 are implemented, reviewed and committed. The full local gate is green
(`vitest run`: 89 files / 1645 passed, 2 skipped; `tsc --noEmit`: clean;
lint: clean; `wrangler deploy --dry-run`: clean, with the three new vars in the
binding table).

**Task 7 (the live integrated proof) is DEFERRED.** Nothing in this phase has
been applied remotely, deployed, or sent to a real Slack workspace. Every Slack
call in the test suite is a stubbed `fetch`.

## Why Task 7 was deferred

A sibling worktree (`firefighter-ui`, branch `phase-15-16`) is active on this
repo alongside a live peer session. Task 7 Step 1 applies migration `0009`
`--remote` and deploys the Worker — that would push Phase 13's code to the
shared production Worker while another terminal is mid-phase. It is
outward-facing and not cheaply reversible, so it waits for a window where this
checkout is the only one deploying.

## Live gates — run these in order when the deploy window is free

Each gate is the plan's Task 7 step, with what must be true before it starts.

### Gate 0 — pick a value for `NUDGE_FALLBACK_CHANNEL_ID`

**Blocking for gates 3 and 4.** The var currently ships as `""`. No
`#eng-firefighter` channel id exists anywhere in this repo — `seed-channels.sh`
leaves that channel deliberately unmapped — and guessing one would aim engineer
nudges at an unknown conversation. While it is empty:

- `NUDGE_MODE=channel` is inert, and
- an on-duty engineer with no connected Slack identity leaves the card sitting
  on the sweeper's retry feed instead of falling back to a channel.

The DM path is unaffected and works without it.

An operator sets the real channel id in `apps/worker/wrangler.jsonc` before the
fallback branch can be proven live.

### Gate 1 — migrate and deploy

```
cd apps/worker
pnpm exec wrangler d1 migrations list firefighter --remote   # confirm 0009 is pending, and only 0009
pnpm exec wrangler d1 migrations apply firefighter --remote
pnpm exec wrangler deploy
```

Then confirm `/api/health`.

Phase 13 owns migration `0009` only. If the list shows anything else pending,
stop — another phase's migration has drifted in.

### Gate 2 — connect a Slack identity

Connect your own Slack identity through Phase 12's OAuth flow.

The plan raises, and answers, the rotation problem here: **do not reorder
`ROTATION` or move `ROTATION_EPOCH_MS` to put yourself on duty.** Both values
are still unconfirmed upstream (question sent to Ronit 2026-08-13) and editing
them to make a test convenient would silently page the wrong person later.

Two honest options — record which one was used:

- **(a)** Wait for a shift where the connected account is genuinely on duty, and
  prove the DM path live.
- **(b)** Prove the fallback-channel path live instead (needs Gate 0), and note
  that the DM path was proven with the on-duty engineer stubbed in
  `test/notify-nudge.test.ts`.

### Gate 3 — the approve path

Escalate from `#test-firedrill`, then verify, in order:

1. A phone push arrives within seconds of the `approval_card` projection.
2. The nudge's button opens the right approval card
   (`${DASHBOARD_BASE_URL}/?approval=<id>`).
3. Approve on the dashboard.
4. The reply lands in the customer thread **under the engineer's own Slack
   identity**, not the bot.
5. Delivery is `sent` with a real `ts`.
6. The nudge DM has been rewritten to "approved".

### Gate 4 — the withdraw path

Second escalation, then let the next customer message make it moot. Verify the
nudge DM is rewritten to say it was withdrawn.

### Gate 5 — record the evidence

Append message `ts` values, approval ids and the relevant D1 rows to this file,
then commit: `docs(notify): record phase 13 live verification`.

## Carried forward — deferred minor findings

Reviewed, judged non-blocking, and left for a follow-up:

- `sendNudge` does not refuse on a missing `SLACK_BOT_TOKEN` or
  `DASHBOARD_BASE_URL`; it attempts the call and lands on the sweeper's retry
  feed instead of naming the missing configuration.
- If `releaseNudge` itself fails after a failed send, that row stays claimed and
  un-nudged forever. It needs two consecutive D1 failures; a repair feed
  (`nudge_ts IS NULL AND nudged_at < now-N`) would close it.
- `chat.postMessage` returning `{ok:true}` without a string `ts` maps to
  `in_doubt` but has no covering test; the `"slack refused the send"` fallback
  reason and the outbound `content-type` header are likewise unasserted.
- A rate-limited send (`429` / `ok:false ratelimited`) is a TERMINAL `blocked`.
  This matches the pinned contract and the phase's no-retry rule — the human
  re-sends by hand — but it turns a transient condition into a permanent one.
- `resolveCodeModeScope` resolves the actor and the sender resolves the token
  separately; across a rotation boundary a run's recorded actor could name a
  different engineer than the token that posted. Harmless while the actor is
  only a gate.
- The `nudgeless()` test helper is duplicated verbatim across three test files.
- `PROVEN_PRE_UPSTREAM`'s comment in `effects.ts` says "refused before anything
  left this Worker", but a Slack `ok:false` now maps into it. The ledger outcome
  is right; the comment is not.
