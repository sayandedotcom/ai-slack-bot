import { Hono } from "hono";
import type { Env } from "../index";
import { createRunFromChat, resolveChassis } from "../run/chassis";
import { runStubForKey } from "../run/keys";
import { getRunById, listRuns, readRunUsage, RUN_LIST_MAX_LIMIT } from "../run/repository";
import { decimalNanoUsd } from "../agent/cost";
import { modelDisposition } from "../agent/ports";
import { isRunStatus, parseClientMessage, type RunStatus } from "../run/protocol";
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

/**
 * Phase 25, gap 6. Refuse a LEGACY-ONLY route when the deployment runs Think.
 *
 * Three routes in this file reach `RunDO` through `runStubForKey` — the run
 * snapshot, the steer, and the socket. On `RUN_CHASSIS=think` the session that
 * owns the run is a `RunAgent`, and `RunDO` for the same key is an empty object
 * that will answer every one of them successfully: the snapshot returns zero
 * events and a default driver for a run that is mid-incident, and the steer is
 * accepted, stored, and never read by anything. A silent wrong answer, which is
 * the exact failure `wakeRun`/`createRunFromChat` exist to prevent — so these
 * refuse by NAME instead.
 *
 * The dashboard never reaches here on Think: it asks `/api/chassis` on load and
 * renders `AgentSession` against `/agents/*`. This guard is for the callers the
 * SPA is not — a curl, a stale bundle a browser still has cached, a future
 * script — and it is the mirror image of the `chassis !== "think"` refusal on
 * `/agents/*` in `src/index.ts`. Same code, same status: a route that is not
 * part of this deployment is a 404, not a 500.
 *
 * Returns the body and status to send, or `null` to continue.
 */
function refuseIfThink(env: Env): { body: { code: string; message: string }; status: 404 | 500 } | null {
  let chassis: string;
  try {
    chassis = resolveChassis(env);
  } catch {
    // Names the variable, never its value (invariant 39 applied uniformly).
    return {
      body: fail("invalid_chassis", "RUN_CHASSIS is not a recognised value"),
      status: 500,
    };
  }
  if (chassis !== "think") return null;
  return {
    body: fail("chassis_not_active", "this deployment runs the think run chassis"),
    status: 404,
  };
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

runsApi.post("/runs", async (c) => {
  let body: Record<string, unknown> = {};
  try {
    const parsed = await c.req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // An empty body is a valid "just start a run".
  }

  const firstMessage = typeof body.firstMessage === "string" ? body.firstMessage : undefined;
  if (firstMessage !== undefined && firstMessage.trim().length === 0) {
    return c.json(fail("empty_content", "firstMessage must not be blank"), 400);
  }
  const requestId = typeof body.requestId === "string" ? body.requestId : undefined;

  // Through the chassis facade, NOT `createChatRun` directly. Under
  // `RUN_CHASSIS=think` the direct call created the run in `RunDO` while the
  // dashboard opened the `RunAgent` this id resolves to, so the opening message
  // was silently never answered. The Access and roster checks on this route are
  // unchanged; only the session the turn lands in is.
  const run = await createRunFromChat(c.env, { firstMessage, requestId });
  return c.json({ run: publicRun(run) }, 201);
});

runsApi.get("/runs/:id", async (c) => {
  const refused = refuseIfThink(c.env);
  if (refused) return c.json(refused.body, refused.status);

  const run = await getRunById(c.env.DB, c.req.param("id"));
  // Looked up in D1 first, so an unknown id cannot instantiate an object.
  if (!run) return c.json(fail("not_found", "no such run"), 404);

  const sinceParam = c.req.query("since");
  let since = 0;
  if (sinceParam !== undefined) {
    const parsed = Number(sinceParam);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return c.json(fail("invalid_since", "since must be a non-negative integer"), 400);
    }
    since = parsed;
  }

  const stub = runStubForKey(c.env.RUNS, run.key);
  const snapshot = await stub.snapshot(since);
  // This route already woke the object for its events, so the driver state is
  // free here. It is deliberately NOT on `GET /api/runs`, which must stay
  // D1-only: adding it there would cost one Durable Object wake per listed row.
  //
  // `publicDriver()` constructs the browser-safe shape inside the object. This
  // route never sees a lease timestamp, the claim epoch, the generation id, the
  // agent turn id (the Code Mode effect scope), the run key, or any error
  // message — see the note on that method.
  const driver = await stub.publicDriver();
  return c.json({
    run: publicRun(run),
    driver,
    // WHY A `scheduled` RUN IS NOT MOVING, if it is not moving.
    //
    // `driver.state` cannot answer that on its own: a run parked because this
    // deployment has no continuation installed and a run genuinely waiting its
    // turn are both `scheduled` with `error: null`, and telling them apart used
    // to require reading isolate logs. This is a pure function of `env` — no
    // Durable Object wake, no D1 read — and it carries configuration NAMES and
    // a status code only, never a configured value (invariant 39).
    //
    // Deliberately a SIBLING of `driver` rather than a field inside it: the
    // public driver shape is exactly four keys, is asserted to be exactly four
    // keys, and describes THIS RUN. This describes the deployment.
    model: modelDisposition(c.env),
    events: snapshot.events,
    cursor: snapshot.cursor,
    complete: snapshot.complete,
  });
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

/**
 * HTTP fallback for steering, for a dashboard whose socket has dropped. Shares
 * the `steer:{requestId}` id with the socket path, so a client that retries
 * over HTTP after an unacknowledged socket send does not steer twice.
 */
runsApi.post("/runs/:id/turns", async (c) => {
  const refused = refuseIfThink(c.env);
  if (refused) return c.json(refused.body, refused.status);

  const run = await getRunById(c.env.DB, c.req.param("id"));
  if (!run) return c.json(fail("not_found", "no such run"), 404);

  let raw: string;
  try {
    raw = JSON.stringify({ ...(await c.req.json()), type: "steer" });
  } catch {
    return c.json(fail("invalid_json", "body must be JSON"), 400);
  }

  // Same parser as the socket, so role/source cannot be supplied here either.
  const parsed = parseClientMessage(raw);
  if (!parsed.ok) return c.json(fail(parsed.code, parsed.message), 400);

  // No pre-emptive setStatus: the `live` transition happens inside the append's
  // own transaction, so a steer cannot leave the run advertising a loop that
  // the driver's resume policy will refuse to start.
  const stub = runStubForKey(c.env.RUNS, run.key);

  const result = await stub.appendTurn({
    id: `steer:${parsed.message.requestId}`,
    role: "user",
    source: "human_steer",
    content: parsed.message.content,
  });

  return c.json({ seq: result.event.seq, appended: result.appended }, 201);
});

/**
 * The live socket. Mounted separately from /api because it is not JSON, but it
 * sits behind the same Cloudflare Access application as the dashboard — it is
 * NOT in the bypass policy that exists for /slack/events.
 */
export const runsWs = new Hono<{ Bindings: Env }>();

runsWs.get("/run/:id", async (c) => {
  const refused = refuseIfThink(c.env);
  if (refused) return c.json(refused.body, refused.status);

  const run = await getRunById(c.env.DB, c.req.param("id"));
  if (!run) return c.json(fail("not_found", "no such run"), 404);

  const stub = runStubForKey(c.env.RUNS, run.key);
  // Forward the raw request so the upgrade, and ?since=, reach the object
  // untouched.
  return stub.fetch(c.req.raw);
});
