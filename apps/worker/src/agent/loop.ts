import {
  InvalidToolInputError,
  NoSuchToolError,
  streamText,
  type ModelMessage,
  type TextStreamPart,
  type Tool,
  type ToolExecutionOptions,
} from "ai";
import type { Env } from "../index";
import type {
  AssistantUpdateInput,
  RunEvent,
  ToolCallUpdateInput,
} from "../run/protocol";
import { broadcastEvent } from "../run/broadcast";
import {
  appendAgentToolCallUpdate,
  appendAssistantUpdate,
  appendInputMessages,
  checkpointStepMessages,
  finalizeAnswer,
  heartbeat,
  listPendingInputTurns,
  readGeneration,
  readModelTranscript,
  readState,
  recordStepUsage,
  totalCostNanoUsd,
  turnEventSeq,
  type FinalizeAnswerInput,
  type FinalizeAnswerOutcome,
  type RunState,
} from "../run/session";
import type {
  AssistantUpdateOutcome,
  ClaimFence,
  FencedAppendOutcome,
} from "./contracts";
import { auditSinkFactory, outerToolMapper, type ToolUpdateWriter } from "./audit";
import {
  costNanoUsd,
  evaluateSpendGuard,
  normalizeSdkUsage,
  UnknownModelPriceError,
} from "./cost";
import type { AgentContinuation, ClaimedGeneration, ContinuationOutcome } from "./driver";
import { DEFAULT_AGENT_LIMITS, type AgentLimits } from "./limits";
import {
  classifyStepOutcome,
  modelCallOptions,
  ModelCompositionError,
  REFUSAL_GENERATION_STATE,
  REFUSAL_RESUME_POLICY,
  type ModelFactory,
  type ModelHandle,
} from "./model";
import {
  ANTHROPIC_PROVIDER_OPTIONS,
  buildAgentPrompt,
  resolveTrustedContext,
  toInputModelMessage,
  type TrustedContext,
} from "./prompt";
import {
  dropUnresolvedTailCalls,
  normalizeResponseMessages,
  selectModelHistory,
  OUTER_TOOL_NAME,
  type ResponseMessage,
  type TranscriptMessage,
} from "./transcript";
import { AssistantStream, systemClock, type StreamClock } from "./stream";
import {
  abortMeansContinuation,
  armSteeringAbort,
  bothFresh,
  disarmSteeringAbort,
  generationFreshnessGuard,
  SteeringAbort,
} from "./steering";
import { makeApprovalPort } from "../approval/port";
import { makeAgentTools, type CapabilityDependencyFactory } from "./dependencies";
import { makeProvenanceSink } from "./memory";
import type { AgentExecutionGuard } from "../codemode/contracts";
import type { CodeModeOutput } from "../codemode/tool";

/**
 * ONE streamed model/tool continuation.
 *
 * This is the file where Phase 10 stops being modules and becomes a loop:
 * durable transcript in, `streamText` with exactly one tool, batched assistant
 * events out, a step checkpoint per completed step, and one atomic
 * finalization. It is deliberately GENERIC — there is no ticket type here, no
 * surface handler, and no branch on what the customer asked (invariant 3).
 * `origin` appears exactly once, to LABEL the final turn as internal narration
 * for Slack, which is presentation context and not a pipeline (invariant 4).
 *
 * THE AUTHORITY BOUNDARY, stated once because it is the security property this
 * file is responsible for: every byte of conversational input reaches the model
 * through `toInputModelMessage`, which forces `role: "user"` regardless of what
 * the stored turn's role column says. That downgrade is not cosmetic — triage
 * openings written before the coordinator fix sit in durable tables claiming
 * `role: "system"`, and those runs are still live. There is no second path from
 * a turn to a `ModelMessage` in this file, and adding one would silently restore
 * system authority to customer-authored Slack text (invariant 23).
 */

/* ------------------------------------------------------------ the ports -- */

/**
 * Where the loop's REPLAYABLE output goes.
 *
 * A port rather than a `RunDO` import, for one concrete reason: every write here
 * must both commit locally and reach attached sockets, and only the object has
 * the sockets. Reads and non-event writes go straight to `storage`, because they
 * are synchronous session calls with no broadcast half.
 */
export interface RunEventPort {
  assistantUpdate(input: AssistantUpdateInput): Promise<AssistantUpdateOutcome>;
  toolUpdate(input: ToolCallUpdateInput): Promise<FencedAppendOutcome>;
  finalize(input: FinalizeAnswerInput): Promise<FinalizeAnswerOutcome>;
}

/**
 * The production port: commit, then broadcast, in that order and in the same
 * continuation.
 *
 * Broadcasting after an awaited D1 write is what lets two concurrent appends
 * deliver out of order, so nothing here awaits D1 at all — the run-index work is
 * already a durable local job by the time these return, and only the alarm
 * projector touches D1 (invariant 32).
 *
 * It deliberately does not re-arm the alarm. An assistant batch is not work to
 * schedule; the driver arms once the attempt finishes, and arming per batch
 * would be one storage write per flush for no scheduling benefit.
 */
export function makeRunEventPort(ctx: DurableObjectState, fence: ClaimFence): RunEventPort {
  const emit = (events: readonly RunEvent[]): void => {
    for (const event of events) broadcastEvent(ctx, event);
  };

  return {
    async assistantUpdate(input) {
      const outcome = appendAssistantUpdate(ctx.storage, fence, input);
      if (outcome.outcome === "appended") emit([outcome.event]);
      return outcome;
    },
    async toolUpdate(input) {
      const outcome = appendAgentToolCallUpdate(ctx.storage, fence, input);
      if (outcome.outcome === "appended") emit([outcome.event]);
      return outcome;
    },
    async finalize(input) {
      const outcome = finalizeAnswer(ctx.storage, fence, input);
      if (outcome.outcome !== "stale_claim") emit(outcome.events);
      return outcome;
    },
  };
}

/* --------------------------------------------------------- the outcomes -- */

/**
 * Every way one continuation can end, named.
 *
 * Explicit and exhaustive because the driver must not have to infer what
 * happened from state it is not allowed to re-read, and because each of these
 * settles differently: a refusal is not a crash, a step ceiling is not a spend
 * ceiling, and a superseded final is not a failure at all.
 */
export type ContinuationPath =
  | "completed"
  /**
   * The answer is durable AND this generation left an approval open, so the
   * run parks `awaiting_approval`. A distinct path from `completed` because
   * the driver has to report a different public status, not because anything
   * failed: the pause itself was already latched by `finalizeAnswer`, in the
   * same transaction as the final turn.
   */
  | "paused"
  /** A fresher input landed; the SAME generation continues (invariants 8, 14). */
  | "continuation_requested"
  /** A successor claimed the run mid-stream. This attempt writes nothing more. */
  | "aborted_stale_claim"
  /**
   * The provider stream was aborted with NO trusted input pending — an operator
   * or user cancellation rather than steering. Visible, not a silent retry.
   */
  | "run_cancelled"
  | "provider_refusal"
  | "provider_timeout"
  /** Unpaired tool calls, unusable history, or a response we refuse to store. */
  | "malformed_history"
  | "step_limit"
  | "cost_limit"
  /** Transient: the driver's bounded backoff and attempt ceiling apply. */
  | "infrastructure_retry"
  /** Not transient: retrying cannot fix a missing price, key, or gateway. */
  | "infrastructure_exhausted";

export type ContinuationResult = {
  path: ContinuationPath;
  /** Safe, host-authored code. Never provider prose and never a stack. */
  errorCode: string | null;
  detail?: string;
  /** Present only on `completed` and `paused`. */
  finalTurnId?: string;
  /** Present only on `paused`: the approval the run is parked on. */
  pausedApprovalId?: string;
};

/**
 * Map a typed path onto what the driver commits.
 *
 * `continuation_requested` and `aborted_stale_claim` both report `completed`,
 * which is not a shrug: `finalizeGeneration` re-reads the cursors itself and
 * turns a generation with pending input into `continued`, and a stale claimant's
 * finalize is refused by the fence. Reporting `retry` for either would spend a
 * crash retry on something that did not crash.
 */
export function toContinuationOutcome(result: ContinuationResult): ContinuationOutcome {
  switch (result.path) {
    case "completed":
    case "continuation_requested":
    case "aborted_stale_claim":
      return { outcome: "completed" };
    case "paused":
      // The pause is already durable; this only tells the driver which public
      // status to apply. A `paused` path with no id would be a bug in
      // `finalize` below, and reporting `completed` is the safe direction —
      // the run stays idle rather than parking on an approval nobody named.
      return result.pausedApprovalId === undefined
        ? { outcome: "completed" }
        : { outcome: "paused", approvalId: result.pausedApprovalId };
    case "provider_refusal":
      return {
        outcome: "failed",
        state: REFUSAL_GENERATION_STATE,
        resumePolicy: REFUSAL_RESUME_POLICY,
        errorCode: result.errorCode ?? "provider_refusal",
        ...(result.detail === undefined ? {} : { errorMessage: result.detail }),
      };
    case "cost_limit":
      return {
        outcome: "failed",
        state: "budget_exhausted",
        // A spend ceiling is not something an ordinary follow-up message may
        // restart. Only an operator raising the cap can.
        resumePolicy: "requires_operator_config",
        errorCode: result.errorCode ?? "cost_limit",
        ...(result.detail === undefined ? {} : { errorMessage: result.detail }),
      };
    case "run_cancelled":
    case "step_limit":
    case "malformed_history":
      return {
        outcome: "failed",
        state: "failed",
        // A human steer allocates a new generation with a fresh step budget and
        // fresh evidence, which is the only thing that helps here.
        resumePolicy: "requires_input",
        errorCode: result.errorCode ?? result.path,
        ...(result.detail === undefined ? {} : { errorMessage: result.detail }),
      };
    case "infrastructure_exhausted":
      return {
        outcome: "failed",
        state: "failed",
        resumePolicy: "requires_operator_config",
        errorCode: result.errorCode ?? "infrastructure_failure",
        ...(result.detail === undefined ? {} : { errorMessage: result.detail }),
      };
    case "provider_timeout":
    case "infrastructure_retry":
      return {
        outcome: "retry",
        errorCode: result.errorCode ?? result.path,
        ...(result.detail === undefined ? {} : { errorMessage: result.detail }),
      };
  }
}

/** Thrown to unwind out of a callback with a decided outcome, never to a caller. */
class ContinuationStop extends Error {
  readonly result: ContinuationResult;

  constructor(result: ContinuationResult) {
    super(result.errorCode ?? result.path);
    this.name = "ContinuationStop";
    this.result = result;
  }
}

/* ----------------------------------------------------------- the inputs -- */

export type ContinuationDeps = {
  /** The object's own SQLite. Reads and non-event writes go straight here. */
  storage: DurableObjectStorage;
  events: RunEventPort;
  /** The one tool the model may see (invariant 5). */
  tools: { run_code: Tool<{ code: string }, CodeModeOutput> };
  model: ModelHandle;
  /** Resolved from D1 and `run_state`; never from anything anybody typed. */
  context: TrustedContext;
  limits?: AgentLimits;
  clock?: StreamClock;
  /**
   * An OUTER signal to fold into this invocation's own steering controller.
   *
   * Chained rather than passed through, so there is exactly one signal reaching
   * `streamText` and exactly one place that decides what an abort meant. What
   * it meant is always read from the durable cursors (see `steering.ts`), never
   * from whichever signal fired.
   */
  abortSignal?: AbortSignal;
  /** Bounds for the model history read. Tests inject smaller ones. */
  historyBounds?: { maxMessages: number; maxBytes: number };
  /** Batching thresholds. Tests inject smaller ones. */
  flush?: { chars?: number; ms?: number };
};

const DEFAULT_HISTORY_BOUNDS = { maxMessages: 200, maxBytes: 400_000 };

/** The dashboard's one-line description of a settled generation. */
const SUMMARY_MAX_CHARS = 160;

/* ------------------------------------------------------------- the loop -- */

export async function runContinuation(
  claim: ClaimedGeneration,
  deps: ContinuationDeps,
): Promise<ContinuationResult> {
  const limits = deps.limits ?? DEFAULT_AGENT_LIMITS;
  const clock = deps.clock ?? systemClock;
  const bounds = deps.historyBounds ?? DEFAULT_HISTORY_BOUNDS;
  const { storage, events, context } = deps;
  const fence = claim.fence;

  const stream = new AssistantStream({
    fence,
    attempt: claim.attempt,
    sink: (input) => events.assistantUpdate(input),
    clock,
    ...(deps.flush?.chars === undefined ? {} : { flushChars: deps.flush.chars }),
    ...(deps.flush?.ms === undefined ? {} : { flushMs: deps.flush.ms }),
  });

  // THE PREFLIGHT. `stepCountIs(n)` uses strict equality in the pinned SDK, so
  // `stopWhen: stepCountIs(0)` would never fire and the first call would be made
  // anyway — with money. The ceiling is therefore checked HERE, before the
  // provider exists, and `modelCallOptions` refuses a non-positive budget too.
  const remainingSteps = limits.maxStepsPerGeneration - claim.stepCount;
  if (remainingSteps <= 0) {
    await stream.terminate("failed", "step_limit");
    return {
      path: "step_limit",
      errorCode: "step_limit",
      detail: `generation has taken ${claim.stepCount} of ${limits.maxStepsPerGeneration} steps`,
    };
  }

  /** The terminal step's normalized response messages, for the atomic finalize. */
  let terminalResponseMessages: unknown[] = [];
  let terminalGlobalStep = claim.stepCount;
  let sawAnyStep = false;
  /**
   * Whether the LAST completed step issued a tool call.
   *
   * True here means the generation was cut off mid-investigation — `stopWhen`
   * fired on a step that asked for a tool rather than answering — and the honest
   * outcome is `step_limit`, not "the terminal step produced no text". The two
   * settle differently and only one of them tells an operator what happened.
   */
  let lastStepHadToolCalls = false;

  /**
   * The decided outcome, recorded BEFORE the throw that carries it.
   *
   * A throw out of `prepareStep` or `onStepEnd` does not reach this function's
   * caller: the pinned SDK catches callback errors and ends the generation
   * quietly, so a loop that relied on the exception alone would see a stream
   * that simply stopped and would report "the terminal step produced no text"
   * for a refusal it had already correctly diagnosed. Measured, not assumed —
   * `agent-loop.test.ts` covers both callbacks.
   */
  let stopped: ContinuationResult | null = null;

  /**
   * The best-effort abort for THIS provider invocation.
   *
   * Created per invocation and offered to `RunDO.appendTurn` only while the
   * provider is streaming visible text (see `steering.ts`). It carries no
   * correctness state: what an abort MEANT is decided below from the durable
   * cursors, never from this controller or its reason.
   */
  const steering = new AbortController();
  const external = deps.abortSignal;
  if (external !== undefined) {
    if (external.aborted) steering.abort(external.reason);
    else external.addEventListener("abort", () => steering.abort(external.reason), { once: true });
  }
  const abortControls = {
    arm: () => armSteeringAbort(storage, steering),
    disarm: () => disarmSteeringAbort(storage, steering),
    /**
     * An abort is a CONTINUATION when trusted input is pending — the same
     * generation carries on with the steer at its next `prepareStep` — and a
     * visible cancellation when nothing is pending. Read from durable state so
     * an evicted object reaches the same answer.
     *
     * FIRST, though: was it even ours? `streamText` is given both this signal
     * and the reviewed `timeout` policy, and when one of those timers fires the
     * SDK aborts its OWN combined signal and delivers an `abort` stream part
     * that is indistinguishable at this seam from a steer — except that this
     * controller was never touched. Steering (and the external signal, which is
     * forwarded into this same controller above) always leaves
     * `steering.signal.aborted` true, so an abort arriving with it false can
     * only be the provider step/first-chunk/inter-chunk/tool timeout. Reporting
     * that as `run_cancelled` told an operator a human cancelled a run that in
     * fact timed out, and made it terminal instead of a bounded retry.
     *
     * THE OTHER WAY IN, because the branch above is wider than the `abort`
     * stream part alone. The `catch` around the whole invocation also routes
     * here, through `isAbort`, and `isAbort` returns true on
     * `error.name === "AbortError"` EVEN WHEN THIS CONTROLLER WAS NEVER TOUCHED
     * — the deliberate fallback for the SDK re-wrapping a timeout's reason on
     * the way out. That is the correct mapping for a thrown timeout, and it is
     * why the two entry points share one answer. But it means the real
     * precondition is not "only a configured timeout aborts this stream", it is
     * "any `AbortError` reaching this loop with `steering.signal.aborted` false
     * is a configured timeout". Anything that later introduces a second abort
     * source into the `streamText` pipeline WITHOUT forwarding it into this
     * controller — a signal handed straight to a tool, a fetch aborted inside a
     * capability whose `AbortError` escapes — would be reported as a bounded
     * provider timeout and silently retried. Forward it into `steering` above,
     * or give it its own path here.
     */
    result: (): ContinuationResult => {
      if (!steering.signal.aborted) {
        return {
          path: "provider_timeout",
          errorCode: "provider_timeout",
          detail: "the provider stream was aborted by a configured timeout",
        };
      }
      return abortMeansContinuation(storage, claim.generationId)
        ? {
            path: "continuation_requested",
            errorCode: null,
            detail: "the provider stream was aborted because newer input arrived",
          }
        : {
            path: "run_cancelled",
            errorCode: "run_cancelled",
            detail: "the provider stream was aborted with no newer input pending",
          };
    },
  };

  // Explicitly annotated, because TypeScript only treats a call as
  // never-returning — and therefore narrows the code after it — when the callee
  // is a const with an explicit type annotation.
  const halt: (result: ContinuationResult) => never = (result) => {
    stopped ??= result;
    throw new ContinuationStop(result);
  };

  /**
   * The input checkpoint, run before EVERY provider step.
   *
   * Durable input is re-queried here rather than captured once at invocation
   * start. That is the whole point: a turn that commits between step 3 and step
   * 4 must be in step 4's request, and a loop holding an array from step 0
   * cannot see it (invariant 13). Task 8's steering barrier builds on this.
   */
  const prepareTurn = async (
    stepNumber: number,
  ): Promise<{ messages: ModelMessage[]; instructions: ReturnType<typeof buildAgentPrompt>["instructions"]; maxOutputTokens: number }> => {
    const globalStep = claim.stepCount + stepNumber;
    const generation = readGeneration(storage, claim.generationId);
    if (!generation) halt({ path: "aborted_stale_claim", errorCode: "generation_missing" });

    const pending = listPendingInputTurns(storage, generation!.includedThroughSeq);
    const inputs = pending.flatMap((turn) => {
      const seq = turnEventSeq(storage, turn.id);
      if (seq === null) return [];
      // The ONLY route from a stored turn to a model message. Always user role.
      return [{ sourceEventSeq: seq, message: toInputModelMessage(turn, seq) as unknown }];
    });

    if (inputs.length > 0) {
      const inserted = appendInputMessages(storage, fence, { globalStep, messages: inputs });
      if (inserted.outcome === "stale_claim") {
        halt({ path: "aborted_stale_claim", errorCode: "stale_claim" });
      }
    }

    const entries: TranscriptMessage[] = readModelTranscript(storage, bounds.maxMessages).map(
      (row) => ({
        ordinal: row.ordinal,
        generationId: row.generationId,
        message: row.message as ModelMessage,
      }),
    );
    const selection = selectModelHistory(entries, {
      maxMessages: bounds.maxMessages,
      maxBytes: bounds.maxBytes,
      protectedGenerationId: claim.generationId,
    });
    if (selection.outcome === "context_limit") {
      halt({
        path: "malformed_history",
        errorCode: `context_limit:${selection.reason}`,
        detail: selection.detail,
      });
    }

    // The obligation `selectModelHistory` reports rather than repairs. Anthropic
    // rejects a request whose last assistant block is an unanswered `tool_use`,
    // so the trailing call is DROPPED before sending — never answered with a
    // fabricated result, which the plan forbids outright.
    const repaired = dropUnresolvedTailCalls(
      selection.outcome === "selected" ? selection.messages : [],
      selection.outcome === "selected" ? selection.unresolvedTailCallIds : [],
    );
    if (repaired.messages.length === 0) {
      halt({
        path: "malformed_history",
        errorCode: "empty_history",
        detail: "no sendable model history survived the tail repair",
      });
    }

    const prompt = buildAgentPrompt({ context, messages: repaired.messages });

    // A step ceiling is not a spend ceiling (invariant 28). This is the one that
    // actually bounds money, and it runs before every billed call.
    const promptBytes = JSON.stringify(prompt.instructions).length
      + JSON.stringify(prompt.messages).length;
    const guard = evaluateSpendGuard({
      modelId: deps.model.modelId,
      generationSpentNanoUsd: generation!.costNanoUsd,
      runSpentNanoUsd: totalCostNanoUsd(storage),
      promptBytes,
      requestedMaxOutputTokens: limits.maxOutputTokensPerStep,
      gatewayAttempts: deps.model.gatewayAttempts,
      generationCapNanoUsd: limits.generationSpendCapNanoUsd,
      runCapNanoUsd: limits.runSpendCapNanoUsd,
    });
    if (guard.outcome === "cost_limit") {
      halt({
        path: "cost_limit",
        errorCode: `${guard.scope}_cost_limit`,
        detail: `${guard.reason}: ${guard.remainingNanoUsd} nano-USD left under the ${guard.scope} cap`,
      });
    }

    stream.beginStep();
    return {
      messages: prompt.messages,
      instructions: prompt.instructions,
      maxOutputTokens: guard.outcome === "ok" ? guard.maxOutputTokens : limits.maxOutputTokensPerStep,
    };
  };

  let result: ContinuationResult;
  try {
    const first = await prepareTurn(0);
    await stream.start();

    const stepStartedAt = { at: clock.now() };
    const generation = streamText({
      model: deps.model.model,
      // EXACTLY one tool. `makeAgentTools` is the one home for that fact; this
      // object is its own assertion that nothing else was added on the way.
      tools: deps.tools,
      instructions: first.instructions,
      messages: first.messages,
      maxOutputTokens: first.maxOutputTokens,
      providerOptions: ANTHROPIC_PROVIDER_OPTIONS,
      // No raw provider chunks. There is nothing this loop may do with one, and
      // an ignored stream of them is still a stream of them (invariant 18).
      includeRawChunks: false,
      abortSignal: steering.signal,
      ...modelCallOptions(limits, remainingSteps),

      prepareStep: async ({ stepNumber }) => {
        stepStartedAt.at = clock.now();
        if (stepNumber === 0) {
          return {
            instructions: first.instructions,
            messages: first.messages,
            maxOutputTokens: first.maxOutputTokens,
          };
        }
        const prepared = await prepareTurn(stepNumber);
        return {
          instructions: prepared.instructions,
          messages: prepared.messages,
          maxOutputTokens: prepared.maxOutputTokens,
        };
      },

      onStepEnd: async (step) => {
        sawAnyStep = true;
        const globalStep = claim.stepCount + step.stepNumber;
        terminalGlobalStep = globalStep;

        const outcome = classifyStepOutcome({
          finishReason: step.finishReason,
          rawFinishReason: step.rawFinishReason,
          emittedVisibleOutput: stream.emittedVisibleOutput,
        });

        // MONEY FIRST, and deliberately unfenced. If this attempt's claim has
        // already been taken over, the provider still billed for the call, and a
        // ledger that drops the row understates a ceiling enforced from it.
        const usage = normalizeSdkUsage(step.usage);
        let costNano = 0;
        try {
          costNano = costNanoUsd({
            modelId: deps.model.modelId,
            usage,
            cacheWriteTtl: "5m",
            billing: outcome.billing,
          }).totalNanoUsd;
        } catch (error) {
          if (!(error instanceof UnknownModelPriceError)) throw error;
          halt({
            path: "infrastructure_exhausted",
            errorCode: "unknown_model_price",
            detail: error.message,
          });
        }
        recordStepUsage(storage, {
          generationId: claim.generationId,
          agentTurnId: claim.agentTurnId,
          attempt: claim.attempt,
          globalStep,
          provider: deps.model.provider,
          model: deps.model.modelId,
          providerRequestId: step.response.id,
          gatewayLogId: step.response.headers?.["cf-aig-log-id"] ?? null,
          usage,
          costNanoUsd: costNano,
          latencyMs: Math.max(0, Math.round(clock.now() - stepStartedAt.at)),
          finishReason: step.finishReason,
          rawFinishReason: step.rawFinishReason ?? null,
          errorCode: outcome.errorCode,
        });

        const hadToolCalls = step.toolCalls.length > 0;
        lastStepHadToolCalls = hadToolCalls;
        await stream.endStep({
          hadToolCalls,
          ...(outcome.discardPartialDrafts ? { discardDrafts: true } : {}),
        });

        if (outcome.kind !== "ok") {
          halt({
            path: "provider_refusal",
            errorCode: outcome.errorCode ?? "provider_refusal",
            detail: `the provider stopped with ${step.finishReason}`,
          });
        }

        // Tool calls the SDK REFUSED BEFORE running them, because the MODEL's
        // own arguments were wrong.
        //
        // `ai@7.0.59` marks such a call `invalid: true` and hangs the deciding
        // error object off the `tool-call` part itself: `InvalidToolInputError`
        // when the arguments fail `run_code`'s strict schema (an over-long
        // program, a missing or extra property, a wrong type), `NoSuchToolError`
        // when the name is not registered. The paired `tool-error` part carries
        // only `String(error)`, which is why the discrimination reads the
        // `tool-call` part — the class is the precise signal, the stringified
        // message is not.
        //
        // This is NOT infrastructure. Nothing threw, no host call failed, the
        // tool never started. It is a model-authored malformation, and the
        // failure matrix's own row for a program the tool refuses is "failed
        // tool event, model may continue" — the error-as-value contract. So the
        // model is allowed to read the refusal and fix its own call, exactly as
        // it reads a `CodeModeOutput.error`, rather than the whole generation
        // being re-run on the identical history that produced the bad call.
        const refusedByValidation = new Set<string>();
        for (const part of step.content) {
          if (part.type !== "tool-call" || part.invalid !== true) continue;
          if (
            InvalidToolInputError.isInstance(part.error)
            || NoSuchToolError.isInstance(part.error)
          ) {
            refusedByValidation.add(part.toolCallId);
          }
        }

        // What the model reads back is HOST-AUTHORED, never the SDK's message.
        //
        // The SDK's own synthetic result is
        // `{ type: "error-text", value: "AI_InvalidToolInputError: … Type
        // validation failed: Value: <the entire submitted program> … <zod
        // issues>" }`. Storing that reopens the disclosure half of the defect
        // this guard was added for — the same reason `codemode/tool.ts:4-16`
        // refuses `@cloudflare/codemode/ai`'s validator, whose issue text echoes
        // submitted values back — and it doubles the transcript with a copy of
        // the program that is already in the assistant message beside it.
        //
        // The replacement is `error-json`, so `@ai-sdk/anthropic` sends it with
        // `is_error: true`, and its value is a `CodeModeOutput` whose `result`
        // is null and whose `error` is in the tool's documented `code: message`
        // wire format. Nothing about it can be mistaken for a successful run.
        const responseMessages =
          refusedByValidation.size === 0
            ? step.response.messages
            : replaceRefusedToolOutputs(step.response.messages, refusedByValidation);

        // Strict allowlist. Readable reasoning, a provider-executed call, an
        // unknown tool name or an unstorable output all fail the step SAFELY
        // rather than being written into durable history (invariants 16-18).
        //
        // Still ahead of everything below, and that is what keeps the unknown
        // tool NAME settling `malformed_response:unsupported_tool` even though
        // the block above also recognises it: replacing that call's output does
        // not make `escalate` a tool this build offers, and the allowlist
        // rejects on the name before any of it is checkpointed.
        const normalized = normalizeResponseMessages(responseMessages);
        if (normalized.outcome === "rejected") {
          halt({
            path: "malformed_history",
            errorCode: `malformed_response:${normalized.reason}`,
            detail: normalized.detail,
          });
        }

        // A tool whose `execute` THREW rather than returning a value.
        //
        // `run_code` turns every failure it can express into a `CodeModeOutput`
        // carrying an `error` string — the error-as-value contract the model is
        // told to read and act on. A THROW therefore means the failure happened
        // somewhere the tool cannot speak for: the host prologue that builds the
        // execution before either of the tool's own `try` blocks
        // (`codemode/tool.ts` — the outer call id, the audit sink, the execution
        // record), or the SDK refusing the call outright.
        //
        // The SDK answers a throw with a SYNTHETIC tool result whose output is
        // `{ type: "error-text", value: <the raw thrown message> }`, and
        // `normalizeResponseMessages` above stores that shape happily — it is a
        // legal `ToolResultOutput`. Left alone, the next step reads a host error
        // — unsanitized, never through `safeMessage` — as though it were the
        // tool's answer, and the model writes a final answer on top of a result
        // nothing produced. That is the fabricated result the failure matrix's
        // thrown-infrastructure row exists to forbid; measured, and it really
        // did reach `completed`.
        //
        // So fail the step. The provider call above is already billed (money
        // first), nothing is checkpointed, and `infrastructure_retry` gives the
        // driver's bounded backoff the whole step to re-run — the same treatment
        // every other transient host failure gets. `detail` stays host-authored:
        // the thrown message may be a raw upstream string with a URL in it, and
        // this field is persisted and shown.
        //
        // AFTER the allowlist, deliberately. A model naming a tool that does not
        // exist also produces a `tool-error`, and that is not infrastructure —
        // it is a malformed response, it is diagnosed precisely one block up as
        // `malformed_response:unsupported_tool`, and it settles `requires_input`
        // rather than spending two more provider calls on a history that will
        // produce the same bad call again. Ordering is what keeps both true.
        //
        // And NARROWED to the throw. `refusedByValidation` is excluded because
        // its call was refused by the schema, not by a host failure: retrying
        // the generation there re-runs the IDENTICAL history, the model
        // re-emits the same rejected arguments, all three paid driver attempts
        // burn and it ends in `driver_attempts_exhausted` needing a human — for
        // a program a hundred characters too long that the model fixes by
        // itself in one more step. Measured, both halves.
        if (
          step.content.some(
            (part) => part.type === "tool-error" && !refusedByValidation.has(part.toolCallId),
          )
        ) {
          halt({
            path: "infrastructure_retry",
            errorCode: "tool_execution_failed",
            detail: "a tool call ended without a result the model may read",
          });
        }

        const messages = normalized.outcome === "normalized" ? normalized.messages : [];

        const checkpoint = checkpointStepMessages(storage, fence, {
          globalStep,
          messages,
        });
        if (checkpoint.outcome === "stale_claim") {
          halt({ path: "aborted_stale_claim", errorCode: "stale_claim" });
        }
        terminalResponseMessages = messages;

        // A long tool call must not look like a crash to the reclaim path.
        if (heartbeat(storage, fence).outcome === "stale_claim") {
          halt({ path: "aborted_stale_claim", errorCode: "stale_claim" });
        }
      },
    });

    await consumeStream(generation.stream, stream, halt, () => stopped, abortControls);

    if (stopped !== null) {
      await terminateFor(stream, stopped);
      return stopped;
    }
    if (stream.staleClaim) {
      return { path: "aborted_stale_claim", errorCode: "stale_claim" };
    }
    if (!sawAnyStep) {
      await stream.terminate("failed", "empty_generation");
      return {
        path: "infrastructure_retry",
        errorCode: "empty_generation",
        detail: "the provider stream ended without completing a step",
      };
    }

    if (lastStepHadToolCalls) {
      // The step budget ran out while the model was still asking for tools.
      // There is no answer to persist, and calling that an empty answer would
      // retry an attempt whose own preflight is about to refuse it anyway.
      await stream.terminate("failed", "step_limit");
      return {
        path: "step_limit",
        errorCode: "step_limit",
        detail: `the step ceiling of ${limits.maxStepsPerGeneration} was reached mid tool loop`,
      };
    }

    result = await finalize({
      claim,
      events,
      stream,
      context,
      globalStep: terminalGlobalStep,
      responseMessages: terminalResponseMessages,
      now: clock.now(),
    });
  } catch (error) {
    if (error instanceof ContinuationStop) {
      await terminateFor(stream, error.result);
      return error.result;
    }
    // The SDK may raise the abort instead of streaming an `abort` part,
    // depending on where in the pipeline the signal fires. Both mean the same
    // thing, and both ask the durable cursors what that thing is.
    const mapped = isAbort(error, steering) ? abortControls.result() : classifyThrown(error);
    await terminateFor(stream, mapped);
    return mapped;
  } finally {
    // Never leave a controller on offer past the invocation it belongs to: an
    // `appendTurn` that found a stale entry would abort nothing while believing
    // it had. Idempotent, and it removes only this invocation's own entry.
    abortControls.disarm();
  }

  return result;
}

/* ------------------------------------------------------- stream reading -- */

/**
 * Consume the ALL-EVENTS stream, exhaustively.
 *
 * `result.stream` rather than `textStream`, because the loop must observe tool
 * lifecycle and terminal errors — `textStream` drops both, including the errors.
 * (`fullStream` is the deprecated alias of this same stream in `ai@7.0.59`.)
 *
 * The `default` arm assigns to `never`. That is the point of writing every
 * discriminant out: when the SDK adds a stream part in a minor release, this
 * file stops compiling instead of silently ignoring whatever the new part
 * carries — which for a part carrying reasoning or a raw provider body is the
 * difference between "ignored" and "leaked".
 */
async function consumeStream(
  parts: AsyncIterable<TextStreamPart<{ run_code: Tool<{ code: string }, CodeModeOutput> }>>,
  stream: AssistantStream,
  halt: (result: ContinuationResult) => never,
  stopped: () => ContinuationResult | null,
  abort: { arm: () => void; disarm: () => void; result: () => ContinuationResult },
): Promise<void> {
  for await (const part of parts) {
    // A callback already decided this attempt is over. Stop reading rather than
    // consuming the rest of a generation whose outcome is settled: with the
    // reader gone, backpressure ends the provider stream too.
    if (stopped() !== null) return;

    switch (part.type) {
      case "text-delta":
        await stream.delta(part.text);
        break;

      // THE ONLY WINDOW IN WHICH A STEER MAY CUT THE PROVIDER OFF.
      //
      // Armed at `text-start` and withdrawn the moment the step shows any sign
      // of being worth finishing, because streaming prose is the only phase
      // where aborting is cheaper than continuing: every further token is text
      // a steer would supersede anyway. A steer that lands while the model is
      // thinking, while `run_code` is executing, or between steps finds nothing
      // armed and is absorbed by the next `prepareStep` instead — with the
      // step's tokens and its tool result intact, which is strictly better than
      // paying for the step twice.
      //
      // The window is deliberately as small as the stream allows, but it cannot
      // be zero: while the first narration deltas of a step arrive there is no
      // signal yet distinguishing "this step is the answer" from "this step is
      // about to call a tool", and a steer landing in those few tokens does cut
      // the step short. That costs the narration tokens and re-sends the prompt;
      // it loses nothing, and `row 2 — a steer during pre-tool narration` pins
      // the behaviour down rather than leaving it to be discovered.
      case "text-start":
        abort.arm();
        break;

      case "text-end":
      // The moment the step declares a tool, it has work worth keeping: the
      // arguments are already being streamed and the call is about to issue.
      // Disarmed HERE rather than only at `tool-call`, because the argument
      // payload of a `run_code` call is the model's whole program and streams
      // as `tool-input-delta` — by far the longest stretch of a tool step, and
      // the last place an abort should still be on offer.
      case "tool-input-start":
      // Belt and braces for a provider that emits the call without the input
      // framing. Nothing is EMITTED for either: the outer `run_code` lifecycle
      // is written by the execute wrapper, not from here, because the wrapper
      // is what guarantees the outer `started` precedes the nested `cap:*`
      // events the execution emits while it runs. Mapping both would put every
      // tool call in the timeline twice (see audit.ts).
      case "tool-call":
        abort.disarm();
        break;

      // Reasoning, in every form. Ignored ENTIRELY: no event, no log, no D1
      // row, no Zep (invariant 18). The signed thinking block still reaches the
      // durable transcript through `normalizeResponseMessages`, which keeps the
      // opaque signature and refuses readable text.
      case "reasoning-start":
      case "reasoning-delta":
      case "reasoning-end":
      case "reasoning-file":
      // Raw provider chunks. `includeRawChunks: false` means these should not
      // arrive at all; the arm exists so that a provider that sends one anyway
      // is dropped rather than reaching the default.
      case "raw":
      // Framing and progress with no durable meaning of their own.
      case "start":
      case "start-step":
      case "tool-input-delta":
      case "tool-input-end":
      case "source":
      case "file":
      case "custom":
      // Tool lifecycle, emitted by the execute wrapper rather than from here
      // (see the `tool-call` arm above).
      case "tool-result":
      // `tool-error` is NOT ignored, it is merely not decided HERE. It arrives
      // before `finish-step`, and halting on it would skip `onStepEnd` — which
      // is where the provider call this step already made gets billed. So the
      // step is allowed to end, money is recorded, and `onStepEnd` refuses to
      // checkpoint the SDK's synthetic error result. Deciding it in two places
      // would mean two answers to the same question.
      case "tool-error":
        break;

      // Per-step accounting happens in `onStepEnd`, which the SDK awaits.
      case "finish-step":
      case "finish":
        abort.disarm();
        break;

      // Reachable from Task 8 on: `RunDO.appendTurn` may abort the armed
      // controller after a steering turn commits. What it MEANS is read from
      // durable state — steering continues the same generation, a cancellation
      // with nothing pending is a visible outcome — never from the reason
      // string, which an eviction would lose.
      case "abort":
        abort.disarm();
        return halt(abort.result());

      case "error":
        abort.disarm();
        return halt(classifyThrown(part.error));

      case "tool-output-denied":
      case "tool-approval-request":
      case "tool-approval-response":
        // No approval configuration exists in this build and no tool is
        // provider-executed, so one of these is a response that is not for us.
        // Phase 11 owns approvals; acting on one here would be granting it.
        return halt({
          path: "malformed_history",
          errorCode: `unexpected_stream_part:${part.type}`,
        });

      default: {
        const unhandled: never = part;
        return halt({
          path: "malformed_history",
          errorCode: "unknown_stream_part",
          detail: String((unhandled as { type?: unknown }).type ?? "unknown"),
        });
      }
    }
  }
}

/**
 * The ONE thing the model is told when the SDK refused its tool arguments.
 *
 * Host-authored, fixed, and deliberately shaped as a `CodeModeOutput` — the
 * same value `run_code` returns for every failure it can express, so the model
 * reads a schema refusal exactly the way it reads a capability error, in the
 * documented `code: message` wire format (`codemode/tool.ts`'s RULES: "Errors
 * come back as 'code: message'. The code is stable; read it and adapt.").
 *
 * `result: null` and a populated `error` are what make it unmistakable for a
 * successful run; carried as `error-json`, it also reaches Anthropic with
 * `is_error: true`.
 *
 * It quotes NOTHING back. Not the SDK's message, not the zod issue list, not
 * the submitted program — `codemode/tool.ts:4-16` already rejected a validator
 * for echoing submitted values, and this field is persisted, replayed to the
 * provider and read by an operator.
 *
 * It does not state the length cap, because it cannot reach one: this is a
 * module constant with no `limits` in scope, and a hardcoded number here would
 * be a second copy of the limit free to drift from the schema. The number the
 * model needs lives once, rendered from `limits.maxCodeChars`, in `run_code`'s
 * own description (`codemode/tool.ts`'s RULES) — which is in the context of the
 * very call being repaired.
 *
 * Exported so a test can assert it is frozen.
 */
export const SCHEMA_REFUSAL: CodeModeOutput = {
  result: null,
  logs: [],
  error:
    "invalid_input: the arguments did not satisfy this tool's input schema, so nothing ran. "
    + "It takes exactly one property, `code`, holding the whole program as a single non-empty "
    + "string within the declared length limit, and no other property. "
    + "Repair the arguments — shortening the program if it is long — and call the tool again.",
  truncation: { result: false, logs: false },
  metrics: { durationMs: 0, capabilityCalls: 0 },
};

// ONE instance is referenced by every refused tool result in memory and
// re-serialized on every replay (`agent/transcript.ts`'s normalizeToolOutput
// hands `value` on without cloning). Nothing mutates it today; freezing makes
// that structural instead of a convention.
//
// Every level, not just the top one. A shallow freeze would leave `logs`,
// `truncation` and `metrics` writable — and `logs.push(...)` on the shared
// array is exactly the mutation that would appear in every historical refusal
// at once.
Object.freeze(SCHEMA_REFUSAL);
Object.freeze(SCHEMA_REFUSAL.logs);
Object.freeze(SCHEMA_REFUSAL.truncation);
Object.freeze(SCHEMA_REFUSAL.metrics);

/**
 * Swap the SDK's synthetic validation-error result for the host-authored one,
 * for exactly the calls the SDK refused against the schema.
 *
 * Structural on purpose: it rebuilds the parts it keeps rather than spreading
 * the provider's objects, so no field nobody enumerated rides along into the
 * value `normalizeResponseMessages` is about to store. Everything it does not
 * recognize is passed through untouched — this function decides ONE thing, and
 * the allowlist immediately after it still decides what may be stored at all.
 */
function replaceRefusedToolOutputs(
  messages: readonly ResponseMessage[],
  refused: ReadonlySet<string>,
): ResponseMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool-result" || !refused.has(part.toolCallId)) return part;
        return {
          type: "tool-result" as const,
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: { type: "error-json" as const, value: SCHEMA_REFUSAL },
        };
      }),
    };
  });
}

/**
 * What a thrown or streamed error means for the driver.
 *
 * Timeout detection is by name and message rather than by an exported class,
 * because the pinned SDK raises step/chunk timeouts through several error types
 * and `ai@7.0.59` exports no single `TimeoutError` to test against. It is
 * separated from the generic transient case only because the two read
 * differently in an operator's failure list; both retry.
 */
function classifyThrown(error: unknown): ContinuationResult {
  if (error instanceof ContinuationStop) return error.result;

  if (error instanceof ModelCompositionError) {
    return {
      path: "infrastructure_exhausted",
      errorCode: error.code,
      detail: error.message,
    };
  }
  if (error instanceof UnknownModelPriceError) {
    return {
      path: "infrastructure_exhausted",
      errorCode: error.code,
      detail: error.message,
    };
  }

  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const looksLikeTimeout = /timeout|timed out/i.test(`${name} ${message}`);
  return {
    path: looksLikeTimeout ? "provider_timeout" : "infrastructure_retry",
    errorCode: looksLikeTimeout ? "provider_timeout" : "provider_stream_failed",
    // Message only, never the stack: a stack from a capability can carry a URL
    // with a token in it, and this string is persisted and shown.
    detail: message.slice(0, 400),
  };
}

/**
 * Was this the steering abort, or something that merely looks like one?
 *
 * The controller's own signal is the primary test, because a signal this loop
 * created can only have been aborted by this loop's registry entry. The name
 * checks are the fallback for the SDK re-wrapping the reason on the way out.
 */
function isAbort(error: unknown, controller: AbortController): boolean {
  if (controller.signal.aborted) return true;
  if (error instanceof SteeringAbort) return true;
  const name = error instanceof Error ? error.name : "";
  return name === "AbortError";
}

/**
 * Terminate the visible stream for a non-success path.
 *
 * Every exit terminates exactly one stream update, so a client is never left
 * holding a draft with nothing coming for it. A stale claimant terminates
 * nothing: its writes are refused anyway, and the successor owns the answer.
 *
 * A continuation terminates the draft as `superseded`, not `failed`. Nothing
 * failed: the customer steered, the same generation is about to continue, and
 * showing them a failed answer for having typed is the opposite of what
 * happened.
 */
async function terminateFor(stream: AssistantStream, result: ContinuationResult): Promise<void> {
  if (result.path === "aborted_stale_claim") return;
  if (result.path === "continuation_requested") {
    await stream.terminate("superseded");
    return;
  }
  await stream.terminate("failed", result.errorCode ?? result.path);
}

/* ------------------------------------------------------- the finalization -- */

async function finalize(input: {
  claim: ClaimedGeneration;
  events: RunEventPort;
  stream: AssistantStream;
  context: TrustedContext;
  globalStep: number;
  responseMessages: unknown[];
  now: number;
}): Promise<ContinuationResult> {
  const { stream, claim } = input;
  const pending = stream.takePending();
  const deltaBatchSeq = stream.nextBatchSeq;
  const terminalBatchSeq = pending === null ? deltaBatchSeq : deltaBatchSeq + 1;

  const finalText = answerText(stream.terminalText, pending);
  if (finalText === null) {
    await stream.terminate("failed", "empty_answer");
    return {
      path: "infrastructure_retry",
      errorCode: "empty_answer",
      detail: "the terminal step produced no text to persist as the final turn",
    };
  }

  const outcome = await input.events.finalize({
    attempt: claim.attempt,
    finalText,
    summary: summarize(finalText),
    // Slack final text is INTERNAL run narration: customer output happens only
    // through `slack.reply` (invariant 4). The harness reads the label, not the
    // origin, so a surface added later cannot acquire send rights by default.
    internalNarration: input.context.origin === "slack",
    ...(pending === null ? {} : { pendingDelta: pending }),
    deltaBatchSeq,
    terminalBatchSeq,
    globalStep: input.globalStep,
    responseMessages: input.responseMessages,
    now: input.now,
  });

  switch (outcome.outcome) {
    case "finalized":
    case "already_final":
      // `already_final` is a redelivered finalization of an answer that is
      // already durable — and it carries the pause the first delivery latched,
      // so a retry of a parked generation reports the park again instead of
      // telling the driver the run went idle.
      return outcome.pausedApprovalId === null
        ? { path: "completed", errorCode: null, finalTurnId: outcome.turnId }
        : {
            path: "paused",
            errorCode: null,
            finalTurnId: outcome.turnId,
            pausedApprovalId: outcome.pausedApprovalId,
          };
    case "superseded":
      return {
        path: "continuation_requested",
        errorCode: null,
        detail: `input at seq ${outcome.pendingThroughSeq} arrived after ${outcome.includedThroughSeq}`,
      };
    case "stale_claim":
      return { path: "aborted_stale_claim", errorCode: "stale_claim" };
  }
}

/**
 * The text that becomes the durable final turn.
 *
 * `terminalText` is the terminal step's text ONLY. `pending` is whatever of that
 * same step was still buffered when the stream ended, and appending it is not
 * concatenating narration: `endStep` flushes into `terminalText` on every step
 * boundary, so a non-null `pending` here can only be tail bytes of the step that
 * has not been flushed yet.
 */
function answerText(terminalText: string, pending: string | null): string | null {
  const text = pending === null || terminalText.endsWith(pending)
    ? terminalText
    : `${terminalText}${pending}`;
  const trimmed = text.trim();
  return trimmed.length === 0 ? null : text;
}

/** One line for the run list. First sentence, hard-bounded, never model markup. */
function summarize(finalText: string): string {
  const flat = finalText.replace(/\s+/g, " ").trim();
  if (flat.length <= SUMMARY_MAX_CHARS) return flat;
  return `${flat.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
}

/* ------------------------------------------------- the outer tool wrapper -- */

/**
 * Emit the outer `run_code` lifecycle from AROUND the execution.
 *
 * The plan allows `onToolExecutionStart`/`onToolExecutionEnd` OR an equivalent
 * wrapper, and says plainly: never both, because both means every tool call
 * appears twice in the timeline and the second `completed` overwrites the
 * first's output. This build uses the wrapper and does NOT pass those callbacks
 * to `streamText`, for a reason the callbacks cannot satisfy: a nested `cap:*`
 * audit event is written by the capability layer DURING execution, so the outer
 * `started` has to be committed before `execute` is entered, synchronously with
 * the same call. The wrapper is inside that boundary; a stream part is not.
 *
 * `CodeModeOutput.error` is returned to the model as an ordinary tool result so
 * the next step can adapt, while the visible event is `failed` — both are true
 * at once, and only one of them is an event state (see `outerToolMapper`).
 */
export function withOuterToolEvents(
  inner: Tool<{ code: string }, CodeModeOutput>,
  generationId: string,
  writer: ToolUpdateWriter,
): Tool<{ code: string }, CodeModeOutput> {
  const mapper = outerToolMapper(generationId);
  const execute = inner.execute;
  if (!execute) return inner;

  return {
    ...inner,
    execute: async (
      args: { code: string },
      options: ToolExecutionOptions<never>,
    ): Promise<CodeModeOutput> => {
      await writer.write(mapper.started({ toolCallId: options.toolCallId, code: args.code }));
      const output = (await execute(args, options as never)) as CodeModeOutput;
      await writer.write(mapper.ended({ toolCallId: options.toolCallId, output }));
      return output;
    },
    // The wrapper is intentionally opaque to the SDK's tool-context generic: it
    // adds no context of its own and forwards `options` untouched, so widening
    // through `unknown` here loses nothing the inner tool declared.
  } as unknown as Tool<{ code: string }, CodeModeOutput>;
}

/* ----------------------------------------------------------- the factory -- */

export type AgentContinuationOptions = {
  modelFactory: ModelFactory;
  /**
   * An ADDITIONAL freshness check, ANDed on top of the durable one.
   *
   * Named `additionalGuard` rather than `guard` because the call site is what
   * an audit of invariant 15 actually reads. A field called `guard` set to
   * `alwaysFresh()` tells that reader freshness checking is off, which is the
   * exact inverse of the truth: invariant 15's real gate is
   * `generationFreshnessGuard`, `composeAndRun` always composes it, and no
   * caller can turn it off. `additionalGuard: alwaysFresh()` says the true
   * thing — nothing extra beyond the durable check.
   *
   * The durable half re-reads this generation's input revision, the driver's
   * pending cursor and the claim epoch from RunDO storage immediately before
   * the outer `run_code` call and before every capability body, so a step
   * already known to be stale produces a safe `stale_generation` result instead
   * of a live external write.
   *
   * It stays REQUIRED. It is the seam a test uses to force a refusal
   * deterministically, and a required field means the answer "nothing extra"
   * has to be typed out, in a diff somebody reads. AND-semantics mean an added
   * guard can only ever tighten the check; it cannot loosen it.
   */
  additionalGuard: AgentExecutionGuard;
  limits?: AgentLimits;
  clock?: StreamClock;
  /** Batching thresholds. Tests inject smaller ones. */
  flush?: { chars?: number; ms?: number };
  historyBounds?: { maxMessages: number; maxBytes: number };
  /**
   * Swap the capability layer's VENDOR PORTS only. See
   * `RunCodeToolInput.dependencies`: it is what lets a test drive this exact
   * composition without reaching a vendor, instead of rebuilding it.
   */
  dependencies?: CapabilityDependencyFactory;
  /**
   * Observe the ten typed paths.
   *
   * The driver contract deliberately narrows to three outcomes — settle,
   * continue, retry — because that is all scheduling needs. An operator looking
   * at a failed run wants to know whether it was a refusal, a spend cap or a
   * malformed history, and those are all `failed` by the time the driver sees
   * them. This is where that detail is available without widening the port.
   */
  onOutcome?: (result: ContinuationResult) => void;
};

/**
 * Build the real continuation for ONE Durable Object.
 *
 * This is the shape `RunPorts.continuation` now takes: a factory over
 * `(ctx, env)`, because the loop needs this object's storage and this object's
 * bindings and a module-scope singleton has a route to neither.
 *
 * Everything that can refuse, refuses BEFORE the provider: an unconfirmable run,
 * an unmapped channel, a customer the channel policy cannot name. Discovering
 * mid-answer that this run may not act is the failure mode fail-closed ordering
 * exists to prevent.
 */
export function makeAgentContinuation(
  ctx: DurableObjectState,
  env: Env,
  options: AgentContinuationOptions,
): AgentContinuation {
  return {
    async run(claim: ClaimedGeneration) {
      const state = readState(ctx.storage);
      if (!state) {
        return {
          outcome: "failed",
          state: "failed",
          resumePolicy: "requires_operator_config",
          errorCode: "run_not_initialized",
        };
      }

      const events = makeRunEventPort(ctx, claim.fence);
      const result = await composeAndRun(ctx, env, state, claim, events, options);
      options.onOutcome?.(result);
      return toContinuationOutcome(result);
    },
  };
}

async function composeAndRun(
  ctx: DurableObjectState,
  env: Env,
  state: RunState,
  claim: ClaimedGeneration,
  events: RunEventPort,
  options: AgentContinuationOptions,
): Promise<ContinuationResult> {
  const resolved = await resolveTrustedContext(env.DB, {
    generationId: claim.generationId,
    run: {
      runId: state.runId,
      origin: state.origin,
      channelId: state.channelId,
      threadTs: state.threadTs,
    },
  });
  if (resolved.outcome === "refused") {
    return {
      path: "infrastructure_exhausted",
      errorCode: `trusted_context_${resolved.reason}`,
      detail: "the run's trusted facts could not be resolved; no model work was started",
    };
  }

  let model: ModelHandle;
  try {
    model = options.modelFactory({
      runId: state.runId,
      generationId: claim.generationId,
      attempt: claim.attempt,
      surface: state.origin,
    });
  } catch (error) {
    return classifyThrown(error);
  }

  const writer: ToolUpdateWriter = {
    async write(update) {
      await events.toolUpdate(update);
    },
  };

  let tools: { run_code: Tool<{ code: string }, CodeModeOutput> };
  try {
    tools = await makeAgentTools({
      env,
      state,
      // Allocated inside the input transaction, before any provider I/O, and
      // reused by every continuation and retry of this generation (invariant 7).
      turnId: claim.agentTurnId,
      // audit.ts, wired: nested capability events become `cap:*` tool updates
      // on the same replayable stream as everything else (invariant 19).
      auditForExecution: auditSinkFactory(claim.generationId, writer),
      // Generation-scoped, not execution-scoped: every `run_code` call this
      // generation makes contributes evidence to the ONE episode its
      // finalization will freeze. This is what lets a Chat answer cite the
      // customer messages a recall returned rather than its own prompt.
      provenance: makeProvenanceSink(ctx.storage, claim.generationId),
      // INVARIANT 15, composed here rather than delegated to the caller.
      //
      // The durable half — `generationFreshnessGuard`, which re-reads this
      // generation's included cursor, the driver's pending cursor and the claim
      // epoch immediately before every outer call and every capability body —
      // is not optional and cannot be opted out of. `options.additionalGuard`
      // is an ADDITIONAL check ANDed on top of it, which is why a caller
      // passing `alwaysFresh()` still gets full steering safety.
      guard: bothFresh(
        generationFreshnessGuard(ctx.storage, claim.fence),
        options.additionalGuard,
      ),
      // THE REAL APPROVAL PORT, built here because this is the first place
      // that has all three of its inputs at once: THIS object's storage, the
      // run's PINNED Slack scope from `run_state`, and the generation whose
      // escalation it would be. `dependencies.ts` can reach none of them, which
      // is why the port is handed down rather than composed there.
      approval: makeApprovalPort({
        storage: ctx.storage,
        db: env.DB,
        runId: state.runId,
        generationId: claim.generationId,
        slackThread:
          state.origin === "slack" && state.channelId !== null && state.threadTs !== null
            ? { channelId: state.channelId, threadTs: state.threadTs }
            : null,
        now: () => (options.clock?.now() ?? Date.now()),
      }),
      ...(options.dependencies === undefined
        ? {}
        : { dependencies: options.dependencies }),
    });
  } catch (error) {
    return classifyThrown(error);
  }

  return runContinuation(claim, {
    storage: ctx.storage,
    events,
    tools: { [OUTER_TOOL_NAME]: withOuterToolEvents(tools.run_code, claim.generationId, writer) },
    model,
    context: resolved.context,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.flush === undefined ? {} : { flush: options.flush }),
    ...(options.historyBounds === undefined
      ? {}
      : { historyBounds: options.historyBounds }),
  });
}
