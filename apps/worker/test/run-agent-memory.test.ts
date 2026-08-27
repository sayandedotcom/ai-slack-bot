import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { UIMessage } from "ai";

import type { AgentEpisode } from "../src/memory/episode";
import { chatRunKey, slackRunKey } from "../src/run/keys";
import {
  askedFrom,
  enqueueTurnEpisode,
  episodeOutcomeFor,
  makeTurnAuditSink,
  makeTurnProvenanceSink,
  messageText,
  newTurnRecord,
} from "../src/run/agent-memory";
import { installTestModel, resetTestModel } from "../src/run/model";
import { getRunById } from "../src/run/repository";
import { createRunFromChat, wakeRun } from "../src/run/wake";
import { cannedModel } from "./helpers/canned-model";
import { waitFor } from "./helpers/wait";

beforeEach(() => installTestModel(cannedModel({ text: "The exporter was out of memory." })));
afterEach(() => resetTestModel());

type OutboxRow = { id: string; graph_id: string; episode_json: string; source_json: string };

async function outboxFor(runId: string): Promise<OutboxRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, graph_id, episode_json, source_json FROM agent_memory_outbox WHERE run_id = ?",
  )
    .bind(runId)
    .all<OutboxRow>();
  return results ?? [];
}

function episodeOf(row: OutboxRow): AgentEpisode {
  return JSON.parse(row.episode_json) as AgentEpisode;
}

function userMessage(text: string): UIMessage {
  return { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] } as UIMessage;
}

let channelSeq = 0;
async function liveChannel(slug: string): Promise<string> {
  channelSeq += 1;
  const channelId = `CMEM${channelSeq}${Math.floor(Math.random() * 1e5)}`.toUpperCase().slice(0, 20);
  await env.DB.prepare(
    "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, ?, 'live')",
  )
    .bind(channelId, `ext-${channelId.toLowerCase()}`, slug)
    .run();
  return channelId;
}

let threadSeq = 1_740_000_000;
function freshThreadTs(): string {
  threadSeq += 1;
  return `${threadSeq}.000100`;
}

describe("one episode per finished turn", () => {
  it("writes exactly one outbox row when a turn completes", async () => {
    const { runId } = await createRunFromChat(env, { firstMessage: "why is the exporter stuck?" });

    const rows = await waitFor("the turn's episode", async () => {
      const found = await outboxFor(runId);
      return found.length > 0 ? found : null;
    });
    expect(rows).toHaveLength(1);

    const episode = episodeOf(rows[0]);
    expect(episode.run_id).toBe(runId);
    expect(episode.asked).toContain("why is the exporter stuck?");
    expect(episode.draft).toBe("The exporter was out of memory.");
    expect(episode.outcome).toBe("completed");
  });

  it("keys the row on the turn, so a redelivered turn writes nothing new", async () => {
    const run = await createRunFromChat(env, { firstMessage: "same question" });
    const rows = await waitFor("the turn's episode", async () => {
      const found = await outboxFor(run.runId);
      return found.length > 0 ? found : null;
    });

    // The same turn id, re-enqueued. `ensureOutboxRow` is ON CONFLICT DO
    // NOTHING, so the frozen body is never replaced by a later attempt's.
    const record = newTurnRecord();
    record.asked = "a completely different question";
    await enqueueTurnEpisode(env, {
      runId: run.runId,
      turnId: rows[0].id.split(":").slice(2).join(":"),
      origin: "chat",
      channelId: null,
      outcome: "failed",
      record,
      draft: "different",
      now: Date.now(),
    });

    const after = await outboxFor(run.runId);
    expect(after).toHaveLength(1);
    expect(episodeOf(after[0]).asked).toBe(episodeOf(rows[0]).asked);
  });

  it("scopes a slack run's episode to its customer graph", async () => {
    const channelId = await liveChannel("pulsefit");
    const threadTs = freshThreadTs();
    await wakeRun(env, {
      eventId: `Ev${crypto.randomUUID()}`,
      channelId,
      threadTs,
      openingPrompt: "pulsefit says the exporter is stuck",
    });
    const run = await getRunById(
      env.DB,
      (await env.DB.prepare('SELECT id FROM runs WHERE "key" = ?')
        .bind(slackRunKey(channelId, threadTs))
        .first<{ id: string }>())?.id ?? "",
    );

    const rows = await waitFor("the wake's episode", async () => {
      const found = await outboxFor(run?.id ?? "");
      return found.length > 0 ? found : null;
    });
    expect(rows[0].graph_id).toBe("customer:pulsefit");
  });

  it("puts a chat run's episode in the org graph, never a customer's", async () => {
    const { runId } = await createRunFromChat(env, { firstMessage: "an internal question" });
    const rows = await waitFor("the turn's episode", async () => {
      const found = await outboxFor(runId);
      return found.length > 0 ? found : null;
    });
    expect(rows[0].graph_id).toBe("org");
  });

  it("remembers nothing for a turn that never happened", async () => {
    // A turn with nothing asked, nothing done and nothing drafted is what a
    // failure before the model looks like. An episode of it is noise a future
    // recall has to read past.
    const { runId } = await createRunFromChat(env, {});
    expect(
      await enqueueTurnEpisode(env, {
        runId,
        turnId: "turn-empty",
        origin: "chat",
        channelId: null,
        outcome: "failed",
        record: newTurnRecord(),
        draft: "",
        now: Date.now(),
      }),
    ).toEqual({ enqueued: false, reason: "empty_turn" });
    expect(await outboxFor(runId)).toEqual([]);
  });
});

describe("what an episode is made of", () => {
  it("records capability names and refusal codes, never results", async () => {
    // `slack.reply` returning a whole customer thread and `slack.reply`
    // refusing both produce one short line — that is the difference between a
    // semantic memory and a transcript (invariant 33).
    const record = newTurnRecord();
    const audit = makeTurnAuditSink(record);
    await audit.started({
      kind: "started",
      runId: "run-1",
      turnId: "turn-1",
      callId: "c1",
      seq: 1,
      namespace: "slack",
      method: "thread",
      at: 1,
      args: null,
    });
    await audit.completed({
      kind: "completed",
      runId: "run-1",
      turnId: "turn-1",
      callId: "c1",
      seq: 1,
      namespace: "slack",
      method: "thread",
      at: 2,
      durationMs: 10,
      resultChars: 90_000,
    });
    await audit.failed({
      kind: "failed",
      runId: "run-1",
      turnId: "turn-1",
      callId: "c2",
      seq: 2,
      namespace: "slack",
      method: "reply",
      at: 3,
      durationMs: 5,
      code: "identity_unavailable",
      message: "no fire-fighter has connected Slack",
      retryable: false,
    });

    // A `started` is not an action: a call that began and then refused is one
    // line saying it refused, not two.
    expect(record.actions).toEqual(["slack.thread", "slack.reply refused: identity_unavailable"]);
  });

  it("keeps the host-produced ids a read returned", async () => {
    const record = newTurnRecord();
    makeTurnProvenanceSink(record).record([
      { kind: "slack_message", ref: "Ev123" },
      { kind: "zep_episode", ref: "uuid-1" },
    ]);
    expect(record.sources.map((source) => source.ref)).toEqual(["Ev123", "uuid-1"]);
  });

  it("takes what was asked from the LAST user message", async () => {
    // A wake carries the briefing, a steer the operator's instruction, an
    // approval resolution the human's decision — each is what the turn is
    // answering.
    expect(
      askedFrom([
        userMessage("the opening briefing"),
        { id: "a", role: "assistant", parts: [{ type: "text", text: "on it" }] } as UIMessage,
        userMessage("actually check the deploy"),
      ]),
    ).toBe("actually check the deploy");
    expect(askedFrom([])).toBe("");
  });

  it("reads text parts and nothing else off a message", async () => {
    expect(
      messageText({
        id: "m",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "reasoning", text: "" },
          { type: "text", text: "the answer" },
          { type: "tool-run_code", input: { code: "secret()" } },
        ],
      } as unknown as UIMessage),
    ).toBe("the answer");
  });

  it("redacts a credential-shaped string the customer pasted", async () => {
    const { runId } = await createRunFromChat(env, {});
    const record = newTurnRecord();
    record.asked = "the webhook uses xoxb-1234567890-abcdefghijklmnop and it broke";
    await enqueueTurnEpisode(env, {
      runId,
      turnId: `turn-${crypto.randomUUID()}`,
      origin: "chat",
      channelId: null,
      outcome: "completed",
      record,
      draft: "rotated it",
      now: Date.now(),
    });

    const rows = await outboxFor(runId);
    expect(rows[0].episode_json).not.toContain("xoxb-1234567890-abcdefghijklmnop");
  });
});

describe("how a turn ended", () => {
  it("calls a refusal a refusal, not a failure", () => {
    // "This model would not answer that" is a different lesson from "this run
    // broke", and memory needs the distinction.
    expect(episodeOutcomeFor({ status: "failed", refused: true, budgetExhausted: false })).toBe(
      "refused",
    );
    expect(episodeOutcomeFor({ status: "failed", refused: false, budgetExhausted: false })).toBe(
      "failed",
    );
    expect(episodeOutcomeFor({ status: "idle", refused: false, budgetExhausted: true })).toBe(
      "budget_exhausted",
    );
    expect(
      episodeOutcomeFor({ status: "awaiting_approval", refused: false, budgetExhausted: false }),
    ).toBe("completed");
  });
});

describe("an unbound run", () => {
  it("remembers nothing rather than throwing into the turn", async () => {
    // The customer's answer was durable and broadcast before memory ran.
    const stub = await getAgentByName(env.RUN_AGENTS, chatRunKey(crypto.randomUUID()));
    await stub.onChatResponse({
      message: { id: "m", role: "assistant", parts: [] },
      requestId: "r",
      continuation: false,
      status: "completed",
    } as never);
    expect((await stub.runStateForTest()).status).toBe("idle");
  });
});
