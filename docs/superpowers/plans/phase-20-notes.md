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
