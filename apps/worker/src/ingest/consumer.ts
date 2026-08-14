import type { Env } from "../index";
import type { QueuedEvent } from "../slack/types";
import { getChannelPolicy, shouldTriage } from "../db/channels";
import { insertMessage, recordEvent } from "../db/messages";
import { getPermalink } from "../slack/client";
import { classify } from "./rules";

/**
 * The real work of ingest, off the request path. Everything here is idempotent
 * on `event_id` because Slack retries up to three times. See spec §4.2.
 *
 * Permalink resolution is deliberately absent — Task 4 adds it as a backfill.
 * The D1 write must never depend on a network call succeeding.
 */
export async function handleIngestBatch(batch: MessageBatch<QueuedEvent>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const { event_id, event, received_at } = message.body;

    const policy = await getChannelPolicy(env.DB, event.channel);
    const outcome = classify(event, policy.known, {
      appId: env.SLACK_APP_ID,
      botUserId: env.SLACK_BOT_USER_ID,
    });

    const isFirstSighting = await recordEvent(env.DB, {
      event_id,
      channel_id: event.channel ?? null,
      outcome,
      received_at,
    });

    if (!isFirstSighting) continue;
    if (outcome !== "ingested" && outcome !== "ingested_self") continue;

    await insertMessage(env.DB, {
      event_id,
      channel_id: event.channel,
      ts: event.ts,
      thread_ts: event.thread_ts ?? null,
      user_id: event.user ?? null,
      text: event.text ?? "",
      subtype: event.subtype ?? null,
      permalink: null,
      customer_slug: policy.customer_slug,
      received_at,
    });

    // D1 is committed; everything downstream is a projection with its own
    // retry budget. A queue send failing must not fail ingest.
    try {
      await env.MEMORY_QUEUE.send({ event_id });
    } catch {}

    // THE LOOP GUARD. A self-post is stored (the agent must see its own words
    // in the thread) and remembered (memory must know what we told the
    // customer), but it NEVER reaches the triage queue — which is the only
    // path that wakes or re-enters a run. Without this line: agent replies →
    // event → routed back into the owning run as input → the agent reacts to
    // itself.
    if (outcome === "ingested" && shouldTriage(policy)) {
      try {
        await env.TRIAGE_QUEUE.send({ event_id });
      } catch {}
    }

    // Insert first, enrich second. A Slack API outage costs permalinks, never
    // messages — getPermalink swallows every failure and returns null.
    const permalink = await getPermalink(env.SLACK_BOT_TOKEN, event.channel, event.ts);
    if (permalink) {
      await env.DB.prepare("UPDATE messages SET permalink = ? WHERE event_id = ?")
        .bind(permalink, event_id)
        .run();
    }
  }
}
