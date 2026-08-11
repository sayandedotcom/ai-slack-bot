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
