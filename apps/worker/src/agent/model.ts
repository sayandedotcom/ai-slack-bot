import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { FABLE_5_MODEL_ID, isPricedModel } from "./cost";
import {
  GATEWAY_AUTH_HEADER,
  GATEWAY_PROVIDER_NATIVE_HOST,
  gatewayHeaders,
  type GatewaySurface,
} from "./gateway";
import { DEFAULT_AGENT_LIMITS, type AgentLimits } from "./limits";

/**
 * The one production model path, behind an injected factory.
 *
 * Provider creation lives here and nowhere else, so prompt and loop code can be
 * unit-tested against `MockLanguageModelV4` without a network, a key, or a
 * Gateway. Tests never enter `createProductionModelFactory`; production never
 * enters anything else.
 *
 * The composer is the only place a credential is touched. `agent/gateway.ts`
 * builds the safe headers and is structurally unable to hold a token; the two
 * secrets — the Anthropic API key and the Gateway token — are merged into the
 * request configuration here, at the last possible moment, and are never
 * returned, logged, snapshotted, or attached to the handle a caller receives.
 */

/**
 * Trusted, opaque metadata describing one `streamText` invocation.
 *
 * Everything here is either an ID this system minted or a value from the
 * persisted run descriptor. Nothing comes from the model, the customer, or a
 * tool result — the headers built from it are sent to a third party.
 */
export type ModelInvocation = {
  runId: string;
  generationId: string;
  /** Claim number. Part of stable write identity; a small integer. */
  attempt: number;
  surface: GatewaySurface;
};

/**
 * What the loop gets back: one model, plus the facts telemetry needs about it.
 *
 * There is no `apiKey`, no `token`, no `headers` containing a credential, and
 * no provider object to reach one through. A caller cannot leak what it was
 * never given.
 */
export type ModelHandle = {
  model: LanguageModel;
  /** The billing key. `agent/cost.ts` refuses to price anything not in its table. */
  modelId: string;
  provider: "anthropic";
  /** The SAFE headers only. The auth header is deliberately absent. */
  safeHeaders: Record<string, string>;
  /** The number the spend guard must multiply provider exposure by. */
  gatewayAttempts: number;
};

/**
 * An invocation-scoped model factory.
 *
 * One model per `streamText` invocation, because the pinned SDK's
 * `PrepareStepResult` can override the model and generation settings but NOT
 * request headers — so headers are fixed for the invocation and deliberately
 * omit the step. Per-step correlation comes from the provider and Gateway
 * request IDs returned with each completed call, not from metadata.
 */
export type ModelFactory = (invocation: ModelInvocation) => ModelHandle;

export class ModelCompositionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ModelCompositionError";
    this.code = code;
  }
}

/** Exactly what the production composer needs, and nothing more. */
export type ModelEnv = {
  ANTHROPIC_API_KEY: string;
  AI_GATEWAY_ANTHROPIC_URL?: string;
  AI_GATEWAY_TOKEN?: string;
};

/**
 * Compose the real Fable path.
 *
 * FAILS CLOSED, always, on any of:
 *
 *  - a missing Anthropic key;
 *  - a missing Gateway URL — Anthropic must never be called directly from
 *    production, because the Gateway is where the retry policy, the payload-
 *    logging control and the independent billing cross-check live;
 *  - a Gateway URL that is not an `https://gateway.ai.cloudflare.com` endpoint,
 *    because `cf-aig-authorization` is the auth header for the PROVIDER-NATIVE
 *    family only. Pointed at the REST API host, that header would be ignored
 *    and the request would authenticate as nobody;
 *  - a missing Gateway token, since the whole point of an authenticated
 *    gateway is that an unauthenticated request cannot inflate the bill.
 *
 * There is no environment flag guarding this. A "development mode" that
 * silently skips the Gateway is how an unmetered direct-to-Anthropic call
 * reaches production; local unit tests do not need this function at all,
 * because they inject a mock model instead.
 */
export function createProductionModelFactory(
  env: ModelEnv,
  options: { modelId?: string; limits?: AgentLimits } = {},
): ModelFactory {
  const limits = options.limits ?? DEFAULT_AGENT_LIMITS;
  const modelId = options.modelId ?? FABLE_5_MODEL_ID;

  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new ModelCompositionError("missing_anthropic_key", "ANTHROPIC_API_KEY is not configured");
  }

  const baseURL = env.AI_GATEWAY_ANTHROPIC_URL?.trim();
  if (!baseURL) {
    throw new ModelCompositionError(
      "missing_gateway_url",
      "AI_GATEWAY_ANTHROPIC_URL is not configured; refusing to call Anthropic directly",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new ModelCompositionError("invalid_gateway_url", "AI_GATEWAY_ANTHROPIC_URL is not a URL");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== GATEWAY_PROVIDER_NATIVE_HOST) {
    throw new ModelCompositionError(
      "invalid_gateway_url",
      `AI_GATEWAY_ANTHROPIC_URL must be an https ${GATEWAY_PROVIDER_NATIVE_HOST} provider-native endpoint`,
    );
  }

  const gatewayToken = env.AI_GATEWAY_TOKEN?.trim();
  if (!gatewayToken) {
    throw new ModelCompositionError(
      "missing_gateway_token",
      "AI_GATEWAY_TOKEN is not configured; the gateway must be authenticated",
    );
  }

  // No silent fallback: an unpriced model would produce billed steps this
  // system cannot cost, which is worse than not running at all.
  if (!isPricedModel(modelId)) {
    throw new ModelCompositionError(
      "unpriced_model",
      `model ${JSON.stringify(modelId)} has no reviewed price table`,
    );
  }

  return (invocation) => {
    const safeHeaders = gatewayHeaders({
      run: invocation.runId,
      generation: invocation.generationId,
      attempt: invocation.attempt,
      surface: invocation.surface,
      maxAttempts: limits.gatewayMaxAttempts,
      retryDelayMs: limits.gatewayRetryDelayMs,
      requestTimeoutMs: limits.gatewayRequestTimeoutMs,
    });

    // The ONE place the two credentials meet the request. The auth header is
    // spread into the provider's own header bag and never into `safeHeaders`,
    // so the object handed back below cannot carry it.
    const provider = createAnthropic({
      apiKey,
      baseURL,
      headers: { ...safeHeaders, [GATEWAY_AUTH_HEADER]: `Bearer ${gatewayToken}` },
    });

    return {
      model: provider(modelId),
      modelId,
      provider: "anthropic",
      safeHeaders,
      gatewayAttempts: limits.gatewayMaxAttempts,
    };
  };
}

/**
 * The non-negotiable half of the eventual `streamText()` options.
 *
 * `maxRetries: 0` is the load-bearing line. AI Gateway owns at most two
 * transport attempts and it is the ONLY retry owner (invariant 27); leaving the
 * SDK's default of 2 in place would silently multiply worst-case spend by
 * four and make the reviewed attempt count a fiction.
 *
 * Timeouts are all explicit for the same reason the Gateway headers are:
 * a default that changes underneath a reviewed policy is not a reviewed policy.
 */
export function modelCallOptions(limits: AgentLimits = DEFAULT_AGENT_LIMITS) {
  return {
    maxRetries: 0 as const,
    timeout: {
      totalMs: limits.continuationMs,
      stepMs: limits.stepMs,
      firstChunkMs: limits.firstChunkMs,
      chunkMs: limits.chunkMs,
      toolMs: limits.toolMs,
    },
  };
}

// --- refusal ----------------------------------------------------------------

/**
 * Anthropic's raw stop reason for a refusal.
 *
 * Read STRUCTURALLY rather than dug out of `providerMetadata`. At the provider
 * layer `LanguageModelV4FinishReason` is an object `{ unified, raw }`
 * (`@ai-sdk/provider@4.0.7` dist/index.d.ts:2536); the AI SDK splits it across
 * `StepResult.finishReason` (the unified enum) and `StepResult.rawFinishReason`
 * (`string | undefined`), so the provider's own word survives to here.
 */
export const ANTHROPIC_REFUSAL_RAW_REASON = "refusal";

/**
 * What a completed step actually was.
 *
 * Refusal is not success (invariant 30) and there is no fallback model in this
 * phase (invariant 31), so the two refusal cases are distinguished here rather
 * than collapsed into a generic failure — they have different billing and
 * different recovery.
 */
export type StepOutcomeKind = "ok" | "refusal_pre_output" | "refusal_mid_stream";

export type StepOutcomeInput = {
  /** The unified finish reason from `StepResult.finishReason`. */
  finishReason: string | undefined;
  /** The provider's raw finish reason from `StepResult.rawFinishReason`. */
  rawFinishReason: string | null | undefined;
  /**
   * Whether any customer-visible draft text was emitted before the stop.
   *
   * This is what separates the two cases, and it must be measured from what
   * was actually STREAMED OUT, not from the reported output token count: a
   * refusal can report output tokens it never emitted, and a model can emit
   * text the usage row rounds to zero.
   */
  emittedVisibleOutput: boolean;
};

export type StepOutcome = {
  kind: StepOutcomeKind;
  /** What `agent/cost.ts` must charge for this step. */
  billing: "normal" | "none";
  /** Whether partial customer-visible draft batches must be discarded. */
  discardPartialDrafts: boolean;
  /** Safe, non-provider-authored code for telemetry and the failure event. */
  errorCode: string | null;
};

/**
 * Classify a completed step.
 *
 * Pre-output refusal: Anthropic does not bill a response it refused before
 * emitting anything, so cost is ZERO. Reported usage is still recorded, because
 * rate limits and observability are about requests made, not money spent.
 *
 * Mid-stream refusal: the input and the emitted output really were billed, so
 * they are charged normally — but every partial draft batch already written is
 * terminally discarded rather than promoted to a final answer, because half a
 * refused message is not an answer to send anyone.
 */
export function classifyStepOutcome(input: StepOutcomeInput): StepOutcome {
  const isRefusal =
    input.rawFinishReason === ANTHROPIC_REFUSAL_RAW_REASON ||
    // A provider that stops reporting a raw reason must still be caught. The
    // unified enum's `content-filter` is the same event with the detail lost.
    input.finishReason === "content-filter";

  if (!isRefusal) {
    return { kind: "ok", billing: "normal", discardPartialDrafts: false, errorCode: null };
  }

  if (input.emittedVisibleOutput) {
    return {
      kind: "refusal_mid_stream",
      billing: "normal",
      discardPartialDrafts: true,
      errorCode: "provider_refusal_mid_stream",
    };
  }

  return {
    kind: "refusal_pre_output",
    billing: "none",
    discardPartialDrafts: true,
    errorCode: "provider_refusal",
  };
}

/**
 * How a refusal must settle the generation.
 *
 * `requires_input` rather than `retryable`: replaying the same unchanged
 * context at the same model gets the same refusal and pays for it again. A
 * human steer allocates a NEW generation, which resumes from the last safe
 * pre-refusal checkpoint — the transcript as it stood before the refused
 * response, which was never persisted (invariant 16 stores completed steps,
 * and a refused step is not one).
 */
export const REFUSAL_RESUME_POLICY = "requires_input" as const;

/** The generation state a refusal settles into. */
export const REFUSAL_GENERATION_STATE = "refused" as const;

/**
 * What the customer-facing surface may say. Fixed text, not provider prose:
 * a refusal message is written by the model that just refused, and echoing it
 * would put unreviewed provider output in front of a customer.
 */
export const REFUSAL_SAFE_MESSAGE =
  "The model declined to continue this response. Nothing was sent, and this needs a human to look at before it goes further.";
