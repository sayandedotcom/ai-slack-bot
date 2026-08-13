import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { resetRunPorts } from "../src/agent/driver";
import { makeSlackGateway } from "../src/slack/gateway";
import { listEvents, listToolCalls, listTurns, readModelTranscript } from "../src/run/session";
import {
  customerTurn,
  errorStep,
  freshLoopRun,
  mockModel,
  steerTurn,
  textStep,
  toolStep,
  type LoopHarness,
} from "./helpers/agent-loop";

/**
 * THE ANTI-CLASSIFIER PROOF (invariants 3 and 4).
 *
 * One scripted input from Chat and one from Slack/triage, through the SAME
 * scripted model and the SAME scripted tool result. After normalizing only
 * origin-specific trusted metadata, everything else must be byte-identical:
 * driver and generation transitions, model transcript roles, the assistant
 * update protocol, the outer/nested tool update structure, the usage schema and
 * the failure semantics.
 *
 * This is the standing guard against the shape this project must never take: a
 * `handleSlackAgent` beside a `handleChatAgent`, or a branch on whether a
 * message reads like a bug, a question, a feature, a small thing or a large
 * one. Origin is presentation context. It is allowed to change how the final
 * text is LABELLED — Slack's is internal narration, because customer output
 * happens only through `slack.reply` — and nothing else.
 *
 * If somebody adds a second loop, or an origin branch inside the one loop, the
 * two traces below stop matching and this file says where.
 */

afterEach(() => {
  resetRunPorts();
});

const CODE = `async () => {
  const thread = await slack.thread({});
  return { messages: thread.length };
}`;

const THREAD = [
  { ts: "1.0", userId: "U1", text: "exports are empty", permalink: null },
  { ts: "2.0", userId: "U2", text: "since the 04:12 deploy", permalink: null },
];

/**
 * Everything that must be the same, collected in one shape.
 *
 * Ids and timestamps are replaced rather than deleted, so a field that stops
 * being produced at all still shows up as a difference.
 */
async function collect(harness: LoopHarness) {
  return harness.storage((storage) => {
    const events = listEvents(storage, 0, 500);
    const turns = listTurns(storage);
    const transcript = readModelTranscript(storage);
    const toolCalls = listToolCalls(storage);
    const usageColumns = storage.sql
      .exec("SELECT * FROM model_step_usage LIMIT 1")
      .columnNames.slice()
      .sort();
    const generations = storage.sql
      .exec<{ state: string }>("SELECT state FROM agent_generations ORDER BY created_at ASC")
      .toArray()
      .map((row) => row.state);
    const driver = storage.sql
      .exec<{ phase: string; attempt: number; retry_count: number }>(
        "SELECT phase, attempt, retry_count FROM agent_driver WHERE singleton = 1",
      )
      .one();

    return {
      /** Public status transitions, in order. */
      statusEvents: events
        .filter((event) => event.type === "status")
        .map((event) => `${event.previousStatus}->${event.status}`),
      /** The replayable event protocol, structurally. */
      eventShape: events.map((event) => {
        if (event.type === "assistant_update") {
          return {
            type: event.type,
            state: event.update.state,
            hasDelta: (event.update.delta ?? "").length > 0,
          };
        }
        if (event.type === "tool_call") {
          return {
            type: event.type,
            name: event.update.name,
            state: event.update.state,
            nested: event.update.callId.startsWith("cap:"),
          };
        }
        if (event.type === "turn") {
          return { type: event.type, role: event.turn.role };
        }
        return { type: event.type };
      }),
      /** Model transcript roles and their kinds, never their content. */
      transcript: transcript.map((entry) => ({
        kind: entry.kind,
        globalStep: entry.globalStep,
        role: (entry.message as { role: string }).role,
      })),
      /** Outer tool and every nested capability, by structure. */
      toolCalls: toolCalls.map((call) => ({
        name: call.name,
        state: call.state,
        nested: call.callId.startsWith("cap:"),
      })),
      usageColumns,
      generations,
      driver,
      /** Roles only — a Slack input is `customer`, a Chat input `human_steer`. */
      turnRoles: turns.map((turn) => turn.role),
    };
  });
}

async function runOne(origin: "chat" | "slack", script: Parameters<typeof mockModel>[0]) {
  const harness = await freshLoopRun({
    origin,
    model: mockModel(script),
    fixtures: { slackThread: THREAD },
    flush: { chars: 16 },
  });
  // The only origin-specific input: Slack arrives as `customer`, Chat as
  // `human_steer`. Both are trusted wake sources and neither is a different
  // pipeline.
  await harness.stub.appendTurn(
    origin === "slack"
      ? customerTurn("t1", "why are exports empty?")
      : steerTurn("t1", "why are exports empty?"),
  );
  await harness.alarm();
  return harness;
}

function successScript() {
  return [
    toolStep({ toolCallId: "call_1", code: CODE, narration: ["Pulling ", "the thread."] }),
    textStep({ chunks: ["Two messages; it started at the 04:12 deploy."] }),
  ];
}

describe("one loop, two surfaces", () => {
  it("produces the identical trace for a Chat input and a Slack input", async () => {
    const chat = await runOne("chat", successScript());
    const slack = await runOne("slack", successScript());

    const chatTrace = await collect(chat);
    const slackTrace = await collect(slack);

    expect(chat.results[0].path).toBe("completed");
    expect(slack.results[0].path).toBe("completed");

    // Driver and generation transitions.
    expect(slackTrace.driver).toEqual(chatTrace.driver);
    expect(slackTrace.generations).toEqual(chatTrace.generations);
    expect(slackTrace.statusEvents).toEqual(chatTrace.statusEvents);

    // Model transcript roles.
    expect(slackTrace.transcript).toEqual(chatTrace.transcript);

    // Assistant update protocol and outer/nested tool update structure, which
    // travel on the same event stream.
    expect(slackTrace.eventShape).toEqual(chatTrace.eventShape);
    expect(slackTrace.toolCalls).toEqual(chatTrace.toolCalls);

    // Usage schema.
    expect(slackTrace.usageColumns).toEqual(chatTrace.usageColumns);

    // Turn roles. Both surfaces produce user input then an assistant answer;
    // the SOURCE differs (customer vs human_steer) and is normalized away here,
    // because provenance is what the wake predicate reads, not what the loop
    // branches on.
    expect(slackTrace.turnRoles).toEqual(chatTrace.turnRoles);
  });

  it("produces the identical failure semantics for both surfaces", async () => {
    const failing = () => [errorStep("upstream exploded")];
    const chat = await runOne("chat", failing());
    const slack = await runOne("slack", failing());

    expect(slack.results[0].path).toBe(chat.results[0].path);
    expect(slack.results[0].errorCode).toBe(chat.results[0].errorCode);

    const chatTrace = await collect(chat);
    const slackTrace = await collect(slack);
    expect(slackTrace.driver).toEqual(chatTrace.driver);
    expect(slackTrace.generations).toEqual(chatTrace.generations);
    expect(slackTrace.statusEvents).toEqual(chatTrace.statusEvents);
  });

  // NOT the guard on invariant 5, despite the name. It reads the calls the model
  // actually MADE, so seven extra tools installed in the map but never called
  // are invisible to it — measured, under Task 11's mutation 4, which added the
  // seven namespaces as outer tools and left this green. What it does prove is
  // parity: whatever the surfaces expose, they expose the same one thing. The
  // real guard on "exactly one outer tool" is `agent-composer.test.ts:92,98`,
  // which reads the tool map itself.
  it("has exactly one outer tool on both surfaces, and it is run_code", async () => {
    for (const origin of ["chat", "slack"] as const) {
      const harness = await runOne(origin, successScript());
      const calls = await harness.storage((storage) => listToolCalls(storage));
      const outer = calls.filter((call) => !call.callId.startsWith("cap:"));
      expect(outer.map((call) => call.name)).toEqual(["run_code"]);
    }
  });
});

/**
 * THE SLACK SAFETY BOUNDARY (invariants 4 and 34).
 *
 * A Slack-origin final answer is an INTERNAL assistant turn. It is written to
 * the run stream, it is visible to an engineer on the dashboard, and it causes
 * no Slack request of any kind. The only path to a customer is `slack.reply`,
 * which refuses with `identity_unavailable` until Phase 12 resolves the on-duty
 * engineer's own token — there is no bot-token fallback, and adding one is the
 * single change that would turn a draft into a message a customer receives.
 */
describe("a Slack answer never reaches Slack", () => {
  it("writes the final text as an internal assistant turn, labelled as narration", async () => {
    const harness = await runOne("slack", successScript());
    const turns = await harness.storage((storage) => listTurns(storage));

    const final = turns.find((turn) => turn.role === "assistant");
    expect(final).toBeDefined();
    expect(final!.content).toContain("04:12 deploy");
    // Task 7's label, read by the harness rather than re-derived from origin,
    // so a surface added later cannot acquire send rights by default.
    expect(final!.metadata).toMatchObject({ delivery: "internal_narration" });
  });

  it("labels a Chat answer as an ordinary visible turn instead", async () => {
    const harness = await runOne("chat", successScript());
    const turns = await harness.storage((storage) => listTurns(storage));
    const final = turns.find((turn) => turn.role === "assistant");

    expect(final).toBeDefined();
    expect((final!.metadata as { delivery?: string } | null)?.delivery).not.toBe(
      "internal_narration",
    );
  });

  it("refuses slack.reply with identity_unavailable and sends nothing", async () => {
    const REPLY = `async () => {
      await slack.reply({ text: "we are on it" });
      return { sent: true };
    }`;

    const harness = await freshLoopRun({
      origin: "slack",
      model: mockModel([
        toolStep({ toolCallId: "call_reply", code: REPLY }),
        textStep({ chunks: ["Drafted a reply for a human to send."] }),
      ]),
      flush: { chars: 16 },
      // THE REAL SEND PATH, not the fixture's.
      //
      // Every other port here is a fake, and the fake `reply` succeeds — which
      // is exactly why this case has to reach past it. `makeSlackGateway`'s
      // `reply` is the only code in the Worker that could ever speak to a
      // customer, and the property under test is that it refuses rather than
      // falling back to `SLACK_BOT_TOKEN` (invariant 34). Asserting that
      // against a fake would assert nothing at all.
      wrapDeps: (base) => ({
        ...base,
        slack: {
          ...base.slack,
          reply: makeSlackGateway(env.DB, {} as never).reply,
        },
      }),
    });
    await harness.stub.appendTurn(customerTurn("t1", "any update?"));
    await harness.alarm();

    const calls = await harness.storage((storage) => listToolCalls(storage));
    const reply = calls.find((call) => call.name.endsWith("slack.reply"));

    // The refusal is recorded on the nested capability event, with its code, so
    // an engineer reading the run sees WHY nothing was sent.
    expect(reply?.state).toBe("failed");
    expect(reply?.error ?? "").toContain("identity_unavailable");

    // And the run still finishes: a refusal to speak to a customer is a normal,
    // recoverable answer the model works around, not a failed investigation.
    expect(harness.results[0].path).toBe("completed");
    const turns = await harness.storage((storage) => listTurns(storage));
    expect(turns.find((turn) => turn.role === "assistant")?.metadata).toMatchObject({
      delivery: "internal_narration",
    });
  });
});
