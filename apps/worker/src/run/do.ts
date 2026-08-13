import { DurableObject } from "cloudflare:workers";
import type { Env } from "../index";
import type {
  AssistantUpdateInput,
  RunEvent,
  RunServerMessage,
  RunStatus,
  RunTurnInput,
  ToolCallUpdateInput,
} from "./protocol";
import { parseClientMessage } from "./protocol";
import { broadcastEvent } from "./broadcast";
import { getRunById, projectRunIndex } from "./repository";
import {
  outboundText,
  resolutionTurnContent,
  type ApprovalDelivery,
  type ApprovalRow,
} from "../approval/contracts";
import {
  getApproval,
  markResolutionDelivered,
  setDelivery,
} from "../approval/repository";
import {
  appendAssistantUpdate,
  appendToolCallUpdate,
  appendTurn,
  claimGeneration,
  claimProjectionJob,
  coalesceSupersededRunIndexJobs,
  completeProjectionJob,
  countPendingProjectionJobs,
  ensureSchema,
  finalizeGeneration,
  initializeSession,
  latestSeq,
  listEvents,
  listRecentTurns,
  listToolCalls,
  listTurns,
  listTurnsAfter,
  nextProjectionDueAt,
  readDriver,
  readGeneration,
  resolveApprovalState,
  readRunIndexRevision,
  countModelSteps,
  resumeAfterOperatorConfig,
  retryProjectionJob,
  readState,
  setStatus,
  setSummary,
  snapshot,
  touchRunIndex,
  type AppendResult,
  type RunDescriptor,
  type RunState,
  type SessionSnapshot,
  type StatusResult,
} from "./session";
import type {
  AssistantUpdateOutcome,
  ClaimFence,
  ClaimSnapshot,
  DriverPhase,
  DriverState,
  FinalizeOutcome,
  ProjectionJobKind,
} from "../agent/contracts";
import { updateNudge } from "../notify/nudge";
import { abortForNewerInput } from "../agent/steering";
import { ensureRunPortsInstalled } from "../agent/ports";

import {
  continuationMadeNoProgress,
  crashOutcome,
  deadlineOutcome,
  nextAlarmAt,
  noProgressOutcome,
  resolveRunPorts,
  safeErrorText,
  toFinalizeRequest,
  type ClaimedProjectionJob,
  type ContinuationOutcome,
  type RunPorts,
} from "../agent/driver";
import {
  driverRetryBackoffMs,
  PROJECTION_LEASE_MS,
  projectionRetryBackoffMs,
} from "../agent/limits";

/**
 * The thread-scoped run. One object per origin key — `slack:{channel}:{thread}`
 * or `chat:{uuid}` — reached only through `runStubForKey()`.
 *
 * No correctness state lives in memory. There is no client map, no cached turn
 * list, no timer and no interval, so a wake from hibernation needs nothing but
 * the constructor's schema call.
 */
/**
 * Backlog page size. Bounded so a long run's replay is several ordered frames
 * rather than one unbounded WebSocket message the dashboard cannot render
 * incrementally.
 */
const SYNC_CHUNK = 200;

function upgradeError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export type SetStatusOutcome =
  | { ok: true; changed: boolean; status: RunStatus; event: RunEvent | null }
  | { ok: false; status: RunStatus | null; reason: string };

function eventCreatedAt(event: RunEvent): number {
  switch (event.type) {
    case "turn":
      return event.turn.createdAt;
    case "tool_call":
    case "assistant_update":
      return event.update.createdAt;
    case "status":
      return event.createdAt;
  }
}

/**
 * The `delivery_error` written when a resolution is re-entered while a send is
 * still in flight. Named rather than inline because it is the one delivery
 * error a human reading the dashboard has to act on: it means somebody must
 * open the thread and look before anything else is sent.
 */
const REENTERED_WHILE_SENDING = "the resolution was re-entered while a send was in flight";

/** How many revisions one drain pass will carry before yielding. */
const PROJECTION_DRAIN_MAX = 8;

export type ProjectionFlush = { projected: number; failed: number; pending: number };

/**
 * The four words a dashboard may know about the driver.
 *
 * Identical to `DriverPhase` today, and mapped rather than passed through on
 * purpose: the private phase set is going to grow (Phase 11 adds an approval
 * pause), and a pass-through would publish the new member the day it is added.
 * The map is where a new private phase has to be given a public name — or
 * deliberately collapsed onto an existing one — in a diff somebody reads.
 */
export type PublicDriverPhase = "scheduled" | "running" | "idle" | "failed";

const PUBLIC_DRIVER_PHASE: Record<DriverPhase, PublicDriverPhase> = {
  idle: "idle",
  scheduled: "scheduled",
  running: "running",
  failed: "failed",
};

/**
 * The public status a finalized `settled` outcome implies, keyed by the driver
 * phase it left behind.
 *
 * A table rather than a ternary because the third entry is the one that is easy
 * to get wrong: a terminal failure that woke a successor for stranded input is
 * `scheduled`, and it is `live`, not `failed`.
 */
const FINALIZED_STATUS: Record<"idle" | "failed" | "scheduled", RunStatus> = {
  idle: "idle",
  failed: "failed",
  scheduled: "live",
};

export type PublicDriverState = {
  state: PublicDriverPhase;
  attempt: number;
  steps: number;
  /** The safe error CODE, never a provider or capability message. */
  error: string | null;
};

/** What one alarm delivery actually did. Returned for tests and operator tooling. */
export type AlarmOutcome = {
  dispatched: "model" | "projection" | "none";
  /**
   * What the model half of the dispatch decided, reported separately from
   * `dispatched` on purpose: "a projection was delivered" and "the model claim
   * was refused because a lease is live" are different facts, and collapsing
   * them into one field is how a test ends up asserting the wrong one.
   */
  model: "claimed" | "lease_held" | "backoff" | "not_scheduled" | "parked";
  /** The alarm armed for the next due item, or null when the object may hibernate. */
  nextAlarmAt: number | null;
  detail: string;
};

export class RunDO extends DurableObject<Env> {
  #ports: RunPorts | null = null;
  #portsKey: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // THE PRODUCTION WIRING, and the earliest point that can carry it.
    //
    // Ports must exist before `#armAlarm()` below decides whether model work is
    // enabled, and before any alarm, socket or RPC entry reads them. Module
    // scope cannot do it (the ports need `env`); a handler cannot do it (crash
    // recovery runs in this constructor, before any handler). Idempotent and
    // memoized per isolate; a test's key-scoped registration still wins.
    ensureRunPortsInstalled(env);

    // Synchronous only. This runs again on every wake, so it must be cheap and
    // must not await.
    ensureSchema(ctx.storage);

    // Answered by the runtime without waking a hibernating object, so the UI
    // can hold a liveness check that costs nothing. setWebSocketAutoResponse is
    // the method; WebSocketRequestResponsePair is only the payload.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

    // Short constructor recovery.
    //
    // `blockConcurrencyWhile` is used for exactly one thing: read LOCAL driver
    // and projection state and re-arm the alarm, so an object that crashed
    // mid-attempt or lost a post-commit `setAlarm()` heals on its next wake
    // instead of waiting for a message that may never come.
    //
    // Nothing external happens inside it — no model, no projector, no D1, no
    // fetch. Holding the gate across external I/O would block steering from
    // entering while a provider request is in flight, which is the one thing
    // the whole design is arranged to allow (invariant 11).
    //
    // Nothing is caught. If the local read or `setAlarm()` itself fails, this
    // object's ONLY recovery path has failed, and swallowing that would leave a
    // permanently unscheduled run that looks healthy. Letting it throw resets
    // the object and lets the platform try again.
    ctx.blockConcurrencyWhile(async () => {
      this.#resumeAfterOperatorConfig();
      await this.#armAlarm();
    });
  }

  /**
   * THE CONFIG RESET, applied at the only moment a deployment's configuration
   * can have changed under a Durable Object: its construction.
   *
   * A run that failed composition for want of the Gateway settings is terminal
   * and `requires_operator_config`, so no message and no steer can revive it —
   * correctly, because ordinary input must never bypass that policy. The
   * operator action that MAY revive it is supplying the configuration, and a
   * secret landing is a new deployment, which means every object is torn down
   * and rebuilt. This constructor is therefore the first moment such a run can
   * observe that the thing which killed it is gone.
   *
   * Placed BEFORE `#armAlarm()` deliberately: the reschedule is what gives the
   * alarm something to arm for, and running it after would leave the revived
   * generation sitting `scheduled` with no alarm until the next wake.
   *
   * Cheap and quiet in the ordinary case. `resumeAfterOperatorConfig` returns
   * immediately unless the deployment is configured AND this object's driver is
   * failed on an ABSENT-configuration code, so a healthy object pays one boolean
   * and one local SELECT.
   *
   * The `live` transition IS delivered, because "a constructor runs on a cold
   * object with nobody watching" is FALSE here. This object hibernates its
   * sockets (`ctx.acceptWebSocket` in `fetch`), so a construction driven by a
   * hibernated socket's own inbound frame — or by any request while such a
   * socket is attached — finds those sockets already restored on `ctx`, and
   * `ctx.getWebSockets()` returns them inside this very constructor. A dashboard
   * that was open when the deployment rolled is exactly the reader most entitled
   * to see the run come back.
   *
   * Safe to do from here on both counts the constructor cares about: `#broadcast`
   * is synchronous and awaits nothing, so the rule at the top of the constructor
   * holds; and it runs AFTER `resumeAfterOperatorConfig`'s `transactionSync` has
   * committed, which is the same durable-then-broadcast order `#afterCommit`
   * keeps. The per-socket cursor makes it a no-op for a socket that already has
   * this seq, and with nobody attached it does nothing at all — the status event
   * and its run-index revision are committed by the same transaction either way,
   * for the next reader and the next projection flush.
   */
  #resumeAfterOperatorConfig(): void {
    const ports = this.#resolvePorts();
    if (!ports.modelConfigured) return;
    const resumed = resumeAfterOperatorConfig(
      this.ctx.storage,
      { configurationComplete: true },
      this.#now(),
    );
    if (resumed.outcome === "rescheduled" && resumed.statusEvent !== null) {
      this.#broadcast(resumed.statusEvent);
    }
  }

  /**
   * Ports are resolved lazily and re-resolved once the run has a key.
   *
   * The constructor runs before `initialize()` on a brand-new object, so a
   * key-scoped registration would be invisible if the resolution happened only
   * there. The ports are NOT built here — resolving is a map lookup and a local
   * SELECT, never a client, a socket or a secret.
   */
  #resolvePorts(): RunPorts {
    const key = readState(this.ctx.storage)?.key ?? null;
    if (this.#ports === null || key !== this.#portsKey) {
      this.#portsKey = key;
      this.#ports = resolveRunPorts(key);
    }
    return this.#ports;
  }

  #now(): number {
    return this.#resolvePorts().now();
  }

  /**
   * Hibernation delivers socket messages here, as a class handler. An ordinary
   * `addEventListener("message", ...)` on the server socket works right up
   * until the object hibernates, at which point the listener is gone and
   * messages route to a handler that was never written.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const parsed = parseClientMessage(message);
    if (!parsed.ok) {
      // A malformed frame is that socket's problem. It must not crash the
      // object or broadcast anything to the other tabs.
      this.#sendError(ws, parsed.code, parsed.message);
      return;
    }

    const { requestId, content } = parsed.message;
    try {
      // No pre-emptive setStatus here any more. Steering a parked or finished
      // run still resumes it, but the `live` transition now happens INSIDE the
      // append's transaction, so there is no window where the run reads live
      // with nothing scheduled — and a steer that is refused by the driver's
      // resume policy (a spend ceiling, a pending reconciliation) no longer
      // advertises a loop that will not start.
      //
      // The server assigns role and source. The parser has already refused any
      // client-supplied value, so a browser cannot pose as the customer or as
      // an approval decision.
      const result = await this.appendTurn({
        id: `steer:${requestId}`,
        role: "user",
        source: "human_steer",
        content,
      });

      const ack: RunServerMessage = { type: "ack", requestId, seq: result.event.seq };
      ws.send(JSON.stringify(ack));
    } catch (error) {
      this.#sendError(
        ws,
        "steer_failed",
        error instanceof Error ? error.message : "could not commit the turn",
        requestId,
      );
    }
  }

  #sendError(ws: WebSocket, code: string, message: string, requestId?: string): void {
    const frame: RunServerMessage = {
      type: "error",
      code,
      message,
      ...(requestId ? { requestId } : {}),
    };
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // Socket already gone; nothing to report it to.
    }
  }

  /**
   * The dashboard's live socket. Only `GET` with `Upgrade: websocket` — this
   * object serves no other HTTP surface.
   *
   * Deliberately NOT async, and there is no `await` anywhere in the body. That
   * is what closes the connect/append race: because the whole upgrade runs in
   * one uninterrupted Durable Object event, an `appendTurn` is serialized
   * either entirely before the cursor is captured (so the socket gets it in the
   * backlog) or entirely after `acceptWebSocket` (so it gets it live). There is
   * no window in which an event lands in neither path.
   */
  fetch(request: Request): Response {
    if (request.method !== "GET") {
      return upgradeError(405, "method_not_allowed", "run sockets accept GET only");
    }
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
      return upgradeError(426, "upgrade_required", "expected Upgrade: websocket");
    }

    const raw = new URL(request.url).searchParams.get("since");
    let since = 0;
    if (raw !== null) {
      // `Number("")` is 0, so an empty `?since=` would silently mean "replay
      // everything". A present-but-blank cursor is malformed input; say so.
      const parsed = raw.trim() === "" ? Number.NaN : Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return upgradeError(400, "invalid_since", "since must be a non-negative integer");
      }
      since = parsed;
    }

    // Clamp to what actually exists. A cursor from the future — a stale tab, or
    // a hand-edited query string — would otherwise sit above every seq the run
    // will ever produce and silence the client permanently, because #broadcast
    // skips anything at or below the socket's lastSeq.
    let cursor = Math.min(since, latestSeq(this.ctx.storage));

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // acceptWebSocket, NOT server.accept(). The latter yields a working socket
    // that pins the object in memory and burns duration cost silently.
    this.ctx.acceptWebSocket(server);

    const status = readState(this.ctx.storage)?.status ?? null;
    for (;;) {
      const events = listEvents(this.ctx.storage, cursor, SYNC_CHUNK);
      const complete = events.length < SYNC_CHUNK;
      if (events.length > 0) cursor = events[events.length - 1].seq;

      const frame: RunServerMessage = { type: "sync", events, cursor, complete, status };
      server.send(JSON.stringify(frame));
      if (complete) break;
    }

    server.serializeAttachment({ lastSeq: cursor });
    return new Response(null, { status: 101, webSocket: client });
  }

  initialize(descriptor: RunDescriptor): RunState {
    return initializeSession(this.ctx.storage, descriptor);
  }

  state(): RunState | null {
    return readState(this.ctx.storage);
  }

  snapshot(afterSeq = 0, limit?: number): SessionSnapshot {
    return snapshot(this.ctx.storage, afterSeq, limit);
  }

  cursor(): number {
    return latestSeq(this.ctx.storage);
  }

  /** Oldest-first, unchanged Phase 08 behaviour. See `recentTurns` for a long run. */
  turns(limit?: number) {
    return listTurns(this.ctx.storage, limit);
  }

  /** The NEWEST turns, oldest-first. What a long run's reader almost always wants. */
  recentTurns(limit?: number) {
    return listRecentTurns(this.ctx.storage, limit);
  }

  turnsAfter(afterEventSeq: number, limit?: number) {
    return listTurnsAfter(this.ctx.storage, afterEventSeq, limit);
  }

  /** Private driver state, for operator inspection and the Task 3 alarm. */
  driver(): DriverState {
    return readDriver(this.ctx.storage);
  }

  /**
   * The browser-safe projection of the driver, for the live run snapshot.
   *
   * Deliberately a SEPARATE method rather than a filter applied at the API
   * layer. `driver()` returns lease timestamps, heartbeat times, the claim
   * epoch, the generation id and the internal agent turn id; a route that
   * spread that object and deleted three keys would leak the next field
   * somebody adds. Here the shape is a construction, so a new private field is
   * private by default.
   *
   * What is withheld, and why:
   *
   *  - lease/heartbeat/next-attempt timestamps and the claim epoch: they are
   *    the concurrency fence, and publishing them tells a caller exactly when a
   *    claim is stealable;
   *  - the generation and agent turn ids: `agent_turn_id` is the Code Mode
   *    EFFECT SCOPE, the idempotency key external writes are reserved under;
   *  - the run key: the Durable Object name (invariant 10's `runs.id` rule);
   *  - the prompt, the transcript and any assistant text.
   *
   * `error` is the safe error CODE only, never the message: a message is
   * assembled from provider and capability text, and a capability's error can
   * carry a URL that had a token in it. Codes are ours.
   */
  publicDriver(): PublicDriverState {
    const driver = readDriver(this.ctx.storage);
    return {
      state: PUBLIC_DRIVER_PHASE[driver.phase],
      attempt: driver.attempt,
      steps: countModelSteps(this.ctx.storage),
      error: driver.lastErrorCode,
    };
  }

  toolCalls() {
    return listToolCalls(this.ctx.storage);
  }

  /**
   * The one inbox. Everything conversational arrives here: the triage opening,
   * later customer messages, dashboard steering, Phase 11 approval outcomes and
   * Phase 10 agent turns.
   */
  async appendTurn(input: RunTurnInput): Promise<AppendResult> {
    const result = appendTurn(this.ctx.storage, input);
    const committed = await this.#afterCommit(result);

    // BEST EFFORT, AFTER THE DURABLE COMMIT, AND NEVER BEFORE IT.
    //
    // A steer that joined a generation already in flight may cut short the
    // provider text that generation is streaming — the customer has changed
    // the question, so every further token is prose that is about to be
    // superseded anyway. It happens here, after the transaction, because an
    // abort issued before the commit could stop the current answer for input
    // that then failed to persist: the one ordering that can lose a turn.
    //
    // Nothing depends on it. The controller lives in memory and is usually
    // absent — the object may have been evicted, the model may be between
    // steps, or the loop may be inside a tool call, and in every one of those
    // cases the steer is picked up by the next `prepareStep` or by
    // `finalizeAnswer`'s cursor compare instead. This only makes it faster.
    if (committed.appended && committed.scheduling.outcome === "joined") {
      abortForNewerInput(this.ctx.storage);
    }
    return committed;
  }

  /**
   * ONE HUMAN DECISION, BACK INTO THE RUN IT CAME FROM.
   *
   * Called by the dashboard's `PATCH /api/approvals/:id` after its D1 CAS has
   * committed, and by the one-minute sweeper for any decided row whose
   * resolution never arrived (invariant 9). Five steps, each idempotent on
   * `approvalId`, in this order:
   *
   *   1. shadow run  ⇒ delivery `suppressed`, and NO sender call at all;
   *   2. else approved/edited ⇒ D1 `none -> sending`, send, `sending -> ...`;
   *   3. the local `approval_state` row ⇒ `resolved`, so the finalize latch
   *      cannot re-park the run on a decision that has already landed;
   *   4. `appendTurn({ id: "approval:"+approvalId, source: "approval" })`,
   *      which is the ordinary input transaction and therefore the wake;
   *   5. D1 `resolution_delivered_at`, which retires the sweeper's repair key.
   *
   * Steps 3 and 4 are the reverse of the plan's order, for a reason argued at
   * the call site: the plan's order has a crash window the sweeper cannot
   * repair, and this one is self-healing.
   *
   * A crash anywhere in that sequence is repaired by the sweeper re-invoking
   * this method: step 4's turn id makes re-entry append no second turn, and
   * step 2's CAS makes it attempt no second send.
   *
   * THE RUN RESUMES WHATEVER DELIVERY DID — `blocked`, `in_doubt` or
   * `suppressed` all unpark it. Under Phase 11's identity-refusing sender that
   * means every approval resumes `blocked`, which reads as a bug until you
   * price the alternative: the human's decision is a fact independently of
   * whether the message went out, and parking until a delivery that cannot
   * happen before Phase 13 would strand every real escalation for weeks. The
   * resolution turn says so honestly instead (see `resolutionTurnContent`).
   *
   * `decidedBy` is accepted, recorded in D1 by the caller, and DELIBERATELY
   * never passed to `appendTurn` (invariant 12). The model does not learn
   * which engineer clicked.
   */
  async resolveApproval(input: {
    approvalId: string;
    decision: "approved" | "edited" | "rejected";
    outboundText: string | null;
    rejectReason: string | null;
    decidedBy: string;
  }): Promise<{ applied: boolean }> {
    const state = readState(this.ctx.storage);
    if (state === null) return { applied: false };

    const card = await getApproval(this.env.DB, input.approvalId);
    // Nothing to resolve, or this decision belongs to a different
    // conversation. The second check is the one that matters: an approval
    // resolved into the wrong object would put one customer's approved text
    // into another customer's run. The notifier addresses this object by the
    // run's own key, so it can only fail through a caller bug — which is
    // exactly the kind this refuses cheaply.
    if (card === null || card.runId !== state.runId) return { applied: false };

    // THE D1 ROW DECIDES WHETHER THERE IS ANYTHING TO RESOLVE — invariant 6's
    // "one writer surface", enforced here rather than assumed of the caller.
    // Unparking a run on a decision the system of record does not carry would
    // be a resolution nobody made; a mismatched one would answer with the
    // wrong human's choice. Both are refused as undelivered, which leaves the
    // repair key (`resolution_delivered_at`) set and the sweeper re-driving,
    // rather than committing something unattributable.
    //
    // The TEXT still comes from `input`, not from the row: the caller derived
    // it from this same row with `outboundText` a moment ago, and taking it
    // here keeps the sweeper's replay byte-identical to the original notify.
    if (card.decision !== input.decision) return { applied: false };

    const finalText = input.outboundText ?? outboundText(card);
    const delivery =
      input.decision === "rejected"
        // `rejected | withdrawn => delivery stays none`. There is nothing to
        // send, so there is no delivery sub-machine to run at all.
        ? { delivery: "none" as ApprovalDelivery, error: null }
        : await this.#deliverApproval(card, finalText, state);

    // THE LOCAL RECORD IS SETTLED BEFORE THE TURN IS COMMITTED, and the order
    // is the opposite of the plan's — deliberately, because the plan's order
    // has a crash window its own repair path cannot repair.
    //
    // Turn first, then settle: a crash in between leaves a committed
    // resolution turn beside a still-`open` local row. That turn has already
    // scheduled a generation, which runs, answers, and at finalize
    // `latchApprovalPause` finds the open row and parks the run again. The
    // sweeper's re-drive then appends NOTHING — `writeTurn` returns
    // `appended:false` for an id it already holds — and nothing here writes a
    // status, so the run stays `awaiting_approval` until some unrelated
    // customer message happens to wake it. A repair path that provably cannot
    // repair is worse than no repair path.
    //
    // Settle first, then turn: a crash in between leaves a resolved local row
    // and no turn, so nothing wakes and nothing re-parks. The sweeper finds
    // `resolution_delivered_at IS NULL`, re-enters, appends the turn (that id
    // is not present yet), and the input transaction wakes the run — with the
    // latch already unable to re-park it. Self-healing in the direction
    // invariant 9 promises.
    //
    // Safe in the window it opens, which is the reason to check rather than
    // assume: the only reader of an unsettled row is the pause latch, and a
    // generation racing this one settles WITHOUT parking, which is the correct
    // end state anyway — the human's decision has landed, and the turn that
    // carries it is committed microseconds later by this same method or by the
    // sweeper.
    //
    // THIS ORDER IS MIRRORED BY A TEST THAT CANNOT SEE IT. `test/approval-
    // interrupt.test.ts` > "a withdraw whose D1 CAS was in flight when the
    // resolution landed" replays these three steps — decide in D1, settle the
    // local record, commit the turn — from inside a wrapped `D1Database`,
    // because a re-entrant RPC into the object under test is not possible. It
    // is how `ApprovalPort.withdraw` is proved not to re-park a run whose
    // decision has already arrived. Reorder the three statements below and that
    // test keeps passing while no longer standing for anything: change it in
    // the same commit.
    const moved = resolveApprovalState(this.ctx.storage, input.approvalId, "resolved", this.#now());

    const result = await this.appendTurn({
      id: `approval:${input.approvalId}`,
      role: "user",
      source: "approval",
      content: resolutionTurnContent({
        decision: input.decision,
        text: input.decision === "rejected" ? null : finalText,
        reason: input.rejectReason,
        draft: card.draft,
        delivery: delivery.delivery,
        deliveryError: delivery.error,
      }),
      // The approval id, so a reader can join this turn back to its card. No
      // decided_by here either — metadata rides on the same turn.
      metadata: { approvalId: input.approvalId, decision: input.decision, delivery: delivery.delivery },
    });

    // `resolveApprovalState` reports whether IT moved the row, not whether the
    // row is in the asked-for state — which is what makes this pair meaningful
    // rather than tautological.
    //
    // Under the order above, THIS call settling the local row beside a turn
    // that was already there is the anomalous combination: this method settles
    // first, so no earlier invocation of it can have left that pair behind. It
    // means another writer (a `withdraw` that lost to a human decision and put
    // the row back to `resolving`, or a genuinely interleaved second
    // resolution) moved it between that turn and this settle.
    //
    // The other direction — a fresh turn beside a row somebody had already
    // settled — is NOT anomalous any more: it is exactly what the sweeper's
    // repair of a crash between the settle and the turn looks like, and
    // warning on it would make the healthy repair path noisy.
    if (moved && !result.appended) {
      console.warn("approval resolution: the local record moved after its turn was committed", {
        approvalId: input.approvalId,
      });
    }

    await markResolutionDelivered(this.env.DB, input.approvalId, this.#now());

    // LAST, AND BEST-EFFORT: the engineer's nudge DM still shows a "Review"
    // button for a card that is now settled. `updateNudge` rewrites it in
    // place, makes no call at all when no nudge message was recorded, and
    // never throws — so it cannot turn a delivered resolution into a failed
    // one. It is after `markResolutionDelivered` deliberately: a slow Slack
    // must not hold the repair key open, or the sweeper would re-drive a
    // resolution that has already landed.
    //
    // `card` is the row as it stood when this method read it, which is AFTER
    // the dashboard's D1 CAS committed the decision (the `card.decision !==
    // input.decision` guard above is what proves that), so it carries the
    // decision and the decider this edit names.
    await updateNudge(this.env, card);
    return { applied: true };
  }

  /**
   * Step 1 and step 2: settle the delivery sub-machine, and return what it
   * settled on so the resolution turn can tell the truth about it.
   *
   * Delivery NEVER writes back to the decision (invariant 5). Nothing in here
   * can fail in a way that rolls a human's click back; the worst case is an
   * `in_doubt` row and a sentence telling a person to go and look.
   */
  async #deliverApproval(
    card: ApprovalRow,
    text: string,
    state: RunState,
  ): Promise<{ delivery: ApprovalDelivery; error: string | null }> {
    const db = this.env.DB;

    // Shadow is read LIVE from the D1 `runs` row, not taken from the card's
    // snapshot, and the two are OR-ed. A run's shadow flag only ever ratchets
    // false -> true (`run/repository.ts`), so a card projected before the
    // ratchet says `false` about a run that must never write to a customer —
    // and if the live row cannot be read at all, the snapshot is what is left,
    // which fails closed in the same direction.
    const run = await getRunById(db, card.runId);
    if (card.shadow || run?.shadow === true) {
      return this.#settleDelivery(card.id, ["none", "sending"], "suppressed", null);
    }

    if (state.channelId === null || state.threadTs === null) {
      // The destination comes from run state and nowhere else (invariant 10),
      // so a run with no pinned thread has nowhere to send — `escalate` refuses
      // to open an approval on such a run at all, which makes this unreachable
      // rather than merely unlikely. Blocked, and never a guess at a channel.
      return this.#settleDelivery(card.id, ["none", "sending"], "blocked", "no_pinned_thread");
    }

    // THE GUARD AGAINST A SECOND SEND, and it is this CAS rather than the read
    // above: a read can be stale, a conditional UPDATE cannot. Exactly one
    // caller moves `none -> sending`, and only that caller sends.
    const started = await setDelivery(db, card.id, ["none"], "sending", null, this.#now());
    if (!started) {
      // Somebody already started it. A row still `sending` is a crash between
      // the send and its outcome: an unknown outcome is a human's problem to
      // reconcile, whereas a duplicate customer message is not recoverable at
      // all — so this maps to `in_doubt` and NEVER to a second attempt. A row
      // that has already settled (the ordinary sweeper replay) is untouched by
      // that CAS and reported as it stands.
      return this.#settleDelivery(card.id, ["sending"], "in_doubt", REENTERED_WHILE_SENDING);
    }

    const sender = this.#resolvePorts().approvalSender;
    let outcome;
    try {
      outcome = await sender.send({
        runId: state.runId,
        channelId: state.channelId,
        threadTs: state.threadTs,
        text,
      });
    } catch (error) {
      // A THROWN sender is an unknown outcome, not a failure to send: the
      // request may well have reached Slack before the throw. Treating it as
      // retryable is the one thing that could double-post to a customer.
      outcome = { result: "in_doubt" as const, reason: safeErrorText(error, "the sender threw") };
    }

    return outcome.result === "sent"
      ? this.#settleDelivery(card.id, ["sending"], "sent", null)
      : this.#settleDelivery(card.id, ["sending"], outcome.result, outcome.reason);
  }

  /**
   * One delivery transition, reporting what the row ACTUALLY holds afterwards.
   *
   * The re-read on a refused CAS is not ceremony: the resolution turn quotes
   * this outcome to the model, and a turn that says "sent" about a row another
   * caller has just marked `in_doubt` would be the run confidently telling a
   * customer something nobody can confirm.
   */
  async #settleDelivery(
    approvalId: string,
    from: ApprovalDelivery[],
    to: ApprovalDelivery,
    error: string | null,
  ): Promise<{ delivery: ApprovalDelivery; error: string | null }> {
    const moved = await setDelivery(this.env.DB, approvalId, from, to, error, this.#now());
    if (moved) return { delivery: to, error };
    const current = await getApproval(this.env.DB, approvalId);
    return current === null ? { delivery: to, error } : { delivery: current.delivery, error: null };
  }

  async appendToolCallUpdate(input: ToolCallUpdateInput): Promise<AppendResult> {
    const result = appendToolCallUpdate(this.ctx.storage, input);
    return this.#afterCommit(result);
  }

  /**
   * One streamed assistant batch, committed then broadcast.
   *
   * Only an `appended` outcome broadcasts. A redelivered batch is `replayed`
   * and returns the sequence it already has, so an at-least-once alarm cannot
   * show the customer the same sentence twice; a `stale_claim` outcome writes
   * and sends nothing at all.
   */
  async appendAssistantUpdate(
    fence: ClaimFence,
    input: AssistantUpdateInput,
  ): Promise<AssistantUpdateOutcome> {
    const result = appendAssistantUpdate(this.ctx.storage, fence, input);
    if (result.outcome === "appended") {
      this.#broadcast(result.event);
      await this.#armAlarm();
      this.#kickProjection();
    }
    return result;
  }

  /**
   * Moves the private state and the D1 index through ONE method, so the two can
   * never disagree about whether a run is still live.
   *
   * Returns an outcome rather than rejecting. Two reasons: Phase 10 and 11 want
   * to branch on a refused transition rather than wrap every call in try/catch,
   * and a rejecting RPC method leaves an unhandled rejection inside the Durable
   * Object under vitest-pool-workers 0.21 — noise that masks real failures. The
   * invariant is unchanged; `session.setStatus` still throws, and that is where
   * it is unit-tested.
   */
  async setStatus(status: RunStatus): Promise<SetStatusOutcome> {
    let result: StatusResult;
    try {
      result = setStatus(this.ctx.storage, status);
    } catch (error) {
      const current = readState(this.ctx.storage)?.status ?? null;
      return {
        ok: false,
        status: current,
        reason: error instanceof Error ? error.message : "status change refused",
      };
    }

    // Synchronous section ends here. Broadcast, then hand D1 to the projector
    // WITHOUT awaiting it: the status is already durable locally, and a D1
    // outage must not make a status change fail or hang.
    if (result.event) this.#broadcast(result.event);
    await this.#armAlarm();
    this.#kickProjection();
    return { ok: true, changed: result.changed, status: result.status, event: result.event };
  }

  /**
   * The run list's one-line description.
   *
   * Phase 08 wrote this locally and then called `touchRun()`, which only moves
   * `updated_at` — the summary never reached D1 and the dashboard stayed blank.
   * The local write now allocates a run-index revision and the projector
   * carries status and summary over together, conditionally.
   */
  async setSummary(summary: string): Promise<{ changed: boolean; revision: number | null }> {
    const result = setSummary(this.ctx.storage, summary);
    await this.#armAlarm();
    this.#kickProjection();
    return result;
  }

  /**
   * Runs in the same continuation as the commit that produced `result`. The
   * order is load-bearing:
   *
   *   transactionSync (durable) -> broadcast (ordered) -> queue D1 (index)
   *
   * Broadcasting AFTER an awaited D1 write would let two concurrent appends
   * deliver out of order. The skip rule in `#broadcast` would then drop the
   * lower seq permanently, because a skipped event is never retried and the
   * client's next reconnect asks for the higher cursor it already recorded.
   *
   * Nothing here awaits D1 at all any more. The index work is already a durable
   * local job by the time this runs, so the projector can fail, retry, or wait
   * for the next alarm without the model or tool loop noticing. A D1 outage
   * during a nested capability's start/end events must not stall the
   * continuation that is holding a customer's answer.
   */
  async #afterCommit(result: AppendResult): Promise<AppendResult> {
    if (result.appended) {
      this.#broadcast(result.event);
      // The live transition, when this input scheduled work. It was committed
      // in the same transaction and holds the next seq, so it broadcasts second
      // and in order.
      if (result.statusEvent) this.#broadcast(result.statusEvent);
    }

    // Queued even on a retry that appended nothing: the first attempt may have
    // committed the event and then died before its index work was delivered, and
    // a duplicate delivery is the only thing that will ever heal that. A replay
    // therefore skips the coalescing window and forces a fresh revision — the
    // D1 apply is still conditional and MAX()-bounded, so it can only repair the
    // index, never move it backwards.
    touchRunIndex(
      this.ctx.storage,
      eventCreatedAt(result.event),
      result.appended ? undefined : 0,
    );

    // The wake, and its position is load-bearing.
    //
    // AFTER commit and broadcast: an alarm that fired before the turn was
    // durable would claim a generation whose input does not exist yet, and one
    // that fired before the broadcast could interleave an assistant update
    // ahead of the message it answers.
    //
    // BEFORE any D1 work: the index is a projection, and a D1 outage must never
    // be what stops the loop from waking.
    //
    // On a DUPLICATE delivery too, which is the point of doing it here rather
    // than inside the append's transaction: the first attempt may have committed
    // the turn and then died before scheduling, and a redelivery is the only
    // thing that will ever heal that. `#armAlarm` is idempotent — it only ever
    // moves the alarm earlier.
    await this.#armAlarm();
    this.#kickProjection();
    return result;
  }

  // --- the alarm -------------------------------------------------------------

  /**
   * The kinds this object can actually deliver right now.
   *
   * `run_index` is always here: this object owns it, because it needs `env.DB`
   * and the coalescing drain below. The other two are here only once a runner
   * is installed — a job whose kind has no runner is deliberately never claimed
   * and never scheduled, so an unwired `d1_usage` row parks instead of waking
   * the object forever to discover nobody can deliver it.
   */
  #projectionKinds(): ProjectionJobKind[] {
    const ports = this.#resolvePorts();
    const kinds: ProjectionJobKind[] = ["run_index"];
    for (const kind of ["d1_usage", "memory_outbox", "approval_card"] as const) {
      if (ports.projections[kind]) kinds.push(kind);
    }
    return kinds;
  }

  #plannedAlarmAt(now: number): number | null {
    const ports = this.#resolvePorts();
    return nextAlarmAt({
      driver: readDriver(this.ctx.storage),
      projectionDueAt: nextProjectionDueAt(this.ctx.storage, this.#projectionKinds()),
      continuationInstalled: ports.continuation !== null,
      now,
    });
  }

  /**
   * Arm the single alarm slot for the earliest due item.
   *
   * Only ever moves the alarm EARLIER. That is what makes it idempotent under
   * at-least-once delivery and safe to call from every mutation path: a
   * duplicate kick re-computes the same time and writes nothing, and a fresh
   * input arriving during a backoff pulls the alarm forward instead of queueing
   * behind it.
   *
   * Deliberately not wrapped in try/catch anywhere it is called. A failed
   * `setAlarm()` is the failure of the only mechanism that would ever retry
   * this work; the caller must see it, so its own retry can heal it.
   */
  async #armAlarm(): Promise<void> {
    const at = this.#plannedAlarmAt(this.#now());
    const current = await this.ctx.storage.getAlarm();

    if (at === null) {
      // Nothing is due. Leaving a stale alarm armed would wake this object to
      // discover it has no work, forever, on an otherwise hibernating run.
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    if (current !== null && current <= at) return;
    await this.ctx.storage.setAlarm(at);
  }

  /**
   * One durable wake.
   *
   * Delivery is at-least-once and the platform retries a rejection up to six
   * times, so every step below is idempotent: the claim is a conditional
   * transaction, the checkpoint keys are stable, and re-arming is
   * earliest-wins.
   *
   * Exactly ONE item is dispatched per delivery, model work first. Claiming
   * model work ahead of an older-due projection job is the priority rule that
   * keeps a vendor outage from starving the customer loop; arming for the
   * earliest of the two is what keeps the busy loop from starving delivery.
   * If more is due, the re-arm at the end schedules the next delivery
   * immediately rather than looping here — a long drain inside one alarm is a
   * long time during which a crash loses everything after the last commit.
   *
   * `ctx.waitUntil()` is not the loop's lifetime. A promise the runtime is
   * merely waiting on has no durable existence: if the object dies, nothing
   * remembers it. The alarm does.
   */
  async alarm(info?: AlarmInvocationInfo): Promise<void> {
    await this.dispatchAlarm(info);
  }

  /**
   * The alarm's body, returning what it did.
   *
   * `alarm()` itself must return void to satisfy the platform's handler shape,
   * which would leave a test asserting on scheduling by inspecting storage and
   * guessing. This says it outright.
   */
  async dispatchAlarm(_info?: AlarmInvocationInfo): Promise<AlarmOutcome> {
    const now = this.#now();
    const ports = this.#resolvePorts();
    let dispatched: AlarmOutcome["dispatched"] = "none";
    let model: AlarmOutcome["model"] = "parked";
    let detail = "no continuation wired; model work parked";

    if (ports.continuation !== null) {
      const claim = claimGeneration(this.ctx.storage, {
        now,
        leaseMs: ports.limits.claimLeaseMs,
      });
      switch (claim.outcome) {
        case "claimed":
          dispatched = "model";
          model = "claimed";
          detail = await this.#runContinuation(claim.claim, now);
          break;
        case "already_running":
          // A live lease. A second provider stream is refused (invariant 10) —
          // but the projection half of this delivery still runs, and the re-arm
          // at the end covers the lease expiry.
          model = "lease_held";
          detail = `model lease held until ${claim.leaseExpiresAt}`;
          break;
        case "backoff":
          model = "backoff";
          detail = `model retry backoff until ${claim.nextAttemptAt}`;
          break;
        case "nothing_scheduled":
          model = "not_scheduled";
          detail = `driver ${claim.phase}`;
          break;
      }
    }

    if (dispatched === "none") {
      const projected = await this.#projectOneDueJob(now);
      if (projected !== null) {
        dispatched = "projection";
        detail = `${detail}; ${projected}`;
      }
    }

    // Last, and never inside a catch: if this throws, the alarm rejects and the
    // platform retries, which is exactly what a run whose scheduling failed
    // needs. Swallowing it would leave durable work with nothing coming for it.
    await this.#armAlarm();
    return { dispatched, model, nextAlarmAt: await this.ctx.storage.getAlarm(), detail };
  }

  /**
   * Run one claimed attempt and commit whatever it reports.
   *
   * The continuation's own failures are CAUGHT: a provider outage or a thrown
   * capability is ordinary work failure, and letting it reject the alarm would
   * burn the platform's six retries invisibly, with no persisted error and no
   * explicit schedule. The finalize that follows is NOT caught — that is the
   * recovery state write, and if it fails the only honest thing is to let the
   * platform retry the whole delivery.
   */
  async #runContinuation(claim: ClaimSnapshot, now: number): Promise<string> {
    const ports = this.#resolvePorts();
    // Built per claimed attempt, from THIS object's state and bindings. Nothing
    // is cached across claims: a continuation holds a claim fence, and a reused
    // instance would be holding a fence that has since been superseded.
    const continuation = ports.continuation?.(this.ctx, this.env) ?? null;
    if (!continuation) return "no continuation wired";

    // A claimed generation is visibly working, whatever the run said before.
    await this.#applyPublicStatus("live");

    const state = readState(this.ctx.storage);
    const deadlineAt = now + ports.limits.continuationTotalMs;
    let outcome: ContinuationOutcome;
    try {
      outcome = await this.#withDeadline(
        continuation.run({ ...claim, runId: state?.runId ?? "", deadlineAt }),
        deadlineAt,
      );
    } catch (error) {
      outcome = crashOutcome(error);
    }

    // A `completed` that consumed none of the input it was claimed to answer
    // would be continued by the session and re-armed at once — the same lap,
    // forever. Bounded here, through the ordinary retry budget, rather than
    // left to the step ceiling and spend caps that arrive two tasks later.
    if (outcome.outcome === "completed") {
      const current = readGeneration(this.ctx.storage, claim.generationId);
      if (continuationMadeNoProgress(claim, current?.includedThroughSeq ?? claim.includedThroughSeq)) {
        outcome = noProgressOutcome();
      }
    }

    const request = toFinalizeRequest(outcome, claim, ports.limits);
    const finalize = finalizeGeneration(
      this.ctx.storage,
      claim.fence,
      request.kind === "retry"
        ? { ...request, retryAfterMs: driverRetryBackoffMs(claim.attempt) }
        : request,
      this.#now(),
    );
    await this.#applyFinalizeStatus(finalize);
    return `${outcome.outcome} -> ${finalize.outcome}`;
  }

  /**
   * The wall-time budget, enforced by the driver rather than trusted to the
   * port. A continuation that overruns is abandoned, not cancelled: it keeps
   * whatever it was doing, but the finalize below moves the driver out of
   * `running`, so the claim fence refuses every write it attempts afterwards.
   */
  async #withDeadline(
    work: Promise<ContinuationOutcome>,
    deadlineAt: number,
  ): Promise<ContinuationOutcome> {
    const remaining = deadlineAt - this.#now();
    if (remaining <= 0) return deadlineOutcome();

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<ContinuationOutcome>((resolve) => {
          timer = setTimeout(() => resolve(deadlineOutcome()), remaining);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * The public status, which the session layer deliberately does not touch.
   *
   * This is the seam Task 2 left open on purpose: `finalizeGeneration` moves the
   * PRIVATE driver phase and stops. Without this mapping a settled run stays
   * `live` on the dashboard forever.
   *
   * `done` is never set here. There is still no notion of a conversation being
   * finished — only of having nothing scheduled. `awaiting_approval` IS set
   * here now, and only here: it is Phase 11's approval gate, and it is reached
   * exclusively from a settle whose finalize latched a pause.
   */
  async #applyFinalizeStatus(finalize: FinalizeOutcome): Promise<void> {
    switch (finalize.outcome) {
      case "settled":
        // The approval gate. A settle that latched a pause is `idle` on the
        // DRIVER — there is nothing scheduled and nothing to reclaim, and the
        // run wakes only through `appendTurn({source:"approval"})` — but it is
        // `awaiting_approval` to everyone looking at it. The session layer
        // committed the pause; deciding what the customer-visible state becomes
        // is this method's job, exactly as it is for every other phase.
        if (finalize.pausedApprovalId !== undefined) {
          await this.#applyPublicStatus("awaiting_approval");
          return;
        }
        // Three phases, not two. A terminal failure that stranded input the dead
        // generation never read allocates a successor in the same transaction
        // (`UNSEEN_INPUT_WAKE_CODES`), and the public status follows the DRIVER,
        // not the generation: the run has work scheduled, so it is `live`.
        // Reporting `failed` here would flash a failure the customer's own
        // message has already resumed, and the re-arm below would then contradict
        // it by firing anyway.
        await this.#applyPublicStatus(FINALIZED_STATUS[finalize.driverPhase]);
        return;
      case "continued":
      case "rescheduled":
        // Still working, or about to be. Stay live.
        await this.#applyPublicStatus("live");
        return;
      case "already_settled":
      case "stale_claim":
        // Somebody else owns the outcome. Touching the public status from here
        // would let a superseded attempt overwrite the current one's answer.
        return;
    }
  }

  async #applyPublicStatus(status: RunStatus): Promise<void> {
    const current = readState(this.ctx.storage)?.status;
    if (current === undefined || current === status) return;
    await this.setStatus(status);
  }

  /**
   * Claim and deliver exactly one due projection job.
   *
   * `run_index` is handled by this object's own coalescing drain rather than a
   * port, because it needs `env.DB` and because collapsing a long backlog into
   * one write is the behaviour that keeps a D1 outage cheap. Everything else
   * goes through its installed runner.
   *
   * Returns null when nothing was due.
   */
  async #projectOneDueJob(now: number): Promise<string | null> {
    const runIndexDue = nextProjectionDueAt(this.ctx.storage, ["run_index"]);
    if (runIndexDue !== null && runIndexDue <= now) {
      const flush = await this.#drainRunIndex();
      return `run_index projected=${flush.projected} failed=${flush.failed}`;
    }

    const ports = this.#resolvePorts();
    const kinds = this.#projectionKinds().filter((kind) => kind !== "run_index");
    if (kinds.length === 0) return null;

    const claim = claimProjectionJob(this.ctx.storage, {
      kinds,
      now,
      leaseMs: PROJECTION_LEASE_MS,
    });
    if (claim.outcome !== "claimed") return null;

    // Built per claimed job, from THIS object's ctx and bindings — the same
    // reason the continuation is a factory. A projection runner reads the
    // frozen episode or the billed step row out of this object's own storage.
    const runner = ports.projections[claim.job.kind]?.(this.ctx, this.env);
    if (!runner) {
      // The runner disappeared between the due-time scan and the claim. Put the
      // job back rather than completing work nobody did.
      retryProjectionJob(this.ctx.storage, {
        id: claim.job.id,
        claimToken: claim.claimToken,
        backoffMs: projectionRetryBackoffMs(claim.job.attempts),
        error: "no runner installed for this kind",
        now: this.#now(),
      });
      return `${claim.job.kind} has no runner`;
    }

    const job: ClaimedProjectionJob = {
      job: claim.job,
      claimToken: claim.claimToken,
      runId: readState(this.ctx.storage)?.runId ?? "",
    };

    let outcome;
    try {
      outcome = await runner.run(job);
    } catch (error) {
      outcome = {
        outcome: "retry" as const,
        error: safeErrorText(error, "projection runner threw"),
      };
    }

    if (outcome.outcome === "delivered" || outcome.outcome === "dropped") {
      completeProjectionJob(this.ctx.storage, {
        id: claim.job.id,
        claimToken: claim.claimToken,
        now: this.#now(),
      });
    } else {
      retryProjectionJob(this.ctx.storage, {
        id: claim.job.id,
        claimToken: claim.claimToken,
        backoffMs: outcome.backoffMs ?? projectionRetryBackoffMs(claim.job.attempts),
        error: outcome.error,
        now: this.#now(),
      });
    }
    return `${claim.job.kind} ${outcome.outcome}`;
  }

  /**
   * Start a drain if one is not already running, and do not await it.
   *
   * `ctx.waitUntil` keeps the object alive for the write without holding up the
   * caller. If it fails or is cut short, the job row is still pending and the
   * alarm-driven projector (Task 3) picks it up — the durable job, not this
   * best-effort kick, is what guarantees delivery.
   */
  #projection: Promise<ProjectionFlush> | null = null;

  #kickProjection(): void {
    if (this.#projection) return;
    const drain = this.#drainRunIndex().finally(() => {
      this.#projection = null;
    });
    this.#projection = drain;
    this.ctx.waitUntil(drain);
  }

  /**
   * Deliver pending run-index revisions to D1.
   *
   * Exposed because the alarm will own it in Task 3, and because a caller that
   * genuinely needs the index to be current (a test, an operator endpoint) must
   * have a way to wait for it that is not "sleep and hope".
   */
  async flushProjections(): Promise<ProjectionFlush> {
    const inFlight = this.#projection;
    if (inFlight) await inFlight;
    return this.#drainRunIndex();
  }

  async #drainRunIndex(): Promise<ProjectionFlush> {
    const state = readState(this.ctx.storage);
    if (!state) return { projected: 0, failed: 0, pending: 0 };

    let projected = 0;
    let failed = 0;

    for (let pass = 0; pass < PROJECTION_DRAIN_MAX; pass += 1) {
      // Older pending revisions are superseded by the newest pending one, so a
      // long outage drains in one write instead of hundreds. Claimed jobs are
      // left alone: they are somebody's in-flight work.
      coalesceSupersededRunIndexJobs(this.ctx.storage);

      const claim = claimProjectionJob(this.ctx.storage, {
        kind: "run_index",
        leaseMs: PROJECTION_LEASE_MS,
      });
      if (claim.outcome !== "claimed") break;

      const revision = Number(claim.job.sourceId);
      const snapshot = Number.isInteger(revision)
        ? readRunIndexRevision(this.ctx.storage, revision)
        : null;
      if (!snapshot) {
        completeProjectionJob(this.ctx.storage, {
          id: claim.job.id,
          claimToken: claim.claimToken,
        });
        continue;
      }

      try {
        await projectRunIndex(this.env.DB, state.runId, snapshot.revision, snapshot);
        completeProjectionJob(this.ctx.storage, {
          id: claim.job.id,
          claimToken: claim.claimToken,
        });
        projected += 1;
      } catch (error) {
        retryProjectionJob(this.ctx.storage, {
          id: claim.job.id,
          claimToken: claim.claimToken,
          // Exponential and capped, so a long D1 outage backs off instead of
          // re-arming the alarm every fifteen seconds for an hour.
          backoffMs: projectionRetryBackoffMs(claim.job.attempts),
          error: safeErrorText(error, "run index projection failed"),
          now: this.#now(),
        });
        failed += 1;
        break;
      }
    }

    return {
      projected,
      failed,
      pending: countPendingProjectionJobs(this.ctx.storage, "run_index"),
    };
  }

  /**
   * `ctx.getWebSockets()` is the recoverable source of connected clients after
   * hibernation. An in-memory Map would be empty after eviction, and the
   * failure would be invisible to any test that never evicts.
   */
  #broadcast(event: RunEvent): void {
    broadcastEvent(this.ctx, event);
  }
}
