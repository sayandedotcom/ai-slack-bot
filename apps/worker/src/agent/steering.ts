import { checkClaim, hasPendingInput, readDriver, readGeneration } from "../run/session";
import { staleGeneration } from "../codemode/bindings/shared";
import type { AgentExecutionGuard } from "../codemode/contracts";
import type { ClaimFence } from "./contracts";

/**
 * Mid-flight steering: the freshness guard, and the abort that is only ever an
 * optimization.
 *
 * The property this file is responsible for is the one the product is sold on:
 * a human types a correction while the agent is working and the agent picks it
 * up rather than dropping it. Two mechanisms, and only one of them is
 * correctness:
 *
 *  - `generationFreshnessGuard` reads DURABLE state — the generation's
 *    `included_through_seq`, the driver's `pending_through_seq`, and the claim
 *    epoch — immediately before every outer `run_code` call and before every
 *    host capability body (invariant 15). Nothing here is cached, nothing is
 *    captured at invocation start, and nothing lives in a field that eviction
 *    could take away;
 *  - the abort registry below is BEST EFFORT and holds no correctness state at
 *    all. It exists so a steer typed while the final answer is streaming does
 *    not have to wait for that answer to finish. If the object is evicted, if
 *    the controller was never registered, or if the abort loses the race, the
 *    durable cursors and `finalizeAnswer`'s atomic compare still supersede the
 *    stale final and continue the same generation.
 */

/* ------------------------------------------------------------ freshness -- */

/**
 * The real invariant-15 guard: is the work about to happen still the work the
 * run wants?
 *
 * Three durable reads, all synchronous SQLite against this object's own
 * storage, all performed AT CALL TIME rather than remembered:
 *
 *  1. the generation still exists;
 *  2. this claim still owns the run (`phase = 'running'` at this claim epoch),
 *     so an attempt whose lease was reclaimed cannot keep acting;
 *  3. no trusted input sits above the generation's included cursor.
 *
 * (3) is the steering check. `pending_through_seq` is advanced inside the same
 * synchronous transaction that commits a steering turn, and
 * `included_through_seq` only moves when `appendInputMessages` actually puts
 * that input in the model's transcript — so `pending > included` means, exactly,
 * "a trusted turn exists that the model has not seen yet". Refusing here turns
 * that into a safe `stale_generation` tool result the next step can read,
 * instead of an external write nobody asked for any more.
 *
 * THE HONEST LIMIT, stated where the code is rather than in a document: this
 * minimizes but cannot eliminate the race. The check happens immediately before
 * the capability body, and the capability body then makes a network call. A
 * steer that commits after the check and before the upstream request has no way
 * to recall that request — it is already gone. What the run does then is
 * reconcile: the effect stays in the audit/effect ledger, and the next model
 * step is handed BOTH the action's result and the steering. No guard placement
 * can do better than this without a distributed transaction across a vendor we
 * do not control, and pretending otherwise would be the more dangerous lie.
 */
export function generationFreshnessGuard(
  storage: DurableObjectStorage,
  fence: ClaimFence,
): AgentExecutionGuard {
  return {
    async assertFresh() {
      const generation = readGeneration(storage, fence.generationId);
      if (!generation) throw staleGeneration();
      if (checkClaim(storage, fence).outcome !== "current") throw staleGeneration();
      if (readDriver(storage).pendingThroughSeq > generation.includedThroughSeq) {
        throw staleGeneration();
      }
    },
  };
}

/**
 * Both guards, in order, first refusal wins.
 *
 * The durable guard is NOT something a caller can opt out of: `makeAgentContinuation`
 * always composes it, and the required `guard` option is an ADDITIONAL check on
 * top. That is deliberate — invariant 15 stops being a wiring decision somebody
 * could forget and becomes a structural property of the composition.
 */
export function bothFresh(
  first: AgentExecutionGuard,
  second: AgentExecutionGuard,
): AgentExecutionGuard {
  return {
    async assertFresh() {
      await first.assertFresh();
      await second.assertFresh();
    },
  };
}

/* ---------------------------------------------------------------- abort -- */

/**
 * The in-memory abort registry, keyed by the object's own storage handle.
 *
 * A `WeakMap` keyed on `DurableObjectStorage` rather than a field on either side
 * because the two halves live in different files and neither owns the other:
 * `RunDO.appendTurn` has `ctx.storage` and the loop has `deps.storage`, and they
 * are the same object for the same run. It is weak so an evicted object's entry
 * cannot keep it alive.
 *
 * NOTHING durable is derived from this map. It is legal for it to be empty at
 * any moment — after eviction it always is.
 */
const ACTIVE_ABORTS = new WeakMap<DurableObjectStorage, AbortController>();

/**
 * Offer this invocation's controller for abort, for as long as aborting it is
 * CHEAPER than letting it finish.
 *
 * The loop arms this only while the provider is streaming visible text and no
 * tool call has been issued in the current step — the phase where every further
 * token is prose that a steer would supersede anyway. It is deliberately NOT
 * armed while the model is thinking, while a tool is executing, or between
 * steps: input arriving there is absorbed by the next `prepareStep` with the
 * step's tokens and its tool result intact, which is strictly better than
 * throwing away a billed step and re-sending the whole prompt.
 */
export function armSteeringAbort(
  storage: DurableObjectStorage,
  controller: AbortController,
): void {
  ACTIVE_ABORTS.set(storage, controller);
}

/** Withdraw the offer. Idempotent, and never removes a newer claimant's entry. */
export function disarmSteeringAbort(
  storage: DurableObjectStorage,
  controller: AbortController,
): void {
  if (ACTIVE_ABORTS.get(storage) === controller) ACTIVE_ABORTS.delete(storage);
}

/**
 * Cut a provider invocation short because newer input is already durable.
 *
 * Called AFTER the input transaction commits, never before: an abort that
 * preceded the commit could stop the current answer for a steer that then
 * failed to persist, which is the one ordering that can actually lose a turn.
 *
 * Returns whether anything was aborted, for tests and for the caller's own
 * observability. A `false` is not a failure — it is the ordinary state of a run
 * whose object was evicted, whose model is between steps, or which is not
 * currently talking to a provider at all.
 */
export function abortForNewerInput(storage: DurableObjectStorage): boolean {
  const controller = ACTIVE_ABORTS.get(storage);
  if (!controller || controller.signal.aborted) return false;
  ACTIVE_ABORTS.delete(storage);
  controller.abort(new SteeringAbort());
  return true;
}

/** The reason an abort carries, so the loop can tell steering from a crash. */
export class SteeringAbort extends Error {
  constructor() {
    super("aborted because newer input arrived");
    this.name = "SteeringAbort";
  }
}

/**
 * What an aborted provider stream MEANS, decided from durable state.
 *
 * Never from the abort reason: the reason is in-memory, an eviction loses it,
 * and a run whose answer was cut short must reach the same conclusion either
 * way. The cursors are the authority — if trusted input sits above what THIS
 * generation has already put in front of the model, the abort was steering and
 * the same generation continues; if there is none, somebody cancelled a run
 * that had nothing new to say, and that is a visible outcome rather than a
 * silent retry that would immediately re-bill the same question.
 *
 * The comparison is `pending_through_seq` against the GENERATION's
 * `included_through_seq`, exactly as `finalizeAnswer` and the freshness guard
 * do it. The driver's settled watermark is the wrong cursor here and gets the
 * answer backwards: it does not move until a generation settles, so during any
 * in-flight answer it always reads as "input pending" — including for the
 * opening message this very attempt is busy answering.
 */
export function abortMeansContinuation(
  storage: DurableObjectStorage,
  generationId: string,
): boolean {
  const generation = readGeneration(storage, generationId);
  if (!generation) return hasPendingInput(storage);
  return readDriver(storage).pendingThroughSeq > generation.includedThroughSeq;
}
