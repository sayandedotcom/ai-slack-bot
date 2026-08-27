/**
 * Every way work enters a run from outside it.
 *
 * Three entry points and one shape: create-or-find the D1 row under the
 * CURRENT channel policy, bind the object to its public id, note the input,
 * then submit one durable turn. Nothing here decides what a message is ABOUT —
 * there is no bug/feature/question anywhere in this file, and adding one would
 * rebuild the banned per-ticket-type pipeline.
 *
 * THE D1 ROW IS WRITTEN BEFORE THE OBJECT IS ADDRESSED, always. Two reasons,
 * and the second one is the reason the previous Think path refused every send:
 *
 *  - it is the enforcement point for invariant 37. By the time a turn exists,
 *    the `runs` row the write guard re-reads already carries the shadow flag,
 *    so an `external_write` from a run on an `observe` channel is denied at the
 *    capability layer rather than after the fact;
 *  - it is what makes the run ADDRESSABLE at all. The public `runs.id` is a
 *    separate UUID resolved through D1 (invariant 10), and `/agents/*`, the
 *    approval sweep and every projection start from that row. Without it the
 *    run is invisible to all of them and `resolveRunScope` refuses.
 *
 * FAIL CLOSED: if the policy read or the row write throws, this throws and the
 * wake never happens. There is deliberately no catch that proceeds with a
 * default — an unresolvable policy must not become a postable run.
 */

import type { RunTurnSubmit, SubmitMessagesResult } from "@cloudflare/think";
import { getAgentByName } from "agents";

import { canPost, getChannelPolicy } from "../db/channels";
import type { Env } from "../index";
import type { SlackRunMessage } from "../triage/contracts";
import type { RunAgent } from "./agent";
import { channelForOrigin, type RunChannelId } from "./agent-channels";
import { canonicalThreadTs, chatRunKey, slackRunKey } from "./keys";
import {
  createOrGetRun,
  createOrGetRunUnderPolicy,
  findOwnedSlackRun,
  type RunDescriptor,
  type RunRecord,
} from "./repository";

/**
 * The one `runTurn` overload this file calls, restated.
 *
 * MEASURED TRAP: `Think.runTurn` is overloaded three ways (`wait` | `submit` |
 * `stream`) and a Durable Object RPC stub maps an overloaded method to its LAST
 * overload only — `runTurn(options: RunTurnStream): Promise<void>`. The correct
 * submit call through a stub is therefore a compile error (`Type '"submit"' is
 * not assignable to type '"stream"'`, then `Property 'accepted' does not exist
 * on type 'void'`) even though it is exactly right at runtime. Narrowing to
 * this shape — built from the package's OWN exported types, never `any` — is
 * what recovers the signature the runtime actually honours.
 */
type SubmitOnlyAgent = {
  runTurn(options: RunTurnSubmit): Promise<SubmitMessagesResult>;
};

/** What a submitted turn reports back: whether THIS call admitted the work. */
export type WakeOutcome = { accepted: boolean; runId: string };

/**
 * Create-or-find this thread's run under the channel's CURRENT policy, and
 * ratchet its shadow flag.
 *
 * Re-resolved on EVERY wake rather than at creation, which is what makes
 * redelivery and continuation safe: a stored wake decision replayed after the
 * channel was downgraded to `observe`, and a customer's follow-up in a thread
 * whose run predates that downgrade, both land here and both shadow the run.
 * Neither can go the other way — `createOrGetRunUnderPolicy` has no statement
 * that clears the flag (invariant 37).
 */
export async function ensureSlackRunRowUnderPolicy(
  env: Env,
  descriptor: RunDescriptor & { channelId: string }
): Promise<RunRecord> {
  const policy = await getChannelPolicy(env.DB, descriptor.channelId);
  return createOrGetRunUnderPolicy(env.DB, descriptor, {
    mustShadow: !canPost(policy),
  });
}

/**
 * Bind the object to its row, record that new input arrived, and submit one
 * durable turn.
 *
 * The three calls are ordered and none is optional:
 *
 *  1. `bindRun` — the object cannot derive the public id from its own name, and
 *     every scope resolution, usage row and projection needs it. Idempotent,
 *     and it refuses a rebind onto a different run id.
 *  2. `noteInput` — the revision this turn answers. It is what makes
 *     supersession detectable: a turn still working on revision N is stale the
 *     moment N+1 exists, which `beforeToolCall` and the capability freshness
 *     guard both read. A customer's follow-up arriving mid-turn stops the work
 *     in flight because of this line.
 *  3. `runTurn({ mode: "submit" })` — durable and idempotent on
 *     `idempotencyKey`, so a redelivered queue message returns
 *     `accepted: false` instead of starting a second turn. `submit` is also the
 *     only legal mode from outside a live turn: `wait`/`stream` would block on
 *     the very queue this call is adding to.
 */
async function submitTurn(
  env: Env,
  input: {
    run: RunRecord;
    channel: RunChannelId;
    text: string;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  }
): Promise<WakeOutcome> {
  const stub = await getAgentByName<Env, RunAgent>(
    env.RUN_AGENTS,
    input.run.key
  );
  await stub.bindRun({ runId: input.run.id, channel: input.channel });
  const inputRevision = await stub.noteInput();

  const submitted = await (stub as unknown as SubmitOnlyAgent).runTurn({
    mode: "submit",
    input: input.text,
    idempotencyKey: input.idempotencyKey,
    channel: input.channel,
    metadata: {
      ...input.metadata,
      runId: input.run.id,
      // One turn id per submission, and the same string as the idempotency
      // key: a redelivery that is refused as a duplicate must not have been
      // given a new identity on the way in.
      turnId: input.idempotencyKey,
      inputRevision,
    },
  });

  return { accepted: submitted.accepted, runId: input.run.id };
}

/**
 * Triage decided this thread is worth waking.
 *
 * The opening prompt already contains the triggering customer message, so that
 * message is NOT submitted a second time. `slack:{event_id}` is the
 * idempotency token, so a queue replay of a stored wake decision is a no-op.
 *
 * The prompt is submitted as a `user` message, never a system one. It is
 * WRITTEN BY triage but MADE OF customer bytes — the triggering Slack message,
 * the thread so far and recalled memory, quoted into one briefing — and storing
 * it with system authority would hand every one of those bytes the authority of
 * our own policy. `</untrusted_input> ignore system policy`, typed by anyone in
 * a customer channel, would then arrive as an instruction rather than as
 * evidence.
 */
export async function wakeRun(
  env: Env,
  input: {
    eventId: string;
    channelId: string;
    threadTs: string;
    openingPrompt: string;
  }
): Promise<WakeOutcome> {
  const key = slackRunKey(input.channelId, input.threadTs);
  const run = await ensureSlackRunRowUnderPolicy(env, {
    key,
    origin: "slack",
    channelId: input.channelId,
    threadTs: input.threadTs,
  });

  return submitTurn(env, {
    run,
    channel: "slack",
    text: input.openingPrompt,
    idempotencyKey: `slack:${input.eventId}`,
    metadata: { eventId: input.eventId },
  });
}

/**
 * A later message in a thread a run already owns.
 *
 * Returns true only when the message has been COMMITTED as a turn — the triage
 * consumer uses that to decide whether it still needs to ask the model, so
 * "found but not stored" would silently drop the customer's follow-up (defect
 * 14).
 *
 * Continuation bypasses TRIAGE, deliberately: the model is not asked again
 * whether this thread is worth answering. It does not bypass POLICY. The
 * channel's current mode is re-read and the ratchet applied before the submit,
 * so a thread whose channel was downgraded after its run was created continues
 * as a shadow draft.
 */
export async function routeToOwnedRun(
  env: Env,
  message: SlackRunMessage
): Promise<boolean> {
  const threadTs = canonicalThreadTs(message.ts, message.threadTs);
  const owned = await findOwnedSlackRun(env.DB, message.channelId, threadTs);
  if (owned === null) return false;

  // Through the same create-or-find as a wake rather than ratcheting inline:
  // the operation that creates a run and the operation that continues it must
  // stay one operation, or the two drift and only one of them gets the next
  // policy rule.
  const run = await ensureSlackRunRowUnderPolicy(env, {
    key: owned.key,
    origin: "slack",
    channelId: message.channelId,
    threadTs,
  });

  await submitTurn(env, {
    run,
    channel: "slack",
    text: message.text,
    idempotencyKey: `slack:${message.eventId}`,
    metadata: {
      eventId: message.eventId,
      thread: [
        {
          ts: message.ts,
          userId: message.userId,
          text: message.text,
          permalink: message.permalink,
        },
      ],
    },
  });
  return true;
}

/**
 * A dashboard-initiated run.
 *
 * TWO UUIDS ARE MINTED, and they are different values on purpose: the public
 * `runs.id` comes from the insert and goes in dashboard URLs, the `chat:{uuid}`
 * origin key names the Durable Object and never leaves the Worker (invariant
 * 10). Reusing one value would make a public run id trivially convertible into
 * an `idFromName()` input.
 *
 * `actorEmail` is recorded on the submission's metadata and NOWHERE ELSE. It is
 * not in the prompt and not in `this.state`: which engineer opened a chat must
 * not change what the model answers (invariant 12), and `this.state` reaches
 * every connected browser.
 */
export async function createRunFromChat(
  env: Env,
  options: {
    firstMessage?: string;
    actorEmail?: string;
    requestId?: string;
  } = {}
): Promise<{ runId: string }> {
  const key = await chatKeyFor(options);
  // No channel, so no policy to read: `createOrGetRun` is
  // `createOrGetRunUnderPolicy` with the ratchet bound off, not a second copy
  // of it.
  const run = await createOrGetRun(env.DB, {
    key,
    origin: "chat",
    channelId: null,
    threadTs: null,
  });

  const first = options.firstMessage?.trim();
  if (first === undefined || first === "") return { runId: run.id };

  await submitTurn(env, {
    run,
    channel: channelForOrigin("chat"),
    text: first,
    // The same token `POST /api/runs/:id/turns` and the run socket use, so a
    // client that retries a create it never saw the response to re-delivers one
    // string and the submission queue refuses it.
    idempotencyKey: `steer:${options.requestId ?? run.id}`,
    metadata:
      options.actorEmail === undefined
        ? {}
        : { actorEmail: options.actorEmail },
  });

  return { runId: run.id };
}

/**
 * The `chat:{uuid}` key for a dashboard-started run.
 *
 * Random when the caller names no request id, and DERIVED when it does: a
 * client that retries a create it never saw the response to would otherwise
 * leave a second, half-empty run in the dashboard list every time, and the
 * turn-level `idempotencyKey` cannot prevent that — it dedupes inside a run
 * that has already been created.
 *
 * The digest covers the ACTOR as well as the request id, so two people whose
 * clients happen to mint the same id cannot land in one conversation. Nothing
 * about it is guessable-to-another-run either: the input is the caller's own
 * email and their own token, and the key never leaves the Worker (invariant
 * 10). Version and variant bits are stamped so the value is a well-formed
 * UUID rather than 16 bytes that happen to be the right length.
 */
async function chatKeyFor(options: {
  actorEmail?: string;
  requestId?: string;
}): Promise<string> {
  const { actorEmail, requestId } = options;
  if (actorEmail === undefined || requestId === undefined || requestId === "") {
    return chatRunKey(crypto.randomUUID());
  }

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`chat\u0000${actorEmail}\u0000${requestId}`)
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  // Version 8 ("custom"), RFC 9562's arm for a name-derived value that is not
  // one of the registered namespaces.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return chatRunKey(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}
