import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

import { turnTelemetry } from "../../src/run/agent-contract";
import { getRunById } from "../../src/run/repository";
import { createRunFromChat } from "../../src/run/wake";

/**
 * The agent's own traces are the SDK's: Think emits GenAI OTLP spans through
 * `wrapAISDK` and the Workers runtime exports them. There is no hand-written
 * writer, no `dotted_order`, and no flush.
 *
 * WHAT THIS FILE CAN AND CANNOT PIN, stated rather than implied. Span emission
 * is a deploy-side property — the OTLP destination is a dashboard setting no
 * Worker var and no test pool can reach — so nothing here proves a span was
 * sent. What it pins is the POLICY those spans carry, which is the half with
 * the security content: what payloads are attached, and whose identity is on
 * them.
 */

/**
 * Typed structurally, and not by the stub: `getAgentByName` without explicit
 * type arguments widens every method's return to `never`, which vitest would
 * not catch (it strips types) but `tsc --noEmit` does.
 */
type TracingPolicy = {
  storeTools: boolean;
  storeMessages: boolean;
  telemetry: { functionId?: string; metadata?: Record<string, unknown> };
};

async function boundRun() {
  const { runId } = await createRunFromChat(env, {});
  const run = await getRunById(env.DB, runId);
  const stub = (await getAgentByName(
    env.RUN_AGENTS,
    run?.key ?? ""
  )) as unknown as {
    tracingPolicyForTest(): Promise<TracingPolicy>;
  };
  return { runId, key: run?.key ?? "", stub };
}

describe("what a span is allowed to carry", () => {
  it("attaches tool payloads and never message content", async () => {
    // `storeMessages` is all-or-nothing (`think.js:2827` hands both straight to
    // `wrapAISDK`), so there is no per-field switch that would keep the
    // customer's thread, the triage briefing and recalled memory out of a
    // third-party trace store. The conversation stays off the span; the
    // model-authored program and what the capabilities answered do not.
    const { stub } = await boundRun();
    const policy = await stub.tracingPolicyForTest();

    expect(policy.storeTools).toBe(true);
    expect(policy.storeMessages).toBe(false);
  });
});

describe("whose identity is on a span", () => {
  it("stamps the PUBLIC run id, never the durable object's name", async () => {
    // Think's default `agentId` is `this.name` (`think.js:2548`) — the private
    // run key. Left alone, every customer conversation would put
    // `slack:{channel}:{thread_ts}` into a trace store nobody greps, which is
    // invariant 10 broken somewhere it would never be noticed.
    const { runId, key, stub } = await boundRun();
    const policy = await stub.tracingPolicyForTest();

    expect(policy.telemetry.metadata).toMatchObject({ agentId: runId, runId });
    expect(JSON.stringify(policy.telemetry)).not.toContain(key);
  });

  it("names the agent, not the class, as the traced function", async () => {
    const { stub } = await boundRun();
    expect((await stub.tracingPolicyForTest()).telemetry.functionId).toBe(
      "run-agent"
    );
  });

  it("carries the turn id, so a span joins the usage row that billed it", () => {
    const telemetry = turnTelemetry({
      runId: "run-1",
      turnId: "slack:Ev1",
    }) as {
      metadata?: Record<string, unknown>;
    };
    expect(telemetry.metadata).toEqual({
      agentId: "run-1",
      runId: "run-1",
      turnId: "slack:Ev1",
    });
  });
});

describe("what the tracing rewrite removed", () => {
  it("leaves no trace-emitter configuration behind", async () => {
    // The hand-written writer read all three. Nothing reads them now, and a var
    // that configures nothing is a var somebody will later assume still works.
    const bindings = env as unknown as Record<string, unknown>;
    expect(bindings.LANGSMITH_TRACING).toBeUndefined();
    expect(bindings.LANGSMITH_TRACE_PROJECT).toBeUndefined();
    expect(bindings.LANGSMITH_TRACE_PAYLOADS).toBeUndefined();
  });

  it("leaves the READ pins alone, because they are a different thing", async () => {
    // `src/langsmith/client.ts` reads a CUSTOMER's traces as a capability, in a
    // second project, in the same workspace. It shares only the key.
    const bindings = env as unknown as Record<string, unknown>;
    expect(bindings.LANGSMITH_PROJECT_NAME).toBe("fire-fighter-standin");
    expect(typeof bindings.LANGSMITH_PROJECT_ID).toBe("string");
  });
});
