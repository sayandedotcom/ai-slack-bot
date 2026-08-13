import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  installRunPorts,
  resetRunPorts,
  resolveRunPorts,
  type RunPorts,
} from "../src/agent/driver";
import {
  modelDisposition,
  productionRunPorts,
  resetProductionPortsMemo,
} from "../src/agent/ports";
import { ABSENT_MODEL_CONFIGURATION_CODES, memoryOutboxIdFor } from "../src/agent/contracts";
import {
  createProductionModelFactory,
  ModelCompositionError,
  type ModelEnv,
} from "../src/agent/model";
import { runStubForKey } from "../src/run/keys";
import { countModelSteps, readGenerationMemory, recordStepUsage } from "../src/run/session";
import type { MemoryJob } from "../src/memory/consumer";
import type { Env } from "../src/index";
import type { RunDO } from "../src/run/do";
import type { RunServerMessage } from "../src/run/protocol";
import { customerTurn, freshLoopRun, mockModel, textStep } from "./helpers/agent-loop";
import { connect, syncedCursor, waitFor } from "./helpers/run-ws";

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

    expect(report).toEqual({
      continuationInstalled: true,
      status: "ready",
      missingConfiguration: [],
    });
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

    expect(report.continuationInstalled).toBe(true);
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

    expect(report.continuationInstalled).toBe(false);
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
      const report = modelDisposition({
        ...configuredEnv(),
        AGENT_MODEL_DISABLED: raw,
      } as unknown as Env);
      expect(report.continuationInstalled).toBe(false);
    }
    for (const raw of ["", "yes", "0", "false", "disabled"]) {
      const report = modelDisposition({
        ...configuredEnv(),
        AGENT_MODEL_DISABLED: raw,
      } as unknown as Env);
      expect(report.continuationInstalled).toBe(true);
    }
  });

  /**
   * THE FIRST OF THE TWO GUARDS THAT KEEP THIS SUITE OFF THE REAL MODEL.
   *
   * `.dev.vars` is loaded by this pool and holds a LIVE `ANTHROPIC_API_KEY`.
   * While absence parked, that was survivable; now that absence composes, the
   * pool-wide opt-out is what stops a RunDO built from the POOL env from
   * installing the production continuation. If somebody removes it from
   * vitest.config.ts, this fails.
   *
   * It is not the whole story, and the case below is the rest of it: any test
   * that builds its own env object and installs the production continuation
   * from it bypasses this flag entirely, and several in this repo do.
   */
  it("parks model work for the test pool's own env", () => {
    const { ports, report } = productionRunPorts(env as unknown as Env);

    expect(report.status).toBe("disabled_by_configuration");
    expect(ports.continuation).toBeUndefined();
  });

  /**
   * THE GUARD THAT ACTUALLY CANNOT BE BYPASSED.
   *
   * `AGENT_MODEL_DISABLED` only protects a composition that reads the POOL env.
   * It protects nothing at all for a call site that builds its own env and
   * installs the production continuation explicitly — key-scoped or GLOBAL, in
   * this file or any other. No count is given, because the count is not the
   * property: such a continuation resolves its env AT CALL TIME from the Durable
   * Object (`do.ts`, `ports.continuation?.(this.ctx, this.env)`), so what it
   * composes against is THIS pool env, opt-out or no opt-out, however many of
   * them there happen to be today.
   *
   * So the line that cannot be defeated is the one below: with the two Gateway
   * settings bound EMPTY, `createProductionModelFactory` throws
   * `missing_gateway_url` before `createAnthropic` is ever constructed, and no
   * provider request can be built no matter which env installed the port or how
   * many alarm dispatches a test loops over.
   *
   * The binding is what makes it true, not `.dev.vars`. Miniflare bindings
   * override `.dev.vars`, which is the same mechanism that already keeps
   * `ZEP_API_KEY` off the production memory graph — so the day somebody creates
   * the private AI Gateway and puts these two settings in `.dev.vars` (a KNOWN
   * DEFERRED operator step for this repo), the empty bindings still win.
   */
  it("binds the pool's Gateway settings empty, so no test env can compose a real provider", () => {
    // Empty STRING, not undefined: `undefined` would mean the binding is gone
    // and the pool is inheriting whatever `.dev.vars` happens to hold.
    expect(env.AI_GATEWAY_ANTHROPIC_URL).toBe("");
    expect(env.AI_GATEWAY_TOKEN).toBe("");

    // The same fixture precedence, pinned for the other live credential the
    // wired ports can now reach: vitest.config.ts's explicit miniflare binding
    // must win over the real key in `.dev.vars`, or a settled generation in any
    // suite writes episodes into the production memory graph.
    expect(env.ZEP_API_KEY).toBe("zep-test-key");

    // And the consequence, stated as the composer states it. This is the env a
    // globally installed production continuation would actually be handed.
    //
    // WHICH code comes back depends on whether this machine's `.dev.vars` fills
    // in `ANTHROPIC_API_KEY` (CI has no `.dev.vars` at all), so the assertion is
    // that composition refuses for ABSENT configuration — never that it got as
    // far as building a provider.
    let thrownCode: string | null = null;
    try {
      createProductionModelFactory(env as unknown as ModelEnv);
    } catch (error) {
      thrownCode =
        error instanceof ModelCompositionError
          ? error.code
          : `unexpected:${String(error)}`;
    }
    expect(ABSENT_MODEL_CONFIGURATION_CODES).toContain(thrownCode);
  });

  /**
   * THE BIDIRECTIONAL PIN ON `ABSENT_MODEL_CONFIGURATION_CODES`.
   *
   * The case above is one-directional and single-sample: it observes ONE thrown
   * code (whichever this machine's `.dev.vars` leaves absent first) and checks
   * containment. Adding a fourth code to the list, or deleting one of the three,
   * failed nothing — and that list is what decides whether a config-killed run
   * can ever be revived, so a drifting entry is either a run that stays dead
   * forever or a run revived onto a value that will fail again on every wake.
   *
   * This closes both directions against the REAL composer:
   *
   *  - FORWARD — blanking any required setting throws a code that is IN the
   *    list, so a newly required setting cannot fail with a code the resume path
   *    does not know about;
   *  - REVERSE — the set of codes the composer actually produces this way EQUALS
   *    the list, so an entry nobody can reach (a typo, a code that moved) fails
   *    here instead of sitting in a resume allow-list forever.
   *
   * The required settings are taken from `modelDisposition`'s own report rather
   * than retyped, so a fourth required setting joins this case automatically.
   */
  it("pins the absent-configuration codes, in both directions, against the real composer", () => {
    // An empty env is missing everything, so the report names the whole required
    // set. This is `ports.ts`'s list, read out rather than duplicated here.
    const required = modelDisposition({} as unknown as Env).missingConfiguration;
    expect(required).not.toHaveLength(0);

    // CONTROL. With every setting present the composer returns a factory, so a
    // throw below is caused by the ONE setting that case blanked and not by
    // something ambient (an unpriced default model, a malformed fixture URL).
    expect(() =>
      createProductionModelFactory(configuredEnv() as unknown as ModelEnv),
    ).not.toThrow();

    const observed = required.map((name) => {
      const env = { ...configuredEnv(), [name]: "" } as unknown as ModelEnv;
      try {
        createProductionModelFactory(env);
        return { name, code: "did_not_throw" };
      } catch (error) {
        return {
          name,
          code:
            error instanceof ModelCompositionError ? error.code : `unexpected:${String(error)}`,
        };
      }
    });

    // FORWARD. Named per setting, so a failure says WHICH one drifted.
    for (const { name, code } of observed) {
      expect(ABSENT_MODEL_CONFIGURATION_CODES, `absent ${name}`).toContain(code);
    }

    // REVERSE. Nothing may sit in the list that no absent setting produces.
    expect([...new Set(observed.map((entry) => entry.code))].sort()).toEqual(
      [...ABSENT_MODEL_CONFIGURATION_CODES].sort(),
    );
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
 * WHAT HAPPENS TO EVERY RUN CLAIMED BEFORE THE SECRET LANDS.
 *
 * The case above is the intended behaviour: absence FAILS, terminally, naming
 * the setting (plan lines 965-966). But `requires_operator_config` is not
 * input-resumable — `isInputResumablePolicy`, and the gate in `scheduleInput` —
 * so on the first production deploy of this wiring, every run claimed between
 * "the code shipped" and "the operator created the private AI Gateway" was dead
 * FOREVER. Not paused. Not retried later. Dead, including after the operator did
 * the exact thing the error code asked them to do.
 *
 * Nothing in the plan requires that. Line 655 says `requires_operator_config` is
 * woken by "explicit operator/config reset, never ordinary input" — supplying
 * the configuration IS the reset, and the behaviour this wiring replaced
 * (`continuation: null`) was explicitly recoverable: "the first alarm after the
 * Gateway is created picks the run up exactly where it was left".
 *
 * These cases pin the restored property and, just as importantly, everything it
 * must NOT do.
 */
describe("absent configuration is terminal, but not irreversible", () => {
  /** A real run, really claimed, really failed on a really-absent Gateway. */
  async function killedByAbsentGateway() {
    const harness = await freshLoopRun({
      model: mockModel([textStep({ chunks: ["The 04:12 deploy dropped the export worker."] })]),
    });
    installRunPorts(productionRunPorts(unconfiguredEnv()).ports, { runKey: harness.key });

    await harness.stub.appendTurn(customerTurn("t1", "why are exports empty?"));
    expect((await harness.alarm()).model).toBe("claimed");

    const driver = await harness.stub.driver();
    expect(driver.phase).toBe("failed");
    expect(driver.lastErrorCode).toBe("missing_gateway_url");
    expect(driver.resumePolicy).toBe("requires_operator_config");

    // NOTHING WAS BILLED. `createProductionModelFactory` throws before the
    // provider, before `makeAgentTools` and before a single token, so recovery
    // cannot be re-billing work that never happened.
    expect(await harness.storage((storage) => countModelSteps(storage))).toBe(0);

    return { harness, deadGenerationId: driver.generationId };
  }

  /** Put the deployment's configuration in place, the way a deploy does. */
  async function operatorSuppliesConfiguration(harness: {
    key: string;
    ports: Partial<RunPorts>;
    stub: DurableObjectStub<RunDO>;
  }) {
    // The harness's own local ports (a mock provider, no network), plus the one
    // bit the constructor reads. This stands in for the real deploy, where
    // `productionRunPorts` sets `modelConfigured` from
    // `modelDisposition(env).status === "ready"`.
    installRunPorts({ ...harness.ports, modelConfigured: true }, { runKey: harness.key });
    // A secret landing IS a new deployment: every object is torn down and
    // rebuilt. That reconstruction is the moment the run can notice.
    await evictDurableObject(harness.stub);
  }

  it("comes back on the first construction after the configuration lands, and answers", async () => {
    const { harness, deadGenerationId } = await killedByAbsentGateway();

    await operatorSuppliesConfiguration(harness);

    // Reconstructed by this very call. The constructor's recovery ran before
    // `#armAlarm()`, so there is a generation for the alarm to arm for.
    const revived = await harness.stub.driver();
    expect(revived.phase).toBe("scheduled");
    expect(revived.resumePolicy).toBeNull();
    expect(revived.lastErrorCode).toBeNull();
    // A FRESH generation. The dead one already froze its immutable episode and
    // enqueued its memory-outbox job; reviving it in place would strand both as
    // a lie about a generation that went on to succeed.
    expect(revived.generationId).not.toBe(deadGenerationId);

    // ...and it actually answers the message it was killed holding.
    await harness.alarm();
    const settled = await harness.stub.driver();
    expect(settled.phase).toBe("idle");

    const turns = await harness.stub.turns();
    const answer = turns.find((turn) => turn.role === "assistant");
    expect(answer?.content).toContain("04:12");
  });

  /**
   * WHAT A CONNECTED DASHBOARD SEES WHEN THE RUN COMES BACK.
   *
   * The constructor's resume commits a `live` status event. Before this case
   * existed that event was computed, committed and then DROPPED — the return
   * value of `resumeAfterOperatorConfig` was discarded — on the justification
   * that "a cold object has no sockets yet". That justification is false for
   * this object: it hibernates its sockets (`ctx.acceptWebSocket`), so a tab
   * that was open when the deployment rolled is still attached when the
   * constructor runs and `ctx.getWebSockets()` hands it straight back there.
   *
   * The failure this pins was survivable, not silent-forever — the event is in
   * the log and the next broadcast re-syncs the tab — but "the run you are
   * watching says `failed` until something else happens" is not what the
   * transition is for.
   */
  it("tells a socket that hibernated across the deploy that the run is live again", async () => {
    const { harness } = await killedByAbsentGateway();
    expect((await harness.stub.state())?.status).toBe("failed");

    const socket = await connect(harness.stub);
    const cursor = await syncedCursor(socket);

    installRunPorts({ ...harness.ports, modelConfigured: true }, { runKey: harness.key });
    // `webSockets: "hibernate"` and not a plain evict: this is the state a real
    // open dashboard is in across a deployment, and it is the state in which the
    // reconstructed object genuinely does have sockets attached.
    await evictDurableObject(harness.stub, { webSockets: "hibernate" });

    // Reconstructs the object; the constructor's resume runs inside this call.
    expect((await harness.stub.driver()).phase).toBe("scheduled");

    const frame = (await waitFor(
      socket,
      (m) => m.type === "event" && m.event.type === "status" && m.event.seq > cursor,
    )) as Extract<RunServerMessage, { type: "event" }>;
    expect(frame.event).toMatchObject({
      type: "status",
      previousStatus: "failed",
      status: "live",
    });
  });

  it("stays dead while the deployment is still unconfigured", async () => {
    const { harness, deadGenerationId } = await killedByAbsentGateway();

    // A redeploy that STILL has no Gateway. `modelConfigured` is false, which is
    // what stops this from becoming a rearm loop against a config that cannot
    // fix itself: every wake of an unconfigured deployment does nothing at all.
    installRunPorts({ ...harness.ports, modelConfigured: false }, { runKey: harness.key });
    await evictDurableObject(harness.stub);

    const driver = await harness.stub.driver();
    expect(driver.phase).toBe("failed");
    expect(driver.generationId).toBe(deadGenerationId);
    expect(driver.lastErrorCode).toBe("missing_gateway_url");
  });

  it("is not resumed by an ordinary message, even once the configuration is there", async () => {
    const { harness } = await killedByAbsentGateway();

    // The policy is unchanged and is still enforced where it always was.
    const blocked = await harness.stub.appendTurn(customerTurn("t2", "any update?"));
    expect(blocked.scheduling.outcome).toBe("blocked");

    installRunPorts({ ...harness.ports, modelConfigured: true }, { runKey: harness.key });
    // No eviction: the operator has not deployed anything, so nothing has
    // reconstructed this object. A message alone must not reach into the reset.
    const stillBlocked = await harness.stub.appendTurn(customerTurn("t3", "hello?"));
    expect(stillBlocked.scheduling.outcome).toBe("blocked");
    expect((await harness.stub.driver()).phase).toBe("failed");
  });

  /**
   * THE TWO DISCRIMINATIONS THAT KEEP THIS NARROW.
   *
   * `requires_operator_config` also covers a RUN SPEND CEILING, and the whole
   * reason that policy is not input-resumable is that no ordinary event may
   * restart spending a cap stopped. And `invalid_gateway_url` means the setting
   * was PRESENT and wrong, which a presence check cannot see — a run revived on
   * a malformed value would fail on it again on every single wake.
   *
   * Both are excluded by `ABSENT_MODEL_CONFIGURATION_CODES`, and both are
   * checked here by changing exactly one thing: the persisted error code.
   */
  it.each(["cost_limit", "invalid_gateway_url", "unpriced_model"])(
    "refuses to revive a %s failure, which carries the same policy",
    async (errorCode) => {
      const { harness, deadGenerationId } = await killedByAbsentGateway();

      // ONE variable changed. Everything else — phase, policy, cursors, the
      // pending input — is exactly the state the case above revives from.
      await harness.storage((storage) =>
        storage.sql.exec(
          "UPDATE agent_driver SET last_error_code = ? WHERE singleton = 1",
          errorCode,
        ),
      );

      await operatorSuppliesConfiguration(harness);

      const driver = await harness.stub.driver();
      expect(driver.phase).toBe("failed");
      expect(driver.generationId).toBe(deadGenerationId);
      expect(driver.resumePolicy).toBe("requires_operator_config");
    },
  );

  it("refuses to revive a failure whose input was already settled", async () => {
    const { harness, deadGenerationId } = await killedByAbsentGateway();

    // Nothing is owed. Reviving here would put the model back over a transcript
    // that has no unanswered question in it.
    await harness.storage((storage) =>
      storage.sql.exec(
        "UPDATE agent_driver SET settled_through_seq = pending_through_seq WHERE singleton = 1",
      ),
    );

    await operatorSuppliesConfiguration(harness);

    const driver = await harness.stub.driver();
    expect(driver.phase).toBe("failed");
    expect(driver.generationId).toBe(deadGenerationId);
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
