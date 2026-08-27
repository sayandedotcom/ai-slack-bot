/**
 * What a finished turn leaves behind in memory.
 *
 * Zep already receives customer MESSAGES. This is the agent's half: one bounded
 * episode per turn saying what it was asked, what it did, what it drafted, and
 * how it ended. `src/memory/episode.ts` owns the bounds and the redaction; this
 * module owns where each field COMES FROM, which is the part that decides
 * whether the exclusion list holds.
 *
 * THE EXCLUSION LIST IS STRUCTURAL HERE, not a filter (invariants 18, 33, 39):
 *
 *  - `asked` is the turn's own user message text, read once at `beforeTurn`;
 *  - `draft` is the SELECTED final assistant text handed to `onChatResponse` —
 *    never a stream delta, because deltas never reach this module;
 *  - `actions` are capability NAMES and error CODES off the audit sink — never
 *    a tool result, never model-authored code;
 *  - reasoning is absent because there is nothing to take it from: the provider
 *    returns thinking with an empty text field (invariant 17) and no field here
 *    reads a reasoning part at all.
 *
 * The handoff is D1 first, queue second. `ensureOutboxRow` is the durable
 * record and it is `ON CONFLICT DO NOTHING`, so a redelivered turn writes
 * nothing new; the queue send is the fast path and the one-minute cron sweep is
 * the backstop for when it fails. Neither may fail a customer's answer — memory
 * lag is an operational warning, not an incident.
 */

import type { UIMessage } from "ai";

import { getChannelPolicy } from "../db/channels";
import type { CapabilityAuditSink } from "../capabilities/audit";
import type { Env } from "../index";
import {
  buildAgentEpisode,
  describeAction,
  discardingProvenanceSink,
  type EpisodeOutcome,
  type EpisodeSourceDescriptor,
  type ProvenanceSink,
} from "../memory/episode";
import { agentGraphIdFor } from "../memory/graphs";
import { ensureOutboxRow } from "../memory/outbox";
import type { RunOrigin } from "./keys";
import type { RunStatus } from "./protocol";

/**
 * Everything one turn accumulates that memory needs, held for the length of
 * that turn and thrown away with it.
 */
export type TurnRecord = {
  asked: string;
  actions: string[];
  sources: EpisodeSourceDescriptor[];
};

export function newTurnRecord(): TurnRecord {
  return { asked: "", actions: [], sources: [] };
}

/**
 * The audit sink that feeds `actions`.
 *
 * `started` is deliberately ignored: an action is what HAPPENED, and a call
 * that began and then refused is one line saying it refused, not two. Both
 * methods are async because the interface is, and neither awaits anything —
 * this is an in-memory push on the capability call path, and a storage
 * round-trip there would be paid by every model step.
 */
export function makeTurnAuditSink(record: TurnRecord): CapabilityAuditSink {
  return {
    async started() {},
    async completed(event) {
      record.actions.push(
        describeAction({ name: `${event.namespace}.${event.method}`, state: "completed" }),
      );
    },
    async failed(event) {
      record.actions.push(
        describeAction({
          name: `${event.namespace}.${event.method}`,
          state: "failed",
          errorCode: event.code,
        }),
      );
    },
  };
}

/**
 * Where a trusted tool read registers what it RETURNED.
 *
 * Host-produced ids only — a Zep episode uuid, a stored message event id — so a
 * later claim can be traced back to a real message. Nothing model-authored code
 * supplied, or even saw, has a route here.
 */
export function makeTurnProvenanceSink(record: TurnRecord): ProvenanceSink {
  return {
    record(sources) {
      for (const source of sources) record.sources.push(source);
    },
  };
}

/** A sink for the paths that keep no record. Re-exported so callers name one thing. */
export { discardingProvenanceSink };

/**
 * How the turn ended, in memory's vocabulary.
 *
 * A REFUSAL IS NOT A FAILURE and gets its own outcome. The provider called it a
 * clean stop, the run calls it failed, and memory needs the distinction: "this
 * model would not answer that" is a different lesson from "this run broke".
 */
export function episodeOutcomeFor(input: {
  status: RunStatus;
  refused: boolean;
  budgetExhausted: boolean;
}): EpisodeOutcome {
  if (input.refused) return "refused";
  if (input.budgetExhausted) return "budget_exhausted";
  return input.status === "failed" ? "failed" : "completed";
}

/** Every text part of one message, joined. Nothing else on it is read. */
export function messageText(message: UIMessage | undefined): string {
  if (message === undefined) return "";
  return message.parts
    .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n")
    .trim();
}

/**
 * What this turn was asked.
 *
 * The LAST user message, because that is the one this turn is answering: a wake
 * carries the triage briefing, a steer carries the operator's instruction, and
 * an approval resolution carries the human's decision — each of which is the
 * right thing for a later recall to have learned.
 */
export function askedFrom(messages: readonly UIMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return messageText(message);
  }
  return "";
}

export type EpisodeHandoff = { enqueued: boolean; reason?: string };

/**
 * Freeze one turn's episode into D1 and hand it to the queue.
 *
 * The outbox id is `memory:{runId}:{turnId}`, which is what makes a redelivered
 * turn a no-op: the row already exists and `ensureOutboxRow` does not touch it.
 *
 * The graph is decided HERE, once, from trusted host state, and stored on the
 * row. Deciding it at delivery time instead would let a channel reclassified
 * after the fact move an episode that was already written under the old scope.
 * An unknown scope resolves to `org`, never to a customer graph nobody is sure
 * about.
 */
export async function enqueueTurnEpisode(
  env: Env,
  input: {
    runId: string;
    turnId: string;
    origin: RunOrigin;
    channelId: string | null;
    outcome: EpisodeOutcome;
    record: TurnRecord;
    draft: string;
    now: number;
  },
): Promise<EpisodeHandoff> {
  // Nothing asked and nothing done is not a turn worth remembering. It is what
  // a turn that failed before the model ran looks like, and an episode of it
  // would be noise a future recall has to read past.
  if (input.record.asked === "" && input.record.actions.length === 0 && input.draft === "") {
    return { enqueued: false, reason: "empty_turn" };
  }

  const policy = input.channelId === null ? null : await getChannelPolicy(env.DB, input.channelId);
  const graphId = agentGraphIdFor({ origin: input.origin, policy });

  const payload = buildAgentEpisode({
    runId: input.runId,
    agentTurnId: input.turnId,
    outcome: input.outcome,
    asked: input.record.asked,
    actions: input.record.actions,
    draft: input.draft,
    sources: input.record.sources,
  });

  const outboxId = `memory:${input.runId}:${input.turnId}`;
  await ensureOutboxRow(env.DB, {
    id: outboxId,
    runId: input.runId,
    generationId: input.turnId,
    graphId,
    episodeJson: JSON.stringify(payload.episode),
    sourceJson: JSON.stringify(payload.sources),
    now: input.now,
  });

  // The D1 row already exists, so the cron sweep will deliver this within a
  // minute even if the send throws. Reported rather than raised: memory lag
  // must not turn a finished answer into a failed turn.
  await env.MEMORY_QUEUE.send({ kind: "agent_generation", outboxId });
  return { enqueued: true };
}
