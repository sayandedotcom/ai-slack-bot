import type { SlackMessageEvent } from "../slack/types";

export type IngestOutcome =
  | "ingested"
  | "ingested_self"
  | "dropped_dm"
  | "dropped_bot"
  | "dropped_subtype";

/**
 * How this app recognises its own user-token posts in the event stream.
 * Both values are public identifiers (they appear in every message this app
 * posts), pinned in wrangler.jsonc vars.
 */
export type SelfIdentity = { appId: string; botUserId: string };

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
export function classify(
  event: SlackMessageEvent,
  channelKnown: boolean,
  self?: SelfIdentity,
): IngestOutcome {
  void channelKnown;
  if (event.channel_type === "im" || event.channel_type === "mpim") return "dropped_dm";
  if (event.subtype === "bot_message") return "dropped_bot";

  if (event.bot_id) {
    /**
     * Slack stamps `bot_id` + `app_id` onto EVERY message an app posts through
     * the API — a reply sent with an engineer's USER token included (verified
     * live 2026-08-14: agent replies carried `user: <human>` plus both stamps).
     * A blanket bot_id drop therefore erased this app's own replies from D1,
     * blinding the agent to its own promises.
     *
     * The narrow exception is a SELF-post: OUR `app_id`, speaking as a HUMAN.
     * The `user !== botUserId` clause is what keeps the nudge out — a
     * bot-token post carries the bot's own user id there. `app_id` is the pin
     * rather than `bot_id` because bot ids are not stable identifiers
     * (auth.test and message events report different ones for this very app).
     * Foreign apps stay dropped, and an unconfigured `self` fails safe by
     * dropping everything bot-flavored — the pre-fix behavior.
     */
    const isSelfPost =
      self !== undefined &&
      event.app_id === self.appId &&
      typeof event.user === "string" &&
      event.user.length > 0 &&
      event.user !== self.botUserId;
    if (!isSelfPost) return "dropped_bot";
    if (event.subtype && DROPPED_SUBTYPES.has(event.subtype)) return "dropped_subtype";
    return "ingested_self";
  }

  if (event.subtype && DROPPED_SUBTYPES.has(event.subtype)) return "dropped_subtype";
  return "ingested";
}
