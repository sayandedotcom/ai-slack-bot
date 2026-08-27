/**
 * Resolve a message's canonical Slack permalink. Returns null on any failure —
 * a missing permalink must never cost us the message itself. Task 3 writes the
 * row first; this enriches it.
 */
export async function getPermalink(
  botToken: string,
  channel: string,
  ts: string,
): Promise<string | null> {
  const url = new URL("https://slack.com/api/chat.getPermalink");
  url.searchParams.set("channel", channel);
  url.searchParams.set("message_ts", ts);

  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${botToken}` } });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok: boolean; permalink?: string };
    return body.ok && body.permalink ? body.permalink : null;
  } catch {
    return null;
  }
}

/** A channel as the registry cares about it: an id and a human name. */
export type SlackChannelInfo = { id: string; name: string };

/**
 * Resolve one channel's name.
 *
 * Returns null for anything that is not a real channel — a DM or a group DM —
 * as well as on any failure. The DM refusal is belt-and-braces: `classify`
 * already drops DM events before registration is reached, and this is the
 * second door on the rule that this app is channels-only.
 *
 * Null on failure rather than throwing, for the same reason `getPermalink`
 * does it: a Slack outage must cost enrichment, never a message. An
 * unregistered channel is picked up by the next message or by the cron sweep.
 */
export async function getConversationInfo(
  botToken: string,
  channelId: string,
): Promise<SlackChannelInfo | null> {
  const url = new URL("https://slack.com/api/conversations.info");
  url.searchParams.set("channel", channelId);

  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${botToken}` } });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      ok: boolean;
      channel?: { id?: string; name?: string; is_im?: boolean; is_mpim?: boolean };
    };
    const channel = body.channel;
    if (!body.ok || !channel?.id || !channel.name) return null;
    if (channel.is_im === true || channel.is_mpim === true) return null;
    return { id: channel.id, name: channel.name };
  } catch {
    return null;
  }
}

/** How many `users.conversations` pages the sweep will walk in one tick. */
const MAX_CONVERSATION_PAGES = 5;

/**
 * Every public and private channel this bot is a member of.
 *
 * `types` deliberately excludes `im` and `mpim`, so a DM cannot enter the
 * channel table through the sweep even if the app somehow holds `im:read`.
 *
 * Returns `[]` on any failure — the sweep is a repair path, and a Slack outage
 * that emptied it must not be mistaken for "the bot is in no channels", which
 * is why nothing downstream ever deletes a row based on absence from this list.
 */
export async function listBotConversations(botToken: string): Promise<SlackChannelInfo[]> {
  const found: SlackChannelInfo[] = [];
  let cursor = "";

  try {
    for (let page = 0; page < MAX_CONVERSATION_PAGES; page++) {
      const url = new URL("https://slack.com/api/users.conversations");
      url.searchParams.set("types", "public_channel,private_channel");
      url.searchParams.set("exclude_archived", "true");
      url.searchParams.set("limit", "200");
      if (cursor !== "") url.searchParams.set("cursor", cursor);

      const res = await fetch(url, { headers: { authorization: `Bearer ${botToken}` } });
      if (!res.ok) return [];
      const body = (await res.json()) as {
        ok: boolean;
        channels?: { id?: string; name?: string }[];
        response_metadata?: { next_cursor?: string };
      };
      if (!body.ok) return [];

      for (const channel of body.channels ?? []) {
        if (channel.id && channel.name) found.push({ id: channel.id, name: channel.name });
      }

      cursor = body.response_metadata?.next_cursor ?? "";
      if (cursor === "") break;
    }
  } catch {
    return [];
  }

  return found;
}
