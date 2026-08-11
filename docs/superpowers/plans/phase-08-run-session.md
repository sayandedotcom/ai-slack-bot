# Phase 08 — RunDO Session Core and Live Streaming

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the one thread-scoped run/session shape used by both Slack and
Chat, persist its turns and tool-call stream in RunDO SQLite, index it in D1,
and make it watchable and steerable through a hibernation-compatible WebSocket
without gaps or duplicate events.

**Depends on:** Phase 05 (D1/API/Access foundation) and Phase 07 (triage wake
decision) · **Day 3** · **Gates:** Phases 09, 10, 11, 15 and 17

**Architecture:** A run has a stable origin key —
`slack:{channel_id}:{thread_ts}` or `chat:{uuid}` — and that key is the only
input to `RUNS.idFromName()`. D1 stores a small run index for lists and
counters. The RunDO's private SQLite database stores the live session. Every
turn, tool update and status change becomes a committed append-only event with
a monotonic `seq` before it is broadcast. A WebSocket reconnect sends events
after the client's last `seq`, then continues with live events. No correctness
state exists only in memory, so constructor re-entry after hibernation is safe.

**This phase does not run the model.** Phase 09 supplies Code Mode and Phase 10
supplies the model loop. Phase 08 owns only durable session semantics, routing,
streaming and steering.

**Global constraints** from `00-roadmap.md` apply. The most important ones for
this phase are: one generic session shape; no ticket type; channels only; D1 as
the index/system of record; secrets never enter model-authored code; and every
task ends with a commit.

---

## Docs and API verification gate

Durable Objects changed recently enough that memory is not authoritative. Read
the installed generated types and the current official docs before Task 1.

Authoritative local surface:

```bash
cd apps/worker
rg -n "acceptWebSocket|getWebSockets|webSocketMessage|SqlStorage|idFromName" \
  worker-configuration.d.ts
rg -n '"exports"|new_sqlite_classes|durable_objects' \
  node_modules/wrangler/config-schema.json
```

Official docs to verify:

- Durable Objects WebSocket hibernation:
  <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>
- Hibernation server example:
  <https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/>
- SQLite-backed storage:
  <https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/>
- Durable Object testing and eviction:
  <https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/>
- Durable Object class lifecycle configuration:
  <https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/>

Pin these facts in `phase-08-notes.md` before implementation:

1. Hibernating sockets are accepted with `ctx.acceptWebSocket(server)`, not
   `server.accept()`.
2. Hibernating events arrive through class handlers
   `webSocketMessage`, `webSocketClose` and `webSocketError`; do not attach
   ordinary `message` listeners to the server socket.
3. `ctx.getWebSockets()` recovers the attached sockets after constructor
   re-entry. Per-socket cursors, if used, belong in
   `serializeAttachment()`/`deserializeAttachment()`.
4. Run storage uses synchronous `ctx.storage.sql`; a new class must be
   SQLite-backed.
5. `evictDurableObject()` is the test for constructor re-entry and persisted
   state. A passing restart-by-process test is not a substitute. Its second
   argument is `{ webSockets: "close" | "hibernate" }` and it already defaults
   to `"hibernate"`.
6. `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping",
   "pong"))` is the auto-response call. `WebSocketRequestResponsePair` is the
   payload type, not the method.
7. Whether DO SQLite accepts `AUTOINCREMENT` is **unverified and unnecessary**.
   `AUTOINCREMENT` needs SQLite's internal `sqlite_sequence` table and DO
   SQLite restricts internal tables. This phase never deletes from
   `stream_events`, so a plain `INTEGER PRIMARY KEY` rowid alias is already
   monotonic. Prove it in Task 0 rather than discovering it in Task 3.

### Wrangler lifecycle choice

Wrangler 4.120 supports both the legacy `migrations` array and the newer
declarative `exports` map. Use the legacy form for this trial:

```jsonc
"durable_objects": {
  "bindings": [{ "name": "RUNS", "class_name": "RunDO" }]
},
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["RunDO"] }
]
```

Reason: both are supported, but the official Vitest recipe and the existing
roadmap use `new_sqlite_classes`; it is the lower-risk choice on a seven-day
clock. Do not use `new_classes`, which creates the wrong storage backend. If
the deployed Worker already has a Durable Object migration history by the time
this task starts, append a new unique tag instead of rewriting history.

Record this choice because current docs call `exports` the replacement. It is
exactly the sort of thin-training-data override the README's AI-tool notes are
supposed to disclose.

---

## Load-bearing invariants

1. **One origin key, one RunDO.** Slack is keyed by thread, never by individual
   message. Chat is keyed by a server-created UUID. Both resolve through one
   `runStubForKey()` helper and the same `RunDO` class.
2. **One inbox.** `appendTurn()` is the only session mutation that injects
   conversational input. Triage openings, later customer messages, dashboard
   steering and Phase 11 approval outcomes all call it.
3. **Source is not type.** A turn may record where it came from
   (`triage`, `customer`, `human_steer`, `approval`, `agent`, `system`) so the
   model can understand the conversation. There is still no bug/feature/question
   classification and nothing branches on those concepts.
4. **Commit before broadcast, and broadcast before the next `await`.** A socket
   may only see an event already durable in RunDO SQLite — and the broadcast
   must run in the same synchronous continuation as the `transactionSync()` that
   committed it, before any `await`. Durability alone is not enough: the D1
   index write is an `await`, the DO input gate allows another event to run
   during it, and broadcasting after it lets two concurrent appends deliver out
   of order. See the ordering hazard in the race table.
5. **Every event has a cursor.** `seq` is monotonically increasing within one
   run. Clients deduplicate by `seq` and reconnect with `?since=<last_seq>`.
   `seq` comes from a plain `INTEGER PRIMARY KEY` rowid alias — nothing deletes
   from `stream_events`, so it is monotonic without `AUTOINCREMENT`.
6. **D1 is an index, not a session mirror.** D1 stores run identity, status and
   summary. It does not duplicate turns or tool deltas.
7. **All writes are idempotent.** Turn/update IDs are caller-stable. Queue retry
   and browser retry must not create a second event.
8. **Hibernation is normal.** No `Map` of clients, cached turn list, timer,
   interval or pending promise is required for correctness.
9. **The route is protected at the origin.** `/ws/run/:id` remains behind the
   same Cloudflare Access app as the dashboard. Only `/slack/events` and the
   OAuth callbacks are bypassed.
10. **A public run ID is not a DO ID.** Dashboard URLs use `runs.id` (UUID).
    The Worker loads `runs.key` from D1, then calls `idFromName(key)`. This keeps
    routing details server-side and makes changing the key format survivable.

---

## Race and recovery model

| Failure/race | Required behavior |
|---|---|
| Same Slack event delivered twice | Stable turn ID returns the existing event; no second row or broadcast. |
| Triage decision commits, RunDO wake fails | Queue retries; the stored decision is replayed to the run without calling Haiku again. |
| Turn commits, D1 `updated_at` write fails | Retry finds the turn, repairs/touches D1, and broadcasts by the same `seq`; socket cursor suppression prevents a duplicate. |
| Two `appendTurn()` calls overlap | Both broadcast synchronously at commit, so delivery order equals `seq` order. Broadcasting after the awaited D1 touch would let `seq 5` land first, set the socket cursor to 5, and make the `lastSeq >= seq` skip rule drop `seq 4` permanently — the client's own reconnect would then ask for `since=5`. |
| Client connects while a turn arrives | DO input serialization plus a synchronous sync snapshot gives either backlog or live delivery, never neither. |
| Client reconnects | `since` is clamped to the current cursor; only larger `seq` values are sent. |
| RunDO is evicted with sockets attached | SQLite and socket attachments survive; the next message reconstructs the instance and continues. |
| Customer posts during `awaiting_approval` | The new customer turn enters the same inbox and the run becomes `live`; Phase 11 may withdraw/redraft the stale approval. |
| Completed thread receives a new actionable message | Triage runs again, the same thread-scoped RunDO is reopened from `done`/`failed` to `live`, and history remains continuous. |

---

## Test isolation — read before writing any RunDO test

`@cloudflare/vitest-pool-workers` 0.21 has **no `isolatedStorage`**. It was
removed along with `singleWorker` when the pool moved to the `cloudflareTest`
plugin. Storage is shared across every test *and every test file* in the run —
`test/triage-consumer.test.ts` already carries a comment saying exactly that
about D1.

Durable Object SQLite behaves the same way. A DO reached by the same name in
two different test files is the same object with the same rows and the same
`seq` counter.

`reset()` from `cloudflare:test` is **not** the escape hatch here. It deletes
data from every attached binding, including the D1 whose migrations
`test/setup.ts` applies once at module load. Calling it would break every other
suite.

The rule for this phase:

> **Every DO test derives its own run key.** Use
> `chat:${crypto.randomUUID()}` (or a per-test Slack thread ts) and never a
> literal shared key.

Consequences that would otherwise produce flaky-looking failures:

- never assert an absolute `seq` value such as `1`, `2`, `3` — capture the
  cursor the DO reports and assert *relative* progression;
- never assert that `since=0` returns an empty backlog unless the run key was
  minted in that test;
- an "initialization is idempotent" test and a "rejects a different descriptor"
  test must not share a key, or the second one passes for the wrong reason.

---

## File structure

```text
apps/worker/migrations/0004_runs.sql       D1 run index (0003 is triage)
apps/worker/src/run/protocol.ts            statuses, turns, stream protocol
apps/worker/src/run/keys.ts                origin keys + one idFromName helper
apps/worker/src/run/repository.ts          D1-only run index operations
apps/worker/src/run/session.ts             RunDO SQLite schema and mutations
apps/worker/src/run/do.ts                  RunDO RPC + hibernating WebSockets
apps/worker/src/run/coordinator.ts         create/wake/route orchestration
apps/worker/src/api/runs.ts                list/create/read/steer HTTP API
apps/worker/src/triage/consumer.ts         route existing run + replay wake
apps/worker/src/index.ts                   routes, binding type, RunDO export
apps/worker/wrangler.jsonc                 RUNS binding + SQLite class migration
apps/worker/worker-configuration.d.ts      regenerate; never hand-edit
apps/worker/test/run-protocol.test.ts
apps/worker/test/run-repository.test.ts
apps/worker/test/run-session.test.ts
apps/worker/test/run-triage.test.ts
apps/worker/test/run-ws.test.ts
docs/superpowers/plans/phase-08-notes.md   verified APIs and model mistakes
```

The roadmap's old placeholder says `0003_runs.sql`; that name is stale because
Phase 07 already shipped `0003_triage.sql`. Phase 08 must use
`0004_runs.sql`.

---

## Public contracts established by this phase

### Run identity

```ts
export type RunOrigin = "slack" | "chat";

export function slackRunKey(channelId: string, threadTs: string): string;
export function chatRunKey(chatId: string): string;

export function runStubForKey(
  namespace: DurableObjectNamespace<RunDO>,
  key: string,
): DurableObjectStub<RunDO>;
```

`slackRunKey("C123", "1720000000.123456")` returns
`slack:C123:1720000000.123456`. `chatRunKey(uuid)` returns `chat:{uuid}`.
Only `runStubForKey()` calls `idFromName()`.

**The chat key's UUID is not `runs.id`.** `POST /api/runs` mints two independent
`crypto.randomUUID()` values: one becomes the public `runs.id` in dashboard
URLs, the other becomes the private `chat:{uuid}` origin key. Reusing one UUID
for both would make the public ID trivially convertible to the `idFromName()`
input and quietly void invariant 10 for every Chat run.

### Statuses and transitions

```ts
export const RUN_STATUSES = [
  "live",
  "awaiting_approval",
  "idle",
  "done",
  "failed",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
```

Allowed state changes:

```text
live              -> awaiting_approval | idle | done | failed
awaiting_approval -> live | idle | done | failed
idle              -> live | done | failed
done              -> live
failed            -> live
same              -> same (idempotent, emits no event)
```

Reopening `done` and `failed` is deliberate: the Slack thread owns one durable
session for its lifetime. A new actionable message should regain that context,
not create a second DO with a fake message-scoped suffix.

**`idle` counts as owning the thread, and that is a product decision, not an
accident.** `ACTIVE_RUN_STATUSES` is `["live", "awaiting_approval", "idle"]`,
and `findOwnedSlackRun()` matches it — so once a run reaches `idle`, every
later message in that thread routes to the agent and triage never sees it
again, banter included. The alternative (letting `idle` fall back to triage)
would re-run Haiku on follow-ups inside a conversation the agent is already
holding, and would risk two entry paths for one thread. Accepted deliberately:
a thread the agent has answered once is a thread it stays on. Only `done` and
`failed` release it back to triage.

### Turns

```ts
export type TurnRole = "system" | "user" | "assistant";
export type TurnSource =
  | "triage"
  | "customer"
  | "human_steer"
  | "approval"
  | "agent"
  | "system";

export type RunTurnInput = {
  id: string;             // caller-stable idempotency key
  role: TurnRole;
  source: TurnSource;
  content: string;
  metadata?: JsonObject;  // Slack event/permalink, approval id, etc.
  createdAt?: number;
};
```

Stable IDs by path:

```text
triage opening       triage:{event_id}
later Slack message slack:{event_id}
dashboard steer     steer:{request_id}
approval outcome    approval:{approval_id}:{decision_version}   (Phase 11)
agent turn          agent:{provider_message_id}                  (Phase 10)
tool update         tool:{call_id}:{provider_sequence}           (Phase 10)
```

The opening prompt already contains the triggering customer message, thread and
memory. Do not also append that same raw message as a second turn. Later Slack
messages append as `source: "customer"`.

### Stream events

```ts
export type RunEvent =
  | { seq: number; type: "turn"; turn: RunTurn }
  | { seq: number; type: "tool_call"; update: ToolCallUpdate }
  | {
      seq: number;
      type: "status";
      previousStatus: RunStatus;
      status: RunStatus;
      createdAt: number;
    };
```

Tool-call updates need enough shape for Phase 10 to stream without changing the
socket protocol:

```ts
export type ToolCallUpdate = {
  id: string;
  callId: string;
  name: string;
  state: "running" | "completed" | "failed";
  input?: JsonValue;
  output?: JsonValue;
  error?: string;
  delta?: string;
  createdAt: number;
};
```

### WebSocket protocol

Client to server:

```ts
type RunClientMessage = {
  type: "steer";
  requestId: string;
  content: string;
};
```

Server to client:

```ts
type RunServerMessage =
  | {
      type: "sync";
      events: RunEvent[];
      cursor: number;
      complete: boolean;
      status: RunStatus | null;
    }
  | { type: "event"; event: RunEvent }
  | { type: "ack"; requestId: string; seq: number }
  | { type: "error"; code: string; message: string; requestId?: string };
```

Backlog is chunked. A full chunk uses `complete: false`; a final (possibly
empty) chunk uses `complete: true`. Phase 15 can render incrementally without a
single unbounded WebSocket frame.

---

## Task 0: Verify APIs and preserve the baseline

**Files:** Create `docs/superpowers/plans/phase-08-notes.md`

- [ ] **Step 1: Run the current suite before modifying configuration**

```bash
cd apps/worker
pnpm test
pnpm typecheck
```

Expected at the start of this phase: 15 test files and 82 tests pass. If the
count has moved, record the new baseline rather than editing tests to recover a
historical number.

- [ ] **Step 2: Read the installed runtime signatures**

Record the exact signatures for `DurableObject`, `DurableObjectState`,
`acceptWebSocket`, `getWebSockets`, `WebSocketPair`, `SqlStorage.exec`,
`DurableObjectNamespace.idFromName`, and the WebSocket attachment methods.

- [ ] **Step 3: Compare the two lifecycle config forms**

Confirm the installed Wrangler schema supports both `migrations` and
`exports`. Record why this phase uses `new_sqlite_classes` and the legacy form.

- [ ] **Step 4: Record every invented or stale API**

At minimum, call out any suggestion to use `server.accept()` for a hibernating
socket, ordinary event listeners on the DO-side socket, in-memory subscriber
maps as the source of truth, or `new_classes` for a SQLite-backed class.

- [ ] **Step 5: Spike the two facts Task 3 builds on top of**

Fifteen minutes here settles both storage assumptions before a real schema
depends on them.

This spike needs a binding, which Task 4 has not added yet. Add a throwaway
`class SpikeDO extends DurableObject {}` exported from `src/index.ts`, a
`RUNS` binding and a `new_sqlite_classes` migration tag in `wrangler.jsonc`,
and `test/run-spike.test.ts`. **Revert all of it before Step 6** — the tag is
local to miniflare and never reaches deployed migration history, and Task 4
adds the real versions. Only the recorded findings survive this step.

```ts
// test/run-spike.test.ts
import { env, runInDurableObject, evictDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

it("rowid alias increments monotonically and survives eviction", async () => {
  const key = `chat:${crypto.randomUUID()}`;
  const stub = env.RUNS.get(env.RUNS.idFromName(key));

  // The callback's SECOND argument is the DurableObjectState. `instance.ctx` is
  // `protected` on the cloudflare:workers DurableObject base and does not
  // typecheck from a test file.
  const first = await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS spike (seq INTEGER PRIMARY KEY, v TEXT)",
    );
    return state.storage.transactionSync(() => {
      state.storage.sql.exec("INSERT INTO spike (v) VALUES ('a')");
      return state.storage.sql
        .exec<{ seq: number }>("SELECT MAX(seq) AS seq FROM spike")
        .one().seq;
    });
  });

  await evictDurableObject(stub);

  const second = await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("INSERT INTO spike (v) VALUES ('b')");
    return state.storage.sql
      .exec<{ seq: number }>("SELECT MAX(seq) AS seq FROM spike")
      .one().seq;
  });

  expect(second).toBe(first + 1);
});
```

Record two things in the notes: that a rowid alias is sufficient (so
`AUTOINCREMENT` is never introduced), and that the DO reached by a given name
keeps its rows across eviction *and* across test files — which is why every
later test mints its own run key.

- [ ] **Step 6: Commit the notes**

```bash
git add docs/superpowers/plans/phase-08-notes.md
git commit -m "docs(runs): verify durable object hibernation api"
```

---

## Task 1: Freeze the protocol and origin-key contract

**Files:** Create `src/run/protocol.ts`, `src/run/keys.ts`,
`test/run-protocol.test.ts`

**Consumes:** Phase 07's Slack `channel_id`, canonical `thread_ts` and
`event_id`

**Produces:** `RunStatus`, turn/tool/event types, protocol parser,
`slackRunKey`, `chatRunKey`, and the one `runStubForKey` helper consumed by all
later tasks

- [ ] **Step 1: Write failing tests for exact statuses and transitions**

Tests must assert the exact five-value status list, not only happy-path values.
They must prove `done -> live` and `failed -> live` are allowed, an unknown
status is rejected, and a same-state update is idempotent.

- [ ] **Step 2: Write failing key tests**

Cover:

- a Slack root message uses its own `ts` as `thread_ts` before key creation;
- a Slack reply uses the root `thread_ts`;
- the same Slack thread always creates the same key;
- two different threads in one channel do not collide;
- chat and Slack keys cannot collide;
- empty IDs, `:` in components, malformed Slack timestamps and non-UUID chat
  IDs are rejected before `idFromName()`;
- both keys resolve through `runStubForKey()` to the `RunDO` namespace.

- [ ] **Step 3: Write failing protocol-parser tests**

Only `{ type: "steer", requestId, content }` is accepted from a dashboard
socket. Reject binary input, invalid JSON, blank content, oversized content,
unknown message types and client-supplied `role`/`source` fields.

The server assigns `role: "user"` and `source: "human_steer"`; a browser must
not be able to impersonate a customer or an approval decision.

- [ ] **Step 4: Implement the pure contracts**

Keep the file free of D1/DO calls except `runStubForKey()` in `keys.ts`. Export
`ACTIVE_RUN_STATUSES = ["live", "awaiting_approval", "idle"]` for repository
queries.

- [ ] **Step 5: Run and commit**

```bash
cd apps/worker
pnpm vitest run test/run-protocol.test.ts
git add src/run/protocol.ts src/run/keys.ts test/run-protocol.test.ts
git commit -m "feat(runs): freeze session and streaming protocol"
```

---

## Task 2: Add the D1 run index

**Files:** Create `migrations/0004_runs.sql`, `src/run/repository.ts`,
`test/run-repository.test.ts`

**Consumes:** Phase 01 D1 binding and Phase 03 `channels` table

**Produces:** listable `RunRecord`s without waking RunDOs

- [ ] **Step 1: Write the D1 migration**

```sql
CREATE TABLE runs (
  id         TEXT PRIMARY KEY,
  "key"      TEXT NOT NULL UNIQUE,
  origin     TEXT NOT NULL CHECK (origin IN ('slack', 'chat')),
  channel_id TEXT,
  thread_ts  TEXT,
  status     TEXT NOT NULL CHECK (
    status IN ('live', 'awaiting_approval', 'idle', 'done', 'failed')
  ),
  shadow     INTEGER NOT NULL DEFAULT 0 CHECK (shadow IN (0, 1)),
  summary    TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (origin = 'slack' AND channel_id IS NOT NULL AND thread_ts IS NOT NULL)
    OR
    (origin = 'chat' AND channel_id IS NULL AND thread_ts IS NULL)
  )
);

CREATE INDEX idx_runs_status_updated ON runs (status, updated_at DESC);
CREATE INDEX idx_runs_slack_thread ON runs (channel_id, thread_ts);
```

Quote `"key"` in every SQL statement. It is the spec's column name and using
an unquoted keyword-shaped identifier is an avoidable portability trap.

- [ ] **Step 2: Write failing repository tests**

Cover:

- `createOrGetRun()` is idempotent on origin key and returns the original UUID;
- Slack and Chat row-shape constraints fail closed;
- a second Slack thread gets a second UUID;
- `findOwnedSlackRun()` matches only active statuses;
- `listRuns()` orders by `updated_at DESC`, joins channel/customer display data,
  caps `limit`, and never calls the RUNS namespace;
- D1 rejects an invalid status and invalid `shadow` value;
- empty tables return `[]`, not `null`.

- [ ] **Step 3: Implement the D1-only repository**

Required surface:

```ts
export type RunRecord = {
  id: string;
  key: string;
  origin: RunOrigin;
  channelId: string | null;
  threadTs: string | null;
  status: RunStatus;
  shadow: boolean;
  summary: string | null;
  createdAt: number;
  updatedAt: number;
};

export function createOrGetRun(...): Promise<RunRecord>;
export function getRunById(...): Promise<RunRecord | null>;
export function getRunByKey(...): Promise<RunRecord | null>;
export function findOwnedSlackRun(...): Promise<RunRecord | null>;
export function listRuns(...): Promise<RunListItem[]>;
export function touchRun(...): Promise<void>;
```

Generate `runs.id` with `crypto.randomUUID()`. Use `INSERT OR IGNORE` on
`"key"`, then select the canonical row. Do not rely on a losing concurrent
insert returning the candidate UUID.

- [ ] **Step 4: Prove the migration applies from an empty database**

The test setup reads every D1 migration. Run the full suite once here; a
duplicate filename or malformed check constraint otherwise fails every test
later and obscures the cause.

- [ ] **Step 5: Commit**

```bash
git add migrations/0004_runs.sql src/run/repository.ts test/run-repository.test.ts
git commit -m "feat(runs): add d1 run index"
```

---

## Task 3: Build the RunDO SQLite session store

**Files:** Create `src/run/session.ts`, `test/run-session.test.ts`

**Consumes:** Task 1 protocol types

**Produces:** durable `initialize`, `appendTurn`, `appendToolCallUpdate`,
`setStatus`, `listEvents` and `snapshot` operations

- [ ] **Step 1: Define the private SQLite schema**

Create tables synchronously with `CREATE TABLE IF NOT EXISTS`:

```text
run_state
  singleton PK · run_id · run_key · origin · channel_id · thread_ts
  · status · summary · created_at · updated_at

stream_events
  seq INTEGER PRIMARY KEY · type · payload_json · created_at
  (rowid alias — nothing deletes from this table, so no AUTOINCREMENT)

turns
  id PK · role · source · content · metadata_json · created_at
  · event_seq UNIQUE

tool_calls
  call_id PK · name · state · input_json · output_json · error
  · started_at · updated_at

tool_updates
  id PK · call_id · name · state · input_json · output_json
  · error · delta · created_at · event_seq UNIQUE
```

`stream_events` is the socket replay log. `turns` and `tool_calls` are the
queryable session view Phase 10 needs. Both are in the same private SQLite
database, so there is no cross-store replication.

- [ ] **Step 2: Write failing initialization tests**

Prove initialization is idempotent for the same descriptor and rejects a
different run ID/key/origin pointed at the same DO. An uninitialized DO must
reject session mutations instead of creating an anonymous session.

Re-read **Test isolation** above before writing the first `describe`. Storage is
shared across files in this pool. Every test in this file starts from its own
key:

```ts
function freshRun() {
  const key = `chat:${crypto.randomUUID()}`;
  const stub = env.RUNS.get(env.RUNS.idFromName(key));
  return { key, stub, id: crypto.randomUUID() };
}
```

The idempotent-initialize case and the rejects-a-different-descriptor case must
each call `freshRun()`. Sharing one key makes the second pass for the wrong
reason.

- [ ] **Step 3: Write failing one-inbox tests**

Call the same `appendTurn()` with `triage`, `customer`, `human_steer` and
`approval` sources. Assert ordered `seq` values and one common turn shape.
There must be no source-specific storage method.

- [ ] **Step 4: Write failing idempotency and atomicity tests**

- appending the same turn ID twice returns the original event and leaves one
  turn plus one stream event;
- appending two distinct turns creates consecutive `seq` values — assert
  `second.seq === first.seq + 1`, never `expect(seq).toBe(1)`;
- an invalid turn writes neither table;
- a tool update and its stream event commit together;
- repeating a tool update ID does not append a second delta;
- a `completed`/`failed` update preserves the original tool input while adding
  output/error.

Use `storage.transactionSync()` for the event plus materialized row. Do not
write the row, `await`, and then write its stream event.

- [ ] **Step 5: Write failing status tests**

Assert every allowed transition, at least one forbidden transition, and
same-state idempotency. A real transition appends exactly one `status` event.

- [ ] **Step 6: Implement bounded reads**

`listEvents(afterSeq, limit)` clamps `afterSeq >= 0` and `1 <= limit <= 1000`.
`snapshot()` returns `{ state, events, cursor }`. Never expose an unbounded
`SELECT *` through RPC.

- [ ] **Step 7: Run and commit**

```bash
pnpm vitest run test/run-session.test.ts
git add src/run/session.ts test/run-session.test.ts
git commit -m "feat(runs): durable sqlite session with one inbox"
```

---

## Task 4: Add the RunDO class, binding and RPC surface

**Files:** Create `src/run/do.ts`; modify `src/index.ts`, `wrangler.jsonc`,
`worker-configuration.d.ts`, `test/run-session.test.ts`

**Consumes:** Tasks 1-3

**Produces:** a typed `RUNS` binding and one exported `RunDO` class

- [ ] **Step 1: Add the binding and SQLite class declaration**

Add `durable_objects.bindings` and a unique legacy migration tag using
`new_sqlite_classes: ["RunDO"]`. If a migration tag already exists in the
deployed config, append instead of rewriting it.

- [ ] **Step 2: Export the class from the Worker entry module**

```ts
export { RunDO } from "./run/do";
```

The named export is required for the binding. Keep the default exported Worker
handler unchanged.

- [ ] **Step 3: Regenerate bindings**

```bash
pnpm cf-typegen
```

Confirm the generated environment contains `RUNS`; do not hand-edit
`worker-configuration.d.ts`. Add the precise generic to the app's `Env` type:

```ts
RUNS: DurableObjectNamespace<RunDO>;
```

- [ ] **Step 4: Implement the RPC surface**

There is no separate `RunDOEnv`. RunDO takes the app's own `Env` from
`src/index.ts` — it needs `DB` for the D1 index write, and every other module in
this Worker already does `import type { Env } from "../index"`. Keep that
import **type-only**: `src/index.ts` value-exports `RunDO`, so a value import
back into `do.ts` would be a real module cycle.

```ts
import type { Env } from "../index";

export class RunDO extends DurableObject<Env> {
  initialize(descriptor: RunDescriptor): RunState;
  appendTurn(input: RunTurnInput): Promise<AppendResult>;
  appendToolCallUpdate(input: ToolCallUpdateInput): Promise<AppendResult>;
  setStatus(status: RunStatus): Promise<StatusResult>;
  snapshot(afterSeq?: number): SessionSnapshot;
}
```

Rules:

- constructor work is synchronous schema setup only;
- no timer, interval or outbound socket;
- **every mutation is one synchronous critical section, then I/O.** Commit the
  event with `transactionSync()` and broadcast it to `ctx.getWebSockets()` in
  that same continuation, *then* `await` the D1 `updated_at` write, then return.
  Nothing may `await` between the commit and the broadcast — see invariant 4 and
  the ordering hazard in the race table;
- status changes update both private state and the D1 index through one method;
- a retry of an already-committed event still repairs/touches D1;
- only JSON/structured-clone-safe values cross RPC.

Sketch, because the ordering is the whole point:

```ts
async appendTurn(input: RunTurnInput): Promise<AppendResult> {
  // synchronous: commit, then hand to sockets, no await in between
  const result = this.ctx.storage.transactionSync(() => commitTurn(this.ctx, input));
  if (result.appended) this.#broadcast(result.event);

  // I/O only after every socket already holds the event
  await touchRun(this.env.DB, result.runId, result.event.createdAt);
  return result;
}
```

- [ ] **Step 5: Test namespace identity and eviction**

Use `runInDurableObject()` to inspect private SQLite and
`evictDurableObject()` to destroy the instance. After eviction, the same stub
must return the same state, turns, tool calls and cursor.

- [ ] **Step 6: Run configuration validation, tests and commit**

```bash
pnpm exec wrangler deploy --dry-run
pnpm vitest run test/run-session.test.ts
pnpm typecheck
git add src/run/do.ts src/index.ts wrangler.jsonc worker-configuration.d.ts \
  test/run-session.test.ts
git commit -m "feat(runs): add sqlite-backed run durable object"
```

---

## Task 5a: Hibernating upgrade and gap-free sync

**Files:** Modify `src/run/do.ts`; create `test/run-ws.test.ts`

**Consumes:** persisted `RunEvent.seq` from Task 3

**Produces:** the upgrade path and cursor replay — no live broadcast yet

Task 5 was split. 5a is the read path (upgrade, clamp, backlog); 5b is the
write path (broadcast, steer). They fail independently and a reviewer can
reject one while accepting the other.

### Shared test harness

Put this at the top of `test/run-ws.test.ts`; both 5a and 5b use it.

```ts
import { env, evictDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import type { RunServerMessage } from "../src/run/protocol";

// Storage is shared across this whole pool — see "Test isolation". Every case
// mints its own key so no other test's events land in its backlog.
export function freshRun() {
  const key = `chat:${crypto.randomUUID()}`;
  const stub = env.RUNS.get(env.RUNS.idFromName(key));
  return { key, runId: crypto.randomUUID(), stub };
}

export type Socket = {
  ws: WebSocket;
  inbox: RunServerMessage[];
};

export async function connect(
  stub: DurableObjectStub,
  since = 0,
): Promise<Socket> {
  const res = await stub.fetch(`https://run/ws?since=${since}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const inbox: RunServerMessage[] = [];
  ws.addEventListener("message", (e) => {
    inbox.push(JSON.parse(e.data as string) as RunServerMessage);
  });
  ws.accept();
  return { ws, inbox };
}

export async function waitFor(
  socket: Socket,
  match: (m: RunServerMessage) => boolean,
  timeoutMs = 1000,
): Promise<RunServerMessage> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = socket.inbox.find(match);
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(`no match; inbox was ${JSON.stringify(socket.inbox)}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Drains the initial backlog and returns the cursor the server settled on.
export async function syncedCursor(socket: Socket): Promise<number> {
  const done = await waitFor(socket, (m) => m.type === "sync" && m.complete);
  return (done as Extract<RunServerMessage, { type: "sync" }>).cursor;
}

export function turn(id: string, content = "hi") {
  return { id, role: "user", source: "human_steer", content } as const;
}
```

`touchRun()` updates zero rows when the test never inserted a `runs` row. That
is fine and intentional — these tests exercise the DO, not the D1 index, and
the mutation must not fail on a missing index row.

- [ ] **Step 1: Write a failing upgrade test**

`RunDO.fetch()` accepts only `GET` with `Upgrade: websocket`. Return `426` for
a normal HTTP request and a structured `400` for invalid `since` values.

- [ ] **Step 2: Implement the hibernating upgrade correctly**

The core sequence is:

```ts
const [client, server] = Object.values(new WebSocketPair());
this.ctx.acceptWebSocket(server);
// synchronously send ordered sync chunks from RunDO SQLite
server.serializeAttachment({ lastSeq: cursor });
return new Response(null, { status: 101, webSocket: client });
```

Do not call `server.accept()` and do not register a server-side `message`
listener.

- [ ] **Step 3: Make reconnect sync gap-free**

1. Parse `?since=N`, default `0`.
2. Read `latestSeq()` and clamp `since` to it. A malicious future cursor must
   not suppress all future live events.
3. Accept the socket.
4. Synchronously read and send ordered chunks after the cursor until a final
   `complete: true` frame.
5. Store the final cursor in the socket attachment.
6. Return the upgrade response without an `await` between the snapshot read and
   socket registration/sync.

Because all of this runs within one DO event and uses synchronous SQLite, an
append is serialized either before the captured cursor or after the socket is
registered. There is no gap in which an event can be in neither path.

- [ ] **Step 4: Write the resumption tests**

```ts
it("replays only events after the client cursor", async () => {
  const { runId, key, stub } = freshRun();
  await stub.initialize({ runId, key, origin: "chat" });

  const a = await stub.appendTurn(turn("t-1"));
  const b = await stub.appendTurn(turn("t-2"));
  const c = await stub.appendTurn(turn("t-3"));

  const socket = await connect(stub, a.event.seq);
  await syncedCursor(socket);

  const replayed = socket.inbox
    .filter((m) => m.type === "sync")
    .flatMap((m) => (m as Extract<RunServerMessage, { type: "sync" }>).events)
    .map((e) => e.seq);

  expect(replayed).toEqual([b.event.seq, c.event.seq]);
});

it("returns an empty complete sync when the client is current", async () => {
  const { runId, key, stub } = freshRun();
  await stub.initialize({ runId, key, origin: "chat" });
  const a = await stub.appendTurn(turn("t-1"));

  const socket = await connect(stub, a.event.seq);
  const cursor = await syncedCursor(socket);

  expect(cursor).toBe(a.event.seq);
  expect(
    socket.inbox.flatMap((m) =>
      m.type === "sync" ? m.events : [],
    ),
  ).toEqual([]);
});

it("clamps a cursor from the future instead of muting the run", async () => {
  const { runId, key, stub } = freshRun();
  await stub.initialize({ runId, key, origin: "chat" });
  const a = await stub.appendTurn(turn("t-1"));

  const socket = await connect(stub, a.event.seq + 10_000);
  expect(await syncedCursor(socket)).toBe(a.event.seq);
});
```

Also cover, in the same style: a non-WebSocket `GET` returns `426`, a
non-numeric or negative `since` returns a structured `400`, and a backlog large
enough to force more than one chunk arrives with strictly increasing, unique
`seq` values and exactly one `complete: true` frame.

The future-cursor case is the one that matters most and is easiest to get
wrong: without the clamp, the socket attachment holds a `lastSeq` no event will
ever exceed, and the skip rule in 5b silences that client forever.

- [ ] **Step 5: Run and commit**

```bash
pnpm vitest run test/run-ws.test.ts
git add src/run/do.ts test/run-ws.test.ts
git commit -m "feat(runs): hibernating websocket upgrade with cursor replay"
```

---

## Task 5b: Live broadcast, steering and hibernation resumption

**Files:** Modify `src/run/do.ts`, `test/run-ws.test.ts`

**Consumes:** Task 5a's upgrade path and socket attachments

**Produces:** the live half of the stream protocol

- [ ] **Step 1: Broadcast only committed events, before any `await`**

The broadcast is called from inside the mutation's synchronous section — the
sketch in Task 4 Step 4 — never after the D1 touch. Iterate
`ctx.getWebSockets()`. For each socket:

- read `{ lastSeq }` from `deserializeAttachment()`;
- skip when `lastSeq >= event.seq`;
- send `{ type: "event", event }`;
- update the attachment to the new cursor;
- isolate a broken socket so one client cannot fail the mutation for all.

No in-memory subscriber map is needed. `getWebSockets()` is the recoverable
source after hibernation.

The skip rule and the ordering rule are load-bearing *together*. The skip rule
alone is what makes an out-of-order broadcast lose an event permanently rather
than merely reorder it, because a skipped `seq` is never retried and the
client's next reconnect asks for the higher cursor it already recorded.

- [ ] **Step 2: Write the ordering regression test**

```ts
it("delivers concurrent appends in seq order", async () => {
  const { runId, key, stub } = freshRun();
  await stub.initialize({ runId, key, origin: "chat" });

  const socket = await connect(stub);
  await syncedCursor(socket);

  // Both RPCs are in flight at once; each awaits a D1 write after committing.
  const [first, second] = await Promise.all([
    stub.appendTurn(turn("t-a")),
    stub.appendTurn(turn("t-b")),
  ]);

  const expected = [first.event.seq, second.event.seq].sort((x, y) => x - y);
  await waitFor(socket, (m) => m.type === "event" && m.event.seq === expected[1]);

  const delivered = socket.inbox
    .filter((m) => m.type === "event")
    .map((m) => (m as Extract<RunServerMessage, { type: "event" }>).event.seq);

  expect(delivered).toEqual(expected);
});
```

This is a guard, not a proof — whether the interleaving that breaks a
broadcast-after-`await` implementation actually occurs depends on D1 timing. The
real guarantee is structural and belongs in review: **no `await` sits between
`transactionSync()` and `#broadcast()`.** Reject the task if one appears, even
with this test green.

- [ ] **Step 3: Add steering through `webSocketMessage()`**

Parse only text `steer` messages. Convert them server-side to:

```ts
{
  id: `steer:${requestId}`,
  role: "user",
  source: "human_steer",
  content,
}
```

Transition the run to `live` when necessary, call the same `appendTurn()`, and
return an `ack` containing the committed `seq`. Parse/storage errors become an
error frame for that socket; they do not crash or broadcast an uncommitted
turn.

- [ ] **Step 4: Set a no-wake ping response**

In the constructor:

```ts
this.ctx.setWebSocketAutoResponse(
  new WebSocketRequestResponsePair("ping", "pong"),
);
```

`setWebSocketAutoResponse` is the method; `WebSocketRequestResponsePair` is only
the payload type. This gives the future UI a health check that does not wake a
hibernating object.

- [ ] **Step 5: Write the two-tab test**

```ts
it("two tabs on one run see the same event and seq", async () => {
  const { runId, key, stub } = freshRun();
  await stub.initialize({ runId, key, origin: "chat" });

  const tabA = await connect(stub);
  const tabB = await connect(stub);
  await syncedCursor(tabA);
  await syncedCursor(tabB);

  const { event } = await stub.appendTurn(turn("t-shared", "same bytes"));

  const seen = async (s: Socket) =>
    (await waitFor(s, (m) => m.type === "event")) as Extract<
      RunServerMessage,
      { type: "event" }
    >;

  const [fromA, fromB] = await Promise.all([seen(tabA), seen(tabB)]);

  expect(fromA.event.seq).toBe(event.seq);
  expect(fromB.event.seq).toBe(event.seq);
  expect(JSON.stringify(fromA.event)).toBe(JSON.stringify(fromB.event));
});
```

The `JSON.stringify` comparison is deliberate — the exit criterion says
"byte-equivalent", and a per-socket transform that reorders keys or injects a
cursor would pass a shallow `toEqual`.

- [ ] **Step 6: Write the real hibernation test**

```ts
it("resumes a hibernated socket after the instance is torn down", async () => {
  const { runId, key, stub } = freshRun();
  await stub.initialize({ runId, key, origin: "chat" });

  const socket = await connect(stub);
  const cursor = await syncedCursor(socket);

  // Destroys the instance; the attached socket hibernates rather than closing.
  await evictDurableObject(stub, { webSockets: "hibernate" });

  const { event } = await stub.appendTurn(turn("t-after-evict"));
  expect(event.seq).toBeGreaterThan(cursor);

  const live = (await waitFor(
    socket,
    (m) => m.type === "event",
  )) as Extract<RunServerMessage, { type: "event" }>;

  expect(live.event.seq).toBe(event.seq);
});
```

This is the phase's proof that no correctness state lives in memory. A variant
that steers over the hibernated socket instead of appending by RPC exercises
`webSocketMessage()` after constructor re-entry — write both.

- [ ] **Step 7: Run and commit**

```bash
pnpm vitest run test/run-ws.test.ts
pnpm typecheck
git add src/run/do.ts test/run-ws.test.ts
git commit -m "feat(runs): live broadcast steering and hibernation resumption"
```

---

## Task 6: Add run coordination and HTTP routes

**Files:** Create `src/run/coordinator.ts`, `src/api/runs.ts`; modify
`src/index.ts`; create/modify API tests

**Consumes:** D1 repository, RunDO namespace, Phase 05 Access-protected API

**Produces:** run list/create/read/steer APIs and `/ws/run/:id`

- [ ] **Step 1: Implement the coordinator, not origin-specific pipelines**

The coordinator owns infrastructure choreography only:

```ts
export function ensureRun(...): Promise<{ run: RunRecord; stub: RunStub }>;
export function createChatRun(...): Promise<RunRecord>;
export function wakeSlackRun(...): Promise<RunRecord>;
export function routeSlackMessageToOwnedRun(...): Promise<boolean>;
```

It may branch on `origin` to build identity, but never on bug/feature/question.
`wakeSlackRun()` appends one `source: "triage"` opening turn.
`routeSlackMessageToOwnedRun()` appends one `source: "customer"` turn.

- [ ] **Step 2: Add `GET /api/runs`**

Return the D1 index only, newest first. Accept bounded `limit` and optional
validated status. Join `channels` for `channelName`/`customerSlug`. This route
must not wake every listed RunDO.

- [ ] **Step 3: Add `POST /api/runs` for Chat**

The server creates **two** independent UUIDs — one for the public `runs.id`,
one for the private `chat:{uuid}` key — per the rule under "Run identity". A
test must assert they differ; reusing one value is the easy mistake and it
voids invariant 10. If a first message is present, append it as
`role: "user", source: "human_steer"` through the same inbox. Return `201`
with the public run record and never the key.

- [ ] **Step 4: Add `GET /api/runs/:id`**

Return D1 metadata plus a bounded initial snapshot for the drawer/chat
component. A missing ID returns `404`; it must not instantiate a new DO.

- [ ] **Step 5: Add `POST /api/runs/:id/turns`**

This is the HTTP fallback for dashboard steering. Accept only
`{ requestId, content }`; assign role/source server-side and call
`appendTurn()`. It must share the same idempotency key as a socket retry.

- [ ] **Step 6: Add `GET /ws/run/:id`**

Look up the public ID in D1, resolve its private key through
`runStubForKey()`, and forward the raw upgrade request to the DO. Unknown IDs
return `404` without creating a namespace instance.

Mount `/ws` above the static asset catch-all in `src/index.ts`. Do not add it
to the Cloudflare Access bypass policy.

- [ ] **Step 7: Test API error contracts**

Cover empty list, invalid status/limit, blank steering content, missing run,
idempotent Chat create retry, non-WebSocket request, and the exact public JSON
shape. No stack traces or internal DO keys in error bodies.

- [ ] **Step 8: Run and commit**

```bash
pnpm test
pnpm typecheck
git add src/run/coordinator.ts src/api/runs.ts src/index.ts test
git commit -m "feat(api): run list chat creation and live steering routes"
```

---

## Task 7: Wire triage and later Slack messages into the one inbox

**Files:** Modify `src/triage/consumer.ts`, `src/index.ts`,
`test/triage-consumer.test.ts`; create `test/run-triage.test.ts`

**Consumes:** Phase 07 stored decision and opening prompt

**Produces:** actionable first messages wake a run; later thread messages join
it without another model classification

### Why the Phase 07 seam must change

The current optional `hasLiveRun(channelId, threadTs): Promise<boolean>` can
skip triage, but it cannot append the customer message it skipped. Wiring it
as written would silently lose follow-up messages from the run. It also splits
"check" from "append", which creates a race.

Replace it with one operation:

```ts
routeToOwnedRun?: (message: SlackRunMessage) => Promise<boolean>;
```

`true` means the callback found an owning run **and committed the message as a
turn**. `false` means triage should continue. Keep the old seam only long
enough to update Phase 07 tests in the same commit; do not leave two production
paths.

- [ ] **Step 1: Write a failing existing-run test**

Seed a `live`, `idle` or `awaiting_approval` Slack run. Deliver a later thread
message. Assert:

- Haiku is not called;
- no `triage_decisions` row is written for that event;
- one `slack:{event_id}` customer turn appears in the existing RunDO;
- a duplicate queue delivery creates no second turn;
- the run is `live` after the interruption.

- [ ] **Step 2: Add a wake callback to triage dependencies**

```ts
wakeRun?: (input: {
  eventId: string;
  channelId: string;
  threadTs: string;
  openingPrompt: string;
}) => Promise<void>;
```

Production supplies `wakeSlackRun()` from the coordinator. Tests may inject a
fake.

- [ ] **Step 3: Fix decision-to-wake retry semantics**

The existing Phase 07 consumer returns immediately when a decision row exists.
That is unsafe once waking becomes a second I/O operation:

```text
INSERT triage decision succeeds
RunDO wake fails
queue retries
consumer sees decision and returns
actionable message never wakes a run
```

On an existing stored decision:

- if `wake = 0`, return;
- if `wake = 1`, load the message identity and call `wakeRun()` again;
- never call the triage model again.

`triage:{event_id}` makes the replay safe.

**The decision check must stay first, above `routeToOwnedRun`.** The current
consumer (`src/triage/consumer.ts:53`) returns on an existing decision before it
fetches the message row; the replay branch therefore has to fetch that row
*inside itself*. Do not "clean this up" by hoisting the message fetch above the
decision check and moving `routeToOwnedRun` with it. Concretely, the order is:

```text
1. SELECT triage_decisions WHERE event_id = ?
     wake = 0 -> return
     wake = 1 -> load message row, call wakeRun() again, return
2. load message row
3. policy / shouldTriage gate
4. routeToOwnedRun(message)  -> true means committed, return
5. recall + model call + INSERT OR IGNORE decision
6. if wake, call wakeRun(); throw on failure so the queue retries
```

Reason, and it is not stylistic: a wake that half-succeeded leaves a `live` run
owning the thread. On retry with the checks reordered, step 4 would see that run
and append the triggering message as a `source: "customer"` turn — the exact
double-append forbidden under "Turns", since that message is already inside the
opening prompt. Keeping the decision check first means a retry always takes the
replay branch and never reaches `routeToOwnedRun`.

A consequence to accept rather than fix: a message that `routeToOwnedRun`
claims writes **no** `triage_decisions` row, so the Phase 07 `triaged` counter
does not count follow-ups inside an owned thread. That is correct — the counter
measures triage decisions, and no decision was made. State it in the notes so it
does not read as a regression during Phase 05 counter review.

- [ ] **Step 4: Wire a new wake**

After `INSERT OR IGNORE` of a new `wake = 1` decision, call `wakeRun()`. If it
fails, throw so that the queue message retries. Do not acknowledge a decision
whose required wake has not been durably delivered.

- [ ] **Step 5: Write retry tests**

- wake fails once after the decision insert, then succeeds on retry;
- Haiku call count remains one;
- the opening turn appears once;
- two simultaneous/repeated wake deliveries converge on one D1 run row and one
  opening turn;
- `wake = false` never creates a run;
- a `done` run is not treated as owning the thread before triage, but a new
  wake reopens the same key and history.

- [ ] **Step 6: Wire production dependencies in `src/index.ts`**

The triage queue case supplies both:

```ts
routeToOwnedRun: (message) => routeSlackMessageToOwnedRun(env, message),
wakeRun: (input) => wakeSlackRun(env, input),
```

No HTTP self-call and no new queue are needed. The consumer and coordinator are
already in the trusted parent Worker.

- [ ] **Step 7: Run and commit**

```bash
pnpm vitest run test/triage-consumer.test.ts test/run-triage.test.ts
pnpm test
pnpm typecheck
git add src/triage/consumer.ts src/index.ts test/triage-consumer.test.ts \
  test/run-triage.test.ts
git commit -m "feat(triage): wake and resume thread-scoped runs idempotently"
```

---

## Task 8: Prove the exit criteria locally and on the deployed Worker

**Files:** Modify `phase-08-notes.md` with results only

- [ ] **Step 1: Run the complete automated gate**

```bash
cd apps/worker
pnpm test
pnpm typecheck
pnpm exec wrangler deploy --dry-run
```

No test may depend on `.dev.vars` secret values or a live Zep/Anthropic call.

- [ ] **Step 2: Test two tabs against local Wrangler**

Create one Chat run, open two WebSocket clients at `/ws/run/:id`, steer from
one, and confirm both receive the same ordered event. Refresh one client using
its last cursor and confirm no repeated turn.

- [ ] **Step 3: Test a real Slack thread in `#test-firedrill`**

Post an actionable root message, verify one run row and one triage opening
turn, then post a reply and verify it enters the same RunDO without another
triage decision.

Do not enable ungated posting to real customer channels. This phase only
observes and creates internal session state.

- [ ] **Step 4: Deploy and verify Access behavior**

- authenticated dashboard origin upgrades the socket successfully;
- an unauthenticated `/ws/run/:id` request is blocked by Access;
- `/slack/events` still bypasses Access and passes Slack signature handling;
- a missing public run ID returns `404` and does not create a DO.

- [ ] **Step 5: Verify hibernation evidence**

Automated proof is the `evictDurableObject()` test. In deployed observability,
also confirm an idle connected run is not kept active by application timers or
outbound sockets.

- [ ] **Step 6: Record results and commit**

```bash
git add docs/superpowers/plans/phase-08-notes.md
git commit -m "docs(runs): record phase 08 verification"
```

---

## Phase 08 exit criteria

- [ ] Slack root messages and Chat sessions resolve to the same `RunDO` class
  through the same key helper and expose the same session/protocol shape.
- [ ] A Slack thread has at most one D1 run row and one Durable Object identity.
- [ ] Triage opening, customer follow-up, dashboard steering and a synthetic
  approval outcome all persist through the same `appendTurn()` method.
- [ ] Every persisted turn/tool/status event has a unique increasing `seq` and
  is committed before any socket sees it.
- [ ] No `await` appears between a mutation's `transactionSync()` commit and its
  broadcast, and concurrent appends are delivered in `seq` order.
- [ ] No test asserts an absolute `seq` value or reuses a run key across cases;
  every Durable Object test mints its own key.
- [ ] Two browser tabs see byte-equivalent events in the same order.
- [ ] Reconnect with `since` has neither a gap nor a duplicate.
- [ ] Forced Durable Object eviction preserves the session and an attached
  hibernating WebSocket resumes.
- [ ] `GET /api/runs` lists from D1 without waking every RunDO.
- [ ] A later message in an owned Slack thread bypasses triage and is not lost.
- [ ] A stored wake decision is replayable after partial failure without a
  second Haiku call or a second opening turn.
- [ ] No `type`/`category` field or bug/feature/question branch appears anywhere
  in the run layer.
- [ ] Full tests, typecheck and Wrangler dry-run pass.

---

## Handoff to later phases

- **Phase 09** receives a typed RunDO bridge and can emit tool-call updates
  without inventing a second event protocol.
- **Phase 10** consumes ordered turns for the model loop, appends assistant
  turns/tool updates, and moves `live -> idle/done/failed`.
- **Phase 11** calls `appendTurn()` with `source: "approval"`; it does not build
  a separate resume mechanism.
- **Phase 15** consumes `GET /api/runs`, the initial snapshot and
  `/ws/run/:id?since=` for the live drawer.
- **Phase 17** creates Chat runs through the same API and renders the same
  session component.

Do not add temporary alternate paths in those phases. The reason Phase 08 is
strict about one inbox and one cursor protocol is to make later features add
capabilities, not parallel state machines.
