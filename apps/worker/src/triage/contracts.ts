/**
 * One customer message, as the run layer needs it.
 *
 * Declared here rather than in the run layer because triage is what produces
 * it and triage outlives any particular agent chassis: the fields are the
 * message's own facts (its Slack identity, its text, its permalink), not
 * anything about how a run is implemented.
 */
export type SlackRunMessage = {
  eventId: string;
  channelId: string;
  /** The message's own ts; canonicalised against threadTs by the consumer. */
  ts: string;
  threadTs: string | null;
  text: string;
  userId: string | null;
  permalink: string | null;
};
