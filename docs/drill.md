# Fire-drill runbook — cold-operator edition

This document assumes you have **never run a drill before**. Follow it literally, top to
bottom. You need: a browser already logged in to the dashboard at
`https://firefighter.sayandeten.workers.dev` (do the Cloudflare Access one-time-PIN dance
*before* you start), a Slack account that can post in `#test-firedrill`, and a terminal at
the repo root.

`#test-firedrill` is channel `C0BPGUXG5RS` (slug `firedrill`, mode `live`) — confirmed by
the pre-flight query in §2.3, which re-reads the table rather than trusting this line.

Your dashboard identity must be on the **fire-fighter roster**, not `VIEWERS`. A viewer can
watch everything, but the approval `PATCH` is refused Worker-side
(`apps/worker/src/access/roster.ts`).

---

## 1. What a drill is and what it costs

A drill posts real messages into a real Slack channel in Zellify's workspace and lets the
deployed agent act on them. Blast radius, stated plainly:

- **Slack.** The agent replies in the `#test-firedrill` thread under the on-duty engineer's
  user token. Everyone in the channel sees it. Messages cannot be unsent invisibly.
- **GitHub.** Scenarios 2 and 3 push a branch and open a **real pull request on
  `Zellify/web2app-rebuild`** — the product monorepo, not this repo — against `staging`.
  Watchers get notified; `pr-checks.yml` runs.
- **Linear.** A real `FIR-` issue lands in the `fire-fighter-testing` team. That team is
  pinned server-side, which is what keeps drills out of live work.
- **R2 and the open web.** Proof recordings are served **logged-out** at `/proofs/:key`.
  Anyone with the URL can play them.
- **Money.** Roughly $1–$2.50 of model spend per run, and a 2–3 minute container boot.
  The two runs that have actually shipped a PR cost $1.45 and $2.42.

**Undoable:** the open PR (close it) and its head branch (delete it). That is what
`apps/worker/scripts/undo-drill-pr.mjs` does. The Linear issue can be detached and re-filed
by hand.

**Not undoable** — quoting the undo script's own header:

> - the PR number and its closed record stay visible in the repo forever
> - the `pr-checks.yml` CI run stays in the Actions history
> - notifications already delivered to watchers cannot be recalled
> - the linear-code bot's comment/activity trace on the Linear issue

A **merged** PR cannot be undone by the script at all — it refuses, and tells you to revert
with a normal revert PR. **Do not merge drill PRs.** Human review on GitHub is the line.

---

## 2. Pre-flight

Run every check. Do not start a drill on a failed pre-flight.

All `wrangler` commands run **from `apps/worker`** and are prefixed `env -u CF_API_TOKEN` —
a `CF_API_TOKEN` in your environment breaks wrangler's OAuth on this account, and the failure
looks like an unrelated auth error.

### 2.1 Access gate is up

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://firefighter.sayandeten.workers.dev/api/counters
```

**Expected: `302`** — the Access login wall. Anything else means the dashboard API is exposed
or the origin is down. Stop.

### 2.2 Slack ingest is alive

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST -d '{}' \
  https://firefighter.sayandeten.workers.dev/slack/events
```

**Expected: `401`** — our own HMAC check rejecting a fake payload, which proves the request
*reached the Worker*. **A `302` here means ingest is DEAD**: Access is swallowing the webhook
route. Stop and fix the bypass before anything else.

### 2.3 The proof bypass is intact

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://firefighter.sayandeten.workers.dev/proofs/nope.mp4
curl -s -o /dev/null -w '%{http_code}\n' https://firefighter.sayandeten.workers.dev/api/artifacts
```

**Expected: `404` then `302`.** The 404 proves the request reached our code — `/proofs/*`
bypasses Access on purpose, because a proof video has to play for someone with no login,
from a PR body or a Slack unfurl. A **`302` on the first line means the bypass policy was
lost** and every recording link in every PR is now a login redirect. The 302 on the second
line is the login wall doing its job: every *other* artifact stays gated.

### 2.4 Channel policy is what this runbook assumes

```bash
cd apps/worker
env -u CF_API_TOKEN pnpm exec wrangler d1 execute firefighter --remote \
  --command "SELECT channel_id, name, customer_slug, mode FROM channels ORDER BY mode, name;"
```

**Expected:** `test-firedrill` and `ff-test` are `live`; `ext-zellify-sidehop` is `observe`.
If `test-firedrill` is not `live`, the agent cannot post there — `canPost()` fails closed —
and every scenario stalls at the first reply.

### 2.5 Ingest actually lands

Post the literal text `preflight ping` in `#test-firedrill` (it will not wake the agent),
then:

```bash
env -u CF_API_TOKEN pnpm exec wrangler d1 execute firefighter --remote \
  --command "SELECT COUNT(*) AS events_seen FROM events_seen;"
```

**Expected:** a count one higher than before the ping.

### 2.6 The read-only GitHub drill

This is the ship loop rehearsed against the real monorepo — the real diff applier on real
`staging` content, the real compare guard against real history — stopping before any POST.

```bash
cd apps/worker
pnpm exec tsx scripts/live-drill-readonly.mjs
```

It reads `MONOREPO_PAT` from the gitignored `apps/worker/.dev.vars` (key name only — never
paste the value anywhere).

**Green means:** every line reads `PASS`, and the summary line reads
`… passed, 0 failed | GitHub reads: N, writes: 0`. **`writes: 0` is mandatory** — the script
throws `INVARIANT VIOLATED` otherwise.

If `push grant is live` FAILS, remember the lesson that cost a day: **a fine-grained PAT and a
repository collaborator role are two independent gates, and both must be open.** The token's
settings page shows the ceiling; only `GET /repos/{owner}/{repo}` → `permissions.push` shows
the intersection. Nothing downstream of a false probe means anything. Stop and get the grant.

### 2.7 Recorded pre-flight output

Run 2026-08-16, against the deployed Worker at `05185b1`. **All green.**

```text
$ curl -s -o /dev/null -w '%{http_code}\n' .../api/counters
302

$ curl -s -o /dev/null -w '%{http_code}\n' -X POST -d '{}' .../slack/events
401

$ curl -s -o /dev/null -w '%{http_code}\n' .../proofs/nope.mp4
404
$ curl -s -o /dev/null -w '%{http_code}\n' .../api/artifacts
302

$ ... --command "SELECT channel_id, name, customer_slug, mode FROM channels ORDER BY mode, name;"
channel_id  | name                | customer_slug | mode
------------+---------------------+---------------+--------
C0BPA2L4BBP | ff-test             | firedrill     | live
C0BPGUXG5RS | test-firedrill      | firedrill     | live
C0B9YBENNAD | ext-zellify-sidehop | sidehop       | observe

$ ... --command "SELECT COUNT(*) AS events_seen FROM events_seen;"
events_seen
-----------
64

$ pnpm exec tsx scripts/live-drill-readonly.mjs
========================================================================
  Phase 20 ship loop — READ-ONLY live drill against Zellify/web2app-rebuild
========================================================================

  staging HEAD = b9d2a6daa66934afa37a65c47ab47e60c43b6b1a

  Tree entry the gateway WOULD post (no POST issued):
    {"path":"README.md","mode":"100644","type":"blob"}
    parents: ["b9d2a6daa66934afa37a65c47ab47e60c43b6b1a"]

------------------------------------------------------------------------
  PASS  push grant is live — permissions.push=true
  PASS  default branch is staging — staging
  PASS  contents API returns base64 — encoding=base64
  PASS  README.md round-trips as UTF-8 (gateway would accept it) — 491 bytes
  PASS  real applier produced a modify entry — kind=modify
  PASS  applier output is byte-exact (base + appended line)
  PASS  applier preserved mode 100644 — 100644
  PASS  basePaths names the modified file — ["README.md"]
  PASS  compare staging...staging = identical (guard ALLOWS) — identical
  PASS  compare staging...parent = behind (guard ALLOWS) — behind
  PASS  compare staging...dev is NOT contained (guard REFUSES) — status=diverged
------------------------------------------------------------------------
  11 passed, 0 failed | GitHub reads: 6, writes: 0
========================================================================
```

The `events_seen` figure is a baseline, not a target — 2.4 asks only that it grows.

---

## 3. The four scenarios

Shape for every scenario: post the message as yourself in `#test-firedrill`, playing a
customer. The agent does **not** reply instantly — it triages first, and triage emits only
`{wake, why, opening_prompt}`, never a ticket type. Then watch the dashboard: a new row in
the **runs list**, then the **live drawer** (triage decision, `run_code` turns, sandbox boot
notes), then — only when the model judges a reply committal — an **approval card** carrying
the draft, the model's reason, and Approve / Edit / Reject.

Approving is the click. The Worker then sends under the engineer's user token
(`src/approval/sender.ts`). You may also get one Block Kit DM nudge per approval; that is
delivery, not a second gate.

**What "normal" looks like, measured rather than hoped.** The last eight production runs took
**3–8 minutes** wall clock, and the one that went all the way to a review-ready PR took eight.
Every run gets its own cold container (`run:{runId}`) — there is no warming trick. **Two of
those eight ended `failed`**, so budget for a re-run rather than treating the first failure as
a broken system. Nothing notifies you when a run dies; you find out by watching. That gap is
the first item in the README's "what another week would buy".

### Scenario 1 — how-to question

1. Post:
   > hey — how do we point a customer's custom domain at their funnel? is there a set of DNS
   > records they need to add, or do we do it from our side?
2. **Dashboard:** a run appears, triage `wake: true` with a `why`. The live drawer shows the
   agent reading the thread, memory, and possibly the monorepo source. **No PR, no Linear
   issue, no sandbox needed** for a pure question — booting one is not a failure, just waste.
3. **The agent should** answer directly and technically in the thread. A clarifying or
   reversible answer is **sent, not escalated**, so the likely click count is **zero**. If the
   model judges its own answer committal, it escalates and you approve: **one** click.
4. **The agent should not** produce AI tells — no preamble, no "Great question!", no bulleted
   recap, no closing paragraph restating the answer.
5. **Pass:** a correct, direct answer in the thread, **0 or 1 clicks**, no AI tells.
   **Fail:** no answer; an answer that reads machine-written; or more than one approval card
   for one answer.

### Scenario 2 — small feature request

1. Post:
   > Can we take the Careers link out of the site navigation? We're not hiring right now and
   > applicants keep landing on a dead page. Small thing but it looks sloppy.

   If a previous drill already removed it, pick an equally small change that is visible on a
   page which renders **without auth**. This matters: a run once burned its entire budget
   looking for a way to log in and never recorded anything.
2. **Dashboard:** the sandbox boots (`run:{runId}`, boot notes advancing clone → install →
   build → browser; a full cold boot has measured 122–171 s), then the agent locates the code,
   edits it, and captures the diff.
3. **The agent should** make the change, verify it, file a `FIR-` issue, open a PR against
   `staging` with `Fixes FIR-<n>` as the **first line of the body**, poll `checkPR` until the
   `linear-code` linkback comment lands, move the issue to `In Review`, and reply in the thread
   with the PR and proof URLs. **None of that costs a click** — see §4. Only the
   customer-facing reply announcing the fix is committal.
4. **The agent should not** ask permission on the dashboard to open the PR. There is no such
   card; review happens on GitHub.
5. **Expected clicks: 1.** **Pass:** a PR meeting every check in §5, issue linked, one click
   total. **Fail:** any PR or Linear action gated on the dashboard; no PR; or a second PR from
   a retry — a retried run must *update* its PR, not open another.

### Scenario 3 — planted bug

This one needs setup **before** you post, because the bug lives on a branch and the PR must
diff against that branch, not `staging`.

1. **Plant the bug** on a branch of `Zellify/web2app-rebuild`, **in `apps/landing`**. That is
   the only app the live drills have ever booted and rendered in a container; `apps/web`, the
   dashboard and the funnel need Supabase and auth and have never been exercised there, so a
   planted bug in one of them is an unrehearsed gamble. Keep it small and visible without login.
2. **Point the deployment at that branch — both halves, or the run refuses:**
   - `GITHUB_BASE` in `apps/worker/wrangler.jsonc` (`vars`) → the planted branch.
   - `REPO_REF` in `apps/worker/src/sandbox/lifecycle.ts` — a code constant, `"staging"` by
     default → the same branch, so the container checks out what the PR diffs against.
   - Redeploy: `cd apps/worker && env -u CF_API_TOKEN pnpm run deploy`.

   Both, because these were once two uncoupled notions of "base": a sandbox on a planted
   branch with `GITHUB_BASE` still `staging` **would have shipped the planted bug into staging
   on merge**. The compare guard now refuses the mismatch — correct behaviour, but it looks
   like an unexplained refusal if you forget the coupling. Write the override down; §6 restores it.
3. Post a message describing the symptom you planted, in a customer's voice, e.g.:
   > The docs link in the footer points at the old domain — anyone clicking it lands on a
   > parked page. Been like that a while and it's the link we put in onboarding emails.
4. **Dashboard, in order:** run appears → sandbox boots → the agent writes a Playwright script
   and records the **failing** repro (the failing recording is a first-class result — it is the
   proof the bug was real) → applies the fix → re-runs the same script → keeps the **passing**
   recording → files the `FIR-` issue → opens the PR carrying the passing recording → polls
   `checkPR` for the linkback → moves the issue to `In Review` → escalates the customer reply.
   Approval card: **click approve.**
5. **The agent should not** skip the failing recording, merge anything, or send the customer
   more than one acknowledgment and one final message.
6. **Expected clicks: 1.** **Pass:** both recordings play logged-out at their `/proofs/…` URLs,
   the PR meets every check in §5, one click. **Fail:** missing failing recording; PR against
   the wrong base; a click demanded for the PR or the issue; or a duplicated customer message.

### Scenario 4 — large feature request

This is the scenario the roadmap uses as the click-count test.

1. Post:
   > We keep getting asked for multi-language funnels — German and French customers want
   > localized checkout flows and translated templates. This is becoming a dealbreaker on
   > renewals. What would it take, and when could we realistically have it?
2. **What this must produce**, per the design spec: follow-up questions to the customer
   (**sent, not escalated**), a Linear issue in `fire-fighter-testing` carrying a value /
   blocking / customer-weight assessment, and an honest acknowledgment in the thread that does
   not overpromise.
3. **Dashboard:** scoping questions go out **with no approval cards**; the `linear.createIssue`
   call lands directly; and at most **one** card appears, for the final committal
   acknowledgment.
4. **The agent should not** open a PR, attempt the feature in the sandbox, promise a date, or
   escalate its clarifying questions.
5. **Pass/fail is the roadmap's own criterion:** *"Count the clicks on the fourth — gating every
   reply fails it."* If every scoping question raises an approval card, the drill FAILS however
   good the issue is.

---

## 4. The click-count budget

A "click" is one Approve / Edit / Reject on the dashboard (`PATCH /api/approvals/:id`,
`apps/worker/src/api/approvals.ts`). In code there are exactly two routes a committal
capability can take, and only one of them reaches a human:

- **`approval.escalate` / `approval.withdraw`** (`src/codemode/bindings/approval.ts`), effect
  `control_write` — the **only** path that produces a card. The namespace takes no destination
  argument; channel and thread are snapshotted from the run's own scope. It is deliberately
  *not* gated by shadow or channel policy, so a shadow run can still draft and park.
- **`external_write` capabilities**, gated by `src/codemode/write-guard.ts` (channel policy +
  shadow, re-read from D1 at call time) plus the at-most-once effect ledger
  (`src/codemode/effects.ts`). No dashboard involvement, **zero clicks**.

| Capability | File | Effect | Costs a click? |
|---|---|---|---|
| `approval.escalate` / `withdraw` | `bindings/approval.ts` | `control_write` | **Yes — this *is* the click** |
| `slack.reply` (non-committal, `live` channel) | `bindings/slack.ts` | `external_write` | No |
| `github.openPR` | `bindings/github.ts` | `external_write` | **No** |
| `github.checkPR` | `bindings/github.ts` | `read` | No |
| `linear.createIssue` / `updateIssue` | `bindings/linear.ts` | `external_write` | **No** |
| `linear.findIssue` | `bindings/linear.ts` | `read` | No |
| `files.publish` | `bindings/files.ts` | `external_write` | No |
| `sandbox.*` (boot, exec, spawn, diff …) | `bindings/sandbox.ts` | `sandbox_write` | No |
| `browser.record` and friends | `bindings/browser.ts` | `sandbox_write` | No |
| slack / memory / linear / supabase / langsmith / betterstack reads | various | `read` | No |

This is the constraint made mechanical rather than promised: **the dashboard approves Slack
messages and nothing else.** Opening a PR and filing or updating a Linear issue must never
route through `approval.escalate` — a PR that costs a click fails scenario 4's count. Review
happens on GitHub.

**Scenario 4's total: at most 1 click** — the single committal acknowledgment. Every scoping
question and the Linear issue cost zero. **That passes.** An approval card per scoping question
would fail it.

---

## 5. Verifying the PR (scenarios 2 and 3)

Check every line with your own eyes.

1. **Base is `staging`** — or, if you did the scenario-3 override, exactly the planted branch.
2. **Branch and title follow the monorepo's convention:** `<type>/<2-4 kebab-case words>` and
   `<type>: <imperative>`, the same type in both.
3. **The first line of the body is `Fixes FIR-<n>`.** In the **body**, not the commit —
   commit-message magic words are switched off in this workspace, so a commit-only `Fixes`
   links nothing, silently.
4. **The `linear-code` bot has commented** on the PR naming the issue. That comment is the
   workspace's own receipt that "closes on merge" is wired.
5. **Zero AI attribution anywhere.** The forbidden list, verbatim from the monorepo's own
   conventions:
   > - No `🤖 Generated with [Claude Code]` or any AI-attribution footer.
   > - **No `Co-Authored-By: Claude …` trailers on commits made for this PR.**
   > - No `## Summary` / `## What changed` / `## Test plan` boilerplate.
   > - No emoji headers, badges, or marketing language.
   > - No restating every commit.

   Check the commits too. This monorepo's rule is the **opposite** of this repo's own commit
   convention; do not let the habit leak. `github.openPR` refuses — rather than silently
   rewrites — text containing attribution or smuggled headings.
6. **The proof recording plays logged-out.** Open the `/proofs/…` URL in a private window:
   expect 200, `video/mp4`, and a video that actually plays.
7. **The issue sits at `In Review`** in `fire-fighter-testing`, and the same proof URL appears
   in **both** the PR and the Slack thread.
8. **Do not merge.**

---

## 6. Undo

1. **Close the PR and delete its branch:**

   ```bash
   cd apps/worker
   pnpm exec tsx scripts/undo-drill-pr.mjs <pr-number>
   ```

   It reads `MONOREPO_PAT` from `.dev.vars`, prints the PR's state / head / base, **refuses a
   merged PR**, closes it if open, and deletes the head branch — refusing if that head is
   `staging`, `main`, `prod` or `dev`.
2. **Linear.** The script does not touch it. Detach the issue from the PR and re-file it to
   Backlog (or cancel the `FIR-` issue) by hand. The bot's activity trace stays.
3. **Restore the scenario-3 override** — skip if you never set it:
   - `GITHUB_BASE` → `"staging"` in `apps/worker/wrangler.jsonc`.
   - `REPO_REF` → `"staging"` in `apps/worker/src/sandbox/lifecycle.ts`.
   - `cd apps/worker && env -u CF_API_TOKEN pnpm run deploy`.
   - Delete the planted branch on `web2app-rebuild`.

   This is not optional hygiene. A forgotten override makes the *next* run open PRs against
   the planted branch.
4. **What stays behind forever:** the closed PR number and record, the Actions CI run, delivered
   notifications, the bot trace on the Linear issue, the drill messages in Slack, and the proof
   recordings in R2 at their `/proofs` URLs unless you delete them from the bucket by hand.

---

## 7. Known failure modes

Every row below is a defect a real drill found and no unit test could. All are fixed; their
symptoms are what a stuck drill looks like.

| Symptom | Cause | What to do now |
|---|---|---|
| Run dies `generation_cost_limit` with budget visibly unspent — once refusing a $0.13 step with $1.19 left | The spend guard reserves worst-case, pricing a mostly-cache-read prompt at the cache-*write* rate | Fixed; the cap is $5.00. If it recurs, suspect the reservation math before the model. |
| Run dies `step_limit` with money left — once at exactly 24 steps with $1.63 of $5.00 spent | The old ceiling was budgeted for exec-and-diff work; the ship loop's tail is 12–14 steps on its own | Fixed; the ceiling is 40. Dying at 40 means steps burned upstream — look for boot-poll storms or a login hunt in the drawer. |
| PR opens with **no `Fixes` line**, and the agent apologises for it in its own PR body | A prose defect, not broken plumbing: the `fixesIssueIds` doc said "UUIDs (from createIssue)", so the model believed it could not link a pre-existing issue | Fixed — `linear.findIssue({identifier})` exists and the prose is corrected. A PR still lacking the line should not be merged; say so. |
| Recording shows broken images, missing hero art, a dev-server issue badge | Sparse image exclusions: `public/` assets referenced by URL fail silently at runtime | Homepage assets are baked back in. **Deeper pages may still record with broken images** — a known image-layer gap, not a broken sandbox. Aim drills at landing pages. |
| The customer receives the same message twice, ~30 s apart | A `run_code` block timed out *after* its `slack.reply` had already left. "Abandoned" read as "nothing happened", so the model re-sent a rewrite the text-keyed ledger could not dedupe | Fixed — the timeout message now names what survived and instructs read-back plus identical-args retry. Read the abandonment message first if it recurs. |
| CI red on the PR because of `navbar.tsx`, drowning the real diff | `biome ci --changed` judges the whole touched file, and that file carries 229 pre-existing diagnostics including a cognitive complexity of 43 with no automatic fix | Expected, not a drill failure. The agent declines the ~850-line reformat and says so in the PR. Making that file green is a repo decision. |
| Re-posting the *identical* message after a failed run triages `wake: 0` | Memory carries the dead run's own optimistic "will post the video here" reply, so a fresh request reads as already in hand | Re-word the message rather than re-posting verbatim. The real fix is prompt-side and still open. |
| Run burns its whole budget "looking for a way to log in" and never records | An auth-gated target; the sandbox has no seeded account, so the login hunt is bottomless | Drill only against pages that render without auth. |
| Recording comes out with missing images *again*, after the image fix | The sparse-checkout pattern in `sandbox/Dockerfile` (which keeps the landing site's fonts, SVGs, webp and hero video) and the one in `sandbox/provision.sh` (which excludes all of `apps/landing/public`) **disagree**. The Dockerfile's pattern wins on the normal path because the repo is baked; `provision.sh` only clones as a fallback | A latent issue, not a regression: it means the run took the fallback clone. Note it and move on — do not debug it live. |
| Dev server "isn't up" though the process is running | Three apps default to port 3000, and 3000 is also the container's own control server — `waitForPort(3000)` succeeds against a dev server that never started | The agent starts the landing app on **4100** for exactly this reason. If you see 3000 in the drawer, that is the bug, not the port being busy. |
