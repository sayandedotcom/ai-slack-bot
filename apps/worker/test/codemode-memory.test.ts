import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildRegistry } from "../src/codemode/registry";
import type { CodeModeScope } from "../src/codemode/contracts";
import type { MemoryFact, MemoryStore } from "../src/memory/store";
import { fakeAuditSink, fakeDeps, slackScope, TEST_LIMITS, testExecution } from "./helpers/codemode";

const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

/** Records which graph was searched, so scope derivation is observable. */
function recordingStore(byGraph: Record<string, MemoryFact[]> = {}) {
  const searched: string[] = [];
  const store: MemoryStore & { searched: string[] } = {
    searched,
    async ensureGraph() {},
    async addMessage() { return { episodeUuid: "ep_0" }; },
    async search(graphId: string) {
      searched.push(graphId);
      return byGraph[graphId] ?? [];
    },
  };
  return store;
}

function memoryTools(scope: CodeModeScope, store: MemoryStore) {
  const deps = { ...fakeDeps(), db: env.DB, memory: store };
  return buildRegistry(scope, deps, TEST_LIMITS, testExecution({ audit: fakeAuditSink() }))
    .find((p) => p.name === "memory")!.tools;
}

const call = (tools: ReturnType<typeof memoryTools>, method: string, args: unknown) =>
  (tools[method] as { execute: (a: unknown) => Promise<unknown> }).execute(args);

/** A message with a permalink, wired to an episode so cite() can resolve it. */
async function seedCitable(text: string) {
  const eventId = `ev_${uid()}`;
  const episodeUuid = `epi_${uid()}`;
  const channelId = `C${uid().toUpperCase()}`;
  const ts = `171234${Math.floor(Math.random() * 9000) + 1000}.000100`;
  const permalink = `https://slack.example/${eventId}`;
  await env.DB.prepare(
    `INSERT INTO messages (event_id, channel_id, ts, thread_ts, user_id, text, subtype, permalink, customer_slug, received_at)
     VALUES (?, ?, ?, NULL, 'U1', ?, NULL, ?, 'acme', 0)`,
  ).bind(eventId, channelId, ts, text, permalink).run();
  await env.DB.prepare(
    "INSERT INTO zep_episodes (episode_uuid, event_id, graph_id, created_at) VALUES (?, ?, 'customer:acme', 0)",
  ).bind(episodeUuid, eventId).run();
  return { episodeUuid, permalink, ts, channelId };
}

describe("memory.recall graph scoping", () => {
  it("derives the customer graph from trusted scope", async () => {
    const store = recordingStore();
    await call(memoryTools({ ...slackScope, customerSlug: "acme" }, store), "recall", { query: "billing" });
    expect(store.searched).toEqual(["customer:acme"]);
  });

  it("uses the literal org graph for org scope", async () => {
    const store = recordingStore();
    await call(memoryTools(slackScope, store), "recall", { query: "runbook", scope: "org" });
    expect(store.searched).toEqual(["org"]);
  });

  it("refuses customer recall when the run has no customer", async () => {
    const store = recordingStore();
    await expect(
      call(memoryTools({ ...slackScope, customerSlug: null }, store), "recall", { query: "x" }),
    ).rejects.toThrow(/customer_scope_required/);
    expect(store.searched).toEqual([]); // never reached the store
  });

  it("still allows org recall on a run with no customer", async () => {
    const store = recordingStore();
    await call(memoryTools({ ...slackScope, customerSlug: null }, store), "recall",
      { query: "x", scope: "org" });
    expect(store.searched).toEqual(["org"]);
  });

  it.each([
    ["a graph id", { query: "x", graphId: "customer:globex" }],
    ["a customer slug", { query: "x", customerSlug: "globex" }],
    ["a blank query", { query: "" }],
    ["an oversized query", { query: "x".repeat(600) }],
    ["an out-of-range scope", { query: "x", scope: "everything" }],
  ])("rejects %s", async (_label, args) => {
    const store = recordingStore();
    await expect(call(memoryTools(slackScope, store), "recall", args))
      .rejects.toThrow(/invalid_input/);
    expect(store.searched).toEqual([]);
  });

  it("clamps the limit rather than passing it through", async () => {
    let seenLimit: number | undefined;
    const store: MemoryStore = {
      async ensureGraph() {},
      async addMessage() { return { episodeUuid: "e" }; },
      async search(_g, _q, limit) { seenLimit = limit; return []; },
    };
    await call(memoryTools(slackScope, store), "recall", { query: "x", limit: 50 });
    expect(seenLimit).toBe(50);
  });

  it("turns an upstream memory failure into a safe error", async () => {
    const store: MemoryStore = {
      async ensureGraph() {},
      async addMessage() { return { episodeUuid: "e" }; },
      async search() { throw new Error("zep 503: key=sk-secret-value"); },
    };
    const err: Error = await call(memoryTools(slackScope, store), "recall", { query: "x" })
      .then(() => { throw new Error("recall should have failed"); }, (e: Error) => e);
    expect(err.message).toMatch(/^upstream_unavailable: /);
    expect(err.message).not.toContain("sk-secret-value");
  });

  it("never exposes episode identifiers to model code", async () => {
    const store = recordingStore({
      "customer:acme": [{ factId: "f1", fact: "billing broke", episodeUuids: ["epi_secret"] }],
    });
    const out = await call(memoryTools({ ...slackScope, customerSlug: "acme" }, store),
      "recall", { query: "billing" });
    expect(JSON.stringify(out)).not.toContain("epi_secret");
    expect(out).toEqual([{ factId: "f1", fact: "billing broke" }]);
  });
});

describe("memory.cite integrity", () => {
  const withFacts = async (facts: MemoryFact[]) => {
    const store = recordingStore({ "customer:acme": facts });
    const tools = memoryTools({ ...slackScope, customerSlug: "acme" }, store);
    await call(tools, "recall", { query: "anything" });
    return tools;
  };

  it("resolves one recalled fact to its stored permalink", async () => {
    const seeded = await seedCitable("the invoice failed");
    const tools = await withFacts([
      { factId: "f1", fact: "invoice failed", episodeUuids: [seeded.episodeUuid] },
    ]);
    const out = await call(tools, "cite", { factIds: ["f1"] }) as Array<Record<string, unknown>>;
    expect(out).toEqual([{
      factId: "f1", fact: "invoice failed",
      permalink: seeded.permalink, ts: seeded.ts,
    }]);
  });

  it("preserves request order across several facts", async () => {
    const a = await seedCitable("first");
    const b = await seedCitable("second");
    const tools = await withFacts([
      { factId: "fa", fact: "A", episodeUuids: [a.episodeUuid] },
      { factId: "fb", fact: "B", episodeUuids: [b.episodeUuid] },
    ]);
    const out = await call(tools, "cite", { factIds: ["fb", "fa"] }) as Array<{ factId: string }>;
    expect(out.map((c) => c.factId)).toEqual(["fb", "fa"]);
  });

  it("deduplicates repeated identifiers deterministically", async () => {
    const a = await seedCitable("only once");
    const tools = await withFacts([{ factId: "fa", fact: "A", episodeUuids: [a.episodeUuid] }]);
    const out = await call(tools, "cite", { factIds: ["fa", "fa", "fa"] }) as unknown[];
    expect(out).toHaveLength(1);
  });

  // The fabrication guard: an id the model invented must not resolve.
  it("refuses an identifier that recall never returned", async () => {
    const a = await seedCitable("real");
    const tools = await withFacts([{ factId: "fa", fact: "A", episodeUuids: [a.episodeUuid] }]);
    await expect(call(tools, "cite", { factIds: ["fa", "invented"] }))
      .rejects.toThrow(/invalid_input/);
  });

  it("refuses when nothing has been recalled at all", async () => {
    const store = recordingStore();
    const tools = memoryTools(slackScope, store);
    await expect(call(tools, "cite", { factIds: ["anything"] }))
      .rejects.toThrow(/invalid_input/);
  });

  it("produces no citation when the episode has no permalink", async () => {
    const eventId = `ev_${uid()}`;
    const episodeUuid = `epi_${uid()}`;
    await env.DB.prepare(
      `INSERT INTO messages (event_id, channel_id, ts, thread_ts, user_id, text, subtype, permalink, customer_slug, received_at)
       VALUES (?, 'C1', '1712345678.000001', NULL, 'U1', 'no link', NULL, NULL, 'acme', 0)`,
    ).bind(eventId).run();
    await env.DB.prepare(
      "INSERT INTO zep_episodes (episode_uuid, event_id, graph_id, created_at) VALUES (?, ?, 'customer:acme', 0)",
    ).bind(episodeUuid, eventId).run();

    const tools = await withFacts([{ factId: "fx", fact: "A", episodeUuids: [episodeUuid] }]);
    await expect(call(tools, "cite", { factIds: ["fx"] })).resolves.toEqual([]);
  });

  it("produces no citation when the episode is unknown to D1", async () => {
    const tools = await withFacts([
      { factId: "fy", fact: "A", episodeUuids: [`epi_missing_${uid()}`] },
    ]);
    await expect(call(tools, "cite", { factIds: ["fy"] })).resolves.toEqual([]);
  });

  it("takes citation text from the recalled fact, not from model input", async () => {
    const seeded = await seedCitable("stored text");
    const tools = await withFacts([
      { factId: "fz", fact: "the recalled wording", episodeUuids: [seeded.episodeUuid] },
    ]);
    const out = await call(tools, "cite", { factIds: ["fz"] }) as Array<{ fact: string }>;
    expect(out[0].fact).toBe("the recalled wording");
  });

  it("never returns a destination identifier alongside the citation", async () => {
    const seeded = await seedCitable("some text");
    const tools = await withFacts([
      { factId: "fq", fact: "A", episodeUuids: [seeded.episodeUuid] },
    ]);
    const out = await call(tools, "cite", { factIds: ["fq"] });
    expect(JSON.stringify(out)).not.toContain(seeded.channelId);
    expect(JSON.stringify(out)).not.toContain("channel_id");
  });

  // Cross-customer isolation: the cache belongs to one execution, so facts
  // recalled by another run are not reachable even with the right id.
  it("keeps one execution's recalled facts out of another's", async () => {
    const seeded = await seedCitable("acme only");
    const acmeStore = recordingStore({
      "customer:acme": [{ factId: "shared-id", fact: "acme fact", episodeUuids: [seeded.episodeUuid] }],
    });
    const acme = memoryTools({ ...slackScope, customerSlug: "acme" }, acmeStore);
    await call(acme, "recall", { query: "x" });

    // A second execution for a different customer recalls nothing.
    const globex = memoryTools(
      { ...slackScope, runId: "run_globex", customerSlug: "globex" },
      recordingStore(),
    );
    await call(globex, "recall", { query: "x" });
    await expect(call(globex, "cite", { factIds: ["shared-id"] }))
      .rejects.toThrow(/invalid_input/);
  });
});

describe("memory has no write capability", () => {
  // findCustomers joined in Phase 10 Task 6 and is READ-ONLY: it searches the
  // D1 channel catalog and mints references. There is still no `remember()`,
  // and there is deliberately no way for the model to write a fact — memory
  // writes are automatic system behaviour driven by what actually happened, or
  // the system of record fills with things the model merely inferred.
  it("declares only read capabilities", () => {
    const tools = memoryTools(slackScope, recordingStore());
    expect(Object.keys(tools).sort()).toEqual(["cite", "findCustomers", "recall"]);
  });
});
