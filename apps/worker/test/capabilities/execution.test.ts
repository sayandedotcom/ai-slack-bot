import { describe, expect, it, vi } from "vitest";

import type { CapabilityEvent } from "../../src/capabilities/audit";
import {
  alwaysFresh,
  newCodeExecution,
  PRODUCTION_LIMITS,
  staleGeneration,
  withCapabilityAudit,
} from "../../src/capabilities/execution";
import type { RunScope } from "../../src/gateways/scope";

const scope: RunScope = {
  runId: "run-1",
  turnId: "turn-1",
  origin: "chat",
  shadow: false,
  customerSlug: null,
  customerSlugTrusted: false,
  slackThread: null,
  actor: null,
};

function harness(
  overrides: { fresh?: boolean; maxCapabilityCalls?: number } = {}
) {
  const events: CapabilityEvent[] = [];
  const execution = newCodeExecution({
    outerToolCallId: "tc-1",
    audit: {
      started: async (e) => void events.push(e),
      completed: async (e) => void events.push(e),
      failed: async (e) => void events.push(e),
    },
    guard:
      overrides.fresh === false
        ? {
            assertFresh: async () => {
              throw staleGeneration();
            },
          }
        : alwaysFresh(),
    limits: {
      ...PRODUCTION_LIMITS,
      maxCapabilityCalls:
        overrides.maxCapabilityCalls ?? PRODUCTION_LIMITS.maxCapabilityCalls,
    },
    clock: () => 0,
  });
  return { events, execution };
}

describe("withCapabilityAudit — ordering", () => {
  it("records started then completed around a successful call", async () => {
    const { events, execution } = harness();
    await withCapabilityAudit(execution, scope, "slack", "thread", async () => [
      "m",
    ]);
    expect(events.map((e) => e.kind)).toEqual(["started", "completed"]);
  });

  it("records started then failed, and rethrows a narrowed error", async () => {
    const { events, execution } = harness();
    await expect(
      withCapabilityAudit(execution, scope, "slack", "reply", async () => {
        // An adapter that failed to translate its own upstream error. Narrowing
        // here is what stops a connection string reaching model-authored code.
        throw new Error("connect ECONNREFUSED 10.0.0.5:5432");
      })
    ).rejects.toMatchObject({ code: expect.any(String) });

    expect(events.map((e) => e.kind)).toEqual(["started", "failed"]);
    expect(JSON.stringify(events)).not.toContain("10.0.0.5");
  });

  it("gives each call a callId carrying the outer tool call id and its sequence", async () => {
    // A bare `cap:1` collides across the many run_code calls of one loop, which
    // makes the audit trail unreadable exactly when someone needs it.
    const { events, execution } = harness();
    await withCapabilityAudit(
      execution,
      scope,
      "slack",
      "thread",
      async () => null
    );
    await withCapabilityAudit(
      execution,
      scope,
      "slack",
      "thread",
      async () => null
    );
    const ids = events.filter((e) => e.kind === "started").map((e) => e.callId);
    expect(ids).toEqual(["cap:tc-1:1", "cap:tc-1:2"]);
  });
});

describe("withCapabilityAudit — budget", () => {
  it("charges the budget BEFORE the host call, so an over-budget call never reaches upstream", async () => {
    const { execution } = harness({ maxCapabilityCalls: 1 });
    const upstream = vi.fn(async () => "ok");

    await withCapabilityAudit(execution, scope, "slack", "thread", upstream);
    await expect(
      withCapabilityAudit(execution, scope, "slack", "thread", upstream)
    ).rejects.toMatchObject({ code: "capability_unavailable" });

    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("still records the refused call, rather than leaving no trace", async () => {
    const { events, execution } = harness({ maxCapabilityCalls: 0 });
    await expect(
      withCapabilityAudit(execution, scope, "slack", "thread", async () => "ok")
    ).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(events.map((e) => e.kind)).toEqual(["started", "failed"]);
  });

  it("does not share a budget between two concurrent executions", async () => {
    // A module-global counter would let one run exhaust another's budget.
    const a = harness({ maxCapabilityCalls: 1 });
    const b = harness({ maxCapabilityCalls: 1 });
    await withCapabilityAudit(
      a.execution,
      scope,
      "slack",
      "thread",
      async () => "a"
    );
    await expect(
      withCapabilityAudit(
        b.execution,
        scope,
        "slack",
        "thread",
        async () => "b"
      )
    ).resolves.toBe("b");
  });
});

describe("withCapabilityAudit — freshness", () => {
  it("refuses a stale call before it reaches upstream", async () => {
    const { execution } = harness({ fresh: false });
    const upstream = vi.fn(async () => "ok");
    await expect(
      withCapabilityAudit(execution, scope, "slack", "reply", upstream)
    ).rejects.toMatchObject({ code: "stale_generation" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("counts and records a stale call, because a silent refusal is invisible", async () => {
    // "The loop kept calling capabilities on a superseded generation" is
    // exactly what an operator needs to be able to see.
    const { events, execution } = harness({ fresh: false });
    await expect(
      withCapabilityAudit(execution, scope, "slack", "reply", async () => "ok")
    ).rejects.toThrow();
    expect(events.map((e) => e.kind)).toEqual(["started", "failed"]);
  });
});

describe("audit redaction", () => {
  it("drops a credential-shaped VALUE whatever the field is called", async () => {
    const { events, execution } = harness();
    await withCapabilityAudit(
      execution,
      scope,
      "slack",
      "reply",
      async () => "ok",
      { note: "xoxb-1234567890-abcdef" }
    );
    expect(JSON.stringify(events)).not.toContain("xoxb-1234567890-abcdef");
  });

  it("drops the KEY as well as the value for a secret-named field", async () => {
    // The field name is itself information: it fingerprints which credential an
    // adapter is passing around, and an audit record is durable.
    const { events, execution } = harness();
    await withCapabilityAudit(
      execution,
      scope,
      "github",
      "openPR",
      async () => "ok",
      { apiKey: "harmless-looking", title: "fix" }
    );
    const started = events.find((e) => e.kind === "started");
    expect(started?.args).not.toHaveProperty("apiKey");
    expect(started?.args).toMatchObject({ title: "fix", redactedFields: 1 });
  });

  it("summarises binary instead of expanding it", async () => {
    // JSON.stringify on a 5MB Uint8Array materialises ~67 MILLION characters
    // in the parent Worker before anything downstream gets to bound it.
    const { events, execution } = harness();
    await withCapabilityAudit(
      execution,
      scope,
      "files",
      "publish",
      async () => "ok",
      { bytes: new Uint8Array(5000) }
    );
    const started = events.find((e) => e.kind === "started");
    expect(started?.args).toMatchObject({ bytes: "<binary: 5000 bytes>" });
    expect(JSON.stringify(events).length).toBeLessThan(2000);
  });

  it("records no args at all when a capability takes none", async () => {
    const { events, execution } = harness();
    await withCapabilityAudit(
      execution,
      scope,
      "sandbox",
      "boot",
      async () => "ok"
    );
    expect(events.find((e) => e.kind === "started")?.args).toBeNull();
  });
});

describe("customer references", () => {
  it("mints an unguessable reference rather than a countable one", () => {
    // `cust_1` would be guessable, and the next execution would resolve it.
    const { execution } = harness();
    const ref = execution.customers.mint("pulsefit");
    expect(ref).not.toContain("pulsefit");
    expect(ref).not.toMatch(/^cust_\d+$/);
  });

  it("resolves a reference it minted", () => {
    const { execution } = harness();
    expect(
      execution.customers.resolve(execution.customers.mint("pulsefit"))
    ).toBe("pulsefit");
  });

  it("refuses a reference minted by a DIFFERENT execution", () => {
    // Otherwise model-authored code could carry a slug across executions and
    // read another customer's data.
    const a = harness();
    const b = harness();
    const ref = a.execution.customers.mint("pulsefit");
    expect(() => b.execution.customers.resolve(ref)).toThrow(
      /not produced in this execution/
    );
  });

  it("refuses a guessed reference", () => {
    const { execution } = harness();
    expect(() => execution.customers.resolve("cust_1")).toThrow();
    expect(() => execution.customers.resolve("pulsefit")).toThrow();
  });

  it("names neither the reference nor any slug when it refuses", () => {
    // Confirming which of two guesses was closer is itself an oracle.
    const a = harness();
    const b = harness();
    const ref = a.execution.customers.mint("pulsefit");
    try {
      b.execution.customers.resolve(ref);
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as Error).message).not.toContain("pulsefit");
      expect((err as Error).message).not.toContain(ref);
    }
  });
});
