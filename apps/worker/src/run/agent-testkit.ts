/**
 * The bodies of `RunAgent`'s test-only RPC surface.
 *
 * The METHODS have to stay on the class — a Durable Object stub resolves a call
 * by name off the instance, so a test surface that is not a method is not
 * reachable at all. What does not have to stay there is the reasoning: roughly
 * a page of it, explaining storage archaeology and RPC ergonomics, sitting in
 * the middle of the file that describes how a run is served. This module is
 * that half.
 *
 * Every function takes what it needs as arguments rather than the agent, so the
 * stub on the class stays a single line and nothing here can reach a field it
 * was not handed. None of it runs in production.
 */
import type { TurnConfig, TurnContext } from "@cloudflare/think";
import type { createWorkspaceTools } from "@cloudflare/think/tools/workspace";
import type { ToolSet } from "ai";

import { turnTelemetry } from "./agent-contract";

type WorkspaceLike = Parameters<typeof createWorkspaceTools>[0];

/**
 * The merged map Think would assemble for a turn.
 *
 * Built the way Think builds it, from the same three sources, because the
 * assertion it exists for is that the merge can never be one entry —
 * `createWorkspaceTools` is called unconditionally and always returns seven
 * file tools, so `activeTools` is the real control (invariant 5).
 */
export async function mergedToolNames(input: {
  workspace: WorkspaceLike;
  bash: boolean;
  own: ToolSet;
  session: ToolSet;
}): Promise<string[]> {
  const { createWorkspaceTools } = await import(
    "@cloudflare/think/tools/workspace"
  );
  return Object.keys({
    ...createWorkspaceTools(input.workspace, { bash: input.bash }),
    ...input.own,
    ...input.session,
  });
}

/**
 * Run the per-turn hook against a synthetic context and return the parts that
 * survive RPC. `TurnConfig` carries functions (`stopWhen`), so it cannot cross
 * a stub itself.
 */
export async function beforeTurnSummary(
  beforeTurn: (ctx: TurnContext) => Promise<TurnConfig>,
  assembledSystem: string
): Promise<{
  instructions: string;
  activeTools: string[];
  maxSteps: number;
}> {
  const config = await beforeTurn({ system: assembledSystem } as TurnContext);
  return {
    instructions: config.instructions ?? "",
    activeTools: [...(config.activeTools ?? [])],
    maxSteps: config.maxSteps ?? 0,
  };
}

/**
 * Run a hook and report how it ended.
 *
 * A throw crossing an RPC stub is logged by the runtime as an uncaught
 * exception even when the caller handles the rejection, which turns one
 * deliberate assertion into permanent suite noise. This keeps the throw inside
 * the object where it belongs.
 */
export async function outcomeOf(
  hook: () => Promise<void>
): Promise<string | null> {
  try {
    await hook();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * The whole of the agent's trace policy, as one readable value.
 *
 * Span EMISSION is a deploy-side property — the OTLP destination is a
 * dashboard setting, not anything a Worker var or the test pool can reach —
 * so what a test can pin from in here is the policy that decides what those
 * spans carry. That is the half with the security content.
 */
export function tracingPolicy(input: {
  storeTools: boolean;
  storeMessages: boolean;
  runId: string;
  turnId: string;
}): {
  storeTools: boolean;
  storeMessages: boolean;
  telemetry: { functionId?: string; metadata?: Record<string, unknown> };
} {
  return {
    storeTools: input.storeTools,
    storeMessages: input.storeMessages,
    telemetry: turnTelemetry({ runId: input.runId, turnId: input.turnId }) as {
      functionId?: string;
      metadata?: Record<string, unknown>;
    },
  };
}

/**
 * Every table in an agent's own SQLite that contains `needle`.
 *
 * ENUMERATED FROM `sqlite_master`, NEVER FROM A LIST OF NAMES. The tables that
 * matter here are not ours: Think creates the session tree, the submission
 * ledger, the chat fiber snapshots, the cached prompt store and the stream
 * chunk table, and the set changes when the SDK version does. A sweep over
 * names somebody wrote down by hand would keep passing after the SDK added the
 * table that leaks.
 *
 * A test surface, and only that — nothing in production calls it. It exists
 * because invariant 39 is a claim about storage nobody can see from outside the
 * object, and a claim nothing checks is a claim that quietly stops being true.
 */
export async function sweepForCanary(
  storage: DurableObjectStorage,
  state: unknown,
  needle: string
): Promise<string[]> {
  // `storage.sql.exec` and NOT the agent's `sql` tag. The tag binds every
  // interpolation as a PARAMETER, and SQLite has no bind slot for an
  // identifier — `FROM "${name}"` would run `FROM "?"`. A table name is not a
  // value, so it has to be concatenated, which is why the shape is checked
  // first even though sqlite_master is the only source it has.
  const raw = storage.sql;
  const tables = [
    ...raw.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC"
    ),
  ];

  const hits: string[] = [];
  for (const { name } of tables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    try {
      const rows = [...raw.exec(`SELECT * FROM "${name}"`)];
      if (rows.some((row) => JSON.stringify(row).includes(needle)))
        hits.push(name);
    } catch {
      // `_cf_KV` refuses direct SQL with SQLITE_AUTH: it is the key-value
      // surface the runtime reserves, and the agent's state lives in it.
      // Skipped here and swept below through the API that IS allowed to read
      // it, so the hole is covered rather than excused.
      hits.push(...(await sweepKeyValue(storage, state, needle, name)));
    }
  }
  return hits;
}

/**
 * The half of durable storage SQL cannot reach: the key-value surface, which is
 * where the agent's state and every scheduled callback's payload live.
 */
async function sweepKeyValue(
  storage: DurableObjectStorage,
  state: unknown,
  needle: string,
  label: string
): Promise<string[]> {
  const stored = await storage.list();
  const values = [...stored.values(), state];
  return values.some((value) => JSON.stringify(value ?? null).includes(needle))
    ? [label]
    : [];
}
