# Phase 20 — verified facts, gathered before the plan

Everything here was read from the **live** Zellify Linear workspace and GitHub org
on 2026-08-15, ahead of writing the Phase 20 plan. It exists so the plan argues
from measured facts rather than assumptions, and so the lead-time questions were
asked before they could block.

Nothing in this file is a design decision. It is what is true.

## The Linear ↔ GitHub integration is already live

**This was going to be a question for Ronit. It does not need to be asked.**

`ZEL-1771` (Development team, status `In Review`) carries these attachments:

```
https://github.com/Zellify/web2app-rebuild/pull/1489
https://github.com/Zellify/web2app/issues/2862
```

A GitHub PR auto-attaches to its Linear issue in this workspace, which is the
mechanism behind the assignment's "so the issue closes on merge". Phase 20 does
not have to build linking, and does not have to ask for an integration to be
connected. It has to produce a PR the existing integration can match.

**Two repos exist.** `Zellify/web2app-rebuild` is where the PR landed;
`Zellify/web2app` is separate and also referenced. Confirm which one the
fire-fighter targets before Task 1 — a PR against the wrong repo is a silent
failure of the whole ship loop.

## Conventions — read from the repo's own skills, not inferred

The repo is **`Zellify/web2app-rebuild`** (confirmed 2026-08-15). There is **no
`.github` PR template**; `.github/templates/` holds ECS deploy templates and
nothing else. The conventions live as agent skills, and `conventions.md` §Process
points at them:

- `.agents/skills/m-create-pr/SKILL.md`
- `.agents/skills/m-create-linear-task/SKILL.md`

**An earlier draft of this file inferred the branch convention from Linear's
generated `gitBranchName` (`sayandeten/zel-1771-…`). That was wrong.** That string
is Linear's suggestion, not this repo's rule, and the branch is explicitly *not*
what drives Linear sync.

### Branches

```
<type>/<short-slug>
<type>/<short-slug>-zel-<n>     # only when a Linear issue already exists
```

- `<type>` ∈ `feat, fix, chore, docs, refactor, perf, test, ci` — same type as the PR title.
- `<short-slug>` — 2–4 kebab-case words, ≤30 chars, filler words stripped.
- The `zel-<n>` suffix is **optional** and is for grep/autocomplete only. It is
  **not** the sync trigger.
- Branch off a freshly pulled `staging`. **Never `dev`** — abandoned, ~1300
  commits behind. Never off another feature branch.

### The PR lifecycle is two-phase, and the first phase happens immediately

A draft PR goes up *before the work is presentable*: empty commit if needed,
`gh pr create --draft --base staging --title "<type>: <slug>" --body ""`. Then
the body is filled in later and `gh pr ready <num>` flips it.

This matters for Phase 20's design: the agent should open the draft when it
starts, not construct one PR at the end. It also makes the run watchable — the PR
URL exists from minute one.

### PR body — exactly this, nothing else by default

```markdown
Fixes ZEL-<n>          <- first line, only when an issue exists

## Description

<one short paragraph: what changed and why. No headings inside.>

## Acceptance Criteria

- [ ] observable, testable thing
- [ ] observable, testable thing
```

Optional sections, only when genuinely needed: `## Screenshots` (UI changes) and
`## Notes for reviewers`. **`## Screenshots` is where the Phase 19 recording
belongs** — it is the sanctioned home for visual proof, so the ship loop does not
need to invent a section.

Title: `<type>: <imperative summary>`, under ~70 chars.

### Linking: `Fixes ZEL-<n>`, first line of the body

Use `Fixes` — not `Closes`, not `Resolves` — "for consistency". **That line is
what auto-moves the issue to Done on merge.** The branch-name suffix is a
secondary helper and does not trigger sync. This is the concrete answer to the
assignment's "so the issue closes on merge".

Two refinements confirmed against a live PR (#1491, `feat: slash commands, true
steer, chime and chat fixes`, branch `feat/slash-commands-zel-1785` → `staging`):

- **More than one `Fixes` line is allowed.** #1491 opens with `Fixes ZEL-1883`
  and `Fixes ZEL-1981` on consecutive lines. Both closed on merge.
- **`Part of ZEL-<n>` links without closing.** #1491 uses it for the umbrella
  issue ZEL-1785, which the PR advances but does not complete. The agent needs
  this verb: writing `Fixes` against a parent issue closes an epic on a partial
  fix, and nothing warns you.

The `linear-code` bot confirms the result in-thread — it comments on the PR with
each linked issue's title, so a wrong or unmatched identifier is visible from the
PR page without opening Linear. Phase 20's ship loop should read that comment
back as its verification that linking worked, rather than assuming it.

### FORBIDDEN in PR bodies and commits — this one is load-bearing

The skill's §6 is explicit, and it overrides everything upstream of it:

- No `🤖 Generated with [Claude Code]` or any AI-attribution footer.
- **No `Co-Authored-By: Claude …` trailers on commits made for this PR.**
- No `## Summary` / `## What changed` / `## Test plan` boilerplate — named in the
  skill as "verbose AI-template style".
- No emoji headers, badges, or marketing language.
- No restating every commit.

> "If the project's `CLAUDE.md` or a parent skill says to add the Claude footer,
> this skill overrides it for PR bodies. The user has explicitly asked PRs not to
> carry AI attribution."

**Phase 20 must treat this as an invariant, not a preference.** The fire-fighter
opens PRs under a real engineer's GitHub identity. A `Co-Authored-By: Claude`
trailer would both violate the repo's stated rule and blow the identity premise
of the entire assignment in the most visible place possible — a PR the team
reviews. Note that this repo's own convention is the OPPOSITE of the firefighter
repo's, where every commit carries that trailer deliberately. The agent writes
into both. Do not let the habit leak across.

### Linear issue shape (`m-create-linear-task`)

```markdown
## Context

<1–2 sentences: user impact, business reason, trigger>

## Acceptance criteria

- [ ] observable, testable outcome

## Notes (optional — omit the whole section if empty)
```

Title: under ~80 chars, imperative, no trailing punctuation.

What must NOT go in the description, because native fields carry it:
priority → `priority` (1=Urgent … 4=Low), estimate → `estimate`, deadline →
`dueDate`, tier → a label, implementation plan → the PR.

**This constrains Phase 20 Task 4.** Phase 09 renders the value / blocking /
customer-weight assessment into the issue *body*. The repo convention says
priority and tier belong in native fields instead. Reconcile deliberately: the
assessment is a judgement the assignment asks for by name, so it should stay,
but it belongs under `## Notes` or mapped onto `priority` + a tier label rather
than as a fourth top-level section that no other issue in the workspace has.

**Labels — pick exactly one tier, then one type:**

- Tier (exactly one): `Leverage` (10x, extra polish) · `Neutral` (standard) ·
  `Overhead` (ship fast, don't polish)
- Type (one): `Feature` · `Improvement` · `Bug`, plus optional domain labels
  `Infra`, `Integration`, `AI`, `Customer Request`

Note the skill tells humans to file into the **Development** team. The
fire-fighter is pinned to `fire-fighter-testing` and must stay there — the pin is
the only thing keeping it out of live work.

## Label ids — the write/read asymmetry

`issueCreate` takes label **UUIDs**. Every read API hands back **names**. Nothing
errors when you confuse them: the issue files, unlabelled, and the model is told
it succeeded. This was a live bug in `src/linear/client.ts:183`, fixed in
`7b9bb9f`.

Proven by writing `1222a88e-…` to `FIR-2` and reading back `labels: ["Bug"]`.

| name | id |
|---|---|
| `Bug` | `1222a88e-6b42-46c0-b19b-1c7ec3190393` |
| `Feature` | `1d6956a0-c9c5-4597-8e0a-fa67c3a765cd` |
| `Improvement` | `503881f7-3d11-46c9-b2fb-c1ba68238e2d` |
| `Customer Request` | `d5350315-b33e-469c-99cf-ae24dc603bb7` |
| `AI` | `2275c2ac-e815-46cd-a42b-dd534f812276` |
| `Infra` | `80515b29-3269-4a74-af82-6f7d06d4f9fe` |
| `Integration` | `a9c27b6b-8e8e-4cd9-af41-7bdde7e8ff9a` |

**Labels are WORKSPACE-wide, not team-scoped.** The `LINEAR_TEAM_ID` pin does not
put other teams' labels out of reach. The workspace carries a `Devin Playbooks`
group — `!triage`, `!plan`, `!implement`, `!review` — which are another agent's
triggers. The model picks label names freely, so `client.ts` now refuses any
`!`-prefixed label. Do not remove that filter on the grounds that the team pin
already covers it. It does not.

Ids are resolved at call time rather than from this table. A hardcoded table goes
stale the first time someone adds a label, and it fails in the same silent way
the original bug did. This table is documentation, not configuration.

## Workflow states are TEAM-scoped

Unlike labels. The same state name has a different id per team:

| state | `fire-fighter-testing` | `Development` |
|---|---|---|
| `Todo` | `90bb701b-88bd-49a7-813a-14e86d745e68` | `8ec2d243-7ed1-4172-840b-a797ccef25df` |
| `In Review` | `ad1e3615-cc0d-4701-82a6-bff32e35b877` | `67ab7035-e794-4af1-bb08-9017b1438040` |

Full `fire-fighter-testing` set:

| state | type | id |
|---|---|---|
| `Backlog` | backlog | `45618df4-683d-4edb-8eb4-73b18a6741a9` |
| `Todo` | unstarted | `90bb701b-88bd-49a7-813a-14e86d745e68` |
| `In Progress` | started | `33e9e8ab-af37-4f76-8d66-f1a61edf0835` |
| `In Review` | started | `ad1e3615-cc0d-4701-82a6-bff32e35b877` |
| `Done` | completed | `c4e231ae-3ad8-4b94-8258-45951f8f2715` |
| `Canceled` | canceled | `f0870ada-53ce-4c17-b56f-64b0600bb2c8` |
| `Duplicate` | duplicate | `f7fd8a79-08d4-4c06-b1dc-c3214908520f` |

Task 3's status transitions must resolve within the pinned team. A state id
observed on a Development issue is not valid here, and Linear's error for that
is not obviously about teams.

`In Review` is the state a PR-opened issue moves to — confirmed by ZEL-1771's
own state history, which went `Todo → In Review` when its PR opened.

## Constraints the assignment puts on this phase

Copied here because they are easy to violate while writing plausible code.

1. **"The dashboard approves Slack messages and nothing else."** Opening a PR and
   filing or updating a Linear issue must NOT route through `approval.escalate`.
   The assignment is explicit that gating the harness layer "leaves you with an
   agent that can't act", and a PR that costs a click fails the click-count
   criterion in drill scenario 4. Review happens on GitHub, not on the dashboard.
2. **"One generic agent, no per-ticket-type pipelines."** `github` exposes
   capabilities — open a PR, push a commit, comment. Sequencing is the model's.
   Task 1 phrased as "diff → PR" is the most likely place in this phase to grow a
   `shipBugFix()` workflow by accident. It is a capability, not a pipeline.
3. **"Model-authored code never touches raw credentials."** Already satisfied by
   the Worker-side blobs → tree → commit → ref → PR approach; the sandbox never
   holds a token.
4. **The recording goes in BOTH places.** The drill wants "the recording in both
   the PR and the thread", and scenario 2 wants the customer replied to. Phase
   20's roadmap exit criteria only names the PR. Whoever writes the plan should
   assert the Slack side too, or it will be nobody's task.

## Monorepo operational facts (AGENTS.md §3) — these bear on Phase 19 too

`CLAUDE.md` is a pointer; `AGENTS.md` is canonical (commit "make agents.md
canonical"). Read 2026-08-15.

```bash
pnpm install
pnpm build-packages      # MUST run before first dev/build -- builds packages to real dist/
pnpm dev --filter=@web2app/<app>
pnpm test                # turbo, vitest where present
pnpm check-types         # "skip unless asked -- slow in this monorepo"
```

Three things the sandbox has to respect:

1. **`pnpm build-packages` is mandatory before the first dev server or build.**
   Phase 18's provision.sh already does install + build-packages, which matches.
   Without it the packages resolve to source rather than `dist/`.
2. **The global virtual store is OFF and must stay off.** With it on,
   `next build` dies with "We couldn't find the Next.js package
   (`next/package.json`)" because Turbopack refuses to resolve outside the
   project boundary. The repo writes **every** CI/Docker install as
   `pnpm --config.enable-global-virtual-store=false install --frozen-lockfile`,
   deliberately redundant, as a guard that makes a re-enable non-fatal. The
   sandbox's install should carry the same flag for the same reason.
3. **`pnpm check-types` is slow enough that the repo tells agents to skip it.**
   A ship-loop run should verify through the dev server and `pnpm test`, not by
   typechecking the whole monorepo — that is a wall-clock trap inside a run
   already paying a ~3-minute cold boot.

**Release path:** `staging` → `prod`, either a whole-branch `Staging` PR or
cherry-picks onto a branch off `prod`. The fire-fighter never touches this; it
only ever opens `→ staging`.

## ~~BLOCKER~~ — CLEARED 2026-08-15. It took TWO grants, not one.

**Final state, measured three ways:**

```
GET /repos/Zellify/web2app-rebuild        -> permissions.push: TRUE
GET .../collaborators   (push-gated)      -> HTTP 200
GET .../collaborators/sayandedotcom/...   -> permission: "write"
```

The lesson worth keeping, because it cost half a day: **a fine-grained PAT and a
repository role are two independent gates, and both must be open.** The token
grant raises a ceiling; the collaborator role supplies the access. Approving the
token alone left `push: false`, and the token's own settings page still displayed
"Read and Write access to code and pull requests" the entire time — the dashboard
shows the ceiling, the API shows the intersection. Trust the API.

The diagnostic that settles it in one call, and which belongs in any future
pre-flight: `GET /repos/{owner}/{repo}` and read `permissions.push`. A second,
independent confirmation is `GET .../collaborators`, which is itself push-gated —
403 means no push regardless of what any settings page claims.

**Still not readable:** `GET .../branches/staging/protection` returns *"Resource
not accessible by personal access token"* — branch protection needs
`Administration: read`, a token permission requiring another org approval round.
Not pursued: protection does not block opening a PR into `staging`, and any
required status checks become visible on the PR itself once it opens. Revisit
only if a check turns out to gate the drill.

### The original measurement, and why one grant was not enough

**Measured 2026-08-15, after the org approved the re-scoped token but before the
collaborator role was changed:**

```
GET /repos/Zellify/web2app-rebuild   (auth: MONOREPO_PAT, post-approval)
permissions: {admin: false, maintain: false, push: FALSE, triage: false, pull: true}
default_branch: staging
```

**A fine-grained PAT cannot grant access the account does not already have.**
Org approval authorises a token to *exercise* the user's permissions; it does
not change the user's role on the repository. `sayandedotcom` is still
read-only on `web2app-rebuild`, so `Contents: read & write` on the token buys
nothing.

The fix was a different setting that only an org/repo admin can do: **add the
trial account as a collaborator with `write`** (repo → Settings → Collaborators
and teams). Asked and granted the same day — that grant is what flipped
`push` to true above.

**It never blocked building Phase 20.** The code is identical either way —
Tasks 1–5 are correct regardless of who holds the grant, because every one of
their tests runs against a stubbed `fetch`. Only Task 6's live drill was gated.
Verify with the probe before spending a container boot, never during the drill.

A second correction while here: an earlier version of this section reasoned that
push would traverse the sentinel git proxy in `src/sandbox/class.ts`. It does
not. Roadmap Task 1 builds the PR **entirely Worker-side** — blobs → tree →
commit → ref → PR over REST, authored with the on-duty engineer's token, and the
sandbox never holds the diff. The credential that decides whether shipping works
is therefore the engineer's own grant, not the sandbox's clone PAT. Both point
at the same account — which is why the collaborator grant, not the token
approval, was the thing that mattered.

### What the approval DID accomplish (kept — it is still needed)

The fine-grained PAT (renamed
`zillify-monorepo-read-write-pull-request`) was re-scoped from read-only to
**Contents: read & write** + **Pull requests: read & write**, still limited to
`Zellify/web2app-rebuild` alone, and approved by the org.

Three consequences worth having written down:

- **No secret to reinstall.** GitHub's *Request update* re-scopes a fine-grained
  token in place; it does not regenerate it. The value is byte-identical to the
  one already deployed. (*Regenerate token* would have invalidated it — do not
  touch it.) `MONOREPO_PAT` now also sits in `apps/worker/.dev.vars` so the
  push probe can run locally.
- **The token is no longer the limiting factor.** Whatever grant the account
  eventually receives, the token is already scoped to exercise it. When the
  collaborator grant lands, nothing else needs changing.
- **The fork workaround (option 2) is dead** — the collaborator grant landed, so
  Phase 20 pushes a branch to the real repo under the real identity. Keeping the
  target repo and head ref as configuration is still correct, but as hygiene
  again rather than as a fallback.

The measurement that established the blocker is kept below, because it is the
evidence for *why* a plain classic PAT is not enough here and would otherwise be
rediscovered the hard way.

### The original measurement

Measured 2026-08-15 with a classic PAT carrying full `repo` scope, org membership
`active`, role `member`.

| repo | `push` |
|---|---|
| `Zellify/firefighter` | `true` |
| `Zellify/web2app-rebuild` | **`false`** |

Same token, same org, same request. `GET /repos/Zellify/web2app-rebuild/collaborators/<user>/permission`
and `GET .../branches/staging/protection` both return 404, which is what
read-only access returns for those endpoints. So this is a per-repository
permission, not a token scope problem and not SSO.

**Phase 20 pushes a feature branch to this repo and cannot.** Drill scenarios 2
(small feature → PR) and 3 (planted bug → PR) both fail at the push, after the
agent has done all the expensive work: boot, repro, fix, record.

What this does NOT mean: the design is not wrong. In production the PR is
authored with the **on-duty engineer's** OAuth token, and Ronit / Luka / Zurab /
Misho presumably have push. The gap is that during the trial the rotation
override makes the tester the on-duty engineer, so the only identity available to
test with is the one that lacks access.

`GITHUB_SCOPE` in `src/oauth/github.ts` is already `repo`, correctly — GitHub has
no narrower classic scope that can both read a repository and push a branch. The
scope is right; the grant is missing.

Three ways out, in order of preference:

1. **Push access on `web2app-rebuild` for the trial account.** One org setting,
   and it makes the loop testable end to end before day 7.
2. **A fork.** `allow_forking: true` and the repo is private, so a private fork is
   possible if the org permits it. PRs from a fork still open under the
   engineer's own identity and still carry `Fixes ZEL-<n>`, so the assignment's
   identity and linking requirements survive. It changes Phase 20's Task 1: the
   commit lands on the fork's ref, and the PR is cross-repository.
3. **Run the drill with a real engineer on duty.** Works without any change, but
   it cannot be rehearsed, and the first time the push path executes would be
   during the benchmark.

Option 2 is the only one that does not depend on someone else acting, so Phase 20
should be written so the target repo and the head ref are configuration, not
assumptions — cheap now, and it makes 1 and 2 the same code path.

*(Outcome: option 1 landed the same day. The configuration advice stands on its
own merits; the fork path is no longer needed.)*

**`staging` is a protected branch** (`"protected": true`); the rules are not
readable at this permission level. Protection does not block opening a PR into
it, and "merged after human review" is what the assignment asks for anyway, so
this is a note rather than a problem. Confirm required status checks before the
drill if push access lands.

**Default branch is `staging`** — confirmed via the API, consistent with
`AGENTS.md` §3.

## The `FIR-` question — mostly settled by reading the settings

*(The paragraph immediately below is the original framing, kept because the
status note after it corrects a specific claim in it.)*

Whether Linear's GitHub integration matches **`FIR-`** identifiers or only
**`ZEL-`**. The integration is confirmed live for `ZEL-` against
`web2app-rebuild` (ZEL-1771 → PR #1489). The fire-fighter is pinned to the
`fire-fighter-testing` team, whose issues are `FIR-<n>`, and whether that team's
identifiers are matched by the same integration is a workspace setting nobody has
looked at. If they are not, `Fixes FIR-2` links nothing and the "closes on merge"
requirement fails silently.

Cheapest check once push access exists: open a throwaway draft PR with
`Fixes FIR-2` as the first body line and see whether the issue picks up the
attachment. Until then, treat auto-close as unproven for `FIR-` issues.

**Status 2026-08-15: the per-team worry was mistaken. Read the settings.**

Linear → Settings → Integrations → GitHub, read directly. The integration is
enabled org-wide on `Zellify` (by `ronit@zellify.app`, 2026-07-15). The **only**
per-team binding on that page is under **GitHub Issues** — `Development (ZEL)` ↔
`Zellify/web2app`, two-way — and that feature imports GitHub *issues* into a
Linear team. It is not PR linking, and the fire-fighter does not use it.

PR↔issue linking is org-level: any repo in a connected org can link to any
identifier that resolves in the workspace. So `FIR-<n>` is expected to work, and
the earlier note here — "Linear scopes GitHub sync per team" — was wrong. The
draft-PR probe is still the only thing that turns "expected" into "proven", and
it is now runnable, but it is confirmation rather than a live risk.

### The real trap: commit-message magic words are DISABLED

**`Link commits to issues with magic words` is toggled OFF** in the workspace.
That setting governs *commit messages* only. With it off, `Fixes FIR-2` written
into a commit links nothing at all.

`Fixes` in the **PR body** is unaffected and works — PR #1491 is the proof:
`ZEL-1883` and `ZEL-1981` appear only in the body, never in the branch name
(`feat/slash-commands-zel-1785`), and the bot linked all three.

**Rule for the ship loop: the `Fixes` line lives in the PR body. A
commit-message-only `Fixes` is silently inert.** This is the single easiest way
for the assignment's "closes on merge" requirement to fail while every artefact
looks correct.

### Other settings read at the same time, and why they matter

- **`Automatically link Linear issues`: OFF.** Leave it off. On, it links a
  matching issue *or generates one on merge when none is linked* — so every
  agent PR that missed its link would mint a phantom Linear issue.
- **Linkbacks → Private repositories: ON**, descriptions included. This is what
  produces the `linear-code` bot comment the ship loop reads back as its
  verification. Confirmed enabled, not assumed.
- **Branch format: `username/identifier-title`.** This is Linear's *Copy git
  branch name* suggestion, workspace-wide. It is not the repo's convention and
  not a constraint on the agent — see the branch section above, and the recorded
  correction about not inferring the convention from `gitBranchName`.
- **GitHub Issues sync targets `Zellify/web2app`**, the older repo — not
  `web2app-rebuild`. Nothing the fire-fighter touches, noted only so it is not
  mistaken later for evidence about which repo is in scope for PR linking.

## Still open

- **`AGENTS.md` §3** is cited by both skills as the authority on `staging` vs
  `dev` and has not been read in full. The `staging`-only rule is already
  confirmed twice over, so this is corroboration rather than a gap.
- **Whether the fire-fighter should open its PR as a draft first** (the repo's
  two-phase lifecycle) or go straight to a filled PR (§7 allows this for a branch
  that already has work). The agent always has real work by the time it pushes,
  so §7 is the closer fit — but the draft-first flow makes the run watchable
  earlier. A plan decision, not a missing fact.

Both "still open" items from the first draft of this file are now closed: the
repo is `web2app-rebuild`, and the conventions above are read from the repo's own
skills rather than inferred.

## Build outcome — Tasks 1–5 shipped and deployed 2026-08-15

Written after the build, so this file carries what is true at the end as well as what was true
before it. Task 6 (the live drill) is NOT done; everything below is about the code.

**Deployed:** version `924e1cb3`, container image unchanged at `27fd1043` (this phase adds no
container work). `GITHUB_REPO=Zellify/web2app-rebuild`, `GITHUB_BASE=staging`,
`GITHUB_AUTHOR=worker-pat` are live vars; `GITHUB_HEAD_REPO` is deliberately unset so it defaults
to `GITHUB_REPO`.

**Suite:** 104 files, 2120 passed, 2 skipped. `tsc --noEmit` clean. `codemode:dts:check` clean.

**What the reviews caught that the tests did not.** Recorded because the pattern is the lesson,
not the individual bugs:

1. **A model-supplied branch name force-updated an arbitrary repository.** `POST /git/refs` 422s on
   an invalid ref name — which was exactly the branch that triggered the force-`PATCH` — and
   `new URL(base + "x/../../../../../../evil/repo/git/refs/heads/main")` normalises to
   `https://api.github.com/repos/evil/repo/git/refs/heads/main`. `encodeURIComponent` does not
   encode `.`. Verified in node before acting on it. Now: ref-name validation before any fetch at
   every entry point (`openPR`, `findPR`, `checkPR`, patch paths, and the paginated `Link`
   follower), each with a test asserting `calls.length === 0`.
2. **"Structurally impossible" was merely absent.** The PR-body renderer interpolated `description`
   verbatim, so `"fixed it\n\n## Test plan\n\n- ran it"` rendered a heading this repo's §6 forbids
   — and the test claiming to cover it fed benign input and asserted absence, a tautology that
   would still pass with the injection wide open. Now `HEADING_PATTERN = /^\s*#{1,6}\s/m` screens
   description, notes, **and every acceptance criterion by index** before any render. The criterion
   screen is necessary, not merely consistent: `- [ ] ` neutralises a *leading* `##`, but
   `"covers the retry path\n## Test plan"` still renders a real column-0 heading.
3. **Non-UTF-8 base files were silently rewritten.** Git only calls a file binary on a NUL in the
   first 8 KB, so a latin-1 **text** file passes the applier's binary refusal, and
   `TextDecoder("utf-8")` turns every invalid byte into U+FFFD in the committed blob — corrupting
   lines the fix never touched. The byte-exact context check cannot catch it, because the patch
   arrives through the container's stdout mangled the same way and both sides agree. Now the decode
   must round-trip byte-for-byte or the file is refused by name.
4. **A modified symlink became a regular file.** `index a..b 120000` was not modelled, so the mode
   fell back to `100644` and the tree entry replaced the link with its target as file content.
   Modes are now whitelisted at all five entry points; `as Mode` casts are gone.
5. **`git add -A -N && git diff` never showed deletions** — `-A` stages them, so the unstaged diff
   misses them entirely and a fix that deleted a file would have opened a PR that silently did not.
   Now `git diff HEAD`, which also makes the capture agree with the recorded `baseSha`.
6. **Two uncoupled base-branch notions.** `lifecycle.ts`'s `REPO_REF` (what the container checks
   out, hence what `baseSha` points at) and `GITHUB_BASE` (what the PR opens against) agreed only
   by coincidence of defaults — and Task 6 Step 2 deliberately breaks that. Sandbox on a planted
   branch with `GITHUB_BASE` still `staging` would have shipped the planted bug **into** staging on
   merge. Now `GET /compare/{base}...{baseSha}` must return `identical` or `behind` or the PR is
   refused. Semantics verified against the live API, twice, independently.

**Known residuals, none able to corrupt a commit or open a PR against the wrong base:**

- `config.base` reaches a URL path for the first time (via the compare call) and is validated only
  against the literal `"dev"`. Deploy-time var, not model-reachable, GET only — but inconsistent
  with the doctrine that produced `assertValidSha`.
- The non-base64 refusal says "over 1 MB" for any non-base64 encoding; other encodings are
  effectively unreachable because symlinks and submodules refuse earlier.
- A compare-call failure classifies as in-doubt though nothing was written, so `findPR` reconciles
  a branch that was never pushed and returns null. Fails closed.
- `findPR`'s `updated: true` is an unsettled contract question, deliberately left open: as the
  `reconcile` result it reads as "this PR already existed", which is true of the branch/PR
  disjunction the doc states.
- `test/sandbox-diff.test.ts` still holds a 39-character `BASE_SHA` fixture. Harmless —
  `captureDiff` validates nothing by design and `openPR` is now the gate — but that suite has never
  seen a real sha shape. (The `github-gateway` fixture had the same 39-char bug and is fixed.)

## Task 6 — the live drill, not yet run

Everything it needs is deployed and push access is confirmed (`permissions.push: true`,
`/collaborators` → 200). It is human-in-the-loop by design: it needs someone to plant a bug and to
fire a drill message. The runbook is the plan's Task 6, unchanged. Two things to carry into it:

- **Re-assert the probe first** (`GET /repos/{owner}/{repo}` → `permissions.push`). It is 30
  seconds and it is the one check that invalidates the whole drill.
- **If you point `GITHUB_BASE` at a planted branch, check out that same branch in the sandbox.**
  The new compare guard refuses the mismatch rather than silently shipping a wrong diff — which is
  the intended behaviour, but it will look like an unexplained refusal if the coupling is forgotten.
