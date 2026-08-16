/**
 * The approval half of the Think chassis: the agent's own approval table,
 * escalation, and the human's approve / edit / reject decision.
 *
 * Approval stays HOST-owned rather than riding the codemode runtime's own
 * pause/approve flow: `CodemodeApproveOptions` is `{ executionId }` only, with
 * no way to substitute the edited text a human typed (verified fact 5, spec
 * decision D4). The edit path is the whole point of this module, so
 * `requiresApproval` is never set on a connector tool and this file is the
 * whole of the state machine.
 *
 * WHO WRITES WHAT, because there are two databases here and they are not
 * peers:
 *
 *  - the AGENT'S OWN SQLite (`approvals`, below) is what this run acts on. It
 *    is the one writer for the decision, its final text, and the delivery
 *    outcome, and the CAS that makes a decision happen exactly once is a
 *    conditional UPDATE against it.
 *  - D1 `approvals` is the DASHBOARD'S card. `src/api/approvals.ts` still owns
 *    its Access check and its own D1 CAS, unchanged; this module projects a
 *    card into it at escalation and mirrors the delivery outcome back onto it
 *    afterwards. Every one of those writes is best-effort: D1 being down must
 *    not lose, delay or duplicate a customer-facing send.
 *
 * The column set follows the pinned `Approval` type (Wave A), not the plan's
 * earlier sketch: the sketch's `state`/`sent_text`/`reason`/`kind` predate the
 * pinned type, which speaks `decision`/`editedText`/`rejectReason`/`delivery`
 * and carries no `kind` — approval gates Slack replies and nothing else, so a
 * kind column would have exactly one legal value.
 */

import { getAgentByName } from "agents";
import type { ResolutionNotifier } from "../api/approvals";
import {
  resolutionTurnContent,
  validateDecisionInput,
  type ApprovalDecision,
  type ApprovalDelivery,
  type DecisionInput,
} from "../approval/contracts";
import { getApproval, insertApproval, setDelivery } from "../approval/repository";
import { makeUserTokenSender } from "../approval/sender";
import { getChannelPolicy } from "../db/channels";
import { makeUserTokenSource } from "../identity/user-token";
import { buildAgentEpisode } from "../memory/episode";
import { agentGraphIdFor } from "../memory/graphs";
import { ensureOutboxRow } from "../memory/outbox";
import { sendNudge, updateNudge } from "../notify/nudge";
import type { Env } from "../index";
import type { RunAgent } from "./agent";
import { assertRunKey, runOriginOf } from "./keys";
import { getRunById, getRunByKey, type RunRecord } from "./repository";

/** What a capability asks for when it wants to say something to a customer. */
export type EscalateInput = {
  /** The exact text that would be sent, verbatim, if approved unedited. */
  draft: string;
  /** One line of why, for the dashboard card and the engineer's DM. */
  why: string;
};

/** One human decision on one open approval. */
export type ResolveInput = {
  approvalId: string;
  /** `approve` | `edit` (carries the replacement text) | `reject` (carries a reason). */
  decision: DecisionInput;
  /** The Access-verified engineer email that decided. Never model-supplied. */
  decidedBy: string;
  /** The decision instant, so the caller's clock is the one recorded. */
  decidedAt: number;
};

/**
 * The outcome of a decision, as a CAS result rather than a boolean.
 *
 * `already_resolved` is a normal outcome, not an error: two dashboard tabs, a
 * retried PATCH, and the cron repair sweep all race here, and the second one
 * through must learn what the first decided rather than overwrite it.
 */
export type ResolveResult =
  | { status: "resolved"; approval: Approval }
  | { status: "already_resolved"; approval: Approval }
  | { status: "not_found" };

/** One approval as the dashboard and the run both see it. */
export type Approval = {
  id: string;
  runId: string;
  draft: string;
  why: string;
  decision: ApprovalDecision;
  /** The text that was actually sent: the edit when edited, else the draft. */
  editedText: string | null;
  rejectReason: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
  delivery: ApprovalDelivery;
  createdAt: number;
};

/** The local row, in SQLite's own column names. */
type ApprovalRowLocal = {
  id: string;
  run_id: string;
  draft: string;
  why: string;
  decision: ApprovalDecision;
  edited_text: string | null;
  reject_reason: string | null;
  decided_by: string | null;
  decided_at: number | null;
  delivery: ApprovalDelivery;
  created_at: number;
};

function toApproval(row: ApprovalRowLocal): Approval {
  return {
    id: row.id,
    runId: row.run_id,
    draft: row.draft,
    why: row.why,
    decision: row.decision,
    editedText: row.edited_text,
    rejectReason: row.reject_reason,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    delivery: row.delivery,
    createdAt: row.created_at,
  };
}

/**
 * The Worker bindings, off an agent whose `env` is `protected`.
 *
 * `DurableObject.env` is protected and `RunAgent` deliberately does not widen
 * it — Wave B fills stub bodies and never edits `src/run/agent.ts`. Same cast,
 * and the same reasoning, as `runIndexDb` in `agent-projection.ts`.
 */
function agentEnv(agent: RunAgent): Env {
  return (agent as unknown as { env: Env }).env;
}

/**
 * The D1 `runs` row this object is the session for, or null.
 *
 * Through the run KEY (this object's name), never a string-built id: a Slack
 * run's public `runs.id` is a separate UUID (invariant 10). A missing row is
 * not an error here — it is the fail-closed direction, and every caller below
 * treats it as "no card, no send".
 */
async function resolveRun(env: Env, key: string): Promise<RunRecord | null> {
  try {
    return await getRunByKey(env.DB, key);
  } catch {
    return null;
  }
}

/**
 * The best available public run id when D1 has no row yet.
 *
 * A chat run's key IS `chat:{its public id}`, so that one is exact. A Slack
 * run's public id is a separate UUID that only D1 knows, so this returns the
 * key itself: downstream reads find no row and REFUSE, which is the direction
 * a missing index must fail in.
 */
function fallbackRunId(key: string): string {
  const validated = assertRunKey(key);
  return runOriginOf(validated) === "chat" ? validated.slice("chat:".length) : validated;
}

/**
 * Create the agent's approval table if it is not there yet.
 *
 * Called from `RunAgent.onStart`, so it runs on every wake and must be
 * idempotent (`CREATE TABLE IF NOT EXISTS`). Also called at the top of both
 * write paths: an escalation that arrives before the start hook has run must
 * be stored, not dropped with a "no such table".
 */
export function ensureApprovalSchema(agent: RunAgent): void {
  agent.sql`
    CREATE TABLE IF NOT EXISTS approvals (
      id            TEXT PRIMARY KEY,
      run_id        TEXT NOT NULL,
      draft         TEXT NOT NULL,
      why           TEXT NOT NULL,
      decision      TEXT NOT NULL,
      edited_text   TEXT,
      reject_reason TEXT,
      decided_by    TEXT,
      decided_at    INTEGER,
      delivery      TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    )
  `;
}

/* --------------------------------------------------------------- escalate -- */

/**
 * Open one approval for this run and return its id.
 *
 * The local row is written FIRST and synchronously: it is what the pause
 * latches on at turn end, and it must survive a crash in anything that comes
 * after it. Everything after it — the dashboard's D1 card, the on-duty
 * engineer's nudge DM — is best-effort and cannot fail this call, because a
 * capability that threw here would hand the model an error about a decision a
 * human may still be about to make.
 *
 * It does not block on a human: nothing in here waits for the decision. The
 * model ends its turn and the pause latches at turn end.
 */
export async function escalate(
  agent: RunAgent,
  input: EscalateInput,
): Promise<{ approvalId: string }> {
  ensureApprovalSchema(agent);

  const env = agentEnv(agent);
  const approvalId = `apr:${crypto.randomUUID()}`;
  const now = Date.now();
  const run = await resolveRun(env, agent.name);
  const runId = run?.id ?? fallbackRunId(agent.name);

  agent.sql`
    INSERT INTO approvals (id, run_id, draft, why, decision, edited_text,
                           reject_reason, decided_by, decided_at, delivery, created_at)
    VALUES (${approvalId}, ${runId}, ${input.draft}, ${input.why}, 'pending',
            NULL, NULL, NULL, NULL, 'none', ${now})
  `;

  await projectCard(env, run, {
    approvalId,
    draft: input.draft,
    why: input.why,
    now,
  });

  return { approvalId };
}

/**
 * The dashboard's card, plus the engineer's DM. Best-effort, in that order.
 *
 * Ordering is the point, and it is the same one `src/approval/projection.ts`
 * documents: the card is committed FIRST, so the DM can never point at a card
 * the dashboard has not got.
 *
 * The Think chassis has no generation numbering of its own — turns are Think's
 * and there is no per-attempt id to record — so the card's `generation_id`
 * names the approval itself. It is a NOT NULL column whose only reader is a
 * human joining a card back to what produced it, and the approval id is the
 * most specific answer this chassis has.
 */
async function projectCard(
  env: Env,
  run: RunRecord | null,
  card: { approvalId: string; draft: string; why: string; now: number },
): Promise<void> {
  // No indexed run, or no pinned customer thread (a chat run has none), means
  // there is no card a human could act on. The local row still stands, and the
  // run still parks on it — a chat run's approval is settled from the dashboard
  // run view, not from the Slack-reply queue.
  if (run === null || run.channelId === null || run.threadTs === null) return;

  try {
    const created = await insertApproval(env.DB, {
      id: card.approvalId,
      runId: run.id,
      generationId: card.approvalId,
      draft: card.draft,
      why: card.why,
      channelId: run.channelId,
      threadTs: run.threadTs,
      shadow: run.shadow,
      now: card.now,
    });
    if (created !== "created") return;

    const row = await getApproval(env.DB, card.approvalId);
    if (row !== null) await sendNudge(env, row);
  } catch {
    // Swallowed on purpose. The escalation itself succeeded and is durable
    // locally; a D1 or Slack outage here costs the card, not the approval, and
    // the alternative — throwing back into model-authored code — would report a
    // failure for something that did happen. Ids only if this ever logs.
    console.warn("approval card did not project", { approvalId: card.approvalId });
  }
}

/* ------------------------------------------------------------------ read -- */

/** Every approval on this run — open ones by default. */
export async function pendingApprovals(
  agent: RunAgent,
  opts?: { includeResolved?: boolean },
): Promise<Approval[]> {
  ensureApprovalSchema(agent);
  // `*` rather than a column list, and it is safe precisely here: this table is
  // private to this module, every reader goes through `toApproval`, which maps
  // by NAME, and `agent.sql` is a tagged template that binds every
  // interpolation as a `?` parameter — a spliced column list would arrive as a
  // bound string, not as SQL.
  const rows = opts?.includeResolved
    ? agent.sql<ApprovalRowLocal>`SELECT * FROM approvals ORDER BY created_at ASC`
    : agent.sql<ApprovalRowLocal>`
        SELECT * FROM approvals WHERE decision = 'pending' ORDER BY created_at ASC
      `;
  return rows.map(toApproval);
}

/* --------------------------------------------------------------- resolve -- */

/**
 * Apply a human decision, then re-enter the loop.
 *
 * THE CAS IS THE CONDITIONAL UPDATE, and everything else in this function
 * hangs off it. Exactly one caller can move a row out of `pending`, so exactly
 * one caller reaches the send below — which is what makes a retried PATCH, a
 * second dashboard tab and the one-minute repair sweep safe to all arrive.
 */
export async function resolveApproval(
  agent: RunAgent,
  input: ResolveInput,
): Promise<ResolveResult> {
  ensureApprovalSchema(agent);
  // Before any write: a blank edit text or reject reason is refused here, on
  // the same helper the D1 path uses, so a row cannot be moved out of `pending`
  // into a decision that carries nothing.
  validateDecisionInput(input.decision);

  const action = input.decision.action;
  const decision: ApprovalDecision =
    action === "approve" ? "approved" : action === "edit" ? "edited" : "rejected";
  const editedText = input.decision.action === "edit" ? input.decision.text : null;
  const rejectReason = input.decision.action === "reject" ? input.decision.reason : null;

  // ONE STATEMENT. `WHERE ... AND decision = 'pending'` plus `RETURNING` is a
  // read and a write that cannot be separated: a second caller either sees the
  // row still pending and wins it, or matches nothing and gets no rows back.
  // There is no read-then-write window for two engineers to both fall through.
  const [won] = agent.sql<ApprovalRowLocal>`
    UPDATE approvals
       SET decision = ${decision},
           edited_text = ${editedText},
           reject_reason = ${rejectReason},
           decided_by = ${input.decidedBy},
           decided_at = ${input.decidedAt}
     WHERE id = ${input.approvalId} AND decision = 'pending'
    RETURNING *
  `;

  if (won === undefined) {
    // Lost, or never existed. The difference matters to the caller: a lost CAS
    // carries the WINNING decision back so the dashboard and the sweeper can
    // stop, while an unknown id must never be reported as settled.
    const [current] = agent.sql<ApprovalRowLocal>`
      SELECT * FROM approvals WHERE id = ${input.approvalId}
    `;
    return current === undefined
      ? { status: "not_found" }
      : { status: "already_resolved", approval: toApproval(current) };
  }

  const env = agentEnv(agent);
  // THE EDITED TEXT IS WHAT GOES OUT. The draft is kept beside it, never
  // instead of it: the human's version is the only one that may reach a
  // customer, and the draft survives only so the model can be shown what was
  // superseded and memory can learn what this team will not say.
  const finalText = decision === "edited" ? (editedText ?? won.draft) : won.draft;

  const delivered =
    decision === "rejected"
      // Nothing to send, so the delivery sub-machine never runs.
      ? { delivery: "none" as ApprovalDelivery, error: null }
      : await deliver(agent, env, won, finalText);

  agent.sql`UPDATE approvals SET delivery = ${delivered.delivery} WHERE id = ${won.id}`;

  const content = resolutionTurnContent({
    decision,
    text: decision === "rejected" ? null : finalText,
    reason: rejectReason,
    draft: won.draft,
    delivery: delivered.delivery,
    deliveryError: delivered.error,
  });

  if (decision === "rejected") {
    await rememberRejection(env, agent.name, won, content);
  }

  // `mode: "submit"` is REQUIRED, not stylistic. A blocking mode throws when
  // called from inside an active turn (verified fact 10), and this is reachable
  // from both sides — the dashboard's PATCH while the run sits parked, and the
  // repair sweep while a successor turn may already be running. The idempotency
  // key is the approval id, so a redelivered resolution is `accepted: false`
  // rather than a second turn carrying the same decision twice.
  // SCHEDULED, not called, and the distinction is load-bearing.
  //
  // `resolveApproval` runs INSIDE the Durable Object, reached by RPC from the
  // dashboard's PATCH. Calling `runTurn` here deadlocks — measured, and it
  // deadlocks whether or not the promise is awaited, because the DO holds the
  // RPC open until in-flight promises settle while the turn queue cannot drain
  // until this call returns. The same three tests hang indefinitely with the
  // call and pass in ~12s without it.
  //
  // `schedule(0, ...)` is the DO-native way to run work AFTER the current call
  // returns: it writes a row and arms the alarm, so the re-entry survives
  // eviction and a crash between the decision and the turn. It is also the
  // right shape for the caller — a human clicking Approve gets their answer as
  // soon as the decision is committed and the message is sent, and never waits
  // on a model turn.
  await agent.schedule(0, "reenterAfterApproval", {
    input: content,
    idempotencyKey: `approval:${won.id}`,
  });

  await mirrorCard(env, won.id, delivered);

  const [fresh] = agent.sql<ApprovalRowLocal>`
    SELECT * FROM approvals WHERE id = ${won.id}
  `;
  return { status: "resolved", approval: toApproval(fresh ?? won) };
}

/**
 * The `delivery_error` written when a resolution is re-entered while a send is
 * still in flight — the one delivery error a human has to act on, because it
 * means somebody must open the thread and look before anything else is sent.
 */
const REENTERED_WHILE_SENDING = "the resolution was re-entered while a send was in flight";

/**
 * Send the approved text as the ON-DUTY ENGINEER, and report what happened.
 *
 * Delivery never writes back to the decision (invariant 5): nothing in here can
 * roll a human's click back, and the worst case is an `in_doubt` row and a
 * sentence telling a person to go and look.
 *
 * Every destination fact comes from HOST state — the D1 `runs` row for the
 * channel, the thread and the shadow flag — and none from the model or the
 * card's snapshot (invariant 10).
 */
async function deliver(
  agent: RunAgent,
  env: Env,
  row: ApprovalRowLocal,
  text: string,
): Promise<{ delivery: ApprovalDelivery; error: string | null }> {
  const run = await resolveRun(env, agent.name);
  if (run === null) {
    // Shadow is unknowable without this row, and a run that might be shadowing
    // a customer conversation must not be written to. Blocked rather than
    // suppressed: we are not entitled to claim it was a shadow run, only that
    // nothing was sent.
    return { delivery: "blocked", error: "run_not_indexed" };
  }
  if (run.shadow) {
    return { delivery: "suppressed", error: null };
  }
  if (run.channelId === null || run.threadTs === null) {
    return { delivery: "blocked", error: "no_pinned_thread" };
  }

  // THE SECOND GUARD AGAINST A SECOND SEND. The decision CAS above already
  // admits one caller, so this is the crash case rather than the race case: a
  // resolution that died between the send and its outcome leaves `sending`
  // behind, and a re-entry then reports an UNKNOWN outcome instead of trying
  // again. A duplicate message to a customer cannot be taken back.
  const [started] = agent.sql<{ id: string }>`
    UPDATE approvals SET delivery = 'sending'
     WHERE id = ${row.id} AND delivery = 'none'
    RETURNING id
  `;
  if (started === undefined) {
    return { delivery: "in_doubt", error: REENTERED_WHILE_SENDING };
  }

  // No bot-token fallback, ever: a source with nobody on duty returns an honest
  // `blocked`, and customer-facing speech carries a human's name or is not sent.
  const sender = makeUserTokenSender(makeUserTokenSource(env));
  try {
    const outcome = await sender.send({
      runId: run.id,
      channelId: run.channelId,
      threadTs: run.threadTs,
      text,
    });
    return outcome.result === "sent"
      ? { delivery: "sent", error: null }
      : { delivery: outcome.result, error: outcome.reason };
  } catch {
    // A THROWN sender is an unknown outcome, not a failure: the request may
    // well have reached Slack before the throw. Treating it as retryable is the
    // one thing that could double-post to a customer.
    return { delivery: "in_doubt", error: "the sender threw" };
  }
}

/**
 * Mirror the delivery outcome onto the dashboard's card, and settle the DM.
 *
 * Best-effort in the strong sense: the decision and the send have both already
 * happened, and neither may be undone by a D1 or Slack failure here. The nudge
 * edit comes last because a slow Slack must not hold up the card.
 */
async function mirrorCard(
  env: Env,
  approvalId: string,
  delivered: { delivery: ApprovalDelivery; error: string | null },
): Promise<void> {
  try {
    if (delivered.delivery !== "none") {
      await setDelivery(
        env.DB,
        approvalId,
        ["none", "sending"],
        delivered.delivery,
        delivered.error,
        Date.now(),
      );
    }
    const row = await getApproval(env.DB, approvalId);
    if (row !== null) await updateNudge(env, row);
  } catch {
    /* the decision stands; the card is a projection and may lag */
  }
}

/**
 * A rejection is the most valuable thing this system learns, so it goes to
 * memory even though nothing was sent.
 *
 * The episode's `asked` is the RESOLUTION TURN CONTENT, byte-identical to what
 * the model is told — which is why `resolutionTurnContent` puts the reason
 * ahead of the draft in its rejected branch: `boundedEpisodeText` keeps the
 * head, so on a long draft it is the reason that survives the cap.
 *
 * Best-effort, and the D1 row alone is enough: the one-minute cron sweep drains
 * `agent_memory_outbox` whether or not the queue send below lands.
 */
async function rememberRejection(
  env: Env,
  key: string,
  row: ApprovalRowLocal,
  content: string,
): Promise<void> {
  try {
    const run = await resolveRun(env, key);
    // The outbox row has a foreign key onto `runs`. Without an indexed run
    // there is nothing to hang the episode off, and inventing an id would fail
    // the constraint on every retry.
    if (run === null) return;

    const policy = run.channelId === null ? null : await getChannelPolicy(env.DB, run.channelId);
    const payload = buildAgentEpisode({
      runId: run.id,
      agentTurnId: `approval:${row.id}`,
      outcome: "refused",
      asked: content,
      actions: [],
      draft: row.draft,
      sources: [],
    });

    const outboxId = `memory:${run.id}:approval:${row.id}`;
    await ensureOutboxRow(env.DB, {
      id: outboxId,
      runId: run.id,
      generationId: `approval:${row.id}`,
      // Decided HERE from trusted host state — the run's own channel policy,
      // never a customer slug that came through a turn or a tool argument
      // (invariants 35-36).
      graphId: agentGraphIdFor({ origin: run.origin, policy }),
      episodeJson: JSON.stringify(payload.episode),
      sourceJson: JSON.stringify(payload.sources),
      now: Date.now(),
    });
    await env.MEMORY_QUEUE.send({ kind: "agent_generation", outboxId });
  } catch {
    console.warn("rejection did not reach the memory outbox", { approvalId: row.id });
  }
}

/* --------------------------------------------------------------- notifier -- */

/**
 * The Think chassis's `ResolutionNotifier`: the dashboard's committed decision,
 * delivered to the `RunAgent` that owns the run.
 *
 * The legacy sibling is `makeRunDoResolutionNotifier` in
 * `src/approval/notifier.ts`; `src/api/approvals.ts` picks between them on
 * `RUN_CHASSIS` and changes nothing else — same Access check, same roster, same
 * D1 CAS, same invariant 9 behaviour on a failed delivery.
 *
 * `runId -> key -> agent`, never `runId -> agent`. The Durable Object name is
 * the run's origin key, which is deliberately not the public `runs.id` a
 * browser sees (invariant 10).
 */
export function makeRunAgentResolutionNotifier(env: Env): ResolutionNotifier {
  return {
    async notify(input) {
      const run = await getRunById(env.DB, input.runId);
      // Not deliverable and not repairable by retrying, but reported as
      // undelivered rather than thrown: a human's committed decision must never
      // turn into a failed request (invariant 9).
      if (run === null) return { applied: false };

      const decision = toDecisionInput(input);
      if (decision === null) return { applied: false };

      const agent = await getAgentByName<Env, RunAgent>(env.RUN_AGENTS, run.key);
      const outcome = await agent.resolveApproval({
        approvalId: input.approvalId,
        decision,
        decidedBy: input.decidedBy,
        decidedAt: Date.now(),
      });

      if (outcome.status === "resolved") return { applied: true };
      // A REDELIVERY is delivered — but only once the run agrees on WHAT was
      // decided. A mismatch means this decision was never the one applied, and
      // reporting it delivered would retire the repair key on a resolution the
      // run never saw.
      if (outcome.status === "already_resolved") {
        const expected =
          input.decision === "approved"
            ? "approved"
            : input.decision === "edited"
              ? "edited"
              : "rejected";
        return { applied: outcome.approval.decision === expected };
      }
      return { applied: false };
    },
  };
}

/**
 * The API's decision shape, as the agent's.
 *
 * `null` for the two shapes that cannot be acted on: an edit with no text and a
 * rejection with no reason. Both are refused by the D1 route before they get
 * here, so reaching this line means a malformed replay — reported as
 * undelivered rather than sent as a blank message.
 */
function toDecisionInput(input: {
  decision: "approved" | "edited" | "rejected";
  outboundText: string | null;
  rejectReason: string | null;
}): DecisionInput | null {
  if (input.decision === "approved") return { action: "approve" };
  if (input.decision === "edited") {
    return input.outboundText === null ? null : { action: "edit", text: input.outboundText };
  }
  return input.rejectReason === null ? null : { action: "reject", reason: input.rejectReason };
}
