import { z } from "zod";

import { CapabilityError } from "../../gateways/errors";
import type { SlackMessage } from "../../gateways/ports";
import type { ClassifiedTool } from "../define";
import { runEffect } from "../effects";
import { auditedCapability, effectDeps, type BindingContext } from "../registry";
import { resolveCustomerScope } from "./customers";

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

/**
 * The model-visible projection of a stored message.
 *
 * Explicit rather than a pass-through, because `SlackMessage` now carries a
 * host-only `eventId` and the output schema above is a `strictObject`. Building
 * the visible shape by hand is what keeps "the model never sees a stored event
 * id" a property of this file rather than a property of whichever zod mode
 * happened to be in force.
 */
function visible(messages: readonly SlackMessage[]): {
  ts: string;
  userId: string | null;
  text: string;
  permalink: string | null;
}[] {
  return messages.map((m) => ({
    ts: m.ts,
    userId: m.userId,
    text: m.text,
    permalink: m.permalink,
  }));
}

export function makeSlackTools(ctx: BindingContext): Record<string, ClassifiedTool> {
  return {
    thread: auditedCapability(ctx, "slack", "thread", {
      effect: "read",
      description:
        "Read the messages of the conversation this run belongs to, oldest first.",
      input: threadInput,
      output: z.array(message),
      run: async (input) => visible(await ctx.deps.slack.thread(input.limit ?? 50)),
    }),

    searchMessages: auditedCapability(ctx, "slack", "searchMessages", {
      effect: "read",
      // Named searchMessages, not search: generated type aliases carry no
      // namespace prefix, so a second `search` elsewhere would emit a duplicate
      // `type SearchInput` and the joined declarations would not compile.
      description:
        "Search previously ingested messages for this conversation's customer, or for the one named by customerRef in an internal chat.",
      input: z.strictObject({
        query: z.string().min(1).max(500),
        customerRef: z.string().min(1).max(120).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      output: z.array(message),
      run: async (input) => {
        // The slug is resolved HERE, in the trusted parent, before the gateway
        // is called. The gateway receives a slug the host vouched for; it never
        // receives a reference and has no way to mint one.
        const found = await ctx.deps.slack.searchMessages(
          input.query,
          input.limit ?? 20,
          resolveCustomerScope(ctx, input.customerRef),
        );

        // Provenance from what this read RETURNED, registered before the result
        // is narrowed. A Chat answer built on these messages therefore cites
        // the messages, not the Chat prompt that went looking for them.
        ctx.execution.provenance.record(
          found
            .filter((m): m is typeof m & { eventId: string } => typeof m.eventId === "string")
            .map((m) => ({ kind: "slack_message" as const, ref: m.eventId })),
        );

        return visible(found);
      },
    }),

    reply: auditedCapability(ctx, "slack", "reply", {
      effect: "external_write",
      // No destination argument, deliberately. Where a reply lands is a
      // property of the run, decided by the host before this code ever ran.
      //
      // THE SECOND HALF OF THIS DESCRIPTION IS A BUG FIX, NOT ADVICE.
      //
      // A `run_code` block is capped at `wallTimeMs` (20s). A block that sends
      // a reply and then runs long is ABORTED — but the send already left the
      // building, and an external write cannot be rolled back. So model code
      // sees a timeout for a message the customer has already received, infers
      // the send failed, rewrites it, and sends it again.
      //
      // The effect ledger cannot catch that second send: `text` is the key, and
      // the rewrite is by definition different text, so it hashes to a genuinely
      // different effect. That is the right rule for two deliberately different
      // messages, which makes this the wrong layer to fix it at — keying on the
      // turn instead would silently swallow a legitimate follow-up.
      //
      // Observed twice in live drills, both times as the customer being told the
      // same thing twice 28 seconds apart. The model was reasoning correctly
      // from bad information; this sentence is the information.
      description:
        "Post a reply into the conversation this run belongs to. The destination is fixed by the run and cannot be chosen here. IF THIS CALL TIMES OUT OR ITS CODE BLOCK IS CUT SHORT, THE MESSAGE HAS PROBABLY ALREADY BEEN SENT — the send happens before the block finishes, so a timeout tells you the block ran long, not that the customer missed the reply. Do not send it again, and do not send a reworded version: a rewrite is different text and will post a second message rather than replacing the first. Read the thread to check what landed, and if you genuinely need to add something, send only the NEW part.",
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
 * Steps 2 and 3 are NOT here any more, and their absence is the Task 6 repair.
 * They were never Slack-specific — a shadow run must not file a Linear issue or
 * publish an artifact either — so they moved to the shared host guard in
 * `codemode/write-guard.ts`, which `auditedCapability` applies to every method
 * classified `external_write`. The guard runs immediately before this function,
 * still re-reading both D1 rows at that moment rather than at composition, so a
 * channel switched to `observe` mid-run stops the very next write.
 *
 * What remains here is what genuinely belongs to replying: a destination, and a
 * human to speak as.
 */
async function assertMayReply(ctx: BindingContext): Promise<void> {
  if (ctx.scope.slackThread === null) {
    throw new CapabilityError(
      "slack_context_required",
      "this run is not attached to a conversation, so there is nowhere to reply.",
    );
  }

  if (ctx.scope.actor === null) {
    throw new CapabilityError(
      "identity_unavailable",
      "no on-duty engineer is resolved, and this product never speaks to a customer without a human identity behind it.",
    );
  }
}
