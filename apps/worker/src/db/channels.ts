export type ChannelMode = "observe" | "live" | "internal";

export type ChannelPolicy = {
  channel_id: string;
  name: string;
  customer_slug: string | null;
  mode: ChannelMode;
  /** False when the channel is absent from the table. Drives the fail-closed rule. */
  known: boolean;
};

/**
 * Resolve a channel's posting policy. An unmapped channel gets `observe`, which
 * is never postable. Fail closed: the cost of being wrong here is a stray
 * message to a real customer under an engineer's name. See spec §4.4.
 */
export async function getChannelPolicy(db: D1Database, channelId: string): Promise<ChannelPolicy> {
  const row = await db
    .prepare("SELECT channel_id, name, customer_slug, mode FROM channels WHERE channel_id = ?")
    .bind(channelId)
    .first<{ channel_id: string; name: string; customer_slug: string | null; mode: ChannelMode }>();

  if (!row) {
    return { channel_id: channelId, name: channelId, customer_slug: null, mode: "observe", known: false };
  }
  return { ...row, known: true };
}

/** Only `live` channels accept outbound messages. Everything else refuses. */
export function canPost(policy: ChannelPolicy): boolean {
  return policy.known && policy.mode === "live";
}

/**
 * Triage runs on customer channels — both the live ones and the reference ones.
 * Reference traffic is the eval set (spec §4.5); withholding it would mean
 * tuning the triage prompt against messages we wrote ourselves.
 */
export function shouldTriage(policy: ChannelPolicy): boolean {
  return policy.known && policy.customer_slug !== null && policy.mode !== "internal";
}
