/**
 * THE WIRING between the dashboard's decision and the run it belongs to: the
 * `ResolutionNotifier` the approvals API declares, backed by one durable
 * submission into the owning `RunAgent`.
 *
 * Its own file, and a small one, because it is the only place in the system
 * where an HTTP request turns into a Durable Object call for approval state.
 * Until this existed, an unwired notifier and a dead run were
 * indistinguishable — both produce `resolutionDelivered: false` — so the
 * absence of this composition looked exactly like the failure it repairs.
 *
 * `runId -> key -> agent`, never `runId -> agent`. The Durable Object name is
 * the run's origin key, which is deliberately not the public `runs.id` a
 * browser sees (invariant 10); D1 is what maps one to the other.
 *
 * IDEMPOTENCY REPLACES THE DELIVERED-CAS. The cron sweep re-submits
 * `approval:{id}` unconditionally and every repeat is refused by the
 * submission queue (`accepted: false`), so a resolution that landed once
 * cannot be delivered twice however many times this runs.
 */

import type { RunTurnSubmit, SubmitMessagesResult } from "@cloudflare/think";
import { getAgentByName } from "agents";

import type { ResolutionNotifier } from "../api/approvals";
import type { Env } from "../index";
import { updateNudge } from "../notify/nudge";
import type { RunAgent } from "../run/agent";
import { channelForOrigin } from "../run/agent-channels";
import { getRunById, type RunRecord } from "../run/repository";
import {
  outboundText,
  resolutionTurnContent,
  type ApprovalDelivery,
  type ApprovalRow,
} from "./contracts";
import { getApproval, setDelivery } from "./repository";
import { makeUserTokenSender, type ApprovalSender } from "./sender";
import { makeUserTokenSource } from "../identity/user-token";

/** See `wake.ts` for why an overloaded method needs restating through a stub. */
type SubmitOnlyAgent = {
  runTurn(options: RunTurnSubmit): Promise<SubmitMessagesResult>;
};

/** A re-entry that found the row mid-send: unknown outcome, never a retry. */
export const REENTERED_WHILE_SENDING = "re-entered while a send was in flight";

export type ResolutionNotifierInput = {
  env: Env;
  /**
   * Who actually posts the approved text. Injected so a test can drive `sent`
   * and `in_doubt`, which no code in this checkout can otherwise produce.
   */
  sender?: ApprovalSender;
  now?: () => number;
};

export function makeRunAgentResolutionNotifier(
  input: ResolutionNotifierInput
): ResolutionNotifier {
  const { env } = input;
  const now = input.now ?? (() => Date.now());
  const sender = input.sender ?? makeProductionSender(env);

  return {
    async notify(notification) {
      const run = await getRunById(env.DB, notification.runId);
      if (run === null) {
        // A decided approval whose run is not in the index: not deliverable and
        // not repairable by retrying, but reported as undelivered rather than
        // thrown. A human's committed decision must never turn into a failed
        // request (invariant 9).
        return { applied: false };
      }

      const card = await getApproval(env.DB, notification.approvalId);
      // Nothing to resolve, or this decision belongs to a different
      // conversation. The second check is the one that matters: an approval
      // resolved into the wrong object would put one customer's approved text
      // into another customer's run.
      if (card === null || card.runId !== run.id) return { applied: false };

      // THE D1 ROW DECIDES WHETHER THERE IS ANYTHING TO RESOLVE — invariant 6's
      // "one writer surface", enforced here rather than assumed of the caller.
      // Unparking a run on a decision the system of record does not carry would
      // be a resolution nobody made.
      //
      // The TEXT still comes from the notification, not from the row: the
      // caller derived it from this same row a moment ago, and taking it here
      // keeps the sweeper's replay byte-identical to the original notify.
      if (card.decision !== notification.decision) return { applied: false };

      const finalText = notification.outboundText ?? outboundText(card);
      const delivery =
        notification.decision === "rejected"
          ? // Nothing to send, so there is no delivery sub-machine to run at all.
            { delivery: "none" as ApprovalDelivery, error: null }
          : await deliverApproval({
              env,
              sender,
              now,
              card,
              run,
              text: finalText,
            });

      const stub = await getAgentByName<Env, RunAgent>(env.RUN_AGENTS, run.key);
      await stub.bindRun({
        runId: run.id,
        channel: channelForOrigin(run.origin),
      });

      // UNPARK BEFORE THE TURN, never after. `beforeToolCall` blocks every tool
      // call while `state.openApprovalId` is set, so a resolution turn started
      // against a still-parked run could read the decision and then be refused
      // the capability call it needs to act on it.
      await stub.setOpenApproval(null);
      const inputRevision = await stub.noteInput();

      await (stub as unknown as SubmitOnlyAgent).runTurn({
        mode: "submit",
        input: resolutionTurnContent({
          decision: notification.decision,
          text: notification.decision === "rejected" ? null : finalText,
          reason: notification.rejectReason,
          draft: card.draft,
          delivery: delivery.delivery,
          deliveryError: delivery.error,
        }),
        idempotencyKey: `approval:${card.id}`,
        channel: channelForOrigin(run.origin),
        // `decidedBy` is DELIBERATELY absent (invariant 12). D1 records which
        // engineer clicked because the dashboard and later audits need it; the
        // model has no business knowing, and a run's answer must not change
        // depending on who was on duty.
        metadata: {
          runId: run.id,
          turnId: `approval:${card.id}`,
          approvalId: card.id,
          decision: notification.decision,
          delivery: delivery.delivery,
          inputRevision,
        },
      });

      // LAST, AND BEST-EFFORT: the engineer's nudge DM still shows a "Review"
      // button for a card that is now settled. `updateNudge` rewrites it in
      // place, makes no call at all when no nudge was recorded, and never
      // throws — so it cannot turn a delivered resolution into a failed one.
      await updateNudge(env, card);
      return { applied: true };
    },
  };
}

/**
 * Settle the delivery sub-machine and report what it settled on, so the
 * resolution turn can tell the model the truth about it.
 *
 * Delivery NEVER writes back to the decision (invariant 5). Nothing in here can
 * fail in a way that rolls a human's click back; the worst case is an
 * `in_doubt` row and a sentence telling a person to go and look.
 */
async function deliverApproval(input: {
  env: Env;
  sender: ApprovalSender;
  now: () => number;
  card: ApprovalRow;
  run: RunRecord;
  text: string;
}): Promise<{ delivery: ApprovalDelivery; error: string | null }> {
  const { env, card, run } = input;
  const settle = (
    from: ApprovalDelivery[],
    to: ApprovalDelivery,
    error: string | null
  ) => settleDelivery(env.DB, input.now, card.id, from, to, error);

  // Shadow is read LIVE from the D1 `runs` row rather than taken from the
  // card's snapshot, and the two are OR-ed. A run's flag only ever ratchets
  // false -> true, so a card projected before the ratchet says `false` about a
  // run that must never write to a customer.
  if (card.shadow || run.shadow) {
    return settle(["none", "sending"], "suppressed", null);
  }

  if (run.channelId === null || run.threadTs === null) {
    // The destination comes from the run's own row and nowhere else (invariant
    // 10), so a run with no pinned thread has nowhere to send — `open` refuses
    // to write a card for such a run at all, which makes this unreachable
    // rather than merely unlikely. Blocked, and never a guess at a channel.
    return settle(["none", "sending"], "blocked", "no_pinned_thread");
  }

  // THE GUARD AGAINST A SECOND SEND, and it is this CAS rather than a read: a
  // read can be stale, a conditional UPDATE cannot. Exactly one caller moves
  // `none -> sending`, and only that caller sends.
  const started = await setDelivery(
    env.DB,
    card.id,
    ["none"],
    "sending",
    null,
    input.now()
  );
  if (!started) {
    // Somebody already started it. A row still `sending` is a crash between the
    // send and its outcome: an unknown outcome is a human's problem to
    // reconcile, whereas a duplicate customer message cannot be taken back — so
    // this maps to `in_doubt` and NEVER to a second attempt. A row that has
    // already settled (the ordinary sweeper replay) is untouched by that CAS
    // and reported as it stands.
    return settle(["sending"], "in_doubt", REENTERED_WHILE_SENDING);
  }

  let outcome;
  try {
    outcome = await input.sender.send({
      runId: run.id,
      channelId: run.channelId,
      threadTs: run.threadTs,
      text: input.text,
      // The human who clicked speaks, if they have connected Slack. This is the
      // sender's input, not the model's.
      decidedBy: card.decidedBy,
    });
  } catch {
    // A THROWN sender is an unknown outcome, not a failure to send: the request
    // may well have reached Slack before the throw. Treating it as retryable is
    // the one thing that could double-post to a customer.
    outcome = { result: "in_doubt" as const, reason: "the sender threw" };
  }

  return outcome.result === "sent"
    ? settle(["sending"], "sent", null)
    : settle(["sending"], outcome.result, outcome.reason);
}

/**
 * One delivery transition, reporting what the row ACTUALLY holds afterwards.
 *
 * The re-read on a refused CAS is not ceremony: the resolution turn quotes this
 * outcome to the model, and a turn that says "sent" about a row another caller
 * has just marked `in_doubt` would be the run confidently telling a customer
 * something nobody can confirm.
 */
async function settleDelivery(
  db: D1Database,
  now: () => number,
  approvalId: string,
  from: ApprovalDelivery[],
  to: ApprovalDelivery,
  error: string | null
): Promise<{ delivery: ApprovalDelivery; error: string | null }> {
  const moved = await setDelivery(db, approvalId, from, to, error, now());
  if (moved) return { delivery: to, error };
  const current = await getApproval(db, approvalId);
  return current === null
    ? { delivery: to, error }
    : { delivery: current.delivery, error: null };
}

/**
 * The deployed sender: the approver's own Slack token when they have connected
 * one, the default speaker's otherwise, and a refusal when nobody has.
 *
 * There is no bot-token fallback, ever. The bot token exists for ingestion,
 * permalinks and nudges; using it here would mean the product says something to
 * a customer that no person said. `makeUserTokenSender` already answers
 * `blocked: no fire-fighter has connected Slack` in that case, without making a
 * request — which is why there is no second, refusing implementation composed
 * here: an unconfigured deployment and a configured one take the same path and
 * the same code decides.
 */
function makeProductionSender(env: Env): ApprovalSender {
  return makeUserTokenSender(makeUserTokenSource(env));
}
