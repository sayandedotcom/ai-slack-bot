import {
  claimProjectionJob,
  completeProjectionJob,
  listPendingUsageProjections,
  markUsageProjected,
  readStepUsage,
  retryProjectionJob,
} from "../run/session";
import type { NormalizedUsage, StepUsageRecord } from "./contracts";

/**
 * Model-step telemetry: normalization, and the idempotent D1 projection of
 * locally recorded steps.
 *
 * RunDO records a completed step first; D1 is its queryable projection
 * (invariant 32). That order is not a preference — a D1 outage must never be a
 * reason to ask the provider for the same answer twice, because the second
 * request is billed exactly like the first one.
 *
 * Nothing here imports a provider SDK and nothing here handles a prompt, a
 * completion or a reasoning block. Cost calculation itself belongs to Task 5;
 * this module takes the integer nano-USD it is given.
 */

const USAGE_FIELDS = [
  "inputTokens",
  "noCacheTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens",
] as const;

export const ZERO_USAGE: NormalizedUsage = {
  inputTokens: 0,
  noCacheTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
};

function toCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.round(value);
}

/**
 * Coerce a provider usage bag into the seven integer token classes Fable cost
 * needs.
 *
 * Missing, negative, fractional and non-numeric values all become a
 * non-negative integer rather than throwing: a usage field the provider changed
 * the shape of must not lose the whole billed row, which is the only local
 * record that the money was spent. `totalTokens` is recomputed when the
 * provider does not supply a usable one, so the column is always self-consistent.
 */
export function normalizeUsage(raw: unknown): NormalizedUsage {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const usage = { ...ZERO_USAGE };
  for (const field of USAGE_FIELDS) {
    usage[field] = toCount(source[field]);
  }
  if (usage.totalTokens === 0) {
    // Cache reads and writes are billed input, so they belong in the total.
    usage.totalTokens =
      usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
  }
  return usage;
}

// --- D1 projection ----------------------------------------------------------

export type UsageProjectionOutcome = { outcome: "inserted" | "duplicate" };

/**
 * Insert one locally recorded step into the cross-run telemetry table.
 *
 * `INSERT OR IGNORE` against the unique step key, so an alarm that is delivered
 * twice, or a projector that crashed between the D1 write and the local
 * `d1_projected_at` mark, cannot bill the same step twice in the dashboard's
 * totals.
 *
 * The bound values are ids, token counts, cost and finish reasons. There is no
 * prompt, no completion, no tool body and no secret, by construction: the
 * record type has nowhere to put one.
 */
export async function projectStepUsageToD1(
  db: D1Database,
  runId: string,
  record: StepUsageRecord,
): Promise<UsageProjectionOutcome> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO agent_model_calls
         (id, run_id, generation_id, agent_turn_id, attempt, step_index, provider, model,
          provider_request_id, gateway_log_id, input_tokens, no_cache_tokens, cache_read_tokens,
          cache_write_tokens, output_tokens, reasoning_tokens, total_tokens, cost_nano_usd,
          latency_ms, finish_reason, raw_finish_reason, error_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.id,
      runId,
      record.generationId,
      record.agentTurnId,
      record.attempt,
      record.globalStep,
      record.provider,
      record.model,
      record.providerRequestId,
      record.gatewayLogId,
      record.usage.inputTokens,
      record.usage.noCacheTokens,
      record.usage.cacheReadTokens,
      record.usage.cacheWriteTokens,
      record.usage.outputTokens,
      record.usage.reasoningTokens,
      record.usage.totalTokens,
      record.costNanoUsd,
      record.latencyMs,
      record.finishReason,
      record.rawFinishReason,
      record.errorCode,
      record.createdAt,
    )
    .run();

  return { outcome: (result.meta.changes ?? 0) > 0 ? "inserted" : "duplicate" };
}

export type UsageDrainResult = {
  projected: number;
  failed: number;
  /** Local rows still waiting for D1 after this pass. */
  pending: number;
};

/**
 * Drain locally recorded steps into D1.
 *
 * A failure leaves the local row unmarked and the job pending, and returns
 * normally. It must not throw into the driver: the model loop's next decision
 * is never allowed to depend on whether telemetry reached D1.
 */
export async function projectPendingUsage(
  storage: DurableObjectStorage,
  db: D1Database,
  runId: string,
  options: { limit?: number; now?: number; backoffMs?: number } = {},
): Promise<UsageDrainResult> {
  const now = options.now ?? Date.now();
  const backoffMs = options.backoffMs ?? 30_000;
  const limit = Math.max(1, Math.floor(options.limit ?? 25));

  let projected = 0;
  let failed = 0;

  for (let drained = 0; drained < limit; drained += 1) {
    const claim = claimProjectionJob(storage, { kind: "d1_usage", now });
    if (claim.outcome !== "claimed") break;

    const record = readStepUsage(storage, claim.job.sourceId);
    if (!record || record.d1ProjectedAt !== null) {
      // The job names a row that is gone or already delivered. Retire it rather
      // than letting it spin forever.
      completeProjectionJob(storage, { id: claim.job.id, claimToken: claim.claimToken, now });
      continue;
    }

    try {
      await projectStepUsageToD1(db, runId, record);
      markUsageProjected(storage, record.id, Date.now());
      completeProjectionJob(storage, { id: claim.job.id, claimToken: claim.claimToken, now });
      projected += 1;
    } catch (error) {
      retryProjectionJob(storage, {
        id: claim.job.id,
        claimToken: claim.claimToken,
        backoffMs,
        error: error instanceof Error ? error.message : "d1 usage projection failed",
        now,
      });
      failed += 1;
      break;
    }
  }

  return { projected, failed, pending: listPendingUsageProjections(storage, 1_000).length };
}
