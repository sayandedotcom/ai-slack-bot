import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { effectKey, runEffect } from "../src/codemode/effects";
import { CapabilityError } from "../src/codemode/errors";
import type { CodeModeScope } from "../src/codemode/contracts";

const slackScope: CodeModeScope = {
  runId: "run_1",
  turnId: "turn_1",
  origin: "slack",
  shadow: false,
  customerSlug: "acme",
  slackThread: { channelId: "C123", threadTs: "1712345678.000100" },
  actor: { engineerEmail: "eng@example.com", slackUserId: "U1" },
};

// There is no empty database in this harness and there cannot be one:
// test/setup.ts applies migrations once at module load, storage is shared
// across cases AND files, and reset() would wipe D1 for every other suite.
// So every test mints its own run/turn and nothing asserts a table-wide count.
const newScope = (): CodeModeScope => ({
  ...slackScope,
  runId: `run_${crypto.randomUUID()}`,
  turnId: `turn_${crypto.randomUUID()}`,
});

describe("codemode_effects schema", () => {
  it("exists with the state check constraint enforced", async () => {
    const row = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='codemode_effects'",
    ).first<{ sql: string }>();
    expect(row?.sql).toContain("effect_key");

    await expect(
      env.DB.prepare(
        `INSERT INTO codemode_effects
           (effect_key, run_id, turn_id, namespace, method, args_hash,
            state, created_at, updated_at)
         VALUES (?, 'r', 't', 'slack', 'reply', 'h', 'bogus_state', 0, 0)`,
      ).bind(`k_${crypto.randomUUID()}`).run(),
    ).rejects.toThrow();          // CHECK constraint refuses the unknown state
  });
});

describe("effectKey", () => {
  const scope = newScope();
  const key = (args: unknown, ns = "slack", method = "reply", s = scope) =>
    effectKey(s, ns, method, args as never);

  it("is stable across object key order", async () => {
    expect(await key({ a: 1, b: 2 })).toBe(await key({ b: 2, a: 1 }));
  });

  it("changes with array order, because order is meaningful", async () => {
    expect(await key({ xs: [1, 2] })).not.toBe(await key({ xs: [2, 1] }));
  });

  it("changes with namespace or method", async () => {
    expect(await key({ t: 1 })).not.toBe(await key({ t: 1 }, "linear"));
    expect(await key({ t: 1 })).not.toBe(await key({ t: 1 }, "slack", "thread"));
  });

  it("changes with run or turn, so a later turn may repeat an effect", async () => {
    const other = { ...scope, turnId: `turn_${crypto.randomUUID()}` };
    expect(await key({ t: 1 })).not.toBe(await key({ t: 1 }, "slack", "reply", other));
  });

  it("normalizes Unicode deterministically", async () => {
    expect(await key({ s: "café" })).toBe(await key({ s: "café" }));
  });

  it("rejects an unhashable value before any reservation", async () => {
    await expect(key({ big: 1n })).rejects.toThrow(/invalid_input/);
  });

  it("produces a SHA-256 hex digest", async () => {
    expect(await key({ t: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("runEffect", () => {
  const deps = () => ({ db: env.DB, clock: () => 1_000 });

  it("executes once and returns the normalized result", async () => {
    let calls = 0;
    const out = await runEffect(deps(), newScope(), "slack", "reply", { text: "hi" }, {
      execute: async () => { calls += 1; return { ts: "1.0", permalink: null }; },
    });
    expect(out).toEqual({ ts: "1.0", permalink: null });
    expect(calls).toBe(1);
  });

  it("hands the effect key to execute as an upstream idempotency token", async () => {
    const scope = newScope();
    let seen: string | null = null;
    await runEffect(deps(), scope, "slack", "reply", { text: "hi" }, {
      execute: async (idempotencyKey) => { seen = idempotencyKey; return { ts: "1.0" }; },
    });
    expect(seen).toBe(await effectKey(scope, "slack", "reply", { text: "hi" }));
  });

  it("replays a completed effect without calling upstream again", async () => {
    const scope = newScope();
    let calls = 0;
    const run = () => runEffect(deps(), scope, "slack", "reply", { text: "hi" }, {
      execute: async () => { calls += 1; return { ts: "1.0", permalink: null }; },
    });
    await run();
    await expect(run()).resolves.toEqual({ ts: "1.0", permalink: null });
    expect(calls).toBe(1);                       // the retry replayed
  });

  it("lets two concurrent identical reservations produce exactly one call", async () => {
    const scope = newScope();
    let calls = 0;
    const run = () => runEffect(deps(), scope, "linear", "createIssue", { title: "t" }, {
      execute: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return { id: "iss_1", identifier: "FF-1", url: "https://x" };
      },
    });
    const [a, b] = await Promise.all([run(), run()]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });

  it("permits a deliberate retry after a proven pre-upstream failure", async () => {
    const scope = newScope();
    let calls = 0;
    const run = (fail: boolean) =>
      runEffect(deps(), scope, "slack", "reply", { text: "hi" }, {
        execute: async () => {
          calls += 1;
          if (fail) throw new CapabilityError("invalid_input", "rejected before send");
          return { ts: "2.0", permalink: null };
        },
      });
    await expect(run(true)).rejects.toThrow(/invalid_input/);
    await expect(run(false)).resolves.toEqual({ ts: "2.0", permalink: null });
    expect(calls).toBe(2);
  });

  // The case that must never duplicate a customer message.
  it("returns effect_in_doubt when the outcome cannot be proven", async () => {
    const scope = newScope();
    await expect(
      runEffect(deps(), scope, "slack", "reply", { text: "hi" }, {
        execute: async () => { throw new Error("network reset mid-flight"); },
      }),
    ).rejects.toThrow(/effect_in_doubt/);

    // And a retry keeps refusing rather than sending a second time.
    let secondAttempt = 0;
    await expect(
      runEffect(deps(), scope, "slack", "reply", { text: "hi" }, {
        execute: async () => { secondAttempt += 1; return { ts: "3.0", permalink: null }; },
      }),
    ).rejects.toThrow(/effect_in_doubt/);
    expect(secondAttempt).toBe(0);
  });

  it("resolves an in-doubt effect through reconcile when one is supplied", async () => {
    const scope = newScope();
    await expect(runEffect(deps(), scope, "linear", "createIssue", { title: "t" }, {
      execute: async () => { throw new Error("timeout after send"); },
    })).rejects.toThrow(/effect_in_doubt/);

    await expect(runEffect(deps(), scope, "linear", "createIssue", { title: "t" }, {
      execute: async () => { throw new Error("should not run"); },
      reconcile: async () => ({ id: "iss_9", identifier: "FF-9", url: "https://x" }),
    })).resolves.toMatchObject({ identifier: "FF-9" });
  });

  it("keeps refusing when reconcile proves nothing", async () => {
    const scope = newScope();
    await expect(runEffect(deps(), scope, "linear", "createIssue", { title: "t" }, {
      execute: async () => { throw new Error("timeout after send"); },
    })).rejects.toThrow(/effect_in_doubt/);

    await expect(runEffect(deps(), scope, "linear", "createIssue", { title: "t" }, {
      execute: async () => { throw new Error("should not run"); },
      reconcile: async () => null,          // upstream could not confirm either way
    })).rejects.toThrow(/effect_in_doubt/);
  });

  it("lets a later turn intentionally repeat the same semantic effect", async () => {
    const base = newScope();
    const later = { ...base, turnId: `turn_${crypto.randomUUID()}` };
    let calls = 0;
    const run = (s: typeof base) =>
      runEffect(deps(), s, "slack", "reply", { text: "same text" }, {
        execute: async () => { calls += 1; return { ts: `${calls}.0`, permalink: null }; },
      });
    await run(base);
    await run(later);
    expect(calls).toBe(2);
  });

  /**
   * Phase 10 Task 1 Step 5. The agent loop can stop waiting mid-effect. What
   * must NOT happen is an effect being called failed because the caller lost
   * interest — that is the one mistake that lets a retry send a customer
   * message twice.
   */
  it("leaves an abandoned wait in doubt rather than failed", async () => {
    const scope = newScope();
    const controller = new AbortController();

    // Someone else holds the reservation and never records an outcome, which is
    // what a Worker dying between "sent" and "recorded" looks like from here.
    const holder = runEffect(deps(), scope, "slack", "reply", { text: "hi" }, {
      execute: () => new Promise<never>(() => {}),
    });
    void holder.catch(() => {});
    await new Promise((r) => setTimeout(r, 10));

    const waiter = runEffect(
      { ...deps(), signal: controller.signal },
      scope, "slack", "reply", { text: "hi" },
      { execute: async () => ({ ts: "2.0", permalink: null }) },
    );
    controller.abort();
    await expect(waiter).rejects.toThrow(/effect_in_doubt/);

    // Still reserved by the holder: the abandoned waiter changed nothing.
    const row = await env.DB.prepare(
      "SELECT state FROM codemode_effects WHERE run_id = ?",
    ).bind(scope.runId).first<{ state: string }>();
    expect(row?.state).toBe("reserved");
  });

  it("stops waiting promptly once the caller gives up", async () => {
    const scope = newScope();
    const controller = new AbortController();
    const holder = runEffect(deps(), scope, "slack", "reply", { text: "hi" }, {
      execute: () => new Promise<never>(() => {}),
    });
    void holder.catch(() => {});
    await new Promise((r) => setTimeout(r, 10));

    const started = Date.now();
    const waiter = runEffect(
      { ...deps(), signal: controller.signal },
      scope, "slack", "reply", { text: "hi" },
      { execute: async () => ({ ts: "2.0", permalink: null }) },
    );
    controller.abort();
    await expect(waiter).rejects.toThrow(/effect_in_doubt/);
    // The full poll budget is 40 x 5ms; an honoured signal returns well inside it.
    expect(Date.now() - started).toBeLessThan(150);
  });

  // stale_generation is raised BEFORE the capability body, so nothing was sent
  // and the row must be `failed` — reusable — not a permanent `in_doubt`.
  it("treats a stale-generation refusal as proven un-sent", async () => {
    const scope = newScope();
    let calls = 0;
    const run = (stale: boolean) =>
      runEffect(deps(), scope, "slack", "reply", { text: "hi" }, {
        execute: async () => {
          calls += 1;
          if (stale) throw new CapabilityError("stale_generation", "newer input arrived");
          return { ts: "5.0", permalink: null };
        },
      });
    await expect(run(true)).rejects.toThrow(/^stale_generation: /);
    const row = await env.DB.prepare(
      "SELECT state FROM codemode_effects WHERE run_id = ?",
    ).bind(scope.runId).first<{ state: string }>();
    expect(row?.state).toBe("failed");

    // A later, current generation may still perform it.
    await expect(run(false)).resolves.toEqual({ ts: "5.0", permalink: null });
    expect(calls).toBe(2);
  });

  it("records the effect row so a restarted Worker can see it", async () => {
    const scope = newScope();
    await runEffect(deps(), scope, "slack", "reply", { text: "durable" }, {
      execute: async () => ({ ts: "9.0", permalink: null }),
    });
    const row = await env.DB.prepare(
      "SELECT state, namespace, method FROM codemode_effects WHERE run_id = ?",
    ).bind(scope.runId).first<{ state: string; namespace: string; method: string }>();
    expect(row).toMatchObject({ state: "completed", namespace: "slack", method: "reply" });
  });
});
