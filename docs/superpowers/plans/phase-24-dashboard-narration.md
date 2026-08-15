# Phase 24 — Dashboard Narration and the Data We Already Hold — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard say what it knows — whose voice the agent is spending, which channel a draft is going to, what a run actually shipped — and fix the three defects that make it read as unfinished.

**Architecture:** Almost nothing new is computed. The facts are already in D1 (`channels.name`, `codemode_effects.safe_result_json`) or in pure functions (`identity/rotation.ts`), and are simply never joined into a response or rendered. Three small worker changes widen existing read routes; the dashboard then grows a lead on-duty card, a funnel-shaped counters panel, an approval card that names its target, and short "why it works this way" captions. No new subsystem, no new dependency except a self-hosted font.

**Tech Stack:** React 19, Vite 7, Tailwind v4 (CSS-first, `packages/ui/src/styles/globals.css`), Hono on Workers, D1, vitest + `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-08-10-firefighter-agent-design.md` §5.3 (approval surface), §10 (dashboard). Source of the target design: the reference prototype the manager supplied as a build request (claude.ai artifact `431fe837`), reviewed 2026-08-15. Roadmap: **no Phase 24 entry exists** — `00-roadmap.md` ends at 23. Add one as Task 12.

## Global Constraints

All of `00-roadmap.md` "Global Constraints" apply. The ones that bite here:

- **Triage never emits a ticket type.** It emits `{wake, why, opening_prompt}`. The reference prototype tags runs `Bug` / `Question` / `Feature · small` — **do not build that.** A type chip would smuggle the banned pipeline back in through the UI. Outcome chips (what the run *did*) are fine; classification chips (what the run *is*) are not.
- **Loading, empty and error states** are graded deliverables. Every new async region goes through `Panel` (`apps/dashboard/src/components/panel.tsx`) and its four `PanelState` cases.
- **Reads never wake a Durable Object** (invariant 7). Every route touched here is D1-only and must stay that way.
- **One origin, relative paths, no tokens in the bundle.** No CDN — a `<link>` to a font host would break the same-origin discipline and the Access gate.
- **Customer-facing copy:** direct, technical. This applies to the narration captions too — they explain a mechanism, they do not sell it.
- **Commit after every task.** Conventional prefixes.

## Depends on

Phases 11 (approvals API), 12 (rotation + OAuth), 14 (`Panel`, `usePoll`, `api.ts`), 15 (run list + drawer), 16 (approval card), 20 (the `github` namespace, whose `openPR` result this reads). All merged.

## Outcome

- The page leads with **who is on duty and that the agent is speaking as them** — a fact currently rendered nowhere.
- An approval card names its channel and customer in words, and says who the reply will send as, before you approve it.
- The counters read as a funnel — heard, ingested, dropped by triage, woke the agent — and all four numbers actually appear.
- A run that opened a PR or filed an issue says so, with a link.
- The app renders in a font we chose.

## What this phase deliberately does not do

- **No "Agent may act as me" toggle.** The prototype shows one; the worker has no revoke path at all — no disconnect route, no consent column on `identities`. Building the switch without the mechanism would be a lie on screen. It wants its own phase.
- **No handoff summary.** That is Phase 22, and the on-duty card here is deliberately *not* a down-payment on it.
- **No rotation editing.** `identity/rotation.ts` is pure arithmetic over a hardcoded array by design; a write path changes that decision and is out of scope.
- **No approval history view.** Phase 16 declined it; still declined.
- **No light theme.** `apps/dashboard/index.html` pins `class="dark"`. Leave it. Do not add colors that only exist in the dark block.

## Non-negotiable invariants

1. **The worker's counter names win.** `heard`/`ingested` are precise (`heard` counts envelopes accepted, `ingested` counts rows committed; `heard > ingested` is healthy and documented at `src/db/counters.ts:3-5`). The dashboard is what renames.
2. **One query per page, not per row.** Channel names and run outcomes are joined or batched; N rows must never mean N queries.
3. **An unmapped channel renders as its ID, not as blank.** `getChannelPolicy` already falls back to `name: channelId` (`src/db/channels.ts:24`); the join must degrade the same way.
4. **Every fetch goes through `lib/api.ts`** — no raw `fetch` in components (Phase 14 invariant 2).
5. **`dev-stubs.ts` stays in step with the API.** It is a `configureServer` hook and never ships, but a stub that lags the real shape makes new panels look broken on localhost.

---

## File Structure

**Worker — modify:**
- `src/db/counters.ts` — unchanged (it is already right); its test grows
- `src/approval/repository.ts:69` (`COLUMNS`), `:161` (`getApproval`), `:287` (`listOpen`) — join `channels`
- `src/api/approvals.ts:150` (`publicApprovalSummary`), `:186` (list route) — carry the new fields, add the envelope
- `src/identity/rotation.ts` — add `shiftBy`, `upcoming`, `lastShiftBefore`
- `src/api/identity.ts:129` (`/roster`) — return upcoming shifts and per-engineer last shift
- `src/run/repository.ts` — add `listRunOutcomes`
- `src/api/runs.ts:38` — attach outcomes to the list

**Worker — create:**
- `test/api-roster.test.ts`, `test/run-outcomes.test.ts`

**Dashboard — modify:**
- `src/lib/api.ts` — `Counters`, `Roster` types
- `src/components/counters-panel.tsx` — funnel
- `src/components/rotation-strip.tsx` → becomes the on-duty hero + a dated rotation list
- `src/components/connect-panel.tsx` → table, viewers split out
- `src/approvals/api.ts`, `src/approvals/approval-card.tsx`, `src/approvals/approvals-panel.tsx`
- `src/runs/api.ts`, `src/runs/run-list.tsx` — outcome chips
- `src/runs/run-drawer.tsx` consumer in `src/app.tsx` — pass the `run` prop
- `src/chat/citations.ts`, `src/chat/sources-rail.tsx` — citations resolve to words
- `src/app.tsx` — page heading, panel order
- `packages/ui/src/styles/globals.css` — font + status tokens
- `dev-stubs.ts` — keep in step

**Dashboard — create:**
- `src/components/on-duty-card.tsx`, `src/components/nudge-preview.tsx`, `src/components/caption.tsx`
- `test/counters-contract.test.ts`, `test/roster-api.test.ts`

---

### Task 1: The counters contract

The worker returns `{heard, ingested, triaged, escalated}` (`src/db/counters.ts:38`). The dashboard reads `{seen, triaged, woken, escalated}` (`src/lib/api.ts:91`, `src/components/counters-panel.tsx:15`). Two tiles render blank today, and the all-zero empty state can never fire because `undefined === 0` is false.

**Files:**
- Modify: `apps/dashboard/src/lib/api.ts:89-97`
- Modify: `apps/dashboard/src/components/counters-panel.tsx:15-20`
- Create: `apps/dashboard/test/counters-contract.test.ts`
- Modify: `apps/worker/test/counters.test.ts`

**Interfaces:**
- Produces: `type Counters = { counters: { heard: number; ingested: number; triaged: number; escalated: number }; since: number }` — Tasks 8 consumes this.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/test/counters-contract.test.ts`:

```ts
import { describe, expect, it, vi, afterEach } from "vitest";

import { getCounters } from "../src/lib/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The exact body `GET /api/counters` returns — see apps/worker/src/api/counters.ts. */
const WORKER_BODY = {
  counters: { heard: 148, ingested: 148, triaged: 148, escalated: 17 },
  since: 1_700_000_000_000,
};

describe("the counters contract", () => {
  it("reads every key the worker actually sends", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        new Response(JSON.stringify(WORKER_BODY), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const { counters } = await getCounters();

    // Not `toEqual` on the object: the point is that each key the UI renders
    // exists on the wire. A rename on either side fails here, not on screen.
    expect(counters.heard).toBe(148);
    expect(counters.ingested).toBe(148);
    expect(counters.triaged).toBe(148);
    expect(counters.escalated).toBe(17);
    expect(Object.keys(counters).sort()).toEqual([
      "escalated",
      "heard",
      "ingested",
      "triaged",
    ]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @workspace/dashboard test -- counters-contract`
Expected: FAIL — TypeScript rejects `counters.heard`; `Property 'heard' does not exist on type`.

- [ ] **Step 3: Rename on the dashboard side**

`apps/dashboard/src/lib/api.ts`:

```ts
/**
 * The 24-hour window, named as the worker names it. `heard` counts envelopes
 * the consumer accepted; `ingested` counts rows committed to `messages`, so
 * `heard > ingested` is the healthy case, not a discrepancy. See
 * `apps/worker/src/db/counters.ts`.
 */
export type Counters = {
  counters: {
    heard: number;
    ingested: number;
    triaged: number;
    escalated: number;
  };
  since: number;
};
```

`apps/dashboard/src/components/counters-panel.tsx`:

```ts
const TILES: { key: keyof Counters["counters"]; label: string }[] = [
  { key: "heard", label: "heard" },
  { key: "ingested", label: "ingested" },
  { key: "triaged", label: "triaged" },
  { key: "escalated", label: "escalated" },
];
```

- [ ] **Step 4: Pin the same contract on the worker side**

Append to `apps/worker/test/counters.test.ts`, inside the existing `describe("getCounters")`:

```ts
it("returns exactly the four keys the dashboard renders", async () => {
  const c = await getCounters(env.DB, NOW - DAY);
  expect(Object.keys(c).sort()).toEqual(["escalated", "heard", "ingested", "triaged"]);
});
```

- [ ] **Step 5: Run both suites**

Run: `pnpm --filter @workspace/dashboard test && pnpm --filter @workspace/worker test -- counters`
Expected: PASS on both.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/lib/api.ts apps/dashboard/src/components/counters-panel.tsx \
        apps/dashboard/test/counters-contract.test.ts apps/worker/test/counters.test.ts
git commit -m "fix(dashboard): counters render the keys the worker actually sends"
```

---

### Task 2: A font, and status colors that are tokens

`packages/ui/src/styles/globals.css:50` is `--font-sans: var(--font-sans)` — self-referential, so it resolves to nothing and the entire app renders in the browser default. Meanwhile `runs/run-list.tsx`, `runs/session-view.tsx` and `components/connect-panel.tsx` hardcode `emerald-500`, `amber-500`, `violet-500` and `text-green-500` in class strings, bypassing the token system entirely.

**Files:**
- Modify: `packages/ui/src/styles/globals.css:11,50` and both `:root` blocks
- Modify: `packages/ui/package.json` — add `@fontsource-variable/inter`
- Modify: `apps/dashboard/src/main.tsx` — import the font CSS
- Modify: `apps/dashboard/src/runs/run-list.tsx`, `src/runs/session-view.tsx`, `src/components/connect-panel.tsx`

**Interfaces:**
- Produces: CSS custom properties `--color-status-live`, `--color-status-waiting`, `--color-status-shadow`, `--color-success` — Tasks 7, 9, 10 use these class names.

- [ ] **Step 1: Install the font as a dependency, not a CDN link**

```bash
pnpm --filter @workspace/ui add @fontsource-variable/inter
```

Self-hosted on purpose: a `<link>` to a font host would be a cross-origin request from a page served behind Cloudflare Access, and the Global Constraint is one origin. Vite fingerprints the woff2 into `dist/assets` and Workers Assets serves it.

- [ ] **Step 2: Import it once, at the same place the stylesheet enters**

`apps/dashboard/src/main.tsx`, above the existing `@workspace/ui/globals.css` import:

```ts
import "@fontsource-variable/inter";
```

- [ ] **Step 3: Make the font token resolve to something**

In `packages/ui/src/styles/globals.css`, replace the circular declaration at line 50:

```css
  /* Was `var(--font-sans)` — a self-reference that resolved to nothing, so
     every screen rendered in the browser default. */
  --font-sans: "Inter Variable", ui-sans-serif, system-ui, sans-serif;
```

Leave `--font-heading: var(--font-sans)` at line 11 as is; it now inherits something real.

- [ ] **Step 4: Add the status tokens**

In the same file, add to **both** the `:root` and `.dark` blocks (same key, different lightness — do not define a color in only one):

```css
  --status-live: oklch(0.72 0.15 155);      /* emerald  — running */
  --status-waiting: oklch(0.77 0.14 85);    /* amber    — needs a human */
  --status-shadow: oklch(0.65 0.16 300);    /* violet   — reaches nobody */
  --success: oklch(0.72 0.15 155);
```

and map them in the `@theme inline` block alongside the existing `--color-*` entries:

```css
  --color-status-live: var(--status-live);
  --color-status-waiting: var(--status-waiting);
  --color-status-shadow: var(--status-shadow);
  --color-success: var(--success);
```

- [ ] **Step 5: Replace the hardcoded colors**

Three files, mechanical. In `runs/run-list.tsx` `STATUS_CLASS`, swap `emerald-*` → `status-live`, `amber-*` → `status-waiting`; `ShadowBadge`'s `violet-*` → `status-shadow` (and drop its `dark:` variant — the token handles it). In `runs/session-view.tsx`, the tool-call state dots and the reconnect banner take the same two. In `components/connect-panel.tsx:41`, `text-green-500` → `text-success`.

- [ ] **Step 6: Verify nothing broke and the font is actually loading**

Run: `pnpm --filter @workspace/dashboard build && pnpm --filter @workspace/dashboard dev`
Expected: build succeeds; `dist/assets` contains a `.woff2`. In the browser, DevTools → Computed → `font-family` on `body` reads `Inter Variable`, and the Network tab shows the woff2 served same-origin.

- [ ] **Step 7: Commit**

```bash
git add packages/ui apps/dashboard/src/main.tsx apps/dashboard/src/runs apps/dashboard/src/components pnpm-lock.yaml
git commit -m "feat(ui): load a real font and promote status colors to tokens"
```

---

### Task 3: The run drawer's badges are dead code

`apps/dashboard/src/app.tsx:79` renders `<RunDrawer runId={runId} onClose={…}>` with no `run` prop, so the entire badge row in `runs/run-drawer.tsx` — `OriginBadge`, `StatusChip`, `ShadowBadge` with its "shadow — nothing this run does reaches a customer" title — never renders. The drawer header shows only an id and a cost.

**Files:**
- Modify: `apps/dashboard/src/app.tsx:98-161`
- Modify: `apps/dashboard/src/runs/run-list.tsx` — lift the polled list

**Interfaces:**
- Consumes: `RunSummary` from `src/runs/api.ts` (already exported).
- Produces: `RunList` gains `onRuns?: (runs: RunSummary[]) => void`.

- [ ] **Step 1: Let the list report what it polled**

The drawer must not fetch a run the list already has. Add an optional callback to `RunList` rather than lifting the whole poll — the list owns its 5-second cadence and should keep it:

```tsx
export function RunList({
  onSelect,
  onRuns,
}: {
  onSelect: (id: string) => void;
  onRuns?: (runs: RunSummary[]) => void;
}): ReactNode {
  const polled = usePoll<RunSummary[]>(useMemo(() => () => fetchRuns(), []), POLL_MS);

  useEffect(() => {
    if (polled.kind === "ready") onRuns?.(polled.data);
  }, [polled, onRuns]);
  // …rest unchanged
```

- [ ] **Step 2: Hold the last polled list in the shell and pass the selected run down**

In `apps/dashboard/src/app.tsx`:

```tsx
const [runs, setRuns] = useState<RunSummary[]>([]);
const selected = runs.find((r) => r.id === selectedRun) ?? null;
```

and in `RunSession`, forward it:

```tsx
function RunSession({
  runId,
  run,
  onClose,
}: {
  runId: string;
  run: RunSummary | null;
  onClose: () => void;
}) {
  const { session, connection, steer } = useRunSession(runId);
  return (
    <RunDrawer runId={runId} run={run ?? undefined} onClose={onClose}>
      <SessionView session={session} connection={connection} onSteer={steer} />
    </RunDrawer>
  );
}
```

`run` stays optional: a drawer opened from a pasted `#run=…` hash before the first poll lands has no summary yet, and the header must render anyway.

- [ ] **Step 3: Verify by eye**

Run: `pnpm --filter @workspace/dashboard dev`, click a run.
Expected: the drawer header now carries the status chip, origin badge and (for shadow runs) the shadow badge, beside the id and cost. Open a `#run=<id>` hash directly in a fresh tab: header renders without badges for one poll interval, then gains them. No flicker of an error state.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/app.tsx apps/dashboard/src/runs/run-list.tsx
git commit -m "fix(dashboard): the run drawer's badge row was never given its run"
```

---

### Task 4: Approvals carry the channel, the customer, and who will send

`listOpen` (`src/approval/repository.ts:287`) and `getApproval` (`:161`) select from `approvals` alone, so the card can only print `#C09FKJ2R1X` and a raw epoch — on the one surface a human is meant to act on quickly. The runs list already does this correctly at `src/run/repository.ts:242-244`; **copy that join**, do not invent one.

**Files:**
- Modify: `apps/worker/src/approval/repository.ts:69,161,287`
- Modify: `apps/worker/src/api/approvals.ts:150,186`
- Modify: `apps/worker/test/approval-repository.test.ts`

**Interfaces:**
- Produces:
```ts
// src/approval/repository.ts
export type ApprovalRow = { /* …existing… */
  channelName: string | null;   // NULL when the channel is not in `channels`
  customerSlug: string | null;
};
// GET /api/approvals?state=open →
{ approvals: OpenApproval[]; willSendAs: string }
// where OpenApproval gains: channelName: string | null; customerSlug: string | null
```
Task 9 consumes both.

- [ ] **Step 1: Write the failing test**

Append to `apps/worker/test/approval-repository.test.ts`:

```ts
describe("channel resolution on the queue", () => {
  it("returns the channel's human name when the channel is mapped", async () => {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, ?, ?)",
    ).bind("C1", "ext-zellify-lingua", "lingua", "live").run();

    const [row] = await listOpen(env.DB);

    expect(row?.channelName).toBe("ext-zellify-lingua");
    expect(row?.customerSlug).toBe("lingua");
  });

  it("returns null rather than throwing when the channel is unmapped", async () => {
    await env.DB.prepare("DELETE FROM channels WHERE channel_id = ?").bind("C1").run();

    const [row] = await listOpen(env.DB);

    // The API layer decides how to render an unmapped channel; the repository
    // reports the absence honestly instead of inventing a name.
    expect(row?.channelName).toBeNull();
  });
});
```

(The existing `beforeEach` in that file already seeds a pending approval on channel `C1`. If it does not, seed one with the same helper the file already defines.)

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @workspace/worker test -- approval-repository`
Expected: FAIL — `Property 'channelName' does not exist on type 'ApprovalRow'`.

- [ ] **Step 3: Join the channel in**

In `src/approval/repository.ts`, `COLUMNS` is shared by `getApproval`, `decide` and `listOpen`, so qualify it and add a second constant rather than widening every caller:

```ts
// Qualified so it can sit on either side of a join without ambiguity.
const COLUMNS = `a.id, a.run_id, a.generation_id, a.draft, a.why, a.channel_id, a.thread_ts,
  a.shadow, a.decision, a.decided_by, a.decided_at, a.edited_text, a.reject_reason, a.delivery,
  a.created_at, a.updated_at, a.nudged_at, a.nudge_channel_id, a.nudge_ts`;

/** The same row plus the channel catalog's words for it. Same LEFT JOIN the
 *  runs list uses (`src/run/repository.ts:242`) — an unmapped channel yields
 *  NULLs, never a dropped row. */
const COLUMNS_WITH_CHANNEL = `${COLUMNS}, c.name AS channel_name, c.customer_slug`;
const CHANNEL_JOIN = `LEFT JOIN channels c ON c.channel_id = a.channel_id`;
```

Every existing `FROM approvals` becomes `FROM approvals a`. Then:

```ts
export async function listOpen(db: D1Database, limit = 50): Promise<ApprovalRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS_WITH_CHANNEL} FROM approvals a ${CHANNEL_JOIN}
        WHERE a.decision = 'pending' ORDER BY a.created_at ASC LIMIT ?`,
    )
    .bind(limit)
    .all<ApprovalRowDb>();
  return (results ?? []).map(toRow);
}
```

`getApproval` takes the same treatment. `decide`'s read-back does **not** — it feeds the 409/200 response, which never renders a channel name, and widening it would put a join inside the CAS batch.

Extend `ApprovalRowDb` with `channel_name: string | null; customer_slug: string | null` and `toRow` with `channelName: db.channel_name ?? null, customerSlug: db.customer_slug ?? null`. Rows read through `decide`'s narrow select get `null` for both — which is correct, not a gap.

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @workspace/worker test -- approval-repository`
Expected: PASS.

- [ ] **Step 5: Carry the fields, and say who will send**

In `src/api/approvals.ts`, add both to `publicApprovalSummary` (`:150`) — `publicApprovalCard` spreads it, so the detail route gets them free:

```ts
    channelId: row.channelId,
    channelName: row.channelName,
    customerSlug: row.customerSlug,
    threadTs: row.threadTs,
```

and on the list route (`:186`), add the envelope field. The reply sends under the on-duty engineer's user token (`identity/user-token.ts`), and the card must say so before anyone clicks approve:

```ts
import { onDuty } from "../identity/rotation";
// …
  const rows = await listOpen(c.env.DB);
  return c.json({
    approvals: rows.map(publicApprovalSummary),
    // Envelope, not per-row: one engineer holds the shift, and a per-row copy
    // could disagree with itself across a shift boundary mid-render.
    willSendAs: onDuty(Date.now()).email,
  });
```

- [ ] **Step 6: Pin the route contract**

Add to `apps/worker/test/approval-api.test.ts`:

```ts
it("names the on-duty engineer who would send the reply", async () => {
  const res = await SELF.fetch("https://x/api/approvals?state=open", {
    headers: { "Cf-Access-Jwt-Assertion": await firefighterJwt() },
  });
  const body = await res.json<{ willSendAs: string; approvals: unknown[] }>();

  expect(body.willSendAs).toBe(onDuty(Date.now()).email);
});
```

Reuse whatever JWT helper that file already defines — do not add a second one.

- [ ] **Step 7: Run the full worker suite and commit**

Run: `pnpm --filter @workspace/worker test`
Expected: PASS.

```bash
git add apps/worker/src/approval/repository.ts apps/worker/src/api/approvals.ts apps/worker/test
git commit -m "feat(approvals): the queue names its channel, its customer, and its sender"
```

---

### Task 5: Shift windows, forward and back

`/api/roster` returns `rotation: string[]` — names with no dates — so the rotation card cannot say `Aug 16–18` and the team table cannot say "last shift". Both are pure arithmetic over the existing epoch; nothing needs storing.

**Files:**
- Modify: `apps/worker/src/identity/rotation.ts`
- Modify: `apps/worker/src/api/identity.ts:129`
- Modify: `apps/worker/test/rotation.test.ts`

**Interfaces:**
- Produces:
```ts
export type ShiftWindow = { email: string; shiftStartMs: number; shiftEndMs: number };
export function shiftBy(nowMs: number, offset: number): ShiftWindow;
export function upcoming(nowMs: number, count: number): ShiftWindow[];
export function lastShiftBefore(email: string, nowMs: number): ShiftWindow | null;
// GET /api/roster gains: upcoming: ShiftWindow[]
//   and each engineer gains: lastShiftEndMs: number | null
```
Tasks 7 and 11 consume these.

- [ ] **Step 1: Write the failing test**

Append to `apps/worker/test/rotation.test.ts`:

```ts
import { ROTATION, ROTATION_EPOCH_MS, SHIFT_MS, onDuty, shiftBy, upcoming, lastShiftBefore } from "../src/identity/rotation";

describe("shiftBy", () => {
  it("offset 0 is the shift onDuty reports", () => {
    const now = ROTATION_EPOCH_MS + SHIFT_MS * 2 + 1000;
    const here = shiftBy(now, 0);
    const duty = onDuty(now);

    expect(here.email).toBe(duty.email);
    expect(here.shiftStartMs).toBe(duty.shiftStartMs);
  });

  it("tiles forward and backward without a gap", () => {
    const now = ROTATION_EPOCH_MS + SHIFT_MS * 2;

    expect(shiftBy(now, 1).shiftStartMs).toBe(shiftBy(now, 0).shiftEndMs);
    expect(shiftBy(now, -1).shiftEndMs).toBe(shiftBy(now, 0).shiftStartMs);
  });

  it("stays on a real rotation member before the epoch", () => {
    // The floored modulo in `onDuty` is the reason this holds; `shiftBy` must
    // not reintroduce a negative index by doing its own arithmetic.
    const before = shiftBy(ROTATION_EPOCH_MS - SHIFT_MS * 3 - 1, 0);

    expect(ROTATION).toContain(before.email);
  });
});

describe("upcoming", () => {
  it("returns the next N shifts, starting after the current one", () => {
    const now = ROTATION_EPOCH_MS + 1000;
    const next = upcoming(now, 3);

    expect(next).toHaveLength(3);
    expect(next[0]?.email).toBe(onDuty(now).nextEmail);
    expect(next[0]?.shiftStartMs).toBe(onDuty(now).shiftEndMs);
  });
});

describe("lastShiftBefore", () => {
  it("finds the most recent completed shift for a rotation member", () => {
    const now = ROTATION_EPOCH_MS + SHIFT_MS * ROTATION.length + 1000;
    const first = ROTATION[0]!;

    const last = lastShiftBefore(first, now);

    expect(last).not.toBeNull();
    expect(last!.shiftEndMs).toBeLessThanOrEqual(now);
  });

  it("returns null for somebody who is not in the rotation", () => {
    expect(lastShiftBefore("marcus@zellify.app", Date.now())).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @workspace/worker test -- rotation`
Expected: FAIL — `shiftBy` is not exported.

- [ ] **Step 3: Implement, reusing `onDuty`'s floored modulo**

Append to `apps/worker/src/identity/rotation.ts`:

```ts
/** A shift with no "who's next" — the list forms of the rotation want only these three fields. */
export type ShiftWindow = {
  email: string;
  shiftStartMs: number;
  shiftEndMs: number;
};

/**
 * The shift `offset` slots away from the one containing `nowMs`. Negative
 * looks back. Defined for every offset, including before the epoch: it is
 * `onDuty`'s arithmetic with the slot count shifted, so the floored modulo
 * that keeps the index non-negative is inherited rather than re-derived.
 */
export function shiftBy(nowMs: number, offset: number): ShiftWindow {
  const shiftsSince = Math.floor((nowMs - ROTATION_EPOCH_MS) / SHIFT_MS) + offset;
  const index =
    ((shiftsSince % ROTATION.length) + ROTATION.length) % ROTATION.length;
  const shiftStartMs = ROTATION_EPOCH_MS + shiftsSince * SHIFT_MS;
  return { email: ROTATION[index]!, shiftStartMs, shiftEndMs: shiftStartMs + SHIFT_MS };
}

/** The next `count` shifts, the current one excluded. */
export function upcoming(nowMs: number, count: number): ShiftWindow[] {
  return Array.from({ length: count }, (_, i) => shiftBy(nowMs, i + 1));
}

/**
 * The most recent shift `email` finished before `nowMs`, or null if they are
 * not in the rotation. Bounded scan: one full cycle back is enough, because a
 * member holds exactly one slot per cycle.
 */
export function lastShiftBefore(email: string, nowMs: number): ShiftWindow | null {
  if (!ROTATION.includes(email)) return null;
  for (let offset = -1; offset >= -ROTATION.length; offset -= 1) {
    const shift = shiftBy(nowMs, offset);
    if (shift.email === email) return shift;
  }
  return null;
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @workspace/worker test -- rotation`
Expected: PASS.

- [ ] **Step 5: Widen `/api/roster`**

In `apps/worker/src/api/identity.ts:129`, keep `rotation` — the nudge path reads it — and add:

```ts
  const engineers = await listConnectStatus(c.env.DB);
  const now = Date.now();

  return c.json({
    onDuty: onDuty(now),
    rotation: [...ROTATION],
    // Dated, so the dashboard can say "Aug 16–18" instead of just a name.
    upcoming: upcoming(now, ROTATION.length - 1),
    engineers: engineers.map((e) => ({
      ...e,
      // Viewers are not in the rotation, so this is null for them by construction.
      lastShiftEndMs: lastShiftBefore(e.email, now)?.shiftEndMs ?? null,
    })),
  });
```

- [ ] **Step 6: Pin the route**

Add to `apps/worker/test/api-identity.test.ts` (or create `test/api-roster.test.ts` if that file is crowded):

```ts
it("dates the upcoming rotation and every engineer's last shift", async () => {
  const res = await SELF.fetch("https://x/api/roster", {
    headers: { "Cf-Access-Jwt-Assertion": await firefighterJwt() },
  });
  const body = await res.json<{
    upcoming: { email: string; shiftStartMs: number; shiftEndMs: number }[];
    engineers: { email: string; lastShiftEndMs: number | null }[];
  }>();

  expect(body.upcoming.length).toBe(ROTATION.length - 1);
  expect(body.upcoming[0]!.shiftEndMs).toBeGreaterThan(body.upcoming[0]!.shiftStartMs);
  // Every engineer answers the question, even if the answer is "never".
  for (const e of body.engineers) {
    expect(e).toHaveProperty("lastShiftEndMs");
  }
});
```

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/identity/rotation.ts apps/worker/src/api/identity.ts apps/worker/test
git commit -m "feat(rotation): dated upcoming shifts and each engineer's last one"
```

---

### Task 6: What did this run actually do?

`RunSummary` carries no artifact, so a run that opened PR #1414 looks identical on the list to one that did nothing. The data is already there: `codemode_effects` (migration `0005`) stores `namespace`, `method`, `state` and `safe_result_json` per run, and `idx_codemode_effects_run` exists for exactly this — the migration comment calls it "Per-run effect history, newest first: what did this run actually do?"

**Files:**
- Modify: `apps/worker/src/run/repository.ts`
- Modify: `apps/worker/src/api/runs.ts:38`
- Create: `apps/worker/test/run-outcomes.test.ts`

**Interfaces:**
- Consumes: `PullRequestRef` = `{number, url, headRef, author, updated}` and `IssueRef` = `{id, identifier, url}`, both from `src/codemode/gateways.ts:63,336`. These are the exact shapes `safe_result_json` holds for `github.openPR` and `linear.createIssue`.
- Produces:
```ts
export type RunOutcome =
  | { kind: "pr"; number: number; url: string }
  | { kind: "issue"; identifier: string; url: string }
  | { kind: "sandbox" };
export async function listRunOutcomes(db: D1Database, runIds: string[]): Promise<Map<string, RunOutcome[]>>;
// RunListItem gains: outcomes: RunOutcome[]
```
Task 10 consumes `RunOutcome`.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/test/run-outcomes.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { listRunOutcomes } from "../src/run/repository";

const NOW = 1_700_000_000_000;

async function seedRun(id: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, summary, created_at, updated_at)
     VALUES (?, ?, 'slack', 'C1', '1720000000.000100', 'done', 0, NULL, ?, ?)`,
  ).bind(id, `slack:C1:${id}`, NOW, NOW).run();
}

async function seedEffect(input: {
  runId: string;
  namespace: string;
  method: string;
  state: string;
  result: unknown;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO codemode_effects
       (effect_key, run_id, turn_id, namespace, method, args_hash, state, safe_result_json, created_at, updated_at)
     VALUES (?, ?, 't1', ?, ?, 'h', ?, ?, ?, ?)`,
  )
    .bind(
      `${input.runId}:${input.namespace}.${input.method}`,
      input.runId,
      input.namespace,
      input.method,
      input.state,
      JSON.stringify(input.result),
      NOW,
      NOW,
    )
    .run();
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM codemode_effects"),
    env.DB.prepare("DELETE FROM runs"),
  ]);
});

describe("listRunOutcomes", () => {
  it("reports a merged PR reference from the effects ledger", async () => {
    await seedRun("r1");
    await seedEffect({
      runId: "r1",
      namespace: "github",
      method: "openPR",
      state: "completed",
      result: { number: 1414, url: "https://github.com/o/r/pull/1414", headRef: "fix", author: "luka", updated: false },
    });

    const outcomes = await listRunOutcomes(env.DB, ["r1"]);

    expect(outcomes.get("r1")).toEqual([
      { kind: "pr", number: 1414, url: "https://github.com/o/r/pull/1414" },
    ]);
  });

  it("reports a filed Linear issue by its identifier", async () => {
    await seedRun("r2");
    await seedEffect({
      runId: "r2",
      namespace: "linear",
      method: "createIssue",
      state: "completed",
      result: { id: "uuid", identifier: "ZEL-2041", url: "https://linear.app/x/issue/ZEL-2041" },
    });

    expect(outcomes(await listRunOutcomes(env.DB, ["r2"]), "r2")).toEqual([
      { kind: "issue", identifier: "ZEL-2041", url: "https://linear.app/x/issue/ZEL-2041" },
    ]);
  });

  it("ignores effects that did not complete", async () => {
    await seedRun("r3");
    await seedEffect({
      runId: "r3",
      namespace: "github",
      method: "openPR",
      state: "in_doubt",
      result: null,
    });

    // 'in_doubt' means we do not know whether the PR exists. Claiming one on
    // the dashboard would be worse than saying nothing.
    expect(await listRunOutcomes(env.DB, ["r3"])).toEqual(new Map());
  });

  it("returns an empty map for no run ids without touching the database", async () => {
    expect(await listRunOutcomes(env.DB, [])).toEqual(new Map());
  });
});

function outcomes(map: Map<string, unknown>, id: string): unknown {
  return map.get(id);
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @workspace/worker test -- run-outcomes`
Expected: FAIL — `listRunOutcomes` is not exported from `../src/run/repository`.

- [ ] **Step 3: Implement one batched query**

Append to `apps/worker/src/run/repository.ts`:

```ts
/**
 * What a run shipped, for the list view. One query for the whole page — an
 * N-row list must never mean N queries (invariant 2 of this phase), and this
 * is a plain D1 read, so no Durable Object is woken.
 *
 * Only `completed` effects count. `reserved` has not happened yet, `failed`
 * did not happen, and `in_doubt` is precisely the state where we do not know
 * — claiming a PR exists on that evidence would be worse than silence.
 */
export type RunOutcome =
  | { kind: "pr"; number: number; url: string }
  | { kind: "issue"; identifier: string; url: string }
  | { kind: "sandbox" };

const OUTCOME_METHODS = [
  ["github", "openPR"],
  ["linear", "createIssue"],
  ["sandbox", "boot"],
] as const;

export async function listRunOutcomes(
  db: D1Database,
  runIds: string[],
): Promise<Map<string, RunOutcome[]>> {
  const out = new Map<string, RunOutcome[]>();
  if (runIds.length === 0) return out;

  const runPlaceholders = runIds.map(() => "?").join(", ");
  const methodPredicate = OUTCOME_METHODS.map(() => "(namespace = ? AND method = ?)").join(" OR ");

  const { results } = await db
    .prepare(
      `SELECT run_id, namespace, method, safe_result_json
         FROM codemode_effects
        WHERE run_id IN (${runPlaceholders})
          AND state = 'completed'
          AND (${methodPredicate})
        ORDER BY created_at ASC`,
    )
    .bind(...runIds, ...OUTCOME_METHODS.flat())
    .all<{ run_id: string; namespace: string; method: string; safe_result_json: string | null }>();

  for (const row of results ?? []) {
    const outcome = toOutcome(row.namespace, row.method, row.safe_result_json);
    if (outcome === null) continue;
    const list = out.get(row.run_id) ?? [];
    // One chip per kind: a run that retried `openPR` opened one PR, not three.
    if (!list.some((o) => o.kind === outcome.kind)) list.push(outcome);
    out.set(row.run_id, list);
  }
  return out;
}

/** A ledger row whose payload does not parse is a row we say nothing about. */
function toOutcome(namespace: string, method: string, json: string | null): RunOutcome | null {
  if (namespace === "sandbox") return { kind: "sandbox" };
  if (json === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  if (namespace === "github" && method === "openPR") {
    const { number, url } = parsed as { number?: unknown; url?: unknown };
    if (typeof number !== "number" || typeof url !== "string") return null;
    return { kind: "pr", number, url };
  }
  if (namespace === "linear" && method === "createIssue") {
    const { identifier, url } = parsed as { identifier?: unknown; url?: unknown };
    if (typeof identifier !== "string" || typeof url !== "string") return null;
    return { kind: "issue", identifier, url };
  }
  return null;
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @workspace/worker test -- run-outcomes`
Expected: PASS.

- [ ] **Step 5: Attach outcomes to the list route**

In `apps/worker/src/api/runs.ts:38`, after the rows are fetched:

```ts
  const runs = await listRuns(c.env.DB, { status, limit });
  const outcomes = await listRunOutcomes(c.env.DB, runs.map((r) => r.id));

  return c.json({
    runs: runs.map((r) => ({ ...r, outcomes: outcomes.get(r.id) ?? [] })),
  });
```

- [ ] **Step 6: Run the worker suite and commit**

Run: `pnpm --filter @workspace/worker test`
Expected: PASS.

```bash
git add apps/worker/src/run/repository.ts apps/worker/src/api/runs.ts apps/worker/test/run-outcomes.test.ts
git commit -m "feat(runs): the list says what each run shipped"
```

---

### Task 7: The on-duty card leads the page

Today the grid opens cold — no heading, and `RotationStrip` is one thin line. The single most consequential fact on the page, **that the agent is speaking to customers as a named person**, is rendered nowhere at all.

**Files:**
- Create: `apps/dashboard/src/components/on-duty-card.tsx`
- Modify: `apps/dashboard/src/components/rotation-strip.tsx` — becomes the dated upcoming list
- Modify: `apps/dashboard/src/lib/api.ts` — `Roster` type
- Modify: `apps/dashboard/src/app.tsx` — heading and order
- Modify: `apps/dashboard/dev-stubs.ts`

**Interfaces:**
- Consumes: `Roster` from Task 5, `PanelState` from `components/panel.tsx`.
- Produces: `OnDutyCard({ state, approvalCount }: { state: PanelState<Roster>; approvalCount: number })`.

- [ ] **Step 1: Widen the client type**

`apps/dashboard/src/lib/api.ts`:

```ts
export type ShiftWindow = {
  email: string;
  shiftStartMs: number;
  shiftEndMs: number;
};

export type ConnectStatus = {
  email: string;
  role: "firefighter" | "viewer";
  slack: boolean;
  github: boolean;
  /** null for viewers, who are not in the rotation. */
  lastShiftEndMs: number | null;
};

export type Roster = {
  onDuty: Shift;
  rotation: string[];
  upcoming: ShiftWindow[];
  engineers: ConnectStatus[];
};
```

- [ ] **Step 2: Build the card**

Create `apps/dashboard/src/components/on-duty-card.tsx`. Move `nameOf` and `initialOf` here from `rotation-strip.tsx` and import them back — two components need them and duplicating would let them drift:

```tsx
import { Panel, type PanelState } from "./panel";
import type { Roster } from "../lib/api";

/**
 * The page's lead. It answers one question the rest of the dashboard assumes
 * you already know: whose voice is the agent spending right now.
 *
 * The connect chips are not decoration. A shift held by someone who has not
 * connected Slack is a shift where no customer reply can be sent at all —
 * `identity/user-token.ts` has no bot fallback — so the absence has to be
 * visible here rather than discovered at approve time.
 */
export function nameOf(email: string): string {
  const at = email.indexOf("@");
  return at === -1 ? email : email.slice(0, at);
}

export function initialOf(email: string): string {
  return (email.trim()[0] ?? "?").toUpperCase();
}

function Chip({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[11px] ${
        ok ? "border-success/40 text-success" : "border-destructive/40 text-destructive"
      }`}
    >
      {children}
    </span>
  );
}

const HANDS_OFF = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

function remaining(endMs: number, nowMs: number): string {
  const ms = Math.max(0, endMs - nowMs);
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${Math.floor(hours / 24)}d ${hours % 24}h ${minutes}m`;
}

export function OnDutyCard({
  state,
  approvalCount,
}: {
  state: PanelState<Roster>;
  approvalCount: number;
}) {
  return (
    <Panel title="On duty" state={state}>
      {({ onDuty, engineers }) => {
        const now = Date.now();
        const self = engineers.find((e) => e.email === onDuty.email);

        return (
          <div className="flex flex-wrap items-start gap-4">
            <span className="flex size-11 items-center justify-center rounded-lg bg-primary text-base font-medium text-primary-foreground">
              {initialOf(onDuty.email)}
            </span>
            <div className="flex min-w-0 flex-col gap-2">
              <p className="text-lg font-semibold tracking-tight">
                {nameOf(onDuty.email)} is on duty
              </p>
              <p className="text-sm text-muted-foreground">
                Shift ends in {remaining(onDuty.shiftEndMs, now)} · hands off to{" "}
                {nameOf(onDuty.nextEmail)}, {HANDS_OFF.format(new Date(onDuty.shiftEndMs))}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-status-waiting/40 px-2 py-0.5 text-[11px] text-status-waiting">
                  agent acting as @{nameOf(onDuty.email)}
                </span>
                <Chip ok={self?.slack === true}>
                  {self?.slack === true ? "✓ Slack connected" : "Slack not connected"}
                </Chip>
                <Chip ok={self?.github === true}>
                  {self?.github === true ? "✓ GitHub connected" : "GitHub not connected"}
                </Chip>
                {approvalCount > 0 ? (
                  <a href="#" className="text-[11px] text-muted-foreground underline">
                    {approvalCount} approval{approvalCount === 1 ? "" : "s"} waiting below
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        );
      }}
    </Panel>
  );
}
```

- [ ] **Step 3: Reduce `rotation-strip.tsx` to the dated queue**

It keeps its `Panel title="Rotation"` and its "a strip, because the rotation is an ordered queue" reasoning, but now renders `roster.upcoming` — one row per engineer with their dates — instead of a bare dot-separated name list. Import `nameOf`/`initialOf` from `on-duty-card.tsx`; delete the local copies. Format each window with a shared `Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })` as `Aug 16–18`, collapsing the month when both ends share it.

- [ ] **Step 4: Head the page and reorder**

In `apps/dashboard/src/app.tsx`, above `<main>`'s grid children, and inside the dashboard branch only:

```tsx
<div className="mx-auto max-w-5xl px-6 pt-6">
  <h1 className="text-2xl font-semibold tracking-tight">Who answers the fire today</h1>
  <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
    Three-day rotation across the fire-fighters. The agent speaks to customers as
    whoever holds the shift, and pings that person on Slack when it needs a yes.
  </p>
</div>
```

Then put `OnDutyCard` first in the grid (`md:col-span-2`), approvals second, `RotationStrip` third. The approvals panel loses its "first, deliberately" comment — replace it, do not delete it: the new reason is that the on-duty card is what makes the approval card's "will send as" legible, so it has to be read first.

Pass `approvalCount={approvals.state.kind === "ready" ? approvals.state.data.length : 0}` — adapt to whatever shape `useApprovals` actually exposes; read it before writing this line.

- [ ] **Step 5: Keep the dev stubs in step**

In `apps/dashboard/dev-stubs.ts`, the `/api/roster` stub must gain `upcoming` and `lastShiftEndMs`, or the new card renders half-empty on localhost and looks like a regression. Compute them the same way the worker does rather than hardcoding dates.

- [ ] **Step 6: Verify all four panel states**

Run: `pnpm --filter @workspace/dashboard dev`
Expected: the card renders on load; kill the worker and confirm it shows `Panel`'s error state with a Retry, not a blank box; check that an engineer with `slack: false` shows the red "Slack not connected" chip.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src apps/dashboard/dev-stubs.ts
git commit -m "feat(dashboard): lead with who is on duty and whose voice the agent spends"
```

---

### Task 8: Counters as a funnel

Four disconnected tiles do not tell the story the numbers contain. The chain does — and it is our own line from `LOOM-DEMO-SCENARIOS.md`: "everything is heard and stored, almost nothing wakes the agent. That's the cost model."

**Files:**
- Modify: `apps/dashboard/src/components/counters-panel.tsx`

**Interfaces:**
- Consumes: `Counters` from Task 1.

- [ ] **Step 1: Render the chain**

Replace the four-tile grid with a wrapping row of `value + label` pairs separated by `→`, in the order `heard → ingested → dropped by triage → woke the agent`. The drop count is **derived, not fetched** — `triaged - escalated` is wrong (escalation is not waking); the honest derivation needs the wake count, which the API does not send. So render four true numbers and let the arrow carry the narrative:

```tsx
const STEPS: { key: keyof Counters["counters"]; label: string }[] = [
  { key: "heard", label: "messages heard" },
  { key: "ingested", label: "ingested to memory" },
  { key: "triaged", label: "triaged" },
  { key: "escalated", label: "escalations raised" },
];
```

Keep `Tile` for the numeral; put `<span aria-hidden="true">→</span>` between steps and give the container `role="list"` so the arrow is not read aloud.

- [ ] **Step 2: Keep the empty state working**

The all-zero fold in `CountersPanel` is correct and now actually reachable (Task 1 fixed the `undefined === 0` bug). Do not touch it — but confirm by hand that it fires: temporarily return zeroes from the dev stub and check the hint renders.

- [ ] **Step 3: Caption the cost**

Below the row, one muted line naming the triage unit cost. **Do not hardcode a number.** `triage_decisions` stores `cost_usd` per decision; either add it to the counters response as a windowed mean in a follow-up, or write the caption without a figure ("triage runs on the cheap model; the expensive one only wakes when triage says so"). Prefer the second — inventing `$0.0003` because a prototype said so would be a fabricated metric on a graded surface.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @workspace/dashboard test && pnpm --filter @workspace/dashboard dev`

```bash
git add apps/dashboard/src/components/counters-panel.tsx
git commit -m "feat(dashboard): counters read as the funnel they describe"
```

---

### Task 9: The approval card names its target

`Meta` (`approvals/approval-card.tsx:96`) prints `#{card.channelId}` and `thread {card.threadTs}` — a raw Slack ID and a raw epoch, on the one surface built for a human to act on quickly.

**Files:**
- Modify: `apps/dashboard/src/approvals/api.ts:16-24`
- Modify: `apps/dashboard/src/approvals/use-approvals.ts` — carry `willSendAs`
- Modify: `apps/dashboard/src/approvals/approval-card.tsx:96-106,121,232`
- Modify: `apps/dashboard/src/approvals/approvals-panel.tsx`
- Modify: `apps/dashboard/dev-stubs.ts`

**Interfaces:**
- Consumes: `{ approvals, willSendAs }` from Task 4.
- Produces: `ApprovalCardProps` gains `willSendAs: string | null`.

- [ ] **Step 1: Widen the client types**

```ts
export type OpenApproval = {
  id: string;
  runId: string;
  draft: string;
  why: string;
  channelId: string;
  /** null when the channel is not in the catalog — render the id instead. */
  channelName: string | null;
  customerSlug: string | null;
  threadTs: string;
  createdAt: number;
};
```

`fetchOpenApprovals` currently returns `OpenApproval[]`. It must now return `{ approvals: OpenApproval[]; willSendAs: string }`. Update `use-approvals.ts` to thread `willSendAs` through to the panel — it belongs on the poll result, not on each card, so a shift boundary cannot make two cards disagree.

- [ ] **Step 2: Rewrite `Meta`**

```tsx
function Meta({ card, now }: { card: OpenApproval; now: number }): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
      {/* Constant, not a column read: `approvals.kind` is CHECK-constrained to
          'slack_reply' (migration 0007), so plumbing it would render one value
          and imply a choice that does not exist. Revisit when a second kind lands. */}
      <span className="text-foreground">Slack reply →</span>
      <span className="rounded border border-border bg-muted px-1.5 py-0.5">
        #{card.channelName ?? card.channelId}
      </span>
      {card.customerSlug === null ? null : <span>{card.customerSlug}</span>}
      <span className="ml-auto shrink-0 tabular-nums">{ago(card.createdAt, now)} in queue</span>
    </div>
  );
}
```

`threadTs` leaves the card entirely — a raw Slack epoch was never actionable, and the run drawer addresses the thread.

`ago()` currently returns "just now" / "12m ago". Appending "in queue" to "12m ago" reads wrong. Add a second formatter in this file returning the bare duration ("12m", "just opened") rather than mutating the shared one — `run-list.tsx` depends on the existing wording and the file comment at `:46` says the two panels must agree about "now".

- [ ] **Step 3: Say who it sends as, and make the button say what it does**

Above the `Draft` blockquote:

```tsx
{willSendAs === null ? null : (
  <p className="text-[11px] text-muted-foreground">
    will send as <span className="text-foreground">@{nameOf(willSendAs)}</span>
  </p>
)}
```

`nameOf` comes from `../components/on-duty-card` (Task 7 moved it there) — import it, do not add a third copy.

Relabel the primary action `Approve & send`. It posts a message to a customer under a named engineer's identity; the button should say so. Leave Edit and Reject, the required-reason rule, the disabled states and the viewer caption exactly as they are — Phase 16 got those right.

- [ ] **Step 4: Update the dev stubs**

`dev-stubs.ts` must return the new envelope shape and give its three seeded approvals a `channelName`/`customerSlug`, or the card renders blank locally.

- [ ] **Step 5: Extend the approvals API test**

`apps/dashboard/test/approvals-api.test.ts` already tests `fetchOpenApprovals`. Update it for the envelope and add:

```ts
it("returns the envelope's sender alongside the rows", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      new Response(
        JSON.stringify({
          approvals: [
            {
              id: "apr:1",
              runId: "r1",
              draft: "d",
              why: "w",
              channelId: "C0UNMAPPED",
              channelName: null,
              customerSlug: null,
              threadTs: "1720000000.000100",
              createdAt: 1_700_000_000_000,
            },
          ],
          willSendAs: "luka@zellify.app",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  );

  const { approvals, willSendAs } = await fetchOpenApprovals();

  expect(willSendAs).toBe("luka@zellify.app");
  // An unmapped channel arrives as null (Task 4). The card must still address
  // something a human can paste into Slack search, so the id is the fallback.
  expect(approvals[0]!.channelName).toBeNull();
  expect(approvals[0]!.channelName ?? approvals[0]!.channelId).toBe("C0UNMAPPED");
});
```

- [ ] **Step 6: Run tests, verify by eye, commit**

Run: `pnpm --filter @workspace/dashboard test`

```bash
git add apps/dashboard/src/approvals apps/dashboard/dev-stubs.ts apps/dashboard/test
git commit -m "feat(approvals): the card names its channel, its customer, and its sender"
```

---

### Task 10: Outcome chips on the run list

**Files:**
- Modify: `apps/dashboard/src/runs/api.ts:17-29`
- Modify: `apps/dashboard/src/runs/run-list.tsx:96-125`

**Interfaces:**
- Consumes: `RunOutcome` from Task 6.

- [ ] **Step 1: Widen `RunSummary`**

```ts
export type RunOutcome =
  | { kind: "pr"; number: number; url: string }
  | { kind: "issue"; identifier: string; url: string }
  | { kind: "sandbox" };

export type RunSummary = { /* …existing… */ outcomes: RunOutcome[] };
```

- [ ] **Step 2: Render them**

Add an `OutcomeChip` beside `StatusChip` in `RunRow`. Two constraints:

- The chip for a PR or an issue is a **link**, and the row is a `<button>`. A nested interactive element inside a button is invalid HTML and breaks keyboard navigation. Render the chips in a sibling `<div>` below the button, inside the same `<li>` — not inside it.
- Labels: `PR #1414`, `ZEL-2041`, `sandbox`. Reuse the badge shape already in `OriginBadge` and the Task 2 tokens. **No ticket-type chips** (Global Constraints).

- [ ] **Step 3: Verify against a real run**

Run: `pnpm --filter @workspace/dashboard dev` with the worker running against remote D1.
Expected: a run that opened a PR shows a linking chip; a run that did nothing shows none, and the row is unchanged.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/runs
git commit -m "feat(dashboard): run rows say what they shipped"
```

---

### Task 11: The team as a table, viewers set apart

`connect-panel.tsx` renders a flat `<ul>` of raw emails with everyone — engineers and read-only viewers — in one list, repeating "—" per viewer row instead of saying once that viewers are not in the rotation.

**Files:**
- Modify: `apps/dashboard/src/components/connect-panel.tsx`

- [ ] **Step 1: Restructure**

Keep `Panel title="Connections"` (or rename to "Team" — pick one and use it in both the heading and the plan's verification). Render a `<table>`: name (via `nameOf`) over email, role chip, Slack cell, GitHub cell, last shift (`lastShiftEndMs` from Task 5, formatted `Aug 4–6`, or `on duty now` when the email matches `onDuty.email`).

Then a captioned sub-section for viewers — one caption, not one em-dash per row: *"Viewers · read-only + chat — not in the rotation."*

**Do not add an "Agent may act as me" column.** The reference prototype shows one; there is no revoke path anywhere in the worker (no disconnect route, no consent column on `identities`), so the switch would be inert or lying. Leave a comment in the file saying exactly that, so the next reader does not think it was forgotten.

- [ ] **Step 2: Preserve what is already correct**

Keep: the self-row highlight (`border-l-primary bg-accent/40`), the plain-anchor OAuth start (a fetch cannot follow an OAuth redirect), the disabled Connect on other people's rows with its `title`, and the viewer `—` in the provider cells.

- [ ] **Step 3: Verify and commit**

Run: `pnpm --filter @workspace/dashboard dev`
Expected: engineers and viewers visually separated; your own row highlighted; Connect still navigates to `/api/oauth/slack/start`.

```bash
git add apps/dashboard/src/components/connect-panel.tsx
git commit -m "feat(dashboard): the team reads as a table, viewers set apart"
```

---

### Task 12: Chat citations resolve to words

`chat/sources-rail.tsx` renders each citation as `#{channelId}` and a raw `ts` — the same raw-identifier problem Task 9 fixed on the approval card, on the surface whose entire value proposition is "answers cite the real Slack messages".

**Files:**
- Modify: `apps/dashboard/src/chat/citations.ts`
- Modify: `apps/dashboard/src/chat/sources-rail.tsx`
- Modify: `apps/dashboard/test/citations.test.ts`

**Interfaces:**
- `extractSources` already parses `memory.cite` tool outputs. Check what the citation payload actually carries **before** writing this task — if it holds a permalink, `channelFromPermalink` (already in `citations.ts`) may resolve the name with no API change at all.

- [ ] **Step 1: Establish what the citation payload holds**

Run: `npx wrangler d1 execute firefighter --remote --command "SELECT source_kind, permalink FROM memory_episode_sources LIMIT 5;"` and read `src/memory/` for the `cite` result shape.

Decide from the evidence:
- **If the permalink carries the channel name** — resolve locally in `citations.ts`, no worker change.
- **If it carries only an id** — add the same `channels` LEFT JOIN Task 4 used, in whichever query backs `memory.cite`.

Record which branch you took in `phase-24-notes.md`; do not guess.

- [ ] **Step 2: Write the failing test**

Extend `apps/dashboard/test/citations.test.ts` with a case asserting the resolved display fields — channel name and a formatted date — for a citation whose raw form carries an id and a Slack `ts`. Include one case where resolution fails, asserting the raw id survives rather than rendering blank.

- [ ] **Step 3: Render words**

In `sources-rail.tsx`, replace `#{channelId}` and the bare `ts` with the resolved name and a `Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })` date. Keep the 2-line clamp on the fact, keep "open thread →", keep the `null` render when there are no sources.

- [ ] **Step 4: Run and commit**

Run: `pnpm --filter @workspace/dashboard test -- citations`

```bash
git add apps/dashboard/src/chat apps/dashboard/test/citations.test.ts
git commit -m "feat(chat): citations name their channel and date"
```

---

### Task 13: The nudge, the captions, and the roadmap entry

The worker composes a Block Kit DM in `src/notify/blocks.ts` that no one on the dashboard ever sees. Showing it is how the page explains that Slack notifies and only the dashboard decides — the thing that lets us skip a Slack interactivity endpoint entirely.

**Files:**
- Create: `apps/dashboard/src/components/nudge-preview.tsx`
- Create: `apps/dashboard/src/components/caption.tsx`
- Modify: `apps/dashboard/src/app.tsx`
- Modify: `docs/superpowers/plans/00-roadmap.md`

- [ ] **Step 1: A shared caption primitive**

```tsx
/** One muted sentence under a panel, explaining the mechanism rather than
 *  selling it. Global Constraints: direct and technical, no preamble. */
export function Caption({ children }: { children: React.ReactNode }) {
  return <p className="px-1 pt-2 text-xs text-muted-foreground">{children}</p>;
}
```

- [ ] **Step 2: The nudge preview**

Render the shape `nudgeBlocks` produces — "Waiting on you: reply to #channel", the `*Why:*` line, the blockquoted draft, and a **Review** button that is a plain link. Drive it off the first open approval when there is one, and a static example otherwise. Caption it: *"A notification, not a control surface — the button is a link, so there is no interactivity endpoint and no second place state can diverge."*

Note honestly in a code comment that this is a re-rendering of the payload, not the payload itself; if it drifts from `notify/blocks.ts`, the worker is the source of truth.

- [ ] **Step 3: Three captions**

Under approvals: *"Only the dashboard approves. Rejections need a reason — that reason is what the agent learns from."*
Under the nudge preview: as above.
Under the team table: *"Access is a hardcoded allowlist. Each engineer connects their own Slack and GitHub — the agent replies and opens PRs as the person on duty."*

- [ ] **Step 4: Add the roadmap entry**

`00-roadmap.md` ends at Phase 23. Append a Phase 24 entry in the established format — Goal, Depends on, Files, Tasks, Exit criteria — pointing at this plan. Record the two deferrals (identity revoke, handoff summary) as their own future phases so they are not lost.

- [ ] **Step 5: Full verification**

```bash
pnpm typecheck && pnpm build
pnpm --filter @workspace/worker test && pnpm --filter @workspace/dashboard test
```

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src docs/superpowers/plans/00-roadmap.md
git commit -m "feat(dashboard): show the nudge, and say why each surface works this way"
```

---

## Verification

**Automated:**
- `pnpm typecheck` and `pnpm build` at the root (turbo covers both apps).
- `pnpm --filter @workspace/worker test` — 93+ existing files must stay green; four new suites: counters key contract, approvals channel join (mapped and unmapped), rotation `shiftBy`/`upcoming`/`lastShiftBefore` including the pre-epoch case, and `listRunOutcomes` including the `in_doubt` refusal.
- `pnpm --filter @workspace/dashboard test`.

**By hand, on localhost (`pnpm dev`):**
- Every new panel in all four `PanelState` cases. Kill the worker mid-session and confirm each renders `Panel`'s error state with a working Retry — never a blank card.
- `dev-stubs.ts` updated in Tasks 7 and 9; if a new panel looks empty locally, suspect the stub before the component.
- Font: DevTools → Computed → `body` `font-family` reads `Inter Variable`, served same-origin.

**Against real data:**
```bash
cd apps/worker
npx wrangler d1 execute firefighter --remote --command \
  "SELECT COUNT(*) AS heard FROM events_seen WHERE received_at >= strftime('%s','now','-1 day')*1000;"
```
Compare with the funnel's first number.

```bash
npx wrangler d1 execute firefighter --remote --command \
  "SELECT run_id, namespace, method, state FROM codemode_effects WHERE state='completed' ORDER BY created_at DESC LIMIT 10;"
```
Every completed `github.openPR` here should have a chip on its row.

**Deployed:** one visual pass on `firefighter.sayandeten.workers.dev` after deploy. The unchecked browser-eyes boxes from G14-1 and phases 15/16/17 (`my-assignment-is-almost-composed-cloud.md` item 10) are still open — close them in the same pass.

**Cold-open check** (borrowed from Phase 22, cheap to run here): show the dashboard to someone who has never seen it and time how long until they can say what the system does. The narration in Task 12 is what this measures.
