import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { installRunPorts, resetRunPorts, resolveRunPorts } from "../src/agent/driver";
import {
  modelDisposition,
  productionRunPorts,
  resetProductionPortsMemo,
} from "../src/agent/ports";
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
 * These cases are the standing proof that the wiring is real, and they come in
 * two kinds, because the header this replaced claimed the second kind existed
 * when it did not:
 *
 *  - MOST cases install the ports by hand and prove `productionRunPorts` builds
 *    the right things. Those prove the composer is CORRECT. On their own they
 *    prove nothing whatever about anything CALLING it — a reviewer deleted
 *    `ensureRunPortsInstalled(env)` from the RunDO constructor and every one of
 *    them still passed.
 *  - ONE case, "the RunDO constructor is what installs them" at the bottom,
 *    calls `installRunPorts` NOWHERE and reads the registry after constructing
 *    a real object through the ordinary binding. That is the case that fails
 *    when the constructor call goes missing, and it is the only one that does.
 */

afterEach(() => {
  resetRunPorts();
});

/**
 * An env whose model configuration is present AND whose opt-out is cleared, so
 * the continuation installs.
 *
 * `AGENT_MODEL_DISABLED` is set for the whole pool (vitest.config.ts) — that is
 * what keeps this suite off the real model now that absence no longer parks —
 * so a test that wants the production continuation has to opt back in by name.
 */
function configuredEnv(): Env {
  return {
    ...env,
    AGENT_MODEL_DISABLED: "",
    ANTHROPIC_API_KEY: "sk-ant-test",
    AI_GATEWAY_ANTHROPIC_URL: "https://gateway.ai.cloudflare.com/v1/acct/ff/anthropic",
    AI_GATEWAY_TOKEN: "cf-aig-test",
  } as unknown as Env;
}

/** A deployed Worker that is missing its Gateway settings and never opted out. */
function unconfiguredEnv(): Env {
  return {
    ...env,
    AGENT_MODEL_DISABLED: "",
    ANTHROPIC_API_KEY: "",
    AI_GATEWAY_ANTHROPIC_URL: "",
    AI_GATEWAY_TOKEN: "",
  } as unknown as Env;
}

/** A deployment that has deliberately turned model work off. */
function disabledEnv(): Env {
  return { ...configuredEnv(), AGENT_MODEL_DISABLED: "true" } as unknown as Env;
}

describe("the production ports", () => {
  it("installs a continuation and both projection runners when the model is configured", () => {
    const { ports, report } = productionRunPorts(configuredEnv());

    expect(report).toEqual({ modelEnabled: true, status: "ready", missingConfiguration: [] });
    expect(typeof ports.continuation).toBe("function");
    // The two kinds whose absence parks durable work. `run_index` is not here
    // on purpose: the RunDO owns that one directly, because it needs env.DB and
    // the coalescing drain.
    expect(typeof ports.projections?.memory_outbox).toBe("function");
    expect(typeof ports.projections?.d1_usage).toBe("function");
  });

  /**
   * PLAN LINES 965-966: the production composer "fails startup/composition in
   * deployed production if the Gateway URL is absent".
   *
   * The gate this replaces did the opposite. It asked whether the Gateway was
   * configured and PARKED when it was not, so composition was never attempted
   * and therefore never failed: a deploy that forgot a secret showed a
   * dashboard full of `live` runs with `error: null` that would never move,
   * and the only signal was one `console.warn` per isolate.
   *
   * Absence now installs the continuation like any other deployment, and the
   * failure happens where a failure is legible — see the alarm case below,
   * which takes it all the way to a terminal `requires_operator_config`.
   */
  it("still composes — and so still fails — when the Gateway URL is absent and nothing opted out", () => {
    const { ports, report } = productionRunPorts(unconfiguredEnv());

    expect(report.modelEnabled).toBe(true);
    expect(report.status).toBe("configuration_incomplete");
    expect(report.missingConfiguration).toEqual([
      "ANTHROPIC_API_KEY",
      "AI_GATEWAY_ANTHROPIC_URL",
      "AI_GATEWAY_TOKEN",
    ]);
    expect(typeof ports.continuation).toBe("function");
  });

  it("names the one missing setting, and never its value", () => {
    const report = modelDisposition({
      ...configuredEnv(),
      AI_GATEWAY_ANTHROPIC_URL: "",
    } as unknown as Env);

    expect(report.status).toBe("configuration_incomplete");
    expect(report.missingConfiguration).toEqual(["AI_GATEWAY_ANTHROPIC_URL"]);
    // The report is served over HTTP. A configured VALUE must never be in it,
    // and neither must anything but a name and a code (invariant 39).
    expect(JSON.stringify(report)).not.toContain("sk-ant-test");
    expect(JSON.stringify(report)).not.toContain("cf-aig-test");
    expect(JSON.stringify(report)).not.toContain("gateway.ai.cloudflare.com");
  });

  it("parks model work — but still delivers projections — when explicitly disabled", () => {
    const { ports, report } = productionRunPorts(disabledEnv());

    expect(report.modelEnabled).toBe(false);
    expect(report.status).toBe("disabled_by_configuration");
    expect(ports.continuation).toBeUndefined();

    // The important half of parking: a deployment that cannot call the model
    // must still drain the memory and usage work its earlier runs committed,
    // or a missing secret quietly becomes lost telemetry and lost memory.
    expect(typeof ports.projections?.memory_outbox).toBe("function");
    expect(typeof ports.projections?.d1_usage).toBe("function");
  });

  it("disables only on an explicit 1 or true, so a typo fails loudly instead of parking", () => {
    for (const raw of ["true", "TRUE", " 1 "]) {
      expect(modelDisposition({ ...configuredEnv(), AGENT_MODEL_DISABLED: raw } as unknown as Env).modelEnabled).toBe(false);
    }
    for (const raw of ["", "yes", "0", "false", "disabled"]) {
      expect(modelDisposition({ ...configuredEnv(), AGENT_MODEL_DISABLED: raw } as unknown as Env).modelEnabled).toBe(true);
    }
  });

  /**
   * THE GUARD THAT KEEPS THIS SUITE OFF THE REAL MODEL.
   *
   * `.dev.vars` is loaded by this pool and holds a LIVE `ANTHROPIC_API_KEY`.
   * While absence parked, that was survivable; now that absence composes, the
   * only thing standing between the suite and a real Gateway call is the
   * pool-wide opt-out. If somebody removes it from vitest.config.ts, or fills
   * in the two Gateway settings locally, this fails before any money is spent.
   */
  it("parks model work for the test pool's own env", () => {
    const { ports, report } = productionRunPorts(env as unknown as Env);

    expect(report.status).toBe("disabled_by_configuration");
    expect(ports.continuation).toBeUndefined();

    // The same fixture precedence, pinned for the other live credential the
    // wired ports can now reach: vitest.config.ts's explicit miniflare binding
    // must win over the real key in `.dev.vars`, or a settled generation in any
    // suite writes episodes into the production memory graph.
    expect(env.ZEP_API_KEY).toBe("zep-test-key");
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

  /**
   * THE SAME PATH, REACHED FROM AN ENV THAT HAS NOTHING CONFIGURED — which is
   * the deployment plan lines 965-966 are about.
   *
   * The case above builds its ports from a CONFIGURED env and fails on the
   * object's own env, so it proved the composer fails; it could not prove that
   * a Worker deployed without the Gateway URL ever gets as far as composing.
   * Under the old presence gate this env produced no continuation at all, so
   * this run would have sat at `scheduled` with `error: null` forever. The
   * assertion is that it does not: it fails, terminally, naming the setting.
   */
  it("fails a deployment that is missing the Gateway URL, instead of parking it silently", async () => {
    const harness = await freshLoopRun({ model: mockModel([textStep({ chunks: ["unused"] })]) });

    installRunPorts(productionRunPorts(unconfiguredEnv()).ports, { runKey: harness.key });

    await harness.stub.appendTurn(customerTurn("t1", "why are exports empty?"));
    expect((await harness.alarm()).model).toBe("claimed");

    const driver = await harness.stub.driver();
    expect(driver.phase).toBe("failed");
    expect(driver.lastErrorCode).toBe("missing_gateway_url");
    expect(driver.resumePolicy).toBe("requires_operator_config");
  });
});

/**
 * THE ONLY CASE IN THIS FILE THAT COVERS THE PRODUCTION CALL SITE.
 *
 * Every other case hands `installRunPorts` the ports itself, which proves
 * `productionRunPorts` builds the right things and proves nothing about who
 * calls it. Deleting `ensureRunPortsInstalled(env)` from the RunDO constructor
 * left this whole file green while a deploy went quiet — the exact failure
 * Task 10 exists to prevent.
 *
 * So: this case calls `installRunPorts` NOWHERE. It empties the registry AND
 * the once-per-isolate memo, constructs a real RunDO through the ordinary
 * binding, and reads the registry back.
 *
 * `memory_outbox` is the probe rather than `continuation` on purpose. It is
 * registered in BOTH branches of `productionRunPorts`, so it does not depend on
 * whether this pool has model configuration or on the opt-out — the probe
 * measures the CALL, not the composition.
 */
describe("the RunDO constructor is what installs them", () => {
  it("installs the production ports on a fresh object, with no help from this test", async () => {
    resetRunPorts();
    // Without this the constructor's call is a memoized no-op — an earlier case
    // in this isolate already ran it — and the probe would fail even with the
    // wiring intact.
    resetProductionPortsMemo();

    const key = `chat:${crypto.randomUUID()}`;
    expect(resolveRunPorts(key).projections.memory_outbox).toBeUndefined();

    // Any entry point constructs the object; `driver()` is the cheapest.
    await runStubForKey(env.RUNS, key).driver();

    expect(resolveRunPorts(key).projections.memory_outbox).toBeDefined();
    expect(resolveRunPorts(key).projections.d1_usage).toBeDefined();
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
