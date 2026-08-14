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

## Conventions, read off real issues

- **Branch names:** `sayandeten/zel-1771-revive-mailchimp-credentials-path-audience-dropdown`
  — that is Linear's own generated `gitBranchName`, shaped `<user>/<issue-key>-<slug>`.
  It is personalised to the requesting user, so the fire-fighter's branches should
  carry the **on-duty engineer's** handle, not a fixed one.
- **PR titles:** conventional commits (`feat: add the reteno and mailchimp
  email-lifecycle integrations`).
- **Issue bodies** on real work use `## Context` and `## Acceptance criteria`
  with checkbox lists. Phase 09's structured assessment block should sit
  alongside that shape, not replace it.

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

- **Which repo** the fire-fighter opens PRs against — `web2app-rebuild` or
  `web2app`. One question in `#eng-firefighter`.
- **The monorepo's own PR template / `AGENTS.md` conventions** have not been read
  from the repo itself. The conventions above are inferred from filed issues and
  merged PRs, which is good evidence but not the source of truth.
