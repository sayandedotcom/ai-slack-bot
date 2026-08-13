import type { Env } from "../index";
import type { ApprovalRow } from "../approval/contracts";
import { claimNudge, getApproval, recordNudgeMessage, releaseNudge } from "../approval/repository";
import { getChannelPolicy } from "../db/channels";
import { getIdentity } from "../db/identities";
import { onDuty } from "../identity/rotation";
import { nudgeBlocks, resolvedBlocks } from "./blocks";

/**
 * The escalation nudge: one Block Kit DM to the on-duty engineer, once.
 *
 * `src/notify/blocks.ts` shapes the payload; this file decides WHETHER and
 * WHERE it goes, and is the only place in the phase that spends
 * `SLACK_BOT_TOKEN`. That is allowed here for one reason and it is worth
 * stating plainly: this message goes to an ENGINEER, never to a customer.
 * Customer-facing speech carries a human's name and goes out under that
 * human's own user token (`src/approval/sender.ts`); a nudge is the product
 * talking to its own operators, so speaking as the app is honest. Nothing in
 * this file opens a sealed credential — the on-duty engineer's Slack user id
 * comes from the `identities` row's `external_id`, which is not secret, and
 * the token column is never read.
 *
 * TWO INVARIANTS, and every design choice below serves one of them:
 *
 *  1. EXACTLY ONE nudge per approval. Enforced by `claimNudge`, a conditional
 *     UPDATE in D1 — never by a flag in an isolate. Alarm delivery is
 *     at-least-once and a crashed worker replays the projection, so a memory
 *     of "already sent" is exactly the memory that is gone when it matters.
 *     The claim is taken BEFORE the first Slack call, so two racing callers
 *     cannot both be mid-`chat.postMessage`.
 *
 *  2. A FAILED NUDGE IS NOT A LOST APPROVAL. Failure releases the claim
 *     (`nudged_at` back to NULL), which puts the row straight back on
 *     `idx_approvals_unnudged` — the sweeper's retry feed. `sendNudge`
 *     therefore never throws: its caller is a projection whose success means
 *     "the human has a card", and a Slack outage may not rewrite that.
 */

const CONVERSATIONS_OPEN_URL = "https://slack.com/api/conversations.open";
const POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const UPDATE_MESSAGE_URL = "https://slack.com/api/chat.update";

/**
 * Ceiling on one Slack request. The projection AWAITS the nudge (see
 * `makeApprovalCardRunner`), so an un-timed fetch that hangs holds that run's
 * alarm slot for as long as the socket stays open. Eight seconds is long
 * enough for a slow-but-alive Slack and short enough that the alarm moves on;
 * an abort lands in the catch below as an ordinary failure, which releases the
 * claim and leaves the row for the sweeper.
 */
const SLACK_TIMEOUT_MS = 8_000;

/** How stale a pending, unnudged card must be before the sweeper retries it. */
export const NUDGE_RETRY_AFTER_MS = 60_000;

/** Ceiling on one sweep, so a backlog cannot monopolise a cron invocation. */
const SWEEP_LIMIT = 10;

export type NudgeOutcome = "sent" | "skipped" | "failed";

type SlackResponse = { ok?: unknown; ts?: unknown; error?: unknown; channel?: unknown };

async function slackCall(
  env: Env,
  url: string,
  payload: Record<string, unknown>,
): Promise<SlackResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
  });
  return (await response.json()) as SlackResponse;
}

/**
 * Who to nudge, and where.
 *
 * `slackUserId` is null when the on-duty engineer has not connected Slack —
 * an ordinary configuration fact, not an error, and the reason the fallback
 * channel exists at all: a nudge nobody can address is still better delivered
 * to the fire-fighting channel than dropped. FALLBACK BEATS SILENCE.
 */
async function resolveTarget(
  env: Env,
  nowMs: number,
): Promise<{ email: string; slackUserId: string | null }> {
  const { email } = onDuty(nowMs);
  const identity = await getIdentity(env.DB, email, "slack");
  return { email, slackUserId: identity?.externalId ?? null };
}

/**
 * Post one nudge for one pending approval, at most once ever.
 *
 * `"skipped"` means another caller already holds this row's nudge slot —
 * success, not failure. `"failed"` means the slot has been handed back and
 * the sweeper will try again.
 *
 * `nowMs` is a parameter, defaulted rather than read inside, for the same
 * reason it is one on `makeUserTokenSource.onDutyToken`: it decides WHOSE
 * shift this is. A caller that already fixed the instant it is acting at — the
 * sweeper, a test — must not get a different engineer from a clock read
 * microseconds later, or from a suite that outlives a three-day shift boundary.
 */
export async function sendNudge(
  env: Env,
  row: ApprovalRow,
  nowMs = Date.now(),
): Promise<NudgeOutcome> {
  const now = nowMs;
  const mode = env.NUDGE_MODE === "channel" ? "channel" : "dm";
  const fallbackChannel = env.NUDGE_FALLBACK_CHANNEL_ID?.trim() ?? "";

  let target: { email: string; slackUserId: string | null };
  try {
    target = await resolveTarget(env, now);
  } catch {
    return "failed";
  }

  // Checked BEFORE the claim: a deployment with no fallback channel and an
  // unconnected engineer has nowhere to send, and burning the once-only slot
  // on an attempt that cannot be made would silence the sweeper too.
  const needsFallback = mode === "channel" || target.slackUserId === null;
  if (needsFallback && fallbackChannel === "") return "failed";

  if (!(await claimNudge(env.DB, row.id, now))) return "skipped";

  try {
    let channelId: string;
    let mention: string | null = null;

    if (mode === "dm" && target.slackUserId !== null) {
      const opened = await slackCall(env, CONVERSATIONS_OPEN_URL, { users: target.slackUserId });
      const openedId = (opened.channel as { id?: unknown } | undefined)?.id;
      if (opened.ok !== true || typeof openedId !== "string") {
        await release(env, row.id);
        return "failed";
      }
      channelId = openedId;
    } else {
      channelId = fallbackChannel;
      // In the channel, the message has to say whose turn it is. With a
      // connected engineer that is a real mention that pings them; without
      // one there is no user id in the system, so it is the roster email in
      // plain text — deliberately NOT a `<@…>` around an email, which Slack
      // renders as a broken mention and pings nobody.
      mention = target.slackUserId !== null ? `<@${target.slackUserId}>` : target.email;
    }

    const policy = await getChannelPolicy(env.DB, row.channelId);
    const blocks = nudgeBlocks({
      draft: row.draft,
      why: row.why,
      approvalId: row.id,
      dashboardUrl: env.DASHBOARD_BASE_URL?.trim() ?? "",
      channelName: policy.name,
    });

    const posted = await slackCall(env, POST_MESSAGE_URL, {
      channel: channelId,
      text: mention === null ? `Waiting on you: #${policy.name}` : `${mention} waiting on you: #${policy.name}`,
      blocks: mention === null
        ? blocks
        : [{ type: "section", text: { type: "mrkdwn", text: mention } }, ...blocks],
    });

    if (posted.ok !== true || typeof posted.ts !== "string") {
      await release(env, row.id);
      return "failed";
    }

    // OUTSIDE the failure path, deliberately. The DM has landed in a human's
    // Slack; from here on nothing may release the claim. Letting a failed
    // bookkeeping write fall into the catch below would hand the slot back
    // after a SUCCESSFUL send, and the sweeper would DM the engineer a second
    // time. Losing the `ts` costs a later `chat.update`; losing the claim
    // costs a duplicate page, and only one of those is recoverable.
    try {
      await recordNudgeMessage(env.DB, row.id, channelId, posted.ts);
    } catch {
      /* the DM went out; the claim stands */
    }
    return "sent";
  } catch {
    // The thrown value is deliberately swallowed rather than logged: a failed
    // Slack request can carry request detail including the authorization
    // header, and nothing in it changes what happens next.
    await release(env, row.id);
    return "failed";
  }
}

/**
 * Hand the once-only slot back. Wrapped because a release that itself fails
 * must not turn a `failed` nudge into a thrown projection — the row simply
 * stays claimed-but-unsent, which the next `chat.update` path treats as a
 * message it cannot find rather than as a second DM.
 */
async function release(env: Env, id: string): Promise<void> {
  try {
    await releaseNudge(env.DB, id);
  } catch {
    /* nothing better to do; see the doc comment */
  }
}

/**
 * Rewrite a nudge whose approval has been settled, so no dead link outlives
 * its card.
 *
 * The nudge's "Review" button points at a dashboard card that is actionable
 * exactly once. After a decision — or after the model withdrew the draft
 * because the conversation moved on — that button leads somewhere that can no
 * longer be acted on, and an engineer scrolling their DMs cannot tell that by
 * looking. `chat.update` replaces the body with `resolvedBlocks`: what happened,
 * who did it, and no button.
 *
 * BEST-EFFORT, IN THE STRONG SENSE: this returns void and NEVER throws. Its
 * callers are the resolution path and the withdrawal path, and both have
 * already committed a fact — a human's decision, or a retraction — that a Slack
 * outage may not roll back. There is nothing for a caller to handle, so there
 * is nothing to report; the worst case is a stale DM beside a settled card,
 * which is exactly the state that existed before this function.
 *
 * NO RECORDED MESSAGE, NO CALL. `nudge_channel_id`/`nudge_ts` are null when the
 * nudge never went out, and also in the narrow case `sendNudge` documents where
 * the DM landed but its bookkeeping write failed. Both mean the same thing
 * here: there is no message id to edit, and Slack has no "find the message I
 * posted" call that would not be a guess.
 *
 * This is the SECOND and last place in the phase that spends
 * `SLACK_BOT_TOKEN`, and it is the same message the first one posted: a bot
 * cannot edit a message it did not author, so the credential here is forced by
 * the one in `sendNudge` rather than being a separate decision. Nothing
 * customer-facing passes through this file.
 */
export async function updateNudge(env: Env, row: ApprovalRow): Promise<void> {
  const channel = row.nudgeChannelId;
  const ts = row.nudgeTs;
  if (channel === null || channel === "" || ts === null || ts === "") return;
  // A pending card has nothing to say that its own nudge does not already say.
  // Refused here rather than in the callers so a future caller cannot get it
  // wrong, and because `resolvedBlocks` has no rendering for `pending` at all.
  if (row.decision === "pending") return;

  try {
    await slackCall(env, UPDATE_MESSAGE_URL, {
      channel,
      ts,
      // The notification fallback, for clients that render no blocks. It says
      // only that the card is settled; the decision and the decider are in the
      // body, where a reader has the surrounding context to read them.
      text: "This approval has been settled — nothing left to review.",
      blocks: resolvedBlocks({ decision: row.decision, decidedBy: row.decidedBy }),
    });
    // An `ok: false` answer needs no branch: there is no retry that would be
    // safe (the row's once-only nudge slot has already been spent) and no
    // caller that could act on the difference.
  } catch {
    // Swallowed, and not logged, for the same reason as `sendNudge`'s catch: a
    // failed Slack request can carry the authorization header in its detail,
    // and nothing in it changes what happens next.
  }
}

/**
 * The retry feed: pending cards that have sat unnudged for longer than a
 * minute get one more attempt per sweep.
 *
 * Concurrency with a live projection is safe for free — both paths go through
 * `claimNudge`, so the loser sees `"skipped"` and sends nothing. Bounded at
 * `SWEEP_LIMIT` per invocation.
 *
 * Each row is attempted inside its OWN try. `sendNudge` swallows Slack
 * failures but is not throw-proof — its `claimNudge`, and this loop's
 * `getApproval`, both talk to D1 outside any catch — and without the per-row
 * guard one D1 hiccup on the first row would skip the other nine AND reject
 * the whole `scheduled()` invocation, taking the memory and resolution sweeps'
 * error report with it. The FEED query is deliberately outside: if the sweep
 * cannot read its own work list, the cron run really did fail and should say so.
 *
 * `now` is threaded into `sendNudge` so the age filter and the shift lookup
 * agree on one instant.
 *
 * Returns how many nudges actually went out, for the caller's log line.
 */
export async function sweepNudges(env: Env, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM approvals
     WHERE decision = 'pending' AND nudged_at IS NULL AND created_at <= ?
     ORDER BY created_at ASC
     LIMIT ?`,
  )
    .bind(now - NUDGE_RETRY_AFTER_MS, SWEEP_LIMIT)
    .all<{ id: string }>();

  let sent = 0;
  for (const { id } of results ?? []) {
    try {
      const row = await getApproval(env.DB, id);
      if (row === null || row.decision !== "pending") continue;
      if ((await sendNudge(env, row, now)) === "sent") sent += 1;
    } catch {
      // This row is the sweeper's own retry feed — it stays on it, so the next
      // minute tries again. Nothing here is worth failing the cron over.
      continue;
    }
  }
  return sent;
}
