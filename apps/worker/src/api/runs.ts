import { Hono } from "hono";
import type { Env } from "../index";
import { isRunOrigin } from "../run/keys";
import { decimalNanoUsd } from "../run/money";
import { isRunStatus, type RunStatus } from "../run/protocol";
import type { RunRecord } from "../run/repository";
import {
  decodeRunCursor,
  getRunById,
  listRuns,
  RUN_LIST_MAX_LIMIT,
  readRunUsage,
} from "../run/repository";
import { createRunFromChat } from "../run/wake";
import { requireTeamMember } from "./identity";

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

const RUN_SEARCH_MAX_CHARS = 200;

/** D1 only. This must never wake a Durable Object, or the list costs one wake per row. */
runsApi.get("/runs", async (c) => {
  const member = await requireTeamMember(c);
  if (member instanceof Response) return member;

  const statusParam = c.req.query("status");
  let status: RunStatus | undefined;
  if (statusParam !== undefined) {
    if (!isRunStatus(statusParam)) {
      return c.json(fail("invalid_status", "unknown run status"), 400);
    }
    status = statusParam;
  }

  const originParam = c.req.query("origin");
  if (originParam !== undefined && !isRunOrigin(originParam)) {
    return c.json(fail("invalid_origin", "origin must be slack or chat"), 400);
  }

  const shadowParam = c.req.query("shadow");
  let shadow: boolean | undefined;
  if (shadowParam !== undefined) {
    if (shadowParam !== "true" && shadowParam !== "false") {
      return c.json(
        fail("invalid_shadow", "shadow must be true or false"),
        400
      );
    }
    shadow = shadowParam === "true";
  }

  const q = c.req.query("q")?.trim();
  if (q !== undefined && q.length > RUN_SEARCH_MAX_CHARS) {
    return c.json(
      fail("invalid_q", `q must be at most ${RUN_SEARCH_MAX_CHARS} characters`),
      400
    );
  }

  const cursor = c.req.query("cursor");
  if (cursor !== undefined && decodeRunCursor(cursor) === null) {
    return c.json(
      fail("invalid_cursor", "cursor is not one this endpoint issued"),
      400
    );
  }

  const limitParam = c.req.query("limit");
  let limit: number | undefined;
  if (limitParam !== undefined) {
    const parsed = Number(limitParam);
    if (
      !Number.isInteger(parsed) ||
      parsed < 1 ||
      parsed > RUN_LIST_MAX_LIMIT
    ) {
      return c.json(
        fail("invalid_limit", `limit must be 1..${RUN_LIST_MAX_LIMIT}`),
        400
      );
    }
    limit = parsed;
  }

  const page = await listRuns(c.env.DB, {
    status,
    origin: originParam,
    channelId: c.req.query("channelId") || undefined,
    shadow,
    q: q || undefined,
    cursor,
    limit,
  });
  return c.json(page);
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
  const member = await requireTeamMember(c);
  if (member instanceof Response) return member;

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
    totalCostUsd: decimalNanoUsd(
      rows.reduce((sum, row) => sum + row.costNanoUsd, 0)
    ),
  });
});

/* ------------------------------------------------------------- writes --- */

/** Bounds on what a browser may open a run with. */
export const CHAT_FIRST_MESSAGE_MAX_CHARS = 4_000;
export const CLIENT_REQUEST_ID_MAX_CHARS = 200;

type ChatCreateInput = {
  firstMessage: string;
  clientRequestId: string | undefined;
};

/**
 * Parse the create body, or `null` for any shape this route refuses.
 *
 * Bounded here rather than at the model: a create is the one entry point a
 * browser reaches with no prior run to charge against, so the cheapest place to
 * refuse an oversized opening is before anything is written.
 */
function parseChatCreate(body: unknown): ChatCreateInput | null {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return null;
  const record = body as Record<string, unknown>;

  const firstMessage = record.firstMessage;
  if (typeof firstMessage !== "string") return null;
  const trimmed = firstMessage.trim();
  if (trimmed === "" || trimmed.length > CHAT_FIRST_MESSAGE_MAX_CHARS)
    return null;

  const clientRequestId = record.clientRequestId;
  if (clientRequestId !== undefined) {
    if (typeof clientRequestId !== "string") return null;
    if (
      clientRequestId === "" ||
      clientRequestId.length > CLIENT_REQUEST_ID_MAX_CHARS
    )
      return null;
  }

  return {
    firstMessage: trimmed,
    clientRequestId: clientRequestId as string | undefined,
  };
}

/**
 * Start a run from the dashboard's chat page.
 *
 * Viewers reach this: a chat run has no customer thread, nothing it says goes
 * out under anyone's name, and every committal write is still gated by the
 * approval route. What a viewer must not do is decide an approval, and that is
 * enforced where it belongs (`PATCH /api/approvals/:id`).
 *
 * `clientRequestId` is carried all the way through: it derives the run's key,
 * so a retried create resolves to the SAME run, and it is the submission's
 * idempotency key, so the opening turn is admitted once. The response is the
 * public id and nothing else — never the `chat:{uuid}` key (invariant 10).
 */
runsApi.post("/runs", async (c) => {
  const member = await requireTeamMember(c);
  if (member instanceof Response) return member;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(fail("invalid_body", "body must be JSON"), 422);
  }

  const input = parseChatCreate(body);
  if (input === null) {
    return c.json(
      fail(
        "invalid_body",
        "firstMessage must be a non-empty string within the size limit"
      ),
      422
    );
  }

  const { runId } = await createRunFromChat(c.env, {
    firstMessage: input.firstMessage,
    // Recorded on the submission's metadata and nowhere else. Which engineer
    // opened a chat must not change what the model answers (invariant 12).
    actorEmail: member.email,
    requestId: input.clientRequestId,
  });

  return c.json({ id: runId }, 201);
});

/**
 * One run, by its public id. D1 only — rendering a run must not wake it.
 *
 * `publicRun` omits `key`, which is the whole reason it exists: the dashboard
 * addresses runs by UUID and the Worker resolves the Durable Object name
 * server-side.
 */
runsApi.get("/runs/:id", async (c) => {
  const member = await requireTeamMember(c);
  if (member instanceof Response) return member;

  const run = await getRunById(c.env.DB, c.req.param("id"));
  if (!run) return c.json(fail("not_found", "no such run"), 404);
  return c.json({ run: publicRun(run) });
});
