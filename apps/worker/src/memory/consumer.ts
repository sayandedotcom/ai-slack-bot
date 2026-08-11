import type { Env } from "../index";
import type { MemoryStore } from "./store";
import { getChannelPolicy } from "../db/channels";
import { graphIdFor } from "./graphs";

export type MemoryJob = { event_id: string };

type MessageRow = {
  event_id: string;
  channel_id: string;
  user_id: string | null;
  text: string;
};

/**
 * Projects D1 messages into Zep, one episode per message. D1 committed before
 * this job existed, so every failure path here is safe: retry re-reads the row,
 * and the zep_episodes check makes a duplicate delivery a no-op.
 */
export async function handleMemoryBatch(
  batch: MessageBatch<MemoryJob>,
  env: Env,
  store: MemoryStore,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await projectOne(message.body.event_id, env, store);
      message.ack();
    } catch {
      message.retry();
    }
  }
}

async function projectOne(eventId: string, env: Env, store: MemoryStore): Promise<void> {
  const mapped = await env.DB.prepare("SELECT 1 FROM zep_episodes WHERE event_id = ?")
    .bind(eventId)
    .first();
  if (mapped) return;

  const row = await env.DB.prepare(
    "SELECT event_id, channel_id, user_id, text FROM messages WHERE event_id = ?",
  )
    .bind(eventId)
    .first<MessageRow>();
  if (!row) return; // Nothing in D1 means nothing to project.

  const policy = await getChannelPolicy(env.DB, row.channel_id);
  const graphId = graphIdFor(policy);
  if (!graphId) return;

  const { episodeUuid } = await store.addMessage(graphId, `${row.user_id ?? "unknown"}: ${row.text}`);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO zep_episodes (episode_uuid, event_id, graph_id, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(episodeUuid, eventId, graphId, Date.now())
    .run();
}
