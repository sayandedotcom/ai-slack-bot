# Phase 07 — Triage

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A cheap model decides which customer-channel messages wake the main agent, writes the opening prompt for the ones that do, and stores every decision with its cost — so the $500 ceiling is observable and the Phase 21 eval set accumulates for free.

**Depends on:** Phase 06 · **Day 3** · **Gates:** Phases 08 (wake wiring), 21 (eval)

**Architecture:** The ingest consumer enqueues a `{ event_id }` job on a `firefighter-triage` queue for messages where `shouldTriage(policy)` holds. The triage consumer loads the message + thread from D1 and a compact recall block from the customer's Zep graph, builds a prompt with a pure function, and calls **Haiku 4.5 (`claude-haiku-4-5` — $1/MTok in, $5/MTok out, verified 2026-08-11)** for structured output `{ wake, why, opening_prompt }`. The decision is stored in `triage_decisions` idempotently. Nothing is woken yet — Phase 08 wires `wake=true` to a RunDO; this phase proves the judgment and the telemetry.

**Load-bearing constraint (global): triage never emits a ticket type.** No `type`, no `category`, no enum of bug/feature/question — a schema-shape test enforces this, because a type field is how the banned pipeline sneaks back in.

**Docs note:** The Vercel AI SDK (`ai` + `@ai-sdk/anthropic`) is the project's model layer (roadmap tech stack, reused in Phase 10). Its `generateObject` API and usage-field names move between majors — **verify against the installed package's `.d.ts`** (`node_modules/ai/dist/index.d.ts`), not memory. Record any invented API in `docs/superpowers/plans/phase-07-notes.md`.

**Global constraints** from `00-roadmap.md` apply, notably: idempotency on `event_id`; internal and unknown channels never reach the model; fail closed.

---

## File Structure

```
apps/worker/migrations/0003_triage.sql     triage_decisions table
apps/worker/src/triage/prompt.ts           prompt builder — pure, no I/O
apps/worker/src/triage/run.ts              zod schema + Haiku call + cost math
apps/worker/src/triage/consumer.ts         queue batch handler
apps/worker/src/db/counters.ts             modify: real `triaged` count
apps/worker/src/ingest/consumer.ts         modify: enqueue on shouldTriage
apps/worker/src/index.ts                   modify: Env, queue routing
apps/worker/wrangler.jsonc                 modify: firefighter-triage queue
apps/worker/.dev.vars.example              modify: ANTHROPIC_API_KEY
apps/worker/test/triage-prompt.test.ts
apps/worker/test/triage-run.test.ts        schema-shape guard + cost math
apps/worker/test/triage-consumer.test.ts
apps/worker/test/counters.test.ts          modify: triaged counter case
```

The model call is the only impure edge. `runTriage` is injected into the consumer as a function, so consumer tests use a stub and never spend a token; the schema guard and cost math are pure and tested exactly.

---

### Task 1: `triage_decisions` table

**Files:** Create `apps/worker/migrations/0003_triage.sql`

**Interfaces:**
- Produces: the table consumed by Tasks 3–5, Phase 08 (wake), Phase 21 (eval).

- [ ] **Step 1: Write the migration**

`apps/worker/migrations/0003_triage.sql`:

```sql
-- One row per triage decision. Storing every decision (not just wakes) is what
-- makes the Phase 21 eval set possible and the `triaged` counter exact.
-- Deliberately NO type/category column — see the global constraint.
CREATE TABLE triage_decisions (
  event_id       TEXT PRIMARY KEY,
  wake           INTEGER NOT NULL CHECK (wake IN (0, 1)),
  why            TEXT NOT NULL,
  opening_prompt TEXT NOT NULL,
  model          TEXT NOT NULL,
  cost_usd       REAL NOT NULL,
  latency_ms     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE INDEX idx_triage_created ON triage_decisions (created_at);
```

- [ ] **Step 2: Verify the harness picks it up**

Run: `cd apps/worker && pnpm vitest run`
Expected: suite green (migrations auto-applied by the Phase 01 test setup).

- [ ] **Step 3: Commit**

```bash
git add apps/worker/migrations/0003_triage.sql
git commit -m "feat(db): triage_decisions table with cost telemetry, no type column"
```

---

### Task 2: Prompt builder

**Files:** Create `apps/worker/src/triage/prompt.ts`, `apps/worker/test/triage-prompt.test.ts`

**Interfaces:**
- Consumes: `MemoryFact` from `src/memory/store.ts` (Phase 06)
- Produces (consumed by Tasks 3–4):

```ts
export type TriageInput = {
  channelName: string;
  customerSlug: string;
  message: { user_id: string | null; text: string; permalink: string | null };
  thread: { user_id: string | null; text: string }[]; // oldest first, excludes the message itself
  recall: MemoryFact[];
};
export function buildTriagePrompt(input: TriageInput): string;
export const TRIAGE_SYSTEM: string;
```

- [ ] **Step 1: Write the failing tests**

`apps/worker/test/triage-prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTriagePrompt, TRIAGE_SYSTEM, type TriageInput } from "../src/triage/prompt";

const base: TriageInput = {
  channelName: "ext-pulsefit",
  customerSlug: "pulsefit",
  message: { user_id: "U1", text: "how do I add a second language variant?", permalink: "https://x/p1" },
  thread: [{ user_id: "U2", text: "earlier context" }],
  recall: [{ factId: "f1", fact: "PulseFit complained about checkout in June", episodeUuids: ["ep1"] }],
};

describe("buildTriagePrompt", () => {
  it("includes the message, thread, and recall facts", () => {
    const p = buildTriagePrompt(base);
    expect(p).toContain("how do I add a second language variant?");
    expect(p).toContain("earlier context");
    expect(p).toContain("PulseFit complained about checkout in June");
    expect(p).toContain("ext-pulsefit");
  });

  it("renders cleanly with no thread and no recall", () => {
    const p = buildTriagePrompt({ ...base, thread: [], recall: [] });
    expect(p).toContain("(no earlier messages in this thread)");
    expect(p).toContain("(no stored context for this customer)");
  });

  it("never mentions ticket types in the system prompt", () => {
    for (const banned of ["bug report", "feature request", "ticket type", "categor"]) {
      expect(TRIAGE_SYSTEM.toLowerCase()).not.toContain(banned);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/worker && pnpm vitest run test/triage-prompt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/worker/src/triage/prompt.ts`:

```ts
import type { MemoryFact } from "../memory/store";

export type TriageInput = {
  channelName: string;
  customerSlug: string;
  message: { user_id: string | null; text: string; permalink: string | null };
  thread: { user_id: string | null; text: string }[];
  recall: MemoryFact[];
};

/**
 * Deliberately says nothing about kinds of ticket. Triage adjudicates one
 * question — does this deserve a human-grade response from us right now —
 * and writes the opening prompt. What kind of thing it is, is the agent's
 * problem. See spec §4.3.
 */
export const TRIAGE_SYSTEM = `You triage messages from a customer Slack channel for a small engineering team.
Decide whether this message needs the team to act or respond (wake=true), or is banter, acknowledgment, an emoji-level reaction, or something already being handled in-thread (wake=false).
Most messages do not need action. Questions, requests, and reports of something broken do.
If wake is true, write opening_prompt: a concise briefing for the engineer's agent — what the customer said, the thread context that matters, and what we know about this customer. Quote the customer's actual words where the wording matters.
Always explain the decision in one sentence as "why".`;

export function buildTriagePrompt(input: TriageInput): string {
  const thread =
    input.thread.length === 0
      ? "(no earlier messages in this thread)"
      : input.thread.map((m) => `${m.user_id ?? "unknown"}: ${m.text}`).join("\n");
  const recall =
    input.recall.length === 0
      ? "(no stored context for this customer)"
      : input.recall.map((f) => `- ${f.fact}`).join("\n");

  return [
    `Channel: #${input.channelName} (customer: ${input.customerSlug})`,
    ``,
    `Thread so far:`,
    thread,
    ``,
    `What memory knows about this customer:`,
    recall,
    ``,
    `New message from ${input.message.user_id ?? "unknown"}:`,
    input.message.text,
  ].join("\n");
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/worker && pnpm vitest run test/triage-prompt.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/triage/prompt.ts apps/worker/test/triage-prompt.test.ts
git commit -m "feat(triage): pure prompt builder that never names a ticket type"
```

---

### Task 3: Structured output via Haiku 4.5, with the schema guard

**Files:** Create `apps/worker/src/triage/run.ts`, `apps/worker/test/triage-run.test.ts`

**Interfaces:**
- Consumes: `TriageInput`, `buildTriagePrompt`, `TRIAGE_SYSTEM` (Task 2)
- Produces (consumed by Task 4):

```ts
export const triageSchema: z.ZodObject<...>; // exactly { wake, why, opening_prompt }
export type TriageDecision = { wake: boolean; why: string; opening_prompt: string };
export type TriageOutcome = TriageDecision & { model: string; cost_usd: number; latency_ms: number };
export type TriageRunner = (input: TriageInput) => Promise<TriageOutcome>;
export function makeTriageRunner(env: { ANTHROPIC_API_KEY: string; AI_GATEWAY_ANTHROPIC_URL?: string }): TriageRunner;
export function haikuCostUsd(usage: { inputTokens: number; outputTokens: number }): number;
```

- [ ] **Step 1: Install the AI SDK**

```bash
cd apps/worker && pnpm add ai @ai-sdk/anthropic zod
```

Then open `node_modules/ai/dist/index.d.ts` and confirm: the exact `generateObject` signature, and the usage field names on its result (current majors use `usage.inputTokens` / `usage.outputTokens`; older ones used `promptTokens` / `completionTokens`). Adjust the code below to the installed reality and record any drift in `phase-07-notes.md`.

- [ ] **Step 2: Write the failing tests**

`apps/worker/test/triage-run.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { triageSchema, haikuCostUsd } from "../src/triage/run";

describe("triage schema", () => {
  it("has exactly wake, why, opening_prompt — no type field can ever appear", () => {
    // THE guard against the banned pipeline. If someone adds `type` or
    // `category`, this fails before any downstream consumer can branch on it.
    expect(Object.keys(triageSchema.shape).sort()).toEqual(["opening_prompt", "wake", "why"]);
  });

  it("parses a valid decision and rejects a smuggled type field in strict mode", () => {
    const ok = triageSchema.safeParse({ wake: true, why: "question", opening_prompt: "..." });
    expect(ok.success).toBe(true);
    const smuggled = triageSchema.strict().safeParse({ wake: true, why: "q", opening_prompt: "p", type: "bug" });
    expect(smuggled.success).toBe(false);
  });
});

describe("haikuCostUsd", () => {
  it("prices at $1/MTok in, $5/MTok out", () => {
    expect(haikuCostUsd({ inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(1.0);
    expect(haikuCostUsd({ inputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(5.0);
    expect(haikuCostUsd({ inputTokens: 1000, outputTokens: 200 })).toBeCloseTo(0.002, 5);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/worker && pnpm vitest run test/triage-run.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`apps/worker/src/triage/run.ts`:

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { buildTriagePrompt, TRIAGE_SYSTEM, type TriageInput } from "./prompt";

/**
 * Exactly three fields. A type/category field here would smuggle the banned
 * per-ticket-type pipeline back in — the shape test in triage-run.test.ts
 * is the enforcement, this comment is the reason.
 */
export const triageSchema = z.object({
  wake: z.boolean(),
  why: z.string(),
  opening_prompt: z.string(),
});

export type TriageDecision = z.infer<typeof triageSchema>;
export type TriageOutcome = TriageDecision & { model: string; cost_usd: number; latency_ms: number };
export type TriageRunner = (input: TriageInput) => Promise<TriageOutcome>;

export const TRIAGE_MODEL = "claude-haiku-4-5";

/** Haiku 4.5 list price: $1/MTok input, $5/MTok output (verified 2026-08-11). */
export function haikuCostUsd(usage: { inputTokens: number; outputTokens: number }): number {
  return (usage.inputTokens * 1 + usage.outputTokens * 5) / 1_000_000;
}

export function makeTriageRunner(env: {
  ANTHROPIC_API_KEY: string;
  AI_GATEWAY_ANTHROPIC_URL?: string;
}): TriageRunner {
  const anthropic = createAnthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    // When the AI Gateway URL is set (Phase 10 formalizes it), requests route
    // through it for cost observability; unset falls straight to Anthropic.
    ...(env.AI_GATEWAY_ANTHROPIC_URL ? { baseURL: env.AI_GATEWAY_ANTHROPIC_URL } : {}),
  });

  return async (input) => {
    const started = Date.now();
    const { object, usage } = await generateObject({
      model: anthropic(TRIAGE_MODEL),
      schema: triageSchema,
      system: TRIAGE_SYSTEM,
      prompt: buildTriagePrompt(input),
    });
    return {
      ...object,
      model: TRIAGE_MODEL,
      cost_usd: haikuCostUsd({
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      }),
      latency_ms: Date.now() - started,
    };
  };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/worker && pnpm vitest run test/triage-run.test.ts && pnpm tsc --noEmit`
Expected: PASS (3 tests), clean typecheck. If `usage` field names fail the typecheck, fix per the installed `.d.ts` (Step 1) and note the drift.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/triage/run.ts apps/worker/test/triage-run.test.ts apps/worker/package.json pnpm-lock.yaml
git commit -m "feat(triage): haiku structured output with schema-shape guard and cost math"
```

---

### Task 4: Triage consumer

**Files:** Create `apps/worker/src/triage/consumer.ts`, `apps/worker/test/triage-consumer.test.ts` · Modify `apps/worker/src/ingest/consumer.ts`, `apps/worker/src/index.ts`, `apps/worker/wrangler.jsonc`, `apps/worker/.dev.vars.example`

**Interfaces:**
- Consumes: `TriageRunner` (Task 3), `MemoryStore` + `graphIdFor` (Phase 06), `getChannelPolicy`/`shouldTriage` (Phase 03)
- Produces: `handleTriageBatch(batch: MessageBatch<TriageJob>, env: Env, deps: TriageDeps): Promise<void>` with `type TriageJob = { event_id: string }` and `type TriageDeps = { triage: TriageRunner; memory: MemoryStore; hasLiveRun?: (channelId: string, threadTs: string) => Promise<boolean> }`. `hasLiveRun` defaults to `async () => false`; **Phase 08 replaces the default** with a real lookup against the `runs` table — this is the documented seam for skip-when-a-run-owns-the-thread.

- [ ] **Step 1: Write the failing tests**

`apps/worker/test/triage-consumer.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleTriageBatch, type TriageJob } from "../src/triage/consumer";
import type { TriageInput } from "../src/triage/prompt";
import type { TriageOutcome } from "../src/triage/run";
import { FakeMemoryStore } from "./helpers/fake-memory";

function batchOf(eventIds: string[]) {
  const acked: string[] = [];
  const retried: string[] = [];
  const batch = {
    queue: "firefighter-triage",
    messages: eventIds.map((event_id) => ({
      body: { event_id } as TriageJob,
      ack: () => acked.push(event_id),
      retry: () => retried.push(event_id),
    })),
  } as unknown as MessageBatch<TriageJob>;
  return { batch, acked, retried };
}

const wakeOutcome: TriageOutcome = {
  wake: true,
  why: "direct question",
  opening_prompt: "Customer asks about language variants.",
  model: "claude-haiku-4-5",
  cost_usd: 0.0003,
  latency_ms: 400,
};

async function seedMessage(eventId: string, opts: { thread_ts?: string; ts?: string; text?: string } = {}) {
  await env.DB.prepare(
    `INSERT INTO messages (event_id, channel_id, ts, thread_ts, user_id, text, subtype, permalink, customer_slug, received_at)
     VALUES (?, 'C1', ?, ?, 'U1', ?, NULL, NULL, 'pulsefit', 1)`,
  ).bind(eventId, opts.ts ?? "9.9", opts.thread_ts ?? null, opts.text ?? "how do I do X?").run();
}

describe("handleTriageBatch", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES ('C1', 'ext-pulsefit', 'pulsefit', 'live')",
    ).run();
  });

  it("stores a decision with prompt inputs from thread and recall", async () => {
    await seedMessage("Root", { ts: "1.0", text: "earlier in thread" });
    await seedMessage("Ev1", { ts: "2.0", thread_ts: "1.0" });
    const memory = new FakeMemoryStore();
    memory.searchResults = [{ factId: "f1", fact: "known issue", episodeUuids: [] }];
    const seen: TriageInput[] = [];
    const triage = async (input: TriageInput) => (seen.push(input), wakeOutcome);
    const { batch, acked } = batchOf(["Ev1"]);

    await handleTriageBatch(batch, env, { triage, memory });

    expect(seen).toHaveLength(1);
    expect(seen[0].thread.map((m) => m.text)).toEqual(["earlier in thread"]);
    expect(seen[0].recall[0].fact).toBe("known issue");
    const row = await env.DB.prepare("SELECT wake, why, cost_usd FROM triage_decisions WHERE event_id = 'Ev1'").first();
    expect(row).toMatchObject({ wake: 1, why: "direct question", cost_usd: 0.0003 });
    expect(acked).toEqual(["Ev1"]);
  });

  it("is idempotent: a redelivered event does not call the model again", async () => {
    await seedMessage("Ev1");
    let calls = 0;
    const triage = async () => (calls++, wakeOutcome);
    const memory = new FakeMemoryStore();
    await handleTriageBatch(batchOf(["Ev1"]).batch, env, { triage, memory });
    await handleTriageBatch(batchOf(["Ev1"]).batch, env, { triage, memory });
    expect(calls).toBe(1);
  });

  it("skips triage entirely when a live run owns the thread", async () => {
    await seedMessage("Ev1", { thread_ts: "1.0" });
    let calls = 0;
    const triage = async () => (calls++, wakeOutcome);
    const { batch, acked } = batchOf(["Ev1"]);

    await handleTriageBatch(batch, env, {
      triage,
      memory: new FakeMemoryStore(),
      hasLiveRun: async () => true,
    });

    expect(calls).toBe(0);
    expect(acked).toEqual(["Ev1"]);
    const row = await env.DB.prepare("SELECT 1 FROM triage_decisions WHERE event_id = 'Ev1'").first();
    expect(row).toBeNull();
  });

  it("still triages when Zep recall fails — recall is best-effort", async () => {
    await seedMessage("Ev1");
    const memory = new FakeMemoryStore();
    memory.search = async () => { throw new Error("zep down"); };
    const seen: TriageInput[] = [];
    const triage = async (input: TriageInput) => (seen.push(input), wakeOutcome);

    await handleTriageBatch(batchOf(["Ev1"]).batch, env, { triage, memory });

    expect(seen[0].recall).toEqual([]);
  });

  it("retries on model failure without failing the batch", async () => {
    await seedMessage("Ev1");
    await seedMessage("Ev2", { ts: "3.0" });
    let first = true;
    const triage = async () => {
      if (first) { first = false; throw new Error("model down"); }
      return wakeOutcome;
    };
    const { batch, acked, retried } = batchOf(["Ev1", "Ev2"]);

    await handleTriageBatch(batch, env, { triage, memory: new FakeMemoryStore() });

    expect(retried).toEqual(["Ev1"]);
    expect(acked).toEqual(["Ev2"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/worker && pnpm vitest run test/triage-consumer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the consumer**

`apps/worker/src/triage/consumer.ts`:

```ts
import type { Env } from "../index";
import type { MemoryStore } from "../memory/store";
import type { TriageInput } from "./prompt";
import type { TriageRunner } from "./run";
import { getChannelPolicy, shouldTriage } from "../db/channels";
import { graphIdFor } from "../memory/graphs";

export type TriageJob = { event_id: string };

export type TriageDeps = {
  triage: TriageRunner;
  memory: MemoryStore;
  /**
   * Whether a live run already owns this thread — in that case the message
   * becomes a turn, not a triage subject. Defaults to false until Phase 08
   * wires the runs table in. Spec §4.3.
   */
  hasLiveRun?: (channelId: string, threadTs: string) => Promise<boolean>;
};

type MessageRow = {
  event_id: string;
  channel_id: string;
  ts: string;
  thread_ts: string | null;
  user_id: string | null;
  text: string;
  permalink: string | null;
};

export async function handleTriageBatch(
  batch: MessageBatch<TriageJob>,
  env: Env,
  deps: TriageDeps,
): Promise<void> {
  const hasLiveRun = deps.hasLiveRun ?? (async () => false);
  for (const message of batch.messages) {
    try {
      await triageOne(message.body.event_id, env, deps, hasLiveRun);
      message.ack();
    } catch {
      message.retry();
    }
  }
}

async function triageOne(
  eventId: string,
  env: Env,
  deps: TriageDeps,
  hasLiveRun: NonNullable<TriageDeps["hasLiveRun"]>,
): Promise<void> {
  const decided = await env.DB.prepare("SELECT 1 FROM triage_decisions WHERE event_id = ?")
    .bind(eventId)
    .first();
  if (decided) return;

  const row = await env.DB.prepare(
    "SELECT event_id, channel_id, ts, thread_ts, user_id, text, permalink FROM messages WHERE event_id = ?",
  )
    .bind(eventId)
    .first<MessageRow>();
  if (!row) return;

  // Belt and suspenders: the producer already filters on shouldTriage, but a
  // policy change between enqueue and consume must fail closed.
  const policy = await getChannelPolicy(env.DB, row.channel_id);
  if (!shouldTriage(policy) || policy.customer_slug === null) return;

  const threadTs = row.thread_ts ?? row.ts;
  if (await hasLiveRun(row.channel_id, threadTs)) return;

  const { results: threadRows } = await env.DB.prepare(
    `SELECT user_id, text FROM messages
     WHERE channel_id = ? AND (thread_ts = ? OR ts = ?) AND event_id != ?
     ORDER BY ts ASC LIMIT 30`,
  )
    .bind(row.channel_id, threadTs, threadTs, eventId)
    .all<{ user_id: string | null; text: string }>();

  // Recall is best-effort: triage must keep working when Zep is down.
  let recall: TriageInput["recall"] = [];
  const graphId = graphIdFor(policy);
  if (graphId) {
    try {
      recall = await deps.memory.search(graphId, row.text, 5);
    } catch {}
  }

  const input: TriageInput = {
    channelName: policy.name,
    customerSlug: policy.customer_slug,
    message: { user_id: row.user_id, text: row.text, permalink: row.permalink },
    thread: threadRows,
    recall,
  };

  const outcome = await deps.triage(input);

  await env.DB.prepare(
    `INSERT OR IGNORE INTO triage_decisions
       (event_id, wake, why, opening_prompt, model, cost_usd, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      eventId,
      outcome.wake ? 1 : 0,
      outcome.why,
      outcome.opening_prompt,
      outcome.model,
      outcome.cost_usd,
      outcome.latency_ms,
      Date.now(),
    )
    .run();
  // Phase 08 adds here: if outcome.wake, wake the thread's RunDO with opening_prompt.
}
```

- [ ] **Step 4: Wire producer, routing, config**

`apps/worker/src/ingest/consumer.ts` — import `shouldTriage` from `../db/channels`, and next to the `MEMORY_QUEUE` send add:

```ts
    if (shouldTriage(policy)) {
      try {
        await env.TRIAGE_QUEUE.send({ event_id });
      } catch {}
    }
```

`apps/worker/src/index.ts` — extend `Env` and the switch:

```ts
import { handleTriageBatch, type TriageJob } from "./triage/consumer";
import { makeTriageRunner } from "./triage/run";
// Env additions:
//   TRIAGE_QUEUE: Queue<TriageJob>;
//   ANTHROPIC_API_KEY: string;
//   AI_GATEWAY_ANTHROPIC_URL?: string;

      case "firefighter-triage":
        return handleTriageBatch(batch as MessageBatch<TriageJob>, env, {
          triage: makeTriageRunner(env),
          memory: new ZepMemory(env.ZEP_API_KEY),
        });
```

and widen the handler type to `ExportedHandler<Env, QueuedEvent | MemoryJob | TriageJob>`.

`apps/worker/wrangler.jsonc` — producers:

```jsonc
{ "binding": "TRIAGE_QUEUE", "queue": "firefighter-triage" }
```

consumers:

```jsonc
{
  "queue": "firefighter-triage",
  "max_batch_size": 5,
  "max_batch_timeout": 3,
  "max_retries": 3,
  "dead_letter_queue": "firefighter-triage-dlq"
}
```

`apps/worker/.dev.vars.example` — append:

```
# Anthropic API key. Phase 07 uses Haiku 4.5 for triage (~$0.0003/message);
# Phase 10 adds Fable 5 for the main agent on the same key.
ANTHROPIC_API_KEY=
```

Mirror any explicit vitest miniflare queue bindings as in Phase 06 Task 4.

- [ ] **Step 5: Run, create queues**

Run: `cd apps/worker && pnpm vitest run && pnpm tsc --noEmit`
Expected: green.

```bash
pnpm wrangler queues create firefighter-triage
pnpm wrangler queues create firefighter-triage-dlq
```

- [ ] **Step 6: Commit**

```bash
git add -A apps/worker
git commit -m "feat(triage): consumer with live-run seam, best-effort recall, stored decisions"
```

---

### Task 5: Real `triaged` counter

**Files:** Modify `apps/worker/src/db/counters.ts`, `apps/worker/test/counters.test.ts`

**Interfaces:**
- Consumes: `triage_decisions` (Task 1)
- Produces: `getCounters` unchanged in signature; `triaged` becomes `COUNT(*) FROM triage_decisions WHERE created_at >= sinceMs`. The `/api/counters` contract (Phase 05) is unchanged.

- [ ] **Step 1: Write the failing test** (append to `apps/worker/test/counters.test.ts`, matching its existing style)

```ts
it("counts triage decisions within the window", async () => {
  await env.DB.prepare(
    `INSERT INTO triage_decisions (event_id, wake, why, opening_prompt, model, cost_usd, latency_ms, created_at)
     VALUES ('EvT1', 1, 'q', 'p', 'claude-haiku-4-5', 0.0003, 400, 5000),
            ('EvT2', 0, 'banter', '', 'claude-haiku-4-5', 0.0002, 300, 1000)`,
  ).run();
  const counters = await getCounters(env.DB, 2000);
  expect(counters.triaged).toBe(1); // only EvT1 is inside the window
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/worker && pnpm vitest run test/counters.test.ts`
Expected: FAIL — `triaged` is 0.

- [ ] **Step 3: Implement** — in `apps/worker/src/db/counters.ts`, replace the hardcoded `triaged: 0` (and its "Populated in Phase 07" doc comment) with a second query:

```ts
  const triagedRow = await db
    .prepare("SELECT COUNT(*) AS triaged FROM triage_decisions WHERE created_at >= ?")
    .bind(sinceMs)
    .first<{ triaged: number }>();
```

and return `triaged: triagedRow?.triaged ?? 0`.

- [ ] **Step 4: Run the full suite**

Run: `cd apps/worker && pnpm vitest run && pnpm tsc --noEmit`
Expected: green.

- [ ] **Step 5: Deploy and verify exit criteria live**

```bash
cd apps/worker && pnpm wrangler secret put ANTHROPIC_API_KEY && pnpm wrangler deploy
```

Then, in a test customer channel: post banter ("lol nice") and a question ("how do I export my funnel data?"). Verify with
`pnpm wrangler d1 execute firefighter --remote --command "SELECT event_id, wake, why, cost_usd FROM triage_decisions ORDER BY created_at DESC LIMIT 5"`
that banter got `wake=0`, the question got `wake=1` with a sensible `opening_prompt`, and every row carries a nonzero `cost_usd`. Confirm `/api/counters` now reports a live `triaged`.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/db/counters.ts apps/worker/test/counters.test.ts
git commit -m "feat(counters): real triaged count from stored decisions"
```

---

## Exit criteria

- Banter in a test channel does not produce `wake=1`; a question does — verified live.
- Every decision is stored with model, cost, and latency; the $500 ceiling is now observable per message.
- Internal and unknown channels never reach the model (producer filter + consumer fail-closed re-check, both tested).
- The schema-shape test proves no ticket type can be emitted.
- Reference (`observe`) customer channels accumulate decisions for the Phase 21 eval set.
- `hasLiveRun` seam exists and is tested, ready for Phase 08 to replace.
