import type { SlackMessageEvent } from "../slack/types";

export type IngestOutcome =
  | "ingested"
  | "dropped_dm"
  | "dropped_bot"
  | "dropped_subtype"
  | "dropped_unknown_channel";

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
 */
export function classify(event: SlackMessageEvent, channelKnown: boolean): IngestOutcome {
  if (event.channel_type === "im" || event.channel_type === "mpim") return "dropped_dm";
  if (event.bot_id || event.subtype === "bot_message") return "dropped_bot";
  if (event.subtype && DROPPED_SUBTYPES.has(event.subtype)) return "dropped_subtype";
  if (!channelKnown) return "dropped_unknown_channel";
  return "ingested";
}
