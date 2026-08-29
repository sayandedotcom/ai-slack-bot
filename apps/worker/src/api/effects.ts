import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { orm } from "../db/client";
import { codemodeEffects } from "../db/tables";
import type { Env } from "../index";
import { getRunById } from "../run/repository";
import { requireTeamMember } from "./identity";

/**
 * What a run actually did, from the effect ledger (`codemode_effects`).
 *
 * D1 only (invariant 7). The only payload column that crosses is
 * `safe_result_json`, which the capability layer already redacted before it
 * was written; `args_hash` and the effect key stay server-side — the hash is
 * over the model's arguments, and the arguments are customer text
 * (invariant 39).
 */
export const effectsApi = new Hono<{ Bindings: Env }>();

export const RUN_EFFECTS_MAX = 200;

function parseSafeResult(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json);
  } catch {
    // A row written before the envelope was JSON, or a truncated write. The
    // ledger is authoritative for idempotency, not for display; show nothing.
    return null;
  }
}

effectsApi.get("/runs/:id/effects", async (c) => {
  const member = await requireTeamMember(c);
  if (member instanceof Response) return member;

  const run = await getRunById(c.env.DB, c.req.param("id"));
  if (!run) return c.json({ code: "not_found", message: "no such run" }, 404);

  const results = await orm(c.env.DB)
    .select({
      turn_id: codemodeEffects.turn_id,
      namespace: codemodeEffects.namespace,
      method: codemodeEffects.method,
      state: codemodeEffects.state,
      safe_result_json: codemodeEffects.safe_result_json,
      safe_error: codemodeEffects.safe_error,
      created_at: codemodeEffects.created_at,
    })
    .from(codemodeEffects)
    .where(eq(codemodeEffects.run_id, run.id))
    .orderBy(desc(codemodeEffects.created_at))
    .limit(RUN_EFFECTS_MAX)
    .all();

  return c.json({
    effects: results.map((row) => ({
      turnId: row.turn_id,
      namespace: row.namespace,
      method: row.method,
      state: row.state,
      safeResult: parseSafeResult(row.safe_result_json),
      safeError: row.safe_error,
      createdAt: row.created_at,
    })),
  });
});
