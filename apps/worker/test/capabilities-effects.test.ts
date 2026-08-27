import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { effectKey, runEffect } from "../src/capabilities/effects";
import { CapabilityError } from "../src/gateways/errors";
import type { RunScope } from "../src/gateways/scope";

/**
 * Pool storage is shared across tests AND files, so every case mints its own
 * run and turn. Nothing here may assume an empty `codemode_effects`.
 */
function scopeFor(turnId = crypto.randomUUID()): RunScope {
  return {
    runId: crypto.randomUUID(),
    turnId,
    origin: "chat",
    shadow: false,
    customerSlug: null,
    slackThread: null,
    actor: null,
  };
}

const deps = { db: env.DB, clock: () => Date.now() };

async function stateOf(
  scope: RunScope,
  method: string
): Promise<string | undefined> {
  const row = await env.DB.prepare(
    "SELECT state FROM codemode_effects WHERE run_id = ? AND method = ?"
  )
    .bind(scope.runId, method)
    .first<{ state: string }>();
  return row?.state;
}

describe("effect ledger — at most once", () => {
  it("calls upstream once for two identical calls in one turn", async () => {
    const scope = scopeFor();
    let calls = 0;
    const run = () =>
      runEffect(
        deps,
        scope,
        "linear",
        "createIssue",
        { title: "t" },
        {
          execute: async () => {
            calls += 1;
            return { id: "ISS-1" };
          },
        }
      );

    expect(await run()).toEqual({ id: "ISS-1" });
    expect(await run()).toEqual({ id: "ISS-1" });
    expect(calls).toBe(1);
    expect(await stateOf(scope, "createIssue")).toBe("completed");
  });

  it("treats the same arguments in a LATER turn as a new effect", async () => {
    // A deliberate repeat must not be deduped away: "send that again" is a
    // legitimate instruction, and the turn id is what separates it from a retry.
    const base = scopeFor();
    let calls = 0;
    const execute = async () => {
      calls += 1;
      return { ts: `${calls}` };
    };
    await runEffect(deps, base, "slack", "reply", { text: "hi" }, { execute });
    await runEffect(
      deps,
      { ...base, turnId: crypto.randomUUID() },
      "slack",
      "reply",
      { text: "hi" },
      { execute }
    );
    expect(calls).toBe(2);
  });

  it("hands upstream the effect key as its idempotency token", async () => {
    // The ledger and the vendor then agree on what "the same effect" means.
    const scope = scopeFor();
    const args = { text: "hi" };
    let seen: string | null = null;
    await runEffect(deps, scope, "slack", "reply", args, {
      execute: async (key) => {
        seen = key;
        return { ts: "1" };
      },
    });
    expect(seen).toBe(await effectKey(scope, "slack", "reply", args));
  });

  it("replays the recorded result rather than the live one", async () => {
    // The replay must equal what the first call returned, not what a second
    // execute would produce.
    const scope = scopeFor();
    let n = 0;
    const execute = async () => ({ n: (n += 1) });
    expect(
      await runEffect(deps, scope, "linear", "createIssue", {}, { execute })
    ).toEqual({ n: 1 });
    expect(
      await runEffect(deps, scope, "linear", "createIssue", {}, { execute })
    ).toEqual({ n: 1 });
  });
});

describe("effect ledger — failure classification", () => {
  it("marks a proven pre-upstream refusal as failed, and lets a retry through", async () => {
    // channel_read_only is refused before anything leaves the Worker, so the
    // effect provably did not happen and reclaiming it is safe.
    const scope = scopeFor();
    let calls = 0;
    const execute = async () => {
      calls += 1;
      if (calls === 1)
        throw new CapabilityError("channel_read_only", "not postable");
      return { ts: "ok" };
    };

    await expect(
      runEffect(deps, scope, "slack", "reply", { text: "x" }, { execute })
    ).rejects.toMatchObject({ code: "channel_read_only" });
    expect(await stateOf(scope, "reply")).toBe("failed");

    expect(
      await runEffect(deps, scope, "slack", "reply", { text: "x" }, { execute })
    ).toEqual({
      ts: "ok",
    });
    expect(calls).toBe(2);
  });

  it("records in_doubt for an ambiguous failure and refuses to re-send", async () => {
    // A socket hang up says nothing about whether the message landed. Sending
    // again could double-post to a customer, which cannot be taken back.
    const scope = scopeFor();
    let calls = 0;
    const execute = async () => {
      calls += 1;
      throw new Error("socket hang up");
    };

    await expect(
      runEffect(deps, scope, "slack", "reply", { text: "x" }, { execute })
    ).rejects.toMatchObject({ code: "effect_in_doubt" });
    expect(await stateOf(scope, "reply")).toBe("in_doubt");

    await expect(
      runEffect(deps, scope, "slack", "reply", { text: "x" }, { execute })
    ).rejects.toMatchObject({ code: "effect_in_doubt" });
    expect(calls).toBe(1);
  });

  it("lets a reconcile resolve an in_doubt effect without re-sending", async () => {
    const scope = scopeFor();
    let sends = 0;
    await expect(
      runEffect(
        deps,
        scope,
        "linear",
        "createIssue",
        { title: "t" },
        {
          execute: async () => {
            sends += 1;
            throw new Error("gateway timeout");
          },
        }
      )
    ).rejects.toMatchObject({ code: "effect_in_doubt" });

    const resolved = await runEffect(
      deps,
      scope,
      "linear",
      "createIssue",
      { title: "t" },
      {
        execute: async () => {
          sends += 1;
          return { id: "SHOULD-NOT-HAPPEN" };
        },
        reconcile: async () => ({ id: "ISS-7" }),
      }
    );

    expect(resolved).toEqual({ id: "ISS-7" });
    expect(sends).toBe(1);
    expect(await stateOf(scope, "createIssue")).toBe("completed");
  });

  it("stays in_doubt when reconcile cannot confirm either way", async () => {
    const scope = scopeFor();
    await expect(
      runEffect(
        deps,
        scope,
        "linear",
        "createIssue",
        {},
        {
          execute: async () => {
            throw new Error("timeout");
          },
        }
      )
    ).rejects.toMatchObject({ code: "effect_in_doubt" });

    await expect(
      runEffect(
        deps,
        scope,
        "linear",
        "createIssue",
        {},
        {
          execute: async () => ({ id: "no" }),
          reconcile: async () => null,
        }
      )
    ).rejects.toMatchObject({ code: "effect_in_doubt" });
    expect(await stateOf(scope, "createIssue")).toBe("in_doubt");
  });

  it("refuses to call an unrecordable result completed", async () => {
    // The effect happened; we cannot record what it produced. Calling that
    // "completed" would let a retry replay garbage; calling it failed would let
    // a retry do it again.
    const scope = scopeFor();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(
      runEffect(
        deps,
        scope,
        "slack",
        "reply",
        { text: "x" },
        {
          execute: async () => cyclic,
        }
      )
    ).rejects.toMatchObject({ code: "effect_in_doubt" });
    expect(await stateOf(scope, "reply")).toBe("in_doubt");
  });
});

describe("effect key canonicalisation", () => {
  it("is stable across object key order", async () => {
    const scope = scopeFor();
    expect(
      await effectKey(scope, "linear", "createIssue", { a: 1, b: 2 })
    ).toBe(await effectKey(scope, "linear", "createIssue", { b: 2, a: 1 }));
  });

  it("preserves array order, which is meaningful", async () => {
    const scope = scopeFor();
    expect(
      await effectKey(scope, "linear", "createIssue", { l: [1, 2] })
    ).not.toBe(await effectKey(scope, "linear", "createIssue", { l: [2, 1] }));
  });

  it("separates namespace from method rather than concatenating", async () => {
    // String concatenation collides the moment an argument contains the
    // separator; the envelope is structured for that reason.
    const scope = scopeFor();
    expect(await effectKey(scope, "slack", "reply", {})).not.toBe(
      await effectKey(scope, "slackreply", "", {})
    );
  });

  it("refuses an argument that cannot be canonicalised", async () => {
    const scope = scopeFor();
    await expect(
      effectKey(scope, "slack", "reply", { n: Number.NaN } as never)
    ).rejects.toThrow();
  });

  it("leaves no reservation behind when the arguments are unhashable", async () => {
    const scope = scopeFor();
    await expect(
      runEffect(deps, scope, "slack", "reply", { n: Number.NaN } as never, {
        execute: async () => ({ ts: "1" }),
      })
    ).rejects.toThrow();
    expect(await stateOf(scope, "reply")).toBeUndefined();
  });
});
