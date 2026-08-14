# Phase 17 — Chat Page + Citations — Implementation Plan

> ⚠️ **SUPERSEDED, 2026-08-14 — DO NOT EXECUTE THIS FILE.**
> Execute [`2026-08-14-phase-17-chat-page-amended.md`](2026-08-14-phase-17-chat-page-amended.md)
> instead. This plan was written on 2026-08-13 against Phase 15's *plan*; the
> amended version was written against Phase 15's *shipped code* and corrects
> four things this file gets wrong — most importantly that `CiteOutput` has no
> `channel_id` (the binding strips it), which makes this file's
> `SourceChip.channelId: string` unsatisfiable. Kept for provenance only.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "What happened with X?" answered on a chat page whose citations open the actual Slack threads — built almost entirely from parts that already exist.

**Architecture:** Dashboard-only; **zero worker changes**. The chat page is Phase 15's `SessionView` + `useRunSession` pointed at a run created by the existing `POST /api/runs` (`chat:{uuid}` origin). The session list is the existing `GET /api/runs` filtered client-side to `origin === "chat"`. Citations are extracted from the event stream the drawer already renders: every capability call is a `tool_call` event named `namespace.method`, so completed `memory.cite` calls carry `{fact, permalink, ...}` outputs — a pure extractor turns them into a sources rail, and permalinks inside assistant text linkify.

**Tech Stack:** React 19, Phase 14/15's `apps/dashboard` stack. No new dependencies, no router library (hash navigation).

**Spec:** `docs/superpowers/specs/2026-08-10-firefighter-agent-design.md` §6, §10. Roadmap entry: `00-roadmap.md` Phase 17.

## Global Constraints

All of `00-roadmap.md` "Global Constraints" apply. The ones that bite here:

- **Never construct a Slack URL.** Citations render permalinks the worker stored (decision D4); the client never assembles `archives/` URLs from channel + ts. Linkification only wraps URLs already present in content verbatim.
- **Loading, empty, error states** for the session list, the session pane, and the sources rail.
- **Viewer role works fully here with no OAuth** — chat is read/ask, and `POST /api/runs` sits behind Access with no fire-fighter gate; assert nothing in this page checks `role`.
- **One origin, relative paths, no tokens in the bundle. Commit after every task.**

## Depends on

Phase 10 (chat runs + citations exist server-side), Phase 14 (shell), and **Phase 15** (`SessionView`, `useRunSession`, `runs/api.ts`) — a dependency the old roadmap sketch omitted and this plan makes explicit. Execute after 15 is merged.

## Outcome

- A "Chat" tab beside the dashboard (hash navigation, `#chat`), viewer-friendly.
- Session list: past `chat:` runs (summary or first-message preview, age, status), newest first; click reopens the full session with backlog-then-live replay.
- "New chat" composer: type a question → `POST /api/runs {firstMessage, requestId}` → the session opens streaming. The composer IS the "start a run by hand from the chat page" deliverable; a copy-run-id button sits in the session header (the copy-ID button Priya asked for).
- Assistant answers show a **Sources** rail: each cited fact as a chip — fact text, `#channel`, timestamp — opening the real Slack permalink in a new tab. Permalinks inside the answer text are clickable in place.
- Ask about a real past thread → the answer's citations open the actual Slack messages (the canonical "what happened with PulseFit?" proof).

## What this phase deliberately does not do

- **No worker API.** The old sketch's `src/api/chat.ts` is not built — `POST /api/runs` + `GET /api/runs` already cover creation and listing. (If chat volume ever makes client-side origin filtering wasteful, an `origin` query param on the existing list route is a two-line later change.)
- **No message-level citation anchoring.** The rail cites the answer, not individual sentences — the run stream does not carry sentence-to-fact mapping, and inventing one client-side would be a lie.
- **No deleting/renaming chat sessions.** Runs are the record; the list shows them.
- **No component-test infra** — the Phase 14/15/16 speed call. Two pure extractors get node tests; everything else is the one visual pass.

## Non-negotiable invariants

1. **Citations come only from completed `memory.cite` tool-call outputs and verbatim URLs in content.** No synthesis, no channel+ts assembly, no dedupe that rewrites a permalink.
2. **`requestId` (a fresh `crypto.randomUUID()`) accompanies every run creation**, and a retry after a network error reuses it — `createChatRun` is idempotent on it server-side; a flaky submit must not open two runs.
3. **The session component is Phase 15's, unmodified.** If chat needs something `SessionView` lacks, extend `SessionView` via props in `src/runs/` — never fork a chat copy. ("Two pages holds honestly.")
4. **External links are `target="_blank"` + `rel="noopener noreferrer"`** — permalinks leave the origin; nothing else does.
5. **Hash routes are the only routing** (`#chat`, `#chat/run=<id>`, plus 15's `#run=<id>`); back/forward must work (listen to `hashchange`, render from the hash, never from shadow state).

## Public contracts

Consumes (all existing — pin in Task 1, do not guess):

- Phase 15: `SessionView`, `useRunSession`, `runs/api.ts` (`RunSummary`, `fetchRuns`), `SessionState`/`SessionItem` (the extractor's input).
- Worker: `POST /api/runs` body `{firstMessage?, requestId?}` → `201 {run}`; `run.origin` is `"chat"` for these; `GET /api/runs?limit=50`.
- Citation payload: `memory.cite` tool-call `output` — pin the exact shape from `apps/worker/src/codemode/generated/capabilities.d.ts` (`CiteOutput`) and `src/memory/cite.ts` (`Citation`: `factId`, `fact`, `permalink`, `channel_id`, `ts`).

Produces:

```ts
// apps/dashboard/src/chat/citations.ts  (pure)
export type SourceChip = { factId: string; fact: string; permalink: string; channelId: string; ts: string };
/** Completed memory.cite outputs across the session, deduped by permalink, in call order. */
export function extractSources(items: SessionItem[]): SourceChip[];
/** Split text into text/link segments for verbatim Slack permalink URLs. */
export function linkifySlackUrls(content: string): Array<{ kind: "text"; text: string } | { kind: "link"; url: string }>;

// apps/dashboard/src/chat/api.ts
export async function createChat(firstMessage: string, requestId: string): Promise<RunSummary>;
export async function fetchChatSessions(): Promise<RunSummary[]>;  // fetchRuns(50) → origin === "chat"

// apps/dashboard/src/chat/chat-page.tsx
export function ChatPage(): ReactNode;  // owns list + active session + new-chat composer
```

## File structure

- Create: `apps/dashboard/src/chat/citations.ts`, `src/chat/api.ts`, `src/chat/sources-rail.tsx`, `src/chat/session-list.tsx`, `src/chat/chat-page.tsx`, `test/citations.test.ts`
- Modify: `apps/dashboard/src/app.tsx` (tab nav Dashboard | Chat from the hash; route `#chat…` to `ChatPage`), `src/runs/session-view.tsx` ONLY IF a props extension is needed (e.g. a `renderContent` hook for linkified text — see Task 3 Step 2)

## Execution speed rules — READ BEFORE DISPATCHING ANY TASK

Phase 14/15's regime; overrides per-step commands wherever they conflict.

1. **Gates are `pnpm --filter @workspace/dashboard build` and typecheck.** The one vitest file runs by exact path: `cd apps/dashboard && pnpm exec vitest run test/citations.test.ts`.
2. **One typecheck per task**, at the end.
3. **One visual pass, in Task 4.** No `pnpm dev` between tasks.
4. **Dispatch = the task's own text + Public contracts + these rules**, plus read access to `apps/dashboard/src/runs/*` (the Phase 15 surface) and — Task 1 only — `apps/worker/src/codemode/generated/capabilities.d.ts` + `apps/worker/src/memory/cite.ts` to pin the citation shape.
5. **Review depth:** deep for Task 3 (the SessionView reuse seam — the place a fork would sneak in); light for 1 and 2; medium for 4.
6. **No new dependencies, no router.**

### Parallel wave schedule

| Wave | Tasks (concurrent) | Why safe |
|---|---|---|
| A | **1** ∥ **2** | pure extractors + their tests vs chat API + session list — disjoint files |
| B | **3** | page assembly consumes both |
| C | **4** | nav wiring, visual pass, gate |

## Task order

### Task 1 — Citation extractors

**Files:** create `src/chat/citations.ts`, `test/citations.test.ts`.

- [ ] **Step 1: Pin the shape.** Read `CiteOutput` in the generated `.d.ts` and `Citation` in `src/memory/cite.ts`; copy exact field names (`channel_id` is snake_case at the source — map it to `channelId` in `SourceChip` and test the mapping).
- [ ] **Step 2: Failing tests.** `extractSources`: a session with two completed `memory.cite` tool calls yields chips in call order; a `running` or `failed` cite call contributes nothing; a non-cite tool call (`memory.recall`, `run_code`) contributes nothing; duplicate permalinks dedupe keeping the first; malformed output (missing `permalink`, output not an array/object of the pinned shape) contributes nothing and throws nothing. `linkifySlackUrls`: text with one `https://…slack.com/archives/…` URL splits into three segments with the URL byte-exact; text with no URL is one text segment; two URLs; a URL at the start/end; **a URL-shaped string missing the scheme stays text** (never guess).
- [ ] **Step 3: Implement.** Pure functions; the URL matcher is one conservative regex for `https://` + host containing `slack.com` + `/archives/` — anything else stays text.
- [ ] **Step 4: Run by exact path + typecheck; PASS. Commit:** `feat(chat): citation extraction and permalink linkification, pinned to the worker's shapes`

### Task 2 — Chat API + session list

**Files:** create `src/chat/api.ts`, `src/chat/session-list.tsx`.

- [ ] **Step 1: Implement `api.ts`.** `createChat` posts `{firstMessage, requestId}` via the Phase 15/16 `postJson` helper; `fetchChatSessions` = `fetchRuns(50)` filtered to `origin === "chat"`, sorted by `updatedAt` desc. (No test file — both are one-liners over already-tested layers; Phase 15's tests own the transport.)
- [ ] **Step 2: Implement `session-list.tsx`.** `Panel` titled "Chats", `usePoll(fetchChatSessions, 10_000)`; rows: summary (fallback "Untitled chat"), status chip, relative age; active row highlighted; empty hint "Ask about any customer thread — answers cite the real Slack messages."; click → `onSelect(id)`.
- [ ] **Step 3: Typecheck. Commit:** `feat(chat): chat session list over the existing runs API`

### Task 3 — The chat page

**Files:** create `src/chat/sources-rail.tsx`, `src/chat/chat-page.tsx`; possibly extend `src/runs/session-view.tsx` (props only).

- [ ] **Step 1: `sources-rail.tsx`.** Renders `SourceChip[]`: fact text (2-line clamp), `#channelId` + ts caption, wrapping `<a href={permalink} target="_blank" rel="noopener noreferrer">`. Empty → render nothing (the rail earns its space only when sources exist).
- [ ] **Step 2: Assemble `chat-page.tsx`.** Two-column layout: `session-list` left; right side is either the new-chat state (centered composer: textarea + "Ask" → `createChat` with a per-submit-retained requestId → select the new run) or an open session: Phase 15's `SessionView` via `useRunSession(id)`, header with the run summary + **copy-run-id button** (`navigator.clipboard.writeText`, "copied" flash), `SourcesRail` fed `extractSources(session.items)`. For in-text links: if `SessionView` renders content as plain text, add ONE optional prop (`renderContent?: (content: string) => ReactNode`) to it and pass a renderer built on `linkifySlackUrls` — extension via props, never a fork (invariant 3).
- [ ] **Step 3: Typecheck. Commit:** `feat(chat): chat page reusing the one session component, with a sources rail`

### Task 4 — Navigation, visual pass, gate

**Files:** modify `src/app.tsx`.

- [ ] **Step 1: Tabs from the hash.** Header nav Dashboard | Chat; `#chat` renders `ChatPage`, `#chat/run=<id>` opens that session, everything else renders the dashboard grid (15's `#run=` drawer keeps working). One `useHashRoute()` helper listening to `hashchange`; back/forward verified.
- [ ] **Step 2: Visual pass.** `wrangler dev` + `pnpm dev`. New chat: "What happened with PulseFit exports?" (or any thread your local D1 actually holds — check with `pnpm exec wrangler d1 execute firefighter --local --command "SELECT channel_id, text FROM messages LIMIT 5"` and ask about that). Verify: run streams; sources rail appears when the model cites; a chip opens the real Slack message; in-text permalinks clickable; copy-id copies; reload on `#chat/run=<id>` reopens the session; back button returns to the dashboard; viewer-role page (no OAuth connected) fully works. Kill both processes.
- [ ] **Step 3: Gate:** dashboard build + `pnpm exec vitest run test/citations.test.ts`.
- [ ] **Step 4: Commit:** `feat(chat): ask the org's memory and land on the real threads`

## Test matrix

| Row | Proven by |
|---|---|
| Only completed `memory.cite` outputs become sources | Task 1 tests |
| Malformed/foreign tool outputs never break the page | Task 1 tests |
| No constructed URLs — verbatim permalinks only | Task 1 linkify tests + invariant 1 review |
| Idempotent chat creation under retry | shared requestId (Task 3) over `createChatRun`'s server-side idempotency |
| One session component, no fork | Task 3 review (deep) |
| Citations open the actual Slack messages | Task 4 live proof, recorded in `phase-17-notes.md` |

## Exit criteria

Ask about a real past thread; get a streamed answer whose sources rail and in-text links open the actual Slack messages. New-chat, reopen, back/forward, and viewer-role all work. Build + typecheck + the citations test green; visual proof recorded in `phase-17-notes.md`.

## Downstream handoff

- **Phase 21:** the chat page is where handoff-summary spot-checks happen; no new surface needed.
- **Phase 22:** the two-pages claim ("dashboard + chat, one session component") is now literally true — the cold-open test walks both tabs; state sweep covers `session-list`, the composer, and the rail.
- **Phase 23:** the Loom's "ask about X" segment records this page.
