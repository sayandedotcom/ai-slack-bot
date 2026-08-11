# Phase 06 — Zep Memory Layer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Every ingested message reaches the right Zep graph asynchronously, and facts recalled from Zep can be resolved back to real Slack permalinks through D1 — never by string formatting.

**Depends on:** Phase 04 · **Day 2** · **Gates:** Phases 07, 17, 21

**Architecture:** D1 stays the system of record; Zep is a rebuildable projection. The ingest consumer commits to D1 first, then enqueues a `{ event_id }` job on a new `firefighter-memory` queue. A separate consumer reads the row back from D1 and writes it to Zep, recording the returned episode UUID in a `zep_episodes` mapping table. Citations resolve fact → episode UUID → `event_id` → stored permalink. Killing Zep loses nothing: retries are per-queue, and a backfill endpoint re-enqueues any unmapped message.

**Docs MCP:** The `zep-docs` MCP server (`https://docs-mcp.getzep.com/mcp`) is configured in this workspace. **Every Zep API shape in this plan is a hypothesis until Task 1's live round-trip confirms it.** V3 renamed V2 "groups" to "graphs", and the Feb 2026 deprecation wave removed params like `min_score` from `graph.search()` — V2-shaped code compiles and fails. Record every wrong shape the model produces in `docs/superpowers/plans/phase-06-notes.md`; that file is raw material for the README's AI-tool notes (a graded deliverable).

**Global constraints** from `00-roadmap.md` apply. Three bear directly on this phase: **all ingest writes are idempotent on `event_id`**; **a Zep failure must never block or poison the D1 write**; **citations resolve through D1, never through string-formatted URLs** (decision D4).

---

## File Structure

```
apps/worker/scripts/zep-spike.ts          Task 1: throwaway live V3 round-trip
apps/worker/src/memory/graphs.ts          graph routing — pure, no I/O
apps/worker/src/memory/store.ts           MemoryStore interface + types
apps/worker/src/memory/zep.ts             ZepMemory: the real client wrapper
apps/worker/src/memory/consumer.ts        memory queue batch handler
apps/worker/src/memory/cite.ts            fact → episode → D1 → permalink
apps/worker/src/api/backfill.ts           POST /api/backfill/memory (behind Access)
apps/worker/migrations/0002_memory.sql    zep_episodes mapping table
apps/worker/src/ingest/consumer.ts        modify: enqueue memory job after D1 commit
apps/worker/src/index.ts                  modify: Env, queue routing on batch.queue
apps/worker/wrangler.jsonc                modify: firefighter-memory queue
apps/worker/.dev.vars.example             modify: ZEP_API_KEY
apps/worker/test/graphs.test.ts
apps/worker/test/memory-consumer.test.ts
apps/worker/test/cite.test.ts
apps/worker/test/helpers/fake-memory.ts   in-memory MemoryStore for tests
```

The `MemoryStore` interface is the seam: consumers and `cite()` are tested against `FakeMemoryStore`; the real `ZepMemory` is verified by the Task 1 spike (live) plus typechecking. Phase 07's triage and Phase 09's `memory` binding both consume the same interface.

---

### Task 1: Verify the V3 API live, before writing any wrapper

**Files:** Create `apps/worker/scripts/zep-spike.ts`, `docs/superpowers/plans/phase-06-notes.md`

**Interfaces:**
- Produces: the *verified* shapes of `graph.create`, `graph.add`, `graph.search`, and the episode/edge result types — which Task 3 copies verbatim.

- [ ] **Step 1: Install the SDK**

```bash
cd apps/worker && pnpm add @getzep/zep-cloud && pnpm add -D tsx
```

- [ ] **Step 2: Query the `zep-docs` MCP server** for the current V3 signatures of `graph.create`, `graph.add`, `graph.search` in the TypeScript SDK, and the shape of the returned `Episode` and search results. Correct the script below where the docs disagree — the docs win.

- [ ] **Step 3: Write the spike script**

`apps/worker/scripts/zep-spike.ts` (shapes below are the expected V3 forms — fix per Step 2):

```ts
// Throwaway spike: one live round-trip to pin down the real V3 API surface.
// Run: ZEP_API_KEY=... pnpm tsx scripts/zep-spike.ts
import { ZepClient } from "@getzep/zep-cloud";

const zep = new ZepClient({ apiKey: process.env.ZEP_API_KEY! });
const graphId = `spike-${Date.now()}`;

async function main() {
  const created = await zep.graph.create({ graphId, name: "spike graph" });
  console.log("create ->", JSON.stringify(created));

  const episode = await zep.graph.add({
    graphId,
    type: "message",
    data: "priya: checkout is broken on the pricing page again",
  });
  console.log("add ->", JSON.stringify(episode));
  // Record: what is the episode UUID field called? episode.uuid? episode.uuid_?

  // Zep ingests asynchronously; give it a moment before searching.
  await new Promise((r) => setTimeout(r, 15000));

  const results = await zep.graph.search({
    graphId,
    query: "checkout problems",
    scope: "edges",
    limit: 5,
  });
  console.log("search ->", JSON.stringify(results, null, 2));
  // Record: edge fields (uuid? fact? episodes?) and whether min_score is rejected.
}

main().catch((e) => {
  console.error("SPIKE FAILED:", e);
  process.exit(1);
});
```

- [ ] **Step 4: Run it live** with the real `ZEP_API_KEY` (add the key to `.dev.vars` first; the script reads the env var directly):

```bash
cd apps/worker && ZEP_API_KEY=$(grep '^ZEP_API_KEY=' .dev.vars | cut -d= -f2) pnpm tsx scripts/zep-spike.ts
```

Expected: three JSON dumps. If `graph.search` returns empty edges, wait longer and re-search — ingestion is async — but `graph.add` returning an episode with a UUID is the load-bearing result.

- [ ] **Step 5: Record findings** in `docs/superpowers/plans/phase-06-notes.md`: the exact confirmed method signatures, the episode UUID field name, the edge result shape, and **every V2-shaped API the model suggested that does not exist** (this is the AI-tool-notes raw material).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/scripts/zep-spike.ts apps/worker/package.json pnpm-lock.yaml docs/superpowers/plans/phase-06-notes.md
git commit -m "spike(memory): verify zep v3 graph api with a live round-trip"
```

---

### Task 2: Graph routing

**Files:** Create `apps/worker/src/memory/graphs.ts`, `apps/worker/test/graphs.test.ts`

**Interfaces:**
- Consumes: `ChannelPolicy` from `src/db/channels.ts` (Phase 03)
- Produces: `graphIdFor(policy: ChannelPolicy): string | null` — `customer:{slug}` for customer channels, `org` for internal, `null` for unknown channels (nothing unknown reaches memory). Consumed by Tasks 4, 5 and Phase 07.

- [ ] **Step 1: Write the failing tests**

`apps/worker/test/graphs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { graphIdFor } from "../src/memory/graphs";
import type { ChannelPolicy } from "../src/db/channels";

const base: ChannelPolicy = {
  channel_id: "C1",
  name: "ext-pulsefit",
  customer_slug: "pulsefit",
  mode: "live",
  known: true,
};

describe("graphIdFor", () => {
  it("routes customer channels to customer:{slug}", () => {
    expect(graphIdFor(base)).toBe("customer:pulsefit");
    expect(graphIdFor({ ...base, mode: "observe" })).toBe("customer:pulsefit");
  });

  it("routes internal channels to org", () => {
    expect(graphIdFor({ ...base, customer_slug: null, mode: "internal" })).toBe("org");
  });

  it("routes an internal channel with a slug to org, not the customer graph", () => {
    expect(graphIdFor({ ...base, mode: "internal" })).toBe("org");
  });

  it("returns null for unknown channels", () => {
    expect(graphIdFor({ ...base, known: false })).toBeNull();
  });

  it("returns null for known channels with no slug and no internal mode", () => {
    expect(graphIdFor({ ...base, customer_slug: null, mode: "observe" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/worker && pnpm vitest run test/graphs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/worker/src/memory/graphs.ts`:

```ts
import type { ChannelPolicy } from "../db/channels";

/**
 * Which Zep graph a channel's messages belong to. Customer channels get a
 * per-customer graph; internal channels share the org graph. Unknown channels
 * get nothing — fail closed, same rule as posting. See spec §7 / decision D4.
 */
export function graphIdFor(policy: ChannelPolicy): string | null {
  if (!policy.known) return null;
  if (policy.mode === "internal") return "org";
  if (policy.customer_slug !== null) return `customer:${policy.customer_slug}`;
  return null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/worker && pnpm vitest run test/graphs.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/memory/graphs.ts apps/worker/test/graphs.test.ts
git commit -m "feat(memory): pure graph routing with fail-closed unknown channels"
```

---

### Task 3: MemoryStore interface and the Zep wrapper

**Files:** Create `apps/worker/src/memory/store.ts`, `apps/worker/src/memory/zep.ts`, `apps/worker/test/helpers/fake-memory.ts`, `apps/worker/migrations/0002_memory.sql`

**Interfaces:**
- Produces (consumed by Tasks 4–6, Phase 07, Phase 09):

```ts
export type MemoryFact = { factId: string; fact: string; episodeUuids: string[] };
export interface MemoryStore {
  /** Idempotent per isolate: creates the graph if missing, caches success. */
  ensureGraph(graphId: string): Promise<void>;
  /** Writes one episode; returns its UUID for the D1 mapping. */
  addMessage(graphId: string, data: string): Promise<{ episodeUuid: string }>;
  search(graphId: string, query: string, limit?: number): Promise<MemoryFact[]>;
}
```

- [ ] **Step 1: Write the migration**

`apps/worker/migrations/0002_memory.sql`:

```sql
-- Maps Zep episode UUIDs back to the D1 message that produced them. This is
-- what makes citations exact: fact -> episode -> event_id -> stored permalink,
-- never a formatted URL. See decision D4.
CREATE TABLE zep_episodes (
  episode_uuid TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL,
  graph_id     TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_zep_episodes_event ON zep_episodes (event_id);
```

- [ ] **Step 2: Write the interface**

`apps/worker/src/memory/store.ts`:

```ts
export type MemoryFact = {
  /** The Zep edge UUID — opaque handle a caller passes back to cite(). */
  factId: string;
  fact: string;
  /** Source episode UUIDs; cite() resolves these through zep_episodes. */
  episodeUuids: string[];
};

/**
 * The one seam between the app and Zep. Consumers, triage, and the Phase 09
 * `memory` binding all program against this; only zep.ts knows the SDK.
 */
export interface MemoryStore {
  ensureGraph(graphId: string): Promise<void>;
  addMessage(graphId: string, data: string): Promise<{ episodeUuid: string }>;
  search(graphId: string, query: string, limit?: number): Promise<MemoryFact[]>;
}
```

- [ ] **Step 3: Write the fake** (test infrastructure for Tasks 4–6 and Phase 07)

`apps/worker/test/helpers/fake-memory.ts`:

```ts
import type { MemoryFact, MemoryStore } from "../../src/memory/store";

let uuidCounter = 0;

export class FakeMemoryStore implements MemoryStore {
  graphs = new Set<string>();
  episodes: { graphId: string; data: string; episodeUuid: string }[] = [];
  searchResults: MemoryFact[] = [];
  failNextAdd = false;

  async ensureGraph(graphId: string): Promise<void> {
    this.graphs.add(graphId);
  }

  async addMessage(graphId: string, data: string): Promise<{ episodeUuid: string }> {
    if (this.failNextAdd) {
      this.failNextAdd = false;
      throw new Error("zep unavailable");
    }
    const episodeUuid = `ep-${++uuidCounter}`;
    this.episodes.push({ graphId, data, episodeUuid });
    return { episodeUuid };
  }

  async search(): Promise<MemoryFact[]> {
    return this.searchResults;
  }
}
```

- [ ] **Step 4: Write the real wrapper**, using the shapes **Task 1 confirmed** (adjust field names to match `phase-06-notes.md` — do not trust the draft below over the spike output):

`apps/worker/src/memory/zep.ts`:

```ts
import { ZepClient } from "@getzep/zep-cloud";
import type { MemoryFact, MemoryStore } from "./store";

/**
 * Real Zep V3 client. Graph existence is cached per isolate so the common
 * path costs zero extra round-trips; the cache resets on isolate recycle,
 * which just means one redundant idempotent create.
 */
export class ZepMemory implements MemoryStore {
  private client: ZepClient;
  private known = new Set<string>();

  constructor(apiKey: string) {
    this.client = new ZepClient({ apiKey });
  }

  async ensureGraph(graphId: string): Promise<void> {
    if (this.known.has(graphId)) return;
    try {
      await this.client.graph.create({ graphId, name: graphId });
    } catch (e: unknown) {
      // Already-exists is success; anything else is a real failure.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/exist|conflict|400|409/i.test(msg)) throw e;
    }
    this.known.add(graphId);
  }

  async addMessage(graphId: string, data: string): Promise<{ episodeUuid: string }> {
    await this.ensureGraph(graphId);
    const episode = await this.client.graph.add({ graphId, type: "message", data });
    return { episodeUuid: episode.uuid ?? "" };
  }

  async search(graphId: string, query: string, limit = 8): Promise<MemoryFact[]> {
    const res = await this.client.graph.search({ graphId, query, scope: "edges", limit });
    return (res.edges ?? []).map((edge) => ({
      factId: edge.uuid ?? "",
      fact: edge.fact ?? "",
      episodeUuids: edge.episodes ?? [],
    }));
  }
}
```

- [ ] **Step 5: Typecheck and apply migrations in tests**

Run: `cd apps/worker && pnpm tsc --noEmit && pnpm vitest run`
Expected: typechecks clean; existing suite still green (the migration is picked up by the Phase 01 `readD1Migrations` harness automatically — it reads the whole `migrations/` directory).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/memory/store.ts apps/worker/src/memory/zep.ts apps/worker/test/helpers/fake-memory.ts apps/worker/migrations/0002_memory.sql
git commit -m "feat(memory): MemoryStore seam, zep v3 wrapper, episode mapping table"
```

---

### Task 4: Memory queue — fan-out after the D1 commit

**Files:** Create `apps/worker/src/memory/consumer.ts`, `apps/worker/test/memory-consumer.test.ts` · Modify `apps/worker/src/ingest/consumer.ts`, `apps/worker/src/index.ts`, `apps/worker/wrangler.jsonc`, `apps/worker/.dev.vars.example`

**Interfaces:**
- Consumes: `graphIdFor` (Task 2), `MemoryStore` (Task 3), `getChannelPolicy` (Phase 03)
- Produces: `handleMemoryBatch(batch: MessageBatch<MemoryJob>, env: Env, store: MemoryStore): Promise<void>` with `type MemoryJob = { event_id: string }`. Ingest consumer now sends `MemoryJob`s to `env.MEMORY_QUEUE`.

- [ ] **Step 1: Write the failing tests**

`apps/worker/test/memory-consumer.test.ts` (mirror the existing `test/ingest.test.ts` harness style — `env` from `cloudflare:test`, rows seeded with `env.DB.prepare(...)`):

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleMemoryBatch, type MemoryJob } from "../src/memory/consumer";
import { FakeMemoryStore } from "./helpers/fake-memory";

function batchOf(eventIds: string[]) {
  const acked: string[] = [];
  const retried: string[] = [];
  const batch = {
    queue: "firefighter-memory",
    messages: eventIds.map((event_id) => ({
      body: { event_id } as MemoryJob,
      ack: () => acked.push(event_id),
      retry: () => retried.push(event_id),
    })),
  } as unknown as MessageBatch<MemoryJob>;
  return { batch, acked, retried };
}

async function seedMessage(eventId: string, channelId: string, text: string) {
  await env.DB.prepare(
    `INSERT INTO messages (event_id, channel_id, ts, thread_ts, user_id, text, subtype, permalink, customer_slug, received_at)
     VALUES (?, ?, '1.1', NULL, 'U1', ?, NULL, 'https://slack.example/p1', 'pulsefit', 1)`,
  ).bind(eventId, channelId, text).run();
}

describe("handleMemoryBatch", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES ('C1', 'ext-pulsefit', 'pulsefit', 'live')",
    ).run();
  });

  it("writes the message to the customer graph and records the episode mapping", async () => {
    await seedMessage("Ev1", "C1", "checkout is broken");
    const store = new FakeMemoryStore();
    const { batch, acked } = batchOf(["Ev1"]);

    await handleMemoryBatch(batch, env, store);

    expect(store.episodes).toHaveLength(1);
    expect(store.episodes[0].graphId).toBe("customer:pulsefit");
    expect(store.episodes[0].data).toContain("checkout is broken");
    const row = await env.DB.prepare("SELECT event_id, graph_id FROM zep_episodes WHERE event_id = 'Ev1'").first();
    expect(row).toMatchObject({ event_id: "Ev1", graph_id: "customer:pulsefit" });
    expect(acked).toEqual(["Ev1"]);
  });

  it("is idempotent: an already-mapped event is acked without a second episode", async () => {
    await seedMessage("Ev1", "C1", "hello");
    const store = new FakeMemoryStore();
    await handleMemoryBatch(batchOf(["Ev1"]).batch, env, store);
    const { batch, acked } = batchOf(["Ev1"]);

    await handleMemoryBatch(batch, env, store);

    expect(store.episodes).toHaveLength(1);
    expect(acked).toEqual(["Ev1"]);
  });

  it("retries the failing message without failing the batch", async () => {
    await seedMessage("Ev1", "C1", "first");
    await seedMessage("Ev2", "C1", "second");
    const store = new FakeMemoryStore();
    store.failNextAdd = true;
    const { batch, acked, retried } = batchOf(["Ev1", "Ev2"]);

    await handleMemoryBatch(batch, env, store);

    expect(retried).toEqual(["Ev1"]);
    expect(acked).toEqual(["Ev2"]);
  });

  it("acks and skips messages whose channel has no graph", async () => {
    await seedMessage("Ev9", "C_UNKNOWN", "noise");
    const store = new FakeMemoryStore();
    const { batch, acked } = batchOf(["Ev9"]);

    await handleMemoryBatch(batch, env, store);

    expect(store.episodes).toHaveLength(0);
    expect(acked).toEqual(["Ev9"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/worker && pnpm vitest run test/memory-consumer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the consumer**

`apps/worker/src/memory/consumer.ts`:

```ts
import type { Env } from "../index";
import type { MemoryStore } from "./store";
import { getChannelPolicy } from "../db/channels";
import { graphIdFor } from "./graphs";

export type MemoryJob = { event_id: string };

type MessageRow = {
  event_id: string;
  channel_id: string;
  user_id: string | null;
  text: string;
};

/**
 * Projects D1 messages into Zep, one episode per message. D1 committed before
 * this job existed, so every failure path here is safe: retry re-reads the row,
 * and the zep_episodes check makes a duplicate delivery a no-op.
 */
export async function handleMemoryBatch(
  batch: MessageBatch<MemoryJob>,
  env: Env,
  store: MemoryStore,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await projectOne(message.body.event_id, env, store);
      message.ack();
    } catch {
      message.retry();
    }
  }
}

async function projectOne(eventId: string, env: Env, store: MemoryStore): Promise<void> {
  const mapped = await env.DB.prepare("SELECT 1 FROM zep_episodes WHERE event_id = ?")
    .bind(eventId)
    .first();
  if (mapped) return;

  const row = await env.DB.prepare(
    "SELECT event_id, channel_id, user_id, text FROM messages WHERE event_id = ?",
  )
    .bind(eventId)
    .first<MessageRow>();
  if (!row) return; // Nothing in D1 means nothing to project.

  const policy = await getChannelPolicy(env.DB, row.channel_id);
  const graphId = graphIdFor(policy);
  if (!graphId) return;

  const { episodeUuid } = await store.addMessage(graphId, `${row.user_id ?? "unknown"}: ${row.text}`);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO zep_episodes (episode_uuid, event_id, graph_id, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(episodeUuid, eventId, graphId, Date.now())
    .run();
}
```

- [ ] **Step 4: Wire the fan-out and the queue routing**

`apps/worker/src/ingest/consumer.ts` — after the `insertMessage` call (and before the permalink backfill), add:

```ts
    // D1 is committed; everything downstream is a projection with its own
    // retry budget. A queue send failing must not fail ingest.
    try {
      await env.MEMORY_QUEUE.send({ event_id });
    } catch {}
```

`apps/worker/src/index.ts` — extend `Env` and route on `batch.queue`:

```ts
import { handleMemoryBatch, type MemoryJob } from "./memory/consumer";
import { ZepMemory } from "./memory/zep";

export type Env = {
  DB: D1Database;
  INGEST_QUEUE: Queue;
  MEMORY_QUEUE: Queue<MemoryJob>;
  ASSETS: Fetcher;
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  ZEP_API_KEY: string;
};
```

```ts
export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<QueuedEvent | MemoryJob>, env: Env): Promise<void> {
    switch (batch.queue) {
      case "firefighter-ingest":
        return handleIngestBatch(batch as MessageBatch<QueuedEvent>, env);
      case "firefighter-memory":
        return handleMemoryBatch(batch as MessageBatch<MemoryJob>, env, new ZepMemory(env.ZEP_API_KEY));
    }
  },
} satisfies ExportedHandler<Env, QueuedEvent | MemoryJob>;
```

`apps/worker/wrangler.jsonc` — add to `queues.producers`:

```jsonc
{ "binding": "MEMORY_QUEUE", "queue": "firefighter-memory" }
```

and to `queues.consumers`:

```jsonc
{
  "queue": "firefighter-memory",
  "max_batch_size": 10,
  "max_batch_timeout": 5,
  "max_retries": 5,
  "dead_letter_queue": "firefighter-memory-dlq"
}
```

`apps/worker/.dev.vars.example` — append:

```
# Zep Cloud API key (Zep dashboard -> Project -> API keys). Powers the org and
# per-customer recall graphs. A missing key breaks memory projection only —
# ingest to D1 is unaffected.
ZEP_API_KEY=
```

Also check `apps/worker/vitest.config.ts`: if the miniflare config enumerates queue producer bindings explicitly, add `MEMORY_QUEUE` there the same way `INGEST_QUEUE` is declared; if queues come from `wrangler.jsonc`, nothing to do.

- [ ] **Step 5: Run tests, then create the live queues**

Run: `cd apps/worker && pnpm vitest run && pnpm tsc --noEmit`
Expected: full suite green.

```bash
pnpm wrangler queues create firefighter-memory
pnpm wrangler queues create firefighter-memory-dlq
```

- [ ] **Step 6: Commit**

```bash
git add -A apps/worker
git commit -m "feat(memory): async zep projection via dedicated queue, d1 commit never blocked"
```

---

### Task 5: Citation resolution

**Files:** Create `apps/worker/src/memory/cite.ts`, `apps/worker/test/cite.test.ts`

**Interfaces:**
- Consumes: `MemoryFact` (Task 3), `zep_episodes` + `messages` tables
- Produces: `cite(db: D1Database, facts: MemoryFact[]): Promise<Citation[]>` with `type Citation = { factId: string; fact: string; permalink: string; channel_id: string; ts: string }`. Consumed by Phase 09's `memory.cite` binding and Phase 17's chat page.

- [ ] **Step 1: Write the failing tests**

`apps/worker/test/cite.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { cite } from "../src/memory/cite";
import type { MemoryFact } from "../src/memory/store";

describe("cite", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      `INSERT INTO messages (event_id, channel_id, ts, thread_ts, user_id, text, subtype, permalink, customer_slug, received_at)
       VALUES ('Ev1', 'C1', '1.1', NULL, 'U1', 'checkout broke', NULL, 'https://zellify.slack.com/archives/C1/p11', 'pulsefit', 1)`,
    ).run();
    await env.DB.prepare(
      "INSERT INTO zep_episodes (episode_uuid, event_id, graph_id, created_at) VALUES ('ep-1', 'Ev1', 'customer:pulsefit', 1)",
    ).run();
  });

  it("resolves a fact to the stored permalink", async () => {
    const facts: MemoryFact[] = [{ factId: "edge-1", fact: "checkout broke", episodeUuids: ["ep-1"] }];
    const citations = await cite(env.DB, facts);
    expect(citations).toEqual([
      {
        factId: "edge-1",
        fact: "checkout broke",
        permalink: "https://zellify.slack.com/archives/C1/p11",
        channel_id: "C1",
        ts: "1.1",
      },
    ]);
  });

  it("returns nothing for a fact with no matching episode — never a fabricated URL", async () => {
    const facts: MemoryFact[] = [{ factId: "edge-2", fact: "ghost", episodeUuids: ["ep-unknown"] }];
    expect(await cite(env.DB, facts)).toEqual([]);
  });

  it("skips episodes whose message has no stored permalink", async () => {
    await env.DB.prepare(
      `INSERT INTO messages (event_id, channel_id, ts, thread_ts, user_id, text, subtype, permalink, customer_slug, received_at)
       VALUES ('Ev2', 'C1', '2.2', NULL, 'U1', 'no link', NULL, NULL, 'pulsefit', 2)`,
    ).run();
    await env.DB.prepare(
      "INSERT INTO zep_episodes (episode_uuid, event_id, graph_id, created_at) VALUES ('ep-2', 'Ev2', 'customer:pulsefit', 2)",
    ).run();
    const facts: MemoryFact[] = [{ factId: "edge-3", fact: "no link", episodeUuids: ["ep-2"] }];
    expect(await cite(env.DB, facts)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/worker && pnpm vitest run test/cite.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/worker/src/memory/cite.ts`:

```ts
import type { MemoryFact } from "./store";

export type Citation = {
  factId: string;
  fact: string;
  permalink: string;
  channel_id: string;
  ts: string;
};

/**
 * Facts are probabilistic; citations must be exact. Resolution goes
 * episode UUID -> zep_episodes -> messages.permalink, and a miss anywhere in
 * that chain yields no citation rather than a constructed URL. Decision D4.
 */
export async function cite(db: D1Database, facts: MemoryFact[]): Promise<Citation[]> {
  const citations: Citation[] = [];
  for (const fact of facts) {
    for (const episodeUuid of fact.episodeUuids) {
      const row = await db
        .prepare(
          `SELECT m.permalink, m.channel_id, m.ts
           FROM zep_episodes z JOIN messages m ON m.event_id = z.event_id
           WHERE z.episode_uuid = ?`,
        )
        .bind(episodeUuid)
        .first<{ permalink: string | null; channel_id: string; ts: string }>();
      if (!row?.permalink) continue;
      citations.push({
        factId: fact.factId,
        fact: fact.fact,
        permalink: row.permalink,
        channel_id: row.channel_id,
        ts: row.ts,
      });
      break; // One citation per fact — the first resolvable episode wins.
    }
  }
  return citations;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/worker && pnpm vitest run test/cite.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/memory/cite.ts apps/worker/test/cite.test.ts
git commit -m "feat(memory): exact citation resolution through d1, misses yield nothing"
```

---

### Task 6: Backfill endpoint for pre-phase messages

**Files:** Create `apps/worker/src/api/backfill.ts` · Modify `apps/worker/src/index.ts`

**Interfaces:**
- Consumes: `MEMORY_QUEUE`, `messages`, `zep_episodes`
- Produces: `POST /api/backfill/memory` → `{ enqueued: number }`. Sits behind Cloudflare Access like every `/api` route (Phase 05), so no extra auth here.

- [ ] **Step 1: Write the failing test** (append to `apps/worker/test/memory-consumer.test.ts`)

```ts
import { backfillMemory } from "../src/api/backfill";

describe("backfillMemory", () => {
  it("enqueues only unmapped messages, capped", async () => {
    await seedMessage("EvA", "C1", "one");
    await seedMessage("EvB", "C1", "two");
    await env.DB.prepare(
      "INSERT INTO zep_episodes (episode_uuid, event_id, graph_id, created_at) VALUES ('ep-a', 'EvA', 'customer:pulsefit', 1)",
    ).run();
    const sent: string[] = [];
    const queue = { send: async (job: MemoryJob) => void sent.push(job.event_id) } as unknown as Queue<MemoryJob>;

    const enqueued = await backfillMemory(env.DB, queue, 100);

    expect(enqueued).toBe(1);
    expect(sent).toEqual(["EvB"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/worker && pnpm vitest run test/memory-consumer.test.ts`
Expected: FAIL — `backfillMemory` not found.

- [ ] **Step 3: Implement**

`apps/worker/src/api/backfill.ts`:

```ts
import { Hono } from "hono";
import type { Env } from "../index";
import type { MemoryJob } from "../memory/consumer";

/**
 * Re-enqueues messages that predate the memory layer (or fell into the DLQ)
 * through the exact same consumer path — no second projection code path to
 * drift. Idempotent: the consumer skips already-mapped events anyway.
 */
export async function backfillMemory(
  db: D1Database,
  queue: Queue<MemoryJob>,
  limit: number,
): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT m.event_id FROM messages m
       LEFT JOIN zep_episodes z ON z.event_id = m.event_id
       WHERE z.event_id IS NULL
       ORDER BY m.received_at ASC LIMIT ?`,
    )
    .bind(limit)
    .all<{ event_id: string }>();

  for (const row of results) {
    await queue.send({ event_id: row.event_id });
  }
  return results.length;
}

export const backfillApi = new Hono<{ Bindings: Env }>();

backfillApi.post("/backfill/memory", async (c) => {
  const enqueued = await backfillMemory(c.env.DB, c.env.MEMORY_QUEUE, 200);
  return c.json({ enqueued });
});
```

`apps/worker/src/index.ts` — alongside the existing `app.route("/api", countersApi)`:

```ts
import { backfillApi } from "./api/backfill";
app.route("/api", backfillApi);
```

- [ ] **Step 4: Run the full suite**

Run: `cd apps/worker && pnpm vitest run && pnpm tsc --noEmit`
Expected: everything green.

- [ ] **Step 5: Deploy and verify the exit criteria live**

```bash
cd apps/worker && pnpm wrangler secret put ZEP_API_KEY && pnpm wrangler deploy
curl -X POST https://<origin>/api/backfill/memory   # via an Access-authenticated browser/session
```

Then post a message in a test customer channel and confirm, via the Zep dashboard (or a one-off `graph.search` with the spike script pointed at `customer:{slug}`), that it lands within seconds; confirm `zep_episodes` rows with `pnpm wrangler d1 execute firefighter --remote --command "SELECT count(*) FROM zep_episodes"`.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/api/backfill.ts apps/worker/src/index.ts apps/worker/test/memory-consumer.test.ts
git commit -m "feat(memory): backfill endpoint reusing the projection consumer"
```

---

## Exit criteria

- A message posted in a test channel appears in `customer:{slug}` within seconds, with a `zep_episodes` row.
- `cite()` returns real stored permalinks; a fact with no D1 mapping returns no citation.
- Killing Zep (wrong API key) loses zero messages: D1 rows and counters unaffected, jobs retry then park in the DLQ, and the backfill endpoint recovers them.
- `phase-06-notes.md` records every invented Zep API encountered.
