/**
 * Money, and the two places it stops a turn.
 *
 * Every number here is an INTEGER of nano-USD (invariant 29). No floating-point
 * dollars appear anywhere, not even transiently: `0.1 + 0.2` is a rounding error
 * the first time and a reconciliation ticket the ten-thousandth, and SQLite
 * cannot sum floats exactly either.
 *
 * WHERE THE CEILING IS ENFORCED, and why it is not where the deleted loop put
 * it. `beforeStep` CANNOT end a turn — `StepConfig` is the AI SDK's
 * `PrepareStepResult` and has no stop. So the ceiling is a `stopWhen` returned
 * from `beforeTurn`, reading cumulative `steps[].usage`, with `maxSteps` as a
 * belt. `beforeStep` keeps only a PREFLIGHT: when the next step's worst case
 * would cross the ceiling, take the tools away so the model writes its final
 * text instead of buying another tool round-trip.
 *
 * Pure module. No storage, no bindings, no clock — every function is total over
 * integers, so the whole spend policy is testable without a provider.
 */
import type {
  LanguageModelUsage,
  StepResult,
  StopCondition,
  ToolSet,
} from "ai";

import { NANO_USD_PER_USD } from "./money";

/* ---------------------------------------------------------- the price table -- */

export const FABLE_5_MODEL_ID = "claude-fable-5";

/** What one token of each class costs, in nano-USD. */
export type ModelPrices = {
  /** Uncached input, and any input the provider did not classify. */
  input: number;
  /** Writing a 5-minute ephemeral cache entry. */
  cacheWrite5m: number;
  /** Writing a 1-hour ephemeral cache entry. */
  cacheWrite1h: number;
  cacheRead: number;
  /** Output, including the reasoning tokens that are a subset of it. */
  output: number;
};

/**
 * Fable 5's official prices. Anthropic quotes USD per million tokens; nano-USD
 * per token is that number divided by 1,000, and it is an exact integer for
 * every Fable price, which is why this unit was chosen over micro-USD.
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
 * A CLOSED table with no default entry. A model that is not here cannot be
 * priced, because the alternative is charging an unknown model at Fable's rate
 * and reporting a confident number that is wrong by an unknown factor.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrices>> =
  Object.freeze({
    [FABLE_5_MODEL_ID]: FABLE_5_PRICES,
  });

/**
 * Thrown when cost is asked for a model with no reviewed price row. A distinct
 * class so a caller can treat it as an operator-config failure rather than a
 * retryable one: retrying will not teach the table a new price.
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
  const prices = Object.hasOwn(MODEL_PRICES, modelId)
    ? MODEL_PRICES[modelId]
    : undefined;
  if (prices === undefined) throw new UnknownModelPriceError(modelId);
  return prices;
}

/* --------------------------------------------------------- the usage adapter -- */

export type NormalizedUsage = {
  inputTokens: number;
  noCacheTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

/**
 * The ONE place the AI SDK's usage shape is read.
 *
 * `ai`'s `LanguageModelUsage` is FLAT at the top with nested detail bags —
 * `{ inputTokens, inputTokenDetails: { noCacheTokens, cacheReadTokens,
 * cacheWriteTokens }, outputTokens, outputTokenDetails: { reasoningTokens },
 * totalTokens }` — every field `number | undefined`. It is NOT the
 * provider-level `LanguageModelV4Usage`, which nests its counters instead
 * (`inputTokens: { total, noCache, … }`). Two similar names, two different
 * shapes; `onStepEnd` receives the flat one. Reading one while assuming the
 * other silently produces zeroes, which reads as a free request.
 *
 * `undefined` becomes zero, and that is a deliberate claim: every field is a
 * COUNT of tokens in a class, so unreported and none are the same number. The
 * one place that would be wrong — a provider reporting no input detail at all —
 * is handled in `costNanoUsd`, which charges the unclassified remainder.
 */
export function normalizeUsage(
  usage: LanguageModelUsage | undefined
): NormalizedUsage {
  const input = usage?.inputTokenDetails;
  const output = usage?.outputTokenDetails;

  const normalized: NormalizedUsage = {
    inputTokens: toCount(usage?.inputTokens),
    noCacheTokens: toCount(input?.noCacheTokens),
    cacheReadTokens: toCount(input?.cacheReadTokens),
    cacheWriteTokens: toCount(input?.cacheWriteTokens),
    outputTokens: toCount(usage?.outputTokens),
    reasoningTokens: toCount(output?.reasoningTokens),
    totalTokens: toCount(usage?.totalTokens),
  };

  if (normalized.totalTokens === 0) {
    // `inputTokens` is the TOTAL input, of which the three detail fields are
    // subsets, so the total is input plus output. Adding the subsets again
    // would double-count, and `reasoningTokens` is a subset of output.
    normalized.totalTokens = normalized.inputTokens + normalized.outputTokens;
  }
  return normalized;
}

function toCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return 0;
  return Math.round(value);
}

/* ------------------------------------------------------------------ charging -- */

/** Which cache TTL the request configured. `agent-prompt.ts` uses `5m`. */
export type CacheWriteTtl = "5m" | "1h";

/**
 * Whether the provider actually bills this response.
 *
 * `none` exists for one real case: Fable can return HTTP 200 with raw stop
 * reason `refusal` before emitting any output, and Anthropic does not bill it.
 * Usage is still reported and still recorded — the money goes to zero, not the
 * telemetry.
 */
export type Billing = "normal" | "none";

export type CostBreakdown = {
  totalNanoUsd: number;
  noCacheNanoUsd: number;
  cacheReadNanoUsd: number;
  cacheWriteNanoUsd: number;
  /** Input counted in `inputTokens` that no detail field claimed. */
  unclassifiedInputNanoUsd: number;
  outputNanoUsd: number;
  unclassifiedInputTokens: number;
};

/**
 * What one completed step cost, broken down.
 *
 * The counting rule, which exists so no token is charged twice:
 *
 *  - each classified input class is charged once at its own rate;
 *  - any REMAINDER of `inputTokens` beyond what the detail fields classified is
 *    charged once at the plain input rate — so a provider that reports only a
 *    total is billed correctly rather than for free, and one that classifies
 *    everything has a remainder of zero rather than a second full charge;
 *  - `reasoningTokens` is a diagnostic SUBSET of `outputTokens` and is never
 *    added, or every thinking token would be billed twice.
 *
 * The remainder is clamped at zero: Anthropic's wire format reports
 * `input_tokens` EXCLUDING cache reads and writes, so a future adapter change
 * could make the subsets exceed the reported total.
 */
export function costBreakdown(input: {
  modelId: string;
  usage: NormalizedUsage;
  cacheWriteTtl?: CacheWriteTtl;
  billing?: Billing;
}): CostBreakdown {
  // The lookup happens even when billing is `none`, so an unknown model fails
  // closed on a refusal too instead of being quietly accepted at zero.
  const prices = pricesFor(input.modelId);
  const { usage } = input;

  const classified =
    usage.noCacheTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
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

  if (input.billing === "none") return breakdown;

  breakdown.totalNanoUsd =
    breakdown.noCacheNanoUsd +
    breakdown.cacheReadNanoUsd +
    breakdown.cacheWriteNanoUsd +
    breakdown.unclassifiedInputNanoUsd +
    breakdown.outputNanoUsd;
  return breakdown;
}

/** What one step cost, as one integer. */
export function costNanoUsd(
  modelId: string,
  usage: LanguageModelUsage | undefined
): number {
  return costBreakdown({ modelId, usage: normalizeUsage(usage) }).totalNanoUsd;
}

/** What the steps completed so far in this turn have cost. */
export function spentNanoUsd(
  modelId: string,
  steps: ReadonlyArray<Pick<StepResult<ToolSet>, "usage">>
): number {
  return steps.reduce(
    (total, step) => total + costNanoUsd(modelId, step.usage),
    0
  );
}

/* ------------------------------------------------------------------ ceilings -- */

/**
 * What one turn may spend: $5.00.
 *
 * The reviewed figure from the deleted loop, kept because the evidence behind it
 * is still true: a full drill run — reproduce, fix, format, diff, file the
 * issue, open the pull request — bills around $1, and the runs that failed
 * under a $2 cap failed one tool call short of the pull request having already
 * done the work. Overridable per deployment through `RUN_SPEND_CEILING_NANO_USD`.
 */
export const DEFAULT_SPEND_CEILING_NANO_USD = 5 * NANO_USD_PER_USD;

/**
 * What the preflight must assume it will pay for an input token: the worst rate
 * in the table, because which class the NEXT step's input lands in is not known
 * until it has been bought.
 */
export function worstCaseInputRate(prices: ModelPrices): number {
  return Math.max(prices.input, prices.cacheWrite5m, prices.cacheWrite1h);
}

/**
 * How conservatively encoded prompt bytes become a token estimate.
 *
 * Real English through Anthropic's tokenizer runs near four bytes per token, and
 * JSON evidence with many short tokens nearer three. Two is the reviewed
 * conservative floor: it over-estimates typical traffic by about 2x, which is
 * the direction that protects the ceiling. Not a proof — a prompt of entirely
 * single-byte tokens would still exceed it — and that residual is the one
 * documented overshoot source.
 */
export const CONSERVATIVE_BYTES_PER_TOKEN = 2;

/** Output tokens below which a step is not worth buying at all. */
export const MIN_USEFUL_OUTPUT_TOKENS = 256;

/**
 * The worst this step can cost if the estimate holds: the whole prompt charged
 * at the most expensive input rate, plus a full output allowance.
 */
export function worstCaseStepNanoUsd(input: {
  modelId: string;
  promptBytes: number;
  maxOutputTokens: number;
}): number {
  const prices = pricesFor(input.modelId);
  const estimatedInputTokens = Math.ceil(
    input.promptBytes / CONSERVATIVE_BYTES_PER_TOKEN
  );
  return (
    estimatedInputTokens * worstCaseInputRate(prices) +
    input.maxOutputTokens * prices.output
  );
}

export type SpendDecision = { allow: true } | { allow: false; reason: string };

/**
 * Whether to buy the next step.
 *
 * The test is `spent + estimate`, not `spent` alone: a ceiling checked only
 * against what has already been billed is always one step behind, and the step
 * that crosses it is exactly the one that was never refused.
 *
 * A ceiling of zero is UNBOUNDED, not "refuse everything". The var is optional
 * and an absent var must not wedge every run.
 */
export function spendDecision(input: {
  spentNanoUsd: number;
  ceilingNanoUsd: number;
  estimateNanoUsd: number;
}): SpendDecision {
  if (input.ceilingNanoUsd <= 0) return { allow: true };
  const projected = input.spentNanoUsd + input.estimateNanoUsd;
  if (projected <= input.ceilingNanoUsd) return { allow: true };
  return {
    allow: false,
    reason: `spend ceiling: ${input.spentNanoUsd} already spent, next step could reach ${projected}, ceiling ${input.ceilingNanoUsd} (nano-USD)`,
  };
}

/**
 * The stop condition that actually ends the turn.
 *
 * `beforeStep` cannot: `StepConfig` has no stop field. This runs after each
 * step, sums what the turn has billed and stops once it is at or over the
 * ceiling — so a turn that blows through the preflight (a single enormous step)
 * still terminates, rather than being asked politely not to continue.
 */
export function spendStopWhen(
  modelId: string,
  ceilingNanoUsd: number
): StopCondition<ToolSet> {
  return ({ steps }) => {
    if (ceilingNanoUsd <= 0) return false;
    return spentNanoUsd(modelId, steps) >= ceilingNanoUsd;
  };
}

/**
 * Read the ceiling from the environment.
 *
 * Names a variable, never a value, in the failure: an unparseable setting falls
 * back to the reviewed default rather than to unbounded, because a typo in an
 * operator's var must not remove the money bound.
 */
export function spendCeilingFrom(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "")
    return DEFAULT_SPEND_CEILING_NANO_USD;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    return DEFAULT_SPEND_CEILING_NANO_USD;
  return parsed;
}
