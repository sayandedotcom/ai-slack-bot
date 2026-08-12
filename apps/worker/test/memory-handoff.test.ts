import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeMemoryOutboxRunner, generationIdFromOutboxId } from "../src/agent/memory";
import { readGenerationMemory } from "../src/run/session";
import { memoryOutboxIdFor } from "../src/agent/contracts";
import { runStubForKey } from "../src/run/keys";
import type { MemoryJob } from "../src/memory/consumer";
import { customerTurn, freshLoopRun, mockModel, textStep } from "./helpers/agent-loop";

/**
 * The local -> D1 -> queue handoff, in the order that makes enqueue failure
 * recoverable: the D1 row is created FIRST, the queue job is sent SECOND.
 *
 * The order is the property. If the send happened first, a crash in between
 * would leave a queue job pointing at a row that does not exist — and the
 * consumer would retry it until the queue gave up, with nothing to sweep. This
 * way round, a failed send leaves a durable D1 row the one-minute cron already
 * knows how to find.
 */

type SendResult = { sent: MemoryJob[]; fail: boolean };

function fakeQueue(state: SendResult): Queue<MemoryJob> {
  return {
    send: async (job: MemoryJob) => {
      if (state.fail) throw new Error("queue unavailable");
      state.sent.push(job);
    },
  } as unknown as Queue<MemoryJob>;
}

async function settledRun(origin: "slack" | "chat") {
  const harness = await freshLoopRun({
    origin,
    model: mockModel([textStep({ chunks: ["The 04:12 deploy."] })]),
  });
  await harness.stub.appendTurn(customerTurn("t1", "why are exports empty?"));
  await harness.alarm();
  const generationId = await harness.storage(
    (storage) =>
      storage.sql.exec<{ id: string }>("SELECT id FROM agent_generations LIMIT 1").toArray()[0].id,
  );
  return { harness, generationId };
}

describe("the memory outbox handoff", () => {
  it("parses the generation out of its own run's job id, and nothing else's", () => {
    expect(generationIdFromOutboxId("memory:run_1:gen:abc", "run_1")).toBe("gen:abc");
    expect(generationIdFromOutboxId("memory:run_2:gen:abc", "run_1")).toBeNull();
  });

  it("creates the D1 row before sending the queue job", async () => {
    const { harness, generationId } = await settledRun("slack");
    const state: SendResult = { sent: [], fail: false };
    const outboxId = memoryOutboxIdFor(harness.runId, generationId);

    const outcome = await runInDurableObject(
      runStubForKey(env.RUNS, harness.key),
      async (_instance, doState) => {
        const runner = makeMemoryOutboxRunner({
          storage: doState.storage,
          db: env.DB,
          queue: fakeQueue(state),
          origin: "slack",
          channelId: null,
          now: () => 5_000,
        });
        return runner.run({
          job: {
            id: "job",
            kind: "memory_outbox",
            sourceId: outboxId,
            state: "claimed",
            claimToken: "tok",
            leaseExpiresAt: null,
            attempts: 0,
            nextAttemptAt: 0,
            lastError: null,
            createdAt: 0,
            updatedAt: 0,
          },
          claimToken: "tok",
          runId: harness.runId,
        });
      },
    );

    expect(outcome).toEqual({ outcome: "delivered" });
    expect(state.sent).toEqual([{ kind: "agent_generation", outboxId }]);

    const row = await env.DB.prepare(
      "SELECT graph_id, state, episode_json FROM agent_memory_outbox WHERE id = ?",
    )
      .bind(outboxId)
      .first<{ graph_id: string; state: string; episode_json: string }>();
    expect(row?.state).toBe("pending");
    // No channel policy passed, so it fails closed to org rather than guessing.
    expect(row?.graph_id).toBe("org");
    expect(row?.episode_json).toContain("why are exports empty");
  });

  it("leaves the D1 row behind for the sweeper when the queue send fails", async () => {
    const { harness, generationId } = await settledRun("chat");
    const state: SendResult = { sent: [], fail: true };
    const outboxId = memoryOutboxIdFor(harness.runId, generationId);

    const outcome = await runInDurableObject(
      runStubForKey(env.RUNS, harness.key),
      async (_instance, doState) => {
        const runner = makeMemoryOutboxRunner({
          storage: doState.storage,
          db: env.DB,
          queue: fakeQueue(state),
          origin: "chat",
          channelId: null,
          now: () => 5_000,
        });
        return runner.run({
          job: {
            id: "job",
            kind: "memory_outbox",
            sourceId: outboxId,
            state: "claimed",
            claimToken: "tok",
            leaseExpiresAt: null,
            attempts: 0,
            nextAttemptAt: 0,
            lastError: null,
            createdAt: 0,
            updatedAt: 0,
          },
          claimToken: "tok",
          runId: harness.runId,
        });
      },
    );

    expect(outcome).toMatchObject({ outcome: "retry" });
    // The whole point: the durable row exists even though the send failed, so
    // the cron sweeper can recover it with no alarm and no queue involvement.
    const row = await env.DB.prepare(
      "SELECT state FROM agent_memory_outbox WHERE id = ?",
    )
      .bind(outboxId)
      .first<{ state: string }>();
    expect(row?.state).toBe("pending");

    // And the local generation is still marked pending, not projected, so the
    // alarm keeps the job alive too.
    const memory = await harness.storage((storage) =>
      readGenerationMemory(storage, generationId),
    );
    expect(memory?.state).toBe("pending");
  });

  it("drops a job whose generation has no frozen episode", async () => {
    const { harness } = await settledRun("chat");
    const state: SendResult = { sent: [], fail: false };

    const outcome = await runInDurableObject(
      runStubForKey(env.RUNS, harness.key),
      async (_instance, doState) => {
        const runner = makeMemoryOutboxRunner({
          storage: doState.storage,
          db: env.DB,
          queue: fakeQueue(state),
          origin: "chat",
          channelId: null,
        });
        return runner.run({
          job: {
            id: "job",
            kind: "memory_outbox",
            sourceId: memoryOutboxIdFor(harness.runId, "gen:does-not-exist"),
            state: "claimed",
            claimToken: "tok",
            leaseExpiresAt: null,
            attempts: 0,
            nextAttemptAt: 0,
            lastError: null,
            createdAt: 0,
            updatedAt: 0,
          },
          claimToken: "tok",
          runId: harness.runId,
        });
      },
    );

    expect(outcome).toMatchObject({ outcome: "dropped" });
    expect(state.sent).toEqual([]);
  });
});
