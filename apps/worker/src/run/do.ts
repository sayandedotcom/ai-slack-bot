import { DurableObject } from "cloudflare:workers";
import type { Env } from "../index";
import type {
  RunEvent,
  RunStatus,
  RunTurnInput,
  ToolCallUpdateInput,
} from "./protocol";
import { setRunStatus, touchRun } from "./repository";
import {
  appendToolCallUpdate,
  appendTurn,
  ensureSchema,
  initializeSession,
  latestSeq,
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
