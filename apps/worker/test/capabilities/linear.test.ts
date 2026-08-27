import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { makeLinearTools } from "../../src/capabilities/namespaces/linear";
import type { LinearGateway } from "../../src/gateways/ports";
import { createOrGetRun } from "../../src/run/repository";
import { testBindingContext } from "../helpers/capabilities";

async function actingScope() {
  const run = await createOrGetRun(env.DB, {
    key: `chat:${crypto.randomUUID()}`,
    origin: "chat",
    channelId: null,
    threadTs: null,
  });
  return { runId: run.id, origin: "chat" as const };
}

function linear(overrides: Partial<LinearGateway> = {}): LinearGateway {
  return {
    createIssue: vi.fn(async () => ({
      id: "iss-1",
      identifier: "FF-1",
      url: "https://l/FF-1",
    })),
    findIssue: vi.fn(async () => null),
    updateIssue: vi.fn(async () => ({ id: "iss-1", url: "https://l/FF-1" })),
    resolveLinkTargets: vi.fn(async () => []),
    lookupIssue: vi.fn(async () => null),
    ...overrides,
  } as unknown as LinearGateway;
}

describe("linear.createIssue", () => {
  it("files once for two identical calls in one turn", async () => {
    const scope = await actingScope();
    const gateway = linear();
    const tools = makeLinearTools(
      testBindingContext({ scope, deps: { linear: gateway } })
    );
    const args = {
      title: "Copy ID button",
      description: "d",
      // Required by the schema, and deliberately so: a large feature request
      // must carry a value / blocking / customer-weight assessment.
      assessment: {
        platformValue: "medium" as const,
        blocking: "low" as const,
        customerWeight: "high" as const,
        evidence: "Priya asked in #pulsefit; two other customers have too.",
      },
      labels: ["Feature"],
    };
    await tools.createIssue.run(args);
    await tools.createIssue.run(args);
    expect(gateway.createIssue).toHaveBeenCalledTimes(1);
  });

  it("refuses from a run that cannot be confirmed", async () => {
    const gateway = linear();
    const tools = makeLinearTools(
      testBindingContext({ deps: { linear: gateway } })
    );
    await expect(
      tools.createIssue.run({
        title: "t",
        description: "d",
        assessment: {
          platformValue: "low" as const,
          blocking: "low" as const,
          customerWeight: "low" as const,
          evidence: "e",
        },
        labels: [],
      })
    ).rejects.toMatchObject({ code: "shadow_write_denied" });
    expect(gateway.createIssue).not.toHaveBeenCalled();
  });

  it("takes no team argument — the team is pinned server-side", () => {
    const tools = makeLinearTools(testBindingContext());
    expect(JSON.stringify(tools.createIssue.input)).not.toMatch(/team/i);
  });
});

describe("linear.createIssue — the assessment", () => {
  it("refuses an issue with no value/blocking/customer-weight assessment", async () => {
    // Requirement 8: a large feature request produces a scoped issue WITH an
    // assessment. Making it required in the schema is what stops the model
    // quietly filing an unscored one.
    const scope = await actingScope();
    const gateway = linear();
    const tools = makeLinearTools(
      testBindingContext({ scope, deps: { linear: gateway } })
    );
    await expect(
      tools.createIssue.run({ title: "t", description: "d", labels: [] })
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(gateway.createIssue).not.toHaveBeenCalled();
  });

  it("names the offending path without echoing what the model sent", async () => {
    const scope = await actingScope();
    const tools = makeLinearTools(
      testBindingContext({ scope, deps: { linear: linear() } })
    );
    try {
      await tools.createIssue.run({
        title: "t",
        description: "SECRET-DRAFT-TEXT",
        labels: [],
      });
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as Error).message).toContain("assessment");
      expect((err as Error).message).not.toContain("SECRET-DRAFT-TEXT");
    }
  });
});
