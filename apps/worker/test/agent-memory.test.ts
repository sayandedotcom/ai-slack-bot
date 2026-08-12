import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  boundedMetadata,
  boundedSourceDescription,
  buildAgentEpisode,
  describeAction,
  EPISODE_LIMITS,
  redactSecrets,
  type AgentEpisode,
} from "../src/memory/episode";
import { agentGraphIdFor } from "../src/memory/graphs";
import type { ChannelPolicy } from "../src/db/channels";
import {
  classifyMemoryJob,
  handleMemoryBatch,
  episodeMetadata,
  episodeSourceDescription,
  type MemoryJob,
} from "../src/memory/consumer";
import { listGenerationSources, readGenerationMemory } from "../src/run/session";
import { FakeMemoryStore } from "./helpers/fake-memory";
import {
  customerTurn,
  freshLoopRun,
  mockModel,
  textStep,
  toolStep,
} from "./helpers/agent-loop";

/**
 * The agent's half of memory: what it was ASKED, what it DID, what it DRAFTED,
 * and how it ENDED.
 *
 * NOTHING HERE REACHES A NETWORK. The Zep client is faked at the `MemoryStore`
 * seam, the provider is a scripted mock, and every other gateway is a local
 * fake. The one genuinely real thing in the end-to-end cases is the Worker
 * Loader isolate and the whole production composition behind it.
 */

/* ------------------------------------------------------------- redaction -- */

describe("episode redaction", () => {
  // Split so the literals below are not themselves credential-shaped strings a
  // scanner would flag in this repo.
  const SECRETS: [string, string][] = [
    ["slack bot token", `xoxb-${"1".repeat(12)}-${"a".repeat(16)}`],
    ["bearer header", `Bearer ${"A".repeat(40)}`],
    ["openai-style key", `sk-${"B".repeat(32)}`],
    ["linear key", `lin_api_${"c".repeat(32)}`],
    ["langsmith key", `lsv2_${"d".repeat(32)}`],
    ["supabase secret", `sb_secret_${"e".repeat(24)}`],
    ["github token", `ghp_${"F".repeat(36)}`],
    ["aws access key", `AKIA${"G".repeat(16)}`],
    ["jwt", `eyJhbGciOiJIUzI1NiJ9.${"h".repeat(24)}.${"i".repeat(24)}`],
    ["labelled password", "password = hunter2hunter2"],
    ["labelled api key", "api_key: abcdefghijklmnop"],
  ];

  for (const [name, secret] of SECRETS) {
    it(`removes a ${name} from episode text`, () => {
      const text = `the customer pasted ${secret} into the thread`;
      const redacted = redactSecrets(text);
      expect(redacted).not.toContain(secret);
      expect(redacted).toContain("[redacted]");
      // The fact that something was pasted survives; the entropy does not.
      expect(redacted).toContain("the customer pasted");
    });
  }

  it("redacts BEFORE truncating, so a bounded field cannot keep half a token", () => {
    const secret = `xoxb-${"9".repeat(40)}-${"z".repeat(60)}`;
    const { episode } = buildAgentEpisode({
      runId: "run_1",
      agentTurnId: "agent:gen_1",
      outcome: "completed",
      asked: `here is my key ${secret} please help`,
      actions: [],
      draft: "",
      sources: [],
    });
    // Truncation of the redacted string can never expose a prefix of the token,
    // because the token is gone before the slice happens.
    expect(episode.asked).not.toContain("xoxb-");
    expect(episode.asked).not.toContain("999999");
  });

  it("bounds every field of the episode", () => {
    const { episode } = buildAgentEpisode({
      runId: "run_1",
      agentTurnId: "agent:gen_1",
      outcome: "completed",
      asked: "a".repeat(9_000),
      actions: Array.from({ length: 200 }, (_, i) => `ns.method${i}`),
      draft: "b".repeat(9_000),
      sources: Array.from({ length: 500 }, (_, i) => ({
        kind: "slack_message" as const,
        ref: `Ev${i}`,
      })),
    });
    expect(episode.asked.length).toBeLessThanOrEqual(EPISODE_LIMITS.asked);
    expect(episode.draft.length).toBeLessThanOrEqual(EPISODE_LIMITS.draft);
    expect(episode.actions.length).toBeLessThanOrEqual(EPISODE_LIMITS.actions);
  });

  it("collapses a repeated action rather than letting it crowd out the rest", () => {
    const { episode } = buildAgentEpisode({
      runId: "run_1",
      agentTurnId: "agent:gen_1",
      outcome: "completed",
      asked: "why",
      actions: [...Array.from({ length: 40 }, () => "supabase.query"), "linear.createIssue"],
      draft: "done",
      sources: [],
    });
    expect(episode.actions).toEqual(["supabase.query", "linear.createIssue"]);
  });

  it("records a refusal by its stable code, never by a vendor message", () => {
    expect(
      describeAction({
        name: "slack.reply",
        state: "failed",
        errorCode: "identity_unavailable",
      }),
    ).toBe("slack.reply refused: identity_unavailable");
  });
});

/* ------------------------------------------------- the verified Zep shape -- */

describe("the Zep request shape", () => {
  const episode: AgentEpisode = {
    asked: "why are exports empty",
    actions: ["slack.thread"],
    draft: "the 04:12 deploy",
    outcome: "completed",
    run_id: "run_1",
    agent_turn_id: "agent:gen_1",
  };

  it("keeps metadata within Zep's verified maximum of ten scalar tags", () => {
    const metadata = episodeMetadata(episode, {
      generationId: "gen_1",
      graphId: "customer:pulsefit",
    });
    expect(Object.keys(metadata).length).toBeLessThanOrEqual(EPISODE_LIMITS.metadataTags);
    expect(EPISODE_LIMITS.metadataTags).toBe(10);
    for (const value of Object.values(metadata)) {
      const scalar =
        typeof value === "string" || typeof value === "number" || typeof value === "boolean";
      const scalarArray =
        Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string");
      expect(scalar || scalarArray).toBe(true);
    }
  });

  it("drops an eleventh tag, an empty array, and a nested object", () => {
    const bounded = boundedMetadata({
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
      f: 6,
      g: 7,
      h: 8,
      i: 9,
      j: 10,
      k: 11,
      empty: [],
      nested: { no: true },
    });
    expect(Object.keys(bounded)).toHaveLength(10);
    expect(bounded.k).toBeUndefined();
    expect(bounded.empty).toBeUndefined();
    expect(bounded.nested).toBeUndefined();
  });

  it("keeps sourceDescription within Zep's documented 500 characters", () => {
    expect(episodeSourceDescription(episode).length).toBeLessThanOrEqual(500);
    expect(boundedSourceDescription("x".repeat(4_000)).length).toBeLessThanOrEqual(500);
    expect(EPISODE_LIMITS.sourceDescription).toBe(500);
  });

  it("never puts episode text or a customer name in metadata", () => {
    const metadata = episodeMetadata(
      { ...episode, asked: "PulseFit checkout is broken", draft: "call them back" },
      { generationId: "gen_1", graphId: "customer:pulsefit" },
    );
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain("checkout is broken");
    expect(serialized).not.toContain("call them back");
  });
});

/* --------------------------------------------------------- graph routing -- */

function policy(overrides: Partial<ChannelPolicy> = {}): ChannelPolicy {
  return {
    channel_id: "C1",
    name: "ext-pulsefit",
    customer_slug: null,
    mode: "live",
    known: true,
    ...overrides,
  };
}

describe("graph routing", () => {
  it("sends a customer Slack run to its customer graph", () => {
    expect(
      agentGraphIdFor({
        origin: "slack",
        policy: policy({ customer_slug: "pulsefit" }),
      }),
    ).toBe("customer:pulsefit");
  });

  it("sends Chat to org even when a channel policy exists", () => {
    expect(
      agentGraphIdFor({
        origin: "chat",
        policy: policy({ customer_slug: "pulsefit" }),
      }),
    ).toBe("org");
  });

  it("fails closed to org for an internal, unknown, or absent scope", () => {
    const internal = policy({ mode: "internal", customer_slug: null });
    const unknown = policy({ known: false, mode: "observe", customer_slug: null });
    expect(agentGraphIdFor({ origin: "slack", policy: internal })).toBe("org");
    expect(agentGraphIdFor({ origin: "slack", policy: unknown })).toBe("org");
    expect(agentGraphIdFor({ origin: "slack", policy: null })).toBe("org");
  });

  it("cannot be steered by a hostile string, because it takes no string", () => {
    // The signature is the proof. `agentGraphIdFor` accepts an origin from
    // `run_state` and a D1 channel policy row — there is no parameter a model,
    // a customer message, or a tool result could ever occupy. A hostile slug
    // would have to be INSIDE the D1 catalog to matter, at which point it is
    // not hostile input, it is our own data.
    // Even a nonsense slug read out of D1 is namespaced, never interpolated
    // into a second graph or a different template.
    const hostile = policy({ customer_slug: "../../org" });
    expect(agentGraphIdFor({ origin: "slack", policy: hostile })).toBe("customer:../../org");
    // And the host never evaluates `customer:${modelInput}` anywhere.
    const source = agentGraphIdFor.toString();
    expect(source).toContain("policy.customer_slug");
  });
});

/* ----------------------------------------------------- the MemoryJob union -- */

describe("MemoryJob validation", () => {
  it("accepts the legacy { event_id } shape as a message job", () => {
    expect(classifyMemoryJob({ event_id: "Ev1" })).toEqual({
      kind: "message",
      eventId: "Ev1",
      legacy: true,
    });
  });

  it("accepts both discriminated shapes", () => {
    expect(classifyMemoryJob({ kind: "message", eventId: "Ev1" })).toEqual({
      kind: "message",
      eventId: "Ev1",
      legacy: false,
    });
    expect(classifyMemoryJob({ kind: "agent_generation", outboxId: "memory:r:g" })).toEqual({
      kind: "agent_generation",
      outboxId: "memory:r:g",
    });
  });

  it("retries an unknown kind, because a newer deploy may understand it", () => {
    const job = classifyMemoryJob({ kind: "approval_outcome", id: "x" });
    expect(job).toMatchObject({ kind: "unrecognized", retryable: true });
  });

  it("drops a shape no deploy could ever understand", () => {
    for (const body of [null, "hello", 42, [], {}, { kind: "message" }]) {
      const job = classifyMemoryJob(body);
      expect(job).toMatchObject({ kind: "unrecognized", retryable: false });
    }
  });
});

describe("the memory queue consumer", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM zep_episodes"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM channels WHERE channel_id = 'CMEM'"),
    ]);
    await env.DB.prepare(
      "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES ('CMEM', 'ext-pulsefit', 'pulsefit', 'live')",
    ).run();
    await env.DB.prepare(
      `INSERT INTO messages (event_id, channel_id, ts, thread_ts, user_id, text, subtype, permalink, customer_slug, received_at)
       VALUES ('EvLegacy', 'CMEM', '1.1', NULL, 'U1', 'checkout is broken', NULL, 'https://slack.example/p1', 'pulsefit', 1)`,
    ).run();
  });

  function batchOf(bodies: unknown[]) {
    const acked: number[] = [];
    const retried: number[] = [];
    const batch = {
      queue: "firefighter-memory",
      messages: bodies.map((body, index) => ({
        body: body as MemoryJob,
        ack: () => acked.push(index),
        retry: () => retried.push(index),
      })),
    } as unknown as MessageBatch<MemoryJob>;
    return { batch, acked, retried };
  }

  it("still projects a legacy { event_id } job", async () => {
    const store = new FakeMemoryStore();
    const { batch, acked } = batchOf([{ event_id: "EvLegacy" }]);

    await handleMemoryBatch(batch, env, store);

    expect(acked).toEqual([0]);
    expect(store.episodes).toHaveLength(1);
    expect(store.episodes[0].graphId).toBe("customer:pulsefit");
    expect(store.episodes[0].type).toBe("message");
    const row = await env.DB.prepare(
      "SELECT graph_id FROM zep_episodes WHERE event_id = 'EvLegacy'",
    ).first();
    expect(row).toMatchObject({ graph_id: "customer:pulsefit" });
  });

  it("one unusable body does not poison the rest of the batch", async () => {
    const store = new FakeMemoryStore();
    const { batch, acked, retried } = batchOf([
      "not an object",
      { kind: "message", eventId: "EvLegacy" },
      { kind: "from_the_future" },
    ]);

    await handleMemoryBatch(batch, env, store);

    // The garbage is acked (dropped), the good one is projected, and only the
    // possible deploy-skew job is handed back.
    expect(acked.sort()).toEqual([0, 1]);
    expect(retried).toEqual([2]);
    expect(store.episodes).toHaveLength(1);
  });
});

/* ------------------------------------------- the frozen episode, end to end -- */

const RECALL_CODE = `async () => {
  const facts = await memory.recall({ query: "checkout", scope: "org" });
  return facts.length;
}`;

const SEARCH_CODE = `async () => {
  const found = await slack.searchMessages({ query: "deploy" });
  return { count: found.length, keys: Object.keys(found[0] ?? {}) };
}`;

describe("the frozen episode", () => {
  it("freezes exactly one episode and one outbox job for a completed generation", async () => {
    const harness = await freshLoopRun({
      origin: "slack",
      model: mockModel([
        toolStep({ toolCallId: "call_1", code: RECALL_CODE, narration: ["Checking ", "memory."] }),
        textStep({ chunks: ["It was the 04:12 deploy."] }),
      ]),
      fixtures: {
        memoryFacts: [{ factId: "edge_1", fact: "checkout uses stripe", episodeUuids: ["zep_1"] }],
      },
    });

    await harness.stub.appendTurn(customerTurn("t1", "why are exports empty?"));
    await harness.alarm();
    expect(harness.results[0].path).toBe("completed");

    const memory = await harness.storage((storage) => {
      const generationId = storage.sql
        .exec<{ id: string }>("SELECT id FROM agent_generations LIMIT 1")
        .toArray()[0].id;
      return readGenerationMemory(storage, generationId);
    });

    expect(memory).not.toBeNull();
    const episode = JSON.parse(memory!.episodeJson) as AgentEpisode;
    expect(episode.outcome).toBe("completed");
    expect(episode.run_id).toBe(harness.runId);
    expect(episode.asked).toContain("why are exports empty?");
    expect(episode.draft).toBe("It was the 04:12 deploy.");
    expect(episode.actions).toContain("memory.recall");

    const jobs = await harness.storage((storage) =>
      storage.sql
        .exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM agent_projection_jobs WHERE kind = 'memory_outbox'",
        )
        .toArray()[0].n,
    );
    expect(jobs).toBe(1);
  });

  it("excludes narration, generated code, tool results and reasoning", async () => {
    const harness = await freshLoopRun({
      origin: "slack",
      model: mockModel([
        toolStep({
          toolCallId: "call_1",
          code: RECALL_CODE,
          // Narration on an intermediate step: assistant delta text that is NOT
          // the selected final draft.
          narration: ["Let me look at ", "the raw rows first."],
        }),
        textStep({ chunks: ["It was the 04:12 deploy."] }),
      ]),
      fixtures: {
        memoryFacts: [
          { factId: "edge_1", fact: "RAW_TOOL_RESULT_MARKER", episodeUuids: ["zep_1"] },
        ],
      },
    });

    await harness.stub.appendTurn(customerTurn("t1", "why are exports empty?"));
    await harness.alarm();

    const memory = await harness.storage((storage) => {
      const generationId = storage.sql
        .exec<{ id: string }>("SELECT id FROM agent_generations LIMIT 1")
        .toArray()[0].id;
      return readGenerationMemory(storage, generationId);
    });
    const body = memory!.episodeJson;

    // Assistant deltas beyond the selected final draft.
    expect(body).not.toContain("the raw rows first");
    // Generated Code Mode source.
    expect(body).not.toContain("memory.recall({");
    expect(body).not.toContain("async ()");
    // Raw tool results.
    expect(body).not.toContain("RAW_TOOL_RESULT_MARKER");
    // Reasoning and provider signatures (invariants 18 and 33).
    expect(body).not.toContain("signature");
    expect(body).not.toContain("thinking");
    expect(body).not.toContain("redactedData");
    // Only the selected draft.
    const episode = JSON.parse(body) as AgentEpisode;
    expect(episode.draft).toBe("It was the 04:12 deploy.");
  });

  it("keeps a credential pasted by a customer out of the episode", async () => {
    const secret = `xoxb-${"7".repeat(12)}-${"k".repeat(16)}`;
    const harness = await freshLoopRun({
      origin: "slack",
      model: mockModel([textStep({ chunks: ["Rotate that token."] })]),
    });

    await harness.stub.appendTurn(
      customerTurn("t1", `our integration broke, here is the token ${secret}`),
    );
    await harness.alarm();

    const memory = await harness.storage((storage) => {
      const generationId = storage.sql
        .exec<{ id: string }>("SELECT id FROM agent_generations LIMIT 1")
        .toArray()[0].id;
      return readGenerationMemory(storage, generationId);
    });
    expect(memory!.episodeJson).not.toContain(secret);
    expect(memory!.episodeJson).toContain("[redacted]");
  });

  it("re-finalizing the same generation neither changes nor duplicates it", async () => {
    const harness = await freshLoopRun({
      origin: "slack",
      model: mockModel([textStep({ chunks: ["Answered once."] })]),
    });

    await harness.stub.appendTurn(customerTurn("t1", "what happened?"));
    await harness.alarm();

    const first = await harness.storage((storage) => {
      const generationId = storage.sql
        .exec<{ id: string }>("SELECT id FROM agent_generations LIMIT 1")
        .toArray()[0].id;
      return readGenerationMemory(storage, generationId);
    });

    // A redelivered alarm. The generation is terminal, so finalization is a
    // no-op — and the episode must be byte-identical, with still one job.
    await harness.alarm();
    await harness.alarm();

    const after = await harness.storage((storage) => {
      const generationId = storage.sql
        .exec<{ id: string }>("SELECT id FROM agent_generations LIMIT 1")
        .toArray()[0].id;
      const jobs = storage.sql
        .exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM agent_projection_jobs WHERE kind = 'memory_outbox'",
        )
        .toArray()[0].n;
      return { memory: readGenerationMemory(storage, generationId), jobs };
    });

    expect(after.memory!.episodeJson).toBe(first!.episodeJson);
    expect(after.memory!.sourceJson).toBe(first!.sourceJson);
    expect(after.jobs).toBe(1);
  });

  it("remembers a terminally failed generation, with no draft", async () => {
    const harness = await freshLoopRun({
      origin: "slack",
      // A refusal is HTTP 200 with a content-filter finish: terminal, not a
      // retry, so it settles as `refused` on the first attempt.
      model: mockModel([textStep({ chunks: ["nope"], unified: "content-filter", raw: "refusal" })]),
    });

    await harness.stub.appendTurn(customerTurn("t1", "do something forbidden"));
    await harness.alarm();

    const memory = await harness.storage((storage) => {
      const generationId = storage.sql
        .exec<{ id: string }>("SELECT id FROM agent_generations LIMIT 1")
        .toArray()[0].id;
      return readGenerationMemory(storage, generationId);
    });

    expect(memory).not.toBeNull();
    const episode = JSON.parse(memory!.episodeJson) as AgentEpisode;
    expect(["refused", "failed", "budget_exhausted"]).toContain(episode.outcome);
    expect(episode.draft).toBe("");
    expect(episode.asked).toContain("do something forbidden");
  });
});

/* -------------------------------------------------------------- provenance -- */

describe("provenance from trusted tool reads", () => {
  it("registers the episode uuids a recall RETURNED, not the question that asked", async () => {
    const harness = await freshLoopRun({
      // CHAT, deliberately: a chat turn carries no message event id, so if the
      // recall did not register its own sources the episode would have none.
      origin: "chat",
      model: mockModel([
        toolStep({ toolCallId: "call_1", code: RECALL_CODE }),
        textStep({ chunks: ["PulseFit uses Stripe."] }),
      ]),
      fixtures: {
        memoryFacts: [
          { factId: "edge_1", fact: "pulsefit uses stripe", episodeUuids: ["zep_a", "zep_b"] },
        ],
      },
    });

    await harness.stub.appendTurn(customerTurn("t1", "which processor does PulseFit use?"));
    await harness.alarm();

    const { sources, frozen } = await harness.storage((storage) => {
      const generationId = storage.sql
        .exec<{ id: string }>("SELECT id FROM agent_generations LIMIT 1")
        .toArray()[0].id;
      return {
        sources: listGenerationSources(storage, generationId),
        frozen: readGenerationMemory(storage, generationId),
      };
    });

    expect(sources).toEqual(
      expect.arrayContaining([
        { kind: "zep_episode", ref: "zep_a" },
        { kind: "zep_episode", ref: "zep_b" },
      ]),
    );

    const frozenSources = JSON.parse(frozen!.sourceJson) as { kind: string; ref: string }[];
    // The customer evidence is there.
    expect(frozenSources.some((s) => s.kind === "zep_episode")).toBe(true);
    // And the Chat question itself contributed NO source: it is not evidence
    // for a fact learned from customer memory.
    expect(frozenSources.some((s) => s.kind === "run_turn")).toBe(false);
  });

  it("registers the message event ids a search RETURNED, and hides them from the model", async () => {
    // SLACK, because an unscoped Chat search is refused outright — a Chat run
    // has no ambient customer and must go through host-mediated discovery
    // first (invariant 36). That refusal is itself asserted in the codemode
    // suites; what this case is about is what a search that DOES run records.
    const harness = await freshLoopRun({
      origin: "slack",
      model: mockModel([
        toolStep({ toolCallId: "call_1", code: SEARCH_CODE }),
        textStep({ chunks: ["Two matches."] }),
      ]),
      fixtures: {
        slackSearch: [
          {
            ts: "1.1",
            userId: "U1",
            text: "the 04:12 deploy broke exports",
            permalink: "https://slack.example/p1",
            eventId: "EvSearch1",
          },
        ],
      },
    });

    await harness.stub.appendTurn(customerTurn("t1", "any deploy chatter?"));
    await harness.alarm();

    const sources = await harness.storage((storage) => {
      const generationId = storage.sql
        .exec<{ id: string }>("SELECT id FROM agent_generations LIMIT 1")
        .toArray()[0].id;
      return listGenerationSources(storage, generationId);
    });
    expect(sources).toContainEqual({ kind: "slack_message", ref: "EvSearch1" });

    // The model's own view of the same result carries no event id: the binding
    // projects the visible shape explicitly. The isolate returned the key list.
    const calls = await harness.storage((storage) =>
      storage.sql
        .exec<{ output_json: string | null }>(
          "SELECT output_json FROM tool_calls WHERE name = 'run_code'",
        )
        .toArray(),
    );
    const rendered = JSON.stringify(calls);
    expect(rendered).not.toContain("EvSearch1");
    expect(rendered).not.toContain("eventId");
  });

  it("orders what a Slack run READ ahead of the question it was answering", async () => {
    // The Slack counterpart of the Chat case above, and the one that actually
    // bites: a Slack input turn carries an `eventId`, so it produces a real
    // `run_turn` descriptor. `source_index` is assigned densely in payload
    // order and `cite()` takes the lowest, so if the question came first every
    // agent episode on the Slack surface would cite the customer asking rather
    // than the evidence the answer was built on.
    const harness = await freshLoopRun({
      origin: "slack",
      model: mockModel([
        toolStep({ toolCallId: "call_1", code: RECALL_CODE }),
        textStep({ chunks: ["The 04:12 deploy."] }),
      ]),
      fixtures: {
        memoryFacts: [
          { factId: "edge_1", fact: "the export worker was dropped", episodeUuids: ["zep_ev"] },
        ],
      },
    });

    await harness.stub.appendTurn({
      id: "t1",
      role: "user",
      source: "customer",
      content: "why are exports empty?",
      // Exactly what the Slack coordinator writes for a real customer message.
      metadata: { eventId: "EvQuestion", channelId: "C1", threadTs: "1.0" },
    });
    await harness.alarm();

    const frozen = await harness.storage((storage) => {
      const generationId = storage.sql
        .exec<{ id: string }>("SELECT id FROM agent_generations LIMIT 1")
        .toArray()[0].id;
      return readGenerationMemory(storage, generationId);
    });

    const sources = JSON.parse(frozen!.sourceJson) as { kind: string; ref: string }[];
    // BOTH are present — the question is real provenance and is not dropped.
    expect(sources).toEqual(
      expect.arrayContaining([
        { kind: "zep_episode", ref: "zep_ev" },
        { kind: "run_turn", ref: "EvQuestion", turnId: "t1" },
      ]),
    );
    // But the evidence is FIRST, so it is what a citation resolves to.
    expect(sources[0].kind).toBe("zep_episode");
    expect(sources.findIndex((s) => s.kind === "zep_episode")).toBeLessThan(
      sources.findIndex((s) => s.kind === "run_turn"),
    );
  });

  it("records the same read twice as one source", async () => {
    const harness = await freshLoopRun({
      origin: "chat",
      model: mockModel([
        toolStep({ toolCallId: "call_1", code: RECALL_CODE }),
        toolStep({ toolCallId: "call_2", code: RECALL_CODE }),
        textStep({ chunks: ["Same answer."] }),
      ]),
      fixtures: {
        memoryFacts: [{ factId: "edge_1", fact: "a fact", episodeUuids: ["zep_dup"] }],
      },
    });

    await harness.stub.appendTurn(customerTurn("t1", "ask twice"));
    await harness.alarm();

    const sources = await harness.storage((storage) => {
      const generationId = storage.sql
        .exec<{ id: string }>("SELECT id FROM agent_generations LIMIT 1")
        .toArray()[0].id;
      return listGenerationSources(storage, generationId);
    });
    expect(sources.filter((s) => s.ref === "zep_dup")).toHaveLength(1);
  });
});
