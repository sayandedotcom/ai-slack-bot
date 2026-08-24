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
