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
import { projectRunIndex } from "./repository";
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
  ClaimSnapshot,
  DriverState,
  FinalizeOutcome,
  ProjectionJobKind,
} from "../agent/contracts";
import { abortForNewerInput } from "../agent/steering";
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

/** How many revisions one drain pass will carry before yielding. */
const PROJECTION_DRAIN_MAX = 8;

export type ProjectionFlush = { projected: number; failed: number; pending: number };

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
      await this.#armAlarm();
    });
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
    for (const kind of ["d1_usage", "memory_outbox"] as const) {
      if (ports.projections[kind]) kinds.push(kind);
    }
    return kinds;
  }

  #plannedAlarmAt(now: number): number | null {
    const ports = this.#resolvePorts();
    return nextAlarmAt({
      driver: readDriver(this.ctx.storage),
      projectionDueAt: nextProjectionDueAt(this.ctx.storage, this.#projectionKinds()),
      modelEnabled: ports.continuation !== null,
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
   * `done` is never set here. Phase 10 has no notion of a conversation being
   * finished — only of having nothing scheduled — and `awaiting_approval` stays
   * reserved for Phase 11's approval gate.
   */
  async #applyFinalizeStatus(finalize: FinalizeOutcome): Promise<void> {
    switch (finalize.outcome) {
      case "settled":
        await this.#applyPublicStatus(finalize.driverPhase === "idle" ? "idle" : "failed");
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

    const runner = ports.projections[claim.job.kind];
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
