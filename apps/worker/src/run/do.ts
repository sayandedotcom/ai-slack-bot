import { DurableObject } from "cloudflare:workers";
import type { Env } from "../index";
import type {
  RunEvent,
  RunServerMessage,
  RunStatus,
  RunTurnInput,
  ToolCallUpdateInput,
} from "./protocol";
import { parseClientMessage } from "./protocol";
import { setRunStatus, touchRun } from "./repository";
import {
  appendToolCallUpdate,
  appendTurn,
  ensureSchema,
  initializeSession,
  latestSeq,
  listEvents,
  listToolCalls,
  listTurns,
  readState,
  setStatus,
  setSummary,
  snapshot,
  type AppendResult,
  type RunDescriptor,
  type RunState,
  type SessionSnapshot,
  type StatusResult,
} from "./session";

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
      return event.update.createdAt;
    case "status":
      return event.createdAt;
  }
}

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
      // Steering a parked or finished run resumes it. Every status reaches
      // `live` legally, so this needs no special-casing per source status.
      const current = readState(this.ctx.storage)?.status;
      if (current && current !== "live") await this.setStatus("live");

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

  turns(limit?: number) {
    return listTurns(this.ctx.storage, limit);
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

    // Synchronous section ends here. Broadcast before the first await.
    if (result.event) this.#broadcast(result.event);

    const state = readState(this.ctx.storage);
    if (state) await setRunStatus(this.env.DB, state.runId, result.status);
    return { ok: true, changed: result.changed, status: result.status, event: result.event };
  }

  async setSummary(summary: string): Promise<void> {
    setSummary(this.ctx.storage, summary);
    const state = readState(this.ctx.storage);
    if (state) await touchRun(this.env.DB, state.runId, Date.now());
  }

  /**
   * Runs in the same continuation as the commit that produced `result`, then
   * does its I/O. The order is load-bearing:
   *
   *   transactionSync (durable) -> broadcast (ordered) -> await D1 (index)
   *
   * Broadcasting AFTER the awaited D1 write would let two concurrent appends
   * deliver out of order. The skip rule in `#broadcast` would then drop the
   * lower seq permanently, because a skipped event is never retried and the
   * client's next reconnect asks for the higher cursor it already recorded.
   */
  async #afterCommit(result: AppendResult): Promise<AppendResult> {
    if (result.appended) this.#broadcast(result.event);

    // Touched even on a retry that appended nothing: the first attempt may have
    // committed the event and then failed before repairing the index. touchRun
    // never moves updated_at backwards, so replaying an old event is a no-op.
    const state = readState(this.ctx.storage);
    if (state) await touchRun(this.env.DB, state.runId, eventCreatedAt(result.event));
    return result;
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
