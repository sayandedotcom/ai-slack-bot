# Phase 02 — Slack Ingress

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A public endpoint that hears every message in every channel the team is in, verifies it came from Slack, and gets out of the way in under 3 seconds.

**Depends on:** Phase 01 · **Day 1** · **Gates:** Phase 04

**Docs MCP:** Slack Web API — Events API envelopes, the `v0` signature scheme, `message.channels`, and the message subtype list. See `00-roadmap.md` → *Docs / API MCP servers*.

**Why the signature work gets seven tests:** this is the only thing standing between a public URL and anyone injecting fake customer messages into org memory. Memory is durable and shared across shifts, so a poisoned entry outlives the shift that received it.

**Global constraints** from `00-roadmap.md` apply.

---

## File Structure

```
apps/worker/src/slack/verify.ts    signature verification — pure, no I/O
apps/worker/src/slack/types.ts     envelope + event types
apps/worker/src/slack/events.ts    POST /slack/events
apps/worker/test/verify.test.ts
apps/worker/test/events.test.ts
```

---

### Task 1: Signature verification

**Files:** Create `apps/worker/src/slack/verify.ts`, `apps/worker/test/verify.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `verifySlackSignature(opts: { signingSecret: string; signature: string | null; timestamp: string | null; rawBody: string; nowSeconds?: number }): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

`apps/worker/test/verify.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { verifySlackSignature } from "../src/slack/verify";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const BODY = "token=xyz&team_id=T1&command=/test";
const TS = "1531420618";

// Slack's documented algorithm: HMAC-SHA256 over `v0:{timestamp}:{body}`,
// hex-encoded, prefixed with "v0=".
async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `v0=${hex}`;
}

describe("verifySlackSignature", () => {
  it("accepts a correctly signed request", async () => {
    const signature = await sign(SECRET, TS, BODY);
    await expect(
      verifySlackSignature({ signingSecret: SECRET, signature, timestamp: TS, rawBody: BODY, nowSeconds: Number(TS) + 10 }),
    ).resolves.toBe(true);
  });

  it("rejects a tampered body", async () => {
    const signature = await sign(SECRET, TS, BODY);
    await expect(
      verifySlackSignature({ signingSecret: SECRET, signature, timestamp: TS, rawBody: BODY + "&evil=1", nowSeconds: Number(TS) + 10 }),
    ).resolves.toBe(false);
  });

  it("rejects a wrong secret", async () => {
    const signature = await sign("other-secret", TS, BODY);
    await expect(
      verifySlackSignature({ signingSecret: SECRET, signature, timestamp: TS, rawBody: BODY, nowSeconds: Number(TS) + 10 }),
    ).resolves.toBe(false);
  });

  it("rejects a replay older than 300 seconds", async () => {
    const signature = await sign(SECRET, TS, BODY);
    await expect(
      verifySlackSignature({ signingSecret: SECRET, signature, timestamp: TS, rawBody: BODY, nowSeconds: Number(TS) + 301 }),
    ).resolves.toBe(false);
  });

  it("rejects a timestamp too far in the future", async () => {
    const signature = await sign(SECRET, TS, BODY);
    await expect(
      verifySlackSignature({ signingSecret: SECRET, signature, timestamp: TS, rawBody: BODY, nowSeconds: Number(TS) - 301 }),
    ).resolves.toBe(false);
  });

  it("rejects missing headers", async () => {
    await expect(
      verifySlackSignature({ signingSecret: SECRET, signature: null, timestamp: TS, rawBody: BODY }),
    ).resolves.toBe(false);
    await expect(
      verifySlackSignature({ signingSecret: SECRET, signature: "v0=abc", timestamp: null, rawBody: BODY }),
    ).resolves.toBe(false);
  });

  it("rejects a non-numeric timestamp", async () => {
    await expect(
      verifySlackSignature({ signingSecret: SECRET, signature: "v0=abc", timestamp: "not-a-number", rawBody: BODY }),
    ).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/worker && pnpm vitest run test/verify.test.ts
```

Expected: FAIL — cannot resolve `../src/slack/verify`.

- [ ] **Step 3: Implement**

`apps/worker/src/slack/verify.ts`:

```ts
const MAX_SKEW_SECONDS = 300;

/**
 * Constant-time string comparison. Hand-rolled rather than reaching for a
 * platform helper: five lines, no dependency, and no API-surface risk.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifySlackSignature(opts: {
  signingSecret: string;
  signature: string | null;
  timestamp: string | null;
  rawBody: string;
  nowSeconds?: number;
}): Promise<boolean> {
  const { signingSecret, signature, timestamp, rawBody } = opts;
  if (!signature || !timestamp) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_SKEW_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${rawBody}`),
  );

  return timingSafeEqual(`v0=${toHex(mac)}`, signature);
}
```

- [ ] **Step 4: Run to verify pass**

```bash
cd apps/worker && pnpm vitest run test/verify.test.ts
```

Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/slack/verify.ts apps/worker/test/verify.test.ts
git commit -m "feat(slack): verify request signatures with replay window"
```

---

### Task 2: Slack envelope types

**Files:** Create `apps/worker/src/slack/types.ts`

**Interfaces:**
- Produces: `SlackMessageEvent`, `SlackEnvelope`, `QueuedEvent` — consumed by Phases 02 Task 3, 04, 07, 08

- [ ] **Step 1: Write the types**

`apps/worker/src/slack/types.ts`:

```ts
export type SlackMessageEvent = {
  type: string;
  subtype?: string;
  channel: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
};

export type SlackEnvelope =
  | { type: "url_verification"; challenge: string }
  | {
      type: "event_callback";
      event_id: string;
      team_id: string;
      event: SlackMessageEvent;
    };

/** What crosses the queue boundary. Kept minimal and serializable. */
export type QueuedEvent = {
  event_id: string;
  event: SlackMessageEvent;
  received_at: number;
};
```

- [ ] **Step 2: Commit**

```bash
git add apps/worker/src/slack/types.ts
git commit -m "feat(slack): envelope and queued-event types"
```

---

### Task 3: The events endpoint

**Files:** Create `apps/worker/src/slack/events.ts`, `apps/worker/test/events.test.ts`; modify `apps/worker/src/index.ts`

**Interfaces:**
- Consumes: `verifySlackSignature` (Task 1), `QueuedEvent` (Task 2)
- Produces: `slackEvents` Hono sub-app mounted at `/slack`

The test that matters most here asserts the **absence** of work — no D1 write in the request path.

- [ ] **Step 1: Write the failing tests**

`apps/worker/test/events.test.ts`:

```ts
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const SECRET = "test-signing-secret"; // matches vitest.config.ts

async function post(body: unknown, opts: { sign?: boolean; timestamp?: number } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (opts.sign !== false) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${raw}`));
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    headers["x-slack-signature"] = `v0=${hex}`;
  } else {
    headers["x-slack-signature"] = "v0=deadbeef";
  }
  headers["x-slack-request-timestamp"] = ts;

  return SELF.fetch("https://example.com/slack/events", { method: "POST", headers, body: raw });
}

const messageEnvelope = {
  type: "event_callback",
  event_id: "Ev0001",
  team_id: "T1",
  event: { type: "message", channel: "C1", channel_type: "channel", user: "U1", text: "hi", ts: "1.1" },
};

describe("POST /slack/events", () => {
  it("answers a url_verification challenge", async () => {
    const res = await post({ type: "url_verification", challenge: "abc123" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "abc123" });
  });

  it("rejects an unsigned request with 401", async () => {
    const res = await post(messageEnvelope, { sign: false });
    expect(res.status).toBe(401);
  });

  it("accepts a signed message event with 200", async () => {
    const res = await post(messageEnvelope);
    expect(res.status).toBe(200);
  });

  it("writes nothing to D1 in the request path", async () => {
    await post(messageEnvelope);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM events_seen").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("returns 200 for an unknown envelope type rather than erroring", async () => {
    const res = await post({ type: "something_new", event_id: "Ev9", event: {} });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/worker && pnpm vitest run test/events.test.ts
```

Expected: FAIL — `/slack/events` currently falls through to the assets handler.

- [ ] **Step 3: Implement the handler**

`apps/worker/src/slack/events.ts`:

```ts
import { Hono } from "hono";
import type { Env } from "../index";
import { verifySlackSignature } from "./verify";
import type { QueuedEvent, SlackEnvelope } from "./types";

export const slackEvents = new Hono<{ Bindings: Env }>();

/**
 * Slack requires a response within 3 seconds and retries up to three times
 * otherwise. This handler therefore does exactly three things: verify, enqueue,
 * 200. No D1 write, no fetch, no logging round-trip. See spec §4.1.
 */
slackEvents.post("/events", async (c) => {
  const rawBody = await c.req.text();

  const ok = await verifySlackSignature({
    signingSecret: c.env.SLACK_SIGNING_SECRET,
    signature: c.req.header("x-slack-signature") ?? null,
    timestamp: c.req.header("x-slack-request-timestamp") ?? null,
    rawBody,
  });
  if (!ok) return c.text("invalid signature", 401);

  let envelope: SlackEnvelope;
  try {
    envelope = JSON.parse(rawBody) as SlackEnvelope;
  } catch {
    return c.text("bad json", 400);
  }

  if (envelope.type === "url_verification") {
    return c.json({ challenge: envelope.challenge });
  }

  if (envelope.type === "event_callback" && envelope.event?.type === "message") {
    const queued: QueuedEvent = {
      event_id: envelope.event_id,
      event: envelope.event,
      received_at: Date.now(),
    };
    await c.env.INGEST_QUEUE.send(queued);
  }

  // Anything else is acknowledged and ignored. Never 500 at Slack: it retries.
  return c.text("ok", 200);
});
```

- [ ] **Step 4: Mount it**

In `apps/worker/src/index.ts`, **above** the `app.all("*")` catch-all:

```ts
import { slackEvents } from "./slack/events";

app.route("/slack", slackEvents);
```

Order matters — the catch-all swallows everything below it.

- [ ] **Step 5: Run to verify pass**

```bash
cd apps/worker && pnpm test
```

Expected: 14 passing (health 2, verify 7, events 5).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/slack/events.ts apps/worker/src/index.ts apps/worker/test/events.test.ts
git commit -m "feat(slack): events webhook — verify, enqueue, 200 with no request-path io"
```

---

### Task 4: Point Slack at it

**Files:** none (operational)

**Interfaces:**
- Produces: live traffic arriving at the deployed Worker

- [ ] **Step 1: Deploy**

```bash
cd apps/worker && npx wrangler deploy
```

- [ ] **Step 2: Set the Request URL**

Slack app config → Event Subscriptions → Request URL:

```
https://firefighter.<subdomain>.workers.dev/slack/events
```

Slack sends a `url_verification` challenge immediately. It must go green. If it does not, the signing secret in production does not match the app — check `wrangler secret list` and that the **rotated** secret was used.

**Check the "Enable Events" master toggle first.** On 2026-08-11 this cost about an hour: the toggle was **off**, while every downstream setting was correct — verified Request URL, `message.channels` subscribed, socket mode off, scopes granted, bot in channel. Slack dispatches nothing at all when it is off, and *nothing* in `apps.manifest.export` reveals its state, so the config reads as perfect while being inert. Likely cause: the app was created with the placeholder URL `https://my.app.com/slack/action-endpoint`, Slack failed delivery against it and auto-disabled events. **Reinstalling does not clear this** — it is app config, not installation state; two reinstalls changed nothing.

Diagnostic order that would have found it in minutes:

1. `wrangler tail`, and **always send a control request** (`curl .../api/health`) inside the window. Without one you cannot tell "no delivery" from "tail never started" — a transient `Authentication error [code: 10000]` on the tails API silently voided one of our test windows.
2. Post as the bot via `chat.postMessage` rather than by hand. It removes the did-they-post-in-time variable entirely.
3. Bisect public vs private channel. Private channels emit `message.groups`, **not** `message.channels` — `conversations.info` returning `needed: groups:read` is how you identify a private channel without `channels:read`.
4. Only then suspect the URL, scopes, or installation.

`#test-firedrill` is **private**, so `message.groups` is subscribed alongside `message.channels`. This contradicts Step 3 below; `groups:history` was already granted, so it cost no new scope. Revisit if the reference customer channels turn out to be public.

- [ ] **Step 3: Subscribe to the bot event**

Subscribe to `message.channels`. Do **not** add `message.im` or `message.groups` — channels only, and the app should not ask for scopes it will not use.

- [ ] **Step 4: Verify live traffic**

```bash
cd apps/worker && npx wrangler tail
```

Post a message in a test channel. The tail shows the request. Nothing is stored yet — Phase 04 adds the consumer — but the envelope is now reaching the queue.

- [ ] **Step 5: Commit any config notes**

```bash
git add -A
git commit -m "chore(slack): point event subscriptions at the deployed worker"
```

---

## Exit criteria

- [ ] 14 tests passing
- [ ] Slack's Request URL shows verified
- [ ] `wrangler tail` shows real messages arriving from a test channel
- [ ] A request with a bad signature returns 401
- [ ] No D1 row is written by the request path
