import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetRunPorts } from "../src/agent/driver";
import { gatewayHeaders } from "../src/agent/gateway";
import {
  listEvents,
  listTurns,
  readGeneration,
  readGenerationMemory,
  readModelTranscript,
} from "../src/run/session";
import {
  customerTurn,
  freshLoopRun,
  mockModel,
  textStep,
  toolStep,
} from "./helpers/agent-loop";

/**
 * Secret canaries: recognizable fake values in every host-adapter credential
 * field, and a sweep of everything the run produced.
 *
 * Every value below is SYNTHETIC and obviously so — the word `canary` is in each
 * one, and each is unique so a match names the field it came from rather than
 * just proving "something leaked". No real credential appears in this file, and
 * these are injected into THIS test's own env, never into the pool's: the pool's
 * `AI_GATEWAY_ANTHROPIC_URL: ""` / `AI_GATEWAY_TOKEN: ""` bindings are what stop
 * any suite from composing a real provider, and nothing here touches them.
 *
 * The property (invariant 39): secrets never enter prompts, Gateway metadata,
 * events, tool output, D1 telemetry, memory or logs. Metadata carries opaque
 * run/generation/attempt/step identifiers and nothing else.
 *
 * WHAT THIS DOES NOT COVER, stated so nobody reads more into a green run than is
 * there: the vendor gateways are faked at the `dependencies` seam, so a real
 * adapter that echoed its own credential into an error string would not be
 * caught HERE. That half is covered by `agent-composer.test.ts` > "reaches no
 * credential by walking the whole dependency object graph", which walks the real
 * object graph, and by `codemode-security.test.ts` > "exposes no credential,
 * binding or host env to model code". What this file adds is the other
 * direction: the host composition holds every credential and still leaks none of
 * them into anything the run produces.
 */

afterEach(() => {
  resetRunPorts();
  vi.restoreAllMocks();
});

/**
 * One canary per secret NAME that this Worker's env declares. Names only are
 * meaningful here; the values are fiction authored in this file.
 */
const CANARIES: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-canary-anthropic-0000000000000000",
  AI_GATEWAY_TOKEN: "cf-aig-canary-gateway-1111111111111111",
  SLACK_BOT_TOKEN: "xoxb-canary-slack-bot-2222222222222222",
  SLACK_SIGNING_SECRET: "canary-slack-signing-3333333333333333",
  LINEAR_API_KEY: "lin_api_canary-linear-4444444444444444",
  SUPABASE_KEY: "canary-supabase-key-5555555555555555",
  ZEP_API_KEY: "z_canary-zep-6666666666666666",
  LANGSMITH_API_KEY: "lsv2_canary-langsmith-7777777777777777",
  BETTERSTACK_SQL_USERNAME: "canary-betterstack-user-8888888888888888",
  BETTERSTACK_SQL_PASSWORD: "canary-betterstack-pass-9999999999999999",
  BETTERSTACK_UPTIME_TOKEN: "canary-betterstack-uptime-aaaaaaaaaaaaaaaa",
};

const CANARY_VALUES = Object.values(CANARIES);

/** A program that touches four namespaces, all against fake vendor ports. */
const BUSY_PROGRAM = `async () => {
  const found = await slack.searchMessages({ query: "exports" });
  const logs = await betterstack.logs({ query: "export", since: "2026-08-13T00:00:00Z" });
  const rows = await supabase.select({ table: "orders", columns: ["id"], limit: 1 });
  return { found: found.length, logs: logs.length, rows: rows.length };
}`;

function expectNoCanary(label: string, haystack: string): void {
  for (const [name, value] of Object.entries(CANARIES)) {
    if (haystack.includes(value)) {
      throw new Error(`${label} contains the ${name} canary`);
    }
  }
}

describe("no credential reaches anything the run produces", () => {
  it("CONTROL: the sweep can actually detect a planted canary", () => {
    // Without this, every assertion below passes just as happily against a sweep
    // that looks in the wrong place or compares against an empty list.
    for (const [name, value] of Object.entries(CANARIES)) {
      expect(() => expectNoCanary("a planted string", `prefix ${value} suffix`)).toThrow(name);
    }
    expect(() => expectNoCanary("a clean string", "nothing to find here")).not.toThrow();
  });

  it("sweeps the model call, events, turns, transcript, D1, memory and logs", async () => {
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => safeString(arg)).join(" "));
      });
    }

    const modelCalls: unknown[] = [];
    const harness = await freshLoopRun({
      origin: "slack",
      env: CANARIES,
      onModelCall: (callOptions) => modelCalls.push(callOptions),
      fixtures: {
        slackSearch: [
          { ts: "1.0", userId: "U1", text: "exports are empty", permalink: null, eventId: "ev_1" },
        ],
        logLines: [{ at: "2026-08-13T04:12:00Z", level: "error", message: "export worker gone" }],
        supabaseRows: [{ id: 1 }],
      },
      model: mockModel([
        toolStep({ toolCallId: "call_1", code: BUSY_PROGRAM, narration: ["Checking."] }),
        textStep({ chunks: ["The export worker was dropped at 04:12."] }),
      ]),
    });

    await harness.stub.appendTurn(customerTurn("t1", "why are the exports empty"));
    await harness.alarm();
    await harness.stub.flushProjections();
    expect(harness.results.at(-1)?.path).toBe("completed");

    /* --- what the model was actually sent -------------------------------- */

    expect(modelCalls.length).toBeGreaterThan(0);
    modelCalls.forEach((call, index) => {
      expectNoCanary(`provider call ${index}`, JSON.stringify(call));
    });

    /* --- the replayable event stream and the durable turns ---------------- */

    const events = await harness.storage((storage) => listEvents(storage, 0, 500));
    expectNoCanary("the RunEvent stream", JSON.stringify(events));
    const turns = await harness.storage((storage) => listTurns(storage));
    expectNoCanary("the durable turns", JSON.stringify(turns));

    /* --- the private model transcript ------------------------------------- */

    const transcript = await harness.storage((storage) => readModelTranscript(storage));
    expectNoCanary("the model transcript", JSON.stringify(transcript));

    /* --- D1 telemetry ------------------------------------------------------ */

    const modelCallRows = await env.DB.prepare("SELECT * FROM agent_model_calls").all();
    expectNoCanary("agent_model_calls", JSON.stringify(modelCallRows.results));
    const runRows = await env.DB.prepare("SELECT * FROM runs WHERE id = ?")
      .bind(harness.runId)
      .all();
    expectNoCanary("the D1 runs row", JSON.stringify(runRows.results));

    /* --- the frozen memory episode and its sources ------------------------- */

    const generationId = harness.results
      .at(-1)!
      .finalTurnId!.replace(/^agent:/, "")
      .replace(/:final$/, "");
    const memory = await harness.storage((storage) => readGenerationMemory(storage, generationId));
    expect(memory).not.toBeNull();
    expectNoCanary("the frozen episode", memory!.episodeJson);
    expectNoCanary("the episode source mapping", memory!.sourceJson);

    const generation = await harness.storage((storage) => readGeneration(storage, generationId));
    expectNoCanary("the generation row", JSON.stringify(generation));

    /* --- logs --------------------------------------------------------------- */

    expectNoCanary("a log line", logged.join("\n"));
  });

  it("keeps a canary out of a capability's own failure message", async () => {
    // A program that fails: a Chat run has no conversation to reply into, so the
    // capability refuses. The refusal text is persisted AND shown, which makes it
    // one of the easier places for an adapter to echo a configuration value.
    const harness = await freshLoopRun({
      origin: "chat",
      env: CANARIES,
      model: mockModel([
        toolStep({ toolCallId: "call_1", code: 'async () => slack.reply({ text: "hi" })' }),
        textStep({ chunks: ["I could not post that."] }),
      ]),
    });
    await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    const events = await harness.storage((storage) => listEvents(storage, 0, 500));
    const toolEvents = events.filter((event) => event.type === "tool_call");
    expect(toolEvents.length).toBeGreaterThan(0);
    expectNoCanary("a tool failure event", JSON.stringify(toolEvents));

    // The result the MODEL read is the other half: an error-as-value carrying a
    // credential would leak into the next prompt rather than into the timeline.
    const transcript = await harness.storage((storage) => readModelTranscript(storage));
    expectNoCanary("the tool result the model read", JSON.stringify(transcript));
  });
});

describe("gateway metadata carries opaque identifiers only", () => {
  /**
   * Stated exactly, because the weaker true thing is worth more than the
   * stronger false one: `gatewayHeaders` validates the SHAPE of an identifier,
   * it does not detect a secret. Every canary above is `[A-Za-z0-9:_.-]`, so it
   * would satisfy `OPAQUE_ID` if a caller passed one as a run id — and several
   * do satisfy it, which is why this asserts a partition rather than "every
   * canary throws".
   *
   * That is the correct boundary. The run, generation and attempt identifiers
   * are minted by trusted host code and never derive from a credential; the
   * shape check exists to stop a slug, an email or a Slack coordinate becoming
   * metadata, and `agent-gateway.test.ts` covers those. The real defence against
   * a credential in metadata is that the composer never reads one into it, which
   * is what the whole-run sweep above measures.
   */
  it("accepts only shape-valid opaque identifiers, and says so honestly", () => {
    const shapeValid = CANARY_VALUES.filter((value) => /^[A-Za-z0-9:_.-]{1,128}$/.test(value));
    expect(shapeValid.length).toBeGreaterThan(0);
    for (const value of shapeValid) {
      expect(() =>
        gatewayHeaders({ run: value, generation: "gen:a", attempt: 1, surface: "chat" }),
      ).not.toThrow();
    }
    // Anything outside that alphabet — a prompt, an email, a spaced credential —
    // is refused.
    for (const value of CANARY_VALUES.map((canary) => canary.replace(/-/g, " "))) {
      expect(() =>
        gatewayHeaders({ run: value, generation: "gen:a", attempt: 1, surface: "chat" }),
      ).toThrow();
    }
  });

  it("emits no credential and no authorization header from the safe helper", () => {
    const headers = gatewayHeaders({
      run: "run_2f1c",
      generation: "gen:9ab3",
      attempt: 1,
      surface: "slack",
    });
    expectNoCanary("the safe gateway header map", JSON.stringify(headers));
    const names = Object.keys(headers).map((name) => name.toLowerCase());
    expect(names.some((name) => name.includes("authorization"))).toBe(false);
  });
});

/*
 * The last clause of Step 6 — "generated Code Mode declarations must still
 * contain no credential-shaped field" — is already proven, and is deliberately
 * NOT duplicated here:
 *
 *  - `codemode-dts.test.ts` > "never advertises a target, actor or credential
 *    argument" bans `token`, `apiKey`, `actor`, `channelId`, `threadTs`,
 *    `teamId`, `workspace`, `baseUrl` and `sql` from the rendered declarations;
 *  - `agent-composer.test.ts` > "names no credential, host or bucket in what the
 *    model is shown" sweeps the real tool description for the real env secrets.
 */

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
