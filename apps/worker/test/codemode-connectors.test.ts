import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildConnectors } from "../src/codemode/connectors";
import { PHASE_09_NAMESPACES } from "../src/codemode/registry";
import {
  fakeAuditSink,
  fakeDeps,
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

function build() {
  return buildConnectors(
    ctx,
    slackScope,
    fakeDeps(),
    TEST_LIMITS,
    testExecution({ audit: fakeAuditSink() }),
    env as never,
  );
}

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
    // The coverage claim, made explicit rather than implied by the loop. 31 is
    // the method count of the committed `capabilities.d.ts` — cross-checked, so
    // this asserts the connector path presents the SAME surface the legacy
    // renderer does, not merely a self-consistent one. A capability added or
    // dropped updates this number; a capability that silently stops being
    // declared does not get to pass quietly.
    expect({ namespaces: connectors.length, methods }).toEqual({
      namespaces: PHASE_09_NAMESPACES.length,
      methods: 31,
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
});
