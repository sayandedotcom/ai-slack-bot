import { getChannelPolicy, shouldTriage } from "../db/channels";
import type { MessagesRow, RunsRow, TriageDecisionsRow } from "../db/schema";
import type { Env } from "../index";
import { graphIdFor } from "../memory/graphs";
import type { MemoryStore } from "../memory/store";
import type { SlackRunMessage } from "./contracts";
import type { TriageInput } from "./prompt";
import type { TriageRunner } from "./run";

export type TriageJob = { event_id: string };

export type TriageDeps = {
  triage: TriageRunner;
  memory: MemoryStore;
  /**
   * Hand the message to a run that already owns this thread.
   *
   * Returns true only when the message has been COMMITTED as a turn. The
   * earlier `hasLiveRun` seam could report ownership without storing anything,
   * which silently dropped the customer's follow-up, and it split "check" from
   * "append" into two steps that could race. One operation, one answer.
   *
   * Spec §4.3.
   */
  routeToOwnedRun?: (message: SlackRunMessage) => Promise<boolean>;
  /**
   * Wake the thread's run with the stored opening prompt. Must be idempotent:
   * it is replayed whenever a stored wake decision is found again.
   */
  wakeRun?: (input: {
    eventId: string;
    channelId: string;
    threadTs: string;
    openingPrompt: string;
  }) => Promise<void>;
};

type MessageRow = Pick<
  MessagesRow,
  | "event_id"
  | "channel_id"
  | "ts"
  | "thread_ts"
  | "user_id"
  | "text"
  | "permalink"
>;

export async function handleTriageBatch(
  batch: MessageBatch<TriageJob>,
  env: Env,
  deps: TriageDeps
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await triageOne(message.body.event_id, env, deps);
      message.ack();
    } catch {
      message.retry();
    }
  }
}

async function loadMessage(
  env: Env,
  eventId: string
): Promise<MessageRow | null> {
  return env.DB.prepare(
    "SELECT event_id, channel_id, ts, thread_ts, user_id, text, permalink FROM messages WHERE event_id = ?"
  )
    .bind(eventId)
    .first<MessageRow>();
}

/**
 * Order matters here, and only one order is correct.
 *
 *   1. stored decision?  wake=0 -> done.  wake=1 -> replay the wake, done.
 *   2. load the message
 *   3. policy gate
 *   4. does a run already own the thread? if so it now holds the message
 *   5. ask the model, store the decision
 *   6. wake, and throw on failure so the queue retries
 *
 * The decision check MUST stay above step 4. A wake that half-succeeded leaves
 * a live run owning the thread; on retry, step 4 would otherwise append the
 * triggering message as a `customer` turn even though the opening prompt
 * already contains it. Keeping the decision check first means a retry always
 * takes the replay branch and never reaches routeToOwnedRun.
 */
async function triageOne(
  eventId: string,
  env: Env,
  deps: TriageDeps
): Promise<void> {
  const decided = await env.DB.prepare(
    "SELECT wake, opening_prompt FROM triage_decisions WHERE event_id = ?"
  )
    .bind(eventId)
    .first<Pick<TriageDecisionsRow, "wake" | "opening_prompt">>();

  if (decided) {
    if (decided.wake !== 1) return;

    // The decision committed but the wake may not have. Replaying is safe:
    // triage:{event_id} makes the opening turn idempotent, and the model is
    // never called again.
    const row = await loadMessage(env, eventId);
    if (!row) return;
    await deps.wakeRun?.({
      eventId,
      channelId: row.channel_id,
      threadTs: row.thread_ts ?? row.ts,
      openingPrompt: decided.opening_prompt,
    });
    return;
  }

  const row = await loadMessage(env, eventId);
  if (!row) return;

  // Belt and suspenders: the producer already filters on shouldTriage, but a
  // policy change between enqueue and consume must fail closed.
  const policy = await getChannelPolicy(env.DB, row.channel_id);
  if (!shouldTriage(policy) || policy.customer_slug === null) return;

  const threadTs = row.thread_ts ?? row.ts;

  // A message an existing run absorbs writes no triage_decisions row, so the
  // `triaged` counter does not count it. That is correct: no decision was made.
  if (deps.routeToOwnedRun) {
    const routed = await deps.routeToOwnedRun({
      eventId,
      channelId: row.channel_id,
      ts: row.ts,
      threadTs: row.thread_ts,
      text: row.text,
      userId: row.user_id,
      permalink: row.permalink,
    });
    if (routed) return;
  }

  const { results: threadRows } = await env.DB.prepare(
    `SELECT user_id, text FROM messages
     WHERE channel_id = ? AND (thread_ts = ? OR ts = ?) AND event_id != ?
     ORDER BY ts ASC LIMIT 30`
  )
    .bind(row.channel_id, threadTs, threadTs, eventId)
    .all<Pick<MessagesRow, "user_id" | "text">>();

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

  // THE ABANDONED-THREAD OVERRIDE.
  //
  // Observed live, twice. The agent replies "Looking at it now", its run then
  // dies, and every follow-up the customer sends is reasoned into silence:
  // triage reads the promise sitting in the thread, correctly concludes the
  // work is already in hand, and returns wake=0. Nothing notifies anyone, so
  // the thread is dead permanently — and it gets MORE certain the more
  // naturally the customer refers to the existing investigation.
  //
  // The model is not wrong. It is reasoning from the conversation, which is
  // all it can see, and the conversation genuinely says someone is on it. The
  // missing fact is infrastructure state, so the correction is structural
  // rather than another prompt line: a thread whose run died is not being
  // handled, whatever the transcript implies.
  //
  // `routeToOwnedRun` has already run and released the terminal run, which is
  // why control reaches here at all.
  const abandoned = await threadRunFailed(env, row.channel_id, threadTs);
  const wake = outcome.wake || abandoned;
  const why =
    abandoned && !outcome.wake
      ? `[abandoned-thread override: the run that owned this thread failed, so nothing is handling it] ${outcome.why}`
      : outcome.why;
  // A wake=0 decision has no reason to carry a usable opening prompt, so the
  // override cannot assume one. Falling back to the customer's own words is
  // both honest and enough for the agent to start from. The fallback is only
  // for a wake: an ordinary decline stores what the model wrote (which may be
  // ""), so the table never claims a run died when none did — and the "failed
  // before it finished" line is only added when that is actually true.
  const openingPrompt =
    wake && outcome.opening_prompt.trim().length === 0
      ? `${policy.customer_slug} wrote in ${policy.name}: ${row.text}` +
        (abandoned
          ? `\n\nA previous attempt on this thread failed before it finished. Pick it up.`
          : "")
      : outcome.opening_prompt;

  await env.DB.prepare(
    `INSERT OR IGNORE INTO triage_decisions
       (event_id, wake, why, opening_prompt, model, cost_usd, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      eventId,
      wake ? 1 : 0,
      why,
      openingPrompt,
      outcome.model,
      outcome.cost_usd,
      outcome.latency_ms,
      Date.now()
    )
    .run();

  if (!wake) return;

  // Throw on failure so the queue retries. Acknowledging a wake decision whose
  // wake has not been durably delivered would strand an actionable message
  // forever: the stored decision would make every later attempt return early.
  await deps.wakeRun?.({
    eventId,
    channelId: row.channel_id,
    threadTs,
    openingPrompt,
  });
}

/**
 * Did the run that last owned this thread die?
 *
 * Only `failed` counts. `idle` and `done` are healthy terminal states — an
 * idle run is waiting on the customer, which is exactly the case the model's
 * own judgement should decide — so treating them as abandoned would wake a run
 * for every follow-up and undo the point of triage.
 *
 * Newest row only. A thread that failed once, was picked up by this override
 * and then settled must not be forced awake forever after.
 */
async function threadRunFailed(
  env: Env,
  channelId: string,
  threadTs: string
): Promise<boolean> {
  const run = await env.DB.prepare(
    `SELECT status FROM runs
      WHERE origin = 'slack' AND channel_id = ? AND thread_ts = ?
      ORDER BY created_at DESC
      LIMIT 1`
  )
    .bind(channelId, threadTs)
    .first<Pick<RunsRow, "status">>();
  return run?.status === "failed";
}
