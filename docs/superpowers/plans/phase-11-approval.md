# Phase 11 — Approval

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Keep the checklist current — Phase 10's checklist was not maintained and reconstructing progress from commits cost real time.

**Goal:** The agent decides when to ask; what it escalates gates on one dashboard decision (approve / edit / reject) whose state lives in D1 alone, resolves back into the same run through the one inbox, and feeds memory.

**Architecture:** Two `control_write` capabilities (`approval.escalate`, `approval.withdraw`) inside the existing single `run_code` tool. `escalate` returns immediately and records one open approval; the pause latches at generation finalize via the driver's reserved `paused` outcome, parking the run `awaiting_approval`. A human decision (`PATCH /api/approvals/:id`, Access-JWT-validated, fire-fighters only) CASes the D1 row and re-enters the run as `appendTurn({source:"approval"})`. Decision and delivery are separate state machines; in Phase 11 the injected sender is the real Slack gateway, so delivery terminates `blocked` on `identity_unavailable` and the run unparks with an honest resolution turn.

**Tech Stack:** existing Worker/RunDO/D1 stack · WebCrypto RS256 JWT validation against the Cloudflare Access team JWKS · no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-10-firefighter-agent-design.md` §5.3, as corrected by "Roadmap and design corrections" below. Planning baseline: `main` at `b84f9f4` (Phase 10 merged, deployed, live-proven).

## Global constraints

Every task inherits `00-roadmap.md`'s Global Constraints, especially:

- one generic agent; exactly one model-facing tool, `run_code`;
- approval gates **Slack replies only** — the dashboard approves Slack messages and nothing else; PR review stays on GitHub, Linear needs no approval;
- fail closed on identity: no bot-token fallback, ever (`slack.reply` and the Phase 11 sender both refuse without an engineer identity);
- D1 is the system of record; RunDO SQLite is the coordination authority; Zep is a rebuildable projection;
- approval state has **one writer surface** (the dashboard API); Slack only nudges (Phase 13);
- rejections feed memory — both what this team won't send and what it should have escalated;
- multi-turn scoping costs at most **one click**, never one per message: clarifying/status sends are the model's own judgment via `slack.reply`, not escalations;
- commit after every task, conventional prefixes; record invented APIs in `phase-11-notes.md`.

## Depends on

Phase 10 merged and deployed (done: `310f5d3`, live fixes through `b84f9f4`). D1 migrations `0001`–`0006` applied remotely (done). The write-guard's `control_write` class, the driver's reserved pause, `appendTurn`'s `approval` source, and the memory outbox all exist on `main`.

## Outcome

At the end of Phase 11:

- a model that judges a draft committal calls `approval.escalate({draft, why})`, the call returns immediately, and when the generation settles the run parks `awaiting_approval`;
- `GET /api/approvals?state=open` and `GET /api/approvals/:id` serve the card from D1 without waking any DO;
- `PATCH /api/approvals/:id` with approve/edit/reject — authorized by a validated Access JWT plus the hardcoded fire-fighter roster — decides exactly once under concurrency, delivers through the injected sender, and re-enters the run via `appendTurn({source:"approval"})`;
- in Phase 11 production, delivery terminates `blocked` (`identity_unavailable`); the resolution turn says so honestly and the run resumes rather than parking until Phase 13;
- a customer message landing on a parked run wakes the agent with the pending approval in trusted context; the model may `approval.withdraw()` and loses gracefully to an already-made human decision;
- every rejection (draft + reason) and edit (diff) reaches the org memory graph through the existing outbox;
- the dashboard `escalated` counter is real;
- the `#test-firedrill` live proof exists: escalate → park → curl-approve → blocked delivery → honest resumption.

## What this phase deliberately does not do

- No dashboard UI (Phases 14/16) — the API is curl-shaped until then.
- No Slack nudge (Phase 13), no Slack interactivity, ever.
- No real send: Phase 12 supplies identity, Phase 13 the real sender. The sender *interface* ships now.
- No approval kinds beyond `slack_reply`. The CHECK constraint enforces it.
- No AI SDK `needsApproval`, no durable-Code-Mode approval runtime — one approval mechanism, ours.
- No OAuth, no rotation, no token crypto (Phase 12). Only JWT validation + a hardcoded roster arrive early, by explicit decision.
- No per-approval expiry/TTL. A pending card waits for a human; Phase 13's nudge is the freshness mechanism.

## Roadmap and design corrections made by this plan

Kept from the prior draft (they were right): Slack-only approvals (1); the `approval` namespace inside `run_code` (2); no tool-local approval (3); decision ≠ delivery (4); real sending belongs to 13 (5); one *unsettled* approval per run via partial unique index (6); a human decision is never rolled back by delivery failure (7); approval reads never wake a DO (8).

Changed:

9. **Authorization arrives in Phase 11, not 12.** The draft composed a deny-all production authorizer, which made approve/edit/reject undemonstrable until Phase 12. Phase 11 validates `Cf-Access-Jwt-Assertion` against the team JWKS and checks a hardcoded roster; Phase 12 inherits `src/access/` untouched and adds OAuth/rotation/crypto. Decision rights: **fire-fighters only** (viewers read, never decide) — approving a message that goes out under an engineer's name is acting on a thread, which the brief reserves for fire-fighters.
10. **`blocked` delivery is terminal for this phase and unparks the run.** The draft kept the run parked until a delivery success that cannot exist before Phase 13, which would strand every real escalation for days. `identity_unavailable` maps to delivery `blocked`; the resolution turn tells the agent the human's decision *and* that the draft needs manual sending. When Phase 13 lands, `blocked` stops occurring; nothing else changes.
11. **The local approval record is authoritative for coordination; D1 is its projection.** Matches the shipped Phase 10 invariant ("RunDO records first; D1 is its queryable projection") instead of inventing a second consistency story. The card row reaches D1 through the existing projection-job machinery.

## Verification gate — read before implementation

Checked while writing this plan (2026-08-13): the shipped `write-guard.ts` (`control_write` exempt from shadow/channel gating, carries its own run-state authorization), `driver.ts` (`ContinuationOutcome` has no pause member — comment says Phase 11 adds it), `contracts.ts` (`WAKE_TURN_SOURCES` includes `"approval"`), `protocol.ts` (`awaiting_approval` legal, transitions defined), `0004_runs.sql` (status CHECK includes it), the projection-job table and `#projectionKinds()` in `do.ts`, [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) (validate signature against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, `iss`, application AUD, `exp`), [D1 `batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) (sequential, one transaction, rolls back on failure).

### Repeat at the start of implementation

- [x] `pnpm --filter @workspace/worker test && pnpm --filter @workspace/worker typecheck` — record the baseline (last known: 69 files / 1329 passed + the 2 new fix suites).
- [x] Re-read `src/agent/driver.ts` `applyOutcome`/`ContinuationOutcome` and `src/run/do.ts` finalize path — Task 4 patches both and they may have drifted.
- [x] Read the Access application AUD from the dashboard (Access → Applications → firefighter → Overview) and record it in `phase-11-notes.md`; it becomes the `ACCESS_APP_AUD` var. Confirm the team domain is `zellify-firefighter.cloudflareaccess.com`.
- [x] Confirm the four fire-fighter emails with Ronit's answer to the day-0 Slack batch (`ronit@ / luka@ / mikheil@ / zurab@zellify.app` assumed below). Do not merge guessed emails; the roster module isolates them.
- [x] Create `docs/superpowers/plans/phase-11-notes.md` with commit, versions, and an invented-API table.

## Non-negotiable invariants

1. **One approval mechanism.** No AI SDK approval, no second gate. `escalate` is a reviewed capability like any other.
2. **`escalate` never blocks.** It records and returns; the isolate cannot park.
3. **The pause latches at finalize only.** One transition authority, already epoch-fenced. A stale claimant cannot park or unpark a run.
4. **One unsettled approval per run**, enforced by a partial unique index, where *unsettled* = `pending`, or decided-approved/edited whose delivery is not yet `sent`/`blocked`.
5. **Decision is immutable once written.** Delivery failure never rewrites what the human chose.
6. **Approval state has one writer surface.** Humans write through `PATCH /api/approvals/:id` alone; the DO writes only `withdrawn` and delivery states.
7. **Reads never wake a DO.** List and card come from D1.
8. **A decision CAS has exactly one winner.** The loser receives `409 already_decided` with the winning decision.
9. **The DO is notified after the D1 decision commits, and notification is repairable.** A click is never lost to a dead DO; a sweeper re-delivers undelivered resolutions.
10. **The model never chooses the destination.** Channel/thread are snapshotted from the run's pinned scope for display; the sender re-derives them from run state at delivery time.
11. **Authorization = validated JWT + roster, decisions fire-fighters only.** Header presence is not identity; the JWKS signature, issuer, AUD, and expiry all check. Tests inject a fake verifier; production composition cannot be built without the real one.
12. **No secret, JWT, or JWKS material in events, D1 rows, logs, or memory.** `decided_by` stores the validated email — that is PII the dashboard needs, not a secret.
13. **Rejections and edits reach memory through the existing outbox**, not a new pipeline.
14. **Escalation from a shadow run parks the run but its delivery can only ever be suppressed** — the write-guard already denies external writes for shadow runs, and the sender re-checks.

## Public contracts

### Code Mode declarations (generated `.d.ts` shape)

```ts
declare const approval: {
  /**
   * Park this run for one human decision on one proposed customer Slack reply.
   * Returns immediately; the pause happens when you finish your turn. Escalate
   * when the message is committal, closes a thread, tells a customer no, or
   * could embarrass the engineer whose name is on it. Do NOT escalate
   * clarifying questions or status updates — send those with slack.reply.
   */
  escalate(input: { draft: string; why: string }): Promise<{
    approvalId: string;
    state: "pending";
  }>;
  /**
   * Retract the open approval, e.g. because the customer's newest message made
   * the draft moot. Loses gracefully: if a human already decided, you get
   * their decision back instead of a withdrawal.
   */
  withdraw(): Promise<
    | { withdrawn: true }
    | { withdrawn: false; decision: "approved" | "edited" | "rejected" }
  >;
};
```

Bounds: `draft` 1–4000 chars, `why` 1–500 chars, both `z.string().trim().min(1)`. Method names are globally unique (`escalate`, `withdraw`) per the registry's uniqueness rule.

### Decision states (D1 `approvals.decision`)

```text
pending ──(PATCH approve)──► approved
pending ──(PATCH edit)─────► edited        (edited_text recorded)
pending ──(PATCH reject)───► rejected      (reject_reason required)
pending ──(DO, model)──────► withdrawn
```

Terminal. No other transition exists; the repository refuses them by CAS shape, and a test proves each illegal pair.

### Delivery states (D1 `approvals.delivery`)

```text
none ──(decision approved|edited)──► sending ──► sent          (Phase 13+)
                                        │──────► blocked       (identity_unavailable — Phase 11 terminal)
                                        │──────► suppressed    (shadow run — never deliverable)
                                        └──────► in_doubt      (attempt outcome unknown; human reconciles)
rejected | withdrawn ⇒ delivery stays none
```

### HTTP API

| Route | Who | Behavior |
|---|---|---|
| `GET /api/approvals?state=open` | any of the 7 | D1 list: id, runId, draft, why, channel/thread snapshot, createdAt |
| `GET /api/approvals/:id` | any of the 7 | one card, plus decision/delivery state |
| `PATCH /api/approvals/:id` | fire-fighters only | body `{action:"approve"} \| {action:"edit", text} \| {action:"reject", reason}` → CAS → deliver → notify DO |

Errors: `401 access_jwt_invalid` · `403 not_a_firefighter` · `404 unknown_approval` · `409 already_decided` (returns the winning decision) · `422 invalid_action` (edit without text, reject without reason, unknown action).

### Authorization seam

```ts
// src/access/jwt.ts
export interface AccessIdentity { email: string }
export interface AccessVerifier {
  verify(jwt: string): Promise<AccessIdentity>; // throws AccessJwtError
}
export function makeAccessVerifier(cfg: { teamDomain: string; aud: string }): AccessVerifier;

// src/access/roster.ts — Phase 12 extends; Phase 11 consumes
export const FIREFIGHTERS: readonly string[]; // 4 zellify.app emails + documented personal override
export const VIEWERS: readonly string[];      // 3 zellify.app emails
export function isFirefighter(email: string): boolean;
export function isTeamMember(email: string): boolean;
```

Production composes `makeAccessVerifier` from `ACCESS_TEAM_DOMAIN` + `ACCESS_APP_AUD` (non-secret `wrangler.jsonc` vars); tests inject a fake. The JWKS fetch is cached per isolate with a 1-hour floor and refetched once on a key-miss (key rotation).

### Driver contract extension

```ts
// src/agent/driver.ts — the reserved member arrives
export type ContinuationOutcome =
  | { outcome: "completed" }
  | { outcome: "paused"; approvalId: string }           // NEW
  | { outcome: "failed"; state: ...; resumePolicy: ...; errorCode: string; errorMessage?: string }
  | { outcome: "retry"; errorCode: string; errorMessage?: string };
```

`paused` maps to public status `awaiting_approval`, driver phase `idle` (nothing to reclaim — the run wakes only through `appendTurn`). The resolution turn (`source:"approval"`) is already in `WAKE_TURN_SOURCES`, so resumption is the existing input transaction, unchanged.

## Persistence design

### D1 — `migrations/0007_approvals.sql`

```sql
CREATE TABLE approvals (
  id            TEXT PRIMARY KEY,              -- apr:{uuid}, minted DO-side
  run_id        TEXT NOT NULL REFERENCES runs(id),
  generation_id TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind = 'slack_reply'),
  draft         TEXT NOT NULL,
  why           TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  thread_ts     TEXT NOT NULL,
  shadow        INTEGER NOT NULL DEFAULT 0,
  decision      TEXT NOT NULL DEFAULT 'pending'
                CHECK (decision IN ('pending','approved','edited','rejected','withdrawn')),
  decided_by    TEXT,
  decided_at    INTEGER,
  edited_text   TEXT,
  reject_reason TEXT,
  delivery      TEXT NOT NULL DEFAULT 'none'
                CHECK (delivery IN ('none','sending','sent','blocked','suppressed','in_doubt')),
  delivery_error TEXT,
  resolution_delivered_at INTEGER,             -- when appendTurn(source:approval) committed
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_approvals_one_open ON approvals(run_id)
  WHERE decision = 'pending'
     OR (decision IN ('approved','edited') AND delivery NOT IN ('sent','blocked','suppressed'));

CREATE INDEX idx_approvals_open ON approvals(decision, created_at)
  WHERE decision = 'pending';
CREATE INDEX idx_approvals_undelivered ON approvals(resolution_delivered_at)
  WHERE decision IN ('approved','edited','rejected') AND resolution_delivered_at IS NULL;
```

`resolution_delivered_at` is invariant 9's repair key: a decided row whose resolution never reached the DO is findable by the existing one-minute `scheduled()` sweeper.

### RunDO SQLite — local schema v3 (`ensureSchema` versioned migration)

```sql
CREATE TABLE approval_state (
  approval_id   TEXT PRIMARY KEY,
  state         TEXT NOT NULL CHECK (state IN ('open','resolving','resolved')),
  draft         TEXT NOT NULL,
  why           TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
```

Written synchronously by the `escalate` capability port (`open`), by the resolution RPC (`resolved`), and by withdraw. Finalize latches `paused` iff an `open` row exists — no D1 read inside `transactionSync`. The D1 card row is projected from this record through a new projection-job kind `approval_card` using the existing `agent_projection_jobs` table and alarm dispatcher, exactly like `run_index`.

## File structure

```text
apps/worker/migrations/0007_approvals.sql            new
apps/worker/wrangler.jsonc                           modify: ACCESS_TEAM_DOMAIN, ACCESS_APP_AUD vars
apps/worker/src/access/jwt.ts                        new — Access JWT verifier
apps/worker/src/access/roster.ts                     new — hardcoded 7 emails
apps/worker/src/approval/contracts.ts                new — states, transitions, resolution payload
apps/worker/src/approval/repository.ts               new — D1 CAS ops, list/card reads
apps/worker/src/codemode/bindings/approval.ts        new — escalate/withdraw capabilities
apps/worker/src/codemode/errors.ts                   modify: approval_already_open, approval_not_open
apps/worker/src/codemode/registry.ts                 modify: add approval namespace (frozen order grows by one)
apps/worker/src/codemode/generated/capabilities.d.ts regenerate via codemode:dts
apps/worker/src/agent/driver.ts                      modify: paused outcome
apps/worker/src/agent/loop.ts                        modify: finalize latch
apps/worker/src/agent/dependencies.ts                modify: compose approval port + sender
apps/worker/src/agent/prompt/policy.ts               modify: escalation judgment block
apps/worker/src/approval/sender.ts                   new — ApprovalSender interface + Phase 11 identity-refusing impl
apps/worker/src/run/session.ts                       modify: schema v3 + approval_state helpers
apps/worker/src/run/do.ts                            modify: resolveApproval RPC, approval_card projection kind
apps/worker/src/api/approvals.ts                     new — the three routes
apps/worker/src/index.ts                             modify: route wiring + sweeper extension
apps/worker/src/db/counters.ts                       modify: real escalated counter

test/access-jwt.test.ts · test/approval-contracts.test.ts · test/approval-repository.test.ts ·
test/codemode-approval.test.ts · test/agent-pause.test.ts · test/approval-resolution.test.ts ·
test/approval-api.test.ts · test/approval-interrupt.test.ts · test/approval-e2e.test.ts
docs/superpowers/plans/phase-11-notes.md
```

## Task order

Risk-first: contracts and CAS before capabilities, pause before API, everything before deploy. Non-negotiable: Tasks 1–8. Cut-if-slipping: Task 7's coalesced-nudge bookkeeping (defer to 13), Task 9's mutation sweep breadth.

### Execution speed rules — READ BEFORE DISPATCHING ANY TASK

These override the per-step commands below wherever they conflict.

1. **Focused tests by exact path, never by pattern.** Run
   `cd apps/worker && pnpm exec vitest run test/<exact-file>.test.ts`.
   NEVER `pnpm --filter @workspace/worker test -- <pattern>` during red/green —
   a pattern that matches nothing (or many files) runs far more than intended;
   a measured "focused" pattern run cost 71s where the exact-path run costs
   ~5s. The per-step "Run:" lines below are superseded by this rule.
2. **One `pnpm exec tsc --noEmit -p tsconfig.json` per task**, at the end —
   never per step.
3. **The full suite runs exactly twice in this phase:** once at Task 9 Step 4
   (the gate), once before the Task 10 deploy. Nowhere else. A subagent that
   runs the full suite mid-task is burning two minutes for nothing.
4. **Dispatch = the task's own text + its Interfaces block + this rules
   section.** A subagent must not re-explore the repo to rediscover what the
   plan already states; grant it the files named in the task and let it read
   only those plus their direct imports.
5. **Review depth is not uniform.** Deep review (read the whole diff): Tasks
   4, 5, 6 — fencing, idempotency, authz. Light review (skim tests, accept):
   Tasks 1, 2, 3, 8. Task 7 medium.
6. **Trivial code skips ceremony.** Where a step's implementation is a
   constant table or a single query (`roster.ts`, the `escalated` counter),
   one red/green cycle for the module is enough — do not write a failing test
   per assertion.

### Parallel wave schedule

Tasks keep their numbers; dispatch them in these waves. Within a wave, run
subagents CONCURRENTLY — the file sets are disjoint by construction.

| Wave | Tasks (concurrent) | Why safe |
|---|---|---|
| A | **1** ∥ **2** | zero shared files (approval/* + migration vs access/*) |
| B | **3** ∥ **8** | 3 touches codemode/*; 8 touches prompt/policy.ts + counters (needs only Task 1's table) |
| C | **4** ∥ **6** | 4 touches agent/loop+driver+session/do; 6 touches api/* against the notifier PORT (see Task 6 note) — its only do.ts contact is deferred to wave D |
| D | **5**, then wire 6's notifier (15 min) | 5 owns do.ts; the wiring step is one composition line |
| E | **7** | needs 4+5 |
| F | **9**, then **10** | serial by nature |

Merge order within a wave doesn't matter; rebase conflicts are limited to
`index.ts` route/wiring lines and are mechanical.

### Task 0 — Baseline and gates

- [x] **Step 1:** Run the baseline commands from "Repeat at the start of implementation"; record counts in `phase-11-notes.md`.
- [x] **Step 2:** Record the Access AUD, team domain, and confirmed roster emails in the notes. If the roster answer from Ronit has not arrived, proceed with the assumed emails but tag the roster module `// UNCONFIRMED` and add a release gate line in notes.
- [x] **Step 3:** Commit: `docs(approval): record phase 11 verification baseline`

### Task 1 — Approval contracts and D1 repository

**Files:** create `src/approval/contracts.ts`, `src/approval/repository.ts`, `migrations/0007_approvals.sql`, `test/approval-contracts.test.ts`, `test/approval-repository.test.ts`.

**Interfaces produced:**

```ts
// contracts.ts
export type ApprovalDecision = "pending"|"approved"|"edited"|"rejected"|"withdrawn";
export type ApprovalDelivery = "none"|"sending"|"sent"|"blocked"|"suppressed"|"in_doubt";
export type ApprovalRow = { id: string; runId: string; generationId: string; draft: string;
  why: string; channelId: string; threadTs: string; shadow: boolean;
  decision: ApprovalDecision; decidedBy: string|null; decidedAt: number|null;
  editedText: string|null; rejectReason: string|null; delivery: ApprovalDelivery;
  createdAt: number; updatedAt: number };
export type DecisionInput =
  | { action: "approve" } | { action: "edit"; text: string } | { action: "reject"; reason: string };
/** The text that will actually be sent: edited_text when edited, else draft. */
export function outboundText(row: ApprovalRow): string;

// repository.ts
export async function insertApproval(db: D1Database, card: NewApprovalCard): Promise<"created"|"duplicate_open">;
export async function decideApproval(db: D1Database, id: string, input: DecisionInput, decidedBy: string, now: number):
  Promise<{ result: "decided"; row: ApprovalRow } | { result: "already_decided"; row: ApprovalRow } | { result: "not_found" }>;
export async function withdrawApproval(db: D1Database, id: string, now: number):
  Promise<{ result: "withdrawn" } | { result: "already_decided"; row: ApprovalRow } | { result: "not_found" }>;
export async function setDelivery(db: D1Database, id: string, from: ApprovalDelivery[], to: ApprovalDelivery, error: string|null, now: number): Promise<boolean>;
export async function markResolutionDelivered(db: D1Database, id: string, now: number): Promise<void>;
export async function listOpen(db: D1Database, limit?: number): Promise<ApprovalRow[]>;
export async function getApproval(db: D1Database, id: string): Promise<ApprovalRow|null>;
export async function listUndeliveredResolutions(db: D1Database, limit: number): Promise<ApprovalRow[]>;
```

- [x] **Step 1: Write failing repository tests.** Real D1 via the workerd pool (no `isolatedStorage`; mint unique run ids per test, per the standing harness rules). Cover: insert; **partial-index enforcement** — second insert for the same run while the first is `pending` returns `duplicate_open`, and again while first is `approved`+`delivery='none'`, but succeeds after `delivery='blocked'`; `decideApproval` CAS — two concurrent `approve` and `reject` calls via `Promise.all` yield exactly one `decided` and one `already_decided` carrying the winner; `edit` without text and `reject` without reason are refused at the contracts layer (typed error, no row change); `withdrawApproval` on a decided row returns `already_decided`; `setDelivery` moves only along legal `from` states; illegal decision transitions (`approved→rejected` etc.) are unreachable because `decideApproval` only CASes from `pending` — assert the row is untouched.
- [x] **Step 2: Run, verify FAIL** (`cd apps/worker && pnpm exec vitest run test/approval-repository.test.ts`).
- [x] **Step 3: Implement.** Migration as specified in Persistence design. `decideApproval` is a `db.batch()` of the conditional UPDATE (`WHERE id=? AND decision='pending'`) then a SELECT; branch on `meta.changes`. `insertApproval` maps the unique-index violation to `duplicate_open` by catching the constraint error message — test the exact message text against real D1 and record it in notes.
- [x] **Step 4: Run tests + `cd apps/worker && pnpm exec tsc --noEmit -p tsconfig.json`; verify PASS.**
- [x] **Step 5: Commit:** `feat(approval): add decision and delivery records with one-open enforcement`

### Task 2 — Access JWT verification and roster

**Files:** create `src/access/jwt.ts`, `src/access/roster.ts`, `test/access-jwt.test.ts`; modify `wrangler.jsonc` (vars), regenerate types.

**Interfaces produced:** as in "Authorization seam" above. `AccessJwtError` carries a stable `code`: `missing|malformed|bad_signature|wrong_issuer|wrong_audience|expired`.

- [x] **Step 1: Write failing tests.** Mint a real RS256 keypair in-test via WebCrypto (`crypto.subtle.generateKey`), export the public JWK, and serve it from a fake JWKS fetcher injected into `makeAccessVerifier` (add an optional `fetchJwks` parameter defaulting to the real fetch — the test seam). Sign JWTs in-test. Cover: valid token → email out; wrong `aud`, wrong `iss`, expired `exp`, garbage token, token signed by a different key → each throws its distinct code; JWKS is fetched once for two verifications (cache); an unknown `kid` triggers exactly one refetch. Roster: `isFirefighter` true for the 4 + the documented override, false for viewers; `isTeamMember` true for all 7 + override.
- [x] **Step 2: Run, verify FAIL.**
- [x] **Step 3: Implement.** Verify with `crypto.subtle.verify("RSASSA-PKCS1-v1_5", ...)` over the JOSE signing input; check `iss === "https://{teamDomain}"`, `aud` contains `cfg.aud`, `exp > now`. Extract `email` from the payload. Roster constants with the `// UNCONFIRMED` tag if Task 0 left it.
- [x] **Step 4: Run tests, verify PASS.**
- [x] **Step 5: Commit:** `feat(access): validate the access jwt and pin the roster`

### Task 3 — The `approval` capability namespace

**Files:** create `src/codemode/bindings/approval.ts`; modify `src/codemode/errors.ts`, `src/codemode/registry.ts`, `src/agent/dependencies.ts`; regenerate `capabilities.d.ts`; create `test/codemode-approval.test.ts`.

**Interfaces consumed:** `insertApproval` (Task 1). **Produces:** the `ApprovalPort` the loop and DO share:

```ts
// contracts.ts addition
export interface ApprovalPort {
  /** Synchronous local open + async D1 projection enqueue. Returns the minted id. */
  open(input: { draft: string; why: string }): Promise<{ approvalId: string }>;
  /** Local read the finalize latch uses. Synchronous. */
  openApprovalId(): string | null;
  withdraw(): Promise<{ withdrawn: true } | { withdrawn: false; decision: Exclude<ApprovalDecision,"pending"|"withdrawn"> }>;
}
```

- [x] **Step 1: Write failing capability tests.** Through the real registry + a real isolate execution (pattern from `codemode-customers.test.ts`): `escalate` returns `{approvalId, state:"pending"}` and the port recorded it; a second `escalate` in the same or a later execution while one is open → typed `approval_already_open` (and it is in the proven-pre-upstream set — no effect ledger entry); `withdraw` with nothing open → `approval_not_open`; both methods are classified `control_write` (assert via the registry classification test's fixtures); a **shadow** run may escalate (write-guard exemption) — assert no `external_write` denial; `draft`/`why` bounds enforced by Zod host-side.
- [x] **Step 2: Run, verify FAIL.**
- [x] **Step 3: Implement.** Two `CapabilityErrorCode` additions with the closed-set test updated. Registry gains the `approval` namespace at the end of the frozen order; `codemode:dts` regenerated and drift-checked. The capability calls `deps.approval.open/withdraw` — it never touches D1 or storage itself.
- [x] **Step 4: Run `pnpm --filter @workspace/worker test -- codemode` (full codemode regression) + `codemode:dts:check` + typecheck.**
- [x] **Step 5: Commit:** `feat(codemode): let the model park a run for one human decision`

### Task 4 — Pause latch and the `paused` outcome

**Files:** modify `src/agent/driver.ts`, `src/agent/loop.ts`, `src/run/session.ts` (schema v3 + `approval_state` helpers), `src/run/do.ts` (projection kind `approval_card`, port wiring); create `test/agent-pause.test.ts`.

**Interfaces consumed:** `ApprovalPort` (Task 3). **Produces:** `ContinuationOutcome` gains `{ outcome:"paused"; approvalId }`; session helpers `openApproval(storage)`, `putApprovalState(...)`, `resolveApprovalState(...)`.

- [x] **Step 1: Write failing tests.** Using the established fake-continuation driver harness (`test/helpers/agent-driver.ts`): a generation whose execution opened an approval settles as `paused` → public status `awaiting_approval`, driver `idle`, no alarm armed for model work; a generation with no open approval settles `completed` → `idle` (regression); schema-v2 → v3 upgrade preserves all Phase 10 state and is idempotent; a crash after `escalate` recorded locally but before finalize → recovery claim re-runs, finds the open approval at its own finalize, and still parks (stable generation identity — no duplicate approval row, `insertApproval` returns `duplicate_open` and the projector treats it as success); a **stale-epoch claimant cannot park or unpark** (extend the existing fencing test with the new outcome); the `approval_card` projection job delivers the D1 row through the alarm dispatcher and retries on injected D1 failure.
- [x] **Step 2: Run, verify FAIL.**
- [x] **Step 3: Implement.** Loop: at finalize, after the pending-cursor comparison, consult `deps.approval.openApprovalId()`; if non-null return `paused`. Driver: map `paused` → status `awaiting_approval`, phase `idle`, persist `approvalId` in the generation row's existing error-free terminal fields (add a nullable `paused_approval_id` column in the v3 migration). DO: register the projection kind beside `run_index`.
- [x] **Step 4: Run `pnpm --filter @workspace/worker test -- agent-pause agent-driver agent-recovery agent-concurrency` + typecheck.**
- [x] **Step 5: Commit:** `feat(agent): park the run when the model asks for a human`

### Task 5 — Resolution: sender, DO RPC, one inbox re-entry

**Files:** create `src/approval/sender.ts`; modify `src/run/do.ts` (add `resolveApproval` RPC), `src/agent/dependencies.ts`; create `test/approval-resolution.test.ts`.

**Interfaces produced:**

```ts
// sender.ts
export interface ApprovalSender {
  /** Send the approved/edited text to the run's pinned thread AS the on-duty
   *  engineer. Phase 11's production impl refuses: identity_unavailable. */
  send(input: { runId: string; channelId: string; threadTs: string; text: string }):
    Promise<{ result: "sent"; ts: string } | { result: "blocked"; reason: string } | { result: "in_doubt"; reason: string }>;
}
export function makeIdentityRefusingSender(): ApprovalSender; // Phase 11 production

// do.ts RPC
async resolveApproval(input: { approvalId: string; decision: "approved"|"edited"|"rejected";
  outboundText: string|null; rejectReason: string|null; decidedBy: string }): Promise<{ applied: boolean }>
```

Resolution order inside the RPC (each step idempotent on `approvalId`): (1) shadow run ⇒ delivery `suppressed`, skip send; (2) else approved/edited ⇒ D1 `setDelivery none→sending` then `sender.send` then `sending→sent|blocked|in_doubt`; (3) `appendTurn({ id: "approval:"+approvalId, source: "approval", content: <structured resolution: decision, final text or reason, delivery outcome> })` — the existing input transaction wakes the driver; (4) local `approval_state → resolved`; (5) D1 `markResolutionDelivered`. A crash between (2) and (3) is repaired by the sweeper re-invoking the RPC — the turn id makes re-entry idempotent, and a `sending` row found on re-entry maps to `in_doubt` rather than a second send attempt.

- [x] **Step 1: Write failing tests.** With a fake sender and real DO: approve → delivery `blocked` (production sender) → resolution turn committed once with `source:"approval"` → run transitions `awaiting_approval → live` (driver wakes) and the next fake generation sees the resolution in its transcript as user-authority input; edit → `outboundText` uses the edited text; reject → no send attempted, reason lands in the turn; duplicate `resolveApproval` (sweeper replay) appends no second turn (idempotent id) and re-marks delivery consistently; shadow run → `suppressed`, no sender call; fake sender returning `in_doubt` → delivery `in_doubt`, resolution turn says so, run still resumes (the human decision is fact regardless of delivery).
- [x] **Step 2: Run, verify FAIL.**
- [x] **Step 3: Implement.**
- [x] **Step 4: Run `pnpm --filter @workspace/worker test -- approval-resolution run-do` + typecheck.**
- [x] **Step 5: Commit:** `feat(approval): resolve a human decision through the one inbox`

### Task 6 — The HTTP API

**Files:** create `src/api/approvals.ts`; modify `src/index.ts` (routes + sweeper extension + verifier composition); create `test/approval-api.test.ts`.

**Interfaces consumed:** repository (Task 1), verifier/roster (Task 2), and a
**notifier port this task defines itself** so it can run concurrently with
Tasks 4–5:

```ts
// src/api/approvals.ts
export interface ResolutionNotifier {
  notify(input: { runId: string; approvalId: string; decision: "approved"|"edited"|"rejected";
    outboundText: string|null; rejectReason: string|null; decidedBy: string }): Promise<{ applied: boolean }>;
}
```

All Task 6 tests use a fake notifier. The production composition line —
`notify` calling the RunDO stub's `resolveApproval` (Task 5) — is written as
the single wave-D wiring step, NOT here. Everything else in this task
(authz, CAS-through-HTTP, 409/422/404, sweeper re-delivery via the fake) is
provable without Task 5 existing.

- [x] **Step 1: Write failing tests.** Through `SELF.fetch` with an injected fake verifier (compose via the same key-scoped test-port pattern the run layer uses): list/card require any team email — a valid JWT for a viewer works, a valid JWT for an outsider email → 403, no/garbage JWT → 401; PATCH as a **viewer** → `403 not_a_firefighter`, row untouched; PATCH approve as a fire-fighter → 200, response carries decision+delivery, and the DO received exactly one `resolveApproval`; concurrent PATCH approve vs reject → one 200, one `409 already_decided` carrying the winner; edit without text / reject without reason → 422; unknown id → 404; **DO notify failure after D1 commit** (inject a failing stub) → PATCH still returns 200 with `resolutionDelivered:false`, the row is decided, and the extended sweeper (invoke `scheduled()` directly in-test) re-delivers via `listUndeliveredResolutions`; reads hit D1 only (assert zero DO invocations for GET).
- [x] **Step 2: Run, verify FAIL.**
- [x] **Step 3: Implement.** Routes in Hono beside `src/api/runs.ts` conventions. The sweeper extension queries `listUndeliveredResolutions(db, 10)` each minute and re-invokes the owning DO's `resolveApproval`.
- [x] **Step 4: Run tests + typecheck.**
- [x] **Step 5: Commit:** `feat(api): decide approvals from the dashboard alone`

### Task 7 — Interruption and withdraw

**Files:** modify `src/agent/prompt/context.ts` (pending-approval trusted context), `src/run/do.ts`; extend `test/approval-interrupt.test.ts`.

- [x] **Step 1: Write failing tests.** Customer message on a parked run → run wakes (existing inbox), new generation's trusted context contains the pending approval (id + draft + why, from local `approval_state`, never from model-supplied data); model calls `withdraw` → D1 `pending→withdrawn` CAS, local `resolved`, escalate becomes possible again (partial index frees); withdraw racing a human decision — hold the PATCH CAS and the withdraw CAS behind a barrier → exactly one wins; when the human won, `withdraw` returns `{withdrawn:false, decision}` and the model's next step can react; when withdraw won, a late PATCH gets `409 already_decided` with `withdrawn`.
- [x] **Step 2: Run, verify FAIL.**
- [x] **Step 3: Implement.** Context builder reads `openApproval(storage)`; interruption requires no new wake machinery (the inbox already wakes on `customer`).
- [x] **Step 4: Run tests + typecheck.**
- [x] **Step 5: Commit:** `feat(approval): interrupt and withdraw without losing the human's click`

### Task 8 — Prompt judgment, memory, counter

**Files:** modify `src/agent/prompt/policy.ts`, `src/agent/memory.ts` (episode includes approval outcome — verify it already flows via actions/outcome fields before adding anything), `src/db/counters.ts`; extend `test/agent-prompt.test.ts`, `test/memory-outbox.test.ts`, counters test.

- [x] **Step 1: Write failing tests.** Prompt snapshot: policy contains the escalate/send distinction (committal, closing a thread, saying no, embarrassment ⇒ escalate; clarifying question, status update ⇒ `slack.reply` directly), names both capabilities, states that escalate returns immediately and the pause happens at turn end, and stays **byte-identical across two builds** (cache safety — it is all constants). Memory: a generation that settled `paused` and was later rejected produces, in the *following* generation's outbox episode, the rejection reason and draft (assert on the episode JSON through the existing outbox test harness); an edit produces the human's text beside the model's. Counter: `escalated` counts `approvals` rows created in the window; the D1 query matches the Phase 05 counter contract shape.
- [x] **Step 2: Run, verify FAIL.**
- [x] **Step 3: Implement.** Policy text additions only in the stable block. Counter reads D1, no DO wakes.
- [x] **Step 4: Run tests + typecheck.**
- [x] **Step 5: Commit:** `feat(approval): teach the judgment, remember the outcome, count the asks`

### Task 9 — Failure matrix, security sweep, full gate

**Files:** extend `test/approval-e2e.test.ts` + existing suites.

- [x] **Step 1: Crash-window tests.** (1) local open committed, D1 card projection pending, worker dies → alarm re-projects, card appears once; (2) D1 decided, DO never notified → sweeper delivers, one resolution turn; (3) delivery `sending`, crash before outcome → re-entry maps to `in_doubt`, never a second send; (4) resolution turn committed, `markResolutionDelivered` failed → sweeper re-invocation is a no-op (idempotent turn id) and repairs the mark.
- [x] **Step 2: Security tests.** A forged `resolveApproval`-shaped browser frame over the run WebSocket cannot inject an approval turn (existing `parseClientMessage` rejection extended to the new source); a JWT for a non-roster email can read nothing and decide nothing; secret canaries (existing harness) extended over approval rows, events, and the resolution turn — no JWT material anywhere; `decided_by` appears in D1 and the API but never in model context (the resolution turn carries the decision, not the decider — the model has no business knowing which engineer clicked).
- [x] **Step 3: Mutation review (manual, recorded, TIMEBOXED to three).** Break each and confirm a test fails: drop the partial unique index; skip JWT validation on PATCH; latch the pause from a stale epoch. Record the other three candidate mutations (viewer PATCH, decision rollback on delivery failure, model-supplied channel) in notes as reviewed-by-reading, not mutation-tested.
- [x] **Step 4: Full gate.** `pnpm --filter @workspace/worker test` · `codemode:dts:check` · `typecheck` · `pnpm lint` · `pnpm build` · `wrangler deploy --dry-run`. Compare counts to Task 0 baseline.
- [x] **Step 5: Commit:** `test(approval): prove the gate under crashes, races, and forgery`

### Task 10 — Deploy and live proof

> **Status 2026-08-13:** All five steps are done and verified live. Deployed version `2201184a-0c68-47db-b971-2abfe68edcdf`; release gate G1 closed. **Approve:** run `bca4b327…` parked on `apr:b64f4a23…`, authenticated `PATCH` → `200` with `delivery: "blocked"` / `identity_unavailable`, resumed narrating that a human must paste the draft. **Reject:** run `f723b51f…` parked on `apr:16bb9cc7…`, `PATCH` → `200` with `delivery` left at `none` (no send attempted), and the projected memory episode carrying the reason **and** the rejected draft, draft last — the live proof of the final review's Important 1. `escalated` moved 0 → 3. **Not exercised live:** an `edit` decision, and a `memory.recall` surfacing the rejection lesson (pending extraction). Full evidence in `phase-11-notes.md` → "Task 10".

- [x] **Step 1:** Apply `0007` to remote D1 (`d1 migrations list` first). Set `ACCESS_TEAM_DOMAIN`/`ACCESS_APP_AUD` vars via `wrangler.jsonc` and deploy.
- [x] **Step 2:** Post a committal-shaped message in `#test-firedrill` (e.g. a request to confirm a refund policy). Verify: run parks `awaiting_approval`; `GET /api/approvals?state=open` (browser, Access session) shows the card; the model's narration names the escalation.
- [x] **Step 3:** Approve via authenticated `PATCH` (browser devtools fetch or `curl` with a copied `CF_Authorization` cookie → document which in notes). Verify: 200, delivery `blocked`, resolution turn visible in the run snapshot, run resumed `live→idle` with an honest "approved; needs manual send" narration. — token sent as the `cf-access-token` header; transitions observed were `awaiting_approval→live→idle`.
- [x] **Step 4:** Reject a second escalation with a reason; after Zep extraction lag, `memory.recall` from a Chat run surfaces the lesson. Verify the `escalated` counter moved. — rejection verified live on run `f723b51f…` / `apr:16bb9cc7…`: `200`, `delivery` stayed `none` (no send attempted), and the projected episode carries the reason **and** the rejected draft, draft last. Counter moved 0 → 3. **One part not proven:** no later run has yet recalled *this* lesson, so it is recorded as **pending extraction** — though Zep extraction is itself proven live, since run 2 recalled an extracted fact from run 1's episode.
- [ ] **Step 5:** Record all evidence (run ids, timestamps, D1 rows, JWT rejection of a logged-out request) in `phase-11-notes.md`. Commit: `docs(approval): record phase 11 live verification`

## Test matrix (the phase is not done without each row)

| Area | Proof |
|---|---|
| one open approval | partial index refuses a second; frees after terminal delivery |
| decision CAS | concurrent approve/reject → one winner, loser gets the winner back |
| immutable decision | delivery failure never rewrites `decision` |
| pause latch | only at finalize, only fresh epoch, survives crash-and-reclaim |
| resolution | exactly one `source:"approval"` turn per approval, idempotent under sweeper replay |
| blocked delivery | `identity_unavailable` → `blocked` → run resumes with honest narration |
| authz | invalid JWT 401 · outsider 403 · viewer PATCH 403 · fire-fighter 200 |
| interruption | customer message wakes parked run with pending context; withdraw races decided exactly-once |
| shadow | can escalate; delivery only ever `suppressed` |
| memory | rejection reason + draft reach the org graph via existing outbox |
| security | no JWT/decider in model context, events, or memory; forged frames rejected |

## Exit criteria

- [x] A `#test-firedrill` escalation parks the run and the driver stops before another model step. — verified live: run `bca4b327…` went `live → awaiting_approval`, and the next event on the run was the resolution turn, with no model step in between.
- [ ] The dashboard API approves, edits, and rejects with validated identity; an edit stores the human's text; a rejection's reason reaches memory. — **approve** and **reject** both verified live with validated identity (`decidedBy: sayandeten@gmail.com`), and the rejection's reason *and rejected draft* reached the projected memory episode. Stays unticked for one reason only: **an `edit` was never exercised live**, so "an edit stores the human's text" remains proven in test only.
- [x] Delivery in Phase 11 terminates `blocked` with no bot-token fallback and the run resumes honestly. — verified live: `delivery=blocked`, `delivery_error=identity_unavailable`, run resumed to `idle` narrating that the draft must be pasted by a human.
- [x] A multi-turn scoping conversation costs at most one click — clarifying sends never create approval rows (prompt-taught, test-snapshotted). — met on this criterion's own stated basis: the policy text is in `src/agent/prompt/policy.ts` and pinned by two green cases in `test/agent-prompt.test.ts`. Not live-observed.
- [x] Full local gate green; live proof recorded in `phase-11-notes.md`. — gate green (78 files, 1495 passed, 2 skipped, 0 failed); live proof run end to end across two runs (escalate → park → authenticated approve → `blocked` → honest resumption, and escalate → park → reject → no send → reason + rejected draft into memory → honest resumption), recorded in `phase-11-notes.md` → "Task 10" with every remaining gap marked NOT RUN rather than implied.

## Downstream handoff

**Phase 12:** replace `makeIdentityRefusingSender` composition input — the sender starts resolving the on-duty engineer's decrypted user token; `src/access/` gains OAuth/rotation but the verifier/roster contracts are stable. **Phase 13:** the real Slack sender implements `ApprovalSender.send` (user-token `chat.postMessage`, correlation-id audit); the nudge fires where Task 5 marks a card open (`approval_card` projection completing is the hook); delivery `sent` becomes reachable and `blocked` extinct; reuse `idx_approvals_undelivered` for nudge-once bookkeeping. **Phase 14/16:** the card renders `GET /api/approvals`; optimistic updates key off the `409 already_decided` contract; live withdrawal arrives over the existing run WebSocket (the resolution turn is already an event). **Phase 21:** shadow escalations accumulate as eval data (`suppressed` delivery rows are the corpus).
