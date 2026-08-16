import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/index";
import type { RunAgent } from "../src/run/agent";
import { createOrGetRun } from "../src/run/repository";

/**
 * Invariant 32, in one assertion.
 *
 * This is the failure with no error attached: a late projection carrying an
 * OLDER revision overwrites a newer one, and the dashboard shows a finished run
 * as failed — or a failed run as live — with nothing thrown, nothing logged and
 * a `runs` row that looks perfectly well-formed. Only the guard on
 * `projection_seq` catches it, and only a real out-of-order pair proves the
 * guard is bound the way it reads.
 */
describe("RunAgent D1 projection", () => {
  it("advances the projection only when the sequence increases", async () => {
    // A FRESH key per case: pool storage is shared across tests and files.
    const key = `chat:${crypto.randomUUID()}`;
    // The projection targets an existing `runs` row by id — a `WHERE id = ?`
    // that matches nothing is a silent no-op, so the row has to be seeded here.
    const run = await createOrGetRun(env.DB, {
      key,
      origin: "chat",
      channelId: null,
      threadTs: null,
    });

    const agent = await getAgentByName<Env, RunAgent>(env.RUN_AGENTS, key);
    await agent.projectForTest({ seq: 5, status: "live", summary: "five" });
    // Lower sequence, and every field it carries differs — so an unguarded
    // UPDATE would be visible in all three columns.
    await agent.projectForTest({ seq: 4, status: "failed", summary: "four" });

    const row = await env.DB.prepare(
      "SELECT status, summary, projection_seq FROM runs WHERE id = ?",
    )
      .bind(run.id)
      .first<{ status: string; summary: string | null; projection_seq: number }>();

    expect(row?.projection_seq).toBe(5);
    expect(row?.status).toBe("live");
    expect(row?.summary).toBe("five");
  });
});
