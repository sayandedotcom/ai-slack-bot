// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Regenerate with:  pnpm codemode:dts
// Verify in CI with: pnpm codemode:dts:check
//
// Rendered from the real Zod schemas in src/codemode/bindings/ by
// @cloudflare/codemode@0.5.1's generateTypes. This file exists for
// review and drift detection; it is NOT a second source of truth, and the tool
// description the model actually sees comes from the same render function.
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
	 * Post a reply into the conversation this run belongs to. The destination is fixed by the run and cannot be chosen here.
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

type SchemaInput = {
    resource?: string;
}
type SchemaOutput = {
    resource: string;
    columns: {
        name: string;
        type: string;
    }[];
}[]
type SelectInput = {
    resource: string;
    columns?: string[];
    filters?: {
        column: string;
        op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "is" | "like";
        value: string | number | boolean | null | string | number[];
    }[];
    order?: {
        column: string;
        direction: "asc" | "desc";
    };
    limit?: number;
}
type SelectOutput = {}[]

declare const supabase: {
	/**
	 * List the readable resources and their columns. Call this before select to learn what exists.
	 */
	schema: (input: SchemaInput) => Promise<SchemaOutput>;

	/**
	 * Read rows from one allowed resource. Filters are structured; free-form query text is not accepted.
	 */
	select: (input: SelectInput) => Promise<SelectOutput>;
}

type TraceInput = {
    traceId: string;
}
type TraceOutput = {
    traceId: string;
    name: string;
    startedAt: string;
    status: string;
    nodes: {
        id: string;
        parentId: string | null;
        name: string;
        runType: string;
        status: string;
        startedAt: string;
        durationMs: number;
        inputPreview: string;
        outputPreview: string;
        error: string | null;
    }[];
    truncated: boolean;
}
type SearchTracesInput = {
    query?: string;
    since?: string;
    limit?: number;
}
type SearchTracesOutput = {
    traceId: string;
    name: string;
    startedAt: string;
    status: string;
}[]

declare const langsmith: {
	/**
	 * Fetch one recorded run by its identifier. Steps come back as a flat list; rebuild the tree from parentId if you need it.
	 */
	trace: (input: TraceInput) => Promise<TraceOutput>;

	/**
	 * Find recorded runs in the configured project. Use ISO-8601 for 'since'.
	 */
	searchTraces: (input: SearchTracesInput) => Promise<SearchTracesOutput>;
}

type LogsInput = {
    query: string;
    since: string;
    until?: string;
    limit?: number;
}
type LogsOutput = {
    at: string;
    level: string;
    message: string;
}[]
type MonitorsInput = {}
type MonitorsOutput = {
    id: string;
    name: string;
    status: string;
    lastCheckedAt: string | null;
}[]

declare const betterstack: {
	/**
	 * Search collected production logs over a time window. 'since' and 'until' are ISO-8601 instants.
	 */
	logs: (input: LogsInput) => Promise<LogsOutput>;

	/**
	 * List the current up/down state of the configured monitors.
	 */
	monitors: (input: MonitorsInput) => Promise<MonitorsOutput>;
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

type EscalateInput = {
    draft: string;
    why: string;
}
type EscalateOutput = {
    approvalId: string;
    state: "pending";
}
type WithdrawInput = {}
type WithdrawOutput = {
    withdrawn: true;
} | {
    withdrawn: false;
    decision: "approved" | "edited" | "rejected";
}

declare const approval: {
	/**
	 * Park this run for one human decision on one proposed customer Slack reply. Returns immediately; the pause happens when you finish your turn. Escalate when the message is committal, closes a thread, tells a customer no, or could embarrass the engineer whose name is on it. Do NOT escalate clarifying questions or status updates — send those with slack.reply.
	 */
	escalate: (input: EscalateInput) => Promise<EscalateOutput>;

	/**
	 * Retract the open approval, e.g. because the customer's newest message made the draft moot. Loses gracefully: if a human already decided, you get their decision back instead of a withdrawal.
	 */
	withdraw: (input: WithdrawInput) => Promise<WithdrawOutput>;
}

type BootInput = {}
type BootOutput = {
    state: "provisioning" | "ready" | "failed";
    commit: string | null;
    repoPath: string;
    elapsedMs: number;
    note: string;
}
type ExecInput = {
    cmd: string;
    cwd?: string;
    timeoutMs?: number;
    injectDevEnv?: boolean;
}
type ExecOutput = {
    stdout: string;
    stderr: string;
    exitCode: number;
    truncated: boolean;
}
type SpawnInput = {
    cmd: string;
    cwd?: string;
    injectDevEnv?: boolean;
}
type SpawnOutput = {
    processId: string;
}
type CheckProcessInput = {
    processId: string;
}
type CheckProcessOutput = {
    running: boolean;
    exitCode: number | null;
    stdoutTail: string;
    stderrTail: string;
}
type KillProcessInput = {
    processId: string;
}
type KillProcessOutput = {
    killed: boolean;
}
type ReadFileInput = {
    path: string;
}
type ReadFileOutput = {
    content: string;
    truncated: boolean;
}
type WriteFileInput = {
    path: string;
    content: string;
}
type WriteFileOutput = {
    bytesWritten: number;
}
type PreviewInput = {
    port: number;
}
type PreviewOutput = {
    url: string;
}
type DiffInput = {}
type DiffOutput = {
    preview: string;
    truncated: boolean;
    filesChanged: number;
    insertions: number;
    deletions: number;
    diffRef: string | null;
}

declare const sandbox: {
	/**
	 * Start this run's container, or report on one already starting. Idempotent. The FIRST boot call in a code block waits up to ~14s for provisioning progress; any further boot call in the same block returns immediately — so call it once per block, and poll across blocks, not within one. A COLD machine clones the monorepo and installs from scratch, which takes 2-4 minutes (~10-14 blocks). Budget for that: call boot early, do genuinely useful work between polls (read memory, draft from what you already know, send a brief status reply if warranted), and only wait on the machine when nothing else moves the task. If the question is answerable without code — a how-to, a status — answer it; the machine is for reproducing, editing and running, not a reflex. Every other capability here refuses with sandbox_not_ready until state is 'ready'. `note` names the current provisioning step; `repoPath` is where commands run by default, and `pnpm build-packages` has already run by the time state is 'ready'.
	 */
	boot: (input: BootInput) => Promise<BootOutput>;

	/**
	 * Run one command to completion and get its output. It blocks, so it must finish inside this execution's budget: timeoutMs defaults to 10000 and anything above 15000 is REFUSED rather than quietly shortened. Use spawn for installs, builds, test suites and servers. Runs in the checkout unless cwd says otherwise. Set injectDevEnv when the command needs the app's dev-tier environment — the monorepo's dev scripts are Infisical-wrapped and there is no credential to authenticate with here, so run the inner command directly and pass this flag instead of running `pnpm dev`. Output is truncated per stream and scrubbed of injected values, so do not try to print them.
	 */
	exec: (input: ExecInput) => Promise<ExecOutput>;

	/**
	 * Start a long-running command in the background and get a processId back. This is how anything slower than a few seconds is run — a dev server, a build, a test suite — because one execution has 20 seconds and a blocking command cannot outlive it. Poll it with checkProcess on later turns. NEVER bind a server to port 3000: three apps here default to it, the port is a CLI flag inside their package script so a PORT variable does NOT override it, and 3000 is the container's own control server. Use 4100 or above, e.g. `pnpm --filter @web2app/web exec next dev --port 4100`. Dev scripts are Infisical-wrapped and cannot authenticate here, so run the inner command directly and pass injectDevEnv: true.
	 */
	spawn: (input: SpawnInput) => Promise<SpawnOutput>;

	/**
	 * Report on a process spawn started: whether it is still running, its exit code once it is not, and the tail of each output stream. This is the poll — call it on a later turn rather than looping here, since waiting burns the same 20 second budget the process needs. A server that is listening but erroring is still 'running'; read the tails to tell those apart.
	 */
	checkProcess: (input: CheckProcessInput) => Promise<CheckProcessOutput>;

	/**
	 * Stop a process this run started. `killed: false` means there was no such process, which is a fact rather than an error. Kill a dev server before starting another on the same port: a process that failed to come up is not reaped, keeps its port, and the next attempt dies with EADDRINUSE pointing at the wrong problem.
	 */
	killProcess: (input: KillProcessInput) => Promise<KillProcessOutput>;

	/**
	 * Read a text file from the container. Content is truncated with a visible marker and scrubbed of injected environment values. Narrow first with exec and grep or sed rather than reading a large file and searching it here — that is the whole reason you are running code instead of calling tools one at a time.
	 */
	readFile: (input: ReadFileInput) => Promise<ReadFileOutput>;

	/**
	 * Write a text file in the container, creating or replacing it whole. Before calling diff, format every file you edited with `pnpm exec biome check --write` and the explicit paths — this repo blocks unformatted commits. NEVER pass a directory or a computed-empty list to that command: it then sweeps the entire repo and rewrites files you never touched.
	 */
	writeFile: (input: WriteFileInput) => Promise<WriteFileOutput>;

	/**
	 * Open a public URL for a port inside the container and wait until it actually serves — a fresh tunnel answers 530 for several seconds, so this retries rather than reporting a broken one. Port 3000 is refused: it is the container's own control server, so a check against it succeeds whether or not your server ever started. Bind and preview 4100 or above.
	 */
	preview: (input: PreviewInput) => Promise<PreviewOutput>;

	/**
	 * Capture everything changed in the checkout, including new files. Returns a bounded preview plus an opaque diffRef; the full patch is stored intact and is what a pull request will be built from, so never reconstruct it from the preview or paste it back. `diffRef: null` means nothing changed. Format your edited files first — an unformatted change arrives as a review comment rather than a merge.
	 */
	diff: (input: DiffInput) => Promise<DiffOutput>;
}

type RecordInput = {
    script: string;
    label: string;
    timeoutMs?: number;
}
type RecordOutput = {
    recordingId: string;
}
type CheckRecordingInput = {
    recordingId: string;
}
type CheckRecordingOutput = {
    state: "running" | "passed" | "failed";
    url: string | null;
    error: string | null;
    stdoutTail: string;
    durationMs: number;
}

declare const browser: {
	/**
	 * Run a Playwright script with video recording, on this run's own container. `page` is already in scope — do not open a browser or a context yourself, do not call recordVideo, and do not call setViewportSize; the harness owns all three and records at a fixed 1280x720 — resizing the page only makes your own video letterbox with a grey band. Write the script as you would a Playwright test body and THROW to fail: the last expression's truthiness is never consulted. This does not block — it starts the recording and returns a recordingId; poll checkRecording for the result on a LATER turn, across blocks rather than in a loop inside this one, because a real run is minutes and this execution has seconds. `timeoutMs` defaults to 60000 (60 seconds) and bounds the SCRIPT: raise it when the first navigation has to wait for a cold dev server to compile the page, which routinely takes 20-40 seconds — otherwise the run fails with "script exceeded timeoutMs", which looks exactly like the bug reproducing and is not. Anything above 180000 (3 minutes) is REFUSED rather than quietly shortened. `script` is capped at 20000 characters and `label` at 200; both are refused, not truncated. A script that throws is not a wasted call: the harness still flushes a playable video of the failure, and checkRecording returns it — that recording IS the proof a bug is real, so keep it rather than re-running for a clean one. If this run's machine never got a working browser, checkRecording reports that by name (browser-unavailable) instead of a generic failure or a hang.
	 */
	record: (input: RecordInput) => Promise<RecordOutput>;

	/**
	 * Poll a recording record started. state: "running" means keep waiting — call again on a later turn, never in a tight loop here. Once it settles ("passed" or "failed"), url — when present — is a public link to a playable mp4: safe to paste as-is into a pull request body or a Slack message, no signing, no escaping, nothing else to fetch. error carries Playwright's own message when the script threw, trimmed to the useful part, or names browser-unavailable when this run's machine never got a working browser — either way it is a reason you can act on. A FAILED recording is a first-class result, not a dead end: its video is what proves the bug is real, and it is worth linking exactly like a passing one, not discarded in favor of a cleaner rerun.
	 */
	checkRecording: (input: CheckRecordingInput) => Promise<CheckRecordingOutput>;
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

declare const github: {
	/**
	 * Open a pull request on the monorepo from this run's diffRef, or update the one already open on `branch` — call this again after improving the fix rather than leaving stale content up; a second call on the same branch updates it, it does not open a second PR. `branch` must follow the convention `<type>/<2-4 kebab-case words>` (e.g. `fix/checkout-timeout`) and `title` must be `<type>: <imperative>`, using the same conventional type in both. The `Fixes <identifier>` line is GENERATED from `fixesIssueIds`, which accepts EITHER the id `linear.createIssue` returns OR a human identifier like `FIR-3` typed straight in — if the issue was filed by an EARLIER run and you have no id for it, call `linear.findIssue({ identifier })` first to confirm it exists and is in reach, then pass that identifier through directly — never type the word "Fixes" into `description`, `notesForReviewers`, or especially `commitMessage`: this Linear setup has commit-message magic words disabled, so a `Fixes` line inside a commit message links nothing, silently, and only the rendered PR body closes the issue on merge. Use `partOfIssueIds` for an umbrella or epic issue instead — same id/identifier shapes, but it renders `Part of`, which links WITHOUT closing, so a fix that only covers part of the epic cannot close the whole thing. Put the proof recording's URL in `proofUrl` (it lands under `## Screenshots`) and ALSO repeat it in your Slack reply — the reviewer reads the PR, the customer reads Slack, and each needs their own copy of the same link. `title`, `commitMessage`, `description` and `notesForReviewers` are REFUSED, not silently rewritten, if they contain co-authored-by, "generated with", the robot emoji, or the word "claude" in any case — this repository forbids AI attribution in PRs and their commits, and a silent strip would hide that rule rather than teach it. `description`, `notesForReviewers` and each `acceptanceCriteria` entry are likewise REFUSED if they contain a Markdown heading (a line starting with `#`) — the only headings this PR body ever has are the ones this tool itself renders (Description, Acceptance Criteria, Screenshots, Notes for reviewers), never one smuggled in through free text. After this returns, poll `checkPR` on a later turn until `linearLinkback.commented` is true — that confirms the Fixes/Part of lines actually took; if it never turns true after a few polls, say so instead of assuming the link worked.
	 */
	openPR: (input: OpenPRInput) => Promise<OpenPROutput>;

	/**
	 * Check one PR's live state — open, closed or merged — and whether the linear-code bot's linkback comment has landed (`linearLinkback.commented`). Call this on a LATER turn after `openPR`, not in a loop inside the same one: the bot's comment can take a little while to post. Once `commented` is true, the Fixes/Part of lines are confirmed wired to the issue(s); if it stays false after a few polls, say so in your reply rather than assuming the link took.
	 */
	checkPR: (input: CheckPRInput) => Promise<CheckPROutput>;
}
