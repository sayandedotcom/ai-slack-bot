import { Hono } from "hono";
import type { Env } from "../index";
import { getRunById, listRuns, readRunUsage, RUN_LIST_MAX_LIMIT } from "../run/repository";
import { decimalNanoUsd } from "../run/money";
import { isRunStatus, type RunStatus } from "../run/protocol";
import type { RunRecord } from "../run/repository";

export const runsApi = new Hono<{ Bindings: Env }>();

/**
 * The public run shape. `key` is absent everywhere in this file: dashboard URLs
 * carry `runs.id`, the Worker looks the key up server-side, and that is what
 * keeps the Durable Object name format changeable later.
 */
function publicRun(run: RunRecord) {
  return {
    id: run.id,
    origin: run.origin,
    status: run.status,
    shadow: run.shadow,
    summary: run.summary,
    channelId: run.channelId,
    threadTs: run.threadTs,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function fail(code: string, message: string) {
  // No stack traces and no internal keys — errors cross to the browser.
  return { code, message };
}


/** D1 only. This must never wake a Durable Object, or the list costs one wake per row. */
runsApi.get("/runs", async (c) => {
  const statusParam = c.req.query("status");
  let status: RunStatus | undefined;
  if (statusParam !== undefined) {
    if (!isRunStatus(statusParam)) {
      return c.json(fail("invalid_status", "unknown run status"), 400);
    }
    status = statusParam;
  }

  const limitParam = c.req.query("limit");
  let limit: number | undefined;
  if (limitParam !== undefined) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > RUN_LIST_MAX_LIMIT) {
      return c.json(fail("invalid_limit", `limit must be 1..${RUN_LIST_MAX_LIMIT}`), 400);
    }
    limit = parsed;
  }

  return c.json({ runs: await listRuns(c.env.DB, { status, limit }) });
});



/**
 * What this run has spent, from D1 alone.
 *
 * NO DURABLE OBJECT IS WOKEN. `agent_model_calls` is the queryable projection
 * of the local step rows (invariant 32), so this route costs one indexed read
 * whether the run is hibernating, streaming, or finished a month ago.
 *
 * `costUsd` is a DECIMAL STRING derived from the integer nano-USD sum, never a
 * float (invariant 29). A JSON number cannot hold nano-USD precision — 0.1 + 0.2
 * is the canonical demonstration — and a dashboard that adds up floats produces
 * a bill nobody can defend. The client renders the string; it never does
 * arithmetic on it.
 *
 * Withheld deliberately, though the columns are right there: `provider`,
 * `provider_request_id` and `gateway_log_id`. Those are internal debugging
 * handles into the AI Gateway's own logs, and the Gateway log id in particular
 * is the key to a record that may contain request metadata. The browser gets
 * token counts, a call count and a cost.
 */
runsApi.get("/runs/:id/usage", async (c) => {
  const run = await getRunById(c.env.DB, c.req.param("id"));
  if (!run) return c.json(fail("not_found", "no such run"), 404);

  const rows = await readRunUsage(c.env.DB, run.id);
  return c.json({
    usage: rows.map((row) => ({
      model: row.model,
      calls: row.calls,
      inputTokens: row.inputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      outputTokens: row.outputTokens,
      costUsd: decimalNanoUsd(row.costNanoUsd),
    })),
    // Summed as integers and formatted once, so the total is exact rather than
    // the sum of rounded per-model strings.
    totalCostUsd: decimalNanoUsd(rows.reduce((sum, row) => sum + row.costNanoUsd, 0)),
  });
});


