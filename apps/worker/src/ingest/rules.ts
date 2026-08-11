import type { SlackMessageEvent } from "../slack/types";

export type IngestOutcome = "ingested" | "dropped_dm" | "dropped_bot" | "dropped_subtype";

const DROPPED_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "message_changed",
  "message_deleted",
  "thread_broadcast_deleted",
]);

/**
 * Decide what happens to one message event. Pure: no I/O, so the whole drop
 * policy is testable in isolation.
 *
 * The DM check comes first and is unconditional. The installed app holds
 * im:history and im:read, so Slack really does deliver DM events here — this
 * line is the only thing keeping them out of D1. See spec §4.1.
 *
 * Channel mapping deliberately does NOT gate ingest. Core requirement 1: "every
 * message in every channel the team is in is heard by the webhook and ingested";
 * only *triage* is restricted to customer channels. An unmapped channel is
 * heard and stored with a null customer_slug, which makes shouldTriage() and
 * canPost() both false — the fail-closed property lives there, not here.
 *
 * `channelKnown` is retained in the signature because callers already resolve
 * the policy and later phases may want to branch on it.
 */
export function classify(event: SlackMessageEvent, channelKnown: boolean): IngestOutcome {
  void channelKnown;
  if (event.channel_type === "im" || event.channel_type === "mpim") return "dropped_dm";
  if (event.bot_id || event.subtype === "bot_message") return "dropped_bot";
  if (event.subtype && DROPPED_SUBTYPES.has(event.subtype)) return "dropped_subtype";
  return "ingested";
}
