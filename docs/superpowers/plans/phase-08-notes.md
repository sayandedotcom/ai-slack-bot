# Phase 08 notes — verified APIs and model mistakes

Raw material for the README's AI-tool notes. Everything below was read from the
installed types or proved by a throwaway spike on 2026-08-11, not recalled.

Environment: `workerd@1.20260804.1`, wrangler 4.120, `@cloudflare/vitest-pool-workers`
0.21.0, vitest 4.1.10.

---

## Baseline before any change

```
pnpm test       15 test files, 82 tests, 0 failures
pnpm typecheck  clean
```

Matches the number the plan predicted. No test was edited to reach it.

---

## Verified runtime signatures

Read from `apps/worker/worker-configuration.d.ts` (generated, never hand-edited).

### The base class — `cloudflare:workers` (line 13109)

```ts
export abstract class DurableObject<Env = Cloudflare.Env, Props = {}> {
    protected ctx: DurableObjectState<Props>;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
    alarm?(alarmInfo?: AlarmInvocationInfo): void | Promise<void>;
    fetch?(request: Request): Response | Promise<Response>;
    webSocketMessage?(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void>;
    webSocketClose?(ws: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void>;
    webSocketError?(ws: WebSocket, error: unknown): void | Promise<void>;
}
```

**`ctx` and `env` are `protected`.** This is the single most load-bearing
detail for the test strategy — see the mistakes section.

### `DurableObjectState` (line 555ff)

```ts
readonly id: DurableObjectId;
readonly storage: DurableObjectStorage;
blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
acceptWebSocket(ws: WebSocket, tags?: string[]): void;
getWebSockets(tag?: string): WebSocket[];
setWebSocketAutoResponse(maybeReqResp?: WebSocketRequestResponsePair): void;
getWebSocketAutoResponse(): WebSocketRequestResponsePair | null;
getWebSocketAutoResponseTimestamp(ws: WebSocket): Date | null;
setHibernatableWebSocketEventTimeout(timeoutMs?: number): void;
getTags(ws: WebSocket): string[];
```

### `DurableObjectStorage` (line 595ff)

```ts
sql: SqlStorage;
kv: SyncKvStorage;
transactionSync<T>(closure: () => T): T;
```

`transactionSync` is synchronous in and out — it takes `() => T` and returns
`T`, not a promise. That is what makes commit-then-broadcast-before-`await`
expressible at all.

### `SqlStorage` (line 3214ff)

```ts
interface SqlStorage {
    exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: any[]): SqlStorageCursor<T>;
    get databaseSize(): number;
}
type SqlStorageValue = ArrayBuffer | string | number | null;

declare abstract class SqlStorageCursor<T> {
    next(): { done?: false; value: T } | { done: true; value?: never };
    toArray(): T[];
    one(): T;
    raw<U extends SqlStorageValue[]>(): IterableIterator<U>;
    columnNames: string[];
}
```

`.one()` and `.toArray()` exist. Spreading a cursor into an array works but is
noisier than `.one()` for a single-row read.

Note `SqlStorageValue` has **no boolean**. Booleans persist as `0`/`1`
integers, exactly like the D1 tables in phases 01–07.

### `DurableObjectNamespace` (line 533ff)

```ts
newUniqueId(options?): DurableObjectId;
idFromName(name: string): DurableObjectId;
idFromString(id: string): DurableObjectId;
get(id: DurableObjectId, options?): DurableObjectStub<T>;
getByName(name: string, options?): DurableObjectStub<T>;
```

### `WebSocket` attachments (line 3165)

```ts
serializeAttachment(attachment: any): void;
deserializeAttachment(): any | null;
```

### `WebSocketRequestResponsePair` (line 632)

```ts
declare class WebSocketRequestResponsePair {
    constructor(request: string, response: string);
    get request(): string;
    get response(): string;
}
```

### Test helpers — `cloudflare:test`

```ts
export function runInDurableObject<O, R>(
    stub: DurableObjectStub<O>,
    callback: (instance: O, state: DurableObjectState) => R | Promise<R>
): Promise<R>;

export interface DurableObjectEvictionOptions {
    webSockets?: "close" | "hibernate";   // defaults to "hibernate"
}
export function evictDurableObject(stub, options?): Promise<void>;
export function listDurableObjectIds<T>(namespace): Promise<DurableObjectId[]>;
export function reset(): Promise<void>;
```

---

## Spike results (Task 0 Step 5)

Throwaway `SpikeDO` + `test/run-spike.test.ts`, run and then reverted. Three
cases, all passing, `pnpm typecheck` clean.

**1. A plain `INTEGER PRIMARY KEY` is monotonic and survives eviction.**

Insert → read `MAX(seq)` → `evictDurableObject(stub)` → insert → read again
returned exactly `first + 1`. `AUTOINCREMENT` is unnecessary and is not used by
`stream_events`. This was never verified against DO SQLite's internal-table
restrictions because it never needed to be.

**2. There is no `isolatedStorage`, and this is now proved rather than assumed.**

Two test cases in one file sharing a literal DO name: the first created a table
and inserted one row and read `COUNT(*) = 1`; the second issued no `CREATE
TABLE`, inserted one row, and read `COUNT(*) = 2`. Storage carries across test
cases, and (per the existing comment in `test/triage-consumer.test.ts:38`)
across test files in the same run.

Consequence, now a hard rule for every later task: **each DO test mints its own
run key** — `chat:${crypto.randomUUID()}` — and no test asserts an absolute
`seq`.

`reset()` is not the alternative. It deletes data from every attached binding
including the D1 that `test/setup.ts` migrates once at module load, so calling
it would break the other 15 suites.

---

## Wrangler lifecycle choice

`node_modules/wrangler/config-schema.json` accepts both the legacy `migrations`
array and the newer declarative `exports` map. This phase uses the legacy form:

```jsonc
"durable_objects": {
  "bindings": [{ "name": "RUNS", "class_name": "RunDO" }]
},
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["RunDO"] }]
```

Reason: the official Vitest recipe and `spikes/worker-loader/wrangler.jsonc` in
this repo both use `new_sqlite_classes`, and it is the lower-risk choice on a
seven-day clock. Current docs call `exports` the replacement, so this is a
deliberate override of newer guidance and is disclosed here for that reason.

`new_classes` would create a KV-backed object and is never correct for this
phase.

---

## Invented, stale, or misleading APIs

Ordered by how much time each would have cost.

**1. `instance.ctx` inside `runInDurableObject` does not typecheck.**

The obvious spelling — and the one that appears in plenty of examples — is:

```ts
await runInDurableObject(stub, (instance) => instance.ctx.storage.sql.exec(...));
```

`ctx` is `protected` on the `cloudflare:workers` `DurableObject` base, so TS
rejects it from a test file. The callback's **second argument** is the
`DurableObjectState`, and that is the supported way in:

```ts
await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec(...));
```

Caught by the spike. The Phase 08 plan itself contained the wrong spelling in
its Task 0 example and was corrected against the installed types.

**2. `server.accept()` for a hibernating socket.**

`ctx.acceptWebSocket(server)` is what registers a socket for hibernation.
`server.accept()` produces a working socket that pins the object in memory and
silently burns duration cost. Both compile.

**3. Ordinary `message` listeners on the DO-side socket.**

`server.addEventListener("message", ...)` compiles and works *until* the object
hibernates, at which point the listener is gone and messages route to the class
handler that was never written. Hibernating sockets deliver through
`webSocketMessage` / `webSocketClose` / `webSocketError` only.

**4. An in-memory `Map` of connected clients.**

`ctx.getWebSockets()` is the recoverable source after constructor re-entry. Any
`Map` populated at connect time is empty after eviction, and the failure is
invisible in a test that never evicts.

**5. `WebSocketRequestResponsePair` is not a method.**

The call is
`ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))`.
The pair is the payload.

**6. `env` and `SELF` from `cloudflare:test` are deprecated.**

The installed types mark both, pointing at `import { env } from "cloudflare:workers"`
and `exports.default.fetch()`. All 15 existing suites use the `cloudflare:test`
spelling and it still works, so Phase 08 stays consistent rather than splitting
the codebase across two idioms mid-build. Worth a sweep after the drill.

**7. `pnpm cf-typegen` types a secret that does not exist.**

`wrangler types` reads the *declared names* in `.dev.vars`, not their values.
A bare `ANTHROPIC_API_KEY=` with nothing after it is enough to emit

```ts
ANTHROPIC_API_KEY: string;
```

into `worker-configuration.d.ts`. The type system then promises a string that
is `""` at runtime, and every call site typechecks. That is exactly what is in
this repo right now: the name is declared, the value is empty.

Two consequences:

- **The output is machine-dependent.** Regenerating here added the line
  relative to the committed copy, which predated Phase 07. A teammate with a
  thinner `.dev.vars` generates a different file and sees a spurious diff. This
  is why `test/env.d.ts` declares secrets by hand — only commit the binding
  change from a regeneration.
- **A green suite is not evidence a credential works.** Phase 08 never touches
  Anthropic, and Phase 07's suites inject a fake `TriageRunner`, so
  `makeTriageRunner(env)` and the real Haiku call had never run at the time this
  was written — `haikuCostUsd` was unit-tested against synthetic usage numbers
  only, while cost telemetry is a graded deliverable. **Resolved 2026-08-12**:
  the key was filled in and the live path exercised once; the token→cost mapping
  is real (~$0.0006–0.0009 per decision, non-zero and finite). See
  `phase-07-notes.md`. The failure mode has now inverted — with a working key a
  stray live call in a test would pass quietly and bill, where before it failed
  loudly.

Worth generalising for the README: an empty-but-declared secret is invisible to
typecheck, invisible to tests that stub the client, and only fails on the first
live call.

**8. `Rpc` is a global ambient namespace, not a `cloudflare:workers` export.**

`runStubForKey` is generic over the DO class so `keys.ts` never imports the
Durable Object implementation. The constraint needs `Rpc.DurableObjectBranded`,
and the natural spelling — copied from how
`@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts` writes it —

```ts
import type * as Rpc from "cloudflare:workers";   // wrong in app code
```

fails with `Namespace 'CloudflareWorkersModule' has no exported member
'DurableObjectBranded'`. `Rpc` is declared globally at
`worker-configuration.d.ts:12945`; use it with no import at all.

Caught by `pnpm typecheck` only — the whole test suite passed with the broken
import, because vitest strips types. Typecheck is not optional on this phase.

**9. A recursive JSON type cannot cross a Durable Object RPC boundary.**

The obvious shape for opaque payloads —

```ts
type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
```

— compiles fine on its own and fails the moment it appears in an RPC method's
parameter or return type:

```
TS2589: Type instantiation is excessively deep and possibly infinite.
```

workerd's `Rpc.Serializable<T>` machinery walks the type, and a
self-referential union never bottoms out.

The obvious fix is worse. Switching to `unknown` clears TS2589 and then fails
`Rpc.Serializable` silently — the whole return type collapses to `never`, and
the error surfaces somewhere unrelated as `Property 'appended' does not exist
on type 'never'`.

What works is a depth-bounded chain (`JsonScalar` → `JsonDepth1` → `…3`).
Finite, so no TS2589; concrete, so still serializable.

Both failures are invisible to `pnpm test`, because vitest strips types. This
is the second finding this phase that only `pnpm typecheck` catches.

**10. A rejecting RPC method leaves an unhandled rejection inside the object.**

`await expect(stub.setStatus("idle")).rejects.toThrow()` passes, and vitest
still reports `Unhandled Rejection … This might cause false positive tests`.
The rejection is delivered to the caller AND surfaces inside the Durable
Object under pool-workers 0.21.

`RunDO.setStatus` therefore returns a `SetStatusOutcome` discriminated on `ok`
rather than throwing. Phase 10 and 11 want to branch on a refused transition
anyway rather than wrap every call in try/catch. The invariant is unchanged:
`session.setStatus` still throws, and that is where it is unit-tested.

**11. `wrangler types` infers the DO class generic for you.**

Adding the binding produced
`RUNS: DurableObjectNamespace<import("./src/index").SpikeDO>` in the generated
file without being asked. The hand-written `Env` in `src/index.ts` is separate
and still needs its own `RUNS` entry.

---

## Task 8 results

### Automated gate — passing

```
pnpm test                        23 test files, 305 tests, 0 failures
pnpm typecheck                   clean
pnpm exec wrangler deploy --dry-run   env.RUNS (RunDO) resolves
```

Baseline at the start of the phase was 15 files / 82 tests, so Phase 08 added
8 files and 223 tests. No pre-existing test was weakened to accommodate the
new code; the only edit to an existing suite was renaming the `hasLiveRun`
seam to `routeToOwnedRun` in `triage-consumer.test.ts`, in the same commit
that changed it.

No test depends on a `.dev.vars` secret value or reaches Zep or Anthropic.

### Structural criteria — verified by grep, not by assertion

| Criterion | Evidence |
|---|---|
| One `idFromName` call site | `src/run/keys.ts:90`, and nowhere else in `src/` |
| No ticket type in the run layer | `bug\|feature\|question` appears twice in `src/run/`, both in comments explaining its absence. No `type`/`category` field on any run, turn or event; the only `type` is the stream-event discriminant (`turn`/`tool_call`/`status`) and the socket message kind |
| No timers, intervals or alarms | `setInterval\|setTimeout\|setAlarm` — no matches in `src/run/` |
| No `server.accept()` and no socket `addEventListener` | Both appear only in comments warning against them |

### Hibernation evidence

The automated proof is `evictDurableObject()`, used in four places:

- `run-session.test.ts` — state, turns, tool calls and cursor identical across
  eviction, and `seq` continues rather than restarting;
- `run-do.test.ts` — same via the RPC surface, plus the run's storage alarm is
  asserted `null` so nothing holds the object open;
- `run-ws-live.test.ts` — an attached socket hibernated with
  `{ webSockets: "hibernate" }` still receives a later RPC append, still
  accepts a steer (exercising `webSocketMessage` after constructor re-entry),
  and keeps its per-socket cursor so nothing is resent.

### Two tabs against local `wrangler dev` — done 2026-08-12

The automated suite drives the Durable Object stub. This ran against
`wrangler dev` on 8787 with local D1 (all four migrations applied), using the
real HTTP routes and real browser-style `WebSocket`s. 13/13:

| Check | Result |
|---|---|
| `POST /api/runs` → 201, body omits the origin key | keys are `id, origin, status, shadow, summary, channelId, threadTs, createdAt, updatedAt` |
| Two tabs upgrade, both get a complete sync | cursor 1 on both; backlog carries the opening turn |
| Steer from tab A, acked with the committed seq | ack 2 = event seq 2 |
| Both tabs receive **byte-identical** events | `JSON.stringify` equal at seq 2 |
| Refresh tab A with its last cursor | 0 events replayed, cursor still 2 |
| Tab B, left open across the refresh, keeps streaming | seq 3 |
| Unknown run id | `404`, and the socket upgrade is refused |
| Non-WebSocket request to a real run | `426` |
| `GET /api/runs` lists it from D1 | present |

Harness note for whoever repeats this: Node's `fetch` (undici) forbids setting
the `Upgrade` header, so the not-found case is checked without it — the route
resolves the id in D1 before the upgrade, so the `404` is decided first — and
the upgrade refusal is checked with a real `WebSocket` instead.

### Still outstanding — needs a deploy and a human

These three steps cannot be done from a local machine. They are the only parts
of Phase 08 not yet proved:

1. **A real Slack thread in `#test-firedrill`** — post an actionable root
   message, confirm one run row and one triage opening turn, reply, confirm the
   reply enters the same run with no second triage decision.
2. **Deployed Access behaviour** — an authenticated dashboard origin upgrades
   the socket; an unauthenticated `/ws/run/:id` is blocked; `/slack/events`
   still bypasses Access and passes signature verification.
3. **Deployed observability** — confirm an idle connected run is not kept
   active.

Plus one that is not a Phase 08 step but blocks the same deploy:
`wrangler secret put ANTHROPIC_API_KEY`, without which the deployed triage
consumer fails on its first actionable message (see `phase-07-notes.md`).

Deploying is the owner's call, and step 1 posts into a real Slack workspace, so
none of these was done unprompted.
