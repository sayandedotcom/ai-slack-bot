# `apps/web` Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the one-page Next dashboard into six pages by job — with a three-column Runs workbench — on a neutral Vercel theme with one attention accent, backed by the Worker read endpoints the workbench needs.

**Architecture:** Five commits. (1) Worker: fix the counters contract and add read-only D1 endpoints (run list filters/cursor/spend, per-run approvals and effects, decided approvals, `decidedBy` on 409). (2) Design system: theme vars + Geist in `apps/web`, `StatusBadge` + new primitives in `packages/ui`. (3) `apps/web` shell + `/runs` split view. (4) Overview + `/approvals`. (5) `/team`, `/channels`, `/eval`, ⌘K, docs. Every page keeps the existing `PanelState`/TanStack/Zustand patterns; nothing new is written to D1.

**Tech Stack:** Cloudflare Worker (Hono, D1, `@cloudflare/think` 0.15.1, `agents` 0.20.1), Next.js 16 App Router, React 19, Tailwind v4, shadcn `base-nova` on `@base-ui/react`, TanStack Query 5, Zustand 5, vitest (workerd pool for the Worker, jsdom for `apps/web`), Biome.

**Spec:** `docs/superpowers/specs/2026-08-28-web-redesign-design.md` (D14–D20). Also in force: `docs/superpowers/specs/2026-08-26-nextjs-frontend-design.md` (D1–D13).

## Global Constraints

- **DEPLOY ORDER: Worker first (`workflow_dispatch`), then Vercel.** The new UI reads endpoints and fields that only exist after commit 1 ships; the old UI ignores the new fields, so Worker-first is the only safe order.
- Node 22.20.0, pnpm 10.33.4. **The gate is `pnpm check` at the repo root** (control bytes, Biome, tsc, `capabilities:dts:check`, worker suite). Run it before judging any task; establish the baseline first.
- **Do not `git commit` without asking the user first** (user memory). Each "Commit" step below means: run the checks, then ASK, then commit with the message shown.
- Worker tests run in workerd with SHARED storage across files: mint fresh ids per case (`crypto.randomUUID()`), never assert absolute counts on tables a `beforeEach` did not wipe, never call `reset()`.
- Every new Worker route is D1-only (invariant 7: reads never wake a Durable Object) and behind `requireTeamMember` from `src/api/identity.ts`.
- Money is a decimal STRING from `decimalNanoUsd` (`src/run/money.ts`); the client never calls `Number()` on it.
- `codemode_effects` responses expose `safe_result_json` only — never `args_hash`, never arguments (invariant 39).
- `packages/ui/src/styles/globals.css` is NOT edited for theme colours (D17): both front-ends import it. Theme vars go in `apps/web/app/globals.css`.
- Biome runs once at the root: `pnpm format` (writes) / `pnpm lint` (CI mode). `apps/web` has no `lint` script.
- `apps/worker/worker-configuration.d.ts` and `src/capabilities/generated/capabilities.d.ts` are generated — never hand-edit.
- `test/` mirrors `src/`: `src/api/effects.ts` is pinned by `test/api/effects.test.ts`.
- `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` are written by `next dev` — do not hand-edit.
- Keep the provenance doctrine (D19): `.machine`/`.eyebrow` (mono) for system output, sans for what a person typed, including the agent's draft.
- `apps/web` demo mode (`NEXT_PUBLIC_DEMO=1`) must keep rendering every route from `lib/fixtures` with no backend.

## File Structure

**Worker (`apps/worker`)**
- `src/db/counters.ts` — add `woken`, `dropped` (modify)
- `src/api/counters.ts` — `?window=`, `requireTeamMember` (modify)
- `src/run/repository.ts` — `listRuns` → filters, keyset cursor, spend/turns/openApprovalId (modify)
- `src/api/runs.ts` — query parsing for the new list params, `/runs/:id/approvals`, gate `/runs`, `/runs/:id/usage` (modify)
- `src/api/effects.ts` — NEW: `GET /runs/:id/effects`
- `src/approval/repository.ts` — `listByRun`, `listDecided` (modify)
- `src/api/approvals.ts` — `state=decided&since=`, `decidedBy` on 409, export `publicApprovalCard` (modify)
- `src/api/backfill.ts` — gate (modify)
- `src/notify/blocks.ts` — Review URL path (modify)
- `src/index.ts` — mount `effectsApi` (modify)
- Tests: `test/db/counters.test.ts`, `test/run/repository.test.ts`, `test/api/runs.test.ts`, `test/api/approvals.test.ts`, `test/api/effects.test.ts` (new), `test/notify/blocks.test.ts`, `test/api/backfill.test.ts` (new)

**Vite dashboard (`apps/dashboard`)** — `src/lib/api.ts`, `src/components/counters-panel.tsx` (counters contract only)

**UI package (`packages/ui`)**
- `src/components/status-badge.tsx` — NEW
- shadcn-added: `dialog`, `tabs`, `select`, `switch`, `scroll-area`, `command`, `resizable`, `avatar`, `alert`, `popover`, `collapsible`, `sonner`

**Web (`apps/web`)**
- `app/globals.css`, `app/layout.tsx` — theme + Geist (modify)
- `app/page.tsx` — Overview (rewrite)
- `app/runs/layout.tsx` (NEW: split view), `app/runs/page.tsx` (NEW), `app/runs/[id]/page.tsx` (rewrite)
- `app/approvals/page.tsx`, `app/team/page.tsx`, `app/channels/page.tsx`, `app/eval/page.tsx` — NEW
- `app/chat/` — DELETED
- `lib/api/counters.ts` (rewrite), `lib/api/runs.ts` (modify), `lib/api/approvals.ts` (modify), `lib/api/effects.ts` (NEW), `lib/api/eval.ts` (NEW)
- `lib/runs/filters.ts` — NEW pure filter state
- `lib/status.ts` — NEW domain→tone mapping
- `lib/query/keys.ts` — new keys (modify)
- `lib/hooks/use-dashboard-data.ts` — `useCounters(window)`, `useRunEffects`, `useRunApprovals`, `useDecidedApprovals`, `useTriageScore` (modify); `lib/hooks/use-runs-page.ts` (NEW: infinite query)
- `lib/hooks/use-run-agent.ts` — `cancel` (modify)
- `lib/store/approvals-overlay.ts`, `lib/hooks/use-approvals.ts` — delete reconcile branch (modify)
- `lib/fixtures/*` — new shapes (modify), `lib/fixtures/effects.ts` (NEW), `lib/fixtures/eval.ts` (NEW)
- `components/common/section-header.tsx` (NEW), `components/common/status-chip.tsx` (DELETE after Task 7), `components/common/command-palette.tsx` (NEW)
- `components/shell/app-sidebar.tsx`, `site-header.tsx` (modify)
- `components/runs/run-row.tsx`, `run-list.tsx`, `run-filters.tsx`, `run-inspector.tsx`, `new-run-dialog.tsx` — NEW
- `components/run/run-view.tsx`, `transcript.tsx`, `run-session.tsx`, `run-panel.tsx` — chip strip + cancel (modify)
- `components/dashboard/funnel-strip.tsx` (rewrite), `attention-row.tsx` (NEW), `decided-list.tsx` (NEW), `runs-feed.tsx` + `run-sheet.tsx` (DELETE), `approvals-queue.tsx` (modify)
- `components/eval/triage-score.tsx` — NEW
- `BACKEND-GAPS.md` — close §6, §9, §10

---

## Part 1 — Worker API (commit 1)

### Task 1: Real `woken`/`dropped` counters and a `window` parameter

**Files:**
- Modify: `apps/worker/src/db/counters.ts`
- Modify: `apps/worker/src/api/counters.ts`
- Modify: `apps/worker/test/db/counters.test.ts`
- Modify: `apps/dashboard/src/lib/api.ts:89-97`, `apps/dashboard/src/components/counters-panel.tsx`

**Interfaces:**
- Produces: `Counters = { heard; ingested; triaged; woken; dropped; escalated }` from `getCounters(db, sinceMs)`; `GET /api/counters?window=24h|7d` → `{ counters, since, window }`; `400 invalid_window` otherwise; `401/403` via `requireTeamMember`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/test/db/counters.test.ts` inside `describe("getCounters")`:

```ts
  it("counts woken as the triage decisions that said wake, and dropped as the rest", async () => {
    await env.DB.prepare(
      `INSERT INTO triage_decisions (event_id, wake, why, opening_prompt, model, cost_usd, latency_ms, created_at)
       VALUES ('EvW1', 1, 'q', 'p', 'claude-haiku-4-5', 0.0003, 400, ?),
              ('EvW2', 0, 'banter', '', 'claude-haiku-4-5', 0.0002, 300, ?),
              ('EvW3', 0, 'banter', '', 'claude-haiku-4-5', 0.0002, 300, ?)`
    )
      .bind(NOW, NOW, NOW)
      .run();
    const c = await getCounters(env.DB, NOW - DAY);
    expect(c.triaged).toBe(3);
    expect(c.woken).toBe(1);
    expect(c.dropped).toBe(2);
  });
```

Replace the existing `"returns all zeros for an empty window without throwing"` expectation with:

```ts
    expect(c).toEqual({
      heard: 0,
      ingested: 0,
      triaged: 0,
      woken: 0,
      dropped: 0,
      escalated: 0,
    });
```

Replace the whole `describe("GET /api/counters")` block with (the route is now gated, so the test needs the fake verifier the other API suites use):

```ts
import {
  type AccessIdentity,
  AccessJwtError,
  type AccessVerifier,
} from "../../src/access/jwt";
import {
  installIdentityApiPorts,
  resetIdentityApiPorts,
} from "../../src/api/identity";

function fakeVerifier(): AccessVerifier {
  return {
    async verify(jwt: string): Promise<AccessIdentity> {
      if (!jwt) throw new AccessJwtError("missing", "no token was supplied");
      if (!jwt.includes("@"))
        throw new AccessJwtError("malformed", "not an email-shaped token");
      return { email: jwt };
    },
  };
}

describe("GET /api/counters", () => {
  beforeEach(() => {
    resetIdentityApiPorts();
    installIdentityApiPorts({ verifier: fakeVerifier() });
  });

  const read = (query = "") =>
    SELF.fetch(`https://example.com/api/counters${query}`, {
      headers: { "Cf-Access-Jwt-Assertion": "ronit@zellify.app" },
    });

  it("serves the six counters as json, defaulting to a 24h window", async () => {
    const res = await read();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counters: Record<string, number>;
      since: number;
      window: string;
    };
    expect(Object.keys(body.counters).sort()).toEqual([
      "dropped",
      "escalated",
      "heard",
      "ingested",
      "triaged",
      "woken",
    ]);
    expect(body.window).toBe("24h");
    expect(Date.now() - body.since).toBeGreaterThan(86_400_000 - 5_000);
  });

  it("accepts window=7d", async () => {
    const res = await read("?window=7d");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { since: number; window: string };
    expect(body.window).toBe("7d");
    expect(Date.now() - body.since).toBeGreaterThan(7 * 86_400_000 - 5_000);
  });

  it("refuses an unknown window", async () => {
    const res = await read("?window=1y");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_window");
  });

  it("is gated like every other dashboard read", async () => {
    const res = await SELF.fetch("https://example.com/api/counters");
    expect(res.status).toBe(401);
  });
});
```

(Add the two imports at the top of the file with the existing ones.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/worker && npx vitest run test/db/counters.test.ts`
Expected: FAIL — `woken` undefined, keys mismatch, 200 where 401 expected.

- [ ] **Step 3: Implement `getCounters`**

Replace `apps/worker/src/db/counters.ts` `Counters` type and the triage query:

```ts
export type Counters = {
  /** Envelopes the consumer accepted, before drop rules. */
  heard: number;
  /** Rows committed to `messages`. `heard > ingested` is healthy. */
  ingested: number;
  /** Triage decisions stored in the window — wakes and non-wakes alike. */
  triaged: number;
  /** Triage decisions that said `wake = 1`: threads the main model worked on. */
  woken: number;
  /** `triaged - woken`, computed here so no client ever derives it from a missing field. */
  dropped: number;
  /** `approvals` rows opened in the window — every escalation, any decision. */
  escalated: number;
};
```

```ts
  const triagedRow = await db
    .prepare(
      `SELECT COUNT(*) AS triaged,
              SUM(CASE WHEN wake = 1 THEN 1 ELSE 0 END) AS woken
       FROM triage_decisions WHERE created_at >= ?`
    )
    .bind(sinceMs)
    .first<{ triaged: number; woken: number | null }>();
```

and the return:

```ts
  const triaged = triagedRow?.triaged ?? 0;
  const woken = triagedRow?.woken ?? 0;
  return {
    heard: row?.heard ?? 0,
    ingested: row?.ingested ?? 0,
    triaged,
    woken,
    dropped: Math.max(0, triaged - woken),
    escalated: escalatedRow?.escalated ?? 0,
  };
```

- [ ] **Step 4: Implement the route**

Replace `apps/worker/src/api/counters.ts`:

```ts
import { Hono } from "hono";
import { getCounters } from "../db/counters";
import type { Env } from "../index";
import { requireTeamMember } from "./identity";

export const countersApi = new Hono<{ Bindings: Env }>();

/** The two windows the dashboard offers. Anything else is a 400, not a guess. */
const WINDOWS = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
} as const;
type Window = keyof typeof WINDOWS;

function isWindow(value: string): value is Window {
  return Object.hasOwn(WINDOWS, value);
}

countersApi.get("/counters", async (c) => {
  const member = await requireTeamMember(c);
  if (member instanceof Response) return member;

  const windowParam = c.req.query("window") ?? "24h";
  if (!isWindow(windowParam)) {
    return c.json(
      { code: "invalid_window", message: "window must be 24h or 7d" },
      400
    );
  }

  const since = Date.now() - WINDOWS[windowParam];
  const counters = await getCounters(c.env.DB, since);
  return c.json({ counters, since, window: windowParam });
});
```

- [ ] **Step 5: Fix the Vite dashboard's copy of the contract**

`apps/dashboard/src/lib/api.ts` — replace the `Counters` type:

```ts
export type Counters = {
  counters: {
    heard: number;
    ingested: number;
    triaged: number;
    woken: number;
    dropped: number;
    escalated: number;
  };
  since: number;
  window: "24h" | "7d";
};
```

`apps/dashboard/src/components/counters-panel.tsx` — replace `TILES`:

```ts
const TILES: { key: keyof Counters["counters"]; label: string }[] = [
  { key: "heard", label: "heard" },
  { key: "triaged", label: "triaged" },
  { key: "woken", label: "woken" },
  { key: "escalated", label: "escalated" },
];
```

- [ ] **Step 6: Run the tests and both typechecks**

Run: `cd apps/worker && npx vitest run test/db/counters.test.ts && pnpm typecheck && cd ../dashboard && pnpm typecheck && pnpm test`
Expected: all PASS.

### Task 2: `GET /api/runs` — filters, keyset cursor, spend, turns, open approval

**Files:**
- Modify: `apps/worker/src/run/repository.ts` (`RunListItem`, `listRuns`)
- Modify: `apps/worker/src/api/runs.ts` (`/runs`, `/runs/:id/usage`)
- Modify: `apps/worker/test/run/repository.test.ts`
- Modify: `apps/worker/test/api/runs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RunListFilters = {
    status?: RunStatus; origin?: RunOrigin; channelId?: string; shadow?: boolean;
    q?: string; cursor?: string; limit?: number;
  };
  export type RunListPage = { runs: RunListItem[]; nextCursor: string | null };
  export async function listRuns(db, filters: RunListFilters): Promise<RunListPage>;
  export function encodeRunCursor(item: { updatedAt: number; id: string }): string; // `${updatedAt}_${id}`
  export function decodeRunCursor(raw: string): { updatedAt: number; id: string } | null;
  ```
  `RunListItem` gains `costUsd: string`, `turns: number`, `openApprovalId: string | null`.
  Route: `GET /api/runs?status&origin&channelId&shadow=true|false&q&cursor&limit` → `{ runs, nextCursor }`; `400 invalid_origin | invalid_shadow | invalid_cursor | invalid_q` (q > 200 chars).

- [ ] **Step 1: Write the failing repository tests**

In `apps/worker/test/run/repository.test.ts`, every existing `listRuns(...)` call returns a page now; change `await listRuns(env.DB, {})` to `(await listRuns(env.DB, {})).runs` (5 call sites in `describe("listRuns")`, plus the empty-table case becomes `expect((await listRuns(env.DB, {})).runs).toEqual([])`). Then append inside `describe("listRuns")`:

```ts
  async function seedModelCall(runId: string, turnId: string, nano: number) {
    await env.DB.prepare(
      `INSERT INTO agent_model_calls
        (id, run_id, generation_id, agent_turn_id, attempt, step_index, provider, model,
         input_tokens, no_cache_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
         reasoning_tokens, total_tokens, cost_nano_usd, latency_ms, created_at)
       VALUES (?, ?, 'gen:1', ?, 0, 0, 'anthropic', 'claude-fable-5',
               10, 10, 0, 0, 5, 0, 15, ?, 100, 1)`
    )
      .bind(`usage:${crypto.randomUUID()}`, runId, turnId, nano)
      .run();
  }

  it("carries spend as a decimal string, a distinct-turn count, and the open approval", async () => {
    const run = await createOrGetRun(env.DB, slackDescriptor());
    await seedModelCall(run.id, "turn:a", 1_500_000_000);
    await seedModelCall(run.id, "turn:a", 500_000_000);
    await seedModelCall(run.id, "turn:b", 1);
    await env.DB.prepare(
      `INSERT INTO approvals
         (id, run_id, generation_id, kind, draft, why, channel_id, thread_ts, created_at, updated_at)
       VALUES ('apr:list-1', ?, 'gen:1', 'slack_reply', 'd', 'w', 'C1', '1', 1, 1)`
    )
      .bind(run.id)
      .run();

    const [item] = (await listRuns(env.DB, {})).runs;
    expect(item.costUsd).toBe("2.000000001");
    expect(item.turns).toBe(2);
    expect(item.openApprovalId).toBe("apr:list-1");
  });

  it("reports zero spend and no approval for a run that has neither", async () => {
    await createOrGetRun(env.DB, chatDescriptor());
    const [item] = (await listRuns(env.DB, {})).runs;
    expect(item.costUsd).toBe("0.000000000");
    expect(item.turns).toBe(0);
    expect(item.openApprovalId).toBeNull();
  });

  it("filters by origin, channel and shadow", async () => {
    const slack = await createOrGetRun(env.DB, slackDescriptor());
    const chat = await createOrGetRun(env.DB, chatDescriptor());
    await env.DB.prepare("UPDATE runs SET shadow = 1 WHERE id = ?")
      .bind(chat.id)
      .run();

    expect((await listRuns(env.DB, { origin: "chat" })).runs.map((r) => r.id)).toEqual([chat.id]);
    expect((await listRuns(env.DB, { channelId: "C1" })).runs.map((r) => r.id)).toEqual([slack.id]);
    expect((await listRuns(env.DB, { shadow: true })).runs.map((r) => r.id)).toEqual([chat.id]);
    expect((await listRuns(env.DB, { shadow: false })).runs.map((r) => r.id)).toEqual([slack.id]);
  });

  it("searches summary, channel name and id prefix", async () => {
    const slack = await createOrGetRun(env.DB, slackDescriptor());
    const chat = await createOrGetRun(env.DB, chatDescriptor());
    await env.DB.prepare("UPDATE runs SET summary = ? WHERE id = ?")
      .bind("checkout button does nothing on Android", chat.id)
      .run();

    expect((await listRuns(env.DB, { q: "android" })).runs.map((r) => r.id)).toEqual([chat.id]);
    expect((await listRuns(env.DB, { q: "pulsefit-eng" })).runs.map((r) => r.id)).toEqual([slack.id]);
    expect((await listRuns(env.DB, { q: slack.id.slice(0, 8) })).runs.map((r) => r.id)).toEqual([slack.id]);
    // `%` is a literal, not a wildcard.
    expect((await listRuns(env.DB, { q: "%" })).runs).toEqual([]);
  });

  it("pages with a keyset cursor and never repeats or skips a row", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const run = await createOrGetRun(env.DB, slackDescriptor(`172000000${i}.000001`));
      // Two rows share an updated_at so the (updated_at, id) tiebreak is exercised.
      await touchRun(env.DB, run.id, i < 2 ? 1_000 : 1_000 + i);
      ids.push(run.id);
    }

    const first = await listRuns(env.DB, { limit: 2 });
    expect(first.runs).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await listRuns(env.DB, { limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.runs).toHaveLength(2);
    const third = await listRuns(env.DB, { limit: 2, cursor: second.nextCursor ?? undefined });
    expect(third.runs).toHaveLength(1);
    expect(third.nextCursor).toBeNull();

    const seen = [...first.runs, ...second.runs, ...third.runs].map((r) => r.id);
    expect(new Set(seen).size).toBe(5);
    expect(seen.sort()).toEqual([...ids].sort());
  });

  it("round-trips a cursor and rejects a malformed one", async () => {
    expect(decodeRunCursor(encodeRunCursor({ updatedAt: 42, id: "abc" }))).toEqual({ updatedAt: 42, id: "abc" });
    expect(decodeRunCursor("nonsense")).toBeNull();
    expect(decodeRunCursor("x_abc")).toBeNull();
  });
```

Add `decodeRunCursor, encodeRunCursor` to the import list from `../../src/run/repository`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/worker && npx vitest run test/run/repository.test.ts -t listRuns`
Expected: FAIL — `.runs` undefined on an array, missing exports.

- [ ] **Step 3: Implement `listRuns`**

In `apps/worker/src/run/repository.ts`, extend `RunListItem`:

```ts
export type RunListItem = {
  id: string;
  origin: RunOrigin;
  status: RunStatus;
  shadow: boolean;
  summary: string | null;
  channelId: string | null;
  channelName: string | null;
  customerSlug: string | null;
  createdAt: number;
  updatedAt: number;
  /** Decimal USD from the model-call ledger (invariant 29). "0.000000000" for a run that has not billed. */
  costUsd: string;
  /** Distinct `agent_turn_id`s billed — how many times the model was woken on this run. */
  turns: number;
  /** The one pending approval (idx_approvals_one_open), or null. */
  openApprovalId: string | null;
};

export type RunListFilters = {
  status?: RunStatus;
  origin?: RunOrigin;
  channelId?: string;
  shadow?: boolean;
  /** Case-insensitive substring over summary and channel name; prefix over id. */
  q?: string;
  cursor?: string;
  limit?: number;
};

export type RunListPage = { runs: RunListItem[]; nextCursor: string | null };

/** `${updatedAt}_${id}`: ids are uuids, which never contain `_`. Opaque to the client. */
export function encodeRunCursor(item: { updatedAt: number; id: string }): string {
  return `${item.updatedAt}_${item.id}`;
}

export function decodeRunCursor(
  raw: string
): { updatedAt: number; id: string } | null {
  const at = raw.indexOf("_");
  if (at <= 0 || at === raw.length - 1) return null;
  const updatedAt = Number(raw.slice(0, at));
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) return null;
  return { updatedAt, id: raw.slice(at + 1) };
}

/** LIKE treats `%` and `_` as wildcards; a search for "50%_off" must not become "match anything". */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
```

Replace the `listRuns` function (add `import { decimalNanoUsd } from "./money";` at the top):

```ts
export async function listRuns(
  db: D1Database,
  filters: RunListFilters
): Promise<RunListPage> {
  const limit = Math.min(
    Math.max(1, Math.floor(filters.limit ?? RUN_LIST_DEFAULT_LIMIT)),
    RUN_LIST_MAX_LIMIT
  );

  const where: string[] = [];
  const bindings: (string | number)[] = [];

  if (filters.status) {
    where.push("r.status = ?");
    bindings.push(filters.status);
  }
  if (filters.origin) {
    where.push("r.origin = ?");
    bindings.push(filters.origin);
  }
  if (filters.channelId) {
    where.push("r.channel_id = ?");
    bindings.push(filters.channelId);
  }
  if (filters.shadow !== undefined) {
    where.push("r.shadow = ?");
    bindings.push(filters.shadow ? 1 : 0);
  }
  if (filters.q) {
    const like = `%${escapeLike(filters.q)}%`;
    const prefix = `${escapeLike(filters.q)}%`;
    where.push(
      `(r.summary LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR r.id LIKE ? ESCAPE '\\')`
    );
    bindings.push(like, like, prefix);
  }
  if (filters.cursor) {
    const cursor = decodeRunCursor(filters.cursor);
    if (cursor) {
      where.push("(r.updated_at < ? OR (r.updated_at = ? AND r.id < ?))");
      bindings.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
  }

  const { results } = await db
    .prepare(
      `SELECT r.id, r.origin, r.status, r.shadow, r.summary, r.channel_id,
              c.name AS channel_name, c.customer_slug, r.created_at, r.updated_at,
              COALESCE(u.cost_nano_usd, 0) AS cost_nano_usd,
              COALESCE(u.turns, 0) AS turns,
              a.id AS open_approval_id
       FROM runs r
       LEFT JOIN channels c ON c.channel_id = r.channel_id
       LEFT JOIN (
         SELECT run_id, SUM(cost_nano_usd) AS cost_nano_usd,
                COUNT(DISTINCT agent_turn_id) AS turns
         FROM agent_model_calls GROUP BY run_id
       ) u ON u.run_id = r.id
       LEFT JOIN approvals a ON a.run_id = r.id AND a.decision = 'pending'
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY r.updated_at DESC, r.id DESC
       LIMIT ?`
    )
    .bind(...bindings, limit + 1)
    .all<
      Pick<
        RunsRow,
        | "id" | "origin" | "status" | "shadow" | "summary"
        | "channel_id" | "created_at" | "updated_at"
      > & {
        channel_name: ChannelsRow["name"] | null;
        customer_slug: ChannelsRow["customer_slug"];
        cost_nano_usd: number;
        turns: number;
        open_approval_id: string | null;
      }
    >();

  const rows = results ?? [];
  const page = rows.slice(0, limit);
  const runs = page.map((row) => ({
    id: row.id,
    origin: row.origin,
    status: row.status,
    shadow: row.shadow === 1,
    summary: row.summary,
    channelId: row.channel_id,
    channelName: row.channel_name,
    customerSlug: row.customer_slug,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    costUsd: decimalNanoUsd(row.cost_nano_usd),
    turns: row.turns,
    openApprovalId: row.open_approval_id,
  }));
  const last = runs[runs.length - 1];
  return {
    runs,
    nextCursor: rows.length > limit && last ? encodeRunCursor(last) : null,
  };
}
```

- [ ] **Step 4: Run repository tests**

Run: `cd apps/worker && npx vitest run test/run/repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing route tests**

Append to `apps/worker/test/api/runs.test.ts`:

```ts
describe("GET /api/runs (list)", () => {
  const list = (query = "", token = FIREFIGHTER) =>
    SELF.fetch(`https://firefighter.test/api/runs${query}`, {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });

  it("is gated", async () => {
    expect((await SELF.fetch("https://firefighter.test/api/runs")).status).toBe(401);
    expect((await list("", OUTSIDER)).status).toBe(403);
  });

  it("answers a page with a nextCursor field and the new per-row columns", async () => {
    const created = await create(
      { firstMessage: "list me", clientRequestId: crypto.randomUUID() },
      FIREFIGHTER
    );
    const { id } = await created.json<{ id: string }>();
    const res = await list(`?q=${id.slice(0, 8)}`);
    expect(res.status).toBe(200);
    const body = await res.json<{
      runs: { id: string; costUsd: string; turns: number; openApprovalId: string | null }[];
      nextCursor: string | null;
    }>();
    expect(body.runs.map((r) => r.id)).toContain(id);
    const row = body.runs.find((r) => r.id === id);
    expect(typeof row?.costUsd).toBe("string");
    expect(row?.turns).toBeGreaterThanOrEqual(0);
    expect("openApprovalId" in (row ?? {})).toBe(true);
    expect("nextCursor" in body).toBe(true);
  });

  it("refuses bad filters with a code", async () => {
    expect(((await (await list("?origin=email")).json()) as { code: string }).code).toBe("invalid_origin");
    expect(((await (await list("?shadow=maybe")).json()) as { code: string }).code).toBe("invalid_shadow");
    expect(((await (await list("?cursor=nope")).json()) as { code: string }).code).toBe("invalid_cursor");
    expect(((await (await list(`?q=${"x".repeat(201)}`)).json()) as { code: string }).code).toBe("invalid_q");
  });

  it("gates the usage read too", async () => {
    const created = await create(
      { firstMessage: "usage", clientRequestId: crypto.randomUUID() },
      FIREFIGHTER
    );
    const { id } = await created.json<{ id: string }>();
    expect((await SELF.fetch(`https://firefighter.test/api/runs/${id}/usage`)).status).toBe(401);
    expect((await read(`${id}/usage`, FIREFIGHTER)).status).toBe(200);
  });
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `cd apps/worker && npx vitest run test/api/runs.test.ts -t "list"`
Expected: FAIL (200 instead of 401; missing fields).

- [ ] **Step 7: Implement the route**

In `apps/worker/src/api/runs.ts`, add imports `import { isRunOrigin } from "../run/keys";` — check `src/run/keys.ts` exports `RunOrigin`; if there is no `isRunOrigin`, add to `keys.ts`:

```ts
export const RUN_ORIGINS = ["slack", "chat"] as const;
export function isRunOrigin(value: unknown): value is RunOrigin {
  return (RUN_ORIGINS as readonly unknown[]).includes(value);
}
```

(Read `keys.ts` first: `RunOrigin` may be declared as a literal union — keep it as the source of truth and derive `RUN_ORIGINS` to match its members exactly.)

Replace the `runsApi.get("/runs", ...)` handler:

```ts
const RUN_SEARCH_MAX_CHARS = 200;

runsApi.get("/runs", async (c) => {
  const member = await requireTeamMember(c);
  if (member instanceof Response) return member;

  const statusParam = c.req.query("status");
  let status: RunStatus | undefined;
  if (statusParam !== undefined) {
    if (!isRunStatus(statusParam)) {
      return c.json(fail("invalid_status", "unknown run status"), 400);
    }
    status = statusParam;
  }

  const originParam = c.req.query("origin");
  if (originParam !== undefined && !isRunOrigin(originParam)) {
    return c.json(fail("invalid_origin", "origin must be slack or chat"), 400);
  }

  const shadowParam = c.req.query("shadow");
  let shadow: boolean | undefined;
  if (shadowParam !== undefined) {
    if (shadowParam !== "true" && shadowParam !== "false") {
      return c.json(fail("invalid_shadow", "shadow must be true or false"), 400);
    }
    shadow = shadowParam === "true";
  }

  const q = c.req.query("q")?.trim();
  if (q !== undefined && q.length > RUN_SEARCH_MAX_CHARS) {
    return c.json(fail("invalid_q", `q must be at most ${RUN_SEARCH_MAX_CHARS} characters`), 400);
  }

  const cursor = c.req.query("cursor");
  if (cursor !== undefined && decodeRunCursor(cursor) === null) {
    return c.json(fail("invalid_cursor", "cursor is not one this endpoint issued"), 400);
  }

  const limitParam = c.req.query("limit");
  let limit: number | undefined;
  if (limitParam !== undefined) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > RUN_LIST_MAX_LIMIT) {
      return c.json(fail("invalid_limit", `limit must be 1..${RUN_LIST_MAX_LIMIT}`), 400);
    }
    limit = parsed;
  }

  const page = await listRuns(c.env.DB, {
    status,
    origin: originParam,
    channelId: c.req.query("channelId") || undefined,
    shadow,
    q: q || undefined,
    cursor,
    limit,
  });
  return c.json(page);
});
```

Add `decodeRunCursor` to the import from `../run/repository`. Add the gate to `/runs/:id/usage`:

```ts
runsApi.get("/runs/:id/usage", async (c) => {
  const member = await requireTeamMember(c);
  if (member instanceof Response) return member;
  const run = await getRunById(c.env.DB, c.req.param("id"));
  ...
```

- [ ] **Step 8: Run the API tests and typecheck**

Run: `cd apps/worker && npx vitest run test/api/runs.test.ts && pnpm typecheck`
Expected: PASS. Also grep for other `listRuns(` callers (`grep -rn "listRuns(" src`) — only the route should remain.

### Task 3: Per-run approval history, decided approvals, `decidedBy` on 409

**Files:**
- Modify: `apps/worker/src/approval/repository.ts` (add `listByRun`, `listDecided`)
- Modify: `apps/worker/src/api/approvals.ts` (export `publicApprovalCard`; `state=decided&since=`; 409 body)
- Modify: `apps/worker/src/api/runs.ts` (`GET /runs/:id/approvals`)
- Modify: `apps/worker/test/api/approvals.test.ts`, `apps/worker/test/api/runs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function listByRun(db, runId: string): Promise<ApprovalRow[]>;            // created_at ASC
  export async function listDecided(db, sinceMs: number, limit = 50): Promise<ApprovalRow[]>; // decision <> 'pending', updated_at >= since, updated_at DESC
  export function publicApprovalCard(row: ApprovalRow): {...}                           // now exported
  ```
  Routes: `GET /api/approvals?state=open` (unchanged); `GET /api/approvals?state=decided&since=<ms>` → `{ approvals: card[] }` (`since` default now−24h, `400 invalid_since` if not a non-negative integer); `GET /api/runs/:id/approvals` → `{ approvals: card[] }` (`404 not_found` for an unknown run); `PATCH` 409 body → `{ code, message, decision, decidedBy }`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/test/api/approvals.test.ts`. The file already has `fakeVerifier()`, `recordingNotifier()`, `seedRun(): Promise<{ runId; key }>` (no arguments — it mints a chat run), `card(runId, overrides?)`, `FIREFIGHTER = "ronit@zellify.app"`, `VIEWER = "marcus@zellify.app"`, and `installApprovalApiPorts` — use those, do not add new seeders:

```ts
describe("history reads", () => {
  const get = (path: string, who = VIEWER) =>
    SELF.fetch(`https://firefighter.test${path}`, {
      headers: { "Cf-Access-Jwt-Assertion": who },
    });

  beforeEach(() => {
    installApprovalApiPorts({ verifier: fakeVerifier(), notifier: recordingNotifier() });
  });

  it("lists a run's approvals oldest first, every decision included", async () => {
    const { runId } = await seedRun();
    const first = card(runId, { now: 1_000 });
    await insertApproval(env.DB, first);
    await env.DB.prepare(
      "UPDATE approvals SET decision = 'approved', decided_by = ?, decided_at = 2000, updated_at = 2000 WHERE id = ?"
    )
      .bind(FIREFIGHTER, first.id)
      .run();
    const second = card(runId, { now: 3_000 });
    await insertApproval(env.DB, second);

    const res = await get(`/api/runs/${runId}/approvals`);
    expect(res.status).toBe(200);
    const body = await res.json<{
      approvals: { id: string; decision: string; decidedBy: string | null }[];
    }>();
    expect(body.approvals.map((a) => a.id)).toEqual([first.id, second.id]);
    expect(body.approvals[0].decision).toBe("approved");
    expect(body.approvals[0].decidedBy).toBe(FIREFIGHTER);
  });

  it("404s a run that does not exist", async () => {
    expect((await get("/api/runs/nope/approvals")).status).toBe(404);
  });

  it("lists decided approvals newest first within the window", async () => {
    const now = Date.now();
    const a = (await seedRun()).runId;
    const b = (await seedRun()).runId;
    const c = (await seedRun()).runId;
    const old = card(a, { now: now - 3 * 86_400_000 });
    const recent = card(b, { now: now - 3_600_000 });
    const open = card(c, { now });
    await insertApproval(env.DB, old);
    await insertApproval(env.DB, recent);
    await insertApproval(env.DB, open);
    await env.DB.prepare(
      "UPDATE approvals SET decision = 'rejected', reject_reason = 'no', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?"
    )
      .bind(FIREFIGHTER, old.now, old.now, old.id)
      .run();
    await env.DB.prepare(
      "UPDATE approvals SET decision = 'edited', edited_text = 'x', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?"
    )
      .bind(FIREFIGHTER, recent.now, recent.now, recent.id)
      .run();

    const day = await get("/api/approvals?state=decided");
    expect(day.status).toBe(200);
    expect((await day.json<{ approvals: { id: string }[] }>()).approvals.map((x) => x.id)).toEqual([recent.id]);

    const week = await get(`/api/approvals?state=decided&since=${now - 7 * 86_400_000}`);
    expect((await week.json<{ approvals: { id: string }[] }>()).approvals.map((x) => x.id)).toEqual([recent.id, old.id]);

    expect((await get("/api/approvals?state=decided&since=yesterday")).status).toBe(400);
  });

  it("names the winner in the 409 body", async () => {
    const { runId } = await seedRun();
    const c = card(runId);
    await insertApproval(env.DB, c);
    const patch = (who: string) =>
      SELF.fetch(`https://firefighter.test/api/approvals/${c.id}`, {
        method: "PATCH",
        headers: { "Cf-Access-Jwt-Assertion": who, "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      });
    expect((await patch(FIREFIGHTER)).status).toBe(200);
    const lost = await patch("luka@zellify.app");
    expect(lost.status).toBe(409);
    const body = await lost.json<{ decision: string; decidedBy: string | null }>();
    expect(body.decision).toBe("approved");
    expect(body.decidedBy).toBe(FIREFIGHTER);
  });
});
```

(`luka@zellify.app` must be a fire-fighter in `src/access/roster.ts`; if not, pick another roster fire-fighter. The `beforeEach` at the top of the file wipes `runs`/`approvals`, so the "decided" window assertions are exact.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/worker && npx vitest run test/api/approvals.test.ts -t "history reads"`
Expected: FAIL (404s, `decidedBy` undefined).

- [ ] **Step 3: Repository reads**

Append to `apps/worker/src/approval/repository.ts`:

```ts
/** Every approval a run has raised, oldest first — the inspector's history. D1 only. */
export async function listByRun(
  db: D1Database,
  runId: string
): Promise<ApprovalRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM approvals WHERE run_id = ? ORDER BY created_at ASC`)
    .bind(runId)
    .all<ApprovalRowDb>();
  return (results ?? []).map(toRow);
}

/**
 * Decided (approved/edited/rejected/withdrawn) cards whose last change is
 * inside the window, newest first. `updated_at`, not `decided_at`: a withdrawn
 * card has no decider and no `decided_at`, but it did leave the queue.
 */
export async function listDecided(
  db: D1Database,
  sinceMs: number,
  limit = 50
): Promise<ApprovalRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM approvals
       WHERE decision <> 'pending' AND updated_at >= ?
       ORDER BY updated_at DESC LIMIT ?`
    )
    .bind(sinceMs, limit)
    .all<ApprovalRowDb>();
  return (results ?? []).map(toRow);
}
```

- [ ] **Step 4: Routes**

In `apps/worker/src/api/approvals.ts`: change `function publicApprovalCard` to `export function publicApprovalCard`. Replace the `state` handling in `GET /approvals`:

```ts
  const stateParam = c.req.query("state") ?? "open";
  if (stateParam === "open") {
    const rows = await listOpen(c.env.DB);
    return c.json({ approvals: rows.map(publicApprovalSummary) });
  }
  if (stateParam === "decided") {
    const sinceParam = c.req.query("since");
    let since = Date.now() - 86_400_000;
    if (sinceParam !== undefined) {
      const parsed = Number(sinceParam);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        return c.json(fail("invalid_since", "since must be a unix ms timestamp"), 400);
      }
      since = parsed;
    }
    const rows = await listDecided(c.env.DB, since);
    return c.json({ approvals: rows.map(publicApprovalCard) });
  }
  return c.json(fail("invalid_state", "state must be 'open' or 'decided'"), 400);
```

Add `listDecided` to the repository import. In the PATCH handler's 409 branch add `decidedBy: result.row.decidedBy`:

```ts
    return c.json(
      {
        ...fail("already_decided", "already decided"),
        decision: result.row.decision,
        decidedBy: result.row.decidedBy,
      },
      409
    );
```

In `apps/worker/src/api/runs.ts` add (imports: `listByRun` from `../approval/repository`, `publicApprovalCard` from `./approvals`):

```ts
/** Every approval this run raised, oldest first. D1 only. */
runsApi.get("/runs/:id/approvals", async (c) => {
  const member = await requireTeamMember(c);
  if (member instanceof Response) return member;
  const run = await getRunById(c.env.DB, c.req.param("id"));
  if (!run) return c.json(fail("not_found", "no such run"), 404);
  const rows = await listByRun(c.env.DB, run.id);
  return c.json({ approvals: rows.map(publicApprovalCard) });
});
```

Check for an import cycle: `api/approvals.ts` must not import `api/runs.ts`. It does not today; keep it that way.

- [ ] **Step 5: Run and typecheck**

Run: `cd apps/worker && npx vitest run test/api/approvals.test.ts test/api/runs.test.ts && pnpm typecheck`
Expected: PASS.

### Task 4: `GET /api/runs/:id/effects`

**Files:**
- Create: `apps/worker/src/api/effects.ts`
- Modify: `apps/worker/src/index.ts` (mount after `runsApi`)
- Create: `apps/worker/test/api/effects.test.ts`

**Interfaces:**
- Produces: `GET /api/runs/:id/effects` → `{ effects: { turnId: string; namespace: string; method: string; state: "reserved"|"completed"|"failed"|"in_doubt"; safeResult: unknown | null; safeError: string | null; createdAt: number }[] }`, newest first, at most 200. `404 not_found` for an unknown run.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/test/api/effects.test.ts`:

```ts
import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type AccessIdentity,
  AccessJwtError,
  type AccessVerifier,
} from "../../src/access/jwt";
import {
  installIdentityApiPorts,
  resetIdentityApiPorts,
} from "../../src/api/identity";

const MEMBER = "marcus@zellify.app";

function fakeVerifier(): AccessVerifier {
  return {
    async verify(jwt: string): Promise<AccessIdentity> {
      if (!jwt) throw new AccessJwtError("missing", "no token was supplied");
      if (!jwt.includes("@"))
        throw new AccessJwtError("malformed", "not an email-shaped token");
      return { email: jwt };
    },
  };
}

async function seedRun(id: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, summary, created_at, updated_at)
     VALUES (?, ?, 'chat', NULL, NULL, 'done', 0, NULL, 1, 1)`
  )
    .bind(id, `chat:${id}`)
    .run();
}

async function seedEffect(input: {
  runId: string;
  turnId: string;
  namespace: string;
  method: string;
  state: string;
  safeResult: unknown;
  createdAt: number;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO codemode_effects
       (effect_key, run_id, turn_id, namespace, method, args_hash, state, safe_result_json, safe_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      input.runId,
      input.turnId,
      input.namespace,
      input.method,
      `hash-${crypto.randomUUID()}`,
      input.state,
      input.safeResult === null ? null : JSON.stringify(input.safeResult),
      input.createdAt,
      input.createdAt
    )
    .run();
}

beforeEach(() => {
  resetIdentityApiPorts();
  installIdentityApiPorts({ verifier: fakeVerifier() });
});
afterEach(() => resetIdentityApiPorts());

const read = (runId: string, token = MEMBER) =>
  SELF.fetch(`https://firefighter.test/api/runs/${runId}/effects`, {
    headers: { "Cf-Access-Jwt-Assertion": token },
  });

describe("GET /api/runs/:id/effects", () => {
  it("lists a run's effects newest first with the parsed safe result", async () => {
    const runId = crypto.randomUUID();
    await seedRun(runId);
    await seedEffect({
      runId, turnId: "turn:1", namespace: "slack", method: "post", state: "completed",
      safeResult: { ts: "1.2", permalink: "https://slack.example/p/1" }, createdAt: 1_000,
    });
    await seedEffect({
      runId, turnId: "turn:2", namespace: "github", method: "openPullRequest", state: "completed",
      safeResult: { html_url: "https://github.com/Zellify/web2app-rebuild/pull/9" }, createdAt: 2_000,
    });

    const res = await read(runId);
    expect(res.status).toBe(200);
    const body = await res.json<{ effects: Record<string, unknown>[] }>();
    expect(body.effects.map((e) => e.method)).toEqual(["openPullRequest", "post"]);
    expect(body.effects[1]).toEqual({
      turnId: "turn:1",
      namespace: "slack",
      method: "post",
      state: "completed",
      safeResult: { ts: "1.2", permalink: "https://slack.example/p/1" },
      safeError: null,
      createdAt: 1_000,
    });
  });

  it("never exposes the args hash or the effect key", async () => {
    const runId = crypto.randomUUID();
    await seedRun(runId);
    await seedEffect({
      runId, turnId: "t", namespace: "linear", method: "createIssue", state: "in_doubt",
      safeResult: null, createdAt: 1,
    });
    const text = await (await read(runId)).text();
    expect(text).not.toContain("hash-");
    expect(text).not.toContain("effect_key");
    expect(text).not.toContain("args");
  });

  it("404s an unknown run and 401s without a token", async () => {
    expect((await read("nope")).status).toBe(404);
    expect((await SELF.fetch("https://firefighter.test/api/runs/x/effects")).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/worker && npx vitest run test/api/effects.test.ts`
Expected: FAIL — 404 from the `/api/*` fallthrough for the valid run.

- [ ] **Step 3: Implement**

Create `apps/worker/src/api/effects.ts`:

```ts
import { Hono } from "hono";
import type { Env } from "../index";
import { getRunById } from "../run/repository";
import { requireTeamMember } from "./identity";

/**
 * What a run actually did, from the effect ledger (`codemode_effects`).
 *
 * D1 only (invariant 7). The only payload column that crosses is
 * `safe_result_json`, which the capability layer already redacted before it
 * was written; `args_hash` and the effect key stay server-side — the hash is
 * over the model's arguments, and the arguments are customer text
 * (invariant 39).
 */
export const effectsApi = new Hono<{ Bindings: Env }>();

export const RUN_EFFECTS_MAX = 200;

type EffectRowDb = {
  turn_id: string;
  namespace: string;
  method: string;
  state: "reserved" | "completed" | "failed" | "in_doubt";
  safe_result_json: string | null;
  safe_error: string | null;
  created_at: number;
};

function parseSafeResult(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json);
  } catch {
    // A row written before the envelope was JSON, or a truncated write. The
    // ledger is authoritative for idempotency, not for display; show nothing.
    return null;
  }
}

effectsApi.get("/runs/:id/effects", async (c) => {
  const member = await requireTeamMember(c);
  if (member instanceof Response) return member;

  const run = await getRunById(c.env.DB, c.req.param("id"));
  if (!run) return c.json({ code: "not_found", message: "no such run" }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT turn_id, namespace, method, state, safe_result_json, safe_error, created_at
     FROM codemode_effects WHERE run_id = ?
     ORDER BY created_at DESC LIMIT ?`
  )
    .bind(run.id, RUN_EFFECTS_MAX)
    .all<EffectRowDb>();

  return c.json({
    effects: (results ?? []).map((row) => ({
      turnId: row.turn_id,
      namespace: row.namespace,
      method: row.method,
      state: row.state,
      safeResult: parseSafeResult(row.safe_result_json),
      safeError: row.safe_error,
      createdAt: row.created_at,
    })),
  });
});
```

In `apps/worker/src/index.ts`, after `app.route("/api", runsApi);` add:

```ts
// The effect ledger, read-only. Same /api mount and the same roster gate; the
// browser sees what a run did, never what it was asked with.
app.route("/api", effectsApi);
```

with `import { effectsApi } from "./api/effects";`.

- [ ] **Step 4: Run, plus the canary**

Run: `cd apps/worker && npx vitest run test/api/effects.test.ts test/canary-secrets.test.ts && pnpm typecheck`
Expected: PASS.

### Task 5: Gate the backfill write, move the Review button, close the gaps doc, commit

**Files:**
- Modify: `apps/worker/src/api/backfill.ts`
- Create: `apps/worker/test/api/backfill.test.ts`
- Modify: `apps/worker/src/notify/blocks.ts:51`, `apps/worker/test/notify/blocks.test.ts:102`
- Modify: `apps/web/BACKEND-GAPS.md` (§6, §9, §10)
- Modify: `CLAUDE.md` (the `?approval=` sentence in the `apps/web` paragraph)

- [ ] **Step 1: Failing backfill test**

Create `apps/worker/test/api/backfill.test.ts`:

```ts
import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type AccessIdentity,
  AccessJwtError,
  type AccessVerifier,
} from "../../src/access/jwt";
import {
  installIdentityApiPorts,
  resetIdentityApiPorts,
} from "../../src/api/identity";

function fakeVerifier(): AccessVerifier {
  return {
    async verify(jwt: string): Promise<AccessIdentity> {
      if (!jwt) throw new AccessJwtError("missing", "no token was supplied");
      return { email: jwt };
    },
  };
}

beforeEach(() => {
  resetIdentityApiPorts();
  installIdentityApiPorts({ verifier: fakeVerifier() });
});
afterEach(() => resetIdentityApiPorts());

describe("POST /api/backfill/memory", () => {
  it("is a write, so it takes the roster gate like every other one", async () => {
    const anon = await SELF.fetch("https://firefighter.test/api/backfill/memory", { method: "POST" });
    expect(anon.status).toBe(401);
    const outsider = await SELF.fetch("https://firefighter.test/api/backfill/memory", {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": "someone@example.com" },
    });
    expect(outsider.status).toBe(403);
    const member = await SELF.fetch("https://firefighter.test/api/backfill/memory", {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": "ronit@zellify.app" },
    });
    expect(member.status).toBe(200);
    expect(typeof (await member.json<{ enqueued: number }>()).enqueued).toBe("number");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/api/backfill.test.ts` → FAIL (200 for anon).

- [ ] **Step 3: Gate it**

In `apps/worker/src/api/backfill.ts`:

```ts
import { requireTeamMember } from "./identity";
// ...
backfillApi.post("/backfill/memory", async (c) => {
  const member = await requireTeamMember(c);
  if (member instanceof Response) return member;
  const enqueued = await backfillMemory(c.env.DB, c.env.MEMORY_QUEUE, 200);
  return c.json({ enqueued });
});
```

- [ ] **Step 4: Review button path**

`apps/worker/src/notify/blocks.ts:51`: `url: \`${dashboardUrl}/approvals?approval=${approvalId}\`,`
`apps/worker/test/notify/blocks.test.ts:102`: `expect(button.url).toBe(\`${DASHBOARD_URL}/approvals?approval=${APPROVAL_ID}\`);`

Run: `npx vitest run test/api/backfill.test.ts test/notify/blocks.test.ts` → PASS.

- [ ] **Step 5: Docs**

In `apps/web/BACKEND-GAPS.md`:
- §6: replace the shape it documents with `{ counters: { heard, ingested, triaged, woken, dropped, escalated }, since, window }` and mark **"RESOLVED 2026-08-28 (shape); the per-message cost figure remains unbuilt"**.
- §9: append **"RESOLVED 2026-08-28: `GET /api/runs/:id/effects` exposes the effect ledger's `safe_result_json`; the UI links a PR/issue/post only when that payload carries a URL. Nothing is fabricated."**
- §10: append **"RESOLVED 2026-08-28: the 409 body carries `decidedBy`; the overlay's reconcile branch is deleted in the same change."**
- Add **§16 — Runs list**: `GET /api/runs` accepts `status, origin, channelId, shadow, q, cursor, limit`, returns `{ runs, nextCursor }`, each row carrying `costUsd` (string), `turns`, `openApprovalId`. `GET /api/runs/:id/approvals`. `GET /api/approvals?state=decided&since=`.

In `CLAUDE.md`, the `apps/web` paragraph: change "`src/notify/blocks.ts` builds every Review button as `${DASHBOARD_BASE_URL}/?approval=<id>`" to `${DASHBOARD_BASE_URL}/approvals?approval=<id>` and note that `/` redirects the old form.

- [ ] **Step 6: Full gate, then commit**

Run: `pnpm check` at the repo root. Expected: green (compare with the baseline you established first).

ASK THE USER, then:

```bash
git add apps/worker/src apps/worker/test apps/dashboard/src apps/web/BACKEND-GAPS.md CLAUDE.md
git commit -m "feat(api): real woken/dropped counters, run list filters+cursor+spend, run approvals/effects reads, decidedBy on 409"
```

---

## Part 2 — Design system (commit 2)

### Task 6: Vercel theme variables, one attention accent, Geist

**Files:**
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/app/layout.tsx`

**Interfaces:**
- Produces: Tailwind utilities `bg-attention`, `text-attention`, `border-attention`, `text-attention-foreground` (plus the existing `success/warning/info/shadow-run`), `--font-sans` = Geist, `--font-mono` = Geist Mono, `--radius: 0.5rem`.

- [ ] **Step 1: Fetch the theme once and keep the values in the file**

Run `curl -s https://tweakcn.com/r/themes/vercel.json | jq '.cssVars'` and copy the `light` and `dark` maps. Do NOT paste the `theme` map's `font-*` keys (they name Geist — we set those from `next/font` instead) and do NOT copy `shadow-*` keys (the design uses borders, not shadows).

- [ ] **Step 2: Rewrite `apps/web/app/globals.css`**

Keep the header comment, the two `@source` lines, the `@layer base` and `@layer components` blocks exactly as they are. Replace the `@theme inline`, `:root` and `.dark` blocks with:

```css
@theme inline {
  --color-success: var(--success);
  --color-success-foreground: var(--success-foreground);
  --color-warning: var(--warning);
  --color-warning-foreground: var(--warning-foreground);
  --color-info: var(--info);
  --color-info-foreground: var(--info-foreground);
  --color-shadow-run: var(--shadow-run);
  /* The one accent that means "a human is needed" — open approval,
     awaiting_approval, escalated — and nothing else (spec D17). */
  --color-attention: var(--attention);
  --color-attention-foreground: var(--attention-foreground);
  --font-mono: var(--font-mono);
}

:root {
  --font-sans: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif;
  --font-mono: var(--font-geist-mono), ui-monospace, "SFMono-Regular", monospace;
  --radius: 0.5rem;

  /* tweakcn "vercel" — light. Pasted verbatim from the registry item. */
  --background: oklch(0.99 0 0);
  --foreground: oklch(0 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0 0 0);
  --popover: oklch(0.99 0 0);
  --popover-foreground: oklch(0 0 0);
  --primary: oklch(0 0 0);
  --primary-foreground: oklch(1 0 0);
  --secondary: oklch(0.94 0 0);
  --secondary-foreground: oklch(0 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.44 0 0);
  --accent: oklch(0.94 0 0);
  --accent-foreground: oklch(0 0 0);
  --destructive: oklch(0.63 0.19 23.03);
  --destructive-foreground: oklch(1 0 0);
  --border: oklch(0.92 0 0);
  --input: oklch(0.94 0 0);
  --ring: oklch(0 0 0);
  /* …chart-1..5 and every --sidebar-* key from the registry's `light` map… */

  --attention: oklch(0.7 0.17 55);
  --attention-foreground: oklch(0.145 0 0);
  --success: oklch(0.596 0.145 163);
  --success-foreground: oklch(0.985 0 0);
  --warning: oklch(0.666 0.153 62);
  --warning-foreground: oklch(0.145 0 0);
  --info: oklch(0.588 0.158 254);
  --info-foreground: oklch(0.985 0 0);
  --shadow-run: oklch(0.585 0.199 296);
}

.dark {
  /* tweakcn "vercel" — dark. Pasted verbatim from the registry item's `dark` map. */
  /* …every key… */

  --attention: oklch(0.78 0.16 60);
  --attention-foreground: oklch(0.145 0 0);
  --success: oklch(0.723 0.155 163);
  --success-foreground: oklch(0.145 0 0);
  --warning: oklch(0.769 0.158 70);
  --warning-foreground: oklch(0.145 0 0);
  --info: oklch(0.707 0.146 254);
  --info-foreground: oklch(0.145 0 0);
  --shadow-run: oklch(0.702 0.183 294);
}
```

Fill the two `/* …every key… */` markers with the actual values from Step 1 — the block must not ship with a comment where values belong. Remove the old `--card`/`--popover`/`--sidebar` overrides in `.dark` (the theme supplies them) and the `--chart-*` ember ramp (use the theme's).

- [ ] **Step 3: Fonts**

In `apps/web/app/layout.tsx` replace the two Plex imports and constants:

```ts
import { Geist, Geist_Mono } from "next/font/google";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});
```

and the body class: `` className={`${geistSans.variable} ${geistMono.variable} antialiased`} ``. Update the doc comment: same two-voice rule, Geist instead of Plex.

- [ ] **Step 4: Verify**

Run: `cd apps/web && pnpm typecheck && pnpm build`. Expected: build passes. Run `NEXT_PUBLIC_DEMO=1 pnpm dev`, open `/`, toggle theme in the user menu: both themes paint, no ember anywhere, monospace is Geist Mono.

### Task 7: `StatusBadge` in `packages/ui` and the `lib/status.ts` mapping

**Files:**
- Create: `packages/ui/src/components/status-badge.tsx`
- Create: `apps/web/lib/status.ts`
- Create: `apps/web/test/status.test.ts`
- Modify: every importer of `components/common/status-chip.tsx` → then delete it. Importers today: `app/runs/[id]/page.tsx`, `components/dashboard/runs-feed.tsx`, `components/dashboard/run-sheet.tsx` (both deleted in Task 15 — for now just switch the import), `components/dashboard/shadow-panel.tsx` (`TellBadge`), `components/dashboard/roster-card.tsx` / `team-table.tsx` / `speaker-hero.tsx` (connect state text), `components/common/connect-state.tsx`.

**Interfaces:**
- Produces:
  ```tsx
  // packages/ui/src/components/status-badge.tsx
  export type BadgeTone = "neutral" | "attention" | "success" | "warning" | "info" | "destructive" | "shadow";
  export type StatusBadgeProps = React.ComponentProps<"span"> & {
    tone?: BadgeTone; variant?: "dot" | "soft" | "outline"; size?: "sm" | "md";
    pulse?: boolean; icon?: React.ReactNode; mono?: boolean;
  };
  export function StatusBadge(props: StatusBadgeProps): JSX.Element;
  ```
  ```ts
  // apps/web/lib/status.ts
  export type BadgeSpec = { tone: BadgeTone; label: string; pulse?: boolean; meaning: string };
  export function runStatusBadge(status: RunStatus): BadgeSpec;
  export function originBadge(origin: string): BadgeSpec;
  export const SHADOW_BADGE: BadgeSpec;
  export function connectBadge(connected: boolean, provider: "slack" | "github"): BadgeSpec;
  export function decisionBadge(decision: Decision): BadgeSpec;
  export function tellBadge(tell: AiTell): BadgeSpec;
  export function effectStateBadge(state: "reserved" | "completed" | "failed" | "in_doubt"): BadgeSpec;
  ```

- [ ] **Step 1: Failing mapping test**

Create `apps/web/test/status.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  connectBadge,
  decisionBadge,
  effectStateBadge,
  originBadge,
  runStatusBadge,
  SHADOW_BADGE,
} from "@/lib/status";

describe("status → badge", () => {
  it("spends the attention tone only on states that need a human", () => {
    expect(runStatusBadge("awaiting_approval").tone).toBe("attention");
    expect(runStatusBadge("live").tone).toBe("attention");
    expect(runStatusBadge("live").pulse).toBe(true);
    expect(runStatusBadge("awaiting_approval").pulse).toBeFalsy();
    for (const s of ["idle", "done", "failed"] as const) {
      expect(runStatusBadge(s).tone).not.toBe("attention");
      expect(runStatusBadge(s).pulse).toBeFalsy();
    }
  });

  it("maps the rest", () => {
    expect(runStatusBadge("done").tone).toBe("success");
    expect(runStatusBadge("failed").tone).toBe("destructive");
    expect(runStatusBadge("idle").tone).toBe("neutral");
    expect(originBadge("slack").label).toBe("slack");
    expect(SHADOW_BADGE.tone).toBe("shadow");
    expect(connectBadge(true, "slack").tone).toBe("success");
    expect(connectBadge(false, "github").tone).toBe("neutral");
    expect(decisionBadge("rejected").tone).toBe("destructive");
    expect(decisionBadge("pending").tone).toBe("attention");
    expect(effectStateBadge("in_doubt").tone).toBe("warning");
  });

  it("gives every badge a meaning sentence for its tooltip", () => {
    expect(runStatusBadge("idle").meaning.length).toBeGreaterThan(10);
    expect(effectStateBadge("in_doubt").meaning).toMatch(/may or may not/);
  });
});
```

- [ ] **Step 2: Run** — `cd apps/web && npx vitest run test/status.test.ts` → FAIL (module missing).

- [ ] **Step 3: The component**

Create `packages/ui/src/components/status-badge.tsx`:

```tsx
import { cn } from "@workspace/ui/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

export type BadgeTone =
  | "neutral"
  | "attention"
  | "success"
  | "warning"
  | "info"
  | "destructive"
  | "shadow";

/**
 * One badge for every status-shaped thing. Tone is the only colour input, so
 * a reader learns seven meanings once; variant is how loud it is.
 */
const statusBadgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border font-medium leading-none",
  {
    variants: {
      tone: {
        neutral: "",
        attention: "",
        success: "",
        warning: "",
        info: "",
        destructive: "",
        shadow: "",
      },
      variant: {
        soft: "",
        outline: "bg-transparent",
        dot: "border-transparent bg-transparent px-0",
      },
      size: {
        sm: "h-5 px-1.5 text-[11px]",
        md: "h-6 px-2 text-xs",
      },
    },
    compoundVariants: [
      { tone: "neutral", variant: "soft", class: "border-border bg-muted text-muted-foreground" },
      { tone: "attention", variant: "soft", class: "border-attention/30 bg-attention/12 text-attention" },
      { tone: "success", variant: "soft", class: "border-success/30 bg-success/12 text-success" },
      { tone: "warning", variant: "soft", class: "border-warning/30 bg-warning/12 text-warning" },
      { tone: "info", variant: "soft", class: "border-info/30 bg-info/12 text-info" },
      { tone: "destructive", variant: "soft", class: "border-destructive/30 bg-destructive/12 text-destructive" },
      { tone: "shadow", variant: "soft", class: "border-shadow-run/30 bg-shadow-run/12 text-shadow-run" },
      { tone: "neutral", variant: "outline", class: "border-border text-muted-foreground" },
      { tone: "attention", variant: "outline", class: "border-attention/50 text-attention" },
      { tone: "success", variant: "outline", class: "border-success/50 text-success" },
      { tone: "warning", variant: "outline", class: "border-warning/50 text-warning" },
      { tone: "info", variant: "outline", class: "border-info/50 text-info" },
      { tone: "destructive", variant: "outline", class: "border-destructive/50 text-destructive" },
      { tone: "shadow", variant: "outline", class: "border-shadow-run/50 text-shadow-run" },
      { tone: "neutral", variant: "dot", class: "text-muted-foreground" },
      { tone: "attention", variant: "dot", class: "text-attention" },
      { tone: "success", variant: "dot", class: "text-success" },
      { tone: "warning", variant: "dot", class: "text-warning" },
      { tone: "info", variant: "dot", class: "text-info" },
      { tone: "destructive", variant: "dot", class: "text-destructive" },
      { tone: "shadow", variant: "dot", class: "text-shadow-run" },
    ],
    defaultVariants: { tone: "neutral", variant: "soft", size: "sm" },
  }
);

export type StatusBadgeProps = React.ComponentProps<"span"> &
  VariantProps<typeof statusBadgeVariants> & {
    /** Ping ring behind the dot. Only for "changing right now". */
    pulse?: boolean;
    icon?: React.ReactNode;
    /** Mono for system-produced labels (ids, capability names); sans otherwise. */
    mono?: boolean;
  };

function Dot({ pulse }: { pulse: boolean }) {
  return (
    <span className="relative flex size-1.5 shrink-0" aria-hidden="true">
      {pulse ? (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-70" />
      ) : null}
      <span className="relative inline-flex size-1.5 rounded-full bg-current" />
    </span>
  );
}

export function StatusBadge({
  className,
  tone,
  variant,
  size,
  pulse = false,
  icon,
  mono = false,
  children,
  ...props
}: StatusBadgeProps) {
  const showDot = variant === "dot" || pulse;
  return (
    <span
      data-slot="status-badge"
      data-tone={tone ?? "neutral"}
      className={cn(
        statusBadgeVariants({ tone, variant, size }),
        mono && "font-mono tabular-nums tracking-[-0.01em]",
        className
      )}
      {...props}
    >
      {showDot ? <Dot pulse={pulse} /> : icon}
      {children}
    </span>
  );
}

export { statusBadgeVariants };
```

- [ ] **Step 4: The mapping**

Create `apps/web/lib/status.ts`:

```ts
import type { BadgeTone } from "@workspace/ui/components/status-badge";

import type { Decision } from "./api/approvals";
import type { RunStatus } from "./api/runs";
import type { AiTell } from "./api/shadow";
import { TELL_MEANING } from "./api/shadow";

export type BadgeSpec = {
  tone: BadgeTone;
  label: string;
  pulse?: boolean;
  /** One sentence for the tooltip: what it means for the reader, not the schema. */
  meaning: string;
};

const RUN: Record<RunStatus, BadgeSpec> = {
  live: {
    tone: "attention",
    label: "live",
    pulse: true,
    meaning: "The agent is working on this thread right now.",
  },
  awaiting_approval: {
    tone: "attention",
    label: "needs you",
    meaning: "The agent has drafted a reply and is waiting on a human.",
  },
  idle: {
    tone: "neutral",
    label: "idle",
    meaning: "Woken, then nothing further to do — it resumes if the thread moves.",
  },
  done: {
    tone: "success",
    label: "done",
    meaning: "Finished; the thread was answered or closed.",
  },
  failed: {
    tone: "destructive",
    label: "failed",
    meaning: "The run stopped on an error and did not recover.",
  },
};

export function runStatusBadge(status: RunStatus): BadgeSpec {
  return RUN[status];
}

export function originBadge(origin: string): BadgeSpec {
  return origin === "chat"
    ? { tone: "neutral", label: "chat", meaning: "Started from the dashboard, not a customer thread." }
    : { tone: "neutral", label: origin, meaning: "Woken by a message in a Slack channel." };
}

export const SHADOW_BADGE: BadgeSpec = {
  tone: "shadow",
  label: "shadow",
  meaning: "Shadow run — it drafts and reasons, but nothing it does reaches a customer.",
};

export function connectBadge(connected: boolean, provider: "slack" | "github"): BadgeSpec {
  const name = provider === "slack" ? "Slack" : "GitHub";
  return connected
    ? { tone: "success", label: `${name} connected`, meaning: `${name} is authorised under this person's own account.` }
    : { tone: "neutral", label: `${name} not connected`, meaning: `Until ${name} is connected the agent cannot act as this person there.` };
}

const DECISION: Record<Decision, BadgeSpec> = {
  pending: { tone: "attention", label: "waiting", meaning: "Nobody has decided this yet." },
  approved: { tone: "success", label: "approved", meaning: "Sent as drafted." },
  edited: { tone: "info", label: "edited", meaning: "Sent with a human's changes." },
  rejected: { tone: "destructive", label: "rejected", meaning: "Not sent; the agent was told why." },
  withdrawn: { tone: "neutral", label: "withdrawn", meaning: "The agent took the ask back before anyone decided." },
};

export function decisionBadge(decision: Decision): BadgeSpec {
  return DECISION[decision];
}

export function tellBadge(tell: AiTell): BadgeSpec {
  return { tone: "warning", label: tell.replaceAll("_", " "), meaning: TELL_MEANING[tell] };
}

const EFFECT: Record<"reserved" | "completed" | "failed" | "in_doubt", BadgeSpec> = {
  reserved: { tone: "neutral", label: "reserved", meaning: "Claimed in the ledger; the call has not returned." },
  completed: { tone: "success", label: "completed", meaning: "The call returned and its result was recorded." },
  failed: { tone: "destructive", label: "failed", meaning: "The call failed and nothing reached the outside world." },
  in_doubt: { tone: "warning", label: "in doubt", meaning: "The call was made but its outcome may or may not have been recorded." },
};

export function effectStateBadge(state: keyof typeof EFFECT): BadgeSpec {
  return EFFECT[state];
}
```

(Confirm `TELL_MEANING` and `AiTell` exist in `apps/web/lib/api/shadow.ts` — the explorer found both.)

- [ ] **Step 5: A tiny presentational wrapper in the app**

Create `apps/web/components/common/badge.tsx` — the app-side glue that turns a `BadgeSpec` into a `StatusBadge` with its tooltip, so pages never touch tones directly:

```tsx
"use client";

import {
  StatusBadge,
  type StatusBadgeProps,
} from "@workspace/ui/components/status-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";

import type { BadgeSpec } from "@/lib/status";

export function SpecBadge({
  spec,
  ...rest
}: { spec: BadgeSpec } & Omit<StatusBadgeProps, "tone" | "pulse" | "children">) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <StatusBadge tone={spec.tone} pulse={spec.pulse} mono {...rest} className={`cursor-default ${rest.className ?? ""}`} />
        }
      >
        {spec.label}
      </TooltipTrigger>
      <TooltipContent>{spec.meaning}</TooltipContent>
    </Tooltip>
  );
}
```

- [ ] **Step 6: Replace the old chips**

Change every importer listed in **Files** from `StatusChip`/`OriginBadge`/`ShadowBadge`/`TellBadge` to `<SpecBadge spec={runStatusBadge(status)} />`, `<SpecBadge spec={originBadge(origin)} />`, `<SpecBadge spec={SHADOW_BADGE} />`, `<SpecBadge spec={tellBadge(tell)} />`; in `connect-state.tsx`, `roster-card.tsx`, `team-table.tsx`, `speaker-hero.tsx` replace the free-text "connected"/"not connected" with `<SpecBadge spec={connectBadge(ok, "slack")} />`. Then `git rm apps/web/components/common/status-chip.tsx`. Search: `grep -rn "status-chip\|TellBadge" apps/web` must return nothing.

- [ ] **Step 7: Verify**

Run: `cd apps/web && npx vitest run && pnpm typecheck && cd ../../packages/ui && pnpm typecheck`. Expected: PASS (the existing `run-view.test.tsx`, `transcript.test.tsx`, `approval-card.test.tsx` still pass).

### Task 8: Primitives and `SectionHeader`

**Files:**
- Add via CLI into `packages/ui/src/components/`: `dialog`, `tabs`, `select`, `switch`, `scroll-area`, `command`, `resizable`, `avatar`, `alert`, `popover`, `collapsible`, `sonner`
- Create: `apps/web/components/common/section-header.tsx`
- Modify: `apps/web/components/shell/providers.tsx` (mount `<Toaster />`)

- [ ] **Step 1: Add the primitives**

Run from `apps/web` (its `components.json` aliases `ui` into `packages/ui`):

```bash
cd apps/web && npx shadcn@latest add dialog tabs select switch scroll-area command resizable avatar alert popover collapsible sonner
```

Then `git status packages/ui` — every file must land in `packages/ui/src/components/`, none in `apps/web/components/ui/`. If the CLI put any in `apps/web`, move them and fix the imports to `@workspace/ui/...`. If the `base-nova` registry has no `resizable` or `command`, install the underlying packages into `packages/ui` (`pnpm --filter @workspace/ui add react-resizable-panels cmdk`) and copy the shadcn v4 `resizable.tsx` / `command.tsx` sources by hand, replacing the Radix `Dialog` usage in `command.tsx` with the `@base-ui/react` `Dialog` primitive already used by the added `dialog.tsx`. Record whichever path you took in `docs/superpowers/plans/phase-26-notes.md`-style dated line at the bottom of this plan file.

`pnpm install` at the root after any dependency change; commit the lockfile with the task.

- [ ] **Step 2: `SectionHeader`**

Create `apps/web/components/common/section-header.tsx`:

```tsx
import type { ReactNode } from "react";

/**
 * The one way a page labels a region: eyebrow (mono, the system naming its
 * part), a title (sans), and an optional right-side action. Every page uses
 * this, so a reader learns the hierarchy once.
 */
export function SectionHeader({
  eyebrow,
  title,
  action,
  description,
}: {
  eyebrow?: string;
  title: string;
  action?: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div className="space-y-1">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h2 className="font-semibold text-base tracking-tight">{title}</h2>
        {description ? (
          <p className="text-muted-foreground text-sm">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
```

- [ ] **Step 3: Toaster**

In `apps/web/components/shell/providers.tsx`, import `{ Toaster } from "@workspace/ui/components/sonner"` and render `<Toaster position="bottom-right" />` as the last child inside `TooltipProvider`.

- [ ] **Step 4: Verify and commit**

Run: `pnpm check` at the root (all workspaces typecheck; Biome over the new files — run `pnpm format` first). ASK THE USER, then:

```bash
git add packages/ui apps/web pnpm-lock.yaml
git commit -m "feat(ui): vercel theme + geist, StatusBadge with one attention accent, shadcn primitives for the redesign"
```

---

## Part 3 — Shell and the Runs workbench (commit 3)

### Task 9: API clients, query keys, fixtures for the new shapes

**Files:**
- Rewrite: `apps/web/lib/api/counters.ts`; replace `apps/web/test/funnel.test.ts`
- Modify: `apps/web/lib/api/runs.ts`, `apps/web/lib/api/approvals.ts`
- Create: `apps/web/lib/api/effects.ts`, `apps/web/lib/api/eval.ts`
- Modify: `apps/web/lib/query/keys.ts`, `apps/web/lib/hooks/use-dashboard-data.ts`
- Create: `apps/web/lib/hooks/use-runs-page.ts`
- Modify: `apps/web/lib/fixtures/counters.ts`, `runs.ts`, `approvals.ts`; Create: `lib/fixtures/effects.ts`, `lib/fixtures/eval.ts`
- Modify: `apps/web/test/fixtures.test.ts` (if it pins shapes), `apps/web/test/api-client.test.ts` (unchanged unless it references `deriveFunnel`)

**Interfaces (produced, used by every later task):**

```ts
// lib/api/counters.ts
export type CountersWindow = "24h" | "7d";
export type Counters = {
  counters: { heard: number; ingested: number; triaged: number; woken: number; dropped: number; escalated: number };
  since: number; window: CountersWindow;
};
export function getCounters(window: CountersWindow): Promise<Counters>;
export type FunnelStage = { key: "heard" | "triaged" | "woken" | "escalated"; label: string; value: number; ratio: number; accent: boolean };
export function funnelStages(c: Counters["counters"]): FunnelStage[];   // ratio = value / max(heard, 1), in [0,1]
export function isQuiet(c: Counters["counters"]): boolean;              // heard === 0

// lib/api/runs.ts
export type RunSummary = { ...existing; costUsd: string; turns: number; openApprovalId: string | null };
export type RunListParams = { status?: RunStatus; origin?: "slack" | "chat"; channelId?: string; shadow?: boolean; q?: string; cursor?: string; limit?: number };
export type RunPage = { runs: RunSummary[]; nextCursor: string | null };
export function runListQuery(params: RunListParams): string;            // "?a=b&c=d" or ""
export function getRuns(params?: RunListParams): Promise<RunPage>;

// lib/api/approvals.ts
export function getRunApprovals(runId: string): Promise<ApprovalDetail[]>;
export function getDecidedApprovals(sinceMs: number): Promise<ApprovalDetail[]>;
// DecideResult "already_decided" now reads decidedBy from the 409 body.

// lib/api/effects.ts
export type EffectState = "reserved" | "completed" | "failed" | "in_doubt";
export type RunEffect = { turnId: string; namespace: string; method: string; state: EffectState; safeResult: unknown; safeError: string | null; createdAt: number };
export function getRunEffects(runId: string): Promise<RunEffect[]>;
export function effectUrl(effect: RunEffect): string | null;            // safeResult.url | html_url | permalink, if a string starting with https://
export function chipsByTurn(effects: readonly RunEffect[]): Map<string, string[]>; // turnId → ["slack.post", "supabase.read ×3"]

// lib/api/eval.ts
export type TriageScore = { n: number; truePos: number; falsePos: number; falseNeg: number; trueNeg: number; precision: number | null; recall: number | null };
export function getTriageScore(days: 7 | 30 | 90): Promise<{ score: TriageScore; windowDays: number; unripeExcluded: number; truncated: boolean }>;

// lib/query/keys.ts additions
counters: (window) => ["counters", window], runsPage: (params) => ["runs", "page", params], runApprovals: (id) => ["runs", id, "approvals"],
runEffects: (id) => ["runs", id, "effects"], decidedApprovals: (since) => ["approvals", "decided", since], triage: (days) => ["eval", "triage", days]
POLL_MS.effects = 5_000

// lib/hooks/use-runs-page.ts
export function useRunsPage(params: Omit<RunListParams, "cursor">): { state: PanelState<RunSummary[]>; fetchNext: () => void; hasNext: boolean; loadingNext: boolean };
// lib/hooks/use-dashboard-data.ts additions
export function useCounters(window: CountersWindow): PanelState<Counters>;
export function useRunApprovals(id: string): PanelState<ApprovalDetail[]>;
export function useRunEffects(id: string): PanelState<RunEffect[]>;
export function useDecidedApprovals(sinceMs: number): PanelState<ApprovalDetail[]>;
export function useTriageScore(days: 7 | 30 | 90): PanelState<Awaited<ReturnType<typeof getTriageScore>>>;
```

- [ ] **Step 1: Failing tests**

Replace `apps/web/test/funnel.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { funnelStages, isQuiet } from "@/lib/api/counters";

const day = { heard: 148, ingested: 140, triaged: 140, woken: 17, dropped: 123, escalated: 1 };

describe("funnelStages", () => {
  it("scales every stage against heard, in order", () => {
    const stages = funnelStages(day);
    expect(stages.map((s) => s.key)).toEqual(["heard", "triaged", "woken", "escalated"]);
    expect(stages[0].ratio).toBe(1);
    expect(stages[3].ratio).toBeCloseTo(1 / 148);
    expect(stages[3].accent).toBe(true);
    expect(stages.filter((s) => s.accent)).toHaveLength(1);
  });

  it("never divides by zero and never yields NaN", () => {
    const zero = { heard: 0, ingested: 0, triaged: 0, woken: 0, dropped: 0, escalated: 0 };
    for (const s of funnelStages(zero)) {
      expect(Number.isFinite(s.ratio)).toBe(true);
      expect(s.ratio).toBe(0);
    }
    expect(isQuiet(zero)).toBe(true);
    expect(isQuiet(day)).toBe(false);
  });
});
```

Create `apps/web/test/runs-query.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { runListQuery } from "@/lib/api/runs";

describe("runListQuery", () => {
  it("is empty for no params and omits undefined ones", () => {
    expect(runListQuery({})).toBe("");
    expect(runListQuery({ status: undefined, q: "" })).toBe("");
  });
  it("encodes every param and booleans as words", () => {
    expect(runListQuery({ status: "live", shadow: false, q: "a b", cursor: "1_x", limit: 20 })).toBe(
      "?status=live&shadow=false&q=a+b&cursor=1_x&limit=20"
    );
  });
});
```

Create `apps/web/test/effects.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { chipsByTurn, effectUrl, type RunEffect } from "@/lib/api/effects";

const e = (over: Partial<RunEffect>): RunEffect => ({
  turnId: "t1", namespace: "slack", method: "post", state: "completed",
  safeResult: null, safeError: null, createdAt: 1, ...over,
});

describe("effects", () => {
  it("groups chips per turn and counts repeats", () => {
    const chips = chipsByTurn([
      e({ namespace: "supabase", method: "read" }),
      e({ namespace: "supabase", method: "read" }),
      e({ namespace: "slack", method: "post" }),
      e({ turnId: "t2", namespace: "approval", method: "escalate" }),
    ]);
    expect(chips.get("t1")).toEqual(["supabase.read ×2", "slack.post"]);
    expect(chips.get("t2")).toEqual(["approval.escalate"]);
  });

  it("finds a link only when the safe result carries an https url", () => {
    expect(effectUrl(e({ safeResult: { html_url: "https://github.com/x/pull/1" } }))).toBe("https://github.com/x/pull/1");
    expect(effectUrl(e({ safeResult: { permalink: "https://slack.com/p" } }))).toBe("https://slack.com/p");
    expect(effectUrl(e({ safeResult: { url: "javascript:alert(1)" } }))).toBeNull();
    expect(effectUrl(e({ safeResult: "nope" }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run** — `cd apps/web && npx vitest run test/funnel.test.ts test/runs-query.test.ts test/effects.test.ts` → FAIL.

- [ ] **Step 3: `counters.ts`**

Replace `apps/web/lib/api/counters.ts`:

```ts
import { demoCounters } from "../fixtures/counters";
import { fixture, getJson, isDemo } from "./client";

export type CountersWindow = "24h" | "7d";

/** Exactly what `GET /api/counters` returns — `dropped` is computed server-side now. */
export type Counters = {
  counters: {
    heard: number;
    ingested: number;
    triaged: number;
    woken: number;
    dropped: number;
    escalated: number;
  };
  since: number;
  window: CountersWindow;
};

export function getCounters(window: CountersWindow): Promise<Counters> {
  if (isDemo()) return fixture({ ...demoCounters, window });
  return getJson<Counters>(`/api/counters?window=${window}`);
}

export type FunnelStage = {
  key: "heard" | "triaged" | "woken" | "escalated";
  label: string;
  value: number;
  /** value / heard, clamped to [0, 1]; 0 on a quiet window. */
  ratio: number;
  /** The one stage that costs a person's attention. */
  accent: boolean;
};

export function funnelStages(c: Counters["counters"]): FunnelStage[] {
  const scale = c.heard > 0 ? c.heard : null;
  const ratio = (v: number) => (scale === null ? 0 : Math.min(1, Math.max(0, v / scale)));
  return [
    { key: "heard", label: "heard", value: c.heard, ratio: ratio(c.heard), accent: false },
    { key: "triaged", label: "triaged", value: c.triaged, ratio: ratio(c.triaged), accent: false },
    { key: "woken", label: "woke the agent", value: c.woken, ratio: ratio(c.woken), accent: false },
    { key: "escalated", label: "escalated", value: c.escalated, ratio: ratio(c.escalated), accent: true },
  ];
}

export function isQuiet(c: Counters["counters"]): boolean {
  return c.heard === 0;
}
```

`apps/web/lib/fixtures/counters.ts`:

```ts
import type { Counters } from "../api/counters";

export const demoCounters: Counters = {
  counters: { heard: 148, ingested: 140, triaged: 140, woken: 17, dropped: 123, escalated: 1 },
  since: Date.now() - 24 * 60 * 60 * 1000,
  window: "24h",
};
```

- [ ] **Step 4: `runs.ts`**

In `apps/web/lib/api/runs.ts` extend `RunSummary` with `costUsd: string; turns: number; openApprovalId: string | null;`, then replace `getRuns`:

```ts
export type RunListParams = {
  status?: RunStatus;
  origin?: "slack" | "chat";
  channelId?: string;
  shadow?: boolean;
  q?: string;
  cursor?: string;
  limit?: number;
};

export type RunPage = { runs: RunSummary[]; nextCursor: string | null };

/** Deterministic key order, so two components asking the same thing share one cache entry. */
export function runListQuery(params: RunListParams): string {
  const search = new URLSearchParams();
  if (params.status) search.set("status", params.status);
  if (params.origin) search.set("origin", params.origin);
  if (params.channelId) search.set("channelId", params.channelId);
  if (params.shadow !== undefined) search.set("shadow", String(params.shadow));
  if (params.q) search.set("q", params.q);
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  const s = search.toString();
  return s === "" ? "" : `?${s}`;
}

function matchesDemo(run: RunSummary, p: RunListParams): boolean {
  if (p.status && run.status !== p.status) return false;
  if (p.origin && run.origin !== p.origin) return false;
  if (p.channelId && run.channelId !== p.channelId) return false;
  if (p.shadow !== undefined && run.shadow !== p.shadow) return false;
  if (p.q) {
    const q = p.q.toLowerCase();
    const hay = `${run.summary ?? ""} ${run.channelName ?? ""} ${run.id}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export async function getRuns(params: RunListParams = {}): Promise<RunPage> {
  if (isDemo()) {
    return fixture({ runs: demoRuns.filter((r) => matchesDemo(r, params)), nextCursor: null });
  }
  return getJson<RunPage>(`/api/runs${runListQuery(params)}`);
}
```

Update `apps/web/lib/fixtures/runs.ts`: add to each of the six demo runs `costUsd` (copy the matching `demoUsageTotals` value), `turns` (3, 2, 5, 1, 2, 1) and `openApprovalId` (`"apr:demo-lingua"` on the `awaiting_approval` run — check `lib/fixtures/approvals.ts` for the id it actually uses and reuse it; `null` elsewhere).

- [ ] **Step 5: `approvals.ts`**

In `apps/web/lib/api/approvals.ts` add:

```ts
export async function getRunApprovals(runId: string): Promise<ApprovalDetail[]> {
  if (isDemo()) return fixture(listDemoApprovalsForRun(runId));
  const body = await getJson<{ approvals: ApprovalDetail[] }>(
    `/api/runs/${encodeURIComponent(runId)}/approvals`
  );
  return body.approvals;
}

export async function getDecidedApprovals(sinceMs: number): Promise<ApprovalDetail[]> {
  if (isDemo()) return fixture(listDemoDecided());
  const body = await getJson<{ approvals: ApprovalDetail[] }>(
    `/api/approvals?state=decided&since=${sinceMs}`
  );
  return body.approvals;
}
```

and in `decide`'s 409 branch read the name from the body:

```ts
    const body = response.body as { decision?: Decision; decidedBy?: string | null } | null;
    const decision = body?.decision;
    if (!decision)
      return { result: "error", error: new ApiError(409, "unavailable", path) };
    return { result: "already_decided", decision, decidedBy: body?.decidedBy ?? null };
```

In `apps/web/lib/fixtures/approvals.ts` add `listDemoApprovalsForRun(runId)` (filter the mutable demo list by `runId`, as `ApprovalDetail`s) and `listDemoDecided()` (every demo card whose `decision !== "pending"`, plus two static decided cards — one `approved` by `ronit@zellify.app` 2h ago, one `rejected` with a reason 5h ago — so the section is never empty in a demo).

- [ ] **Step 6: `effects.ts` and `eval.ts`**

Create `apps/web/lib/api/effects.ts`:

```ts
import { demoEffectsFor } from "../fixtures/effects";
import { fixture, getJson, isDemo } from "./client";

export type EffectState = "reserved" | "completed" | "failed" | "in_doubt";

/** One row of the effect ledger, as `GET /api/runs/:id/effects` returns it. Never carries arguments. */
export type RunEffect = {
  turnId: string;
  namespace: string;
  method: string;
  state: EffectState;
  safeResult: unknown;
  safeError: string | null;
  createdAt: number;
};

export async function getRunEffects(runId: string): Promise<RunEffect[]> {
  if (isDemo()) return fixture(demoEffectsFor(runId));
  const body = await getJson<{ effects: RunEffect[] }>(
    `/api/runs/${encodeURIComponent(runId)}/effects`
  );
  return body.effects;
}

const URL_KEYS = ["url", "html_url", "permalink"] as const;

/** A link the effect produced, or null. Only https — a result is data, not a place to put a scheme. */
export function effectUrl(effect: RunEffect): string | null {
  const r = effect.safeResult;
  if (typeof r !== "object" || r === null) return null;
  for (const key of URL_KEYS) {
    const value = (r as Record<string, unknown>)[key];
    if (typeof value === "string" && value.startsWith("https://")) return value;
  }
  return null;
}

/** "namespace.method", repeats folded into "×N", in first-seen order per turn. */
export function chipsByTurn(effects: readonly RunEffect[]): Map<string, string[]> {
  const perTurn = new Map<string, Map<string, number>>();
  // Ledger is newest-first; chips read better oldest-first.
  for (const e of [...effects].reverse()) {
    const counts = perTurn.get(e.turnId) ?? new Map<string, number>();
    const name = `${e.namespace}.${e.method}`;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    perTurn.set(e.turnId, counts);
  }
  const out = new Map<string, string[]>();
  for (const [turn, counts] of perTurn) {
    out.set(turn, [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)));
  }
  return out;
}
```

Create `apps/web/lib/fixtures/effects.ts` — per-run fixtures keyed by the demo run ids from `fixtures/runs.ts`: the live pulsefit run gets `supabase.read ×2`, `betterstack.query`, `sandbox.exec` (completed); the awaiting-approval lingua run gets `memory.recall`, `approval.escalate`; the done macrosnap run gets `github.openPullRequest` with `safeResult: { html_url: "https://github.com/Zellify/web2app-rebuild/pull/1287" }` and `linear.createIssue` with `{ url: "https://linear.app/zellify/issue/ZEL-412" }`; every other run `[]`. Use `turnId` values that match the `id`s of the USER messages in `fixtures/run-transcript.ts` for those runs, so the chip strip in demo mode actually lines up (read that file; its user messages have ids — if they do not, add `id`s of the form `turn:<n>` to both).

Create `apps/web/lib/api/eval.ts`:

```ts
import { demoTriage } from "../fixtures/eval";
import { fixture, getJson, isDemo } from "./client";

export type TriageDays = 7 | 30 | 90;

export type TriageScore = {
  n: number;
  truePos: number;
  falsePos: number;
  falseNeg: number;
  trueNeg: number;
  /** null when the denominator is zero — "not measured", never 0.0. */
  precision: number | null;
  recall: number | null;
};

export type TriageReport = {
  score: TriageScore;
  windowDays: number;
  unripeExcluded: number;
  truncated: boolean;
};

export function getTriageScore(days: TriageDays): Promise<TriageReport> {
  if (isDemo()) return fixture({ ...demoTriage, windowDays: days });
  return getJson<TriageReport>(`/api/eval/triage?days=${days}`);
}
```

`apps/web/lib/fixtures/eval.ts`: `export const demoTriage: TriageReport = { score: { n: 212, truePos: 15, falsePos: 4, falseNeg: 2, trueNeg: 191, precision: 15 / 19, recall: 15 / 17 }, windowDays: 30, unripeExcluded: 6, truncated: false };`

- [ ] **Step 7: Keys and hooks**

`apps/web/lib/query/keys.ts` — replace `counters` and `runs`, add the rest:

```ts
  counters: (window: "24h" | "7d") => ["counters", window] as const,
  runsPage: (params: Record<string, unknown>) => ["runs", "page", params] as const,
  runApprovals: (id: string) => ["runs", id, "approvals"] as const,
  runEffects: (id: string) => ["runs", id, "effects"] as const,
  decidedApprovals: (since: number) => ["approvals", "decided", since] as const,
  triage: (days: number) => ["eval", "triage", days] as const,
```

and `effects: 5_000` in `POLL_MS`. Delete `runs: (limit)` after Task 15 removes its last caller (`runs-feed.tsx`); for now leave it.

`apps/web/lib/hooks/use-dashboard-data.ts` — `useCounters(window)` keyed on `queryKeys.counters(window)` calling `getCounters(window)`; add:

```ts
export function useRunApprovals(id: string): PanelState<ApprovalDetail[]> {
  return toPanelState(
    useQuery({ queryKey: queryKeys.runApprovals(id), queryFn: () => getRunApprovals(id), refetchInterval: POLL_MS.approvals }),
    { emptyHint: "This run has not asked for anything yet.", isEmpty: (rows) => rows.length === 0 }
  );
}

export function useRunEffects(id: string): PanelState<RunEffect[]> {
  return toPanelState(
    useQuery({ queryKey: queryKeys.runEffects(id), queryFn: () => getRunEffects(id), refetchInterval: POLL_MS.effects }),
    { emptyHint: "Nothing committal yet — reads do not land in the ledger.", isEmpty: (rows) => rows.length === 0 }
  );
}

export function useDecidedApprovals(sinceMs: number): PanelState<ApprovalDetail[]> {
  return toPanelState(
    useQuery({ queryKey: queryKeys.decidedApprovals(sinceMs), queryFn: () => getDecidedApprovals(sinceMs), refetchInterval: POLL_MS.approvals }),
    { emptyHint: "Nothing was decided in this window.", isEmpty: (rows) => rows.length === 0 }
  );
}

export function useTriageScore(days: TriageDays): PanelState<TriageReport> {
  return toPanelState(
    useQuery({ queryKey: queryKeys.triage(days), queryFn: () => getTriageScore(days), staleTime: 60_000 })
  );
}
```

Create `apps/web/lib/hooks/use-runs-page.ts`:

```ts
"use client";

import { useInfiniteQuery } from "@tanstack/react-query";

import { getRuns, type RunListParams, type RunSummary } from "../api/runs";
import type { PanelState } from "../panel-state";
import { POLL_MS, queryKeys } from "../query/keys";

export const NO_RUNS_HINT =
  "No runs match — the agent wakes only when triage says so.";

/**
 * The runs list as pages. One infinite query per distinct filter set; the
 * first page refetches on the poll and later pages are appended on demand.
 */
export function useRunsPage(params: Omit<RunListParams, "cursor">): {
  state: PanelState<RunSummary[]>;
  fetchNext: () => void;
  hasNext: boolean;
  loadingNext: boolean;
} {
  const query = useInfiniteQuery({
    queryKey: queryKeys.runsPage(params),
    queryFn: ({ pageParam }) => getRuns({ ...params, cursor: pageParam ?? undefined, limit: params.limit ?? 30 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: POLL_MS.runs,
  });

  const runs = query.data?.pages.flatMap((p) => p.runs) ?? null;
  const state: PanelState<RunSummary[]> =
    runs !== null
      ? runs.length === 0
        ? { kind: "empty", hint: NO_RUNS_HINT }
        : { kind: "ready", data: runs }
      : query.isError
        ? { kind: "error", error: asApiError(query.error), retry: () => void query.refetch() }
        : { kind: "loading" };

  return {
    state,
    fetchNext: () => void query.fetchNextPage(),
    hasNext: query.hasNextPage,
    loadingNext: query.isFetchingNextPage,
  };
}
```

(`asApiError` is exported from `lib/api/errors.ts`; import it.) Note: a `refetchInterval` on an infinite query refetches every loaded page in order — acceptable at 30 rows/page; it is what keeps status dots fresh.

- [ ] **Step 8: Verify** — `cd apps/web && npx vitest run && pnpm typecheck`. Expected: PASS. (`runs-feed.tsx`/`run-sheet.tsx` still compile against `useRuns` — leave `useRuns` in place until Task 15 deletes them; give it the new signature `useRuns()` → `getRuns({ limit: 50 }).then(p => p.runs)`.)

### Task 10: Run list filter state (pure)

**Files:**
- Create: `apps/web/lib/runs/filters.ts`
- Create: `apps/web/test/run-filters.test.ts`

**Interfaces:**
```ts
export type RunFilters = { q: string; status: RunStatus | null; origin: "slack" | "chat" | null; channelId: string | null; shadow: boolean | null };
export const EMPTY_FILTERS: RunFilters;
export function parseRunFilters(search: URLSearchParams): RunFilters;
export function filtersToSearch(f: RunFilters): URLSearchParams;
export function toListParams(f: RunFilters): Omit<RunListParams, "cursor" | "limit">;
export function withFilter<K extends keyof RunFilters>(f: RunFilters, key: K, value: RunFilters[K]): RunFilters;
export function activeFilterCount(f: RunFilters): number; // q excluded
```

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";

import { activeFilterCount, EMPTY_FILTERS, filtersToSearch, parseRunFilters, toListParams, withFilter } from "@/lib/runs/filters";

describe("run filters", () => {
  it("round-trips through the URL and drops garbage", () => {
    const f = parseRunFilters(new URLSearchParams("q=android&status=live&origin=chat&shadow=true&channelId=C1"));
    expect(f).toEqual({ q: "android", status: "live", origin: "chat", channelId: "C1", shadow: true });
    expect(filtersToSearch(f).toString()).toBe("q=android&status=live&origin=chat&channelId=C1&shadow=true");
    expect(parseRunFilters(new URLSearchParams("status=bogus&origin=email&shadow=maybe"))).toEqual(EMPTY_FILTERS);
  });
  it("maps to list params without nulls", () => {
    expect(toListParams(EMPTY_FILTERS)).toEqual({});
    expect(toListParams(withFilter(EMPTY_FILTERS, "shadow", false))).toEqual({ shadow: false });
  });
  it("counts active chips, not the search box", () => {
    expect(activeFilterCount(withFilter(withFilter(EMPTY_FILTERS, "q", "x"), "status", "done"))).toBe(1);
  });
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**

```ts
import type { RunListParams, RunStatus } from "../api/runs";

export type RunFilters = {
  q: string;
  status: RunStatus | null;
  origin: "slack" | "chat" | null;
  channelId: string | null;
  shadow: boolean | null;
};

export const EMPTY_FILTERS: RunFilters = { q: "", status: null, origin: null, channelId: null, shadow: null };

const STATUSES: readonly RunStatus[] = ["live", "awaiting_approval", "idle", "done", "failed"];

export function parseRunFilters(search: URLSearchParams): RunFilters {
  const status = search.get("status");
  const origin = search.get("origin");
  const shadow = search.get("shadow");
  return {
    q: search.get("q") ?? "",
    status: STATUSES.includes(status as RunStatus) ? (status as RunStatus) : null,
    origin: origin === "slack" || origin === "chat" ? origin : null,
    channelId: search.get("channelId") || null,
    shadow: shadow === "true" ? true : shadow === "false" ? false : null,
  };
}

export function filtersToSearch(f: RunFilters): URLSearchParams {
  const s = new URLSearchParams();
  if (f.q) s.set("q", f.q);
  if (f.status) s.set("status", f.status);
  if (f.origin) s.set("origin", f.origin);
  if (f.channelId) s.set("channelId", f.channelId);
  if (f.shadow !== null) s.set("shadow", String(f.shadow));
  return s;
}

export function toListParams(f: RunFilters): Omit<RunListParams, "cursor" | "limit"> {
  const p: Omit<RunListParams, "cursor" | "limit"> = {};
  if (f.q) p.q = f.q;
  if (f.status) p.status = f.status;
  if (f.origin) p.origin = f.origin;
  if (f.channelId) p.channelId = f.channelId;
  if (f.shadow !== null) p.shadow = f.shadow;
  return p;
}

export function withFilter<K extends keyof RunFilters>(f: RunFilters, key: K, value: RunFilters[K]): RunFilters {
  return { ...f, [key]: value };
}

export function activeFilterCount(f: RunFilters): number {
  return [f.status, f.origin, f.channelId, f.shadow].filter((v) => v !== null).length;
}
```

- [ ] **Step 4: Run** → PASS.

### Task 11: Shell — six nav entries, titles, `/?approval=` redirect

**Files:**
- Modify: `apps/web/components/shell/app-sidebar.tsx`, `site-header.tsx`
- Create: `apps/web/app/approvals/page.tsx`, `team/page.tsx`, `channels/page.tsx`, `eval/page.tsx` as PLACEHOLDERS that render the existing components (fleshed out in Part 5), so nav links resolve now
- Modify: `apps/web/app/page.tsx` (redirect only, in this task)

- [ ] **Step 1: Sidebar `NAV`**

```tsx
import { Activity, FlaskConical, Hash, Inbox, LayoutDashboard, Users, type LucideIcon } from "lucide-react";
import { useRunsPage } from "@/lib/hooks/use-runs-page";

const NAV: NavEntry[] = [
  { href: "/", label: "Overview", icon: LayoutDashboard, tooltip: "What needs you right now" },
  { href: "/runs", label: "Runs", icon: Activity, tooltip: "Every run, with its transcript" },
  { href: "/approvals", label: "Approvals", icon: Inbox, tooltip: "Decide what the agent may send" },
  { href: "/team", label: "Team", icon: Users, tooltip: "Who the agent speaks as" },
  { href: "/channels", label: "Channels", icon: Hash, tooltip: "Which channels it listens to, and how" },
  { href: "/eval", label: "Eval", icon: FlaskConical, tooltip: "How well triage and the drafts are doing" },
];
```

Active state: `pathname === entry.href || (entry.href !== "/" && pathname.startsWith(entry.href))`. Badges: `/approvals` shows `openCount` (attention tone: `className="machine text-attention"`); `/runs` shows the count of `live` + `awaiting_approval` from `useRunsPage({ status: undefined })` — to avoid a second list query, compute it from `useRunsPage({})`'s first page (`state.kind === "ready" ? state.data.filter(r => r.status === "live" || r.status === "awaiting_approval").length : 0`); it shares the cache with the `/runs` page's unfiltered list.

- [ ] **Step 2: Header titles**

```ts
const TITLE: Record<string, string> = {
  "/": "Overview", "/runs": "Runs", "/approvals": "Approvals",
  "/team": "Team", "/channels": "Channels", "/eval": "Eval",
};
function titleFor(pathname: string): string {
  if (pathname.startsWith("/runs/")) return "Runs";
  return TITLE[pathname] ?? "Fire-Fighter";
}
```

Change the pulse dot and count from `bg-primary`/`text-primary` to `bg-attention`/`text-attention`.

- [ ] **Step 3: Placeholder pages** (each `"use client"`, same container `mx-auto w-full max-w-7xl space-y-6 p-6`):
- `app/approvals/page.tsx` → `<ApprovalsQueue role={identity?.role ?? "viewer"} />`
- `app/team/page.tsx` → `<SpeakerHero state={roster} />`, `<TeamTable state={roster} identity={identity} />`
- `app/channels/page.tsx` → `<ChannelsPanel role={identity?.role ?? null} />`
- `app/eval/page.tsx` → `<ShadowPanel />`

- [ ] **Step 4: Redirect in `app/page.tsx`**

At the top of `DashboardPage`:

```tsx
const search = useSearchParams();
const router = useRouter();
useEffect(() => {
  const approval = search.get("approval");
  if (approval) router.replace(`/approvals?approval=${encodeURIComponent(approval)}`);
}, [search, router]);
```

(`useSearchParams` needs the `<Suspense>` the shell already wraps children in.) Remove `<ApprovalsQueue>`, `<TeamTable>`, `<ChannelsPanel>`, `<ShadowPanel>`, `<NudgePreview>`, `<TokenExplainer>`, `<RosterCard>` from `/` now — they have homes. Keep `SpeakerHero`, `FunnelStrip`, `RunsFeed`, `RunSheet` until Task 16 rewrites the page.

- [ ] **Step 5: Verify** — `pnpm typecheck && npx vitest run` in `apps/web`; `NEXT_PUBLIC_DEMO=1 pnpm dev`: every nav entry lands on a page; `/?approval=x` lands on `/approvals?approval=x`.

### Task 12: `RunRow`, `RunFilters`, `RunList`

**Files:**
- Create: `apps/web/components/runs/run-row.tsx`, `run-filters.tsx`, `run-list.tsx`
- Create: `apps/web/test/run-row.test.tsx`

**Interfaces:**
```tsx
export function RunRow({ run, selected, now, href }: { run: RunSummary; selected: boolean; now: number; href: string }): JSX.Element; // an <li> with a <Link>
export function RunFilterBar({ filters, onChange, channels }: { filters: RunFilters; onChange: (f: RunFilters) => void; channels: { channelId: string; name: string }[] }): JSX.Element;
export function RunList({ selectedId }: { selectedId: string | null }): JSX.Element; // owns filters (URL), the infinite query, j/k keys
```

- [ ] **Step 1: Failing row test**

`apps/web/test/run-row.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RunRow } from "@/components/runs/run-row";
import type { RunSummary } from "@/lib/api/runs";

const run: RunSummary = {
  id: "5f3b1c22-9d41-4a7e-8b02-1d6c4f0a91e3", origin: "slack", status: "awaiting_approval", shadow: false,
  summary: "checkout button does nothing on Android", channelId: "C1", channelName: "zellify-pulsefit",
  customerSlug: "pulsefit", createdAt: 0, updatedAt: 0, costUsd: "0.412700000", turns: 3, openApprovalId: "apr:1",
};

describe("RunRow", () => {
  it("shows summary, channel, spend and an attention mark for an open approval", () => {
    render(<ul><RunRow run={run} selected={false} now={600_000} href="/runs/x" /></ul>);
    expect(screen.getByText(/checkout button/)).toBeInTheDocument();
    expect(screen.getByText("#zellify-pulsefit")).toBeInTheDocument();
    expect(screen.getByText("$0.412700000")).toBeInTheDocument();
    expect(screen.getByLabelText("needs a decision")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/runs/x");
  });
  it("marks the selected row", () => {
    render(<ul><RunRow run={{ ...run, openApprovalId: null }} selected now={0} href="/runs/x" /></ul>);
    expect(screen.getByRole("link")).toHaveAttribute("aria-current", "page");
    expect(screen.queryByLabelText("needs a decision")).toBeNull();
  });
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: `run-row.tsx`**

```tsx
"use client";

import { StatusBadge } from "@workspace/ui/components/status-badge";
import { cn } from "@workspace/ui/lib/utils";
import { Hand } from "lucide-react";
import Link from "next/link";

import type { RunSummary } from "@/lib/api/runs";
import { ago, usd } from "@/lib/format";
import { runStatusBadge, SHADOW_BADGE } from "@/lib/status";

/** One run in the list. Dense: a status dot, one line of the customer's words, and the machine facts under it. */
export function RunRow({ run, selected, now, href }: { run: RunSummary; selected: boolean; now: number; href: string }) {
  const status = runStatusBadge(run.status);
  return (
    <li>
      <Link
        href={href}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "block rounded-md border border-transparent px-3 py-2 transition-colors hover:bg-muted/60",
          selected && "border-border bg-muted"
        )}
      >
        <div className="flex items-start gap-2">
          <StatusBadge variant="dot" tone={status.tone} pulse={status.pulse} className="mt-1.5" aria-label={status.label} />
          <div className="min-w-0 flex-1">
            <p className={cn("truncate text-sm", run.summary === null && "text-muted-foreground italic")}>
              {run.summary ?? "No summary yet"}
            </p>
            <div className="machine mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
              {run.channelName ? <span className="truncate">#{run.channelName}</span> : <span>{run.origin}</span>}
              <span aria-hidden="true">·</span>
              <span>{ago(run.updatedAt, now)}</span>
              <span aria-hidden="true">·</span>
              <span>{usd(run.costUsd)}</span>
              {run.shadow ? <StatusBadge tone={SHADOW_BADGE.tone} size="sm" mono className="ml-auto">shadow</StatusBadge> : null}
            </div>
          </div>
          {run.openApprovalId !== null ? (
            <Hand className="mt-1 size-3.5 shrink-0 text-attention" aria-label="needs a decision" />
          ) : null}
        </div>
      </Link>
    </li>
  );
}
```

- [ ] **Step 4: `run-filters.tsx`**

Search input + chips. Use `Input` (search, `aria-label="Search runs"`, debounced 250 ms before `onChange`), a `Select` for status (All / live / needs you / idle / done / failed), a `Select` for origin (Any / slack / chat), a `Select` for channel (Any + `channels`), and a three-way `shadow` toggle (Any / only shadow / hide shadow) using three small `Button variant="ghost"`s. A "Clear" button appears when `activeFilterCount > 0 || q !== ""` and calls `onChange(EMPTY_FILTERS)`. Every control writes through `withFilter`.

- [ ] **Step 5: `run-list.tsx`**

```tsx
"use client";

import { Button } from "@workspace/ui/components/button";
import { ScrollArea } from "@workspace/ui/components/scroll-area";
import { Plus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Panel } from "@/components/common/panel";
import { useChannels } from "@/lib/hooks/use-channels";
import { useNow } from "@/lib/hooks/use-now";
import { useRunsPage } from "@/lib/hooks/use-runs-page";
import { filtersToSearch, parseRunFilters, type RunFilters, toListParams } from "@/lib/runs/filters";
import { NewRunDialog } from "./new-run-dialog";
import { RunFilterBar } from "./run-filters";
import { RunRow } from "./run-row";

export function RunList({ selectedId }: { selectedId: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const filters = useMemo(() => parseRunFilters(search), [search]);
  const setFilters = useCallback(
    (next: RunFilters) => {
      const s = filtersToSearch(next).toString();
      router.replace(`${pathname}${s ? `?${s}` : ""}`);
    },
    [router, pathname]
  );

  const now = useNow();
  const { state, fetchNext, hasNext, loadingNext } = useRunsPage(toListParams(filters));
  const channels = useChannels();
  const channelOptions =
    channels.state.kind === "ready" ? channels.state.data.map((c) => ({ channelId: c.channelId, name: c.name })) : [];

  // Every row keeps the current filters in its href, so selection never drops them.
  const hrefFor = (id: string) => {
    const s = filtersToSearch(filters).toString();
    return `/runs/${encodeURIComponent(id)}${s ? `?${s}` : ""}`;
  };

  // j / k move the selection; ignored while typing.
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (state.kind !== "ready") return;
    const ids = state.data.map((r) => r.id);
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.key !== "j" && event.key !== "k") return;
      const at = selectedId === null ? -1 : ids.indexOf(selectedId);
      const next = event.key === "j" ? Math.min(ids.length - 1, at + 1) : Math.max(0, at - 1);
      const id = ids[next];
      if (id !== undefined && id !== selectedId) router.push(hrefFor(id));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b p-3">
        <h2 className="eyebrow flex-1">Runs</h2>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus /> New run
        </Button>
      </div>
      <div className="border-b p-3">
        <RunFilterBar filters={filters} onChange={setFilters} channels={channelOptions} />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <Panel title="Runs" state={state} bare>
          {(runs) => (
            <ul className="space-y-0.5 p-2">
              {runs.map((run) => (
                <RunRow key={run.id} run={run} selected={run.id === selectedId} now={now} href={hrefFor(run.id)} />
              ))}
              {hasNext ? (
                <li className="p-2">
                  <Button variant="ghost" size="sm" className="w-full" onClick={fetchNext} disabled={loadingNext}>
                    {loadingNext ? "Loading…" : "Load more"}
                  </Button>
                </li>
              ) : null}
            </ul>
          )}
        </Panel>
      </ScrollArea>
      <NewRunDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
```

(Infinite scroll via `IntersectionObserver` on the "Load more" row is a nicety; the button is the floor. Add the observer: `useEffect` that observes a sentinel `div` and calls `fetchNext` when `isIntersecting && hasNext && !loadingNext`.)

- [ ] **Step 6: Verify** — `npx vitest run test/run-row.test.tsx && pnpm typecheck` (the `NewRunDialog` import will fail typecheck until Task 15 — create that file in Task 15 before running the full typecheck, or create a stub now that renders `null`).

### Task 13: `RunInspector`

**Files:**
- Create: `apps/web/components/runs/run-inspector.tsx`
- Create: `apps/web/test/run-inspector.test.tsx`

**Interfaces:**
```tsx
export function RunInspector({ run, now }: { run: RunDetail; now: number }): JSX.Element;
```
Reads `useRunUsage(run.id)` (existing, returns the total string), `useRunApprovals(run.id)`, `useRunEffects(run.id)`.

- [ ] **Step 1: Failing test** — render with `isDemo()` forced on (set `process.env.NEXT_PUBLIC_DEMO = "1"` before importing, as `test/api-client.test.ts` does) inside a `QueryClientProvider`, for the demo macrosnap run id; assert the PR link `https://github.com/Zellify/web2app-rebuild/pull/1287` renders as an `<a target="_blank" rel="noreferrer">`, the "Did" section lists `github.openPullRequest`, and the spend line shows `$` + `demoUsageTotals[id]`. Use `waitFor` from Testing Library for the fixture latency.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**

```tsx
"use client";

import { Skeleton } from "@workspace/ui/components/skeleton";
import { ExternalLink } from "lucide-react";

import { SpecBadge } from "@/components/common/badge";
import { CopyId } from "@/components/common/copy-id";
import { Panel } from "@/components/common/panel";
import type { RunDetail } from "@/lib/api/runs";
import { effectUrl, type RunEffect } from "@/lib/api/effects";
import { ago, shortThread, usd } from "@/lib/format";
import { useRunApprovals, useRunEffects, useRunUsage } from "@/lib/hooks/use-dashboard-data";
import { decisionBadge, effectStateBadge, originBadge, runStatusBadge, SHADOW_BADGE } from "@/lib/status";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <dt className="eyebrow">{label}</dt>
      <dd className="machine min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

function groupByNamespace(effects: RunEffect[]): Map<string, RunEffect[]> {
  const out = new Map<string, RunEffect[]>();
  for (const e of effects) out.set(e.namespace, [...(out.get(e.namespace) ?? []), e]);
  return out;
}

export function RunInspector({ run, now }: { run: RunDetail; now: number }) {
  const usage = useRunUsage(run.id);
  const approvals = useRunApprovals(run.id);
  const effects = useRunEffects(run.id);

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto p-4">
      <section className="space-y-2">
        <div className="flex flex-wrap gap-1.5">
          <SpecBadge spec={runStatusBadge(run.status)} />
          <SpecBadge spec={originBadge(run.origin)} />
          {run.shadow ? <SpecBadge spec={SHADOW_BADGE} /> : null}
        </div>
        <dl className="space-y-1.5">
          <Row label="Run"><CopyId value={run.id} label="run id" truncate /></Row>
          {run.channelId ? <Row label="Channel">{run.channelId}</Row> : null}
          {run.threadTs ? <Row label="Thread">{shortThread(run.threadTs)}</Row> : null}
          <Row label="Started">{ago(run.createdAt, now)}</Row>
          <Row label="Last activity">{ago(run.updatedAt, now)}</Row>
          <Row label="Spend">
            {usage.kind === "ready" ? usd(usage.data) : usage.kind === "error" ? "unavailable" : <Skeleton className="inline-block h-3 w-12" />}
          </Row>
        </dl>
      </section>

      <Panel title="Did" state={effects} bare>
        {(rows) => (
          <ul className="space-y-3">
            {[...groupByNamespace(rows)].map(([ns, list]) => (
              <li key={ns} className="space-y-1">
                <p className="eyebrow">{ns}</p>
                <ul className="space-y-1">
                  {list.map((e, i) => {
                    const url = effectUrl(e);
                    return (
                      <li key={`${e.turnId}:${i}`} className="flex items-center gap-2 text-xs">
                        <span className="machine truncate">{e.method}</span>
                        <SpecBadge spec={effectStateBadge(e.state)} size="sm" className="ml-auto" />
                        {url ? (
                          <a href={url} target="_blank" rel="noreferrer" className="text-foreground underline-offset-4 hover:underline" aria-label={`open ${e.method} result`}>
                            <ExternalLink className="size-3" />
                          </a>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Approvals" state={approvals} bare>
        {(rows) => (
          <ul className="space-y-2">
            {rows.map((a) => (
              <li key={a.id} className="space-y-1 rounded-md border p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <SpecBadge spec={decisionBadge(a.decision)} />
                  <span className="machine text-muted-foreground">{ago(a.decidedAt ?? a.createdAt, now)}</span>
                </div>
                {a.decidedBy ? <p className="machine text-muted-foreground">{a.decidedBy}</p> : null}
                {a.rejectReason ? <p className="text-pretty">{a.rejectReason}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
```

Effects with a URL are the "artifacts": the link is the whole feature (D20). Nothing is guessed from the method name.

- [ ] **Step 4: Run** → PASS.

### Task 14: Chip strip in the transcript, Cancel in the run view

**Files:**
- Modify: `apps/web/components/run/transcript.tsx` (accept `chips`), `run-view.tsx` (cancel), `run-session.tsx`, `run-panel.tsx`, `lib/hooks/use-run-agent.ts`
- Modify: `apps/web/test/transcript.test.tsx`, `apps/web/test/run-view.test.tsx`

**Interfaces:**
```ts
// transcript.tsx
export function Transcript({ messages, chips }: { messages: readonly TranscriptMessage[]; chips?: ReadonlyMap<string, readonly string[]> }): JSX.Element;
export function turnIdOf(message: TranscriptMessage): string | null;   // message.metadata?.turnId (user messages), else null
// run-view.tsx
RunViewProps += { chips?: ReadonlyMap<string, readonly string[]>; canCancel: boolean; onCancel: () => void; cancelling: boolean }
// use-run-agent.ts
RunAgentView += { cancel: () => Promise<void> }
```

- [ ] **Step 1: Failing tests**

In `test/transcript.test.tsx` add:

```tsx
it("shows a capability chip strip on the tool row that follows a user turn", () => {
  const messages = [
    { id: "turn:1", role: "user", parts: [{ type: "text", text: "fix it" }], metadata: { turnId: "turn:1" } },
    { id: "a1", role: "assistant", parts: [{ type: "tool-run_code", state: "output-available", input: { code: "1" }, output: "ok" }] },
  ];
  render(<Transcript messages={messages} chips={new Map([["turn:1", ["slack.post", "supabase.read ×3"]]])} />);
  expect(screen.getByText("slack.post")).toBeInTheDocument();
  expect(screen.getByText("supabase.read ×3")).toBeInTheDocument();
});

it("falls back to the code length when no effects match the turn", () => {
  const messages = [
    { id: "a1", role: "assistant", parts: [{ type: "tool-run_code", state: "output-available", input: { code: "abcdef" }, output: "ok" }] },
  ];
  render(<Transcript messages={messages} chips={new Map()} />);
  expect(screen.getByText("run_code · 6 chars")).toBeInTheDocument();
});
```

(Extend `TranscriptMessage` with `metadata?: unknown` so the fixture typechecks.) In `test/run-view.test.tsx` add:

```tsx
it("offers Cancel only while it can, and confirms before sending it", async () => {
  const onCancel = vi.fn();
  const user = userEvent.setup();
  const { rerender } = render(<RunView {...base} canCancel onCancel={onCancel} cancelling={false} />);
  await user.click(screen.getByRole("button", { name: "Cancel run" }));
  await user.click(screen.getByRole("button", { name: "Yes, stop it" }));
  expect(onCancel).toHaveBeenCalledOnce();
  rerender(<RunView {...base} canCancel={false} onCancel={onCancel} cancelling={false} />);
  expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
});
```

(`base` = the props object the file already uses for its other cases; add the three new props to it with `canCancel: false`.)

- [ ] **Step 2: Run** → FAIL. **Step 3: Transcript**

In `transcript.tsx`: add `metadata?: unknown` to `TranscriptMessage`; add

```ts
export function turnIdOf(message: TranscriptMessage): string | null {
  const meta = message.metadata;
  if (typeof meta !== "object" || meta === null) return null;
  const id = (meta as { turnId?: unknown }).turnId;
  return typeof id === "string" && id !== "" ? id : null;
}
```

`Transcript` walks messages keeping `currentTurn` (the last user message's `turnIdOf`, or its `id` when there is no metadata) and passes `chips?.get(currentTurn) ?? null` to `MessageRow` → `ToolRow`. In `ToolRow`, replace the `<span className="machine text-xs">{toolNameOf(part)}</span>` with:

```tsx
{chips && chips.length > 0 ? (
  <span className="flex min-w-0 flex-wrap gap-1">
    {chips.map((c) => (
      <StatusBadge key={c} tone="neutral" variant="outline" size="sm" mono>{c}</StatusBadge>
    ))}
  </span>
) : (
  <span className="machine text-xs">
    {toolNameOf(part)}{typeof code === "string" ? ` · ${code.length} chars` : ""}
  </span>
)}
```

- [ ] **Step 4: Cancel**

`use-run-agent.ts`: add `const cancel = useCallback(() => agent.call("cancel", []).then(() => undefined), [agent]);` and return it. `run-view.tsx`: add the three props; render, above the composer's hint line, when `canCancel`:

```tsx
<Popover>
  <PopoverTrigger render={<Button variant="outline" size="sm" disabled={cancelling} />}>
    <Square /> Cancel run
  </PopoverTrigger>
  <PopoverContent className="w-64 space-y-2 text-sm">
    <p>Stops the turn in flight. The run stays where it is — a human stopping it is not it failing.</p>
    <Button size="sm" variant="destructive" onClick={onCancel} aria-label="Yes, stop it">Yes, stop it</Button>
  </PopoverContent>
</Popover>
```

`run-session.tsx`: `canCancel={run.status === "live"}`, `onCancel={() => { setCancelling(true); void run.cancel().then(() => toast("Cancel sent")).catch(() => toast.error("Could not cancel")).finally(() => setCancelling(false)); }}`, `chips={chipsByTurn(effects)}` where `effects` comes from `useRunEffects(runId)` (`state.kind === "ready" ? state.data : []`). `run-panel.tsx` (demo branch): `canCancel={false}`, `chips={chipsByTurn(demoEffectsFor(runId))}`.

- [ ] **Step 5: Run** → `npx vitest run test/transcript.test.tsx test/run-view.test.tsx` PASS; `pnpm typecheck` PASS.

### Task 15: The `/runs` split view, `NewRunDialog`, and the end of `/chat`

**Files:**
- Create: `apps/web/app/runs/layout.tsx`, `apps/web/app/runs/page.tsx`, `apps/web/components/runs/new-run-dialog.tsx`
- Rewrite: `apps/web/app/runs/[id]/page.tsx`
- Delete: `apps/web/app/chat/`, `apps/web/components/chat/`, `apps/web/components/dashboard/runs-feed.tsx`, `run-sheet.tsx`, `apps/web/lib/hooks/use-selected-run.ts`
- Modify: `apps/web/lib/hooks/use-dashboard-data.ts` (remove `useRuns`), `lib/query/keys.ts` (remove `runs(limit)`)

- [ ] **Step 1: `NewRunDialog`**

Port the body of `app/chat/page.tsx` (its `makeChatStarter` memo, `tooLong`, `canStart`, `start`, Enter handling, the error alert) into a `Dialog` with `DialogTitle` "New run", a `Textarea min-h-40`, the hint row and the "Ask" button. On success: `onOpenChange(false)` then `router.push(\`/runs/${encodeURIComponent(run.id)}\`)`. The four starter prompts from `chat-aside.tsx` become four small `Button variant="outline"` chips under the textarea that fill it. The `test/run-idempotency.test.ts` pins `makeChatStarter` and needs no change.

- [ ] **Step 2: `app/runs/layout.tsx`**

```tsx
"use client";

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@workspace/ui/components/resizable";
import { useParams } from "next/navigation";
import { Suspense } from "react";

import { RunList } from "@/components/runs/run-list";

/** The workbench. The list is the layout so it survives navigating between runs; the run is the page. */
export default function RunsLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id?: string }>();
  const selectedId = typeof params.id === "string" ? params.id : null;
  return (
    <div className="h-[calc(100svh-3.5rem)]">
      <ResizablePanelGroup direction="horizontal" autoSaveId="runs-workbench" className="h-full">
        <ResizablePanel defaultSize={26} minSize={18} maxSize={40} className={selectedId ? "hidden lg:block" : ""}>
          <Suspense fallback={null}>
            <RunList selectedId={selectedId} />
          </Suspense>
        </ResizablePanel>
        <ResizableHandle withHandle className="hidden lg:flex" />
        <ResizablePanel className={selectedId ? "" : "hidden lg:block"}>{children}</ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
```

- [ ] **Step 3: `app/runs/page.tsx`** — auto-select the newest:

```tsx
"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { useRunsPage } from "@/lib/hooks/use-runs-page";
import { parseRunFilters, toListParams } from "@/lib/runs/filters";

export default function RunsIndexPage() {
  const router = useRouter();
  const search = useSearchParams();
  const { state } = useRunsPage(toListParams(parseRunFilters(search)));
  useEffect(() => {
    if (state.kind !== "ready") return;
    const first = state.data[0];
    if (first) router.replace(`/runs/${encodeURIComponent(first.id)}${search.size ? `?${search}` : ""}`);
  }, [state, router, search]);
  return (
    <div className="hidden h-full items-center justify-center p-6 text-muted-foreground text-sm lg:flex">
      {state.kind === "empty" ? "No runs match these filters." : "Pick a run."}
    </div>
  );
}
```

- [ ] **Step 4: `app/runs/[id]/page.tsx`** — the transcript + inspector:

Keep the `useQuery(queryKeys.run(id))` header read. Layout:

```tsx
<div className="flex h-full min-h-0">
  <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex items-center gap-2 border-b px-4 py-2">
      <Link href="/runs" className="lg:hidden ..."><ArrowLeft /> Runs</Link>
      <h1 className="min-w-0 flex-1 truncate font-medium text-sm">{run.data?.summary ?? <span className="text-muted-foreground italic">No summary yet</span>}</h1>
      <Button variant="ghost" size="sm" onClick={() => setInspector((v) => !v)} aria-pressed={inspector} aria-label="Toggle details"><PanelRight /></Button>
    </header>
    {isDemo() ? <DemoNotice /> : null}
    <div className="min-h-0 flex-1 p-4">
      <ErrorBoundary message="This transcript could not be rendered." resetKey={id}>
        <RunPanel runId={id} approvals={<RunApprovals runId={id} role={identity?.role ?? "viewer"} />} />
      </ErrorBoundary>
    </div>
  </div>
  {inspector && run.data ? (
    <aside className="hidden w-72 shrink-0 border-l xl:block"><RunInspector run={run.data} now={now} /></aside>
  ) : null}
</div>
```

`inspector` is `useState(true)` initialised from `localStorage["runs.inspector"]` inside a `useEffect` (never during render — hydration), written back on toggle, both in `try/catch`.

- [ ] **Step 5: Delete** the files listed above; remove `useRuns` and `queryKeys.runs`; `grep -rn "use-selected-run\|runs-feed\|run-sheet\|/chat\"" apps/web` must be empty (the sidebar no longer links `/chat`). Next's router will 404 `/chat` — acceptable; nothing links to it.

- [ ] **Step 6: Verify and commit**

`cd apps/web && npx vitest run && pnpm typecheck && pnpm build`, then `pnpm check` at the root. Demo walkthrough: `/runs` selects the newest; filters change the URL and the list; `j`/`k` move; New run opens the dialog; a run shows chips on tool rows, the inspector shows spend/Did/Approvals; the inspector toggle persists across reload.

ASK THE USER, then:

```bash
git add apps/web packages/ui
git commit -m "feat(web): six-page shell and the /runs workbench — list, transcript with capability chips, inspector, cancel"
```

---

## Part 4 — Overview and Approvals (commit 4)

### Task 16: Overview — attention row, fixed funnel, recent runs

**Files:**
- Create: `apps/web/components/dashboard/attention-row.tsx`
- Rewrite: `apps/web/components/dashboard/funnel-strip.tsx`
- Rewrite: `apps/web/app/page.tsx`
- Create: `apps/web/test/funnel-strip.test.tsx`

- [ ] **Step 1: Failing funnel-strip test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FunnelStrip } from "@/components/dashboard/funnel-strip";

const ready = {
  kind: "ready" as const,
  data: {
    counters: { heard: 148, ingested: 140, triaged: 140, woken: 17, dropped: 123, escalated: 1 },
    since: 0,
    window: "24h" as const,
  },
};

describe("FunnelStrip", () => {
  it("renders four counted stages, dropped as a caption, and never the text NaN", () => {
    const { container } = render(<FunnelStrip state={ready} window="24h" onWindow={() => {}} />);
    expect(screen.getByText("148")).toBeInTheDocument();
    expect(screen.getByText("123 dropped")).toBeInTheDocument();
    expect(container.textContent).not.toContain("NaN");
    for (const bar of container.querySelectorAll<HTMLElement>("[data-slot=funnel-bar]")) {
      expect(bar.style.width).toMatch(/^\d+(\.\d+)?%$/);
    }
  });
  it("says quiet when nothing was heard", () => {
    render(<FunnelStrip state={{ ...ready, data: { ...ready.data, counters: { heard: 0, ingested: 0, triaged: 0, woken: 0, dropped: 0, escalated: 0 } } }} window="24h" onWindow={() => {}} />);
    expect(screen.getByText(/Quiet/)).toBeInTheDocument();
  });
  it("offers the two windows", () => {
    const onWindow = vi.fn();
    render(<FunnelStrip state={ready} window="24h" onWindow={onWindow} />);
    screen.getByRole("button", { name: "7d" }).click();
    expect(onWindow).toHaveBeenCalledWith("7d");
  });
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: `funnel-strip.tsx`**

Props: `{ state: PanelState<Counters>; window: CountersWindow; onWindow: (w: CountersWindow) => void }`. Body: `SectionHeader eyebrow={`Last ${window}`} title="How little reaches a human" action={<two Buttons variant ghost/secondary "24h" "7d", aria-pressed>}`; when `isQuiet` → `<Empty>` "Quiet — nothing was heard in this window. That is the good outcome."; else a 4-column grid of `funnelStages(...)`: big `machine` number, label, a `data-slot="funnel-bar"` div with `style={{ width: \`${Math.max(stage.ratio * 100, 0.8)}%\` }}` (ratio is always finite now), the escalated stage in `text-attention`/`bg-attention`, others `bg-muted-foreground/60`. Under "triaged": `<p className="text-muted-foreground text-[11px] italic">{c.dropped} dropped</p>`. Footer: the `since` time as today.

- [ ] **Step 4: `attention-row.tsx`**

Three `Card`s in a `grid gap-4 sm:grid-cols-3`, each a `Link`:
1. **Waiting on you** — `useApprovals()`: big `openCount` in `text-attention` when > 0, else muted "0"; subline "oldest {ago(min createdAt)}" or "you're clear"; href `/approvals`.
2. **Live runs** — `useRunsPage({})` first page: count of `live` + `awaiting_approval`; subline "{n} needs you"; href `/runs?status=live`.
3. **Speaks as** — `useRoster()`: `nameOf(speaker.email)` + `<SpecBadge spec={connectBadge(true,"slack")} size="sm"/>` etc. for the speaker's own row in `engineers`; when `speaker === null` the card takes `border-destructive/50` and reads "Nobody connected — every customer-facing reply is refused"; href `/team`.

- [ ] **Step 5: `app/page.tsx`**

```tsx
"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";

import { AttentionRow } from "@/components/dashboard/attention-row";
import { FunnelStrip } from "@/components/dashboard/funnel-strip";
import { SectionHeader } from "@/components/common/section-header";
import { Panel } from "@/components/common/panel";
import { RunRow } from "@/components/runs/run-row";
import type { CountersWindow } from "@/lib/api/counters";
import { useCounters } from "@/lib/hooks/use-dashboard-data";
import { useNow } from "@/lib/hooks/use-now";
import { useRunsPage } from "@/lib/hooks/use-runs-page";

export default function OverviewPage() {
  const search = useSearchParams();
  const router = useRouter();
  useEffect(() => {
    const approval = search.get("approval");
    if (approval) router.replace(`/approvals?approval=${encodeURIComponent(approval)}`);
  }, [search, router]);

  const [window, setWindow] = useState<CountersWindow>(search.get("window") === "7d" ? "7d" : "24h");
  const counters = useCounters(window);
  const recent = useRunsPage({ limit: 8 });
  const now = useNow();

  return (
    <div className="mx-auto w-full max-w-7xl space-y-8 p-6">
      <AttentionRow />
      <FunnelStrip state={counters} window={window} onWindow={setWindow} />
      <section className="space-y-3">
        <SectionHeader eyebrow="Recent" title="Runs" action={<Link href="/runs" className="text-sm underline-offset-4 hover:underline">See all →</Link>} />
        <Panel title="Recent runs" state={recent.state} bare>
          {(runs) => (
            <ul className="divide-y rounded-lg border">
              {runs.slice(0, 8).map((run) => (
                <RunRow key={run.id} run={run} selected={false} now={now} href={`/runs/${encodeURIComponent(run.id)}`} />
              ))}
            </ul>
          )}
        </Panel>
      </section>
    </div>
  );
}
```

Delete `speaker-hero.tsx` only if `/team` (Task 18) no longer uses it — Task 18 keeps its refusal banner, so keep the file until then.

- [ ] **Step 6: Verify** — `npx vitest run test/funnel-strip.test.tsx && pnpm typecheck`; demo: `/` fits a 1366×768 window without scrolling.

### Task 17: `/approvals` — the queue, the Decided list, and no more reconcile branch

**Files:**
- Rewrite: `apps/web/app/approvals/page.tsx`
- Create: `apps/web/components/dashboard/decided-list.tsx`
- Modify: `apps/web/components/dashboard/approvals-queue.tsx` (drop the `Panel` card chrome; oldest first)
- Modify: `apps/web/lib/hooks/use-approvals.ts`, `apps/web/lib/store/approvals-overlay.ts`, `apps/web/test/approvals-overlay.test.ts`

- [ ] **Step 1: Failing test for the simplified overlay**

In `test/approvals-overlay.test.ts` add:

```ts
it("no longer carries a reconcile set — a vanished card is explained by the decided list", () => {
  const s = useApprovalsOverlay.getState() as Record<string, unknown>;
  expect("claimReconcile" in s).toBe(false);
  expect("reconciled" in s).toBe(false);
});
```

and delete any existing case that exercises `claimReconcile`/`hold`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Delete the branch**

`approvals-overlay.ts`: remove `reconciled`, `claimReconcile`, `hold`, and the `reconciled` reset. `use-approvals.ts`: delete the "Vanish reconciliation" `useEffect`, `lastRowRef`, `previousIdsRef`, and the opportunistic `fetchQuery(getApproval)` in the 409 branch — the 409 body now names the winner: `resolve(card, result.decision, result.decidedBy, false)` and nothing else. Keep `nameDecider` only if something still calls it; otherwise delete it too. A card that another person decided simply leaves the open list on the next poll and appears in the Decided list below — that is the honest replacement for the held card.

- [ ] **Step 4: `decided-list.tsx`**

```tsx
"use client";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { SpecBadge } from "@/components/common/badge";
import { Panel } from "@/components/common/panel";
import { ago, nameOf } from "@/lib/format";
import { useDecidedApprovals } from "@/lib/hooks/use-dashboard-data";
import { useNow } from "@/lib/hooks/use-now";
import { decisionBadge } from "@/lib/status";

const DAY = 86_400_000;

export function DecidedList() {
  const [open, setOpen] = useState(false);
  const now = useNow();
  // Rounded to the minute so the key (and the request) is not new on every render.
  const since = Math.floor((Date.now() - DAY) / 60_000) * 60_000;
  const state = useDecidedApprovals(since);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 text-sm">
        <ChevronRight className={open ? "size-4 rotate-90 transition-transform" : "size-4 transition-transform"} />
        <span className="eyebrow">Decided in the last 24h</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3">
        <Panel title="Decided" state={state} bare>
          {(rows) => (
            <ul className="divide-y rounded-lg border">
              {rows.map((a) => (
                <li key={a.id} className="grid grid-cols-[auto_1fr_auto] items-start gap-3 p-3 text-sm">
                  <SpecBadge spec={decisionBadge(a.decision)} />
                  <div className="min-w-0">
                    <p className="line-clamp-2 text-pretty">{a.editedText ?? a.draft}</p>
                    {a.rejectReason ? <p className="mt-1 text-muted-foreground text-xs">{a.rejectReason}</p> : null}
                    <Link href={`/runs/${encodeURIComponent(a.runId)}`} className="machine mt-1 inline-block text-[11px] text-muted-foreground underline-offset-4 hover:underline">open run</Link>
                  </div>
                  <div className="machine text-right text-[11px] text-muted-foreground">
                    <div>{a.decidedBy ? nameOf(a.decidedBy) : "—"}</div>
                    <div>{ago(a.decidedAt ?? a.updatedAt, now)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </CollapsibleContent>
    </Collapsible>
  );
}
```

- [ ] **Step 5: Page**

`app/approvals/page.tsx`: container; `SectionHeader eyebrow="Waiting on you" title="Approve what the agent may send" description="Approving sends the reply to Slack under a fire-fighter's own account."`; `<ApprovalsQueue role=… />` (change its sort to OLDEST first — `a.card.createdAt - b.card.createdAt` — the one that has waited longest is on top; make `Panel bare`), then `<DecidedList />`. The `?approval=` scroll/ring logic stays inside `ApprovalsQueue` untouched. Replace the `bg-primary` count pill with `bg-attention text-attention-foreground`.

- [ ] **Step 6: Verify and commit**

`npx vitest run && pnpm typecheck` in `apps/web`; `pnpm check` at root. Demo: `/approvals?approval=<demo id>` scrolls and rings; deciding a card shows the resolved note then it moves to Decided.

ASK THE USER, then:

```bash
git add apps/web
git commit -m "feat(web): overview with attention row and a funnel that cannot NaN; /approvals with a decided list; 409 names the winner"
```

---

## Part 5 — Team, Channels, Eval, ⌘K, docs (commit 5)

### Task 18: `/team`

**Files:**
- Rewrite: `apps/web/app/team/page.tsx`
- Modify: `apps/web/components/dashboard/team-table.tsx` (add the "speaks by default" marker column and the caption), `speaker-hero.tsx` (reduce to `RefusalBanner` exported from the same file, rendered only when `speaker === null`)
- Keep unchanged: `token-explainer.tsx`, `nudge-preview.tsx`, `connect-state.tsx`

- [ ] **Step 1:** `team-table.tsx`: take an extra prop `speaker: string | null`; in the person cell render `<SpecBadge spec={{ tone: "attention", label: "speaks by default", meaning: "Direct replies and the nudge DM go out under this account." }} size="sm" />` when `email === speaker`; replace the Slack/GitHub cells' text with `<SpecBadge spec={connectBadge(row.slack, "slack")} />` (self rows keep the OAuth `<a>` from `connect-state.tsx` next to it). Add `<caption className="eyebrow text-left pb-2">Tie-break: the approver if they connected Slack, else the first connected fire-fighter in roster order.</caption>`.
- [ ] **Step 2:** `speaker-hero.tsx`: export `RefusalBanner({ state })` — the existing refusal copy in an `Alert variant="destructive"`; returns null when a speaker exists. Delete the rest of the hero.
- [ ] **Step 3:** page: `SectionHeader eyebrow="Roster" title="Who the agent speaks as"`; `<RefusalBanner state={roster} />`; `<TeamTable state={roster} identity={identity} speaker={roster.kind === "ready" ? roster.data.speaker?.email ?? null : null} />`; then a `Collapsible` "How this works" containing `<TokenExplainer />` and `<NudgePreview />` in a `grid lg:grid-cols-2 gap-4`.
- [ ] **Step 4:** `npx vitest run && pnpm typecheck`; demo renders; `grep -rn "SpeakerHero" apps/web` is empty.

### Task 19: `/channels`

**Files:**
- Rewrite: `apps/web/app/channels/page.tsx`
- Modify: `apps/web/components/dashboard/channels-panel.tsx` (accept `query: string`, `mode: ChannelMode | null` props and filter client-side; `UnconfirmedMark` tooltip text)

- [ ] **Step 1:** `ChannelsPanel` filters `rows` by `name.includes(query)` (case-insensitive) and `mode`; the `UnconfirmedMark` tooltip becomes: "Customer key derived from the channel name, not confirmed by a person. Until a fire-fighter confirms it, tenant-scoped Supabase reads for this channel are refused (`customer_scope_unverified`)."
- [ ] **Step 2:** page: `SectionHeader eyebrow="Registry" title="Channels" description="New channels register themselves on their first message and default to live. A human decides mode and customer key; nothing here is ever deleted."`; an `Input` (search) and a `Select` for mode (Any / observe / live / internal) above the panel, state in `useState`.
- [ ] **Step 3:** `test/channels.test.ts` still passes; demo renders.

### Task 20: `/eval` — Shadow and Triage tabs

**Files:**
- Rewrite: `apps/web/app/eval/page.tsx`
- Create: `apps/web/components/eval/triage-score.tsx`, `apps/web/test/triage-score.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TriageScoreView } from "@/components/eval/triage-score";

describe("TriageScoreView", () => {
  it("renders percentages and never NaN", () => {
    const { container } = render(
      <TriageScoreView report={{ score: { n: 212, truePos: 15, falsePos: 4, falseNeg: 2, trueNeg: 191, precision: 15 / 19, recall: 15 / 17 }, windowDays: 30, unripeExcluded: 6, truncated: false }} />
    );
    expect(screen.getByText("78.9%")).toBeInTheDocument();
    expect(screen.getByText("88.2%")).toBeInTheDocument();
    expect(container.textContent).not.toContain("NaN");
  });
  it("says not measured for a null rate", () => {
    render(
      <TriageScoreView report={{ score: { n: 0, truePos: 0, falsePos: 0, falseNeg: 0, trueNeg: 0, precision: null, recall: null }, windowDays: 7, unripeExcluded: 0, truncated: false }} />
    );
    expect(screen.getAllByText("not measured")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**

```tsx
import type { TriageReport } from "@/lib/api/eval";

function pct(v: number | null): string {
  return v === null ? "not measured" : `${(v * 100).toFixed(1)}%`;
}

export function TriageScoreView({ report }: { report: TriageReport }) {
  const s = report.score;
  const cells: [string, string, string][] = [
    ["precision", pct(s.precision), "Of the wakes, how many a human agreed with."],
    ["recall", pct(s.recall), "Of the threads a human answered, how many triage woke on."],
    ["decisions", String(s.n), `Ripe decisions in ${report.windowDays} days; ${report.unripeExcluded} too recent to score.`],
  ];
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        {cells.map(([label, value, meaning]) => (
          <div key={label} className="rounded-lg border p-4">
            <p className="eyebrow">{label}</p>
            <p className="machine mt-1 font-medium text-2xl">{value}</p>
            <p className="mt-1 text-muted-foreground text-xs">{meaning}</p>
          </div>
        ))}
      </div>
      <dl className="machine grid grid-cols-4 gap-2 text-xs text-muted-foreground">
        <div><dt>true pos</dt><dd>{s.truePos}</dd></div>
        <div><dt>false pos</dt><dd>{s.falsePos}</dd></div>
        <div><dt>false neg</dt><dd>{s.falseNeg}</dd></div>
        <div><dt>true neg</dt><dd>{s.trueNeg}</dd></div>
      </dl>
      {report.truncated ? <p className="text-muted-foreground text-xs">Capped at 5,000 rows; the window is larger than what was scored.</p> : null}
    </div>
  );
}
```

- [ ] **Step 4: Page** — `Tabs defaultValue="shadow"`: `TabsTrigger` "Shadow" → `<ShadowPanel />` (bare); "Triage" → a `Select` for days (7/30/90, `useState<TriageDays>(30)`) and `<Panel title="Triage" state={useTriageScore(days)} bare>{(r) => <TriageScoreView report={r} />}</Panel>`.
- [ ] **Step 5:** `npx vitest run test/triage-score.test.tsx` → PASS.

### Task 21: ⌘K command palette

**Files:**
- Create: `apps/web/components/common/command-palette.tsx`, `apps/web/lib/palette.ts`, `apps/web/test/palette.test.ts`
- Modify: `apps/web/components/shell/site-header.tsx` (a "⌘K" button that opens it), `apps/web/components/shell/providers.tsx` or `app-shell.tsx` (mount once)

- [ ] **Step 1: Failing test** for the pure index:

```ts
import { describe, expect, it } from "vitest";
import { paletteItems } from "@/lib/palette";

describe("paletteItems", () => {
  it("lists pages, then runs, then approvals, each with an href and search text", () => {
    const items = paletteItems({
      runs: [{ id: "abc-123", summary: "checkout broken", channelName: "zellify-pulsefit", status: "live" }],
      approvals: [{ id: "apr:1", runId: "abc-123", draft: "We are on it" }],
    });
    expect(items[0].group).toBe("Pages");
    expect(items.find((i) => i.href === "/runs/abc-123")?.keywords).toContain("zellify-pulsefit");
    expect(items.find((i) => i.href === "/approvals?approval=apr:1")?.label).toMatch(/We are on it/);
  });
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** `lib/palette.ts`:

```ts
export type PaletteItem = { group: "Pages" | "Runs" | "Approvals"; label: string; href: string; keywords: string[] };

const PAGES: PaletteItem[] = [
  { group: "Pages", label: "Overview", href: "/", keywords: ["home", "dashboard"] },
  { group: "Pages", label: "Runs", href: "/runs", keywords: ["transcript"] },
  { group: "Pages", label: "Approvals", href: "/approvals", keywords: ["waiting", "decide"] },
  { group: "Pages", label: "Team", href: "/team", keywords: ["roster", "speaker"] },
  { group: "Pages", label: "Channels", href: "/channels", keywords: ["registry"] },
  { group: "Pages", label: "Eval", href: "/eval", keywords: ["shadow", "triage"] },
];

export function paletteItems(input: {
  runs: { id: string; summary: string | null; channelName: string | null; status: string }[];
  approvals: { id: string; runId: string; draft: string }[];
}): PaletteItem[] {
  return [
    ...PAGES,
    ...input.runs.map((r) => ({
      group: "Runs" as const,
      label: r.summary ?? `run ${r.id.slice(0, 8)}`,
      href: `/runs/${encodeURIComponent(r.id)}`,
      keywords: [r.id, r.channelName ?? "", r.status].filter(Boolean),
    })),
    ...input.approvals.map((a) => ({
      group: "Approvals" as const,
      label: a.draft.length > 60 ? `${a.draft.slice(0, 60)}…` : a.draft,
      href: `/approvals?approval=${encodeURIComponent(a.id)}`,
      keywords: [a.id, a.runId],
    })),
  ];
}
```

`command-palette.tsx`: `CommandDialog` from the added `command` primitive; global `keydown` listener for `(metaKey || ctrlKey) && key === "k"`; items from `paletteItems({ runs: first page of useRunsPage({}), approvals: open cards })`; `CommandGroup` per group; `onSelect` → `router.push(href)` and close. Header button: `<Button variant="outline" size="sm" onClick={open}><Search /> <kbd className="machine">⌘K</kbd></Button>`.

- [ ] **Step 4:** test passes; demo: ⌘K opens, typing a channel name finds the run.

### Task 22: Docs, final gate, commit

**Files:**
- Modify: `CLAUDE.md` (the `apps/web` paragraph: routes are now `/`, `/runs`, `/runs/[id]`, `/approvals`, `/team`, `/channels`, `/eval`; `/chat` is gone — the New-run dialog on `/runs` is the create form; theme is the tweakcn Vercel set in `apps/web/app/globals.css` with `--attention`; `StatusBadge` lives in `packages/ui`)
- Modify: `docs/superpowers/specs/2026-08-26-nextjs-frontend-design.md` — add an "Superseded 2026-08-28" note under §5 pointing at the new spec
- Modify: `apps/web/BACKEND-GAPS.md` §12 env table — no change to values; add a line that `apps/web` now has six routes
- Modify: `README.md` if it lists the dashboard's pages

- [ ] **Step 1:** Make the doc edits above. Keep every sentence about invariants that is still true; delete the ones about `?run=`, the run sheet, and `/chat`.
- [ ] **Step 2:** `pnpm format` at the root, then `pnpm check`. Fix anything Biome or tsc raises. Run `cd apps/web && pnpm build`.
- [ ] **Step 3:** Full demo walkthrough (`NEXT_PUBLIC_DEMO=1 pnpm dev`) of all six routes in both themes; note anything off and fix it in this task.
- [ ] **Step 4:** ASK THE USER, then:

```bash
git add apps/web CLAUDE.md README.md docs
git commit -m "feat(web): team, channels and eval pages, command palette; docs for the six-route dashboard"
```

- [ ] **Step 5: After merge — deploy and live check** (the user runs these; they are `workflow_dispatch`/Vercel): Worker deploy via `.github/workflows/deploy-worker.yml`, Vercel picks up `main`. Then on `https://firefighter.sayande.xyz`: the funnel shows numbers; `/runs` lists with spend; a run's inspector shows effects; a Slack Review button lands on `/approvals?approval=`.

---

## Self-review notes (2026-08-28)

- **Spec coverage:** §3 shell → Task 11 (+21 for ⌘K, +5 for the redirect target); §4 `/runs` → Tasks 9, 10, 12, 13, 14, 15; §5 → Tasks 16, 17; §6 → Tasks 18, 19, 20; §7 → Tasks 6, 7, 8; §8 → Tasks 1–5; §9/§10 → the five commit steps and Task 22.
- **Known judgment calls the executor should not re-litigate:** the runs list `refetchInterval` on an infinite query (accepted cost); `listRuns` return-shape change ripples into `test/run/repository.test.ts` (Task 2 says how); `useRuns` survives Tasks 9–14 and dies in Task 15; `speaker-hero.tsx` survives until Task 18.
- **Open verification in Task 8:** whether the `base-nova` registry serves `resizable` and `command`. The fallback is written into the task.

**2026-08-28 — Task 8's open verification, resolved.** Both `resizable` and
`command` ARE served by the `base-nova` registry; nothing was hand-written.
`command` pulls in `cmdk`, and `cmdk` has no Radix-free build — it declares a
hard runtime dependency on `@radix-ui/react-dialog`, which drags a further 15
`@radix-ui/*` packages into `pnpm-lock.yaml` (16 total, zero before this
task). No file this repo owns imports Radix: `command.tsx`'s `CommandDialog`
wrapper uses this repo's own `@base-ui/react`-backed `dialog.tsx`, never
`cmdk`'s own `Command.Dialog`. That transitive dependency is accepted, not
worked around — see the task's report for the empirical bundle check (a
temporary probe route rendering `Command` showed `@radix-ui/react-dialog`
code, including the distinctive `data-radix-focus-guard` attribute and
`DismissableLayer` internal name, in the client chunk; `cmdk`'s `index.mjs`
attaches `Dialog` to the same exported `Command` object via
`Object.assign(me, {..., Dialog: xe, ...})`, so the two are not
independently tree-shakeable and importing `Command` pulls `Dialog`'s Radix
usage along with it even when unreferenced). Also landed: `input-group.tsx`,
a file this task did not ask for but which arrives as `command`'s own
transitive registry dependency; it carries two `role="group"` divs that trip
`a11y/useSemanticElements` and one that trips `a11y/useKeyWithClickEvents`,
handled with a scoped `biome.jsonc` override rather than a rewrite of
vendored markup.
