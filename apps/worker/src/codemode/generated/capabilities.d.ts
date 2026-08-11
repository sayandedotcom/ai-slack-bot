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
	 * Search previously ingested messages within the scope this run already has.
	 */
	searchMessages: (input: SearchMessagesInput) => Promise<SearchMessagesOutput>;

	/**
	 * Post a reply into the conversation this run belongs to. The destination is fixed by the run and cannot be chosen here.
	 */
	reply: (input: ReplyInput) => Promise<ReplyOutput>;
}

type RecallInput = {
    query: string;
    scope?: "customer" | "org";
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
    source: string;
    permalink: string | null;
}[]

declare const memory: {
	/**
	 * Recall previously recorded facts. Scope 'customer' stays within this run's customer; 'org' covers shared engineering knowledge.
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
    steps: {
        name: string;
        depth: number;
        status: string;
        durationMs: number;
    }[];
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
	 * Fetch one recorded run by its identifier, with its steps flattened into a list.
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
