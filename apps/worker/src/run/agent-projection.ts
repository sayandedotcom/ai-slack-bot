/**
 * What the run layer writes to D1 while a turn is running: the status the
 * dashboard reads, and the money.
 *
 * Both are PROJECTIONS. The Durable Object is the session authority; D1 is the
 * index a list view can read without waking fifty objects. So both writers here
 * are conditional, and neither may fail a turn: a run that cannot update its
 * index row is still a run.
 */
import type { StepContext } from "@cloudflare/think";

import { redact } from "../redact";
import { costBreakdown, FABLE_5_MODEL_ID, normalizeUsage } from "./agent-spend";
import { evaluateTransition, type RunStatus } from "./protocol";
import { casRunStatus, getRunById, setRunSummaryIfAbsent } from "./repository";

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
 * One finished step, as the row that bills it.
 *
 * A pure mapping, kept beside the writer rather than in the hook that calls it:
 * every field is a decision about what the bill is made of, and three of them
 * are the ones that have been gotten wrong before.
 *
 *  - `generationId` is the AI SDK's own id for the generation, which is what the
 *    unique index is keyed on together with attempt and step. `providerRequestId`
 *    is METADATA and never an idempotency key — it changes on a retry of the
 *    same logical step, so keying on it would record the retry as a second
 *    billed call.
 *  - `attempt` distinguishes a recovery re-run from a replay. A re-run after an
 *    interruption is a distinct billed call and must not collide with the first.
 *  - a pre-output refusal comes back HTTP 200 and Anthropic does not bill it, so
 *    the tokens are still recorded and the money is not.
 */
export function usageRowFrom(
  ctx: StepContext,
  ids: { runId: string; turnId: string; attempt: number; now: number }
): UsageRow {
  const usage = normalizeUsage(ctx.usage);
  const modelId = ctx.model?.modelId ?? FABLE_5_MODEL_ID;
  return {
    runId: ids.runId,
    generationId: ctx.callId,
    agentTurnId: ids.turnId,
    attempt: ids.attempt,
    stepIndex: ctx.stepNumber,
    provider: ctx.model?.provider ?? "anthropic",
    model: modelId,
    providerRequestId: ctx.response?.id ?? null,
    gatewayLogId: ctx.response?.headers?.["cf-aig-log-id"] ?? null,
    inputTokens: usage.inputTokens,
    noCacheTokens: usage.noCacheTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens,
    costNanoUsd: costBreakdown({
      modelId,
      usage,
      billing: ctx.finishReason === "content-filter" ? "none" : "normal",
    }).totalNanoUsd,
    latencyMs: Math.max(0, Math.round(ctx.performance?.stepTimeMs ?? 0)),
    finishReason: ctx.finishReason ?? null,
    rawFinishReason: ctx.rawFinishReason ?? null,
    errorCode: null,
    createdAt: ids.now,
  };
}

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

/* ------------------------------------------------------------- summary -- */

/**
 * How much of the opening question survives into the run list.
 *
 * 120 characters is a line, not a paragraph. The column sits in a table beside
 * a status and a timestamp, and anything longer either wraps — turning a
 * scannable list into a wall — or is clipped by CSS, which is the same
 * truncation done later and worse, because the browser cannot put the ellipsis
 * on a word boundary.
 */
export const RUN_SUMMARY_LIMIT = 120;

/**
 * Turn what a turn was asked into the run's one-line summary.
 *
 * Three things happen here and the ORDER of the first is load-bearing.
 *
 * `redact` runs FIRST, on the raw text, because this string is customer bytes
 * that reach D1 and then every dashboard tab. A customer who pastes a token
 * into a Slack thread — which is exactly what someone reporting a broken
 * webhook does — would otherwise have it copied out of `messages` into
 * `runs.summary`, a column no one thinks of as holding secrets. Truncating
 * first would be worse than not redacting at all: a half-token no pattern
 * matches any more is a secret that has been laundered past the sweep in
 * `test/canary-secrets.test.ts` rather than removed (invariant 39).
 *
 * Then whitespace collapses, because a pasted stack trace is one row in a
 * table, not twelve.
 *
 * Then it is bounded. `null` for a turn with nothing in it — an empty string
 * would be a summary that exists and says nothing, which the dashboard cannot
 * tell apart from a real one and so cannot fall back for.
 */
export function summaryFrom(asked: string): string | null {
  const line = redact(asked).replace(/\s+/g, " ").trim();
  if (line === "") return null;
  if (line.length <= RUN_SUMMARY_LIMIT) return line;
  return `${line.slice(0, RUN_SUMMARY_LIMIT - 1).trimEnd()}\u2026`;
}

/**
 * Project the opening question onto the run index, if the run has no summary.
 *
 * Deliberately NOT the model's job. Asking the agent to name its own thread
 * costs a turn, can be skipped, and produces nothing at all for the runs that
 * most need a label — the ones that failed on their first step. The text a
 * human actually typed is available before the model is called, is free, and is
 * the thing an operator scanning the list is looking for.
 *
 * Returns the outcome instead of throwing. `run_not_found` and
 * `summary_present` are both ordinary: the first is an index that has not
 * caught up, the second is every turn after the first.
 *
 * The `getRunById` read exists ONLY to tell those two apart. A conditional
 * UPDATE reports both as zero rows changed, and reporting "already has a
 * summary" for a run that has no row at all would hide a real disagreement
 * between the object and the index behind the most ordinary message there is.
 * `projectStatus` above reads for the same reason. The cost is one read on the
 * first turn of a run, because `#queueSummaryProjection` fires once per
 * instance — not one per turn.
 */
export async function projectSummary(
  db: D1Database,
  runId: string,
  asked: string
): Promise<ProjectionOutcome> {
  const summary = summaryFrom(asked);
  if (summary === null) return { applied: false, reason: "nothing_asked" };

  const run = await getRunById(db, runId);
  if (run === null) return { applied: false, reason: "run_not_found" };

  const { applied } = await setRunSummaryIfAbsent(db, runId, summary);
  return applied
    ? { applied: true }
    : { applied: false, reason: "summary_present" };
}
