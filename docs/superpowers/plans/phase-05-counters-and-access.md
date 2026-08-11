# Phase 05 — Counters and the Access Gate

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The four dashboard counters served from a stable API contract, the channel table seeded with real IDs, and the origin behind Cloudflare Access without killing the webhook.

**Depends on:** Phase 04 · **Day 2** · **Gates:** Phases 08, 14

**Docs MCP:** Cloudflare Access — self-hosted applications, **policy ordering**, path-based bypass. Policy ordering is the trap in Task 4, and it fails silently. See `00-roadmap.md` → *Docs / API MCP servers*.

**The step that breaks everything if done wrong:** Access sits in front of the whole origin, and Slack cannot authenticate to it. A gated `/slack/events` silently drops every event — no error, no alert, just an ingest pipeline that goes quiet. Task 4 exists to make that failure impossible to ship unnoticed.

**Global constraints** from `00-roadmap.md` apply.

---

## File Structure

```
apps/worker/src/db/counters.ts        heard / ingested aggregates
apps/worker/src/api/counters.ts       GET /api/counters
apps/worker/src/index.ts              modify: mount the api route
apps/worker/scripts/seed-channels.sh  real channel IDs → policy table
apps/worker/test/counters.test.ts
```

---

## Counter definitions

The four numbers must mean something specific, or the dashboard is decoration.

| counter | definition | phase |
|---|---|---|
| **heard** | envelopes the consumer accepted, before drop rules | 05 |
| **ingested** | rows committed to `messages` | 05 |
| **triaged** | messages a triage decision ran on | 07 |
| **escalated** | approvals created | 11 |

`heard > ingested` is normal and healthy — it is the DM guard and the bot filter doing their job. **`heard == ingested` means the drop filters are not running**, which is a bug worth noticing on the dashboard.

`triaged` and `escalated` return zero from this phase so the dashboard contract is stable from the start; Phases 07 and 11 replace the zeros without changing the shape.

---

### Task 1: Counter aggregates

**Files:** Create `apps/worker/src/db/counters.ts`, `apps/worker/test/counters.test.ts`

**Interfaces:**
- Consumes: the `events_seen` table (Phase 01), `IngestOutcome` semantics (Phase 04)
- Produces: `Counters`, `getCounters(db, sinceMs)` — consumed by Task 2 and Phases 07, 11, 14

- [ ] **Step 1: Write the failing tests**

`apps/worker/test/counters.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getCounters } from "../src/db/counters";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM events_seen"),
    env.DB.prepare("DELETE FROM messages"),
  ]);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO events_seen VALUES (?, ?, ?, ?)").bind("e1", "C1", "ingested", NOW),
    env.DB.prepare("INSERT INTO events_seen VALUES (?, ?, ?, ?)").bind("e2", "C1", "dropped_dm", NOW),
    env.DB.prepare("INSERT INTO events_seen VALUES (?, ?, ?, ?)").bind("e3", "C1", "dropped_bot", NOW),
    // yesterday — must not be counted
    env.DB.prepare("INSERT INTO events_seen VALUES (?, ?, ?, ?)").bind("e4", "C1", "ingested", NOW - DAY - 1),
  ]);
});

describe("getCounters", () => {
  it("counts heard as every envelope seen in the window", async () => {
    const c = await getCounters(env.DB, NOW - DAY);
    expect(c.heard).toBe(3);
  });

  it("counts ingested as the subset that survived the drop rules", async () => {
    const c = await getCounters(env.DB, NOW - DAY);
    expect(c.ingested).toBe(1);
  });

  it("excludes events outside the window", async () => {
    const c = await getCounters(env.DB, NOW - 1000);
    expect(c.heard).toBe(3);
  });

  it("returns zero for counters later phases populate", async () => {
    const c = await getCounters(env.DB, NOW - DAY);
    expect(c.triaged).toBe(0);
    expect(c.escalated).toBe(0);
  });

  it("returns all zeros for an empty window without throwing", async () => {
    const c = await getCounters(env.DB, NOW + DAY);
    expect(c).toEqual({ heard: 0, ingested: 0, triaged: 0, escalated: 0 });
  });
});
```

The empty-window test matters more than it looks: `SUM()` over no rows returns `NULL`, not `0`, and an unguarded implementation puts `null` on the dashboard.

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/worker && pnpm vitest run test/counters.test.ts
```

Expected: FAIL — cannot resolve `../src/db/counters`.

- [ ] **Step 3: Implement**

`apps/worker/src/db/counters.ts`:

```ts
export type Counters = {
  /** Envelopes the consumer accepted, before drop rules. */
  heard: number;
  /** Rows committed to `messages`. `heard > ingested` is healthy. */
  ingested: number;
  /** Populated in Phase 07. */
  triaged: number;
  /** Populated in Phase 11. */
  escalated: number;
};

export async function getCounters(db: D1Database, sinceMs: number): Promise<Counters> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS heard,
         SUM(CASE WHEN outcome = 'ingested' THEN 1 ELSE 0 END) AS ingested
       FROM events_seen
       WHERE received_at >= ?`,
    )
    .bind(sinceMs)
    .first<{ heard: number; ingested: number | null }>();

  return {
    heard: row?.heard ?? 0,
    ingested: row?.ingested ?? 0,
    triaged: 0,
    escalated: 0,
  };
}
```

- [ ] **Step 4: Run to verify pass**

```bash
cd apps/worker && pnpm vitest run test/counters.test.ts
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/db/counters.ts apps/worker/test/counters.test.ts
git commit -m "feat(db): heard and ingested counter aggregates"
```

---

### Task 2: The counters endpoint

**Files:** Create `apps/worker/src/api/counters.ts`; modify `apps/worker/src/index.ts`, `apps/worker/test/counters.test.ts`

**Interfaces:**
- Consumes: `getCounters` (Task 1)
- Produces: `GET /api/counters` → `{ counters: Counters; since: number }` — consumed by Phase 14

- [ ] **Step 1: Write the failing test**

Append to `apps/worker/test/counters.test.ts`, adding `SELF` to the `cloudflare:test` import:

```ts
describe("GET /api/counters", () => {
  it("serves the counters as json", async () => {
    const res = await SELF.fetch("https://example.com/api/counters");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counters: Record<string, number>; since: number };
    expect(Object.keys(body.counters).sort()).toEqual(["escalated", "heard", "ingested", "triaged"]);
    expect(typeof body.since).toBe("number");
  });
});
```

Asserting the exact key set is what keeps the dashboard contract stable while Phases 07 and 11 fill in the zeros.

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/worker && pnpm vitest run test/counters.test.ts
```

Expected: FAIL — the route falls through to the assets handler.

- [ ] **Step 3: Implement**

`apps/worker/src/api/counters.ts`:

```ts
import { Hono } from "hono";
import type { Env } from "../index";
import { getCounters } from "../db/counters";

export const countersApi = new Hono<{ Bindings: Env }>();

countersApi.get("/counters", async (c) => {
  const since = Date.now() - 86_400_000;
  const counters = await getCounters(c.env.DB, since);
  return c.json({ counters, since });
});
```

- [ ] **Step 4: Mount it**

In `apps/worker/src/index.ts`, **above** the catch-all:

```ts
import { countersApi } from "./api/counters";

app.route("/api", countersApi);
```

- [ ] **Step 5: Run the full suite**

```bash
cd apps/worker && pnpm test
```

Expected: 50 passing.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/api/counters.ts apps/worker/src/index.ts apps/worker/test/counters.test.ts
git commit -m "feat(api): counters endpoint with stable four-key contract"
```

---

### Task 3: Seed the channel policy table

**Files:** Create `apps/worker/scripts/seed-channels.sh`

**Interfaces:**
- Consumes: the `channels` table (Phase 01), the policy semantics (Phase 03)
- Produces: real channel IDs mapped to modes

- [ ] **Step 1: Collect the real channel IDs**

In Slack, open each channel → click the channel name → About → the ID is at the bottom (`C…`).

Collect for: every reference customer channel, `#eng-firefighter`, `#test-firedrill`, and any own test channels.

Assign modes by the Phase 03 rules:
- Reference customer channels → `observe`
- Own test channels and `#test-firedrill` → `live`
- `#eng-firefighter` → `internal`

Getting a reference channel's mode wrong is the one mistake in this plan that reaches a real customer. Check each line twice.

- [ ] **Step 2: Write the seed script**

`apps/worker/scripts/seed-channels.sh`, with real IDs substituted from Step 1:

```bash
#!/usr/bin/env bash
# Seed the channel policy table. Re-runnable: INSERT OR REPLACE.
# Reference customer channels MUST be 'observe' — see spec §4.4.
set -euo pipefail
cd "$(dirname "$0")/.."

run() { npx wrangler d1 execute firefighter --remote --command "$1"; }

run "INSERT OR REPLACE INTO channels VALUES ('C_REPLACE_ME_1','pulsefit-zellify','pulsefit','observe');"
run "INSERT OR REPLACE INTO channels VALUES ('C_REPLACE_ME_2','eng-firefighter',NULL,'internal');"
run "INSERT OR REPLACE INTO channels VALUES ('C_REPLACE_ME_3','test-firedrill','firedrill','live');"
```

Substitute every `C_REPLACE_ME_n` before running. Do not commit the file with placeholders still in it.

- [ ] **Step 3: Run it**

```bash
chmod +x apps/worker/scripts/seed-channels.sh
./apps/worker/scripts/seed-channels.sh
```

- [ ] **Step 4: Verify the modes landed correctly**

```bash
cd apps/worker
npx wrangler d1 execute firefighter --remote --command "SELECT channel_id, name, customer_slug, mode FROM channels ORDER BY mode;"
```

Read every row. Confirm no reference channel is `live`.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/scripts/seed-channels.sh
git commit -m "feat(ops): seed channel policy with real slack ids"
```

---

### Task 4: Cloudflare Access, with the webhook bypassed

**Files:** none (operational)

**Interfaces:**
- Produces: the origin gated to `@zellify.app` with ingest still alive

- [ ] **Step 1: Create the Access application**

Cloudflare dashboard → Zero Trust → Access → Applications → Add a self-hosted application, on the Worker's hostname.

- [ ] **Step 2: Add the Bypass as SEPARATE, path-scoped applications**

**Corrected 2026-08-11 — the original wording here was wrong and would have killed ingest.** A policy cannot be scoped to a path. **Path scoping is a property of the application**, and Access matches the *most specific application*, not policies in order within one app. Cloudflare's own example: "some applications have an endpoint under the `/admin` route that must be publicly routable… create an Access application for the domain `test.example.com/admin/<your-url>` and add the Bypass policy."

So build three applications, not one:

| # | Application (hostname + path) | Policy |
|---|---|---|
| 1 | `firefighter.<subdomain>.workers.dev/slack/*` | **Bypass** — Include · Everyone |
| 2 | `firefighter.<subdomain>.workers.dev/oauth/*` | **Bypass** — Include · Everyone |
| 3 | `firefighter.<subdomain>.workers.dev` (all paths) | **Allow** — emails ending `@zellify.app` |

`/oauth/*` is included now because Phase 12 needs it and adding it later means remembering to.

Two consequences of Bypass worth knowing: it enforces **no** Access controls and **does not log** those requests. That is acceptable only because `/slack/events` verifies Slack's `v0` signature itself (Phase 02) — the bypass is not an unguarded hole. Cloudflare recommends Service Auth where you want policy enforcement plus logging; Slack cannot present service tokens, so it does not apply here.

**`workers.dev` can be gated** — the Workers dashboard has a *Domains* tab that puts the `workers.dev` subdomain behind Access. Once the origin moves to a custom domain, re-create these three applications against that hostname; the shape is unchanged.

- [ ] **Step 3: Add the Allow policy**

Policy: **Allow**, emails ending `@zellify.app`, plus your personal email as a **temporary override**.

Record the personal-email override in the README with instructions to remove it after the trial (spec §8.6). It is a deliberate, documented hole; an undocumented one is a finding.

- [ ] **Step 4: Verify from both sides**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://<hostname>/api/counters
# expect 302 → Access login

curl -sS -o /dev/null -w '%{http_code}\n' -X POST -d '{}' https://<hostname>/slack/events
# expect 401 from OUR signature check — NOT 302
```

The second is the one that matters. **A 302 there means the bypass policy is wrong and ingest is dead.**

- [ ] **Step 5: Confirm the dashboard side is actually gated**

Open the hostname in a private window. You should be asked to authenticate, and only the allowed emails should get through.

- [ ] **Step 6: Commit any config notes**

```bash
git add -A
git commit -m "chore(ops): gate origin behind cloudflare access with webhook bypass"
```

---

### Task 5: Verify against live traffic

**Files:** none (operational)

This is the task that turns a passing test suite into a system that is demonstrably hearing Zellify's Slack.

- [ ] **Step 1: Post in your own test channel and check D1**

```bash
cd apps/worker
npx wrangler d1 execute firefighter --remote \
  --command "SELECT event_id, channel_id, user_id, substr(text,1,40) AS text, permalink FROM messages ORDER BY received_at DESC LIMIT 5;"
```

Verify: the row exists, and `permalink` is populated rather than null.

- [ ] **Step 2: Post in a reference channel and confirm it also ingests**

Mode `observe` blocks posting, not hearing. The message must land in `messages` with its `customer_slug` set.

- [ ] **Step 3: Watch for errors**

```bash
npx wrangler tail
```

Post a few more messages. No exceptions, no retries piling up in the DLQ.

- [ ] **Step 4: Check the counters move**

```bash
npx wrangler d1 execute firefighter --remote \
  --command "SELECT outcome, COUNT(*) FROM events_seen GROUP BY outcome;"
```

Confirm `heard` exceeds `ingested` — join/leave and bot noise should be showing up as drops. If they are exactly equal, the drop filters are not running.

- [ ] **Step 5: Leave it running**

Ingest now accumulates real traffic continuously. Every later phase is built against real data rather than fixtures, and Phase 21's eval set starts filling from this moment.

---

## Exit criteria

- [ ] 50 tests passing
- [ ] `/api/counters` returns all four keys behind Access
- [ ] `/slack/events` returns 401 (our check) rather than 302 (Access)
- [ ] Real messages from a test channel are in remote D1 with permalinks
- [ ] Reference-channel messages ingest, with `customer_slug` set
- [ ] `heard > ingested` in the live data
- [ ] The personal-email Access override is written down for later removal
