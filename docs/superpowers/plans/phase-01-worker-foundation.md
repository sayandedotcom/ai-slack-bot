# Phase 01 — Worker Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A deployed Worker at a real URL with D1 migrated, queues created, and a test harness that runs against the actual workerd runtime. Everything after this is built against a live origin.

**Depends on:** nothing · **Day 1** · **Gates:** Phases 02, 03, 12

**Global constraints** from `00-roadmap.md` apply.

---

## File Structure

```
apps/worker/
  package.json
  wrangler.jsonc                bindings: DB, INGEST_QUEUE, ASSETS
  tsconfig.json
  vitest.config.ts
  public/index.html             placeholder until Phase 14 puts the SPA here
  migrations/0001_init.sql      channels, events_seen, messages
  src/index.ts                  Hono router + queue handler — the only entrypoint
  test/setup.ts                 applies D1 migrations before each suite
  test/health.test.ts
```

`apps/web` (the Next 16 scaffold) is left untouched. Decision D2 replaces it with a Vite SPA in Phase 14; deleting it now would break `pnpm build` for no benefit.

---

### Task 1: Create the worker package

**Files:** Create `apps/worker/package.json`

**Interfaces:**
- Produces: the `@workspace/worker` package, linked into the pnpm workspace

- [ ] **Step 1: Create the directory tree**

```bash
cd /home/sayan/Desktop/zellify/firefighter
mkdir -p apps/worker/src apps/worker/test apps/worker/migrations apps/worker/public
```

- [ ] **Step 2: Write `apps/worker/package.json`**

```json
{
  "name": "@workspace/worker",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "cf-typegen": "wrangler types"
  },
  "dependencies": {
    "hono": "^4.9.0"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.9.0",
    "vitest": "^3.2.0",
    "wrangler": "^4.120.0",
    "typescript": "^5"
  }
}
```

- [ ] **Step 3: Install from the repo root**

Workspace linking only resolves correctly from the root:

```bash
cd /home/sayan/Desktop/zellify/firefighter && pnpm install
```

- [ ] **Step 4: Commit**

```bash
git add apps/worker/package.json pnpm-lock.yaml
git commit -m "chore(worker): create worker package"
```

---

### Task 2: Create D1 and write the initial migration

**Files:** Create `apps/worker/migrations/0001_init.sql`

**Interfaces:**
- Produces: tables `channels`, `events_seen`, `messages` — consumed by Phases 03, 04, 05, 06

- [ ] **Step 1: Create the database**

```bash
cd apps/worker
npx wrangler d1 create firefighter
```

Keep the returned `database_id` for Task 3. It is an identifier, not a secret — safe to commit.

- [ ] **Step 2: Write the migration**

`apps/worker/migrations/0001_init.sql`:

```sql
-- Channel posting policy. Fail closed: a channel absent from this table is
-- never postable. See spec §4.4.
CREATE TABLE channels (
  channel_id    TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  customer_slug TEXT,
  mode          TEXT NOT NULL CHECK (mode IN ('observe', 'live', 'internal'))
);

-- Every envelope the queue consumer accepted, whether or not it was ingested.
-- Doubles as the dedupe key and the source of the "heard" counter. See spec §9.
CREATE TABLE events_seen (
  event_id    TEXT PRIMARY KEY,
  channel_id  TEXT,
  outcome     TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE INDEX idx_events_seen_received ON events_seen (received_at);

-- The system of record. Citations resolve through this table, never through
-- string-formatted URLs. See spec §4.2 and decision D4.
CREATE TABLE messages (
  event_id      TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL,
  ts            TEXT NOT NULL,
  thread_ts     TEXT,
  user_id       TEXT,
  text          TEXT NOT NULL,
  subtype       TEXT,
  permalink     TEXT,
  customer_slug TEXT,
  received_at   INTEGER NOT NULL
);

CREATE INDEX idx_messages_channel_ts ON messages (channel_id, ts);
CREATE INDEX idx_messages_thread ON messages (channel_id, thread_ts);
CREATE INDEX idx_messages_received ON messages (received_at);
```

- [ ] **Step 3: Commit**

```bash
git add apps/worker/migrations/0001_init.sql
git commit -m "feat(db): initial schema — channels, events_seen, messages"
```

---

### Task 3: Wrangler config and queues

**Files:** Create `apps/worker/wrangler.jsonc`

**Interfaces:**
- Produces: bindings `DB: D1Database`, `INGEST_QUEUE: Queue`, `ASSETS: Fetcher`

- [ ] **Step 1: Write `apps/worker/wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "firefighter",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "assets": {
    "directory": "./public",
    "binding": "ASSETS"
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "firefighter",
      "database_id": "PASTE_THE_ID_FROM_TASK_2_STEP_1",
      "migrations_dir": "migrations"
    }
  ],
  "queues": {
    "producers": [{ "binding": "INGEST_QUEUE", "queue": "firefighter-ingest" }],
    "consumers": [
      {
        "queue": "firefighter-ingest",
        "max_batch_size": 25,
        "max_batch_timeout": 5,
        "max_retries": 3,
        "dead_letter_queue": "firefighter-ingest-dlq"
      }
    ]
  }
}
```

- [ ] **Step 2: Create both queues**

```bash
cd apps/worker
npx wrangler queues create firefighter-ingest
npx wrangler queues create firefighter-ingest-dlq
```

- [ ] **Step 3: Note why one Worker is both producer and consumer**

This is intentional and supported. The split that matters is request path versus queue path — the webhook must return in under 3 seconds and the consumer has no such limit. Two Workers would buy nothing and cost a deploy.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/wrangler.jsonc
git commit -m "chore(worker): wrangler config with d1, queues, assets"
```

---

### Task 4: TypeScript config and the entrypoint

**Files:** Create `apps/worker/tsconfig.json`, `apps/worker/public/index.html`, `apps/worker/src/index.ts`

**Interfaces:**
- Produces: `Env` type and the Hono `app` — consumed by every later phase

- [ ] **Step 1: Write `apps/worker/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2022",
    "lib": ["es2022"],
    "module": "es2022",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["@cloudflare/workers-types/experimental", "@cloudflare/vitest-pool-workers"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "worker-configuration.d.ts"]
}
```

- [ ] **Step 2: Write the placeholder asset**

`apps/worker/public/index.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>Fire-Fighter</title>
<p>Dashboard lands here in Phase 14.</p>
```

- [ ] **Step 3: Write the entrypoint**

`apps/worker/src/index.ts`:

```ts
import { Hono } from "hono";

export type Env = {
  DB: D1Database;
  INGEST_QUEUE: Queue;
  ASSETS: Fetcher;
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

// The Worker runs first on every request; anything unmatched falls through to
// the static asset bundle. Explicit, rather than relying on route-ordering
// config that later phases would have to keep correct.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    // Phase 04 fills this in.
    void batch;
    void env;
  },
} satisfies ExportedHandler<Env>;
```

Later phases import `Env` with `import type` to avoid a runtime circular import.

- [ ] **Step 4: Generate binding types**

```bash
cd apps/worker && npx wrangler types
```

- [ ] **Step 5: Commit**

```bash
git add apps/worker/tsconfig.json apps/worker/public apps/worker/src/index.ts apps/worker/worker-configuration.d.ts
git commit -m "feat(worker): hono entrypoint with assets fallback and health route"
```

---

### Task 5: Test harness against the real runtime

**Files:** Create `apps/worker/vitest.config.ts`, `apps/worker/test/setup.ts`, `apps/worker/test/health.test.ts`; modify `turbo.json`

**Interfaces:**
- Produces: `pnpm test` running in workerd against real D1 — used by every later phase

- [ ] **Step 1: Write `apps/worker/vitest.config.ts`**

```ts
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

const migrations = await readD1Migrations("./migrations");

export default defineWorkersConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SLACK_SIGNING_SECRET: "test-signing-secret",
            SLACK_BOT_TOKEN: "xoxb-test",
          },
        },
      },
    },
  },
});
```

These are test fixtures, not credentials. Real values never appear in the repo.

- [ ] **Step 2: Write `apps/worker/test/setup.ts`**

```ts
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

- [ ] **Step 3: Write the failing test**

`apps/worker/test/health.test.ts`:

```ts
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("health", () => {
  it("responds ok", async () => {
    const res = await SELF.fetch("https://example.com/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("has the migrated schema", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all<{ name: string }>();
    const names = results.map((r) => r.name);
    expect(names).toContain("channels");
    expect(names).toContain("events_seen");
    expect(names).toContain("messages");
  });
});
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/worker && pnpm test
```

Expected: 2 passing.

If `applyD1Migrations` or `readD1Migrations` is not exported from the installed version, read `node_modules/@cloudflare/vitest-pool-workers/dist/**/*.d.ts` for the current names. Do not guess — this package's exports move between minor versions.

- [ ] **Step 5: Add the turbo test task**

In `turbo.json`, add to `tasks`:

```json
"test": {
  "dependsOn": ["^build"],
  "outputs": []
}
```

- [ ] **Step 6: Commit**

```bash
git add apps/worker/vitest.config.ts apps/worker/test turbo.json
git commit -m "test(worker): vitest pool workers harness with d1 migrations"
```

---

### Task 6: Set secrets and deploy

**Files:** none (operational)

**Interfaces:**
- Produces: a live origin URL that Slack can reach in Phase 02

- [ ] **Step 1: Write local secrets**

```bash
cd apps/worker
printf 'SLACK_SIGNING_SECRET=...\nSLACK_BOT_TOKEN=...\n' > .dev.vars
```

Use the **rotated** signing secret (spec §15 — the originals were pasted into a chat transcript). `.dev.vars` is gitignored as of commit `74383cc`; confirm with `git check-ignore -v apps/worker/.dev.vars` before continuing.

- [ ] **Step 2: Apply migrations remotely**

```bash
npx wrangler d1 migrations apply firefighter --remote
```

- [ ] **Step 3: Put production secrets**

```bash
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN
```

- [ ] **Step 4: Deploy and verify**

```bash
npx wrangler deploy
curl -sS https://firefighter.<subdomain>.workers.dev/api/health
```

Expected: `{"ok":true}`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(worker): first deploy"
```

---

## Exit criteria

- [ ] `pnpm test` passes 2 tests in the workerd runtime
- [ ] `/api/health` returns `{"ok":true}` from the deployed URL
- [ ] Remote D1 has all three tables
- [ ] Both queues exist
- [ ] `git check-ignore` confirms `.dev.vars` is ignored
