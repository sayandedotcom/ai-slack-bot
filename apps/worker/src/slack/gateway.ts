import type { CodeModeScope } from "../codemode/contracts";
import { CapabilityError } from "../codemode/errors";
import type { SlackGateway, SlackMessage } from "../codemode/gateways";
import { makeUserTokenSender, NOT_CONNECTED } from "../approval/sender";
import type { UserTokenSource } from "../identity/user-token";
import { readThread, searchStoredMessages, isWildcardOnly } from "./messages";

/** Ceilings applied after schema validation, so a caller cannot widen a read. */
const MAX_THREAD = 200;
const MAX_SEARCH = 100;

/** The one refusal this gateway is allowed to answer a permitted write with. */
function identityUnavailable(): CapabilityError {
  return new CapabilityError(
    "identity_unavailable",
    "no on-duty engineer has a connected Slack account, so nothing was sent. Summarise the reply for a human to post.",
  );
}

/**
 * The Slack surface a capability may reach, bound to one run.
 *
 * Reads come from D1. Sending does not: `identity` is the seam Phase 10 left
 * and Phase 13 fills — an encrypted per-engineer token, decrypted at the last
 * trusted moment, so that a customer-facing message carries a real human's
 * identity.
 *
 * `identity` is OPTIONAL and defaults to none, and the default is the whole
 * safety property: a caller that composes this gateway without a credential
 * source gets a `reply` that refuses, never one that falls back to
 * `SLACK_BOT_TOKEN`. The bot token exists for ingestion, permalinks and the
 * engineer nudge — using it for customer speech would mean the product says
 * something to a customer that no person said, which is the exact failure the
 * identity design exists to prevent. A source that answers `null` (nobody on
 * duty has connected Slack) refuses for the same reason and with the same code.
 *
 * The send itself is `makeUserTokenSender`, not a second `chat.postMessage`
 * written here. Both customer-facing paths — the approved-draft delivery and
 * this capability — therefore share ONE implementation of "post as the on-duty
 * engineer", so "there is no bot-token fallback anywhere" is a claim about one
 * function rather than about two that have to be kept in agreement.
 */
export function makeSlackGateway(
  db: D1Database,
  scope: CodeModeScope,
  identity: UserTokenSource | null = null,
): SlackGateway {
  const sender = identity === null ? null : makeUserTokenSender(identity);

  return {
    async thread(limit: number): Promise<SlackMessage[]> {
      if (scope.slackThread === null) {
        throw new CapabilityError(
          "slack_context_required",
          "this run is not attached to a conversation, so there is nothing to read.",
        );
      }
      return readThread(
        db,
        scope.slackThread.channelId,
        scope.slackThread.threadTs,
        Math.min(limit, MAX_THREAD),
      );
    },

    async searchMessages(
      query: string,
      limit: number,
      customerSlug: string,
    ): Promise<SlackMessage[]> {
      // The caller resolved this. It is either the run's own pinned slug or one
      // the host read out of D1 for this execution — never a model string, and
      // never something this gateway chose.
      if (isWildcardOnly(query)) {
        throw new CapabilityError(
          "invalid_input",
          "the search needs actual terms; a wildcard-only query would return everything.",
        );
      }
      return searchStoredMessages(db, {
        customerSlug,
        query,
        limit: Math.min(limit, MAX_SEARCH),
      });
    },

    /**
     * Post `text` into this run's pinned thread, as the on-duty engineer.
     *
     * The idempotency key is deliberately not forwarded: `chat.postMessage` has
     * no idempotency token, so at-most-once is the effect ledger's job, and it
     * has already reserved this call before we were reached.
     *
     * Outcomes are mapped by what a HUMAN would do next, which is also what
     * decides how the ledger records them:
     *
     *  - nobody connected → `identity_unavailable`, a PROVEN pre-upstream
     *    refusal, so the ledger marks it failed and nothing was sent;
     *  - Slack said no (`ok:false`) → `capability_unavailable`, also proven:
     *    Slack answered, and it answered that the message did not go out;
     *  - unknown (a thrown request, an unreadable body) → `effect_in_doubt`,
     *    which is NOT proven, so the ledger records the effect as `in_doubt`
     *    and no retry is invited. `upstream_unavailable` would have been the
     *    obvious code and is the wrong one: it is the only RETRYABLE code in
     *    the vocabulary, and a retried send that already landed is a duplicate
     *    message to a customer, which is not recoverable.
     */
    async reply(text: string): Promise<{ ts: string; permalink: string | null }> {
      // Destination first, then identity — the same escalating order the
      // binding's write-policy matrix documents, so a direct caller and a
      // capability call report the same first unanswerable question.
      if (scope.slackThread === null) {
        throw new CapabilityError(
          "slack_context_required",
          "this run is not attached to a conversation, so there is nowhere to reply.",
        );
      }
      if (sender === null) throw identityUnavailable();

      const outcome = await sender.send({
        runId: scope.runId,
        channelId: scope.slackThread.channelId,
        threadTs: scope.slackThread.threadTs,
        // Byte-exact. No prefix, no signature, no "sent by" footer.
        text,
      });

      switch (outcome.result) {
        case "sent":
          // No permalink: resolving one is a second authenticated call whose
          // only consumer is display, and a failure there must not cast doubt
          // on a message that has already landed. `null` is in the contract.
          return { ts: outcome.ts, permalink: null };

        case "blocked":
          if (outcome.reason === NOT_CONNECTED) throw identityUnavailable();
          throw new CapabilityError(
            "capability_unavailable",
            // Slack's own snake_case code, already shape-validated by the
            // sender, so an upstream that echoed a credential cannot get one
            // into this message.
            `Slack refused the send (${outcome.reason}), so nothing was posted.`,
          );

        case "in_doubt":
          throw new CapabilityError(
            "effect_in_doubt",
            `${outcome.reason}. Do not retry it; report it and let a human check.`,
          );
      }
    },
  };
}
