import type { CodeModeScope } from "../codemode/contracts";
import { CapabilityError } from "../codemode/errors";
import type { SlackGateway, SlackMessage } from "../codemode/gateways";
import { readThread, searchStoredMessages, isWildcardOnly } from "./messages";

/** Ceilings applied after schema validation, so a caller cannot widen a read. */
const MAX_THREAD = 200;
const MAX_SEARCH = 100;

/**
 * The Slack surface a capability may reach, bound to one run.
 *
 * Reads come from D1. Sending does not: it is the seam Phase 12 fills with an
 * encrypted per-engineer token resolved at the last trusted moment, so that a
 * customer-facing message carries a real human's identity.
 *
 * Until then `reply` refuses with `identity_unavailable`. It deliberately does
 * NOT fall back to `SLACK_BOT_TOKEN`. The bot token exists for ingestion,
 * permalinks and later nudges — using it for customer speech would mean the
 * product says something to a customer that no person said, which is the exact
 * failure the identity design exists to prevent. A temporary fallback here
 * would also be indistinguishable from the finished feature in every test.
 */
export function makeSlackGateway(
  db: D1Database,
  scope: CodeModeScope,
): SlackGateway {
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

    async searchMessages(query: string, limit: number): Promise<SlackMessage[]> {
      if (scope.customerSlug === null) {
        throw new CapabilityError(
          "customer_scope_required",
          "this run has no customer, so there is no message scope to search. Ask which customer this concerns.",
        );
      }
      if (isWildcardOnly(query)) {
        throw new CapabilityError(
          "invalid_input",
          "the search needs actual terms; a wildcard-only query would return everything.",
        );
      }
      return searchStoredMessages(db, {
        customerSlug: scope.customerSlug,
        query,
        limit: Math.min(limit, MAX_SEARCH),
      });
    },

    async reply(): Promise<{ ts: string; permalink: string | null }> {
      throw new CapabilityError(
        "identity_unavailable",
        "replying as the on-duty engineer is not available yet, so nothing was sent. Summarise the reply for a human to post.",
      );
    },
  };
}
