# Phase 04 — Ingest Pipeline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Every message the webhook hears lands in D1 exactly once, with DMs and noise dropped at the door and a real Slack permalink attached.

**Depends on:** Phases 02, 03 · **Day 2** · **Gates:** Phases 05, 06, 07

**Docs MCP:** Slack Web API — `chat.getPermalink` and the message subtype list (Task 1's `DROPPED_SUBTYPES` set is the part most likely to be incomplete). See `00-roadmap.md` → *Docs / API MCP servers*.

**Global constraints** from `00-roadmap.md` apply. Two bear directly on this phase: **channels only, never DMs**, and **all ingest writes are idempotent on `event_id`** because Slack retries up to three times.

---

## File Structure

```
apps/worker/src/ingest/rules.ts       drop rules — pure, no I/O
apps/worker/src/db/messages.ts        events_seen + messages writes
apps/worker/src/ingest/consumer.ts    queue batch handler
apps/worker/src/slack/client.ts       minimal Slack Web API client (bot token)
apps/worker/src/index.ts              modify: wire the queue handler
apps/worker/test/rules.test.ts
apps/worker/test/ingest.test.ts
apps/worker/test/permalink.test.ts
```

Rules are split from the consumer so the entire drop policy is testable without a database or a network.

---

### Task 1: Drop rules

**Files:** Create `apps/worker/src/ingest/rules.ts`, `apps/worker/test/rules.test.ts`

**Interfaces:**
- Consumes: `SlackMessageEvent` (Phase 02 Task 2)
- Produces: `IngestOutcome`, `classify(event, channelKnown)` — consumed by Task 3 and Phase 05

- [ ] **Step 1: Write the failing tests**

`apps/worker/test/rules.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classify } from "../src/ingest/rules";
import type { SlackMessageEvent } from "../src/slack/types";

const base: SlackMessageEvent = {
  type: "message",
  channel: "C1",
  channel_type: "channel",
  user: "U1",
  text: "hello",
  ts: "1.1",
};

describe("classify", () => {
  it("ingests an ordinary channel message", () => {
    expect(classify(base, true)).toBe("ingested");
  });

  it("drops direct messages", () => {
    expect(classify({ ...base, channel_type: "im" }, true)).toBe("dropped_dm");
    expect(classify({ ...base, channel_type: "mpim" }, true)).toBe("dropped_dm");
  });

  it("drops messages from bots", () => {
    expect(classify({ ...base, bot_id: "B1" }, true)).toBe("dropped_bot");
    expect(classify({ ...base, subtype: "bot_message" }, true)).toBe("dropped_bot");
  });

  it("drops join and leave noise", () => {
    expect(classify({ ...base, subtype: "channel_join" }, true)).toBe("dropped_subtype");
    expect(classify({ ...base, subtype: "channel_leave" }, true)).toBe("dropped_subtype");
  });

  it("drops edits and deletions", () => {
    expect(classify({ ...base, subtype: "message_changed" }, true)).toBe("dropped_subtype");
    expect(classify({ ...base, subtype: "message_deleted" }, true)).toBe("dropped_subtype");
  });

  it("drops unknown channels even when everything else is fine", () => {
    expect(classify(base, false)).toBe("dropped_unknown_channel");
  });

  it("checks DM before channel membership, so a DM in an unknown channel is dropped as a DM", () => {
    expect(classify({ ...base, channel_type: "im" }, false)).toBe("dropped_dm");
  });

  it("ingests a thread reply", () => {
    expect(classify({ ...base, thread_ts: "1.0" }, true)).toBe("ingested");
  });

  it("ingests a message with empty text rather than dropping it", () => {
    expect(classify({ ...base, text: "" }, true)).toBe("ingested");
  });
});
```

The DM-before-membership ordering is not incidental. It means the DM guard cannot be bypassed by a channel simply being unmapped, and it makes the counter attribution honest.

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/worker && pnpm vitest run test/rules.test.ts
```

Expected: FAIL — cannot resolve `../src/ingest/rules`.

- [ ] **Step 3: Implement**

`apps/worker/src/ingest/rules.ts`:

```ts
import type { SlackMessageEvent } from "../slack/types";

export type IngestOutcome =
  | "ingested"
  | "dropped_dm"
  | "dropped_bot"
  | "dropped_subtype"
  | "dropped_unknown_channel";

const DROPPED_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "message_changed",
  "message_deleted",
  "thread_broadcast_deleted",
]);

/**
 * Decide what happens to one message event. Pure: no I/O, so the whole drop
 * policy is testable in isolation.
 *
 * The DM check comes first and is unconditional. The installed app holds
 * im:history and im:read, so Slack really does deliver DM events here — this
 * line is the only thing keeping them out of D1. See spec §4.1.
 */
export function classify(event: SlackMessageEvent, channelKnown: boolean): IngestOutcome {
  if (event.channel_type === "im" || event.channel_type === "mpim") return "dropped_dm";
  if (event.bot_id || event.subtype === "bot_message") return "dropped_bot";
  if (event.subtype && DROPPED_SUBTYPES.has(event.subtype)) return "dropped_subtype";
  if (!channelKnown) return "dropped_unknown_channel";
  return "ingested";
}
```

- [ ] **Step 4: Run to verify pass**

```bash
cd apps/worker && pnpm vitest run test/rules.test.ts
```

Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/ingest/rules.ts apps/worker/test/rules.test.ts
git commit -m "feat(ingest): pure drop rules with unconditional dm guard"
```

---

### Task 2: Idempotent D1 writes

**Files:** Create `apps/worker/src/db/messages.ts`

**Interfaces:**
- Consumes: `IngestOutcome` (Task 1)
- Produces: `recordEvent(db, row): Promise<boolean>`, `insertMessage(db, row): Promise<void>`

- [ ] **Step 1: Implement**

`apps/worker/src/db/messages.ts`:

```ts
import type { IngestOutcome } from "../ingest/rules";

/**
 * Record that an envelope was seen. Returns true on first sighting, false if
 * Slack already delivered it.
 *
 * `events_seen` is both the dedupe key and the source of the "heard" counter,
 * which is why it is written for dropped events too. See spec §9.
 */
export async function recordEvent(
  db: D1Database,
  row: { event_id: string; channel_id: string | null; outcome: IngestOutcome; received_at: number },
): Promise<boolean> {
  const res = await db
    .prepare(
      "INSERT OR IGNORE INTO events_seen (event_id, channel_id, outcome, received_at) VALUES (?, ?, ?, ?)",
    )
    .bind(row.event_id, row.channel_id, row.outcome, row.received_at)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function insertMessage(
  db: D1Database,
  row: {
    event_id: string;
    channel_id: string;
    ts: string;
    thread_ts: string | null;
    user_id: string | null;
    text: string;
    subtype: string | null;
    permalink: string | null;
    customer_slug: string | null;
    received_at: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO messages
        (event_id, channel_id, ts, thread_ts, user_id, text, subtype, permalink, customer_slug, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.event_id,
      row.channel_id,
      row.ts,
      row.thread_ts,
      row.user_id,
      row.text,
      row.subtype,
      row.permalink,
      row.customer_slug,
      row.received_at,
    )
    .run();
}
```

`INSERT OR IGNORE` plus the `changes` count is what makes retry-safety a database property rather than an application-level check with a race in it.

- [ ] **Step 2: Commit**

```bash
git add apps/worker/src/db/messages.ts
git commit -m "feat(db): idempotent events_seen and messages writes"
```

---

### Task 3: The queue consumer

**Files:** Create `apps/worker/src/ingest/consumer.ts`, `apps/worker/test/ingest.test.ts`; modify `apps/worker/src/index.ts`

**Interfaces:**
- Consumes: `classify` (Task 1), `recordEvent`/`insertMessage` (Task 2), `getChannelPolicy` (Phase 03)
- Produces: `handleIngestBatch(batch, env)`

- [ ] **Step 1: Write the failing tests**

`apps/worker/test/ingest.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleIngestBatch } from "../src/ingest/consumer";
import type { QueuedEvent } from "../src/slack/types";

function batchOf(events: QueuedEvent[]) {
  return {
    queue: "firefighter-ingest",
    messages: events.map((body, i) => ({
      id: `m${i}`,
      timestamp: new Date(),
      body,
      attempts: 1,
      ack: () => {},
      retry: () => {},
    })),
    ackAll: () => {},
    retryAll: () => {},
  } as unknown as MessageBatch<QueuedEvent>;
}

function ev(overrides: Partial<QueuedEvent> = {}): QueuedEvent {
  return {
    event_id: "Ev1",
    received_at: 1_700_000_000_000,
    event: {
      type: "message",
      channel: "C_TEST",
      channel_type: "channel",
      user: "U1",
      text: "the checkout button is broken",
      ts: "1700000000.000100",
    },
    ...overrides,
  };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM events_seen"),
    env.DB.prepare("DELETE FROM channels"),
  ]);
  await env.DB.prepare("INSERT INTO channels VALUES (?, ?, ?, ?)")
    .bind("C_TEST", "test-firedrill", "firedrill", "live")
    .run();
});

describe("handleIngestBatch", () => {
  it("writes an events_seen row and a messages row", async () => {
    await handleIngestBatch(batchOf([ev()]), env);

    const seen = await env.DB.prepare("SELECT * FROM events_seen").first<{ outcome: string }>();
    expect(seen?.outcome).toBe("ingested");

    const msg = await env.DB.prepare("SELECT * FROM messages").first<{
      text: string;
      customer_slug: string;
      channel_id: string;
    }>();
    expect(msg?.text).toBe("the checkout button is broken");
    expect(msg?.customer_slug).toBe("firedrill");
    expect(msg?.channel_id).toBe("C_TEST");
  });

  it("is idempotent — a Slack retry writes exactly one row", async () => {
    await handleIngestBatch(batchOf([ev()]), env);
    await handleIngestBatch(batchOf([ev()]), env);

    const seen = await env.DB.prepare("SELECT COUNT(*) AS n FROM events_seen").first<{ n: number }>();
    const msgs = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    expect(seen?.n).toBe(1);
    expect(msgs?.n).toBe(1);
  });

  it("records a dropped DM in events_seen but not in messages", async () => {
    const dm = ev({ event_id: "Ev_dm" });
    dm.event.channel_type = "im";
    await handleIngestBatch(batchOf([dm]), env);

    const seen = await env.DB.prepare("SELECT outcome FROM events_seen WHERE event_id = ?")
      .bind("Ev_dm")
      .first<{ outcome: string }>();
    expect(seen?.outcome).toBe("dropped_dm");

    const msgs = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    expect(msgs?.n).toBe(0);
  });

  it("drops an unknown channel", async () => {
    const unknown = ev({ event_id: "Ev_unknown" });
    unknown.event.channel = "C_NOT_MAPPED";
    await handleIngestBatch(batchOf([unknown]), env);

    const seen = await env.DB.prepare("SELECT outcome FROM events_seen WHERE event_id = ?")
      .bind("Ev_unknown")
      .first<{ outcome: string }>();
    expect(seen?.outcome).toBe("dropped_unknown_channel");
  });

  it("stores thread_ts when present", async () => {
    const reply = ev({ event_id: "Ev_reply" });
    reply.event.thread_ts = "1700000000.000000";
    await handleIngestBatch(batchOf([reply]), env);

    const msg = await env.DB.prepare("SELECT thread_ts FROM messages WHERE event_id = ?")
      .bind("Ev_reply")
      .first<{ thread_ts: string }>();
    expect(msg?.thread_ts).toBe("1700000000.000000");
  });

  it("ingests reference-channel messages — observe blocks posting, not hearing", async () => {
    await env.DB.prepare("INSERT INTO channels VALUES (?, ?, ?, ?)")
      .bind("C_REF", "pulsefit-zellify", "pulsefit", "observe")
      .run();
    const refMsg = ev({ event_id: "Ev_ref" });
    refMsg.event.channel = "C_REF";
    await handleIngestBatch(batchOf([refMsg]), env);

    const msg = await env.DB.prepare("SELECT customer_slug FROM messages WHERE event_id = ?")
      .bind("Ev_ref")
      .first<{ customer_slug: string }>();
    expect(msg?.customer_slug).toBe("pulsefit");
  });

  it("processes a mixed batch without one bad event blocking the rest", async () => {
    const bad = ev({ event_id: "Ev_bad" });
    bad.event.channel_type = "im";
    await handleIngestBatch(batchOf([bad, ev({ event_id: "Ev_good" })]), env);

    const msgs = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    expect(msgs?.n).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/worker && pnpm vitest run test/ingest.test.ts
```

Expected: FAIL — cannot resolve `../src/ingest/consumer`.

- [ ] **Step 3: Implement**

`apps/worker/src/ingest/consumer.ts`:

```ts
import type { Env } from "../index";
import type { QueuedEvent } from "../slack/types";
import { getChannelPolicy } from "../db/channels";
import { insertMessage, recordEvent } from "../db/messages";
import { classify } from "./rules";

/**
 * The real work of ingest, off the request path. Everything here is idempotent
 * on `event_id` because Slack retries up to three times. See spec §4.2.
 *
 * Permalink resolution is deliberately absent — Task 4 adds it as a backfill.
 * The D1 write must never depend on a network call succeeding.
 */
export async function handleIngestBatch(batch: MessageBatch<QueuedEvent>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const { event_id, event, received_at } = message.body;

    const policy = await getChannelPolicy(env.DB, event.channel);
    const outcome = classify(event, policy.known);

    const isFirstSighting = await recordEvent(env.DB, {
      event_id,
      channel_id: event.channel ?? null,
      outcome,
      received_at,
    });

    if (!isFirstSighting) continue;
    if (outcome !== "ingested") continue;

    await insertMessage(env.DB, {
      event_id,
      channel_id: event.channel,
      ts: event.ts,
      thread_ts: event.thread_ts ?? null,
      user_id: event.user ?? null,
      text: event.text ?? "",
      subtype: event.subtype ?? null,
      permalink: null,
      customer_slug: policy.customer_slug,
      received_at,
    });
  }
}
```

- [ ] **Step 4: Wire the queue handler**

In `apps/worker/src/index.ts`, replace the stub `queue` method:

```ts
import { handleIngestBatch } from "./ingest/consumer";
import type { QueuedEvent } from "./slack/types";

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<QueuedEvent>, env: Env): Promise<void> {
    await handleIngestBatch(batch, env);
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 5: Run the full suite**

```bash
cd apps/worker && pnpm test
```

Expected: 41 passing (health 2, verify 7, events 5, channels 11, rules 9, ingest 7).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/ingest/consumer.ts apps/worker/src/index.ts apps/worker/test/ingest.test.ts
git commit -m "feat(ingest): idempotent queue consumer wired to the worker"
```

---

### Task 4: Permalink backfill

**Files:** Create `apps/worker/src/slack/client.ts`, `apps/worker/test/permalink.test.ts`; modify `apps/worker/src/ingest/consumer.ts`

**Interfaces:**
- Consumes: `insertMessage` (Task 2)
- Produces: `getPermalink(botToken, channel, ts): Promise<string | null>`

Citations must resolve to real Slack URLs, never to strings assembled at read time. This is what makes decision D4's citation story correct by construction rather than by the model behaving well.

- [ ] **Step 1: Write the failing tests**

`apps/worker/test/permalink.test.ts`:

```ts
import { fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getPermalink } from "../src/slack/client";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("getPermalink", () => {
  it("returns the permalink Slack gives us", async () => {
    fetchMock
      .get("https://slack.com")
      .intercept({ path: /^\/api\/chat\.getPermalink/, method: "GET" })
      .reply(200, { ok: true, permalink: "https://zellify.slack.com/archives/C1/p1700000000000100" });

    await expect(getPermalink("xoxb-test", "C1", "1700000000.000100")).resolves.toBe(
      "https://zellify.slack.com/archives/C1/p1700000000000100",
    );
  });

  it("returns null when Slack reports an error rather than throwing", async () => {
    fetchMock
      .get("https://slack.com")
      .intercept({ path: /^\/api\/chat\.getPermalink/, method: "GET" })
      .reply(200, { ok: false, error: "message_not_found" });

    await expect(getPermalink("xoxb-test", "C1", "1.1")).resolves.toBeNull();
  });

  it("returns null on a transport failure rather than throwing", async () => {
    fetchMock
      .get("https://slack.com")
      .intercept({ path: /^\/api\/chat\.getPermalink/, method: "GET" })
      .reply(500, "boom");

    await expect(getPermalink("xoxb-test", "C1", "1.1")).resolves.toBeNull();
  });
});
```

Returning `null` rather than throwing is the design: a missing permalink must never cost us the message, which is the system of record.

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/worker && pnpm vitest run test/permalink.test.ts
```

Expected: FAIL — cannot resolve `../src/slack/client`.

- [ ] **Step 3: Implement the client**

`apps/worker/src/slack/client.ts`:

```ts
/**
 * Resolve a message's canonical Slack permalink. Returns null on any failure —
 * a missing permalink must never cost us the message itself. Task 3 writes the
 * row first; this enriches it.
 */
export async function getPermalink(
  botToken: string,
  channel: string,
  ts: string,
): Promise<string | null> {
  const url = new URL("https://slack.com/api/chat.getPermalink");
  url.searchParams.set("channel", channel);
  url.searchParams.set("message_ts", ts);

  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${botToken}` } });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok: boolean; permalink?: string };
    return body.ok && body.permalink ? body.permalink : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Backfill from the consumer**

In `apps/worker/src/ingest/consumer.ts`, add the import:

```ts
import { getPermalink } from "../slack/client";
```

and append after the `insertMessage` call:

```ts
    const permalink = await getPermalink(env.SLACK_BOT_TOKEN, event.channel, event.ts);
    if (permalink) {
      await env.DB.prepare("UPDATE messages SET permalink = ? WHERE event_id = ?")
        .bind(permalink, event_id)
        .run();
    }
```

Insert first, enrich second. A Slack API outage costs permalinks, never messages.

- [ ] **Step 5: Run the full suite**

```bash
cd apps/worker && pnpm test
```

Expected: 44 passing. The Task 3 ingest tests still pass — `fetchMock` is not active in that file, and `getPermalink` swallows the resulting failure, which is precisely the behavior under test.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/slack/client.ts apps/worker/src/ingest/consumer.ts apps/worker/test/permalink.test.ts
git commit -m "feat(ingest): backfill slack permalinks for citation resolution"
```

---

## Exit criteria

- [ ] 44 tests passing
- [ ] Ingesting the same `event_id` twice writes exactly one row of each kind
- [ ] A DM is recorded in `events_seen` as `dropped_dm` and never reaches `messages`
- [ ] A reference-channel message ingests with its `customer_slug`
- [ ] A Slack API failure during permalink resolution loses no message
