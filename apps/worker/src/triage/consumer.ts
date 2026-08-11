import type { Env } from "../index";
import type { MemoryStore } from "../memory/store";
import type { TriageInput } from "./prompt";
import type { TriageRunner } from "./run";
import { getChannelPolicy, shouldTriage } from "../db/channels";
import { graphIdFor } from "../memory/graphs";

export type TriageJob = { event_id: string };

export type TriageDeps = {
  triage: TriageRunner;
  memory: MemoryStore;
  /**
   * Whether a live run already owns this thread — in that case the message
   * becomes a turn, not a triage subject. Defaults to false until Phase 08
   * wires the runs table in. Spec §4.3.
   */
  hasLiveRun?: (channelId: string, threadTs: string) => Promise<boolean>;
};

type MessageRow = {
  event_id: string;
  channel_id: string;
  ts: string;
  thread_ts: string | null;
  user_id: string | null;
  text: string;
  permalink: string | null;
};

export async function handleTriageBatch(
  batch: MessageBatch<TriageJob>,
  env: Env,
  deps: TriageDeps,
): Promise<void> {
  const hasLiveRun = deps.hasLiveRun ?? (async () => false);
  for (const message of batch.messages) {
    try {
      await triageOne(message.body.event_id, env, deps, hasLiveRun);
      message.ack();
    } catch {
      message.retry();
    }
  }
}

async function triageOne(
  eventId: string,
  env: Env,
  deps: TriageDeps,
  hasLiveRun: NonNullable<TriageDeps["hasLiveRun"]>,
): Promise<void> {
  const decided = await env.DB.prepare("SELECT 1 FROM triage_decisions WHERE event_id = ?")
    .bind(eventId)
    .first();
  if (decided) return;

  const row = await env.DB.prepare(
    "SELECT event_id, channel_id, ts, thread_ts, user_id, text, permalink FROM messages WHERE event_id = ?",
  )
    .bind(eventId)
    .first<MessageRow>();
  if (!row) return;

  // Belt and suspenders: the producer already filters on shouldTriage, but a
  // policy change between enqueue and consume must fail closed.
  const policy = await getChannelPolicy(env.DB, row.channel_id);
  if (!shouldTriage(policy) || policy.customer_slug === null) return;

  const threadTs = row.thread_ts ?? row.ts;
  if (await hasLiveRun(row.channel_id, threadTs)) return;

  const { results: threadRows } = await env.DB.prepare(
    `SELECT user_id, text FROM messages
     WHERE channel_id = ? AND (thread_ts = ? OR ts = ?) AND event_id != ?
     ORDER BY ts ASC LIMIT 30`,
  )
    .bind(row.channel_id, threadTs, threadTs, eventId)
    .all<{ user_id: string | null; text: string }>();

  // Recall is best-effort: triage must keep working when Zep is down.
  let recall: TriageInput["recall"] = [];
  const graphId = graphIdFor(policy);
  if (graphId) {
    try {
      recall = await deps.memory.search(graphId, row.text, 5);
    } catch {}
  }

  const input: TriageInput = {
    channelName: policy.name,
    customerSlug: policy.customer_slug,
    message: { user_id: row.user_id, text: row.text, permalink: row.permalink },
    thread: threadRows,
    recall,
  };

  const outcome = await deps.triage(input);

  await env.DB.prepare(
    `INSERT OR IGNORE INTO triage_decisions
       (event_id, wake, why, opening_prompt, model, cost_usd, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      eventId,
      outcome.wake ? 1 : 0,
      outcome.why,
      outcome.opening_prompt,
      outcome.model,
      outcome.cost_usd,
      outcome.latency_ms,
      Date.now(),
    )
    .run();
  // Phase 08 adds here: if outcome.wake, wake the thread's RunDO with opening_prompt.
}
