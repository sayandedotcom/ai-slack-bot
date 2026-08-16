import type { CodemodeConnector } from "@cloudflare/codemode";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { CodeExecution } from "../src/codemode/bindings/shared";
import { buildConnectors } from "../src/codemode/connectors";
import type { CodeModeScope } from "../src/codemode/contracts";
import { renderDeclarationsFromConnectors } from "../src/codemode/dts";
import type { CapabilityDependencies } from "../src/codemode/gateways";
import {
  buildRegistry,
  capabilityEffectOf,
  PHASE_09_NAMESPACES,
} from "../src/codemode/registry";
import type { CapabilityEffect } from "../src/codemode/write-guard";
import type { Env } from "../src/index";
import { makeSandboxGateway, type SandboxOpsHandle } from "../src/sandbox/gateway";
import {
  fakeAuditSink,
  fakeDeps,
  seedPermittedScope,
  slackScope,
  testExecution,
  TEST_LIMITS,
} from "./helpers/codemode";

/**
 * A connector is constructed the way the DO constructs it, minus the DO: the
 * base class is a `WorkerEntrypoint`, whose constructor only stores `ctx`, so
 * nothing here reaches for a Durable Object. See the base class doc comment.
 */
const ctx = { waitUntil() {} } as unknown as ExecutionContext;

function build(
  options: {
    scope?: CodeModeScope;
    deps?: CapabilityDependencies;
    execution?: CodeExecution;
    workerEnv?: Env;
  } = {},
): CodemodeConnector[] {
  return buildConnectors(
    ctx,
    options.scope ?? slackScope,
    options.deps ?? fakeDeps(),
    TEST_LIMITS,
    options.execution ?? testExecution({ audit: fakeAuditSink() }),
    (options.workerEnv ?? env) as never,
  );
}

/**
 * The model's own call path, not the descriptor's.
 *
 * `executeTool` is what the codemode runtime invokes — it resolves the tool out
 * of the connector's cached `tools()` record and calls its `execute` with raw
 * args. Driving the guard, budget and audit cases through THIS rather than
 * through the registry descriptor is the whole point of these cases: the legacy
 * chassis's suites already prove the descriptor behaves; what is new is that
 * nothing is lost or added between the descriptor and the connector.
 */
function callConnector(
  connectors: CodemodeConnector[],
  namespace: string,
  method: string,
  args: unknown = {},
): Promise<unknown> {
  const connector = connectors.find((c) => c.name() === namespace);
  if (!connector) throw new Error(`no ${namespace} connector was built`);
  return connector.executeTool(method, args);
}

const publishArgs = (filename: string): Record<string, unknown> => ({
  bytes: new TextEncoder().encode(`id,name\n1,${filename}\n`),
  contentType: "text/csv",
  filename,
});

/**
 * Methods whose input schema legitimately has no properties.
 *
 * Pinned rather than tolerated in the general case. An empty `properties` and
 * a MISSING `properties` are one character apart in an assertion but opposite
 * in meaning: the first is a genuinely zero-argument capability, the second is
 * a capability whose model-facing type has silently degraded. Listing the four
 * that really take no arguments — each of them a `z.strictObject({}).default({})`
 * in its binding module — lets the sweep insist on real properties everywhere
 * else, and makes a fifth appearing a test failure rather than a shrug.
 */
const ZERO_ARG_METHODS = [
  "approval.withdraw",
  "betterstack.monitors",
  "sandbox.boot",
  "sandbox.diff",
];

/**
 * The whole model-facing API, swept in one pass.
 *
 * This is the test that says the port did not change what the model can see.
 * The capability code itself is shared — both chassis call `buildNamespaces`,
 * so the eleven `codemode-<ns>.test.ts` suites still cover behaviour — but the
 * PRESENTATION is new, and the presentation is where the silent failure lives:
 * `toolInputSchema` in the connector base accepts any object carrying a `type`
 * key, a Zod v4 schema has `.type === "object"`, and so a raw Zod schema is
 * used verbatim as JSON Schema. Nothing throws. The generated `.d.ts` just
 * quietly becomes `type XInput = unknown` with the description dropped, and
 * the model loses the typed API it plans against. Measured 2026-08-16
 * (verified fact 8); `src/codemode/schema.ts` carries the mechanism.
 */
describe("buildConnectors", () => {
  it("gives every method of every namespace a JSON Schema with properties, and marks none for approval", async () => {
    const connectors = build();
    expect(connectors.map((c) => c.name())).toEqual([...PHASE_09_NAMESPACES]);

    const zeroArg: string[] = [];
    let methods = 0;

    for (const connector of connectors) {
      const described = await connector.describe();
      const entries = Object.entries(described.descriptors);
      expect(entries.length, `${connector.name()} declares no methods`).toBeGreaterThan(0);

      for (const [method, descriptor] of entries) {
        methods += 1;
        const path = `${connector.name()}.${method}`;
        const input = descriptor.inputSchema as
          | { type?: string; properties?: Record<string, unknown> }
          | undefined;

        expect(input?.type, path).toBe("object");
        // The fact-8 assertion. A raw Zod schema passes the `type` check above
        // and fails exactly here, with no other symptom anywhere in the build.
        expect(
          input?.properties,
          `${path} has no properties — a raw Zod schema reached the connector and this capability now types as \`unknown\` for the model`,
        ).toBeDefined();
        if (Object.keys(input?.properties ?? {}).length === 0) zeroArg.push(path);

        // Approval is a model decision through the `approval` namespace with
        // host-owned state, never a runtime annotation: the runtime's approve
        // path takes only an `executionId`, so it cannot carry the text a human
        // edited in the dashboard. See spec decision D4.
        expect(described.annotations?.[method]?.requiresApproval, path).toBeUndefined();
      }
    }

    expect(zeroArg.sort()).toEqual([...ZERO_ARG_METHODS].sort());
    // The coverage claim, made explicit rather than implied by the loop. 32 is
    // the method count of the committed `capabilities.d.ts` — cross-checked, so
    // this asserts the connector path presents the SAME surface the legacy
    // renderer does, not merely a self-consistent one. A capability added or
    // dropped updates this number; a capability that silently stops being
    // declared does not get to pass quietly. (It was 31 until `github.searchPRs`
    // landed and this number was not moved with it — the count is only worth
    // having if it is maintained, so it is cross-checked against the effect
    // table below and against the committed artifact.)
    expect({ namespaces: connectors.length, methods }).toEqual({
      namespaces: PHASE_09_NAMESPACES.length,
      methods: 32,
    });
  });

  /**
   * The `.d.ts` generator derives its type names from the METHOD name alone —
   * `reply` becomes `ReplyInput`, whatever namespace it came from. Two
   * namespaces sharing a method name therefore emit the same type name twice,
   * and the second wins: one capability is silently given the other's argument
   * type, in a generated file nobody hand-reads. This is also the rule
   * CLAUDE.md states for adding a capability, enforced rather than remembered.
   */
  it("keeps method names globally unique across all namespaces", async () => {
    const seen = new Map<string, string>();
    for (const connector of build()) {
      const described = await connector.describe();
      for (const method of Object.keys(described.descriptors)) {
        const previous = seen.get(method);
        expect(
          previous,
          `method "${method}" is declared by both ${previous} and ${connector.name()}; the .d.ts generator names both types "${method[0]?.toUpperCase()}${method.slice(1)}Input" and one silently overwrites the other`,
        ).toBeUndefined();
        seen.set(method, connector.name());
      }
    }
  });

  /**
   * The same fact-8 claim as the sweep above, one layer further out.
   *
   * A JSON Schema with `properties` is necessary and not sufficient: what the
   * model is actually handed is the RENDERED declaration, and the failure mode
   * being pinned is a rendered `type XInput = unknown`. Asserting on the
   * rendered text is the assertion a reviewer can check by eye against the
   * committed artifact, and the per-method loop underneath is what stops the
   * text sweep from passing because a method quietly stopped being declared at
   * all — an absent block contains no `unknown` either.
   */
  it("renders a real input type for every method, never `type XInput = unknown`", async () => {
    const declarations = await renderDeclarationsFromConnectors(build());
    expect(declarations).not.toMatch(/^type \w+ = unknown$/m);

    for (const connector of build()) {
      const { name, descriptors } = await connector.describe();
      for (const method of Object.keys(descriptors)) {
        expect(declarations, `${name}.${method} is not declared at all`).toContain(
          `${method}: (input: `,
        );
      }
    }
  });

  /**
   * Descriptions are the other half of what `toolInputSchema` silently drops.
   *
   * A raw Zod schema does not only cost the argument types — the rendered block
   * loses the doc comment too, and the description is where every operational
   * rule the model must follow lives (`slack.reply`'s "the message has probably
   * already been sent", `github.openPR`'s whole PR convention). Asserted
   * VERBATIM and over every method: descriptions are single-line strings and
   * the renderer emits them intact, so a truncation or an escape is a real
   * change to what the model reads.
   */
  it("carries every method's description through to the JSON schema and the rendered declarations", async () => {
    const declarations = await renderDeclarationsFromConnectors(build());
    const namespaces: string[] = [];

    for (const connector of build()) {
      const { name, descriptors } = await connector.describe();
      namespaces.push(name);
      for (const [method, descriptor] of Object.entries(descriptors)) {
        const path = `${name}.${method}`;
        const description = descriptor.description;
        expect(typeof description, path).toBe("string");
        expect((description ?? "").length, `${path} has an empty description`).toBeGreaterThan(20);
        expect(declarations, `${path}'s description did not survive rendering`).toContain(
          description ?? "",
        );
      }
    }

    // Spot-checked by NAME rather than by count, so a namespace that stopped
    // describing itself cannot be masked by another one gaining a method.
    expect(namespaces).toEqual([...PHASE_09_NAMESPACES]);
  });

  /**
   * One degraded property in the whole model-facing surface, and it is named.
   *
   * `toJsonSchema` converts with `unrepresentable: "any"`, which emits `{}` —
   * JSON Schema for "any value" — for a node JSON Schema cannot express. Today
   * exactly one node needs it: `files.publish.bytes`, a `z.instanceof(Uint8Array)`.
   * The setting is what stops that ONE field from aborting the whole `files`
   * connector, so it is worth having; the risk it carries is that a future
   * schema quietly degrades under it and nobody notices, because "any" never
   * throws. Enumerating the degraded nodes turns that into a failing test.
   *
   * `anyOf`/`oneOf` branches are deliberately not walked: nothing in the surface
   * has one today, and a recursive walk that guessed at composition keywords
   * would be asserting about the converter rather than about the capabilities.
   */
  it("degrades exactly one property in the whole surface — files.publish.bytes — and nothing else", async () => {
    type Node = { properties?: Record<string, unknown>; items?: unknown };

    const collect = (node: unknown, path: string, out: string[]): void => {
      if (node === null || typeof node !== "object") return;
      if (Object.keys(node).length === 0) {
        out.push(path);
        return;
      }
      const schema = node as Node;
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        collect(child, `${path}.${key}`, out);
      }
      if (schema.items !== undefined) collect(schema.items, `${path}[]`, out);
    };

    const degraded: string[] = [];
    for (const connector of build()) {
      const { name, descriptors } = await connector.describe();
      for (const [method, descriptor] of Object.entries(descriptors)) {
        collect(descriptor.inputSchema, `${name}.${method}`, degraded);
      }
    }

    expect(degraded.sort()).toEqual(["files.publish.bytes"]);
  });

  /**
   * Approval is host-owned state reached through the `approval` namespace, never
   * a runtime annotation (spec decision D4). Two reasons it must stay that way,
   * and both are silent failures rather than errors: the runtime's approve path
   * takes only an `executionId`, so it cannot carry the text a human edited in
   * the dashboard, and the package's own `/ai` resolver DROPS a tool carrying
   * the annotation — a capability would simply vanish from the model's API.
   *
   * Asserted on the annotation map as a whole rather than per method, because
   * `describe()` populates that map from `requiresApproval` OR
   * `replay: "reexecute"`, and an empty map is the claim that neither has been
   * introduced anywhere.
   */
  it("never marks a tool for approval or for replay re-execution, in any namespace", async () => {
    for (const connector of build()) {
      const described = await connector.describe();
      expect(described.annotations ?? {}, connector.name()).toEqual({});
      for (const [method, descriptor] of Object.entries(described.descriptors)) {
        const path = `${connector.name()}.${method}`;
        expect(descriptor, path).not.toHaveProperty("requiresApproval");
        expect(descriptor, path).not.toHaveProperty("needsApproval");
      }
    }
  });

  /**
   * The classification table, re-asserted through the connector path.
   *
   * Copied from `codemode-write-guard.test.ts` on purpose rather than imported:
   * the point of a reviewed table is that changing it is a deliberate act in a
   * diff somebody reads, and a shared constant would let one edit move both
   * copies at once. What is NEW here is the second half — the set of methods the
   * connectors actually PRESENT to the model must be exactly the set of methods
   * that carry a classification. A capability that reached the model without
   * going through `auditedCapability` would appear on one side only.
   */
  it("presents exactly the classified surface, with the reviewed effect on every method", async () => {
    const presented: string[] = [];
    for (const connector of build()) {
      const { name, descriptors } = await connector.describe();
      for (const method of Object.keys(descriptors)) presented.push(`${name}.${method}`);
    }

    const table: Record<string, CapabilityEffect> = {};
    for (const provider of buildRegistry(
      slackScope,
      fakeDeps(),
      TEST_LIMITS,
      testExecution({ audit: fakeAuditSink() }),
    )) {
      for (const [method, tool] of Object.entries(provider.tools)) {
        const effect = capabilityEffectOf(tool);
        expect(effect, `${provider.name}.${method} is unclassified`).not.toBeNull();
        table[`${provider.name}.${method}`] = effect!;
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
      "linear.findIssue": "read",
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
      "sandbox.boot": "sandbox_write",
      "sandbox.exec": "sandbox_write",
      "sandbox.spawn": "sandbox_write",
      "sandbox.checkProcess": "sandbox_write",
      "sandbox.killProcess": "sandbox_write",
      "sandbox.readFile": "sandbox_write",
      "sandbox.writeFile": "sandbox_write",
      "sandbox.preview": "sandbox_write",
      "sandbox.diff": "sandbox_write",
      "github.openPR": "external_write",
      "github.checkPR": "read",
      "github.searchPRs": "read",
    });

    expect(presented.sort()).toEqual(Object.keys(table).sort());
  });
});

/* --------------------------------------------------- the guards, connected -- */

/**
 * The connector adds no policy and removes none.
 *
 * `FirefighterConnector.tools()` deliberately re-implements nothing: the Zod
 * parse, the audit chokepoint, the write guard, the effect ledger and the budget
 * all live inside the descriptor's `execute`, and the connector's only job is to
 * present it. These cases are what make that claim testable rather than a
 * comment — they drive `executeTool`, which is the call the codemode runtime
 * makes, and assert the guards fire there.
 */
describe("calling a capability through a connector", () => {
  it("refuses an external write when the channel stops being live or the run turns shadow, re-read at call time", async () => {
    const scope = await seedPermittedScope(env.DB);
    const channelId = scope.slackThread!.channelId;
    const connectors = build({ scope, deps: { ...fakeDeps(), db: env.DB } });

    // Permitted right now: a live channel and a non-shadow run.
    await expect(
      callConnector(connectors, "files", "publish", publishArgs("first.csv")),
    ).resolves.toBeDefined();

    await env.DB.prepare("UPDATE channels SET mode = 'observe' WHERE channel_id = ?")
      .bind(channelId)
      .run();

    // Same connectors, same execution — and refused, because the guard reads D1
    // at call time rather than when the connector was constructed.
    await expect(
      callConnector(connectors, "files", "publish", publishArgs("second.csv")),
    ).rejects.toThrow(/channel_read_only/);

    await env.DB.prepare("UPDATE channels SET mode = 'live' WHERE channel_id = ?")
      .bind(channelId)
      .run();
    await env.DB.prepare("UPDATE runs SET shadow = 1 WHERE id = ?").bind(scope.runId).run();

    await expect(
      callConnector(connectors, "files", "publish", publishArgs("third.csv")),
    ).rejects.toThrow(/shadow_write_denied/);
  });

  it("audits every call and charges it to the execution's budget, refusing past the cap", async () => {
    const audit = fakeAuditSink();
    const execution = testExecution({ audit });
    const connectors = build({ execution, deps: { ...fakeDeps(), db: env.DB } });

    await callConnector(connectors, "slack", "thread", {});
    await callConnector(connectors, "supabase", "schema", {});

    // Order is the assertion that matters: a `completed` with no `started`, or
    // two terminal events for one call, is the shape of a double-charged effect.
    expect(audit.events.map((e) => `${e.kind}:${e.namespace}.${e.method}`)).toEqual([
      "started:slack.thread",
      "completed:slack.thread",
      "started:supabase.schema",
      "completed:supabase.schema",
    ]);
    expect(execution.counter.used).toBe(2);

    // The budget belongs to the EXECUTION, not to a connector: reads spread
    // across two namespaces spend one pool, and the call past the cap never
    // reaches a gateway.
    while (execution.counter.used < TEST_LIMITS.maxCapabilityCalls) {
      await callConnector(connectors, "slack", "thread", {});
    }
    await expect(callConnector(connectors, "memory", "recall", { query: "x", scope: "org" })).rejects.toThrow(
      /budget/,
    );
  });

  /**
   * Redaction lives in the sandbox gateway, so the claim being made here is that
   * the connector path really reaches that gateway rather than some shortened
   * version of it. A dev-tier value that rode out on a result would land in the
   * run transcript, and from there in memory, and from there conceivably in a
   * customer-facing draft — `codemode-sandbox.test.ts` owns the redaction rules
   * themselves; this is the one case that proves the new presentation layer did
   * not step around them.
   */
  it("scrubs known dev-env values out of what a connector call hands back to the model", async () => {
    const sentinelKey = "SUPABASE_SECRET_API_KEY";
    const sentinel = "sk_dev_sentinel_7f3c9a11b2e4d6f8";
    const workerEnv = {
      ...env,
      SANDBOX_DISABLED: "",
      MONOREPO_DEV_ENV: JSON.stringify({ [sentinelKey]: sentinel }),
    } as Env;

    const connectors = build({
      workerEnv,
      deps: {
        ...fakeDeps(),
        db: env.DB,
        // The REAL gateway over a fake container: a fake gateway would assert
        // the redaction away rather than assert it.
        sandbox: makeSandboxGateway(workerEnv, `run_${crypto.randomUUID()}`, {
          resolve: () => fakeContainer(`${sentinelKey}=${sentinel}\nPATH=/usr/bin\n`, sentinel),
          sleep: async () => {},
        }),
      },
    });

    const out = (await callConnector(connectors, "sandbox", "exec", {
      cmd: "env",
      injectDevEnv: true,
    })) as { stdout: string; stderr: string };

    // The whole object, not one field: a value that survived into a nested
    // field or an error message reaches exactly the same places.
    expect(JSON.stringify(out)).not.toContain(sentinel);
    expect(out.stdout).toContain(`[redacted:${sentinelKey}]`);
    expect(out.stderr).toContain(`[redacted:${sentinelKey}]`);
  });
});

/**
 * A container that is provisioned and answers one command.
 *
 * Written here rather than shared with `codemode-sandbox.test.ts`: that file's
 * fake models the whole process table because its cases are about the process
 * table, and importing it would run its suites. This one only has to be ready
 * (`getProcess("provision")` returning a completed record is the entire
 * readiness protocol — see `lifecycle.ts`'s `report`) and to echo something back.
 */
function fakeContainer(stdout: string, sentinel: string): SandboxOpsHandle {
  const provision = {
    id: "provision",
    status: "completed",
    exitCode: 0,
    startTime: new Date(),
  };

  // Real overload signatures plus one wider implementation: `{ encoding: "none" }`
  // is the SDK's raw-byte variant and a single method shorthand cannot satisfy
  // both return types. Mirrors the SDK exactly.
  function readFile(
    path: string,
    options: { encoding: "none" },
  ): Promise<{ content: ReadableStream<Uint8Array>; size: number }>;
  function readFile(
    path: string,
    options?: { encoding?: string },
  ): Promise<{ content: string }>;
  async function readFile(
    _path: string,
    options?: { encoding?: string },
  ): Promise<{ content: string } | { content: ReadableStream<Uint8Array>; size: number }> {
    if (options?.encoding === "none") {
      return {
        size: 0,
        content: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
      };
    }
    return { content: "" };
  }

  return {
    async exec() {
      return { exitCode: 0, stdout, stderr: `warning: ${sentinel} is set\n` };
    },
    async killAllProcesses() {
      return 0;
    },
    async startProcess() {
      return { id: "proc_1" };
    },
    async getProcess(id: string) {
      return id === "provision" ? provision : null;
    },
    async getProcessLogs() {
      return { stdout: "STEP ready\n", stderr: "" };
    },
    async killProcess() {},
    readFile,
    async writeFile() {
      return { success: true };
    },
    async mkdir() {
      return { success: true };
    },
    async destroy() {},
    tunnels: {
      async get() {
        return { url: "https://example.invalid" };
      },
    },
  };
}
