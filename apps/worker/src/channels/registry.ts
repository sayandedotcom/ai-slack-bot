/**
 * How a channel enters the policy table.
 *
 * Before this module the table was seeded by hand (`scripts/seed-channels.sh`,
 * deleted with it): three channel ids pasted in by a human. Every message from
 * a channel nobody had pasted was ingested, stored, and then silently
 * dropped — `shouldTriage()` and `canPost()` both require a row, so an
 * unregistered channel produced no triage, no run, and no signal that anything
 * had been missed. With an unknown and growing number of customer channels
 * that is a bot which mostly does not work.
 *
 * So the table becomes a cache the bot fills itself, through exactly two paths,
 * both of which write through `registerChannel`:
 *
 *  1. LAZY, on the first ingested message from an unknown channel. Zero
 *     latency: the very message that revealed the channel is also triaged.
 *  2. THE CRON SWEEP, `sweepChannelMembership`. Registers channels the bot was
 *     invited to but nobody has spoken in yet, and self-heals anything the lazy
 *     path missed — a Slack API blip, or an invite that arrived while the
 *     Worker was mid-deploy.
 *
 * Deliberately NOT a third path: the `member_joined_channel` event. It would
 * change the webhook's envelope filter and the `QueuedEvent` shape to cover a
 * case the sweep already covers within a minute, and unlike the sweep it does
 * not self-heal a delivery Slack dropped. See the design doc,
 * `docs/superpowers/specs/2026-08-27-generic-channel-registry-design.md` C1.
 *
 * WHAT THIS MODULE DOES NOT DO. It never demotes and never deletes. A row's
 * `mode` and `customer_slug` are a human's decision once written, so
 * re-registration touches neither, and a channel the bot has been removed from
 * keeps its row — Slack itself refuses the post with `not_in_channel`, which is
 * a better enforcement point than a row we would have to keep in sync.
 */
import { getChannelPolicy, type ChannelPolicy } from "../db/channels";
import type { Env } from "../index";
import { getConversationInfo, listBotConversations } from "../slack/client";

/**
 * The customer key derived from a channel name.
 *
 * This is not cosmetic: the slug is the Zep graph id (`customer:{slug}`) and
 * the Supabase tenant filter, so it must be stable for the life of a channel.
 * It is derived once, at registration, and never recomputed — renaming a Slack
 * channel must not silently move a customer's memory to a new graph.
 *
 * A name that reduces to nothing (all punctuation) falls back to the channel
 * id, which is stable and unique even if it is ugly.
 */
export function deriveSlug(name: string, channelId: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? channelId.toLowerCase() : slug;
}

/**
 * What a newly discovered channel is allowed to do.
 *
 * `live` — heard, triaged, and postable. Invite is consent: the operator put
 * the bot in the channel, and a bot that has to be enabled twice is the manual
 * step this module exists to remove.
 *
 * This is not a weakening of the approval gate. `live` means the agent may
 * PROPOSE; every customer-facing send still resolves a connected fire-fighter
 * identity and goes out under that human's name, and `assertExternalWritePermitted`
 * still re-reads this row from D1 at call time. Demoting a channel is one SQL
 * update away and takes effect on the next write of a run already in flight.
 */
const DEFAULT_MODE = "live" as const;

/**
 * Ensure a channel has a policy row, and return the policy to use.
 *
 * Returns the EXISTING policy untouched when the channel is already known —
 * this is called on the hot ingest path, so the common case is one D1 read and
 * nothing else.
 *
 * Returns `null` only when the channel could not be identified: Slack refused
 * `conversations.info`, or answered that this is a DM. A null is not a failure
 * to propagate — the caller keeps the unknown policy, the message is still
 * stored, and the sweep tries again within the minute. Registering under a
 * fallback name was rejected precisely because the slug is derived from it and
 * a wrong slug is permanent.
 */
export async function registerChannel(
  env: Env,
  channelId: string
): Promise<ChannelPolicy | null> {
  const existing = await getChannelPolicy(env.DB, channelId);
  if (existing.known) return existing;

  const info = await getConversationInfo(env.SLACK_BOT_TOKEN, channelId);
  if (info === null) return null;

  await insertChannel(env.DB, info.id, info.name);
  // Re-read rather than synthesise the row we think we wrote: another isolate
  // may have registered the same channel first (two messages arriving
  // together), and the row that WON is the one every later read will see.
  const registered = await getChannelPolicy(env.DB, channelId);
  return registered.known ? registered : null;
}

/**
 * The insert, `DO NOTHING` on conflict.
 *
 * Two messages from a new channel can land in the same batch, and the sweep can
 * run against a channel the lazy path is registering right now. The conflict
 * clause is what makes all three orderings produce one row — and it is
 * `DO NOTHING` rather than `DO UPDATE` because the losing writer must not
 * overwrite a slug the winner already derived, still less one a human has since
 * corrected.
 */
async function insertChannel(
  db: D1Database,
  channelId: string,
  name: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO channels (channel_id, name, customer_slug, mode)
            VALUES (?, ?, ?, ?)
       ON CONFLICT(channel_id) DO NOTHING`
    )
    .bind(channelId, name, deriveSlug(name, channelId), DEFAULT_MODE)
    .run();
}

/**
 * Register every channel the bot is in that has no row yet.
 *
 * Runs as one of the cron's independent sweeps. It only ever ADDS: a channel
 * missing from Slack's answer is not evidence the bot was removed (the list is
 * `[]` on any API failure), so absence is never acted on.
 */
export async function sweepChannelMembership(
  env: Env
): Promise<{ registered: number }> {
  const channels = await listBotConversations(env.SLACK_BOT_TOKEN);
  let registered = 0;

  for (const channel of channels) {
    const policy = await getChannelPolicy(env.DB, channel.id);
    if (policy.known) continue;
    await insertChannel(env.DB, channel.id, channel.name);
    registered++;
  }

  return { registered };
}
