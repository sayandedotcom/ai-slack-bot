import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/index";
import type { RunAgent } from "../src/run/agent";
import { drainSteers } from "../src/run/agent-steering";

/**
 * Invariants 12-13 in one case, because they are one property: a steer reaches
 * the next model step in the order it was typed, and reaches it once.
 *
 * `steer()` is exercised over the stub — that is the dashboard's real path, an
 * Agents SDK `@callable` — while the drain runs inside the object, because
 * `beforeStep` is the only production caller of `drainSteers` and it holds the
 * live instance. A fresh key per case: pool storage is shared across tests and
 * files, so a reused key would inherit another case's queue.
 */
describe("RunAgent steering", () => {
  it("splices queued steers in insertion order and drains each exactly once", async () => {
    const stub = await getAgentByName<Env, RunAgent>(
      env.RUN_AGENTS,
      `chat:${crypto.randomUUID()}`,
    );

    expect(await stub.steer("check the staging logs first")).toEqual({ queued: 1 });
    expect(await stub.steer("and mention the workaround")).toEqual({ queued: 2 });

    // Order is the insertion sequence, never the timestamp — both of the above
    // can land inside the same millisecond.
    const spliced = await runInDurableObject(stub, (agent: RunAgent) => drainSteers(agent, []));
    expect(spliced.map((message) => message.content)).toEqual([
      "check the staging logs first",
      "and mention the workaround",
    ]);

    // Drained, not merely read: the second step must not re-show the model a
    // correction it has already acted on.
    const again = await runInDurableObject(stub, (agent: RunAgent) => drainSteers(agent, []));
    expect(again).toEqual([]);
  });
});
