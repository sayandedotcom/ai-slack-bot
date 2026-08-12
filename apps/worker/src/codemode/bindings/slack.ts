import { z } from "zod";
import type { ToolDescriptors } from "@cloudflare/codemode/ai";
import { canPost, getChannelPolicy } from "../../db/channels";
import { getRunById } from "../../run/repository";
import { CapabilityError } from "../errors";
import { runEffect } from "../effects";
import { auditedCapability, effectDeps, type BindingContext } from "../registry";

const message = z.strictObject({
  ts: z.string(),
  userId: z.string().nullable(),
  text: z.string(),
  permalink: z.string().nullable(),
});

/**
 * `.default({})` is load-bearing, not tidiness. `ToolDispatcher.call` spreads an
 * empty argument array, so a model writing `slack.thread()` reaches
 * `execute(undefined)`. Without the default that is a validation failure on a
 * call the generated types never told it was wrong. The type teaches `{}`; the
 * default tolerates its absence.
 */
const threadInput = z
  .strictObject({ limit: z.number().int().min(1).max(200).optional() })
  .default({});

export function makeSlackTools(ctx: BindingContext): ToolDescriptors {
  return {
    thread: auditedCapability(ctx, "slack", "thread", {
      description:
        "Read the messages of the conversation this run belongs to, oldest first.",
      input: threadInput,
      output: z.array(message),
      run: async (input) => ctx.deps.slack.thread(input.limit ?? 50),
    }),

    searchMessages: auditedCapability(ctx, "slack", "searchMessages", {
      // Named searchMessages, not search: generated type aliases carry no
      // namespace prefix, so a second `search` elsewhere would emit a duplicate
      // `type SearchInput` and the joined declarations would not compile.
      description:
        "Search previously ingested messages within the scope this run already has.",
      input: z.strictObject({
        query: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      output: z.array(message),
      run: async (input) =>
        ctx.deps.slack.searchMessages(input.query, input.limit ?? 20),
    }),

    reply: auditedCapability(ctx, "slack", "reply", {
      // No destination argument, deliberately. Where a reply lands is a
      // property of the run, decided by the host before this code ever ran.
      description:
        "Post a reply into the conversation this run belongs to. The destination is fixed by the run and cannot be chosen here.",
      input: z.strictObject({ text: z.string().min(1).max(4000) }),
      output: z.strictObject({
        ts: z.string(),
        permalink: z.string().nullable(),
      }),
      run: async (input) => {
        await assertMayReply(ctx);
        // Reserved before the send, so a retry after a transport error replays
        // rather than posting to a customer twice.
        return runEffect(
          effectDeps(ctx),
          ctx.scope,
          "slack",
          "reply",
          // `text` is the only behaviour-changing argument this capability has:
          // the destination and the identity are properties of the run, fixed
          // before model code ran, and both are already in the key's envelope
          // via runId/turnId. There is nothing else to include.
          { text: input.text },
          {
            execute: (idempotencyKey) =>
              ctx.deps.slack.reply(input.text, idempotencyKey),
          },
        );
      },
    }),
  };
}

/**
 * The write-policy matrix, in escalating order of how little we know.
 *
 * The order is the point. Each check answers a different question, and
 * reporting the first unanswerable one gives the model something it can act on:
 *
 *  1. is there anywhere to send?      → slack_context_required
 *  2. does the destination accept?    → channel_read_only
 *  3. is this run allowed to act?     → shadow_write_denied
 *  4. do we have a voice to use?      → identity_unavailable
 *
 * Policy is re-fetched here rather than captured when the run started: a
 * channel switched to `observe` mid-run must stop accepting messages
 * immediately, not at the end of the run.
 */
async function assertMayReply(ctx: BindingContext): Promise<void> {
  const target = ctx.scope.slackThread;
  if (target === null) {
    throw new CapabilityError(
      "slack_context_required",
      "this run is not attached to a conversation, so there is nowhere to reply.",
    );
  }

  const policy = await getChannelPolicy(ctx.deps.db, target.channelId);
  if (!canPost(policy)) {
    // canPost is already `known && mode === "live"`, and an unmapped channel
    // resolves to `{ mode: "observe", known: false }`. The fail-closed default
    // is inherited from the shipped policy code, not reimplemented here.
    throw new CapabilityError(
      "channel_read_only",
      `replies are disabled for this conversation (mode=${policy.mode}). Report the reply instead of sending it.`,
    );
  }

  // Read shadow from D1, NOT from the run descriptor. RunState has no `shadow`
  // field; a check written against the descriptor reads undefined, which is
  // falsy, and the run posts. This is the single most dangerous wrong
  // assumption available in this phase, so it is a database read.
  //
  // A missing row refuses too: an unconfirmable run is not a permitted one.
  const record = await getRunById(ctx.deps.db, ctx.scope.runId);
  if (record === null || record.shadow) {
    throw new CapabilityError(
      "shadow_write_denied",
      record === null
        ? "this run could not be confirmed as permitted to post; nothing was sent."
        : "this run is observing only; nothing was sent. Report what you would have posted.",
    );
  }

  if (ctx.scope.actor === null) {
    throw new CapabilityError(
      "identity_unavailable",
      "no on-duty engineer is resolved, and this product never speaks to a customer without a human identity behind it.",
    );
  }
}
