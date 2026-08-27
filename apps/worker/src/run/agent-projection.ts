/**
 * What the run layer writes to D1 while a turn is running: the status the
 * dashboard reads, and the money.
 *
 * Both are PROJECTIONS. The Durable Object is the session authority; D1 is the
 * index a list view can read without waking fifty objects. So both writers here
 * are conditional, and neither may fail a turn: a run that cannot update its
 * index row is still a run.
 */
import { evaluateTransition, type RunStatus } from "./protocol";
import { casRunStatus, getRunById } from "./repository";

export type ProjectionOutcome = { applied: boolean; reason?: string };

/**
 * Apply one status change, or refuse it.
 *
 * THE REFUSAL IS THE POINT. `evaluateTransition` already knows which changes are
 * legal; the defect this closes is that nothing consulted it on the projection
 * path, so a late `done -> idle` could reclaim a Slack thread the run had
 * already released and a new message would reach a finished session instead of
 * triage.
 *
 * Three distinct non-applications, named rather than collapsed into `false`:
 *
 *  - `run_not_found` — no row. The DO owns the session and must not fail
 *    because the index lagged.
 *  - `same_status` — idempotent. Writing anyway would burn an update and show
 *    as a phantom transition in every tab.
 *  - an illegal transition — reported with the pair, and nothing is written.
 *
 * The write itself is a COMPARE-AND-SET on the status we validated against, not
 * an unconditional UPDATE. Two projections racing would otherwise both read
 * `live`, both judge themselves legal, and the loser would overwrite the
 * winner's terminal state with a transition that was legal only against a row
 * that no longer exists.
 */
export async function projectStatus(
  db: D1Database,
  runId: string,
  to: RunStatus,
  now: number
): Promise<ProjectionOutcome> {
  const run = await getRunById(db, runId);
  if (run === null) return { applied: false, reason: "run_not_found" };

  const verdict = evaluateTransition(run.status, to);
  if (!verdict.ok) return { applied: false, reason: verdict.reason };
  if (!verdict.changed) return { applied: false, reason: "same_status" };

  const { applied } = await casRunStatus(db, runId, run.status, to, now);
  return applied
    ? { applied: true }
    : { applied: false, reason: "status_changed_concurrently" };
}

/**
 * One billed model step.
 *
 * Every token class is stored separately because they are priced separately: a
 * cache read is not a fresh input token, and summing them into one column makes
 * the bill unreconstructable. Cost is an INTEGER of nano-USD (invariant 29).
 */
export type UsageRow = {
  runId: string;
  /** The AI SDK generation this step belongs to (`StepResult.callId`). */
  generationId: string;
  /** The run turn, which is also the Code Mode effect scope. */
  agentTurnId: string;
  /** Recovery attempt. A re-run after an interruption is a distinct billed call. */
  attempt: number;
  stepIndex: number;
  provider: string;
  model: string;
  providerRequestId: string | null;
  gatewayLogId: string | null;
  inputTokens: number;
  noCacheTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costNanoUsd: number;
  latencyMs: number;
  finishReason: string | null;
  rawFinishReason: string | null;
  errorCode: string | null;
  createdAt: number;
};

/**
 * Record it, once.
 *
 * `INSERT OR IGNORE` against the unique `(generation_id, attempt, step_index)`
 * index is the idempotency, as a constraint rather than a convention: replaying
 * one step cannot double its cost, while a different attempt lands as the
 * distinct billed call it was.
 */
export async function recordUsage(
  db: D1Database,
  row: UsageRow
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO agent_model_calls (
         id, run_id, generation_id, agent_turn_id, attempt, step_index,
         provider, model, provider_request_id, gateway_log_id,
         input_tokens, no_cache_tokens, cache_read_tokens, cache_write_tokens,
         output_tokens, reasoning_tokens, total_tokens,
         cost_nano_usd, latency_ms, finish_reason, raw_finish_reason, error_code, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      usageRowId(row),
      row.runId,
      row.generationId,
      row.agentTurnId,
      row.attempt,
      row.stepIndex,
      row.provider,
      row.model,
      row.providerRequestId,
      row.gatewayLogId,
      row.inputTokens,
      row.noCacheTokens,
      row.cacheReadTokens,
      row.cacheWriteTokens,
      row.outputTokens,
      row.reasoningTokens,
      row.totalTokens,
      // Integers only. A float here would be a rounding error the first time
      // and a reconciliation ticket the ten-thousandth.
      Math.trunc(row.costNanoUsd),
      Math.trunc(row.latencyMs),
      row.finishReason,
      row.rawFinishReason,
      row.errorCode,
      row.createdAt
    )
    .run();
}

/**
 * The row's primary key, computed rather than random.
 *
 * A provider request id is METADATA, never an idempotency key: it changes on a
 * retry of the same logical step, so keying on it would record the retry as a
 * second billed call.
 */
export function usageRowId(
  row: Pick<UsageRow, "generationId" | "attempt" | "stepIndex">
): string {
  return `usage:${row.generationId}:${row.attempt}:${row.stepIndex}`;
}
