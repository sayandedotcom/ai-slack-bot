import type { Env } from "../index";
import { canonicalThreadTs, chatRunKey, runStubForKey, slackRunKey } from "./keys";
import {
  createOrGetRun,
  findOwnedSlackRun,
  getRunByKey,
  type RunDescriptor,
  type RunRecord,
} from "./repository";
import type { RunDO } from "./do";

/**
 * Infrastructure choreography only: create or find the D1 row, resolve the
 * stub, make sure the object knows who it is, then append through the one
 * inbox.
 *
 * It may branch on `origin` to build identity. It must never branch on what a
 * message is *about* — there is no bug/feature/question anywhere in this file,
 * and adding one would rebuild the banned per-ticket-type pipeline here.
 */

export type RunStub = DurableObjectStub<RunDO>;

export type SlackRunMessage = {
  eventId: string;
  channelId: string;
  /** The message's own ts; canonicalised against threadTs below. */
  ts: string;
  threadTs: string | null;
  text: string;
  userId: string | null;
  permalink: string | null;
};

/**
 * Resolve a run to a live object, creating the index row on first sight. Safe
 * to call repeatedly: both the D1 insert and `initialize` are idempotent.
 */
export async function ensureRun(
  env: Env,
  descriptor: RunDescriptor,
): Promise<{ run: RunRecord; stub: RunStub }> {
  const run = await createOrGetRun(env.DB, descriptor);
  const stub = runStubForKey(env.RUNS, run.key);
  await stub.initialize({
    runId: run.id,
    key: run.key,
    origin: run.origin,
    channelId: run.channelId,
    threadTs: run.threadTs,
  });
  return { run, stub };
}

/**
 * Chat runs mint TWO uuids. The public one goes in dashboard URLs; the private
 * one is the `chat:{uuid}` origin key. Reusing a single value would make the
 * public id trivially convertible into the `idFromName()` input and void the
 * rule that a public run id is not a Durable Object name.
 */
export async function createChatRun(
  env: Env,
  options: { firstMessage?: string; requestId?: string } = {},
): Promise<{ run: RunRecord; stub: RunStub }> {
  const key = chatRunKey(crypto.randomUUID());
  const { run, stub } = await ensureRun(env, {
    key,
    origin: "chat",
    channelId: null,
    threadTs: null,
  });

  const first = options.firstMessage?.trim();
  if (first) {
    await stub.appendTurn({
      id: `steer:${options.requestId ?? run.id}`,
      role: "user",
      source: "human_steer",
      content: first,
    });
  }

  return { run, stub };
}

/**
 * Triage decided this thread is worth waking. Appends exactly one opening turn.
 *
 * The opening prompt already contains the triggering customer message, so that
 * message is NOT appended a second time — see the stable-id table in the plan.
 * `triage:{event_id}` makes a queue replay a no-op.
 */
export async function wakeSlackRun(
  env: Env,
  input: {
    eventId: string;
    channelId: string;
    threadTs: string;
    openingPrompt: string;
  },
): Promise<RunRecord> {
  const key = slackRunKey(input.channelId, input.threadTs);
  const { run, stub } = await ensureRun(env, {
    key,
    origin: "slack",
    channelId: input.channelId,
    threadTs: input.threadTs,
  });

  // A finished thread that earns a new wake reopens the SAME object, keeping
  // its history, rather than forking a message-scoped second one. The `live`
  // transition is NOT made here: it belongs to the same local transaction that
  // schedules the work, so the run can never read live with nothing scheduled.
  await stub.appendTurn({
    id: `triage:${input.eventId}`,
    role: "system",
    source: "triage",
    content: input.openingPrompt,
    metadata: { eventId: input.eventId, channelId: input.channelId, threadTs: input.threadTs },
  });

  const refreshed = await getRunByKey(env.DB, key);
  return refreshed ?? run;
}

/**
 * A later message in a thread a run already owns. Returns true only when the
 * message has been COMMITTED as a turn — the caller uses that to decide whether
 * triage still needs to run, so "found but not stored" would silently drop the
 * customer's message.
 */
export async function routeSlackMessageToOwnedRun(
  env: Env,
  message: SlackRunMessage,
): Promise<boolean> {
  const threadTs = canonicalThreadTs(message.ts, message.threadTs);
  const owned = await findOwnedSlackRun(env.DB, message.channelId, threadTs);
  if (!owned) return false;

  const stub = runStubForKey(env.RUNS, owned.key);
  await stub.appendTurn({
    id: `slack:${message.eventId}`,
    role: "user",
    source: "customer",
    content: message.text,
    metadata: {
      eventId: message.eventId,
      channelId: message.channelId,
      threadTs,
      ts: message.ts,
      userId: message.userId,
      permalink: message.permalink,
    },
  });

  // An interruption makes the run live again — the customer is waiting, even if
  // the agent had parked on an approval — and `appendTurn` has already done it,
  // atomically with the turn that caused it.
  return true;
}
