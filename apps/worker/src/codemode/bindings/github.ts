import { z } from "zod";
import type { ToolDescriptors } from "@cloudflare/codemode/ai";
import { CapabilityError } from "../errors";
import { runEffect } from "../effects";
import { auditedCapability, effectDeps, type BindingContext } from "../registry";

/**
 * The eleventh namespace, and the last one Phase 20 adds: opening a real pull
 * request on a real engineer's identity, against a private monorepo whose PR
 * rules live as agent skills IN that repo. Two of those rules are load-bearing
 * enough that this file makes them structural rather than prompt-hoped —
 * exactly the reason this namespace exists at all rather than letting the
 * model assemble a PR body free-hand:
 *
 *  1. This Linear workspace has commit-message magic words DISABLED
 *     workspace-wide. A `Fixes FIR-2` typed into a commit message links
 *     nothing — not an error, just silence. The only thing that closes the
 *     issue on merge is a `Fixes` line in the PR BODY, so `renderPrBody`
 *     generates it from `fixesIssueIds` and the model is never given a text
 *     field where writing "Fixes" would do anything at all.
 *  2. The monorepo's own PR-conventions skill forbids AI attribution —
 *     `Co-Authored-By: Claude`, "Generated with", a robot emoji, boilerplate
 *     `## Summary`/`## Test plan` sections — and says so explicitly for a
 *     reason: THIS repo (the one this file is committed to) requires that
 *     trailer on its own commits. The habit that is correct here is exactly
 *     the habit that must not leak into what gets rendered for there. That is
 *     this file's whole job, not a side effect of it.
 *
 * `ctx.deps.github` is transport ONLY (see `gateways.ts`'s `GithubGateway`
 * doc) — it takes a `body` string already fully rendered and knows nothing
 * about Linear, conventions, or attribution. Every fact above is enforced
 * here, in the binding, so the gateway can stay a dumb REST client and this
 * file can be unit-tested with no network and no token in reach.
 */

const CONVENTIONAL_TYPES = [
  "feat",
  "fix",
  "chore",
  "docs",
  "refactor",
  "perf",
  "test",
  "ci",
] as const;

/**
 * Built from `CONVENTIONAL_TYPES` rather than written out a second time in
 * each regex below — two literal copies of the same eight words is exactly
 * how a future ninth type gets added to one and not the other.
 */
const TYPE_ALTERNATION = CONVENTIONAL_TYPES.join("|");

/**
 * Refused, not stripped. Silently rewriting a model's `commitMessage` would
 * hide the rule from it — the next call would just try again with a slightly
 * different phrasing of the same mistake. A refusal costs one turn and, read
 * once, teaches the rule for the rest of the run.
 *
 * `\bclaude\b` is broad on purpose: it also catches an engineer's own name if
 * one happened to be "Claude", which is an acceptable false positive next to
 * the alternative of missing a genuine attribution line because it phrased
 * itself unusually.
 */
const ATTRIBUTION_PATTERNS: RegExp[] = [
  /co-authored-by/i,
  /generated with/i,
  /🤖/u,
  /\bclaude\b/i,
];

const REPO_ATTRIBUTION_RULE =
  "this repository forbids AI attribution in PRs and their commits";

const REPO_HEADING_RULE =
  "this repository's PR skill forbids boilerplate sections like \u2018## Summary\u2019 or \u2018## Test plan\u2019, and this renderer's only fixed headings are Description/Acceptance Criteria/Screenshots/Notes for reviewers";

/**
 * Any Markdown ATX heading (`#` through `######`, at the start of a line,
 * followed by a space) — which is exactly the shape of `## Test plan`,
 * `## Summary`, or any other section the monorepo's skill forbids by name.
 * Anchored per-line (`m`) so a heading buried mid-paragraph is still caught,
 * not just one that opens the field.
 *
 * The renderer (`renderPrBody`) only ever writes the headings IT chooses —
 * `## Description`, `## Acceptance Criteria`, and the two optional ones — but
 * that guarantee is worthless if a free-text field can inject an extra one of
 * its own. This is what makes "no forbidden section" true of the rendered
 * body, not just true of the fixed skeleton around the free text.
 */
const HEADING_PATTERN = /^\s*#{1,6}\s/m;

/** Verbatim from the task brief — the monorepo's real branch/title/body contract. */
const inputSchema = z.strictObject({
  branch: z
    .string()
    .regex(new RegExp(`^(${TYPE_ALTERNATION})/[a-z0-9]+(?:-[a-z0-9]+)*$`))
    .max(45),
  title: z.string().regex(new RegExp(`^(${TYPE_ALTERNATION}): \\S`)).max(70),
  commitMessage: z.string().min(1).max(2000),
  description: z.string().min(1).max(2000),
  acceptanceCriteria: z.array(z.string().min(1).max(200)).min(1).max(10),
  /**
   * Either the id `linear.createIssue` hands back, or a human identifier
   * like `FIR-3` — both resolve. If the issue was filed by an EARLIER run
   * (so this run never got an id for it), call
   * `linear.findIssue({ identifier })` first to confirm it exists and is in
   * reach, then pass the identifier straight through. Rendered as
   * `Fixes <identifier>` — closes on merge.
   */
  fixesIssueIds: z.array(z.string().min(1).max(200)).max(5).default([]),
  /** Same id/identifier shapes as `fixesIssueIds`. Rendered as `Part of <identifier>` — links WITHOUT closing. Use for umbrella issues. */
  partOfIssueIds: z.array(z.string().min(1).max(200)).max(5).default([]),
  /** A /proofs recording URL from checkRecording — lands under ## Screenshots. */
  proofUrl: z.string().url().max(500).optional(),
  notesForReviewers: z.string().min(1).max(2000).optional(),
  diffRef: z.string().min(1).max(200),
});
type OpenPRInput = z.infer<typeof inputSchema>;

const pullRequestRefOutput = z.strictObject({
  number: z.number(),
  url: z.string(),
  headRef: z.string(),
  author: z.string(),
  updated: z.boolean(),
});

const pullRequestStatusOutput = z.strictObject({
  state: z.enum(["open", "closed", "merged"]),
  url: z.string(),
  headRef: z.string(),
  baseRef: z.string(),
  linearLinkback: z.strictObject({
    commented: z.boolean(),
    identifiers: z.array(z.string()),
  }),
});

/**
 * The body renderer — the whole enforcement of fact 1 above, as a pure
 * function with no gateway, no network, and one possible output shape for any
 * given input. `## Summary`, `## Test plan`, a footer, an attribution line —
 * none of those can appear, not by convention but because there is no branch
 * of this function that writes them.
 *
 * `fixes`/`partOf` take ALREADY-RESOLVED `{identifier}` pairs rather than raw
 * ids, so this function has no way to reach Linear and no reason to: the
 * caller resolves once, through `resolveLinkTargets`, and hands the result
 * here. That keeps the renderer testable with no gateway in scope at all.
 */
export function renderPrBody(input: {
  fixes: Array<{ identifier: string }>;
  partOf: Array<{ identifier: string }>;
  description: string;
  acceptanceCriteria: string[];
  proofUrl?: string;
  notesForReviewers?: string;
}): string {
  const lines: string[] = [];

  for (const { identifier } of input.fixes) lines.push(`Fixes ${identifier}`);
  for (const { identifier } of input.partOf) lines.push(`Part of ${identifier}`);
  // A blank line separates the link block from the body — but only when a
  // link block exists. With both lists empty the body legally starts at
  // `## Description` with no leading blank line: a PR may precede its issue.
  if (lines.length > 0) lines.push("");

  lines.push("## Description", "", input.description, "", "## Acceptance Criteria", "");
  for (const criterion of input.acceptanceCriteria) lines.push(`- [ ] ${criterion}`);

  if (input.proofUrl !== undefined) {
    lines.push("", "## Screenshots", "", input.proofUrl);
  }
  if (input.notesForReviewers !== undefined) {
    lines.push("", "## Notes for reviewers", "", input.notesForReviewers);
  }

  return lines.join("\n");
}

/**
 * The wall between this repo's habit and the monorepo's rule. Refuses rather
 * than edits: an agent that silently had its attribution stripped would learn
 * nothing and try again the same way next time.
 */
function assertNoAttribution(field: string, value: string): void {
  for (const pattern of ATTRIBUTION_PATTERNS) {
    if (pattern.test(value)) {
      throw new CapabilityError(
        "invalid_input",
        `${field} contains an AI attribution pattern and was refused: ${REPO_ATTRIBUTION_RULE}. ` +
          `Rewrite ${field} without it — nothing is stripped or rewritten for you, because that would hide the rule rather than teach it.`,
      );
    }
  }
}

/**
 * Refuses free text that opens a Markdown heading, for the same refuse-not-
 * strip reason `assertNoAttribution` does: silently deleting a `##` line (or
 * escaping it) would hide from the model exactly what it did wrong, and a
 * stripped heading is one edit away from being un-stripped by the next call.
 *
 * `field` may name a single acceptance-criterion item (`` `acceptanceCriteria[i]` ``)
 * so a refusal on item 3 doesn't read as if item 0 were the problem.
 */
function assertNoHeadings(field: string, value: string): void {
  if (HEADING_PATTERN.test(value)) {
    throw new CapabilityError(
      "invalid_input",
      `${field} contains a Markdown heading and was refused: ${REPO_HEADING_RULE}. ` +
        `Rewrite ${field} as plain text with no line starting "#" — nothing is stripped or rewritten for you, because that would hide the rule rather than teach it.`,
    );
  }
}

/**
 * `z.string().url().max(500)` already bounds length and general URL shape;
 * this is the one rule zod cannot express — the scheme. An `http://` proof
 * link is not a security issue here, but it is a broken one: the monorepo's
 * reviewers and the recording host both expect `https`, and a scheme typo is
 * cheaper to catch here than after the PR is already open.
 */
function assertProofUrl(proofUrl: string | undefined): void {
  if (proofUrl === undefined) return;
  if (!proofUrl.startsWith("https://")) {
    throw new CapabilityError(
      "invalid_input",
      "proofUrl must be an https URL — the recording host and the monorepo's reviewers both expect one, and this one is not.",
    );
  }
}

export function makeGithubTools(ctx: BindingContext): ToolDescriptors {
  return {
    openPR: auditedCapability(ctx, "github", "openPR", {
      effect: "external_write",
      description:
        "Open a pull request on the monorepo from this run's diffRef, or update the one already open on `branch` — call this again after improving the fix rather than leaving stale content up; a second call on the same branch updates it, it does not open a second PR. `branch` must follow the convention `<type>/<2-4 kebab-case words>` (e.g. `fix/checkout-timeout`) and `title` must be `<type>: <imperative>`, using the same conventional type in both. The `Fixes <identifier>` line is GENERATED from `fixesIssueIds`, which accepts EITHER the id `linear.createIssue` returns OR a human identifier like `FIR-3` typed straight in — if the issue was filed by an EARLIER run and you have no id for it, call `linear.findIssue({ identifier })` first to confirm it exists and is in reach, then pass that identifier through directly — never type the word \"Fixes\" into `description`, `notesForReviewers`, or especially `commitMessage`: this Linear setup has commit-message magic words disabled, so a `Fixes` line inside a commit message links nothing, silently, and only the rendered PR body closes the issue on merge. Use `partOfIssueIds` for an umbrella or epic issue instead — same id/identifier shapes, but it renders `Part of`, which links WITHOUT closing, so a fix that only covers part of the epic cannot close the whole thing. Put the proof recording's URL in `proofUrl` (it lands under `## Screenshots`) and ALSO repeat it in your Slack reply — the reviewer reads the PR, the customer reads Slack, and each needs their own copy of the same link. `title`, `commitMessage`, `description` and `notesForReviewers` are REFUSED, not silently rewritten, if they contain co-authored-by, \"generated with\", the robot emoji, or the word \"claude\" in any case — this repository forbids AI attribution in PRs and their commits, and a silent strip would hide that rule rather than teach it. `description`, `notesForReviewers` and each `acceptanceCriteria` entry are likewise REFUSED if they contain a Markdown heading (a line starting with `#`) — the only headings this PR body ever has are the ones this tool itself renders (Description, Acceptance Criteria, Screenshots, Notes for reviewers), never one smuggled in through free text. After this returns, poll `checkPR` on a later turn until `linearLinkback.commented` is true — that confirms the Fixes/Part of lines actually took; if it never turns true after a few polls, say so instead of assuming the link worked.",
      input: inputSchema,
      output: pullRequestRefOutput,
      run: async (input: OpenPRInput) => {
        // Attribution: every free-text field that ends up in the PR or its
        // commit, INCLUDING `title` — the most visible string in the whole
        // artifact, and the one field the first pass of this file missed.
        // `branch` needs no screen: its regex is lowercase-kebab-only and no
        // attribution trailer's shape survives it.
        assertNoAttribution("title", input.title);
        assertNoAttribution("commitMessage", input.commitMessage);
        assertNoAttribution("description", input.description);
        if (input.notesForReviewers !== undefined) {
          assertNoAttribution("notesForReviewers", input.notesForReviewers);
        }

        // Headings: every free-text field the RENDERER interpolates into the
        // body verbatim, so that "no forbidden section" is true of what
        // actually ships rather than only of the skeleton `renderPrBody`
        // itself writes. `title` and `commitMessage` are exempt — neither is
        // interpolated into the body, so neither can inject a heading there.
        assertNoHeadings("description", input.description);
        if (input.notesForReviewers !== undefined) {
          assertNoHeadings("notesForReviewers", input.notesForReviewers);
        }
        input.acceptanceCriteria.forEach((criterion, i) => {
          assertNoHeadings(`acceptanceCriteria[${i}]`, criterion);
        });

        assertProofUrl(input.proofUrl);

        // One combined call, not two. `resolveLinkTargets` refuses the WHOLE
        // call on any single foreign or unknown id rather than returning a
        // partial list — a partially-rendered Fixes/Part-of block is worse
        // than none — and a single call over the concatenation gets that
        // all-or-nothing property for the fixes/partOf split for free, rather
        // than requiring two separate refusal paths that could disagree.
        const combinedIds = [...input.fixesIssueIds, ...input.partOfIssueIds];
        const resolved =
          combinedIds.length > 0 ? await ctx.deps.linear.resolveLinkTargets(combinedIds) : [];
        const fixes = resolved.slice(0, input.fixesIssueIds.length);
        const partOf = resolved.slice(input.fixesIssueIds.length);

        const body = renderPrBody({
          fixes,
          partOf,
          description: input.description,
          acceptanceCriteria: input.acceptanceCriteria,
          proofUrl: input.proofUrl,
          notesForReviewers: input.notesForReviewers,
        });

        return runEffect(
          effectDeps(ctx),
          ctx.scope,
          "github",
          "openPR",
          // Everything that changes what gets opened: branch decides WHERE,
          // title and the rendered body decide what a reviewer reads, diffRef
          // decides WHAT ships. `body` — not the raw id lists — is what's in
          // the key, so a relinked issue (same ids, different resolved
          // identifier — impossible in practice, but the same principle
          // applies to a description or acceptance-criteria edit that changes
          // the rendered text without changing an id list) is correctly a
          // different effect rather than a silent replay of the first PR.
          {
            branch: input.branch,
            title: input.title,
            commitMessage: input.commitMessage,
            body,
            diffRef: input.diffRef,
          },
          {
            execute: (idempotencyKey) =>
              ctx.deps.github.openPR({
                branch: input.branch,
                title: input.title,
                commitMessage: input.commitMessage,
                body,
                diffRef: input.diffRef,
                idempotencyKey,
              }),
            // The reconcile question for an ambiguous open is never "did SOME
            // PR get opened" — it is "is there a PR whose head is THIS
            // branch", because that is the one a retry would otherwise
            // duplicate.
            reconcile: () => ctx.deps.github.findPR(input.branch),
          },
        );
      },
    }),

    checkPR: auditedCapability(ctx, "github", "checkPR", {
      effect: "read",
      description:
        "Check one PR's live state — open, closed or merged — and whether the linear-code bot's linkback comment has landed (`linearLinkback.commented`). Call this on a LATER turn after `openPR`, not in a loop inside the same one: the bot's comment can take a little while to post. Once `commented` is true, the Fixes/Part of lines are confirmed wired to the issue(s); if it stays false after a few polls, say so in your reply rather than assuming the link took.",
      input: z.strictObject({ number: z.number().int().positive() }),
      output: pullRequestStatusOutput,
      run: (input) => ctx.deps.github.checkPR(input.number),
    }),
  };
}
