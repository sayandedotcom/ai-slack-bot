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
