import type { LanguageModelUsage } from "ai";
import type { NormalizedUsage } from "./contracts";
import {
  GATEWAY_MAX_ATTEMPTS,
  GENERATION_SPEND_CAP_NANO_USD,
  MAX_OUTPUT_TOKENS_PER_STEP,
  NANO_USD_PER_USD,
  RUN_SPEND_CAP_NANO_USD,
} from "./limits";

/**
 * Money.
 *
 * Every number in this file is an INTEGER of nano-USD (invariant 29). No
 * floating-point dollars appear anywhere, not even transiently: `0.1 + 0.2`
 * is a rounding error the first time and a reconciliation ticket the
 * ten-thousandth time, and SQLite cannot sum floats exactly either.
 *
 * Pure module. No storage, no bindings, no clock, no network — only the
 * type-level import of the AI SDK's usage shape. Everything here is a total
 * function over integers, so the whole spend policy is testable without a
 * provider.
 */

// --- the price table --------------------------------------------------------

export const FABLE_5_MODEL_ID = "claude-fable-5";

/**
 * What one token of each class costs, in nano-USD.
 *
 * Anthropic quotes USD per million tokens; nano-USD per token is the same
 * number divided by 1,000 and happens to be an exact integer for every Fable
 * price, which is why this unit was chosen over micro-USD.
 */
export type ModelPrices = {
  /** Uncached input, and any input the provider did not classify. */
  input: number;
  /** Writing a 5-minute ephemeral cache entry. */
  cacheWrite5m: number;
  /** Writing a 1-hour ephemeral cache entry. */
  cacheWrite1h: number;
  /** Reading from cache. */
  cacheRead: number;
  /** Output, including the reasoning tokens that are a subset of it. */
  output: number;
};

/** The cache TTLs Anthropic bills differently. `policy.ts` configures `5m`. */
export type CacheWriteTtl = "5m" | "1h";

/**
 * The official Fable 5 prices at the time of planning.
 *
 * | class                | USD / Mtok | nano-USD / token |
 * | -------------------- | ---------: | ---------------: |
 * | uncached input       |     $10.00 |           10,000 |
 * | 5-minute cache write |     $12.50 |           12,500 |
 * | 1-hour cache write   |     $20.00 |           20,000 |
 * | cache read           |      $1.00 |            1,000 |
 * | output               |     $50.00 |           50,000 |
 */
export const FABLE_5_PRICES: ModelPrices = {
  input: 10_000,
  cacheWrite5m: 12_500,
  cacheWrite1h: 20_000,
  cacheRead: 1_000,
  output: 50_000,
};

/**
 * Every model this system knows how to bill, keyed by model ID.
 *
 * Deliberately a closed table with no default entry. A model that is not in
 * here cannot be priced — see `pricesFor` — because the alternative is
 * charging an unknown model at Fable's rate and reporting a confident number
 * that is wrong by an unknown factor. Adding a model is a reviewed diff.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrices>> = Object.freeze({
  [FABLE_5_MODEL_ID]: FABLE_5_PRICES,
});

/**
 * Thrown when cost is asked for a model with no reviewed price row.
 *
 * A distinct class so a caller can convert it into a
 * `requires_operator_config` failure rather than a retryable one: retrying
 * will not teach the table a new price.
 */
export class UnknownModelPriceError extends Error {
  readonly code = "unknown_model_price";
  readonly modelId: string;

  constructor(modelId: string) {
    super(`no reviewed price table for model ${JSON.stringify(modelId)}`);
    this.name = "UnknownModelPriceError";
    this.modelId = modelId;
  }
}

/** Prices for a known model, or a throw. Never a fallback rate. */
export function pricesFor(modelId: string): ModelPrices {
  const prices = Object.hasOwn(MODEL_PRICES, modelId) ? MODEL_PRICES[modelId] : undefined;
  if (!prices) throw new UnknownModelPriceError(modelId);
  return prices;
}

export function isPricedModel(modelId: string): boolean {
  return Object.hasOwn(MODEL_PRICES, modelId);
}

/** The rate the pre-step guard must assume it will pay for an input token. */
export function worstCaseInputRate(prices: ModelPrices): number {
  return Math.max(prices.input, prices.cacheWrite5m, prices.cacheWrite1h);
}

// --- the usage adapter ------------------------------------------------------

/**
 * The ONE place the AI SDK's usage shape is read.
 *
 * `ai@7.0.59` exports `LanguageModelUsage` (dist/index.d.ts:320) with a FLAT
 * top level and nested detail bags:
 *
 *   { inputTokens, inputTokenDetails: { noCacheTokens, cacheReadTokens,
 *     cacheWriteTokens }, outputTokens, outputTokenDetails: { textTokens,
 *     reasoningTokens }, totalTokens, raw? }
 *
 * every field being `number | undefined`. This is NOT the provider-level
 * `LanguageModelV4Usage` from `@ai-sdk/provider@4.0.7` (dist/index.d.ts:2574),
 * which nests its counters instead — `inputTokens: { total, noCache,
 * cacheRead, cacheWrite }`. Two similar names, two different shapes, and
 * `streamText` hands callbacks the flat one: `onStepEnd` receives
 * `GenerateTextStepEndEvent = StepResult`, whose `usage` is
 * `LanguageModelUsage` (dist/index.d.ts:1484). Reading one while assuming the
 * other silently produces zeroes, which reads as a free request.
 *
 * `undefined` becomes zero here, and that is a deliberate semantic claim:
 * every field is a COUNT of tokens in a class, so unreported and none are the
 * same number. The one place where that would be wrong — a provider that
 * reports no input detail at all — is handled in `costNanoUsd`, which charges
 * the unclassified remainder rather than recording a free request.
 */
export function normalizeSdkUsage(usage: LanguageModelUsage | undefined): NormalizedUsage {
  const inputDetails = usage?.inputTokenDetails;
  const outputDetails = usage?.outputTokenDetails;

  const normalized: NormalizedUsage = {
    inputTokens: toTokenCount(usage?.inputTokens),
    noCacheTokens: toTokenCount(inputDetails?.noCacheTokens),
    cacheReadTokens: toTokenCount(inputDetails?.cacheReadTokens),
    cacheWriteTokens: toTokenCount(inputDetails?.cacheWriteTokens),
    outputTokens: toTokenCount(usage?.outputTokens),
    reasoningTokens: toTokenCount(outputDetails?.reasoningTokens),
    totalTokens: toTokenCount(usage?.totalTokens),
  };

  if (normalized.totalTokens === 0) {
    // `inputTokens` is the TOTAL input, of which the three detail fields are
    // subsets, so the total is input plus output and adding the subsets again
    // would double-count. Same reason `reasoningTokens` is absent: it is a
    // subset of `outputTokens`.
    normalized.totalTokens = normalized.inputTokens + normalized.outputTokens;
  }

  return normalized;
}

function toTokenCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.round(value);
}

// --- charging ---------------------------------------------------------------

/**
 * Whether the provider actually bills this response.
 *
 * `none` exists for one real case: Fable can return HTTP 200 with raw stop
 * reason `refusal` before emitting any output, and Anthropic does not bill it.
 * Usage is still reported and still recorded for rate and observability — the
 * money is what goes to zero, not the telemetry.
 */
export type Billing = "normal" | "none";

export type CostInput = {
  modelId: string;
  usage: NormalizedUsage;
  /** Which cache TTL the request configured. `policy.ts` uses `5m`. */
  cacheWriteTtl?: CacheWriteTtl;
  billing?: Billing;
};

export type CostBreakdown = {
  totalNanoUsd: number;
  /** Input the provider explicitly called uncached. */
  noCacheNanoUsd: number;
  cacheReadNanoUsd: number;
  cacheWriteNanoUsd: number;
  /** Input counted in `inputTokens` that no detail field claimed. */
  unclassifiedInputNanoUsd: number;
  outputNanoUsd: number;
  /** Input tokens charged at the plain input rate because nothing classified them. */
  unclassifiedInputTokens: number;
};

/**
 * What one completed provider step cost, in nano-USD.
 *
 * The counting rule, which exists specifically so no token is charged twice:
 *
 *  - each classified input class is charged once at its own rate;
 *  - any REMAINDER of `inputTokens` beyond what the detail fields classified
 *    is charged once at the plain input rate — so a provider that reports
 *    only a total is billed correctly rather than for free, and a provider
 *    that classifies everything has a remainder of zero rather than a second
 *    full charge;
 *  - `reasoningTokens` is a diagnostic SUBSET of `outputTokens` and is never
 *    added, or every thinking token would be billed twice.
 *
 * The remainder is clamped at zero. Anthropic's raw wire format reports
 * `input_tokens` EXCLUDING cache reads and writes, so a future adapter change
 * could make the classified subsets exceed the reported total; charging each
 * class once and nothing extra is the right answer either way.
 */
export function costNanoUsd(input: CostInput): CostBreakdown {
  // The price lookup happens even when billing is `none`, so an unknown model
  // fails closed on a refusal too instead of being quietly accepted at zero.
  const prices = pricesFor(input.modelId);

  const { usage } = input;
  const classified = usage.noCacheTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const unclassifiedInputTokens = Math.max(0, usage.inputTokens - classified);
  const cacheWriteRate =
    input.cacheWriteTtl === "1h" ? prices.cacheWrite1h : prices.cacheWrite5m;

  const breakdown: CostBreakdown = {
    noCacheNanoUsd: usage.noCacheTokens * prices.input,
    cacheReadNanoUsd: usage.cacheReadTokens * prices.cacheRead,
    cacheWriteNanoUsd: usage.cacheWriteTokens * cacheWriteRate,
    unclassifiedInputNanoUsd: unclassifiedInputTokens * prices.input,
    outputNanoUsd: usage.outputTokens * prices.output,
    unclassifiedInputTokens,
    totalNanoUsd: 0,
  };

  if (input.billing === "none") {
    // A pre-output refusal. Keep the breakdown for observability, charge zero.
    return { ...breakdown, totalNanoUsd: 0 };
  }

  breakdown.totalNanoUsd =
    breakdown.noCacheNanoUsd +
    breakdown.cacheReadNanoUsd +
    breakdown.cacheWriteNanoUsd +
    breakdown.unclassifiedInputNanoUsd +
    breakdown.outputNanoUsd;

  return breakdown;
}

// --- the pre-step spend guard ----------------------------------------------

/**
 * How conservatively encoded prompt bytes are turned into a token estimate.
 *
 * Real English through Anthropic's tokenizer runs near four bytes per token,
 * and JSON evidence with many short tokens runs nearer three. Two is the
 * reviewed conservative floor: it over-estimates typical traffic by about 2x,
 * which is the direction that protects the cap. It is not a proof — a prompt
 * of entirely single-byte tokens would still exceed it, and that residual is
 * the one documented overshoot source in `SpendGuardOutcome`.
 */
export const CONSERVATIVE_BYTES_PER_TOKEN = 2;

/**
 * Output tokens below which a step is not worth buying.
 *
 * Without this, a generation with four cents left would be admitted to produce
 * a truncated half-sentence and then stop — spending real money to produce
 * something nobody can use.
 */
export const MIN_USEFUL_OUTPUT_TOKENS = 256;

export type SpendGuardInput = {
  modelId: string;
  /** Durable nano-USD already charged to this generation. */
  generationSpentNanoUsd: number;
  /** Durable nano-USD already charged to the whole run. */
  runSpentNanoUsd: number;
  /** Bytes of the encoded prompt about to be sent. */
  promptBytes: number;
  /** What the caller would like, before any clamp. */
  requestedMaxOutputTokens: number;
  /** Transport attempts the Gateway may bill for this one call. */
  gatewayAttempts?: number;
  generationCapNanoUsd?: number;
  runCapNanoUsd?: number;
  minUsefulOutputTokens?: number;
};

export type SpendGuardOutcome =
  | {
      outcome: "ok";
      /** What `prepareStep` must clamp `maxOutputTokens` to. */
      maxOutputTokens: number;
      /** Headroom under the binding cap before this step. */
      remainingNanoUsd: number;
      /** Conservative token estimate the reservation was built from. */
      estimatedInputTokens: number;
      /** Worst-case input reservation, already multiplied by attempts. */
      reservedInputNanoUsd: number;
      /** Worst case this step can cost if the input estimate holds. */
      worstCaseStepNanoUsd: number;
      /** Which cap is closest. Useful in telemetry, not in the decision. */
      bindingScope: "generation" | "run";
    }
  | {
      outcome: "cost_limit";
      /** Which cap refused the step. */
      scope: "generation" | "run";
      remainingNanoUsd: number;
      estimatedInputTokens: number;
      reservedInputNanoUsd: number;
      /** `input_reservation` if input alone did not fit, else `no_useful_output`. */
      reason: "input_reservation" | "no_useful_output";
    };

/**
 * Decide, before spending anything, what this step is allowed to produce.
 *
 * A step ceiling is not a spend ceiling (invariant 28), so this is what
 * actually bounds money. The plan's seven steps, in order:
 *
 *  1. read what the generation and the run have already been charged;
 *  2. estimate worst-case input from encoded prompt bytes at the HIGHER of the
 *     input and cache-write rates — never the cheap cache-read rate, because
 *     assuming a cache hit that has not happened yet under-reserves by 20x;
 *  3. multiply provider-call exposure by the Gateway attempt count, since every
 *     transport attempt can be billed;
 *  4. reserve that much for input;
 *  5. convert what is left into an output-token ceiling at the output rate;
 *  6. hand that ceiling back for `prepareStep` to clamp `maxOutputTokens`;
 *  7. refuse the call outright if no useful output budget remains.
 *
 * MAXIMUM OVERSHOOT. If the byte estimate holds — that is, if actual input
 * tokens do not exceed `ceil(promptBytes / 2)` — this function CANNOT overshoot
 * either cap, because it reserves the full worst case of every billable
 * attempt before admitting the step. The only overshoot term is an input
 * under-estimate, bounded by
 *
 *     attempts x worstCaseInputRate x max(0, actualInputTokens - estimated)
 *
 * and nothing else: output is clamped to the ceiling this returns, cache reads
 * are cheaper than the rate reserved for them, and attempts are reserved in
 * full. `agent-cost.test.ts` asserts both halves of that statement.
 */
export function evaluateSpendGuard(input: SpendGuardInput): SpendGuardOutcome {
  const prices = pricesFor(input.modelId);
  const attempts = Math.max(1, Math.floor(input.gatewayAttempts ?? GATEWAY_MAX_ATTEMPTS));
  const generationCap = input.generationCapNanoUsd ?? GENERATION_SPEND_CAP_NANO_USD;
  const runCap = input.runCapNanoUsd ?? RUN_SPEND_CAP_NANO_USD;
  const minUseful = input.minUsefulOutputTokens ?? MIN_USEFUL_OUTPUT_TOKENS;

  // 1. What is left under each cap, and which one binds.
  const generationRemaining = Math.max(0, generationCap - Math.max(0, input.generationSpentNanoUsd));
  const runRemaining = Math.max(0, runCap - Math.max(0, input.runSpentNanoUsd));
  const remainingNanoUsd = Math.min(generationRemaining, runRemaining);
  const bindingScope: "generation" | "run" =
    generationRemaining <= runRemaining ? "generation" : "run";

  // 2. Conservative input estimate, at the rate that protects the cap.
  const estimatedInputTokens = Math.ceil(
    Math.max(0, input.promptBytes) / CONSERVATIVE_BYTES_PER_TOKEN,
  );
  const inputRate = worstCaseInputRate(prices);

  // 3 and 4. Reserve every attempt's worth of that input.
  const reservedInputNanoUsd = estimatedInputTokens * inputRate * attempts;

  if (reservedInputNanoUsd >= remainingNanoUsd) {
    return {
      outcome: "cost_limit",
      scope: bindingScope,
      remainingNanoUsd,
      estimatedInputTokens,
      reservedInputNanoUsd,
      reason: "input_reservation",
    };
  }

  // 5. Turn the rest into output tokens, again paying for every attempt.
  const outputBudgetNanoUsd = remainingNanoUsd - reservedInputNanoUsd;
  const affordableOutputTokens = Math.floor(outputBudgetNanoUsd / (prices.output * attempts));

  // 6. Clamp: never above what was asked, never above the reviewed step ceiling.
  const maxOutputTokens = Math.min(
    Math.max(0, Math.floor(input.requestedMaxOutputTokens)),
    MAX_OUTPUT_TOKENS_PER_STEP,
    affordableOutputTokens,
  );

  // 7. A step that cannot produce a usable answer is not worth buying.
  if (maxOutputTokens < minUseful) {
    return {
      outcome: "cost_limit",
      scope: bindingScope,
      remainingNanoUsd,
      estimatedInputTokens,
      reservedInputNanoUsd,
      reason: "no_useful_output",
    };
  }

  return {
    outcome: "ok",
    maxOutputTokens,
    remainingNanoUsd,
    estimatedInputTokens,
    reservedInputNanoUsd,
    worstCaseStepNanoUsd: reservedInputNanoUsd + maxOutputTokens * prices.output * attempts,
    bindingScope,
  };
}

/** Presentation only. Never used to compute or store a charge. */
export function formatNanoUsd(nanoUsd: number): string {
  const sign = nanoUsd < 0 ? "-" : "";
  const magnitude = Math.abs(Math.trunc(nanoUsd));
  const dollars = Math.trunc(magnitude / NANO_USD_PER_USD);
  const fraction = magnitude % NANO_USD_PER_USD;
  return `${sign}$${dollars}.${String(fraction).padStart(9, "0").slice(0, 6)}`;
}
