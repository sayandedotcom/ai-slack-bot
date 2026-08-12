import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { installRunPorts, resetRunPorts, resolveRunPorts } from "../src/agent/driver";
import { productionRunPorts } from "../src/agent/ports";
import { memoryOutboxIdFor } from "../src/agent/contracts";
import { runStubForKey } from "../src/run/keys";
import { readGenerationMemory, recordStepUsage } from "../src/run/session";
import type { MemoryJob } from "../src/memory/consumer";
import type { Env } from "../src/index";
import { customerTurn, freshLoopRun, mockModel, textStep } from "./helpers/agent-loop";

/**
 * THE PHASE-WIDE GAP THIS TASK EXISTS TO CLOSE.
 *
 * Before Task 10, `installRunPorts` had ZERO production call sites. Task 7's
 * `makeAgentContinuation` — the real model loop — and Task 9's
 * `makeMemoryOutboxRunner` were both built, both reviewed, both green, and both
 * unreachable in a deploy: the shipping RunDO ran with `continuation: null`
 * (model work parked forever) and with no `memory_outbox` runner (every memory
 * projection parked instead of being delivered). Every test installed its own
 * ports, so nothing noticed.
 *
 * These cases are the standing proof that the wiring is real. If somebody
 * deletes the constructor call, or the ports module, or drops a projection
 * kind, this file fails rather than the deploy silently going quiet.
 */

afterEach(() => {
  resetRunPorts();
});

/** An env whose model configuration is present, so the continuation installs. */
function configuredEnv(): Env {
  return {
    ...env,
    ANTHROPIC_API_KEY: "sk-ant-test",
    AI_GATEWAY_ANTHROPIC_URL: "https://gateway.ai.cloudflare.com/v1/acct/ff/anthropic",
    AI_GATEWAY_TOKEN: "cf-aig-test",
  } as unknown as Env;
}

function unconfiguredEnv(): Env {
  return { ...env, ANTHROPIC_API_KEY: "", AI_GATEWAY_ANTHROPIC_URL: "", AI_GATEWAY_TOKEN: "" } as unknown as Env;
}

describe("the production ports", () => {
  it("installs a continuation and both projection runners when the model is configured", () => {
    const { ports, report } = productionRunPorts(configuredEnv());

    expect(report.modelEnabled).toBe(true);
    expect(typeof ports.continuation).toBe("function");
    // The two kinds whose absence parks durable work. `run_index` is not here
    // on purpose: the RunDO owns that one directly, because it needs env.DB and
    // the coalescing drain.
    expect(typeof ports.projections?.memory_outbox).toBe("function");
    expect(typeof ports.projections?.d1_usage).toBe("function");
  });

  it("parks model work — but still delivers projections — with no gateway configured", () => {
    const { ports, report } = productionRunPorts(unconfiguredEnv());

    expect(report.modelEnabled).toBe(false);
    expect(report.modelDisabledReason).toContain("AI_GATEWAY_ANTHROPIC_URL");
    expect(ports.continuation).toBeUndefined();

    // The important half of parking: a deployment that cannot call the model
    // must still drain the memory and usage work its earlier runs committed,
    // or a missing secret quietly becomes lost telemetry and lost memory.
    expect(typeof ports.projections?.memory_outbox).toBe("function");
    expect(typeof ports.projections?.d1_usage).toBe("function");
  });

  it("installs globally, so a keyed test fake still wins for its own run", () => {
    installRunPorts(productionRunPorts(configuredEnv()).ports);
    installRunPorts({ continuation: null }, { runKey: "chat:scoped" });

    expect(resolveRunPorts("chat:other").continuation).not.toBeNull();
    expect(resolveRunPorts("chat:scoped").continuation).toBeNull();
  });
});

describe("the installed continuation is the real loop", () => {
  /**
   * The whole path, from a durable alarm to `makeAgentContinuation`, with no
   * mock in it anywhere.
   *
   * A fresh run gets THE PRODUCTION PORTS — not a fake — and a customer turn.
   * The alarm claims the generation, resolves the port, awaits the deferred
   * module load, and enters `composeAndRun`, which resolves the trusted context
   * and then asks the model factory for a handle. The object's own env has no
   * Gateway, so `createProductionModelFactory` refuses there.
   *
   * That refusal is the assertion. `missing_gateway_url` is a string only
   * `createProductionModelFactory` produces, and the only way it can reach this
   * run's driver state is if the production port genuinely ran the production
   * loop. A parked continuation would have left the phase `scheduled` with no
   * error at all, which is exactly the pre-Task-10 behaviour.
   *
   * And note what it is NOT: not a crash, not a retry. `infrastructure_exhausted`
   * becomes a terminal `requires_operator_config`, so a misconfigured deploy
   * points an operator at the setting instead of burning three attempts.
   */
  it("reaches makeAgentContinuation through a real alarm, and fails closed on the model", async () => {
    const harness = await freshLoopRun({ model: mockModel([textStep({ chunks: ["unused"] })]) });

    // Replace the harness's fake with the production ports for this run only.
    installRunPorts(productionRunPorts(configuredEnv()).ports, { runKey: harness.key });

    await harness.stub.appendTurn(customerTurn("t1", "why are exports empty?"));
    const outcome = await harness.alarm();

    expect(outcome.model).toBe("claimed");

    const driver = await harness.stub.driver();
    expect(driver.phase).toBe("failed");
    expect(driver.lastErrorCode).toBe("missing_gateway_url");
    expect(driver.resumePolicy).toBe("requires_operator_config");
  });
});

describe("the installed projection runners are the real ones", () => {
  /**
   * `makeMemoryOutboxRunner`, obtained from the production registry rather than
   * constructed by the test, delivering a real frozen episode.
   *
   * The queue is faked by handing the factory an env whose `MEMORY_QUEUE` is a
   * recorder. That is the ONE substitution: the storage, the frozen episode,
   * the D1 outbox row and the run state are all real. A real send here would
   * reach the memory consumer and, through it, Zep — a network call this suite
   * is not allowed to make.
   */
  it("delivers a frozen episode through the registered memory_outbox factory", async () => {
    const harness = await freshLoopRun({
      model: mockModel([textStep({ chunks: ["The 04:12 deploy."] })]),
    });
    await harness.stub.appendTurn(customerTurn("t1", "why are exports empty?"));
    await harness.alarm();

    const generationId = await harness.storage(
      (storage) =>
        storage.sql.exec<{ id: string }>("SELECT id FROM agent_generations LIMIT 1").toArray()[0]
          .id,
    );
    const outboxId = memoryOutboxIdFor(harness.runId, generationId);

    const sent: MemoryJob[] = [];
    const queueEnv = {
      ...configuredEnv(),
      MEMORY_QUEUE: { send: async (job: MemoryJob) => void sent.push(job) },
    } as unknown as Env;

    const factory = productionRunPorts(queueEnv).ports.projections?.memory_outbox;
    expect(factory).toBeDefined();

    const outcome = await runInDurableObject(
      runStubForKey(env.RUNS, harness.key),
      async (_instance, doState) => {
        // Frozen locally by the generation's finalization; the runner's job is
        // to get it to D1 and then to the queue, in that order.
        expect(readGenerationMemory(doState.storage, generationId)).not.toBeNull();
        return factory!(doState, queueEnv).run({
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
    expect(sent).toEqual([{ kind: "agent_generation", outboxId }]);

    // The D1 row exists and was written BEFORE the send — the ordering that
    // makes a failed enqueue sweepable rather than lost.
    const row = await env.DB.prepare(
      "SELECT state FROM agent_memory_outbox WHERE id = ?",
    )
      .bind(outboxId)
      .first<{ state: string }>();
    expect(row?.state).toBe("pending");
  });

  /**
   * The other half of the same gap. Without a `d1_usage` runner the local step
   * rows never reach `agent_model_calls`, and every cost figure the dashboard
   * can show is zero while the money is genuinely being spent.
   */
  it("projects a billed step into agent_model_calls through the registered d1_usage factory", async () => {
    const harness = await freshLoopRun({
      model: mockModel([textStep({ chunks: ["ok"] })]),
    });
    const productionEnv = configuredEnv();
    const factory = productionRunPorts(productionEnv).ports.projections?.d1_usage;
    expect(factory).toBeDefined();

    const usageId = await runInDurableObject(
      runStubForKey(env.RUNS, harness.key),
      async (_instance, doState) => {
        const recorded = recordStepUsage(doState.storage, {
          generationId: "gen:ports",
          agentTurnId: "agent:gen:ports",
          attempt: 1,
          globalStep: 0,
          provider: "anthropic",
          model: "claude-fable-5",
          usage: {
            inputTokens: 120,
            noCacheTokens: 100,
            cacheReadTokens: 20,
            cacheWriteTokens: 0,
            outputTokens: 40,
            reasoningTokens: 0,
            totalTokens: 160,
          },
          costNanoUsd: 1_234_567,
          latencyMs: 42,
        });
        return recorded.id;
      },
    );

    const outcome = await runInDurableObject(
      runStubForKey(env.RUNS, harness.key),
      async (_instance, doState) =>
        factory!(doState, productionEnv).run({
          job: {
            id: "job",
            kind: "d1_usage",
            sourceId: usageId,
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
        }),
    );

    expect(outcome).toEqual({ outcome: "delivered" });

    const row = await env.DB.prepare(
      "SELECT cost_nano_usd, input_tokens, model FROM agent_model_calls WHERE id = ?",
    )
      .bind(usageId)
      .first<{ cost_nano_usd: number; input_tokens: number; model: string }>();
    // Integer nano-USD all the way to D1 (invariant 29). No float anywhere.
    expect(row).toEqual({ cost_nano_usd: 1_234_567, input_tokens: 120, model: "claude-fable-5" });
    expect(Number.isInteger(row?.cost_nano_usd)).toBe(true);
  });

  it("drops rather than retries a usage job whose local row is gone", async () => {
    const harness = await freshLoopRun({ model: mockModel([textStep({ chunks: ["ok"] })]) });
    const productionEnv = configuredEnv();
    const factory = productionRunPorts(productionEnv).ports.projections?.d1_usage;

    const outcome = await runInDurableObject(
      runStubForKey(env.RUNS, harness.key),
      async (_instance, doState) =>
        factory!(doState, productionEnv).run({
          job: {
            id: "job",
            kind: "d1_usage",
            sourceId: "usage:nope:1:0",
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
        }),
    );

    // A retry would keep an alarm armed forever on work that can never be done.
    expect(outcome.outcome).toBe("dropped");
  });
});
