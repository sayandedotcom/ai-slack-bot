import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  assertClassified,
  buildRegistry,
  capabilityEffectOf,
  type CapabilityRegistry,
} from "../src/codemode/registry";
import { CAPABILITY_EFFECTS, type CapabilityEffect } from "../src/codemode/write-guard";
import { makeArtifactPublisher } from "../src/files/r2";
import { makeSlackGateway } from "../src/slack/gateway";
import type { CodeModeScope } from "../src/codemode/contracts";
import { CapabilityError } from "../src/codemode/errors";
import {
  fakeAuditSink,
  fakeDeps,
  seedPermittedScope,
  slackScope,
  TEST_LIMITS,
  testExecution,
} from "./helpers/codemode";

/**
 * ONE HOST GUARD, EVERY NAMESPACE.
 *
 * Phase 09 put the shadow/channel matrix inside `slack.reply` alone. That was a
 * real hole, not a stylistic one: a shadow run could still file a Linear issue
 * into the pinned team and publish an artifact served from the app's own
 * origin. Both are writes a customer or a colleague can see, and neither went
 * anywhere near the check that was supposed to prevent exactly that.
 *
 * So the matrix now belongs to the EFFECT CLASS. These cases prove it applies
 * to Linear and files as well as Slack, that read-only investigation survives
 * the same conditions, and that a method with no classification cannot be
 * constructed at all.
 */

const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();

async function seedScope(input: {
  mode: "observe" | "live" | "internal";
  shadow: boolean;
  origin?: "slack" | "chat";
}): Promise<CodeModeScope> {
  const channelId = `C${uid()}`;
  const threadTs = "1712345678.000100";
  const runId = `run_${crypto.randomUUID()}`;

  await env.DB.prepare(
    "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, 'acme', ?)",
  )
    .bind(channelId, `chan-${channelId}`, input.mode)
    .run();
  await env.DB.prepare(
    `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, created_at, updated_at)
     VALUES (?, ?, 'slack', ?, ?, 'live', ?, 0, 0)`,
  )
    .bind(runId, `slack:${channelId}:${threadTs}`, channelId, threadTs, input.shadow ? 1 : 0)
    .run();

  const origin = input.origin ?? "slack";
  return {
    ...slackScope,
    runId,
    turnId: `turn_${crypto.randomUUID()}`,
    origin,
    slackThread: origin === "slack" ? { channelId, threadTs } : null,
  };
}

function registryFor(scope: CodeModeScope): CapabilityRegistry {
  const deps = {
    ...fakeDeps(),
    db: env.DB,
    slack: makeSlackGateway(env.DB, scope),
    files: makeArtifactPublisher({
      bucket: env.ARTIFACTS,
      baseUrl: "https://firefighter.example/api/artifacts",
    }),
  };
  return buildRegistry(scope, deps, TEST_LIMITS, testExecution({ audit: fakeAuditSink() }));
}

const call = (registry: CapabilityRegistry, namespace: string, method: string, args: unknown) =>
  (
    registry.find((p) => p.name === namespace)!.tools[method] as {
      execute: (a: unknown) => Promise<unknown>;
    }
  ).execute(args);

const createIssue = {
  title: "Checkout times out for enterprise carts",
  description: "Repros on carts above 200 lines.",
  assessment: {
    platformValue: "high" as const,
    blocking: "medium" as const,
    customerWeight: "high" as const,
    evidence: "Three customers in two weeks.",
  },
};

const publish = {
  bytes: new TextEncoder().encode("id,name\n1,acme\n"),
  contentType: "text/csv",
  filename: "report.csv",
};

/* ------------------------------------------------------------ the matrix -- */

describe("a shadow run cannot write anywhere", () => {
  it("denies slack.reply", async () => {
    const scope = await seedScope({ mode: "live", shadow: true });
    await expect(call(registryFor(scope), "slack", "reply", { text: "hi" })).rejects.toThrow(
      /shadow_write_denied/,
    );
  });

  // The Phase 09 hole. Before Task 6 this call succeeded and filed a real issue.
  it("denies linear.createIssue", async () => {
    const scope = await seedScope({ mode: "live", shadow: true });
    await expect(call(registryFor(scope), "linear", "createIssue", createIssue)).rejects.toThrow(
      /shadow_write_denied/,
    );
  });

  it("denies linear.updateIssue", async () => {
    const scope = await seedScope({ mode: "live", shadow: true });
    await expect(
      call(registryFor(scope), "linear", "updateIssue", { issueId: "iss-1", title: "new" }),
    ).rejects.toThrow(/shadow_write_denied/);
  });

  // The other Phase 09 hole, and the one with an externally reachable URL.
  it("denies files.publish", async () => {
    const scope = await seedScope({ mode: "live", shadow: true });
    await expect(call(registryFor(scope), "files", "publish", publish)).rejects.toThrow(
      /shadow_write_denied/,
    );
  });

  // Evaluating a draft is the entire point of a shadow run, so investigation
  // must survive intact. A guard that also silenced reads would make shadow
  // useless and push everyone to turn it off.
  it("still allows read-only investigation", async () => {
    const scope = await seedScope({ mode: "live", shadow: true });
    const registry = registryFor(scope);
    await expect(call(registry, "slack", "thread", {})).resolves.toBeDefined();
    await expect(call(registry, "supabase", "schema", {})).resolves.toBeDefined();
    await expect(
      call(registry, "memory", "recall", { query: "anything", scope: "org" }),
    ).resolves.toBeDefined();
  });
});

describe("a Slack run whose channel is not live cannot write anywhere", () => {
  it.each([["observe"], ["internal"]] as const)("denies every write on a %s channel", async (mode) => {
    const scope = await seedScope({ mode, shadow: false });
    const registry = registryFor(scope);
    await expect(call(registry, "slack", "reply", { text: "hi" })).rejects.toThrow(
      /channel_read_only/,
    );
    await expect(call(registry, "linear", "createIssue", createIssue)).rejects.toThrow(
      /channel_read_only/,
    );
    await expect(call(registry, "files", "publish", publish)).rejects.toThrow(/channel_read_only/);
  });

  it("denies writes from an entirely unmapped channel", async () => {
    // Fail closed: an unknown channel resolves to `observe, known: false`.
    const scope: CodeModeScope = {
      ...slackScope,
      runId: `run_${crypto.randomUUID()}`,
      turnId: `turn_${crypto.randomUUID()}`,
      slackThread: { channelId: `C${uid()}`, threadTs: "1712345678.000100" },
    };
    await expect(call(registryFor(scope), "files", "publish", publish)).rejects.toThrow(
      /channel_read_only/,
    );
  });

  it("denies a write whose run row does not exist", async () => {
    const scope = await seedScope({ mode: "live", shadow: false });
    const orphaned = { ...scope, runId: `run_${crypto.randomUUID()}` };
    // An unconfirmable run is not a permitted one.
    await expect(call(registryFor(orphaned), "files", "publish", publish)).rejects.toThrow(
      /shadow_write_denied/,
    );
  });
});

describe("policy is re-read immediately before each write", () => {
  it("stops the next write when the channel flips to observe mid-run", async () => {
    const scope = await seedScope({ mode: "live", shadow: false });
    const registry = registryFor(scope);

    // Permitted right now.
    await expect(call(registry, "files", "publish", publish)).resolves.toBeDefined();

    await env.DB.prepare("UPDATE channels SET mode = 'observe' WHERE channel_id = ?")
      .bind(scope.slackThread!.channelId)
      .run();

    // Same registry, same execution, same composed dependencies — and denied,
    // because the guard reads D1 at call time rather than at composition.
    await expect(
      call(registry, "files", "publish", { ...publish, filename: "second.csv" }),
    ).rejects.toThrow(/channel_read_only/);
  });

  it("stops the next write when the run flips to shadow mid-run", async () => {
    const scope = await seedScope({ mode: "live", shadow: false });
    const registry = registryFor(scope);

    await expect(call(registry, "files", "publish", publish)).resolves.toBeDefined();

    await env.DB.prepare("UPDATE runs SET shadow = 1 WHERE id = ?").bind(scope.runId).run();

    await expect(
      call(registry, "files", "publish", { ...publish, filename: "second.csv" }),
    ).rejects.toThrow(/shadow_write_denied/);
  });
});

describe("a Chat-origin run is gated by shadow but not by channel policy", () => {
  it("allows a write from a permitted chat run", async () => {
    const scope = await seedScope({ mode: "live", shadow: false, origin: "chat" });
    // No channel to consult; there is nothing customer-facing about a chat
    // artifact, so only the shadow gate applies.
    await expect(call(registryFor(scope), "files", "publish", publish)).resolves.toBeDefined();
  });

  it("denies a write from a shadow chat run", async () => {
    const scope = await seedScope({ mode: "live", shadow: true, origin: "chat" });
    await expect(call(registryFor(scope), "files", "publish", publish)).rejects.toThrow(
      /shadow_write_denied/,
    );
  });
});

describe("a denied write is counted and recorded, not silently dropped", () => {
  it("audits the refusal against this execution's budget", async () => {
    const scope = await seedScope({ mode: "live", shadow: true });
    const audit = fakeAuditSink();
    const execution = testExecution({ audit });
    const registry = buildRegistry(
      scope,
      { ...fakeDeps(), db: env.DB },
      TEST_LIMITS,
      execution,
    );

    await expect(
      call(registry, "linear", "createIssue", createIssue),
    ).rejects.toThrow(/shadow_write_denied/);

    // "The loop kept trying to post from a shadow run" is exactly what an
    // operator needs to be able to see. A refusal with no trace is
    // indistinguishable from a call that never happened.
    expect(audit.events.map((e) => e.kind)).toEqual(["started", "failed"]);
    expect(execution.counter.used).toBe(1);
  });
});

describe("binary arguments never enter an audit record", () => {
  it("summarizes files.publish bytes instead of serializing them", async () => {
    const scope = await seedPermittedScope(env.DB);
    const audit = fakeAuditSink();
    const registry = buildRegistry(
      scope,
      {
        ...fakeDeps(),
        db: env.DB,
        files: makeArtifactPublisher({
          bucket: env.ARTIFACTS,
          baseUrl: "https://firefighter.example/api/artifacts",
        }),
      },
      TEST_LIMITS,
      testExecution({ audit }),
    );

    // 64KB is far below the 5MB cap and already enough to show the difference:
    // `JSON.stringify` on a typed array expands it to `{"0":1,"1":2,…}`, which
    // at the real cap is a ~67 MILLION character string built inside the
    // trusted parent Worker, once per publish, on demand from model-authored
    // code. Downstream bounding cannot help — the cost is the allocation, and
    // the stored event looks perfectly correct at 400 characters afterwards.
    const payload = new Uint8Array(64 * 1024).fill(65);
    await call(registry, "files", "publish", {
      bytes: payload,
      contentType: "text/plain",
      filename: "big.txt",
    });

    const started = audit.events.find((e) => e.kind === "started")!;
    const args = (started as { args: Record<string, unknown> }).args;

    expect(args.bytes).toBe(`<binary: ${payload.byteLength} bytes>`);
    // The useful facts survive; the bytes do not.
    expect(args.filename).toBe("big.txt");
    expect(JSON.stringify(started).length).toBeLessThan(1_000);
  });
});

/* --------------------------------------------------- effect classification -- */

describe("every capability declares an effect", () => {
  it("classifies every method in every namespace", async () => {
    const scope = await seedScope({ mode: "live", shadow: false });
    const registry = registryFor(scope);

    const unclassified: string[] = [];
    for (const provider of registry) {
      for (const [method, tool] of Object.entries(provider.tools)) {
        if (capabilityEffectOf(tool) === null) unclassified.push(`${provider.name}.${method}`);
      }
    }
    expect(unclassified).toEqual([]);
  });

  // The classification table, written down. A new method changes this list, and
  // changing it is a deliberate act somebody reviews — which is the point of
  // having the table at all.
  it("matches the reviewed classification exactly", async () => {
    const scope = await seedScope({ mode: "live", shadow: false });
    const table: Record<string, CapabilityEffect> = {};
    for (const provider of registryFor(scope)) {
      for (const [method, tool] of Object.entries(provider.tools)) {
        table[`${provider.name}.${method}`] = capabilityEffectOf(tool)!;
      }
    }

    expect(table).toEqual({
      "slack.thread": "read",
      "slack.searchMessages": "read",
      "slack.reply": "external_write",
      "memory.findCustomers": "read",
      "memory.recall": "read",
      "memory.cite": "read",
      "linear.createIssue": "external_write",
      "linear.updateIssue": "external_write",
      "supabase.schema": "read",
      "supabase.select": "read",
      "langsmith.trace": "read",
      "langsmith.searchTraces": "read",
      "betterstack.logs": "read",
      "betterstack.monitors": "read",
      "browser.checkRecording": "sandbox_write",
      "browser.record": "sandbox_write",
      "files.publish": "external_write",
      "approval.escalate": "control_write",
      "approval.withdraw": "control_write",
      // Phase 18. Every one of the nine, including the ones that look like
      // reads: `readFile` observes a machine `exec` has been mutating, and a
      // namespace split across two classes would suggest a boundary inside it
      // that does not exist. `codemode-sandbox.test.ts` carries the rest.
      "sandbox.boot": "sandbox_write",
      "sandbox.exec": "sandbox_write",
      "sandbox.spawn": "sandbox_write",
      "sandbox.checkProcess": "sandbox_write",
      "sandbox.killProcess": "sandbox_write",
      "sandbox.readFile": "sandbox_write",
      "sandbox.writeFile": "sandbox_write",
      "sandbox.preview": "sandbox_write",
      "sandbox.diff": "sandbox_write",
    });
  });

  it("classifies exactly approval.escalate and approval.withdraw as control writes", async () => {
    // `escalate`/`withdraw` are Phase 11 and carry their own run-state
    // authority, not the shadow/channel matrix above. This is the negative
    // half of the classification table: nothing else in the registry may be
    // classified `control_write`, which is what would let a future namespace
    // sneak an external-looking write past the shadow/channel guard by
    // borrowing this class instead of being classified honestly.
    const scope = await seedScope({ mode: "live", shadow: false });
    const controlWrites = registryFor(scope).flatMap((p) =>
      Object.entries(p.tools)
        .filter(([, t]) => capabilityEffectOf(t) === "control_write")
        .map(([method]) => `${p.name}.${method}`),
    );
    expect(controlWrites.sort()).toEqual(["approval.escalate", "approval.withdraw"]);
    expect(CAPABILITY_EFFECTS).toContain("control_write");
  });

  // The compile-time half of the rule only binds capabilities that go through
  // `auditedCapability`. A bare descriptor typechecks, so construction refuses.
  const rogueRegistry = (tool: object): CapabilityRegistry => [
    { name: "rogue", tools: { sendEverything: tool as never } },
  ];

  const refusal = (registry: CapabilityRegistry): unknown => {
    try {
      assertClassified(registry);
      return null;
    } catch (e: unknown) {
      return e;
    }
  };

  it("refuses to build a registry containing an unclassified method", () => {
    // Exactly what a future namespace would produce by hand-rolling a
    // descriptor: valid to the package, invisible to the guard.
    const err = refusal(
      rogueRegistry({ description: "an unclassified side effect", execute: async () => ({}) }),
    );

    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as CapabilityError).message).toMatch(/rogue\.sendEverything/);
    expect((err as CapabilityError).message).toMatch(/effect/);
  });

  // The nastier version, and the reason the check is on a brand rather than on
  // the `effect` string. This descriptor CLAIMS to be an external write and
  // would satisfy any label-based check — while still running with no budget,
  // no audit and no write guard, because all three come from the wrapper.
  it("refuses a descriptor that merely CLAIMS an effect it never went through", () => {
    for (const effect of CAPABILITY_EFFECTS) {
      const err = refusal(
        rogueRegistry({
          effect,
          description: "a side effect wearing a classification",
          execute: async () => ({}),
        }),
      );
      expect(err).toBeInstanceOf(CapabilityError);
      expect((err as CapabilityError).message).toMatch(/auditedCapability/);
    }
  });

  it("accepts a genuinely audited capability", async () => {
    // The control. Without it the two cases above would pass against an
    // `assertClassified` that simply rejected everything.
    const scope = await seedScope({ mode: "live", shadow: false });
    expect(() => assertClassified(registryFor(scope))).not.toThrow();
  });
});
