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
import { projectRunIndex } from "./repository";
import {
  appendAssistantUpdate,
  appendToolCallUpdate,
  appendTurn,
  claimProjectionJob,
  coalesceSupersededRunIndexJobs,
  completeProjectionJob,
  countPendingProjectionJobs,
  ensureSchema,
  initializeSession,
  latestSeq,
  listEvents,
  listRecentTurns,
  listToolCalls,
  listTurns,
  listTurnsAfter,
  readDriver,
  readRunIndexRevision,
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
  DriverState,
} from "../agent/contracts";

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

/** How many revisions one drain pass will carry before yielding. */
const PROJECTION_DRAIN_MAX = 8;
const PROJECTION_LEASE_MS = 30_000;
const PROJECTION_BACKOFF_MS = 15_000;

export type ProjectionFlush = { projected: number; failed: number; pending: number };

export class RunDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Synchronous only. This runs again on every wake, so it must be cheap and
    // must not await.
    ensureSchema(ctx.storage);

    // Answered by the runtime without waking a hibernating object, so the UI
    // can hold a liveness check that costs nothing. setWebSocketAutoResponse is
    // the method; WebSocketRequestResponsePair is only the payload.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
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
    return this.#afterCommit(result);
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
    this.#kickProjection();
    return result;
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
          backoffMs: PROJECTION_BACKOFF_MS,
          error: error instanceof Error ? error.message : "run index projection failed",
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
    const frame = JSON.stringify({ type: "event", event });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        const attachment = socket.deserializeAttachment() as { lastSeq?: number } | null;
        const lastSeq = attachment?.lastSeq ?? 0;
        if (lastSeq >= event.seq) continue;

        socket.send(frame);
        socket.serializeAttachment({ ...(attachment ?? {}), lastSeq: event.seq });
      } catch {
        // One broken socket must not fail the mutation for every other client.
      }
    }
  }
}
