import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildRegistry, capabilityEffectOf, type CapabilityRegistry } from "../src/codemode/registry";
import type { CodeModeScope } from "../src/codemode/contracts";
import type { ApprovalPort } from "../src/approval/contracts";
import {
  fakeApprovalPort,
  fakeAuditSink,
  fakeDeps,
  slackScope,
  TEST_LIMITS,
  testExecution,
} from "./helpers/codemode";

/**
 * THE `approval` CAPABILITY NAMESPACE (Phase 11 Task 3).
 *
 * This suite exercises the real registry and a real isolate-free execution
 * path — `buildRegistry` plus the same `execute()` entry a model's isolate
 * call reaches — against a plain in-memory double of `ApprovalPort`. The port
 * itself is Task 4's to implement for real; what is under test here is the
 * capability layer: validation, refusal ordering, the write-guard exemption,
 * and that this namespace never reaches the effect ledger at all.
 */

const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();

type Harness = {
  registry: CapabilityRegistry;
  approval: ApprovalPort;
  scope: CodeModeScope;
};

function execution(scope: CodeModeScope, approval: ApprovalPort = fakeApprovalPort()): Harness {
  const deps = { ...fakeDeps(), db: env.DB, approval };
  return {
    registry: buildRegistry(scope, deps, TEST_LIMITS, testExecution({ audit: fakeAuditSink() })),
    approval,
    scope,
  };
}

const call = (h: Harness, method: string, args: unknown) =>
  (
    h.registry.find((p) => p.name === "approval")!.tools[method] as {
      execute: (a: unknown) => Promise<unknown>;
    }
  ).execute(args);

const newScope = (patch: Partial<CodeModeScope> = {}): CodeModeScope => ({
  ...slackScope,
  runId: `run_${uid()}`,
  turnId: `turn_${uid()}`,
  ...patch,
});

async function ledgerCount(runId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM codemode_effects WHERE run_id = ?",
  )
    .bind(runId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/* --------------------------------------------------------------- escalate -- */

describe("approval.escalate", () => {
  it("returns a pending state and records the open approval on the port", async () => {
    const h = execution(newScope());
    const result = (await call(h, "escalate", {
      draft: "We've refunded the double charge.",
      why: "Committal to the customer; closes the thread.",
    })) as { approvalId: string; state: string };

    expect(result.state).toBe("pending");
    expect(typeof result.approvalId).toBe("string");
    expect(result.approvalId.length).toBeGreaterThan(0);
    expect(h.approval.openApprovalId()).toBe(result.approvalId);
  });

  it("refuses a second escalate while one is open, with no effect-ledger entry", async () => {
    const scope = newScope();
    const h = execution(scope);
    await call(h, "escalate", { draft: "first draft", why: "first reason" });

    await expect(
      call(h, "escalate", { draft: "second draft", why: "second reason" }),
    ).rejects.toThrow(/approval_already_open/);

    // Nothing upstream happened for the refused call: this namespace never
    // calls `runEffect`, so there is no row to find under this run at all —
    // not "one row, marked failed", but none.
    expect(await ledgerCount(scope.runId)).toBe(0);
  });

  it("refuses a second escalate across separate executions on the same run", async () => {
    const scope = newScope();
    const port = fakeApprovalPort();
    await call(execution(scope, port), "escalate", { draft: "d", why: "w" });

    await expect(
      call(execution(scope, port), "escalate", { draft: "d2", why: "w2" }),
    ).rejects.toThrow(/approval_already_open/);
  });

  it("is classified control_write", async () => {
    const h = execution(newScope());
    const tool = h.registry.find((p) => p.name === "approval")!.tools.escalate;
    expect(capabilityEffectOf(tool)).toBe("control_write");
  });

  /* ---------------------------------------------------------------- bounds -- */

  it("enforces draft and why bounds host-side with Zod", async () => {
    const h = execution(newScope());
    await expect(call(h, "escalate", { draft: "", why: "reason" })).rejects.toThrow(
      /invalid_input/,
    );
    await expect(call(h, "escalate", { draft: "   ", why: "reason" })).rejects.toThrow(
      /invalid_input/,
    );
    await expect(call(h, "escalate", { draft: "d".repeat(4001), why: "reason" })).rejects.toThrow(
      /invalid_input/,
    );
    await expect(call(h, "escalate", { draft: "draft", why: "" })).rejects.toThrow(
      /invalid_input/,
    );
    await expect(call(h, "escalate", { draft: "draft", why: "w".repeat(501) })).rejects.toThrow(
      /invalid_input/,
    );
  });

  it("accepts draft and why at their bounds", async () => {
    const h = execution(newScope());
    await expect(
      call(h, "escalate", { draft: "d".repeat(4000), why: "w".repeat(500) }),
    ).resolves.toMatchObject({ state: "pending" });
  });

  it("takes no destination argument", async () => {
    const h = execution(newScope());
    await expect(
      call(h, "escalate", { draft: "d", why: "w", channel: "C999" }),
    ).rejects.toThrow(/invalid_input/);
  });

  /* --------------------------------------------------------- shadow runs -- */

  it("lets a shadow run escalate — control_write is exempt from the write guard", async () => {
    const channelId = `C${uid()}`;
    const threadTs = "1712345678.000100";
    const runId = `run_${uid()}`;
    await env.DB.prepare(
      "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, 'acme', 'live')",
    )
      .bind(channelId, `chan-${channelId}`)
      .run();
    await env.DB.prepare(
      `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, created_at, updated_at)
       VALUES (?, ?, 'slack', ?, ?, 'live', 1, 0, 0)`,
    )
      .bind(runId, `slack:${channelId}:${threadTs}`, channelId, threadTs)
      .run();

    const scope: CodeModeScope = {
      ...slackScope,
      runId,
      turnId: `turn_${uid()}`,
      slackThread: { channelId, threadTs },
    };

    const result = (await call(execution(scope), "escalate", {
      draft: "shadow draft",
      why: "shadow reason",
    })) as { approvalId: string; state: string };

    // No `shadow_write_denied` — a shadow run may park itself for approval;
    // only its eventual delivery is suppressed, and that is not this layer's
    // concern.
    expect(result.state).toBe("pending");
  });
});

/* --------------------------------------------------------------- withdraw -- */

describe("approval.withdraw", () => {
  it("refuses when nothing is open", async () => {
    const h = execution(newScope());
    await expect(call(h, "withdraw", {})).rejects.toThrow(/approval_not_open/);
  });

  it("refuses with no effect-ledger entry either", async () => {
    const scope = newScope();
    const h = execution(scope);
    await expect(call(h, "withdraw", {})).rejects.toThrow(/approval_not_open/);
    expect(await ledgerCount(scope.runId)).toBe(0);
  });

  it("withdraws an open approval", async () => {
    const h = execution(newScope());
    await call(h, "escalate", { draft: "d", why: "w" });

    await expect(call(h, "withdraw", {})).resolves.toEqual({ withdrawn: true });
    expect(h.approval.openApprovalId()).toBeNull();
  });

  it("loses gracefully to a decision that already landed", async () => {
    const decidedPort: ApprovalPort = {
      ...fakeApprovalPort(),
      async withdraw() {
        return { withdrawn: false, decision: "approved" };
      },
    };
    const h = execution(newScope(), decidedPort);
    await call(h, "escalate", { draft: "d", why: "w" });

    await expect(call(h, "withdraw", {})).resolves.toEqual({
      withdrawn: false,
      decision: "approved",
    });
  });

  it("is classified control_write", async () => {
    const h = execution(newScope());
    const tool = h.registry.find((p) => p.name === "approval")!.tools.withdraw;
    expect(capabilityEffectOf(tool)).toBe("control_write");
  });

  it("takes no arguments and tolerates being called with none at all", async () => {
    const h = execution(newScope());
    await call(h, "escalate", { draft: "d", why: "w" });
    await expect(call(h, "withdraw", undefined)).resolves.toEqual({ withdrawn: true });
  });
});
