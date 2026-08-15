# Phase 20 — PR and ship-loop Linear updates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **STATUS: DONE (2026-08-15).** Built, reviewed (five task reviews, a whole-branch review whose six
> seam findings were all fixed, and two fix rounds that closed a URL-traversal Critical), full suite
> green at 2133, deployed, and **proven LIVE**: PR #1507 on `Zellify/web2app-rebuild`, opened
> autonomously from a Slack message, with `Fixes FIR-4` as the first body line and the `linear-code`
> linkback confirming it. Closed and its branch deleted after review — nothing landed on `staging`.
>
> **The five live drills are the real record of this phase.** Each found a defect the 2133-test suite
> structurally could not, because each was a property of the live economics rather than of the code:
> a spend guard refusing a $0.13 step with $1.19 left, a step ceiling two turns above what the loop
> needs, a `Fixes` line the model believed it could not write, a sandbox with no images, and a
> customer told the same thing twice. All fixed and re-proven. Full account in
> [phase-20-notes.md](phase-20-notes.md).

**Goal:** From a `diffRef` and a recording URL the agent already has, a real pull request appears on the monorepo — base `staging`, the repo's exact body shape, `Fixes FIR-<n>` as the first body line, the recording under `## Screenshots`, no AI attribution anywhere — and the Linear issue moves to `In Review`, with the `linear-code` bot's linkback comment read back as proof the link took.

**Architecture:** One new Code Mode namespace, `github`, with one write and one read. The write has **ensure semantics**: it turns the stored diff into blobs → tree → commit → ref → PR via GitHub's REST Git Data API, entirely Worker-side, creating the branch and PR if absent and updating them if present — so a retried run converges on one PR instead of littering. The body is **rendered by the Worker from structured fields**, never accepted as model free text, which is what makes the repo's conventions (and its forbidden list) structurally unviolable rather than prompt-hoped. The sandbox never holds a token; the model never holds bytes.

**Tech Stack:** GitHub REST v3 (Git Data + Pulls, `https://api.github.com`, fixed origin), the Phase 18 diff store in R2, the Phase 09/10 effect ledger, Linear GraphQL (existing client).

**Spec:** `docs/superpowers/specs/2026-08-10-firefighter-agent-design.md` §7, §11.1. Roadmap: `00-roadmap.md` Phase 20. **Measured facts: [phase-20-notes.md](phase-20-notes.md) — current as of 2026-08-15; every claim below about the monorepo, the Linear workspace, and the token is argued from it, not re-derived.** Predecessors: [phase-18-sandbox-tier-2.md](phase-18-sandbox-tier-2.md) (the diff seam), [phase-19-ship-loop-proof.md](phase-19-ship-loop-proof.md) (the recording URL, and the un-drilled repro→fix→re-record cycle this phase inherits).

## Global Constraints

All of `00-roadmap.md` "Global Constraints" apply. The ones that bite here, plus the assignment constraints the notes copy out because they are easy to violate while writing plausible code:

- **The dashboard approves Slack messages and nothing else.** `openPR` and every Linear write route through the effect ledger and the write guard — **never through `approval.escalate`**. A PR that costs a click fails drill scenario 4's click count; review happens on GitHub.
- **One generic agent, no per-ticket-type pipelines.** `github.openPR` is a capability. The repro→fix→record→PR sequencing is the model's. This phase's Task 4 is the most likely place in the project to grow a `shipBugFix()` workflow by accident; a reviewer who sees one should reject it.
- **Model-authored code never touches raw credentials.** The token is resolved inside the gateway; the sandbox holds nothing; `gateways.ts` may not name a credential (the declarations test greps for exactly that).
- **The recording goes in BOTH places.** The roadmap's exit criterion names only the PR; the drill wants the thread too. The Slack side needs no new code — `RecordingStatus.url` is a plain string and `slack.reply` exists — so it is asserted in Task 6, where it would otherwise be nobody's job.
- **Commit after every task.** Conventional prefixes — and note the split-brain: **this** repo's commits carry the Claude trailer per its own convention; commits built for the **monorepo** PR must never (invariant 2).

## Depends on

Phases 18 and 19, merged and live: `diffRef` + the R2 `_internal/diff/` store, `RecordingStatus.url` at a public `/proofs` URL, the effect ledger (`runEffect`), the pinned-team Linear client, and the `identities` table with its GitHub OAuth connect flow (`src/oauth/github.ts`).

## Verified before planning — the notes file is the evidence, this is the digest

Everything numbered here was read from the live workspace/org on 2026-08-15 and is recorded with its provenance in [phase-20-notes.md](phase-20-notes.md).

1. **Push access exists.** The fine-grained PAT (`zillify-monorepo-read-write-pull-request`) was re-scoped in place to Contents + Pull requests read & write on `Zellify/web2app-rebuild` alone, org-approved. **The deployed secret is byte-identical — do not regenerate, nothing to reinstall.** The classic-PAT measurement that established the original blocker (push `false` on the monorepo, `true` on this repo) stands as the reason the on-duty engineer's OAuth token (`repo` scope, `src/oauth/github.ts`) is *unproven* for push during the trial. Hence decision 2: authoring identity is configuration.
2. **The Linear↔GitHub integration is live and org-wide** (ZEL-1771 ↔ PR #1489). PR↔issue linking is not per-team; `FIR-<n>` is expected to link, and the first PR of the drill is the probe that turns "expected" into "proven".
3. **Commit-message magic words are DISABLED workspace-wide.** `Fixes FIR-2` in a commit message links **nothing**, silently. `Fixes` in the **PR body** works — proven by PR #1491, whose two `Fixes` lines linked and closed with no identifier anywhere in the branch name. **Rule carried into this plan as invariant 2: the `Fixes` line lives in the PR body, first line, and nowhere else is trusted.**
4. **The repo's conventions are agent skills, not a PR template.** `m-create-pr`: branch `<type>/<short-slug>[-zel-<n>]` off fresh `staging` (never `dev` — ~1300 commits behind); title `<type>: <imperative>` ≤ ~70 chars; body exactly `Fixes` line(s) + `## Description` + `## Acceptance Criteria`, with `## Screenshots` the sanctioned home for the recording; `Part of ZEL-<n>` links without closing (the verb that keeps a partial fix from closing an epic). §6 forbids AI attribution: no `Co-Authored-By: Claude`, no generated-with footer, no `## Summary`/`## Test plan` boilerplate — **explicitly overriding any parent CLAUDE.md**.
5. **`Automatically link Linear issues` is OFF and must stay off** (on, it mints a phantom issue for every agent PR that misses its link). **Linkbacks on private repos are ON** — the `linear-code` bot comments each linked issue's title on the PR, which is what Task 4's `checkPR` reads back as verification.
6. **Labels are workspace-wide** (the `!`-prefix Devin-playbook filter in `client.ts` stays); **workflow states are team-scoped** (`updateIssue` already resolves within the pin — `In Review` is the state a PR-opened issue moves to, per ZEL-1771's own history). `issueCreate` wants label UUIDs while reads return names — already fixed at `src/linear/client.ts` (`7b9bb9f`), resolved at call time, not from a table.
7. **`staging` is the default branch and is protected**; protection does not block opening a PR into it. Release path `staging → prod` is never the fire-fighter's.
8. **Draft-first is the human lifecycle, not ours.** The skill's §7 allows a straight filled PR for a branch that already has work; the agent *always* has finished work by push time, and a draft would add a second write for no watcher. Decided: non-draft.

## The five decisions this plan makes

### 1. The PR is assembled Worker-side from the stored diff, parented on the sha the diff was cut against

`diff.ts` promised this moment: bytes go R2 → `readDiff`, never through the model. The Worker parses the unified diff, fetches each touched file's base content **at the base sha**, applies the hunks, and posts blobs → tree (`base_tree` = the base commit's tree) → commit (parent = base sha) → ref. Parenting on the *capture* sha rather than the current `staging` head means the patch applies against exactly the tree it was cut from — a context mismatch is then always a real staleness signal, refused readably ("re-run diff"), never a silent mis-apply. GitHub merges the resulting slightly-behind branch fine; that is what PRs are.

Two consequences: **Task 2** records `baseSha` at capture time (R2 `customMetadata`, invisible to the model — `DiffResult` and the `.d.ts` do not change), and **Task 1** builds a pure applier that refuses what it cannot do byte-exactly (binary patches, renames/copies) instead of approximating.

### 2. Target repo, head ref home, base branch, and authoring identity are configuration — pinned here for every task

Push permission is being verified separately, the trial identity differs from the production one, and a PR against the wrong repo is a silent failure of the whole loop. So nothing in this phase hardcodes them:

```ts
// src/git/commit.ts — resolved from wrangler vars at gateway construction
export type GithubShipConfig = {
  /** GITHUB_REPO — "owner/name". The repo the PR opens ON. Default: MONOREPO_SLUG from src/sandbox/class.ts. */
  repo: string;
  /** GITHUB_HEAD_REPO — "owner/name". Where the head REF is pushed. Default: repo.
   *  This is the notes' fork hygiene kept alive: blobs/tree/commit/ref land here, and the
   *  PR's head is `<headOwner>:<branch>` — so a fork flow, if ever needed again, is one
   *  var and zero code. `findPR` filters by the same qualified head. */
  headRepo: string;
  /** GITHUB_BASE — the PR base ref. Default: "staging". Never "dev". */
  base: string;
  /** GITHUB_AUTHOR — whose token authors the commit and PR. */
  author: "on-duty" | "worker-pat";
};

export interface GithubAuthSource {
  /** The authoring token, or null when the configured identity has none.
   *  "on-duty": the shift engineer's decrypted GitHub OAuth token
   *  (identities row, provider "github" — src/identity/tokens.ts).
   *  "worker-pat": env.MONOREPO_PAT — the re-scoped fine-grained PAT. */
  token(nowMs: number): Promise<{ token: string } | null>;
}
```

Trial default: `GITHUB_AUTHOR="worker-pat"` (the only identity *measured* to push). Handover flips one var to `"on-duty"` — same code path, per the production design where the PR opens as the shift engineer. `openPR`'s result reports the authoring `login` read from `GET /user`, so the drill can assert identity instead of assuming it. The API origin itself is a fixed constant, same rule as `LINEAR_ORIGIN` — an origin that can be configured is an origin that can be redirected.

### 3. The `Fixes` line is a structured argument the Worker renders — never model free text

Because the magic-words toggle is off (fact 3), the PR body's first line is the **only** thing standing between "closes on merge" and a silently inert link — too load-bearing for prompt discipline. So the binding takes Linear issue **ids** (the UUIDs `linear.createIssue` already returns), resolves each through the team pin, and renders `Fixes FIR-<n>` itself; `partOf` renders `Part of FIR-<n>` for issues the PR advances but does not complete (the verb that exists so an epic cannot be closed by a partial fix). A model-supplied team id remains absent from every schema and unreachable at runtime — resolution happens inside the pinned gateway.

The rest of the body is rendered the same way, from `description` + `acceptanceCriteria[]` + `proofUrl` + `notesForReviewers`, into the repo's exact template. Boilerplate headings and attribution footers are thereby not merely forbidden but *unwritable*; free-text fields and the commit message are additionally screened for attribution patterns and refused — not stripped, refused, so the model learns (invariant 2).

### 4. `openPR` has ensure semantics: one branch, one PR, converged on retry

Roadmap Task 5's "a retried run updates its PR" falls out of making the write idempotent at three layers: the **ledger** (`runEffect` with every meaning-bearing field in the key — an exact retry replays the recorded result without touching GitHub); the **ref** (create if absent, force-update if present); and the **PR** (`GET /pulls?head=owner:branch` → `PATCH` title/body if open, else `POST`). `reconcile` for the in-doubt 5xx path is `findPR(branch)` — decidable because the branch names the work, same shape as `findIssue`. A second call with a *different* diffRef is a different effect key and lands as an update to the same PR: that is the "model improves the fix and re-ships" path, free.

### 5. Linking is verified by reading, not assumed

`github.checkPR` (a `read`) returns PR state plus whether the `linear-code` bot's linkback comment exists and which identifiers it names. That comment is the workspace's own receipt that the `Fixes` line resolved (fact 5); a wrong or unmatched identifier is visible without opening Linear. The `.d.ts` prose tells the model: after opening a PR that fixes an issue, poll `checkPR` until the linkback confirms, and report a missing linkback as a problem rather than assuming success.

## Outcome

- The model: `diff()` → `createIssue` (or reuse) → `openPR({branch, title, commitMessage, description, acceptanceCriteria, fixesIssueIds, proofUrl, diffRef})` → poll `checkPR` → `updateIssue({state: "In Review"})` → `slack.reply` with the proof URL. Every arrow is the model's decision; no step knows about the others.
- A retried or resumed run converges on the same PR.
- The PR is indistinguishable from one a Zellify engineer opened by the book — because the book (the repo's own skills) is compiled into the renderer.

## What this phase deliberately does not do

- **No merge.** "Merged after human review" is the assignment's line; the agent stops at a reviewable PR.
- **No git push from the sandbox.** The sentinel path could now carry `git-receive-pack`, but the Worker-side Git Data path is the one that keeps the container credential-free and the commit deterministic. One write path, not two.
- **No draft PRs** (fact 8) and no `gh` CLI.
- **No rename/copy/binary handling in the applier.** A fire-fighter's fix that renames files or edits images is a job for a human PR; the applier refuses readably rather than approximating (invariant 6).
- **No new Slack code.** The proof URL travels through the existing `slack.reply`.

## Non-negotiable invariants

1. **No credential in the container, no bytes through the model.** The PR path is Worker-side only; `openPR` takes a `diffRef`, never a patch. `src/codemode/` never sees `Env`.
2. **The `Fixes <id>` line lives in the PR body — first line(s), Worker-rendered — because commit-message magic words are disabled workspace-wide.** Nothing may rely on a commit message or branch name for linking. And **no AI attribution in anything bound for the monorepo**: `Co-Authored-By: Claude` trailers, generated-with footers, and boilerplate headings are refused at the schema/renderer, per the repo skill's §6 which overrides this repo's own commit convention. The two repos have opposite rules; the renderer is the wall between them.
3. **The team pin is total.** Link targets resolve only through the pinned team; a foreign issue id is `linear_team_denied`; a model-supplied team id remains absent from every schema and rejected at runtime; the `!`-prefix label filter stays.
4. **Base is configuration and defaults to `staging`.** `dev` is refused by name even if configured — it is abandoned, and a PR against it is a silent no-op review.
5. **Upstream echo is bounded and scrubbed.** GitHub's 422s quote back what you sent; error text surfaced to the model is trimmed and passed through the same dev-env redaction the sandbox output uses.
6. **The applier is byte-exact or it refuses.** No fuzzy context matching, no whitespace forgiveness. A hunk that does not match its base is a staleness fact the model must act on ("re-run diff"), and the message names the file.
7. **One PR per branch, ever.** Ensure semantics at ref, PR, and ledger; `reconcile` by head ref.

## File structure

- Create: `src/git/apply.ts` (pure unified-diff applier), `src/git/commit.ts` (`GithubGateway`: REST client, auth source, config), `src/codemode/bindings/github.ts` (the namespace)
- Create tests: `test/git-apply.test.ts`, `test/github-gateway.test.ts`, `test/codemode-github.test.ts`
- Modify: `src/sandbox/diff.ts` (+`baseSha` metadata, +`readDiffWithBase`), `src/sandbox/gateway.ts` (capture the sha), `src/linear/client.ts` (+`resolveLinkTargets`), `src/codemode/bindings/linear.ts` (`## Notes` render), `src/codemode/gateways.ts` (+`GithubGateway`, +`CapabilityDependencies.github`, +`LinearGateway.resolveLinkTargets`), `src/codemode/registry.ts` (11th namespace), `src/index.ts` (Env vars, gateway wiring), `apps/worker/wrangler.jsonc` (`GITHUB_REPO`, `GITHUB_HEAD_REPO`, `GITHUB_BASE`, `GITHUB_AUTHOR`), generated `.d.ts`
- Extend tests: `test/sandbox-diff.test.ts`, `test/codemode-linear.test.ts`, `test/codemode-dts.test.ts`, `test/codemode-contracts.test.ts`
- Nothing manual outside the repo: the Access bypass, the R2 bucket, and the re-scoped PAT all already exist.

## Pinned interfaces — both sides of every wave code against these verbatim

Renaming or widening any of these is a review finding, not a judgment call.

```ts
// src/git/apply.ts — pure, no I/O, no Env
export type FileChange =
  | { kind: "modify" | "create"; path: string; content: string; mode: "100644" | "100755" }
  | { kind: "delete"; path: string };
/** Parse a git unified diff and apply it to base contents. `base` maps path →
 *  file text for every path the patch touches (absent key ⇒ created file).
 *  Throws CapabilityError("invalid_input", …) naming the file for: binary
 *  patches, rename/copy headers, and any hunk whose context does not match
 *  byte-for-byte. */
export function applyUnifiedDiff(patch: string, base: Map<string, string>): FileChange[];
/** The paths the patch reads from the base tree (modify+delete; not creates). */
export function basePaths(patch: string): string[];

// src/sandbox/diff.ts — additions (model-visible DiffResult UNCHANGED)
export async function captureDiff(env: Env, runId: string, raw: string, baseSha: string): Promise<DiffResult>;
export async function readDiffWithBase(env: Env, diffRef: string): Promise<{ patch: string; baseSha: string } | null>;

// src/codemode/gateways.ts — additions
export type PullRequestRef = {
  number: number; url: string; headRef: string;
  /** GET /user's login for the authoring token — the identity the PR opened under. */
  author: string;
  /** True when an existing branch/PR was updated rather than created. */
  updated: boolean;
};
export type PullRequestStatus = {
  state: "open" | "closed" | "merged"; url: string; headRef: string; baseRef: string;
  /** The linear-code bot's linkback receipt: present, and which identifiers it names. */
  linearLinkback: { commented: boolean; identifiers: string[] };
};
export interface GithubGateway {
  openPR(input: {
    branch: string; title: string; commitMessage: string;
    /** Fully rendered by the BINDING (conventions are policy); the gateway is transport. */
    body: string;
    diffRef: string; idempotencyKey: string;
  }): Promise<PullRequestRef>;
  /** Reconcile: the open PR whose head is `branch`, or null. */
  findPR(branch: string): Promise<PullRequestRef | null>;
  checkPR(number: number): Promise<PullRequestStatus>;
}
// LinearGateway addition — Task 5 implements, Task 4 consumes, tests stub:
//   resolveLinkTargets(issueIds: string[]): Promise<Array<{ id: string; identifier: string }>>
//   (order-preserving; throws linear_team_denied on any foreign issue, invalid_input on any unknown)
```

## Execution speed rules — READ BEFORE DISPATCHING ANY TASK

Same regime as Phases 11–19; overrides per-step commands wherever they conflict. Nothing in this phase builds an image or pushes to a registry — the whole build surface is Worker TypeScript — so the waves are wide and the wall-clock ceiling is the live drill, not the build.

1. **Wave A is five writers wide** — Tasks 1, 2, 3, 5, and Task 4's Steps 1–4. File sets are disjoint (see the table); the seams are pinned above. Do not serialise for a pinned signature. Only Task 4's Step 5 (the `.d.ts` regeneration) waits for the merged tree.
2. **Task 4 stubs both gateways.** `GithubGateway` and `resolveLinkTargets` are pinned; the binding's tests run against fakes and must not wait for Tasks 3 or 5.
3. **Focused tests by exact path:** `cd apps/worker && pnpm exec vitest run test/<exact-file>.test.ts`. Never a pattern.
4. **One `pnpm exec tsc --noEmit -p tsconfig.json` per task**, at the end of that task.
5. **The full worker suite runs exactly once**, at the Gate. `codemode:dts:check` regenerates inside Task 4, so drift never blocks the suite run.
6. **Review depth:** deep for Task 1 (a subtly wrong applier corrupts a PR several turns downstream, the exact failure `diff.ts` was built to prevent) and Task 4 (this phase's conventions-and-attribution wall lives there); medium for Tasks 3 and 5; light for Task 2.
7. **Dispatch = the task's own text + Global Constraints + Non-negotiable invariants + the pinned interfaces + these rules.** Task 4's subagent additionally reads `phase-20-notes.md` §"Conventions" and §"The real trap" — the body template and the magic-words fact are requirements, not background. Task 3's reads `src/linear/client.ts` for the error-mapping idiom it mirrors. No wider exploration.
8. **Task 6 is NOT subagent-drivable.** It needs a deployed Worker, a human planting a bug, a logged-out browser, and eyes on a live PR in the org's repo. Run it interactively and record what actually happened.
9. **The push probe runs BEFORE Wave A dispatches** — see "Pre-flight" below. It is the one 30-second check that can invalidate the phase's exit criteria, so it must not sit behind five build tasks. A false result does NOT hold Wave A: the code is correct regardless of who can push; it means the drill needs a human-latency grant, and learning that on minute one is the point.
10. **No new dependencies.** The applier is hand-rolled against git's own well-formed output; the REST client is `fetch`. No octokit, no diff library.
11. **Commit after every task**, conventional prefixes — in THIS repo, with this repo's trailer. The renderer under test is what keeps that trailer out of the monorepo.

### Parallel wave schedule

| Wave | Tasks (concurrent) | Why safe |
|---|---|---|
| A | **1** ∥ **2** ∥ **3** ∥ **4 (Steps 1–4)** ∥ **5** | disjoint: 1 owns `git/apply.ts`; 2 owns `sandbox/diff.ts`+`sandbox/gateway.ts`; 3 owns `git/commit.ts`+`index.ts`+`wrangler.jsonc` **and is sole owner of `gateways.ts`'s Github block + `CapabilityDependencies.github`**; 4 owns `bindings/github.ts`+`registry.ts`, touches `gateways.ts` not at all, and tests against stubs of both gateways (rule 2); 5 owns `linear/client.ts`+`bindings/linear.ts` and adds exactly one pinned method line to `LinearGateway`. `gateways.ts` therefore has exactly TWO writers, in disjoint verbatim-pinned regions — a textual merge |
| B | **4, Step 5 alone** | the `.d.ts` regeneration needs every namespace's real surface stable; it is one command plus its check on the merged tree, not a task-length wave |
| C | Gate: full suite + deploy | serial, once |
| D | **6** | live drill — interactive, human-in-the-loop, not dispatchable |

## Task order

### Pre-flight — the push probe (30 seconds, before dispatching anything)

- [x] `GET /repos/Zellify/web2app-rebuild` with `MONOREPO_PAT` and assert `"permissions": { "push": true }`. **A false result does not stop Wave A** — every build task is correct regardless of who can push. It means Task 6's drill needs a repo-collaborator grant first, which is a *different* org setting from the fine-grained-PAT approval that already landed — so if it comes back false, tell the human immediately and let that grant's latency run in parallel with the waves instead of being discovered at drill time. Record the probe's result in `phase-20-notes.md` either way.

### Task 1 — The applier: a git unified diff, applied byte-exactly or refused

**Files:** create `src/git/apply.ts`, `test/git-apply.test.ts`.

Pure functions, no I/O — the reason it can be tested to death without GitHub. Input diffs are git's own output (`git add -A -N && git diff`), which pins the dialect: `diff --git` headers, `new file mode`/`deleted file mode`, `@@ -a,b +c,d @@` hunks, `\ No newline at end of file` markers.

- [x] **Step 1: Failing tests, the happy paths.** Modify one file (content and line numbers shift correctly across multiple hunks); create a file (`new file mode 100644`, base has no key, result `kind:"create"`); delete a file (`deleted file mode`, result `kind:"delete"`); executable bit (`100755` preserved on create and modify); a file whose *content lines* start with `++`/`--` (TOML front matter — the parseStats trap from `diff.ts`, same fix: hunk state, not prefix guessing); `\ No newline at end of file` on both sides (the result must NOT gain a trailing newline the file never had); CRLF content passing through byte-exact; multi-file patches applied in order; `basePaths` returning modify+delete paths and not creates.
- [x] **Step 2: Failing tests, the refusals.** `GIT binary patch` and `Binary files … differ` → `invalid_input` naming the file and saying binary changes need a human PR; `rename from`/`copy from` → `invalid_input` naming the file; a hunk whose context lines do not match the base byte-for-byte → `invalid_input` naming file and hunk and telling the model the diff is stale ("re-run diff and try again"); a patch touching a path `base` lacks for modify/delete → same staleness refusal; an empty/garbage patch → `invalid_input`. **No fuzzing, no offset search:** git cut this diff from the exact tree we fetch, so any mismatch is real staleness (decision 1) — a "helpful" fuzzy match is how a wrong line gets edited in a customer's repo.
- [x] **Step 3: Implement.** Parser produces per-file: old/new path, kind, mode, hunks (start line + ordered `' '`/`'+'`/`'-'` lines + no-newline flags). Applier walks base lines by hunk offsets, verifying every context and deletion line before emitting. Keep it under ~250 lines; the test file will be longer than the module, and should be.
- [x] **Step 4:** Focused run green, `tsc` clean. Commit: `feat(git): unified-diff applier — byte-exact or refused`

### Task 2 — The base sha travels with the diff

**Files:** modify `src/sandbox/gateway.ts` (~`DIFF_COMMAND`, line 148, and the `captureDiff` call at ~457), `src/sandbox/diff.ts`; extend `test/sandbox-diff.test.ts`.

- [x] **Step 1: Failing tests.** `captureDiff(…, baseSha)` stores `baseSha` in the object's `customMetadata` beside `runId`; `readDiffWithBase` returns `{patch, baseSha}` for a valid ref and `null` for an unknown or malformed one (same `DIFF_REF` validation — a ref is model-visible and stays validated-not-pasted); the model-visible `DiffResult` shape is **unchanged** (assert the returned keys exactly — no `.d.ts` churn is the point); `readDiff` still works for any caller that only wants text.
- [x] **Step 2: Implement.** In `gateway.ts`, run `git rev-parse HEAD` as its own exec **before** the diff command (not concatenated — mixed stdout parsing is how a sha ends up inside a patch), and pass the trimmed sha through. In `diff.ts`, thread the parameter and add `readDiffWithBase`. One caveat to document inline: the store is content-addressed, so two runs producing identical bytes from different base shas share one object and the second write's metadata wins — acceptable, because identical bytes applying at either sha is exactly what byte-exact context verification checks at apply time.
- [x] **Step 3:** Focused run green, `tsc` clean. Commit: `feat(sandbox): record the base sha a diff was cut against`

### Task 3 — The GitHub gateway: blobs → tree → commit → ref → PR, ensure semantics

**Files:** create `src/git/commit.ts`, `test/github-gateway.test.ts`; modify `src/codemode/gateways.ts` (**this task is the sole owner of the pinned Github block there** — `PullRequestRef`, `PullRequestStatus`, `GithubGateway`, and the `CapabilityDependencies.github` field, verbatim from "Pinned interfaces"), `src/index.ts` (Env: `GITHUB_REPO`, `GITHUB_HEAD_REPO`, `GITHUB_BASE`, `GITHUB_AUTHOR`; construct the gateway into `CapabilityDependencies`), `apps/worker/wrangler.jsonc` (the vars: `"Zellify/web2app-rebuild"`, head-repo unset ⇒ same, `"staging"`, `"worker-pat"`).

Implements the pinned `GithubGateway` + `GithubShipConfig` + `GithubAuthSource` (decision 2). Fixed origin `https://api.github.com`; `User-Agent: firefighter-worker` on every request (GitHub 403s without one — `src/oauth/github.ts` already learned this). Error mapping mirrors `src/linear/client.ts`'s `upstreamError` split: 401/403/404-on-repo → `capability_unavailable` ("not authorised / not found, nothing was opened"); 422 → `invalid_input` with GitHub's message **trimmed and dev-env-redacted** (invariant 5); network/5xx → `upstream_unavailable`, in-doubt, reconciled by `findPR`.

- [x] **Step 1: Failing tests, auth + config,** over a stubbed `fetch`: `worker-pat` mode resolves `env.MONOREPO_PAT` and null when unset; `on-duty` mode resolves the shift engineer's decrypted `github` identity row (via `onDuty` + `getDecryptedToken`, the `user-token.ts` pattern) and null when unconnected — null is a `capability_unavailable` with a message naming the fix ("connect GitHub on the dashboard" / "set MONOREPO_PAT"); a configured base of `dev` is refused at construction by name (invariant 4); the repo slug defaults to `MONOREPO_SLUG` when the var is absent.
- [x] **Step 2: Failing tests, the write path,** asserting the exact REST sequence and payloads: reads `{patch, baseSha}` via `readDiffWithBase` (null → `invalid_input` "unknown or expired diffRef"); fetches each `basePaths` file at `?ref=<baseSha>` and base64-decodes; applies via `applyUnifiedDiff`; posts blobs only for create/modify; posts a tree with `base_tree` = the base commit's tree, `sha: null` entries for deletes, modes from the applier; posts the commit with `parents: [baseSha]` and the given message; **ref ensure** — on `headRepo`: `POST refs` on 404, force-`PATCH` on existing; **PR ensure** — on `repo`: `GET pulls?head=<headOwner>:branch&state=open` → `PATCH` title/body (result `updated: true`) or `POST` with `base` from config and the same qualified head; result carries the `/user` login as `author`. A test where `headRepo` differs from `repo` pins the fork path's shape without a fork existing. Staleness from the applier propagates untouched (it is already a readable `invalid_input`).
- [x] **Step 3: Failing tests, the reads.** `findPR` maps the head-filtered list to `PullRequestRef`/null; `checkPR` merges `GET pulls/{n}` with `GET issues/{n}/comments`, recognising the linkback by the bot author (`linear-code`, tolerant of GitHub's `[bot]` suffixing) and extracting `[A-Z]+-\d+` identifiers from its body; no comment → `{commented: false, identifiers: []}`, which is a *fact for the model*, not an error.
- [x] **Step 4: Implement.** Keep the module transport-only: no body rendering, no convention knowledge — that is Task 4's wall, and a reviewer finding a template string in this file should reject it.
- [x] **Step 5:** Focused run green, `tsc` clean. Commit: `feat(git): worker-side PR assembly — blobs to tree to commit to ref to PR, ensured`

### Task 4 — The `github` namespace: where the conventions are compiled

**Files:** create `src/codemode/bindings/github.ts`, `test/codemode-github.test.ts`; modify `src/codemode/registry.ts` (append `"github"` to `PHASE_09_NAMESPACES` — at the END, eleventh), regenerate the `.d.ts`; extend `test/codemode-contracts.test.ts`. **This task does NOT touch `gateways.ts`** — Task 3 owns the Github block there and Task 5 the one Linear line; this task imports the pinned types and runs its tests against stubs of both gateways (speed rule 2). **Steps 1–4 run in Wave A; Step 5 (the `.d.ts` regeneration) is Wave B, alone, on the merged tree.** One deliberate consequence: this task's per-task `tsc` (rule 4) ALSO waits for Step 5 — the binding names `ctx.deps.github`, a field Task 3 owns, so on this task's own Wave-A tree the typecheck cannot pass and must not be attempted. Steps 1–4 verify by focused vitest, which runs fine against stubs because types are stripped at runtime.

Two methods: `openPR` (`external_write`, through `runEffect` with `reconcile: findPR(branch)`) and `checkPR` (`read`). The input schema and renderer are the enforcement of facts 3–4 and invariants 2–3:

```ts
const CONVENTIONAL = ["feat","fix","chore","docs","refactor","perf","test","ci"] as const;
input: z.strictObject({
  branch: z.string().regex(/^(feat|fix|chore|docs|refactor|perf|test|ci)\/[a-z0-9]+(?:-[a-z0-9]+)*$/).max(45),
  title: z.string().regex(/^(feat|fix|chore|docs|refactor|perf|test|ci): \S/).max(70),
  commitMessage: z.string().min(1).max(2000),
  description: z.string().min(1).max(2000),
  acceptanceCriteria: z.array(z.string().min(1).max(200)).min(1).max(10),
  /** Linear issue UUIDs (from createIssue). Rendered as `Fixes <identifier>` — closes on merge. */
  fixesIssueIds: z.array(z.string().min(1).max(200)).max(5).default([]),
  /** Rendered as `Part of <identifier>` — links WITHOUT closing. Use for umbrella issues. */
  partOfIssueIds: z.array(z.string().min(1).max(200)).max(5).default([]),
  /** A /proofs recording URL from checkRecording — lands under ## Screenshots. */
  proofUrl: z.string().url().max(500).optional(),
  notesForReviewers: z.string().min(1).max(2000).optional(),
  diffRef: z.string().min(1).max(200),
})
```

- [x] **Step 1: Failing tests, the renderer** (a pure function in the module, tested directly): body is exactly `Fixes FIR-…` line(s) first (one per resolved id, consecutive — PR #1491's proven shape), then `Part of` lines, blank line, `## Description` with the paragraph, `## Acceptance Criteria` as `- [ ]` items, `## Screenshots` with the bare proof URL only when given, `## Notes for reviewers` only when given. **Nothing else can appear** — no Summary, no Test plan, no footer, structurally.
- [x] **Step 2: Failing tests, the refusals.** Attribution patterns (`/co-authored-by/i`, `/generated with/i`, `/🤖/u`, `/\bclaude\b/i`) in `commitMessage`, `description`, or `notesForReviewers` → `invalid_input` naming the field and quoting the repo rule ("this repository forbids AI attribution in PRs and their commits") — refused, not stripped; a `proofUrl` that is not `https` or exceeds the cap → refused; `fixesIssueIds` resolving through a stubbed `resolveLinkTargets` that throws `linear_team_denied` → the error surfaces untouched; both id lists empty is allowed (a PR may precede its issue — the body simply starts at `## Description`).
- [x] **Step 3: Failing tests, the wiring.** Both methods branded by `auditedCapability`; `openPR` is `external_write`, `checkPR` is `read`; `"github"` appended LAST in `PHASE_09_NAMESPACES`; the effect key contains branch, title, commitMessage, the **rendered** body, and diffRef (each changes what gets opened; the rendered body folds the resolved identifiers in, so a relinked issue is a new effect); reconcile calls `findPR` with the branch; method names globally unique after PascalCase derivation.
- [x] **Step 4: Implement.** `.d.ts` prose is prompt engineering, and this namespace's carries the workflow the assignment grades: branch off the convention (`fix/<2-4 words>`); the `Fixes` line is generated from `fixesIssueIds` — never write "Fixes" into any text field yourself, and never into a commit message, where it links nothing; `Part of` for umbrella issues so a partial fix cannot close an epic; put the recording's URL in `proofUrl` AND in your Slack reply — the customer and the reviewer each get the proof; after opening, poll `checkPR` until `linearLinkback.commented` confirms the link took, and say so if it never does; a second `openPR` on the same branch updates the PR — improving the fix is cheap.
- [x] **Step 5 (Wave B — alone, on the merged tree):** Regenerate declarations, `codemode:dts:check` clean, focused runs green, `tsc` clean. Commit: `feat(codemode): the github namespace — a PR by the repo's own book`

### Task 5 — Linear grows its ship-loop half

**Files:** modify `src/linear/client.ts`, `src/codemode/bindings/linear.ts`, `src/codemode/gateways.ts` (the one pinned method line); extend `test/codemode-linear.test.ts`.

- [x] **Step 1: Failing tests, `resolveLinkTargets`.** Resolves each id to `{id, identifier}` preserving input order; any issue outside the pinned team → `linear_team_denied` naming the team, the whole call refused (a partially-rendered Fixes block is worse than none); unknown id → `invalid_input`; empty input → `[]` with zero requests. Reuses the `requirePinnedIssue` idiom — one GraphQL query per id is fine at `max(5)`.
- [x] **Step 2: Failing tests, the issue-shape reconciliation** (roadmap Task 4 + the notes' ruling): `renderDescription` keeps every structured assessment field verbatim but renders them under a `## Notes` heading instead of the bare `---` divider — the repo's `m-create-linear-task` shape, where Notes is the sanctioned home for what native fields don't carry. Existing Phase 09 tests that pinned the old divider are updated to pin the new shape; platformValue/blocking/customerWeight/evidence remain assertable line-by-line.
- [x] **Step 3: Implement both.** The `!`-prefix label filter and the call-time id resolution are untouched — they are load-bearing (notes §labels) and any "simplification" of them is a review rejection.
- [x] **Step 4:** Focused run green, `tsc` clean. Commit: `feat(linear): link-target resolution under the team pin, and the Notes-shaped assessment`

### Gate — the full suite, once (speed rule 5)

- [x] On the merged result of waves A+B: `cd apps/worker && pnpm exec vitest run` and one `tsc --noEmit`. Green is the entry ticket to Task 6. Deploy here — the drill runs against the deployed Worker.

### Task 6 — Live drill: the inherited cycle, then the ship

Interactive, human-in-the-loop, not dispatchable (speed rule 8). This is where **Phase 19's un-drilled exit criterion comes home**: the planted-bug **repro → fix → re-verify → re-record** cycle was rolled into this phase because its natural consumer is the PR; it is REQUIRED here, not optional polish. Everything goes in `phase-20-notes.md` as it happens.

- [x] **Step 1: Re-assert the pre-flight probe, now against the deployed configuration.** `GET /repos/$GITHUB_HEAD_REPO` (the repo the ref actually lands on — `$GITHUB_REPO` when unset) with the deployed PAT: `"permissions":{"push":true}`. The pre-flight ran on minute one; this re-run is cheap and catches anything that changed since (a var edit, a token event). If false here: STOP — unlike the pre-flight, nothing downstream of this point is meaningful without the grant.
- [x] **Step 2: Plant the bug.** A human plants a small reproducible UI bug on a branch of the monorepo (Phase 19's rehearsed move — auth-free landing page, per its drill lessons). For the drill, point `GITHUB_BASE` at the planted branch so the PR diff shows only the fix — this is precisely why base is configuration (decision 2); note the override and its restoration in the notes.
- [x] **Step 3: Fire the drill in `#test-firedrill`.** The agent, unscripted: boot → check out the planted branch → dev server → Playwright repro that FAILS, recorded → apply the fix → repro PASSES, recorded. Both recordings at `/proofs` URLs. **This closes Phase 19's caveat; say so explicitly in both phases' notes when it happens.**
- [x] **Step 4: The ship.** Still unscripted: `createIssue` (FIR-, assessment under `## Notes`, tier+type labels) → `diff` → `openPR` with `fixesIssueIds`, the passing recording as `proofUrl` → `checkPR` until the linkback lands → `updateIssue` to `In Review` → `slack.reply` with the proof URL in the thread.
- [x] **Step 5: Verify with eyes, and the first FIR- linkback is the probe** (fact 2 promoted from "expected" to "proven" — record it): PR base/branch/title/body match the convention exactly; `Fixes FIR-<n>` is line one; **zero** attribution anywhere — `git log --format=full` on the PR branch shows no `Co-Authored-By`; the commit's author is the configured identity and matches `PullRequestRef.author`; the `linear-code` comment names the right issue; the issue sits at `In Review`; the PR's diff is byte-identical to the stored patch (`git diff` the PR branch against base and compare); both recordings play logged-out; the thread carries the proof URL. Re-fire the same drill message once: the SAME PR, updated — not a second one.
- [x] **Step 6: Do not merge.** Human review is the assignment's line; "closes on merge" is verified by the linkback receipt plus workspace behavior already proven on ZEL PRs (#1491). If Ronit merges during the trial, record the auto-close as observed.
- [x] **Step 7:** Record timings, every invented model API, and any defect found, in `phase-20-notes.md`. Commit: `docs(git): record phase 20 live verification — the ship loop, end to end`

## Exit criteria

A drill message becomes: a failing recording, a fix, a passing recording, a FIR- issue with the assessment under `## Notes`, and a pull request on the configured repo — base `staging` (config), convention-shaped, `Fixes FIR-<n>` first line of the body, the recording under `## Screenshots`, zero AI attribution, authored under the configured identity — with the `linear-code` linkback read back as proof, the issue at `In Review`, and the proof URL in the customer's thread. A re-fired drill updates that PR instead of opening a second. Phase 19's repro→fix→re-record cycle has run live, and both phases' notes say so.

## Downstream handoff

**Phase 21** needs nothing from this phase's plumbing — voice work reads D1. **Handover** flips `GITHUB_AUTHOR` to `"on-duty"` (one var; the code path is already the same) once a real engineer connects GitHub, and restores any drill-time `GITHUB_BASE` override. The PAT and NUCLEO key pasted in earlier transcripts still must be rotated after the trial — unchanged standing item.
