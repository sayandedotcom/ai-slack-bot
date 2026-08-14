# Chat Page + Citations (Phase 17, Amended) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Status: NOT scheduled for execution. This file is deliberately uncommitted** — it supersedes `phase-17-chat-page-citations.md` by folding in four code-verified amendments and two wireframe-informed touches. When execution starts, this document is the authority; the original stays in git history untouched.

**Goal:** The dashboard's second page — Chat — where a human types first: "what happened with X?" gets a streamed answer whose citations open the real Slack threads, and "ship the copy-ID button" starts a run by hand. Built almost entirely from the phase-15 session stack; **zero worker changes**.

**Architecture:** The chat page is `SessionView` + `useRunSession` (phase 15, reused unmodified except one optional prop) pointed at a run created by the existing `POST /api/runs` (origin `"chat"`, idempotent on `requestId` via `createChatRun`). The session list is `GET /api/runs` filtered client-side to `origin === "chat"`. Citations are extracted purely from completed `memory.cite` tool-call outputs already present in the event stream; the chip's channel caption is *parsed out of* the worker-stored permalink, never constructed.

**Tech Stack:** React 19, Vite, Tailwind 4, `@workspace/ui` (shadcn), vitest (node env, no component-test infra). No new dependencies, no router library — hash navigation only.

**Spec:** `docs/superpowers/specs/2026-08-10-firefighter-agent-design.md` §6, §10 · roadmap `docs/superpowers/plans/00-roadmap.md` Phase 17 · original plan `docs/superpowers/plans/phase-17-chat-page-citations.md` · Zellify wireframe (screenshots reviewed 2026-08-14; "illustrative only").

## Global Constraints

- **Never construct a Slack URL.** Chips render permalinks the worker stored; `linkifySlackUrls` only wraps URLs already present verbatim in content. Parsing a channel ID *out of* a stored permalink for display is allowed; assembling `archives/…` from parts is not.
- **Loading, empty, error states** exist for the session list, the session pane, and the sources rail (rail's empty state = render nothing).
- **Viewer role works fully** — chat is read/ask; nothing on this page checks `role`.
- **One origin, relative paths, no tokens in the bundle.**
- **One session component.** Chat mounts phase 15's `SessionView`; extension happens via props on the original, never a fork.
- **Hash routes are the only routing**: `#` (dashboard), `#run=<id>` (dashboard drawer, unchanged), `#chat`, `#chat/run=<id>`. Back/forward must work — render from the hash, listen to `hashchange`, never from shadow state.
- **Idempotent creation**: every `POST /api/runs` carries a `crypto.randomUUID()` `requestId`; a retry after a network error reuses the same one (the worker dedupes on it), so a flaky submit never opens two runs.
- **External links** are `target="_blank" rel="noopener noreferrer"`. Only permalinks leave the origin.
- **Execution regime:** see the next section. It overrides the per-step `Run:` lines wherever they conflict.

## Execution speed rules — READ BEFORE DISPATCHING ANY TASK

The phase 14/15/16 house rules. They override the per-step commands below
wherever they conflict.

1. **Focused tests by exact path, never by pattern.** Run
   `cd apps/dashboard && pnpm exec vitest run test/citations.test.ts`.
   NEVER `pnpm --filter @workspace/dashboard test -- <pattern>` — a pattern
   that matches nothing (or everything) runs far more than intended; a measured
   "focused" pattern run in this repo cost 71s where the exact-path run costs
   ~5s.
2. **The gate is the build, not a suite.** `pnpm --filter @workspace/dashboard build`
   already runs `tsc --noEmit`, so a separate typecheck after it is wasted time.
   **One typecheck per task, at the end** — never per step.
3. **Never run the worker suite.** Nothing in this phase touches
   `apps/worker/**` (see amendment list — zero worker changes). A subagent that
   runs `apps/worker`'s 1600-test suite is burning two minutes for nothing.
4. **One visual pass, in Task 4.** Do not leave `pnpm dev` running between
   tasks; boot it for the pass, then kill it. Booting it per task costs more
   than the pass itself.
5. **Dispatch = the task's own text + the File Structure table + this section.**
   A subagent must not re-explore the repo to rediscover what the plan already
   states. Grant it the files its task names plus, for Task 3 only, read access
   to `apps/dashboard/src/runs/session-view.tsx` and `run-drawer.tsx` (the reuse
   seam). No wider exploration.
6. **Run wave A's two tasks CONCURRENTLY.** Their file sets are disjoint by
   construction (see the wave table); dispatching them serially doubles the
   wall-clock for no safety gain.
7. **Review depth is not uniform.** Deep (read the whole diff): Task 3 — the
   `SessionView` reuse seam, where a fork would sneak in. Light (skim tests,
   accept): Tasks 1 and 2. Task 4 medium.
8. **No new dependencies.** No router, no state library, no test infra. Every
   new package is a review question.
9. **Commit after every task**, conventional prefixes. Do not push.

## The four amendments over the original phase-17 doc (code-verified 2026-08-14)

1. **`channel_id` never reaches the event stream.** The `memory.cite` binding (`apps/worker/src/codemode/bindings/memory.ts:183-190`) deliberately strips it; the generated contract (`apps/worker/src/codemode/generated/capabilities.d.ts:81-86`) is `CiteOutput = { factId; fact; permalink; ts }[]`. The original plan's `SourceChip.channelId: string` is unsatisfiable from tool output. **Resolution:** `channelId` becomes `string | null`, parsed from the permalink path (`/archives/<CHANNEL>/…`); caption falls back to the timestamp alone when parsing fails. Matches the wireframe's `#channel · date` chip without a worker change.
2. **`postJson` is module-private** in `apps/dashboard/src/runs/api.ts:61`. **Resolution:** export it (one-word change); `chat/api.ts` imports it. Never duplicate the helper.
3. **`SessionView` has no `renderContent` prop and `CopyId` is private to `run-drawer.tsx`.** **Resolution:** add one optional prop `renderContent?: (content: string) => ReactNode` to `SessionView` (threaded into turn and draft rendering); move `CopyId` verbatim to `src/components/copy-id.tsx` and re-import it in `run-drawer.tsx`.
4. **Routing/nav generalization is real work.** `app.tsx`'s `useSelectedRun` only knows `#run=`; `Header` has no nav. **Resolution:** Task 4 replaces `useSelectedRun` with `useHashRoute()` and gives `Header` two anchor tabs. `GET /api/runs` has no `origin` query param — client-side filtering stands (a two-line worker change later if volume ever demands it).

## Wireframe-informed touches (prototype is "illustrative only"; these are the two worth keeping)

- **"Try asking" empty state:** the new-chat pane shows four hardcoded suggestion prompts; clicking one fills the composer. Serves the "understand it cold in 30 seconds" grading criterion.
- **Chip caption `#<channel> · <time>`** with the fact text — covered by amendment 1.
- Explicitly **not** built from the wireframe: the explainer cards ("What this door proves", "One Slack app, two tokens", "The nudge as it reaches Luka") are prototype exposition for the assignment's reader, not app features. The wireframe's Chat page has no session list; we keep the original plan's list anyway (reopen past chats; still two pages).

## What this phase deliberately does not do

- **No worker API changes.** `POST /api/runs` + `GET /api/runs` already cover creation and listing (`apps/worker/src/api/runs.ts`, `createChatRun` in `apps/worker/src/run/coordinator.ts`).
- **No message-level citation anchoring** — the stream carries no sentence-to-fact mapping; inventing one client-side would be a lie. The rail cites the answer.
- **No deleting/renaming chat sessions.** Runs are the record.
- **No component-test infra.** The two pure extractor modules get node tests; everything else is the Task 4 visual pass.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `apps/dashboard/src/chat/citations.ts` | Create | Pure extraction: `memory.cite` outputs → `SourceChip[]`; permalink → channel ID; content → text/link segments |
| `apps/dashboard/test/citations.test.ts` | Create | Node tests for both extractors + the permalink parser |
| `apps/dashboard/src/chat/api.ts` | Create | `createChat`, `fetchChatSessions` — thin, over already-tested layers |
| `apps/dashboard/src/chat/session-list.tsx` | Create | Left column: polled list of past chat runs |
| `apps/dashboard/src/chat/sources-rail.tsx` | Create | Renders `SourceChip[]`; nothing when empty |
| `apps/dashboard/src/chat/chat-page.tsx` | Create | Page assembly: list + composer/new-chat state + open session |
| `apps/dashboard/src/components/copy-id.tsx` | Create | `CopyId` moved verbatim out of `run-drawer.tsx` |
| `apps/dashboard/src/runs/api.ts` | Modify | `export` the existing `postJson` (line 61); export nothing else new |
| `apps/dashboard/src/runs/session-view.tsx` | Modify | Add optional `renderContent` prop; thread into `TurnRow` + draft |
| `apps/dashboard/src/runs/run-list.tsx` | Modify | `export` the existing `ago` helper (line 49) |
| `apps/dashboard/src/runs/run-drawer.tsx` | Modify | Delete local `CopyId`; import from `../components/copy-id` |
| `apps/dashboard/src/components/header.tsx` | Modify | Add Dashboard / Chat anchor tabs driven by a `page` prop |
| `apps/dashboard/src/app.tsx` | Modify | Replace `useSelectedRun` with `useHashRoute`; route `#chat…` to `ChatPage` |

### Parallel wave schedule

| Wave | Tasks | Why safe |
|---|---|---|
| A | **1** ∥ **2** | pure extractors + tests vs. API/list (files disjoint; Task 2's one shared-file edit is `runs/api.ts` + `runs/run-list.tsx`, untouched by Task 1) |
| B | **3** | page assembly consumes both |
| C | **4** | nav wiring, visual pass, gate |

**Review depth:** deep for Task 3 (the `SessionView` reuse seam — where a fork would sneak in); light for 1–2; medium for 4.

---

### Task 1: Citation extractors

**Files:**
- Create: `apps/dashboard/src/chat/citations.ts`
- Test: `apps/dashboard/test/citations.test.ts`

**Interfaces:**
- Consumes: `SessionItem` from `../runs/session-reducer` (union of `turn | tool_call | status | draft`; a `tool_call` item is `{ kind: "tool_call"; call: ToolCallView }` with `call.name: string`, `call.state: "running" | "completed" | "failed"`, `call.output?: unknown`).
- Produces (Task 3 relies on these exact names):
  ```ts
  export type SourceChip = { factId: string; fact: string; permalink: string; channelId: string | null; ts: string };
  export type ContentSegment = { kind: "text"; text: string } | { kind: "link"; url: string };
  export function extractSources(items: SessionItem[]): SourceChip[];
  export function channelFromPermalink(permalink: string): string | null;
  export function linkifySlackUrls(content: string): ContentSegment[];
  ```

- [ ] **Step 1: Pin the shape at the source.** Read `apps/worker/src/codemode/generated/capabilities.d.ts` lines ~78–103 and `apps/worker/src/codemode/bindings/memory.ts` lines ~180–190. Confirm the tool output is `{ factId: string; fact: string; permalink: string; ts: string }[]` — **no `channel_id`**. If the shape has drifted, stop and update this plan before writing tests.

- [ ] **Step 2: Write the failing tests** in `apps/dashboard/test/citations.test.ts`. Follow the house pattern: plain vitest node env, no jsdom, data-in/data-out (see `test/session-reducer.test.ts` for tone).

```ts
import { describe, expect, it } from "vitest";

import {
  channelFromPermalink,
  extractSources,
  linkifySlackUrls,
} from "../src/chat/citations";
import type { SessionItem } from "../src/runs/session-reducer";

const PERMALINK_A = "https://zellify.slack.com/archives/C0123ABCD/p1723600000000100";
const PERMALINK_B = "https://zellify.slack.com/archives/C0456EFGH/p1723600000000200";

function citeCall(
  output: unknown,
  state: "running" | "completed" | "failed" = "completed",
  callId = "call-1",
): SessionItem {
  return {
    kind: "tool_call",
    call: { callId, name: "memory.cite", state, output, startedAt: 1, endedAt: 2 },
  };
}

function entry(overrides: Partial<Record<"factId" | "fact" | "permalink" | "ts", string>> = {}) {
  return {
    factId: "f1",
    fact: "PulseFit hit a currency-rounding bug on the annual plan",
    permalink: PERMALINK_A,
    ts: "1723600000.000100",
    ...overrides,
  };
}

describe("extractSources", () => {
  it("yields chips from completed memory.cite calls in call order", () => {
    const items: SessionItem[] = [
      citeCall([entry()], "completed", "call-1"),
      citeCall([entry({ factId: "f2", permalink: PERMALINK_B })], "completed", "call-2"),
    ];
    expect(extractSources(items).map((chip) => chip.factId)).toEqual(["f1", "f2"]);
  });

  it("maps the permalink's channel segment into channelId", () => {
    const [chip] = extractSources([citeCall([entry()])]);
    expect(chip?.channelId).toBe("C0123ABCD");
  });

  it("ignores running and failed cite calls", () => {
    const items: SessionItem[] = [
      citeCall([entry()], "running"),
      citeCall([entry()], "failed", "call-2"),
    ];
    expect(extractSources(items)).toEqual([]);
  });

  it("ignores non-cite tool calls and non-tool items", () => {
    const items: SessionItem[] = [
      {
        kind: "tool_call",
        call: { callId: "c", name: "memory.recall", state: "completed", output: [entry()], startedAt: 1, endedAt: 2 },
      },
      { kind: "turn", turn: { id: "t1", role: "assistant", source: "agent", content: PERMALINK_A, createdAt: 1 } },
    ];
    expect(extractSources(items)).toEqual([]);
  });

  it("dedupes by permalink keeping the first", () => {
    const items: SessionItem[] = [
      citeCall([entry(), entry({ factId: "f2" })], "completed", "call-1"),
    ];
    const chips = extractSources(items);
    expect(chips).toHaveLength(1);
    expect(chips[0]?.factId).toBe("f1");
  });

  it("contributes nothing and throws nothing on malformed output", () => {
    const items: SessionItem[] = [
      citeCall(undefined),
      citeCall("not an array", "completed", "call-2"),
      citeCall([{ fact: "missing everything else" }], "completed", "call-3"),
      citeCall([entry({ permalink: undefined as unknown as string })], "completed", "call-4"),
    ];
    expect(extractSources(items)).toEqual([]);
  });
});

describe("channelFromPermalink", () => {
  it("extracts the channel segment", () => {
    expect(channelFromPermalink(PERMALINK_A)).toBe("C0123ABCD");
  });

  it("returns null for non-archive or non-slack URLs", () => {
    expect(channelFromPermalink("https://example.com/archives/C0123ABCD/p1")).toBeNull();
    expect(channelFromPermalink("https://zellify.slack.com/messages/C0123ABCD")).toBeNull();
  });
});

describe("linkifySlackUrls", () => {
  it("splits one embedded permalink into three segments, URL byte-exact", () => {
    expect(linkifySlackUrls(`see ${PERMALINK_A} for the thread`)).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", url: PERMALINK_A },
      { kind: "text", text: " for the thread" },
    ]);
  });

  it("returns one text segment when there is no URL", () => {
    expect(linkifySlackUrls("no links here")).toEqual([{ kind: "text", text: "no links here" }]);
  });

  it("handles a URL at the start, at the end, and two URLs", () => {
    expect(linkifySlackUrls(`${PERMALINK_A} then ${PERMALINK_B}`)).toEqual([
      { kind: "link", url: PERMALINK_A },
      { kind: "text", text: " then " },
      { kind: "link", url: PERMALINK_B },
    ]);
  });

  it("leaves a scheme-less URL-shaped string as text — never guess", () => {
    const bare = "zellify.slack.com/archives/C0123ABCD/p1";
    expect(linkifySlackUrls(bare)).toEqual([{ kind: "text", text: bare }]);
  });

  it("returns no segments for the empty string", () => {
    expect(linkifySlackUrls("")).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail.**

Run: `cd apps/dashboard && pnpm exec vitest run test/citations.test.ts`
Expected: FAIL — cannot resolve `../src/chat/citations`.

- [ ] **Step 4: Implement** `apps/dashboard/src/chat/citations.ts`:

```ts
/**
 * Pure citation extraction for the chat page. Every capability call the agent
 * makes arrives as a `tool_call` item named `namespace.method`; completed
 * `memory.cite` calls carry `{factId, fact, permalink, ts}[]` outputs (the
 * worker strips `channel_id` before the model ever sees it — see
 * `apps/worker/src/codemode/bindings/memory.ts`). The chip's channel caption is
 * therefore *parsed out of* the stored permalink; nothing here ever assembles a
 * Slack URL from parts.
 */

import type { SessionItem } from "../runs/session-reducer";

export type SourceChip = {
  factId: string;
  fact: string;
  permalink: string;
  /** The `/archives/<CHANNEL>/` segment of the permalink; null when absent. */
  channelId: string | null;
  ts: string;
};

/** Mirrors the worker's generated `CiteOutput` element — keep in step. */
type CiteEntry = { factId: string; fact: string; permalink: string; ts: string };

function isCiteEntry(value: unknown): value is CiteEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.factId === "string" &&
    typeof record.fact === "string" &&
    typeof record.permalink === "string" &&
    typeof record.ts === "string"
  );
}

export function channelFromPermalink(permalink: string): string | null {
  const match = /^https:\/\/[^/\s]*slack\.com\/archives\/([A-Za-z0-9]+)\//.exec(permalink);
  return match === null ? null : (match[1] as string);
}

/** Completed `memory.cite` outputs across the session, deduped by permalink, in call order. */
export function extractSources(items: SessionItem[]): SourceChip[] {
  const seen = new Set<string>();
  const chips: SourceChip[] = [];
  for (const item of items) {
    if (item.kind !== "tool_call") continue;
    if (item.call.name !== "memory.cite" || item.call.state !== "completed") continue;
    if (!Array.isArray(item.call.output)) continue;
    for (const raw of item.call.output) {
      // Malformed entries contribute nothing and throw nothing: a foreign or
      // truncated payload must never take the page down.
      if (!isCiteEntry(raw)) continue;
      if (seen.has(raw.permalink)) continue;
      seen.add(raw.permalink);
      chips.push({
        factId: raw.factId,
        fact: raw.fact,
        permalink: raw.permalink,
        channelId: channelFromPermalink(raw.permalink),
        ts: raw.ts,
      });
    }
  }
  return chips;
}

export type ContentSegment = { kind: "text"; text: string } | { kind: "link"; url: string };

/**
 * Conservative on purpose: only `https://…slack.com/archives/…` URLs already
 * present verbatim become links; anything else — including scheme-less
 * URL-shaped strings — stays text.
 */
const SLACK_PERMALINK = /https:\/\/[^\s<>"]*slack\.com\/archives\/[^\s<>"]+/g;

export function linkifySlackUrls(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  let last = 0;
  for (const match of content.matchAll(SLACK_PERMALINK)) {
    if (match.index > last) segments.push({ kind: "text", text: content.slice(last, match.index) });
    segments.push({ kind: "link", url: match[0] });
    last = match.index + match[0].length;
  }
  if (last < content.length) segments.push({ kind: "text", text: content.slice(last) });
  return segments;
}
```

- [ ] **Step 5: Run tests to verify they pass.**

Run: `cd apps/dashboard && pnpm exec vitest run test/citations.test.ts`
Expected: PASS (all rows).

- [ ] **Step 6: Typecheck** (once, end of task): `pnpm --filter @workspace/dashboard typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src/chat/citations.ts apps/dashboard/test/citations.test.ts
git commit -m "feat(chat): citation extraction and permalink linkification, pinned to the worker's shapes"
```

---

### Task 2: Chat API + session list

**Files:**
- Create: `apps/dashboard/src/chat/api.ts`, `apps/dashboard/src/chat/session-list.tsx`
- Modify: `apps/dashboard/src/runs/api.ts:61` (export `postJson`), `apps/dashboard/src/runs/run-list.tsx:49` (export `ago`)

**Interfaces:**
- Consumes: `postJson`, `fetchRuns`, `RunSummary`, `RunDetail` from `../runs/api`; `Panel`, `PanelState` from `../components/panel`; `usePoll` from `../lib/use-poll`; `StatusChip`, `ago` from `../runs/run-list`.
- Produces (Tasks 3–4 rely on these exact names):
  ```ts
  // chat/api.ts
  export function createChat(firstMessage: string, requestId: string): Promise<RunDetail>;
  export function fetchChatSessions(): Promise<RunSummary[]>; // origin === "chat", updatedAt desc
  // chat/session-list.tsx
  export function SessionList(props: { activeId: string | null; onSelect: (id: string) => void }): ReactNode;
  ```
- No test file: both API functions are one-liners over layers phase 15's tests already own (`test/runs-api.test.ts` covers `postJson`'s error discipline through `postSteer`).

- [ ] **Step 1: Export the two private helpers.** In `runs/api.ts` change `async function postJson` → `export async function postJson` (keep the doc comment). In `runs/run-list.tsx` change `function ago` → `export function ago`. No other edits to either file.

- [ ] **Step 2: Implement** `apps/dashboard/src/chat/api.ts`:

```ts
/**
 * The chat page's network surface: two thin calls over the runs API. Creation
 * is `POST /api/runs` — the same endpoint triage does NOT use; a body with
 * `firstMessage` mints a run with origin "chat" (`createChatRun`), idempotent
 * on `requestId`. Listing is the shared runs list filtered here, client-side:
 * the worker has no `origin` query param and chat volume does not justify one.
 */

import { fetchRuns, postJson } from "../runs/api";
import type { RunDetail, RunSummary } from "../runs/api";

export async function createChat(firstMessage: string, requestId: string): Promise<RunDetail> {
  const body = await postJson<{ run: RunDetail }>("/api/runs", { firstMessage, requestId });
  return body.run;
}

export async function fetchChatSessions(): Promise<RunSummary[]> {
  const runs = await fetchRuns(50);
  return runs
    .filter((run) => run.origin === "chat")
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
```

- [ ] **Step 3: Implement** `apps/dashboard/src/chat/session-list.tsx`:

```tsx
import { useMemo } from "react";
import type { ReactNode } from "react";

import { Panel, type PanelState } from "../components/panel";
import { usePoll } from "../lib/use-poll";
import { StatusChip, ago } from "../runs/run-list";
import type { RunSummary } from "../runs/api";
import { fetchChatSessions } from "./api";

const POLL_MS = 10_000;

/**
 * Past chat runs, newest first. Mirrors `RunList`'s shape but stays its own
 * component: it polls a different (filtered) view, highlights the open
 * session, and never shows origin badges — everything here is origin "chat".
 */
export function SessionList({
  activeId,
  onSelect,
}: {
  activeId: string | null;
  onSelect: (id: string) => void;
}): ReactNode {
  const polled = usePoll<RunSummary[]>(useMemo(() => () => fetchChatSessions(), []), POLL_MS);

  const state: PanelState<RunSummary[]> =
    polled.kind === "ready" && polled.data.length === 0
      ? { kind: "empty", hint: "Ask about any customer thread — answers cite the real Slack messages." }
      : polled;

  const now = Date.now();

  return (
    <Panel title="Chats" state={state}>
      {(sessions) => (
        <ul className="space-y-2">
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                onClick={() => onSelect(session.id)}
                aria-current={session.id === activeId ? "true" : undefined}
                className={`flex w-full flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                  session.id === activeId ? "border-primary/50 bg-primary/5" : "bg-card"
                }`}
              >
                <div className="flex items-center gap-2">
                  <StatusChip status={session.status} />
                  <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                    {ago(session.updatedAt, now)}
                  </span>
                </div>
                <p className="truncate text-sm">
                  {session.summary ?? <span className="text-muted-foreground">Untitled chat</span>}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
```

- [ ] **Step 4: Typecheck**: `pnpm --filter @workspace/dashboard typecheck`
Expected: clean. (Vitest run not required — no new test file; Task 1's file must still pass if run.)

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/chat/api.ts apps/dashboard/src/chat/session-list.tsx apps/dashboard/src/runs/api.ts apps/dashboard/src/runs/run-list.tsx
git commit -m "feat(chat): chat session list over the existing runs API"
```

---

### Task 3: Sources rail + the chat page

**Files:**
- Create: `apps/dashboard/src/chat/sources-rail.tsx`, `apps/dashboard/src/chat/chat-page.tsx`, `apps/dashboard/src/components/copy-id.tsx`
- Modify: `apps/dashboard/src/runs/session-view.tsx` (one optional prop), `apps/dashboard/src/runs/run-drawer.tsx` (import `CopyId` instead of defining it)

**Interfaces:**
- Consumes: `SessionView`, its `Connection` type (`runs/session-view.tsx`); `useRunSession(runId) → { session, connection, steer }` (`runs/use-run-session.ts`); `extractSources`, `linkifySlackUrls`, `SourceChip` (Task 1); `createChat` and `SessionList` (Task 2).
- Produces (Task 4 relies on this exact name):
  ```ts
  export function ChatPage(props: { runId: string | null; onSelectRun: (id: string | null) => void }): ReactNode;
  ```
  Routing stays outside: `ChatPage` receives the open run from the hash and reports selection upward; it never touches `location`.

- [ ] **Step 1: Move `CopyId`.** Create `apps/dashboard/src/components/copy-id.tsx` containing the `CopyId` component **verbatim** from `run-drawer.tsx:27-58` (including its comment), with `export function CopyId`. In `run-drawer.tsx`, delete the local definition and add `import { CopyId } from "../components/copy-id";`. No behavior change.

- [ ] **Step 2: Extend `SessionView` via one prop — never fork.** In `runs/session-view.tsx`:
  - Add to the props type: `renderContent?: (content: string) => ReactNode;`
  - Thread it: `ItemRow` gains the prop and passes it to `TurnRow`; inside `TurnRow`'s `<p>`, render `{renderContent === undefined ? turn.content : renderContent(turn.content)}`. Do the same for the draft branch's text (before the cursor span).
  - Everything else in the file stays untouched; when the prop is absent, output is byte-identical to today (the dashboard drawer keeps passing nothing).

- [ ] **Step 3: Implement** `apps/dashboard/src/chat/sources-rail.tsx`:

```tsx
import type { ReactNode } from "react";

import type { SourceChip } from "./citations";

/**
 * The answer's receipts: each cited fact links to the actual Slack message via
 * the worker-stored permalink. Renders nothing when there are no sources —
 * the rail earns its space only when the agent cited something.
 */
export function SourcesRail({ sources }: { sources: SourceChip[] }): ReactNode {
  if (sources.length === 0) return null;
  return (
    <section aria-label="Sources" className="space-y-2">
      <h3 className="text-[11px] uppercase tracking-wide text-muted-foreground">Sources</h3>
      <ul className="space-y-2">
        {sources.map((source) => (
          <li key={source.permalink}>
            <a
              href={source.permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-lg border border-l-2 border-l-primary/60 bg-card px-3 py-2 transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <p className="line-clamp-2 text-sm">{source.fact}</p>
              <p className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                {source.channelId === null ? null : <span>#{source.channelId}</span>}
                <span className="tabular-nums">{source.ts}</span>
                <span className="ml-auto">open thread →</span>
              </p>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 4: Implement** `apps/dashboard/src/chat/chat-page.tsx`:

```tsx
import { useCallback, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { Button } from "@workspace/ui/components/button";

import { CopyId } from "../components/copy-id";
import { SessionView } from "../runs/session-view";
import { useRunSession } from "../runs/use-run-session";
import { createChat } from "./api";
import { extractSources, linkifySlackUrls } from "./citations";
import { SessionList } from "./session-list";
import { SourcesRail } from "./sources-rail";

/**
 * The second door into the one agent: a human types first. Left, past chat
 * runs; right, either the new-chat composer or an open session — which is
 * phase 15's SessionView over the same socket the dashboard drawer uses.
 */

const SUGGESTIONS = [
  "what shipped for customers this week?",
  "which customer is angriest right now and why?",
  "did PulseFit complain about checkout before, and what did we do?",
  "summarize Driftwear's big ask for Monday's standup",
];

/** Verbatim permalinks in assistant text become in-place links. */
function renderLinkedContent(content: string): ReactNode {
  const segments = linkifySlackUrls(content);
  if (segments.length === 1 && segments[0]?.kind === "text") return content;
  return segments.map((segment, index) =>
    segment.kind === "text" ? (
      <span key={index}>{segment.text}</span>
    ) : (
      <a
        key={index}
        href={segment.url}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-primary underline underline-offset-2"
      >
        {segment.url}
      </a>
    ),
  );
}

function NewChat({ onCreated }: { onCreated: (id: string) => void }): ReactNode {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One requestId per submission attempt, held across retries: the worker
  // dedupes on it, so a flaky network cannot open two runs for one question.
  const requestIdRef = useRef<string | null>(null);

  const submit = useCallback(async () => {
    const firstMessage = draft.trim();
    if (firstMessage === "" || sending) return;
    requestIdRef.current ??= crypto.randomUUID();
    setSending(true);
    setError(null);
    try {
      const run = await createChat(firstMessage, requestIdRef.current);
      requestIdRef.current = null;
      onCreated(run.id);
    } catch {
      setError("Couldn't start the chat — check the connection and try again.");
    } finally {
      setSending(false);
    }
  }, [draft, sending, onCreated]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
      <div className="w-full max-w-xl space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Ask the agent</h2>
        <p className="text-sm text-muted-foreground">
          Same brain that answers Slack — ask what memory knows, or hand it work.
        </p>
        {error === null ? null : (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
            {error}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              // New text is a new question; a retained retry id belongs to the old one.
              requestIdRef.current = null;
            }}
            onKeyDown={onKeyDown}
            rows={3}
            disabled={sending}
            placeholder="Ask anything, or hand it work…"
            aria-label="Start a new chat"
            className="min-h-0 flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
          />
          <Button type="button" onClick={() => void submit()} disabled={sending || draft.trim() === ""}>
            {sending ? "Starting…" : "Ask"}
          </Button>
        </div>
        <div className="space-y-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Try asking</p>
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => setDraft(suggestion)}
              className="block w-full rounded-md border bg-card px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              “{suggestion}”
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Own component so the socket hook mounts/unmounts with the selected run. */
function ChatSession({ runId }: { runId: string }): ReactNode {
  const { session, connection, steer } = useRunSession(runId);
  const sources = useMemo(() => extractSources(session.items), [session.items]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <CopyId runId={runId} />
      </div>
      <div className="min-h-0 flex-1">
        <SessionView
          session={session}
          connection={connection}
          onSteer={steer}
          composerPlaceholder="Reply — Enter to send, Shift+Enter for a newline"
          renderContent={renderLinkedContent}
        />
      </div>
      <SourcesRail sources={sources} />
    </div>
  );
}

export function ChatPage({
  runId,
  onSelectRun,
}: {
  runId: string | null;
  onSelectRun: (id: string | null) => void;
}): ReactNode {
  return (
    <main className="mx-auto grid h-[calc(100svh-57px)] max-w-6xl grid-cols-1 gap-4 p-6 md:grid-cols-[minmax(220px,1fr)_2fr]">
      <div className="min-h-0 overflow-y-auto">
        <SessionList activeId={runId} onSelect={onSelectRun} />
        {runId === null ? null : (
          <Button variant="outline" size="sm" className="mt-3" onClick={() => onSelectRun(null)}>
            New chat
          </Button>
        )}
      </div>
      <div className="min-h-0 rounded-lg border bg-background">
        {runId === null ? (
          <NewChat onCreated={onSelectRun} />
        ) : (
          // Keyed so switching sessions remounts the socket hook, exactly as
          // app.tsx does for the drawer.
          <div className="h-full p-3">
            <ChatSession key={runId} runId={runId} />
          </div>
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 5: Typecheck**: `pnpm --filter @workspace/dashboard typecheck`
Expected: clean. Also re-run Task 1's tests (extractors are now consumed): `cd apps/dashboard && pnpm exec vitest run test/citations.test.ts` — PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/chat/sources-rail.tsx apps/dashboard/src/chat/chat-page.tsx apps/dashboard/src/components/copy-id.tsx apps/dashboard/src/runs/session-view.tsx apps/dashboard/src/runs/run-drawer.tsx
git commit -m "feat(chat): chat page reusing the one session component, with a sources rail"
```

---

### Task 4: Navigation, visual pass, gate

**Files:**
- Modify: `apps/dashboard/src/app.tsx` (replace `useSelectedRun` with `useHashRoute`; route to `ChatPage`), `apps/dashboard/src/components/header.tsx` (tab nav)

**Interfaces:**
- Consumes: `ChatPage` (Task 3). Everything else already lives in `app.tsx`.
- Produces: the four routes — `#` / `#run=<id>` (dashboard, drawer preserved) and `#chat` / `#chat/run=<id>`.

- [ ] **Step 1: Routing.** In `app.tsx`, replace `useSelectedRun` with:

```tsx
type Route =
  | { page: "dashboard"; runId: string | null }
  | { page: "chat"; runId: string | null };

function parseHash(hash: string): Route {
  const chat = /^#chat(?:\/run=(.+))?$/.exec(hash);
  if (chat !== null) {
    return { page: "chat", runId: chat[1] === undefined ? null : decodeURIComponent(chat[1]) };
  }
  const drawer = /^#run=(.+)$/.exec(hash);
  if (drawer !== null) {
    return { page: "dashboard", runId: decodeURIComponent(drawer[1] as string) };
  }
  return { page: "dashboard", runId: null };
}

function routeToHash(route: Route): string {
  if (route.page === "chat") {
    return route.runId === null ? "#chat" : `#chat/run=${encodeURIComponent(route.runId)}`;
  }
  return route.runId === null ? "" : `#run=${encodeURIComponent(route.runId)}`;
}

/** Same discipline as the old `useSelectedRun`: the hash is the state; back,
 * forward, and a hand-edited hash are all the same event to us. */
function useHashRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(location.hash));
    addEventListener("hashchange", onHashChange);
    return () => removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    location.hash = routeToHash(next);
    setRoute(next);
  }, []);

  return [route, navigate];
}
```

  Then in `App`: `const [route, navigate] = useHashRoute();`. The dashboard drawer becomes `route.page === "dashboard" ? route.runId : null` with `selectRun(id)` → `navigate({ page: "dashboard", runId: id })`; the chat page renders when `route.page === "chat"`:

```tsx
<Header identity={identity} page={route.page} />
{route.page === "chat" ? (
  <ChatPage
    runId={route.runId}
    onSelectRun={(id) => navigate({ page: "chat", runId: id })}
  />
) : (
  <>{/* existing dashboard <main> grid, untouched */}</>
)}
```

  The `<RunSession>` drawer mount keeps its `key` and only renders on the dashboard page.

- [ ] **Step 2: Header tabs.** `Header` gains `page: "dashboard" | "chat"` and renders, between the title and the identity block:

```tsx
<nav aria-label="Pages" className="flex items-center gap-1">
  {(
    [
      ["dashboard", "Dashboard", "#"],
      ["chat", "Chat", "#chat"],
    ] as const
  ).map(([key, label, href]) => (
    <a
      key={key}
      href={href}
      aria-current={page === key ? "page" : undefined}
      className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
        page === key ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </a>
  ))}
</nav>
```

  Anchors, not buttons: writing the hash *is* the navigation, and `hashchange` does the rest — no handler code.

- [ ] **Step 3: Visual pass** (the one for the whole phase). Run `pnpm --filter @workspace/worker dev` (wrangler on 8787) and `pnpm --filter @workspace/dashboard dev`; the Vite proxy carries `/api` and `/ws`. Find a real ingested thread first: `cd apps/worker && pnpm exec wrangler d1 execute firefighter --local --command "SELECT channel_id, text FROM messages LIMIT 5"` and ask about that. Verify, in order:
  - Cold `#chat`: session list empty state + composer + four "Try asking" suggestions; clicking one fills the textarea.
  - Ask the question → run appears, transcript streams, tool-call chips render (`memory.recall`, `memory.cite`).
  - Sources rail appears once the model cites; a chip opens the real Slack message in a new tab; caption shows `#<channel-id>` + ts.
  - A permalink inside assistant text is clickable in place.
  - Copy-id copies; "copied" flash shows.
  - Reload on `#chat/run=<id>` reopens the same session (backlog then live); browser Back returns to `#chat`, then to the dashboard; the dashboard `#run=<id>` drawer still works.
  - Steer mid-run from the chat composer; the optimistic pending row appears and resolves.
  - Viewer-role check: with no OAuth connected, every one of the above still works (nothing on the page reads `role`).
  Kill both processes. Record what was seen (and the citation screenshot) in `docs/superpowers/plans/phase-17-notes.md`.

- [ ] **Step 4: Gate.**

Run: `pnpm --filter @workspace/dashboard build && cd apps/dashboard && pnpm exec vitest run test/citations.test.ts`
Expected: build + typecheck clean, tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/app.tsx apps/dashboard/src/components/header.tsx docs/superpowers/plans/phase-17-notes.md
git commit -m "feat(chat): ask the org's memory and land on the real threads"
```

---

## Test matrix

| Behaviour | Proven by |
|---|---|
| Only completed `memory.cite` outputs become sources | Task 1 tests |
| Channel caption parsed from permalink, null-safe | Task 1 tests (`channelFromPermalink` rows) |
| Malformed/foreign tool outputs never break the page | Task 1 tests |
| No constructed URLs — verbatim permalinks only | Task 1 linkify tests + Task 3 review |
| Idempotent chat creation under retry | Task 3 `requestIdRef` over `createChatRun`'s server-side dedupe (worker's own tests cover the dedupe) |
| One session component, no fork | Task 3 review (deep) — the only `session-view.tsx` diff is one optional prop |
| Citations open the actual Slack messages | Task 4 live proof, recorded in `phase-17-notes.md` |
| Back/forward across all four routes | Task 4 visual pass |

## Exit criteria

Ask about a real past thread; get a streamed answer whose sources rail and in-text links open the actual Slack messages. New-chat, reopen via `#chat/run=<id>`, back/forward, steer mid-run, and viewer-role all work. Build + typecheck + citations tests green; visual proof recorded in `phase-17-notes.md`.
