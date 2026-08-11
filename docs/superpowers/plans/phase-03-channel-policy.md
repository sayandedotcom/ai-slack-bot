# Phase 03 — Channel Policy

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make "don't post in real customer channels" a property of the API surface rather than a line in a prompt.

**Depends on:** Phase 01 · **Day 1** · **Gates:** Phases 04, 07, 09

**Docs MCP:** none needed. Pure D1 and pure functions — no external API surface to get wrong.

**Why this phase exists, and why it comes before ingest:** Ronit gave read access to real customer channels for evaluation and said explicitly not to test in them. If that boundary lives in the system prompt, it holds until the one time it doesn't — and the failure mode is the agent posting to a real customer under an engineer's name. Building it before the ingest pipeline means no later phase can quietly bypass it, because there is never a moment when the unguarded path exists.

**Global constraints** from `00-roadmap.md` apply.

---

## The policy

| mode | ingest | triage | agent wakes | `slack.reply()` |
|---|---|---|---|---|
| `observe` | yes | yes | only on manual shadow-run | **throws `ChannelReadOnly`** |
| `live` | yes | yes | yes | sends as on-duty engineer |
| `internal` | yes | no | no | bot nudges only |
| *(unmapped)* | yes | no | no | **throws** — fail closed |

Reference customer channels are `observe`. Own test channels and `#test-firedrill` are `live`. `#eng-firefighter` is `internal`. Anything unmapped fails closed.

`ChannelReadOnly` surfaces to the model as an ordinary error it can reason about — "I can't post here" — not as a crash.

---

## File Structure

```
apps/worker/src/db/channels.ts     policy reads + the three predicates
apps/worker/test/channels.test.ts
```

---

### Task 1: Policy lookup with fail-closed default

**Files:** Create `apps/worker/src/db/channels.ts`, `apps/worker/test/channels.test.ts`

**Interfaces:**
- Consumes: the `channels` table (Phase 01 Task 2)
- Produces: `ChannelMode`, `ChannelPolicy`, `getChannelPolicy(db, channelId)` — consumed by Phases 04, 07, 09

- [ ] **Step 1: Write the failing tests**

`apps/worker/test/channels.test.ts`:

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getChannelPolicy } from "../src/db/channels";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM channels").run();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels VALUES (?, ?, ?, ?)").bind("C_REF", "pulsefit-zellify", "pulsefit", "observe"),
    env.DB.prepare("INSERT INTO channels VALUES (?, ?, ?, ?)").bind("C_TEST", "test-firedrill", "firedrill", "live"),
    env.DB.prepare("INSERT INTO channels VALUES (?, ?, ?, ?)").bind("C_ENG", "eng-firefighter", null, "internal"),
  ]);
});

describe("getChannelPolicy", () => {
  it("returns the stored policy for a known channel", async () => {
    const p = await getChannelPolicy(env.DB, "C_REF");
    expect(p).toMatchObject({ mode: "observe", customer_slug: "pulsefit", known: true });
  });

  it("returns the stored policy for a live channel", async () => {
    const p = await getChannelPolicy(env.DB, "C_TEST");
    expect(p).toMatchObject({ mode: "live", customer_slug: "firedrill", known: true });
  });

  it("returns internal channels with a null customer", async () => {
    const p = await getChannelPolicy(env.DB, "C_ENG");
    expect(p).toMatchObject({ mode: "internal", customer_slug: null, known: true });
  });

  it("fails closed for an unknown channel", async () => {
    const p = await getChannelPolicy(env.DB, "C_NEVER_SEEN");
    expect(p.mode).toBe("observe");
    expect(p.known).toBe(false);
    expect(p.customer_slug).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/worker && pnpm vitest run test/channels.test.ts
```

Expected: FAIL — cannot resolve `../src/db/channels`.

- [ ] **Step 3: Implement the lookup**

`apps/worker/src/db/channels.ts`:

```ts
export type ChannelMode = "observe" | "live" | "internal";

export type ChannelPolicy = {
  channel_id: string;
  name: string;
  customer_slug: string | null;
  mode: ChannelMode;
  /** False when the channel is absent from the table. Drives the fail-closed rule. */
  known: boolean;
};

/**
 * Resolve a channel's posting policy. An unmapped channel gets `observe`, which
 * is never postable. Fail closed: the cost of being wrong here is a stray
 * message to a real customer under an engineer's name. See spec §4.4.
 */
export async function getChannelPolicy(db: D1Database, channelId: string): Promise<ChannelPolicy> {
  const row = await db
    .prepare("SELECT channel_id, name, customer_slug, mode FROM channels WHERE channel_id = ?")
    .bind(channelId)
    .first<{ channel_id: string; name: string; customer_slug: string | null; mode: ChannelMode }>();

  if (!row) {
    return { channel_id: channelId, name: channelId, customer_slug: null, mode: "observe", known: false };
  }
  return { ...row, known: true };
}
```

- [ ] **Step 4: Run to verify pass**

```bash
cd apps/worker && pnpm vitest run test/channels.test.ts
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/db/channels.ts apps/worker/test/channels.test.ts
git commit -m "feat(policy): channel policy lookup with fail-closed default"
```

---

### Task 2: The predicates

**Files:** Modify `apps/worker/src/db/channels.ts`, `apps/worker/test/channels.test.ts`

**Interfaces:**
- Consumes: `ChannelPolicy` (Task 1)
- Produces: `canPost(policy)`, `shouldTriage(policy)` — consumed by Phases 04, 07, 09

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/test/channels.test.ts`, and add `canPost, shouldTriage` to the import:

```ts
describe("canPost", () => {
  it("permits live channels", async () => {
    expect(canPost(await getChannelPolicy(env.DB, "C_TEST"))).toBe(true);
  });

  it("refuses reference customer channels", async () => {
    expect(canPost(await getChannelPolicy(env.DB, "C_REF"))).toBe(false);
  });

  it("refuses internal channels", async () => {
    expect(canPost(await getChannelPolicy(env.DB, "C_ENG"))).toBe(false);
  });

  it("refuses unmapped channels", async () => {
    expect(canPost(await getChannelPolicy(env.DB, "C_UNKNOWN"))).toBe(false);
  });
});

describe("shouldTriage", () => {
  it("triages customer channels, live and reference alike", async () => {
    expect(shouldTriage(await getChannelPolicy(env.DB, "C_REF"))).toBe(true);
    expect(shouldTriage(await getChannelPolicy(env.DB, "C_TEST"))).toBe(true);
  });

  it("does not triage internal channels", async () => {
    expect(shouldTriage(await getChannelPolicy(env.DB, "C_ENG"))).toBe(false);
  });

  it("does not triage unmapped channels", async () => {
    expect(shouldTriage(await getChannelPolicy(env.DB, "C_UNKNOWN"))).toBe(false);
  });
});
```

Note `shouldTriage` is true for reference channels. That is deliberate — triage on reference traffic is what builds the Phase 21 eval set, and it costs $0.0003 a message. Only the *expensive* agent is withheld.

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/worker && pnpm vitest run test/channels.test.ts
```

Expected: FAIL — `canPost` and `shouldTriage` are not exported.

- [ ] **Step 3: Implement**

Append to `apps/worker/src/db/channels.ts`:

```ts
/** Only `live` channels accept outbound messages. Everything else refuses. */
export function canPost(policy: ChannelPolicy): boolean {
  return policy.known && policy.mode === "live";
}

/**
 * Triage runs on customer channels — both the live ones and the reference ones.
 * Reference traffic is the eval set (spec §4.5); withholding it would mean
 * tuning the triage prompt against messages we wrote ourselves.
 */
export function shouldTriage(policy: ChannelPolicy): boolean {
  return policy.known && policy.customer_slug !== null && policy.mode !== "internal";
}
```

- [ ] **Step 4: Run to verify pass**

```bash
cd apps/worker && pnpm test
```

Expected: 25 passing (health 2, verify 7, events 5, channels 11).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/db/channels.ts apps/worker/test/channels.test.ts
git commit -m "feat(policy): canPost and shouldTriage predicates"
```

---

## Exit criteria

- [ ] `canPost` returns false for every mode except `live`, including unmapped
- [ ] `shouldTriage` returns true for reference channels and false for internal
- [ ] An unmapped channel gets `known: false` and `mode: "observe"`
- [ ] 25 tests passing

## Note for Phase 09

When the `slack` binding is built, `canPost` is called **inside the binding**, not by the agent's code and not in the prompt. The agent must be structurally unable to post to a channel it should not — a check the model performs is a check the model can skip.
