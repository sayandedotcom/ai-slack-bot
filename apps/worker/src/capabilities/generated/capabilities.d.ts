// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Regenerate with:  pnpm capabilities:dts
// Verify with:       pnpm capabilities:dts:check
//
// Rendered from the capability connectors' describe() by
// @cloudflare/codemode@0.5.1's generateTypesFromJsonSchema — the same
// call the codemode runtime makes, so this is what the model is handed. It
// exists for review and drift detection; it is NOT a second source of truth.
//
// These declarations are GUIDANCE, not a security boundary. The sandbox runs
// JavaScript and nothing stops model code calling a method the types forbid.
// The boundary is the Zod parse inside defineCapability().

type ThreadInput = {
    limit?: number;
}
type ThreadOutput = {
    ts: string;
    userId: string | null;
    text: string;
    permalink: string | null;
}[]
type SearchMessagesInput = {
    query: string;
    customerRef?: string;
    limit?: number;
}
type SearchMessagesOutput = {
    ts: string;
    userId: string | null;
    text: string;
    permalink: string | null;
}[]
type ReplyInput = {
    text: string;
}
type ReplyOutput = {
    ts: string;
    permalink: string | null;
}

declare const slack: {
	/**
	 * Read the messages of the conversation this run belongs to, oldest first.
	 */
	thread: (input: ThreadInput) => Promise<ThreadOutput>;

	/**
	 * Search previously ingested messages for this conversation's customer, or for the one named by customerRef in an internal chat.
	 */
	searchMessages: (input: SearchMessagesInput) => Promise<SearchMessagesOutput>;

	/**
	 * Post a reply into the conversation this run belongs to. The destination is fixed by the run and cannot be chosen here. IF THIS CALL TIMES OUT OR ITS CODE BLOCK IS CUT SHORT, THE MESSAGE HAS PROBABLY ALREADY BEEN SENT — the send happens before the block finishes, so a timeout tells you the block ran long, not that the customer missed the reply. Do not send it again, and do not send a reworded version: a rewrite is different text and will post a second message rather than replacing the first. Read the thread to check what landed, and if you genuinely need to add something, send only the NEW part.
	 */
	reply: (input: ReplyInput) => Promise<ReplyOutput>;
}

type FindCustomersInput = {
    query: string;
    limit?: number;
}
type FindCustomersOutput = {
    customerRef: string;
    label: string;
}[]
type RecallInput = {
    query: string;
    scope?: "customer" | "org";
    customerRef?: string;
    limit?: number;
}
type RecallOutput = {
    factId: string;
    fact: string;
}[]
type CiteInput = {
    factIds: string[];
}
type CiteOutput = {
    factId: string;
    fact: string;
    permalink: string;
    ts: string;
}[]

declare const memory: {
	/**
	 * Look up which customer an internal question is about. Returns opaque references usable only in this execution; pass one as customerRef to recall or slack.searchMessages. Unavailable in a customer conversation, which is already scoped.
	 */
	findCustomers: (input: FindCustomersInput) => Promise<FindCustomersOutput>;

	/**
	 * Recall previously recorded facts. Scope 'customer' stays within this conversation's customer, or the one named by customerRef in an internal chat; 'org' covers shared engineering knowledge.
	 */
	recall: (input: RecallInput) => Promise<RecallOutput>;

	/**
	 * Turn recalled facts into quotable citations. Only identifiers returned by recall in this same execution are accepted.
	 */
	cite: (input: CiteInput) => Promise<CiteOutput>;
}

type CreateIssueInput = {
    title: string;
    description: string;
    assessment: {
        platformValue: "low" | "medium" | "high";
        blocking: "low" | "medium" | "high";
        customerWeight: "low" | "medium" | "high";
        evidence: string;
    };
    /** Always label. Linear label NAMES, matched case-insensitively — a name that does not exist is dropped without error, so use these exact ones: 'Bug' (something is broken), 'Improvement' (existing behaviour made better), 'Feature' (new behaviour); add 'Customer Request' when a customer asked for it, and 'Support thread' when it came out of a customer Slack channel. Never a name starting with '!' — those hand the issue to another team's automation. */
    labels?: string[];
}
type CreateIssueOutput = {
    id: string;
    identifier: string;
    url: string;
}
type FindIssueInput = {
    identifier: string;
}
type FindIssueOutput = {
    id: string;
    identifier: string;
    url: string;
    title: string;
    state: string;
} | null
type UpdateIssueInput = {
    issueId: string;
    title?: string;
    description?: string;
    state?: string;
}
type UpdateIssueOutput = {
    id: string;
    url: string;
}

declare const linear: {
	/**
	 * File an issue. Where it is filed is fixed by configuration and cannot be chosen here.
	 * @param input.labels - Always label. Linear label NAMES, matched case-insensitively — a name that does not exist is dropped without error, so use these exact ones: 'Bug' (something is broken), 'Improvement' (existing behaviour made better), 'Feature' (new behaviour); add 'Customer Request' when a customer asked for it, and 'Support thread' when it came out of a customer Slack channel. Never a name starting with '!' — those hand the issue to another team's automation.
	 */
	createIssue: (input: CreateIssueInput) => Promise<CreateIssueOutput>;

	/**
	 * Look up an issue by its human identifier (e.g. `FIR-3`) — this is how you pick up an issue you did not create yourself in THIS run, before passing its id to openPR's fixesIssueIds/partOfIssueIds. Returns null, not an error, when there is no such issue or it is out of reach.
	 */
	findIssue: (input: FindIssueInput) => Promise<FindIssueOutput>;

	/**
	 * Update an issue this run already created or read. Fields left out are unchanged.
	 */
	updateIssue: (input: UpdateIssueInput) => Promise<UpdateIssueOutput>;
}

type PublishInput = {
    bytes: Uint8Array;
    contentType: string;
    filename: string;
}
type PublishOutput = {
    url: string;
    size: number;
    sha256: string;
}

declare const files: {
	/**
	 * Publish bytes as a retrievable artifact and get back its address. This is the only way to return binary content.
	 */
	publish: (input: PublishInput) => Promise<PublishOutput>;
}

type OpenPRInput = {
    branch: string;
    title: string;
    commitMessage: string;
    description: string;
    acceptanceCriteria: string[];
    fixesIssueIds?: string[];
    partOfIssueIds?: string[];
    /** @format uri */
    proofUrl?: string;
    notesForReviewers?: string;
    diffRef: string;
}
type OpenPROutput = {
    number: number;
    url: string;
    headRef: string;
    author: string;
    updated: boolean;
}
type CheckPRInput = {
    number: number;
}
type CheckPROutput = {
    state: "open" | "closed" | "merged";
    url: string;
    headRef: string;
    baseRef: string;
    linearLinkback: {
        commented: boolean;
        identifiers: string[];
    };
}
type SearchPRsInput = {
    query: string;
    limit?: number;
}
type SearchPRsOutput = {
    number: number;
    title: string;
    state: "open" | "closed" | "merged";
    url: string;
    author: string;
    updatedAt: string;
}[]

declare const github: {
	/**
	 * Open a pull request on the monorepo from this run's diffRef, or update the one already open on `branch` — call this again after improving the fix rather than leaving stale content up; a second call on the same branch updates it, it does not open a second PR. `branch` must follow the convention `<type>/<2-4 kebab-case words>` (e.g. `fix/checkout-timeout`) and `title` must be `<type>: <imperative>`, using the same conventional type in both. The `Fixes <identifier>` line is GENERATED from `fixesIssueIds`, which accepts EITHER the id `linear.createIssue` returns OR a human identifier like `FIR-3` typed straight in — if the issue was filed by an EARLIER run and you have no id for it, call `linear.findIssue({ identifier })` first to confirm it exists and is in reach, then pass that identifier through directly — never type the word "Fixes" into `description`, `notesForReviewers`, or especially `commitMessage`: this Linear setup has commit-message magic words disabled, so a `Fixes` line inside a commit message links nothing, silently, and only the rendered PR body closes the issue on merge. Use `partOfIssueIds` for an umbrella or epic issue instead — same id/identifier shapes, but it renders `Part of`, which links WITHOUT closing, so a fix that only covers part of the epic cannot close the whole thing. Put the proof recording's URL in `proofUrl` (it lands under `## Screenshots`) and ALSO repeat it in your Slack reply — the reviewer reads the PR, the customer reads Slack, and each needs their own copy of the same link. `title`, `commitMessage`, `description` and `notesForReviewers` are REFUSED, not silently rewritten, if they contain co-authored-by, "generated with", the robot emoji, or the word "claude" in any case — this repository forbids AI attribution in PRs and their commits, and a silent strip would hide that rule rather than teach it. `description`, `notesForReviewers` and each `acceptanceCriteria` entry are likewise REFUSED if they contain a Markdown heading (a line starting with `#`) — the only headings this PR body ever has are the ones this tool itself renders (Description, Acceptance Criteria, Screenshots, Notes for reviewers), never one smuggled in through free text. After this returns, poll `checkPR` on a later turn until `linearLinkback.commented` is true — that confirms the Fixes/Part of lines actually took; if it never turns true after a few polls, say so instead of assuming the link worked.
	 */
	openPR: (input: OpenPRInput) => Promise<OpenPROutput>;

	/**
	 * Check one PR's live state — open, closed or merged — and whether the linear-code bot's linkback comment has landed (`linearLinkback.commented`). This takes a number you already HAVE; to find one, use `searchPRs`, never a sweep of guessed numbers. Call this on a LATER turn after `openPR`, not in a loop inside the same one: the bot's comment can take a little while to post. Once `commented` is true, the Fixes/Part of lines are confirmed wired to the issue(s); if it stays false after a few polls, say so in your reply rather than assuming the link took.
	 */
	checkPR: (input: CheckPRInput) => Promise<CheckPROutput>;

	/**
	 * Find pull requests by free text — words from the title or body, a branch name, an issue identifier — newest activity first, any state (open, closed or merged), in the one repository this deployment is pinned to. This is how you answer "is there a PR for X?" and "did that ship?": search first, then `checkPR` the number you find for its branch and linkback. Never probe PR numbers one by one to find something. An empty result means nothing MATCHED THESE WORDS, not that no PR exists — try the branch name or the issue id before you tell anyone there is none, and never send that answer in the same block as the search.
	 */
	searchPRs: (input: SearchPRsInput) => Promise<SearchPRsOutput>;
}
