# Phase 12 — Identity, OAuth, Rotation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each fire-fighter connects their own Slack and GitHub identities once; a pure function always knows who is on duty; no token is ever readable at rest.

**Architecture:** Three independent pure/narrow modules (rotation math, AES-GCM token crypto, a D1 `identities` table) composed by two OAuth route pairs and one read-only status API. Everything trusts the Cloudflare Access JWT (Phase 11's `src/access/jwt.ts`) for *who is connecting* — never a query parameter.

**Tech Stack:** Hono, WebCrypto (AES-GCM + HMAC), D1, Slack OAuth v2 (`authed_user`), GitHub OAuth web flow.

**Spec:** `docs/superpowers/specs/2026-08-10-firefighter-agent-design.md` §7 (identity), §15. Roadmap entry: `00-roadmap.md` Phase 12.

## Global Constraints

All of `00-roadmap.md` "Global Constraints" apply. The ones that bite here:

- **No secret values in the repo, ever.** New secret NAMES: `IDENTITY_KEY`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`. `.dev.vars` locally, `wrangler secret put` in production.
- **No token, ciphertext, key, or OAuth code in logs, error messages, or API responses.** Status endpoints return booleans, never token material.
- **Fail closed.** An unverifiable Access JWT is a 401; a non-fire-fighter starting OAuth is a 403; a bad `state` is a 403. No dev bypass parameters (same rule as `makeAccessVerifier`).
- **Commit after every task.** Conventional prefixes.

## Depends on

Phase 01 (worker foundation) plus two Phase 11 modules already on `main`: `src/access/jwt.ts` (`makeAccessVerifier`, `AccessJwtError`) and `src/access/roster.ts` (`FIREFIGHTERS`, `VIEWERS`, `isFirefighter`, `isTeamMember`).

**Parallel-safe with Phase 11's remaining tasks.** This phase owns `src/identity/*`, `src/oauth/*`, `src/db/identities.ts`, `src/api/identity.ts`, `migrations/0008_identities.sql`. Phase 11 owns the driver, RunDO, codemode, and `0007`. The only shared file is `src/index.ts` (route wiring + Env additions) — a mechanical rebase.

## Outcome

- `onDuty(now)` returns the current fire-fighter, shift boundaries, and who is next — pure, exhaustively tested at rollover instants.
- A fire-fighter clicks "Connect Slack" / "Connect GitHub" on the (future) dashboard, completes the provider consent screen, and lands back with a stored, AES-GCM-sealed user token keyed to their **Access email**.
- `GET /api/roster` gives Phase 14 everything its rotation strip and connect panel render. `GET /api/identity` gives the header its identity.
- Phase 13 calls `getDecryptedToken(env, email, "slack")` to implement `ApprovalSender`. Phase 20 does the same for GitHub.

## What this phase deliberately does not do

- **No sending.** The Slack user token is stored, never used — `ApprovalSender` stays identity-refusing until Phase 13 Task 5b.
- **No token refresh machinery.** Slack user tokens and GitHub OAuth-app tokens do not expire on a schedule; revocation shows up as a 401 at use time and is Phase 13/20's error path.
- **No roster UI or roster storage.** The roster stays hardcoded in `src/access/roster.ts` (confirmed acceptable, phase-11-notes.md).
- **No GitHub App.** Plain OAuth app, per the current answer state; if Ronit's pending answer says GitHub App, only `src/oauth/github.ts` changes.

## Non-negotiable invariants

1. **The connecting identity is the verified Access email.** OAuth `state` binds it; the callback stores under the state's email, never under anything the provider or query string claims.
2. **Ciphertext at rest, everywhere.** D1 holds `token_ciphertext` only. `SELECT * FROM identities` must never reveal a usable credential without `IDENTITY_KEY`.
3. **Random IV per seal.** Sealing the same plaintext twice yields different ciphertexts, asserted in tests.
4. **`state` is signed and expiring** (HMAC-SHA256, 10-minute TTL, single format). Tampered, expired, or foreign-team state → 403, no exchange call made.
5. **Rotation is UTC math over `ROTATION`, not `FIREFIGHTERS`.** The personal-override email (release gate G2) is in `FIREFIGHTERS` for approval PATCH rights but must never appear on duty.
6. **`ROTATION_EPOCH_MS` and the rotation ORDER are unconfirmed** (pending Ronit — question already sent). Both carry `// UNCONFIRMED` and a note entry; changing either later is a one-line diff and a re-run of the rotation tests.

## Public contracts

```ts
// src/identity/rotation.ts
/** The four real fire-fighters in rotation order. UNCONFIRMED order. */
export const ROTATION: readonly string[]; // ["ronit@zellify.app","luka@zellify.app","mikheil@zellify.app","zurab@zellify.app"]
export const ROTATION_EPOCH_MS: number;   // Date.parse("2026-08-10T00:00:00Z") — UNCONFIRMED
export const SHIFT_MS: number;            // 3 * 86_400_000
export type Shift = { email: string; index: number; shiftStartMs: number; shiftEndMs: number; nextEmail: string };
export function onDuty(nowMs: number): Shift;

// src/identity/crypto.ts
export class SealError extends Error { readonly code: "bad_key" | "tampered"; }
export async function importIdentityKey(base64Secret: string): Promise<CryptoKey>; // AES-GCM 256
export async function seal(key: CryptoKey, plaintext: string): Promise<string>;   // "b64(iv).b64(ct)"
export async function open(key: CryptoKey, sealed: string): Promise<string>;      // throws SealError("tampered")

// src/db/identities.ts        (migration 0008)
export type Provider = "slack" | "github";
export type IdentityRow = { email: string; provider: Provider; externalId: string;
  scopes: string; tokenCiphertext: string; connectedAt: number; updatedAt: number };
export type ConnectStatus = { email: string; role: "firefighter" | "viewer"; slack: boolean; github: boolean };
export async function upsertIdentity(db: D1Database, row: Omit<IdentityRow, "updatedAt">, now: number): Promise<void>;
export async function getIdentity(db: D1Database, email: string, provider: Provider): Promise<IdentityRow | null>;
export async function listConnectStatus(db: D1Database): Promise<ConnectStatus[]>; // roster-driven, tokens never included

// src/identity/tokens.ts      (the one composition Phase 13/20 import)
export async function getDecryptedToken(env: Env, email: string, provider: Provider): Promise<string | null>;

// src/oauth/state.ts
export async function mintState(key: CryptoKey, email: string, provider: Provider, nowMs: number): Promise<string>;
export async function verifyState(key: CryptoKey, state: string, provider: Provider, nowMs: number): Promise<{ email: string } | null>;
```

### HTTP API

| Route | Auth | Behavior |
|---|---|---|
| `GET /api/identity` | valid Access JWT, team member | `{ email, role: "firefighter"\|"viewer" }`; 401 invalid JWT; 403 non-team |
| `GET /api/roster` | valid Access JWT, team member | `{ onDuty: Shift, rotation: string[], engineers: ConnectStatus[] }` |
| `GET /api/oauth/slack/start` | fire-fighter only | 302 to Slack authorize URL with `user_scope=chat:write`, minted state |
| `GET /api/oauth/slack/callback` | state validates | exchanges code, seals `authed_user.access_token`, upserts, 302 `/` |
| `GET /api/oauth/github/start` | fire-fighter only | 302 to GitHub authorize URL with `scope=repo`, minted state |
| `GET /api/oauth/github/callback` | state validates | exchanges code, seals token, upserts, 302 `/` |

Redirect URIs are derived from the request origin (`new URL(c.req.url).origin + path`) — no config knob. The same origin must be registered in the Slack app config and the GitHub OAuth app (live task).

### Persistence — `migrations/0008_identities.sql`

```sql
CREATE TABLE identities (
  email            TEXT    NOT NULL,
  provider         TEXT    NOT NULL CHECK (provider IN ('slack','github')),
  external_id      TEXT    NOT NULL,
  scopes           TEXT    NOT NULL,
  token_ciphertext TEXT    NOT NULL,
  connected_at     INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (email, provider)
);
```

Re-connecting overwrites (upsert): the newest token wins, `connected_at` preserved from the first connect only if the row exists — simpler: overwrite both timestamps; nothing reads `connected_at` for logic.

## File structure

- Create: `src/identity/rotation.ts`, `src/identity/crypto.ts`, `src/identity/tokens.ts`, `src/db/identities.ts`, `src/oauth/state.ts`, `src/oauth/slack.ts`, `src/oauth/github.ts`, `src/api/identity.ts`, `migrations/0008_identities.sql`
- Create tests: `test/rotation.test.ts`, `test/identity-crypto.test.ts`, `test/identities-db.test.ts`, `test/oauth-state.test.ts`, `test/oauth-slack.test.ts`, `test/oauth-github.test.ts`, `test/api-identity.test.ts`
- Modify: `src/index.ts` (mount `identityApi` + both oauth routers under `/api`; add optional Env secret fields), `apps/worker/.dev.vars.example` (document the five new names)

## Execution speed rules — READ BEFORE DISPATCHING ANY TASK

Identical to Phase 11's rules; they override per-step commands wherever they conflict.

1. **Focused tests by exact path:** `cd apps/worker && pnpm exec vitest run test/<exact-file>.test.ts`. Never a pattern.
2. **One `pnpm exec tsc --noEmit -p tsconfig.json` per task**, at the end.
3. **The full suite runs exactly once in this phase** — Task 7, before merge. Nowhere else.
4. **Dispatch = the task's own text + the Public contracts section + these rules.** No repo re-exploration; read only the files the task names plus direct imports.
5. **Review depth:** deep for Tasks 4 and 5 (state binding, callback trust boundary); light for 1, 2, 3, 6 (pure functions and queries with exhaustive tests).
6. **Trivial code skips ceremony:** one red/green cycle per module, not per assertion.

### Parallel wave schedule

| Wave | Tasks (concurrent) | Why safe |
|---|---|---|
| A | **1** ∥ **2** ∥ **3** | rotation, crypto, and the D1 table share zero files (3 treats sealed tokens as opaque strings) |
| B | **4** ∥ **6** | 4 owns `oauth/state.ts` + `oauth/slack.ts`; 6 owns `api/identity.ts` + `identity/tokens.ts` (needs only waves A) |
| C | **5** | `oauth/github.ts` consumes 4's `state.ts` |
| D | **7** | wiring, gate, live registration |

## Task order

### Task 1 — Rotation

**Files:** create `src/identity/rotation.ts`, `test/rotation.test.ts`.

- [ ] **Step 1: Failing tests.** Plain vitest (pure function, no workerd needed — but the pool runs it fine; do not create a second config). Cover: index 0 at exactly `ROTATION_EPOCH_MS`; the instant `EPOCH + SHIFT_MS - 1` still index 0 and `EPOCH + SHIFT_MS` is index 1; wrap 3→0 at `EPOCH + 4*SHIFT_MS`; `nextEmail` at index 3 is index 0's email; a `nowMs` before the epoch still returns a valid rotation member (`((x % 4) + 4) % 4`); `shiftEndMs - shiftStartMs === SHIFT_MS` always; the personal-override email never appears for any of 30 sampled days.
- [ ] **Step 2: Run, verify FAIL** (`cd apps/worker && pnpm exec vitest run test/rotation.test.ts`).
- [ ] **Step 3: Implement.**

```ts
export const ROTATION = ["ronit@zellify.app", "luka@zellify.app", "mikheil@zellify.app", "zurab@zellify.app"] as const;
// UNCONFIRMED: epoch and order pending Ronit (question sent 2026-08-13). An
// epoch off by a day silently nudges the wrong person — see phase-12 notes.
export const ROTATION_EPOCH_MS = Date.parse("2026-08-10T00:00:00Z");
export const SHIFT_MS = 3 * 86_400_000;

export function onDuty(nowMs: number): Shift {
  const shiftsSince = Math.floor((nowMs - ROTATION_EPOCH_MS) / SHIFT_MS);
  const index = ((shiftsSince % ROTATION.length) + ROTATION.length) % ROTATION.length;
  const shiftStartMs = ROTATION_EPOCH_MS + shiftsSince * SHIFT_MS;
  return { email: ROTATION[index], index, shiftStartMs,
    shiftEndMs: shiftStartMs + SHIFT_MS, nextEmail: ROTATION[(index + 1) % ROTATION.length] };
}
```

- [ ] **Step 4: Run tests, verify PASS.**
- [ ] **Step 5: Commit:** `feat(identity): pure three-day rotation with unconfirmed epoch flagged`

### Task 2 — Token crypto

**Files:** create `src/identity/crypto.ts`, `test/identity-crypto.test.ts`.

- [ ] **Step 1: Failing tests.** Round-trip `seal → open` returns the plaintext; two seals of the same plaintext differ (random IV); `open` on a flipped ciphertext byte throws `SealError` with `code: "tampered"`; `open` with a different key throws `tampered`; `importIdentityKey` on a non-base64 or wrong-length secret throws `SealError("bad_key")`; the thrown messages contain neither the plaintext nor any key material.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** `importIdentityKey`: decode base64, require exactly 32 bytes, `crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt","decrypt"])`. `seal`: 12-byte `crypto.getRandomValues` IV, `subtle.encrypt({name:"AES-GCM", iv}, ...)`, emit `b64(iv) + "." + b64(ct)`. `open`: split on the dot, decrypt, wrap any `subtle` rejection as `SealError("tampered", "sealed token failed to open")`.
- [ ] **Step 4: Run tests, verify PASS.**
- [ ] **Step 5: Commit:** `feat(identity): AES-GCM seal/open for tokens at rest`

### Task 3 — The `identities` table

**Files:** create `migrations/0008_identities.sql` (SQL above, verbatim), `src/db/identities.ts`, `test/identities-db.test.ts`.

- [ ] **Step 1: Failing tests.** Real D1 via the workerd pool (no `isolatedStorage`; unique emails per test, per the standing harness rules). Cover: upsert then get returns the row; upsert same `(email, provider)` overwrites token and `updated_at`; `getIdentity` for an unconnected pair returns null; `listConnectStatus` returns all seven roster emails + the override with correct roles, `slack`/`github` booleans flipping after upserts, and — assert explicitly — no `tokenCiphertext` key anywhere in the returned objects.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** `upsertIdentity` is one `INSERT ... ON CONFLICT(email, provider) DO UPDATE SET external_id=?, scopes=?, token_ciphertext=?, connected_at=?, updated_at=?`. `listConnectStatus` builds from `FIREFIGHTERS`/`VIEWERS` in code and one `SELECT email, provider FROM identities` — the roster is the spine, D1 only decorates.
- [ ] **Step 4: Run tests + typecheck, verify PASS.**
- [ ] **Step 5: Commit:** `feat(identity): identities table and connect-status queries`

### Task 4 — Signed OAuth state + Slack OAuth

**Files:** create `src/oauth/state.ts`, `src/oauth/slack.ts`, `test/oauth-state.test.ts`, `test/oauth-slack.test.ts`.

- [ ] **Step 1: Failing state tests.** Mint→verify round-trips `{email}`; verify fails (null) on: expired (11 min later), tampered payload, tampered signature, provider mismatch (state minted for `slack` used on `github`), garbage input. No throw on garbage — `null`, so route code turns it into one 403 path.
- [ ] **Step 2: Implement state.** Payload `b64url(JSON.stringify({e: email, p: provider, x: nowMs + 600_000, n: b64(crypto.getRandomValues(new Uint8Array(16)))}))`; signature HMAC-SHA256 over the payload using a key imported from the same `IDENTITY_KEY` secret (`importKey("raw", bytes, {name:"HMAC", hash:"SHA-256"}, false, ["sign","verify"])`); state = `payload + "." + b64url(sig)`. Verify recomputes and checks expiry with `subtle.verify`.
- [ ] **Step 3: Failing Slack route tests.** Hono app tests with a stubbed `fetch` (same `vi.stubGlobal` pattern as `test/codemode-langsmith.test.ts`). Cover: `start` without a valid Access JWT → 401; a viewer → 403; a fire-fighter → 302 whose `Location` has `user_scope=chat:write`, the caller's derived origin in `redirect_uri`, and a verifiable state. `callback` with bad state → 403 and **no fetch was made**; good state → posts form-encoded `code`, `client_id`, `client_secret`, `redirect_uri` to `https://slack.com/api/oauth.v2.access`, stores a row for the STATE's email whose `token_ciphertext` does not contain the raw token, `external_id` = `authed_user.id`, then 302 `/`; Slack `{ok:false}` response → 502 with a generic message (no body echo).
- [ ] **Step 4: Implement `src/oauth/slack.ts`.** One Hono router with the two routes. Access verification identical to `src/api/identity.ts` (Task 6 defines the shared helper `requireTeamMember` — until wave B merges, inline the verify + roster check; the wiring task deduplicates if both landed).
- [ ] **Step 5: Run both test files + typecheck, verify PASS.**
- [ ] **Step 6: Commit:** `feat(oauth): signed state and Slack user-token connect flow`

### Task 5 — GitHub OAuth

**Files:** create `src/oauth/github.ts`, `test/oauth-github.test.ts`. Consumes Task 4's `state.ts` unchanged.

- [ ] **Step 1: Failing tests.** Mirror the Slack matrix: authz on `start`; authorize URL carries `scope=repo` and a verifiable state; callback exchanges at `https://github.com/login/oauth/access_token` with `Accept: application/json`; a follow-up `GET https://api.github.com/user` (with `Authorization: Bearer`, `User-Agent` header — GitHub 403s without one) supplies `login` as `external_id`; sealed at rest; error body from GitHub (`{"error":"bad_verification_code"}`) → 502 generic.
- [ ] **Step 2: Implement.** Same router shape as Slack.
- [ ] **Step 3: Run tests + typecheck, verify PASS.**
- [ ] **Step 4: Commit:** `feat(oauth): GitHub user-token connect flow`

### Task 6 — Status API + token composition

**Files:** create `src/api/identity.ts`, `src/identity/tokens.ts`, `test/api-identity.test.ts`.

- [ ] **Step 1: Failing tests.** `GET /api/identity`: 401 on missing/invalid JWT (stub the verifier — inject via the same factory-parameter seam `makeAccessVerifier` gives you, do not stub JWKS fetch here); 403 for a non-roster email; `{email, role}` for a viewer and a fire-fighter. `GET /api/roster`: shape `{onDuty, rotation, engineers}`; `engineers` matches `listConnectStatus`; response JSON stringified contains no `token`/`ciphertext` substring. `getDecryptedToken`: returns null when unconnected; round-trips a token sealed by Task 2's `seal`.
- [ ] **Step 2: Implement.** Export `requireTeamMember(c): Promise<{email, role} | Response>` from `src/api/identity.ts` and use it in both routes; `getDecryptedToken` = `getIdentity` → `open` (null on missing row; a `SealError` propagates — a corrupted row must be loud, not null).
- [ ] **Step 3: Run tests + typecheck, verify PASS.**
- [ ] **Step 4: Commit:** `feat(identity): roster/status API and decrypted-token composition`

### Task 7 — Wiring, gate, live registration

**Files:** modify `src/index.ts`, `apps/worker/.dev.vars.example`.

- [ ] **Step 1: Wire.** Mount `identityApi`, `slackOAuth`, `githubOAuth` under `/api` (above the asset catch-all). Extend `Env` with `IDENTITY_KEY?: string; SLACK_CLIENT_ID?: string; SLACK_CLIENT_SECRET?: string; GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string;` (secrets, so `wrangler types` cannot know them — same justification as the AI Gateway pair). Routes 503 by NAME (`missing configuration: IDENTITY_KEY`) when unset, never a value.
- [ ] **Step 2: Swap Task 4's inlined authz for `requireTeamMember`** if it duplicated (one mechanical edit).
- [ ] **Step 3: Full gate, once:** `cd apps/worker && pnpm exec vitest run && pnpm exec tsc --noEmit -p tsconfig.json`.
- [ ] **Step 4: Commit:** `feat(identity): mount identity, roster and OAuth routes`
- [ ] **Step 5 (live, deferrable to the 13/14 integration):** generate `IDENTITY_KEY` (`openssl rand -base64 32`) and `wrangler secret put` all five names; add the callback URLs to the Slack app config (`https://firefighter.sayandeten.workers.dev/api/oauth/slack/callback`) and a GitHub OAuth app; apply `0008` remotely (`pnpm exec wrangler d1 migrations apply firefighter --remote`); connect your own two accounts end to end and record it in `phase-12-notes.md`. If the production Slack app is Ronit's to edit, register a personal test app and note the swap as a release gate.

## Test matrix

| Row | Proven by |
|---|---|
| Rotation boundaries incl. wrap and pre-epoch | `rotation.test.ts` |
| Sealed at rest, tamper-evident, IV-fresh | `identity-crypto.test.ts` |
| Upsert semantics + status never leaks ciphertext | `identities-db.test.ts` |
| State: expiring, tamper-proof, provider-bound | `oauth-state.test.ts` |
| Callback trusts state's email, not the query string | `oauth-slack.test.ts`, `oauth-github.test.ts` |
| Non-fire-fighters cannot start OAuth | both oauth test files |
| 401/403/shape on status routes | `api-identity.test.ts` |

## Exit criteria

Two accounts connect end to end (live step, deferrable). `onDuty` matches the assumed rotation and is one line to correct when Ronit answers. No token is readable in D1 without `IDENTITY_KEY`. `getDecryptedToken` is ready for Phase 13's `ApprovalSender` unchanged.

## Downstream handoff

- **Phase 13:** `getDecryptedToken(env, onDuty(now).email, "slack")` is the whole identity story for the real sender; the bot token remains only for nudge DMs.
- **Phase 14:** render `GET /api/roster` and `GET /api/identity` verbatim; connect buttons are plain links to the `start` routes.
- **Phase 20:** same composition with `"github"`.
