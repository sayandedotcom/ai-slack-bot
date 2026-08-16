import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildConnectors } from "../src/codemode/connectors";
import { buildNamespaces, capabilityEffectOf } from "../src/codemode/registry";
import type { CapabilityDependencies } from "../src/codemode/gateways";
import {
  fakeAuditSink,
  fakeDeps,
  seedPermittedScope,
  TEST_LIMITS,
  testExecution,
} from "./helpers/codemode";

/**
 * A connector is constructed the way `RunAgent` constructs it, minus the DO:
 * the base class is a `WorkerEntrypoint` whose constructor only stores `ctx`.
 * Mirrors `test/codemode-connectors.test.ts`.
 */
const ctx = { waitUntil() {} } as unknown as ExecutionContext;

/**
 * A Linear gateway that records the idempotency key of every issue it files.
 *
 * The count IS the assertion: this stands in for the vendor, and "the vendor
 * saw exactly one call" is the only statement about at-most-once that a
 * customer would recognise.
 */
function countingLinear(): {
  gateway: CapabilityDependencies["linear"];
  filed: string[];
} {
  const filed: string[] = [];
  return {
    filed,
    gateway: {
      ...fakeDeps().linear,
      async createIssue(input) {
        filed.push(input.idempotencyKey);
        return {
          id: "iss_replay",
          identifier: "FIR-9",
          url: "https://linear.app/z/issue/FIR-9",
        };
      },
    },
  };
}

const issue = {
  title: "Checkout times out for enterprise carts",
  description: "Repros on carts above 200 lines.",
  assessment: {
    platformValue: "high" as const,
    blocking: "medium" as const,
    customerWeight: "high" as const,
    evidence: "Three customers in two weeks.",
  },
};

/**
 * Invariant 7 — one execution's `external_write` reaches the vendor at most
 * once, however many times the call is made.
 *
 * ## Why this is not a pause/resume test, measured rather than assumed
 *
 * The plan's Step 3 asks for a paused execution resumed into a replay pass.
 * **That pass is unreachable in this configuration**, and the reason is spec
 * decision D4 rather than an oversight. Read from
 * `@cloudflare/codemode@…/dist/index.js` on 2026-08-16:
 *
 * - `CodemodeRuntime.decide(...)` is the ONLY writer of
 *   `status = 'paused'`, and it writes it in exactly one branch — the one
 *   guarded by `if (requiresApproval)` (`dist/index.js:679-690`).
 * - `requiresApproval` reaches `decide` from
 *   `setup.annotations[`${name}.${method}`]?.requiresApproval ?? false`
 *   in `buildConnectorBindings` (`dist/index.js:1573-1575`) — i.e. straight
 *   off the connector's own `describe()`.
 * - `runtime.resume(id)` returns `null` for anything whose status is not
 *   `paused` (`dist/index.js:616-625`), and `resumeCodemode` turns that into
 *   `"…is not paused (status: …); only a paused run can be approved."`
 *   (`dist/index.js:1817-1826`). `runPass` is the only caller of the
 *   connectors, so no second pass runs.
 * - The other `{ kind: "pause" }` returns are dead ends for replay, not routes
 *   into it: `#fail`/`#diverge` mark the execution `error` before returning it
 *   (`dist/index.js:923-936`), and the "already not running" guard at the top
 *   of `decide` only fires once something else has already paused the run.
 *
 * This project sets `requiresApproval` on nothing — approval is a
 * model-called capability with host-owned state, because
 * `CodemodeApproveOptions = { executionId }` has no edit path (verified fact
 * 5, D4). `test/codemode-connectors.test.ts` sweeps all eleven namespaces and
 * asserts the flag is absent everywhere; the single-namespace check below is
 * the local guard, so this test can never quietly become a no-op by testing a
 * method that pauses.
 *
 * So a codemode-driven replay cannot happen here, and a test that "paused and
 * resumed" would be asserting against an error string. What remains is the
 * property the replay test was there to protect, proven directly and at the
 * seam that would actually be crossed twice: the connector's `executeTool` —
 * which is exactly what `buildConnectorBindings` calls on every pass, with the
 * same `executionId`. Two identical calls in one turn, one vendor call, one
 * `completed` ledger row.
 */
describe("effect ledger vs codemode replay", () => {
  it("fires an external_write once when its execution runs the same call twice", async () => {
    const scope = await seedPermittedScope(env.DB);
    const { gateway, filed } = countingLinear();
    const deps = { ...fakeDeps(), db: env.DB, linear: gateway };

    // This test is only worth anything if `createIssue` is a write. A `read` is
    // never ledgered at all, so a reclassification would leave every assertion
    // below passing against a capability that was never at risk.
    const namespaces = buildNamespaces(
      scope,
      deps,
      TEST_LIMITS,
      testExecution({ audit: fakeAuditSink(), outerToolCallId: "classify-only" }),
    );
    const declared = namespaces.find((p) => p.name === "linear")!.tools.createIssue!;
    expect(capabilityEffectOf(declared)).toBe("external_write");

    const connectors = buildConnectors(
      ctx,
      scope,
      deps,
      TEST_LIMITS,
      testExecution({ audit: fakeAuditSink() }),
      env as never,
    );
    const linear = connectors.find((c) => c.name() === "linear")!;

    // No annotation means `decide` never records a pending action and never
    // pauses — the reachability argument in this file's header, asserted.
    const described = await linear.describe();
    expect(described.annotations?.createIssue?.requiresApproval ?? false).toBe(false);

    // ONE execution id across both calls, because that is what a resume does:
    // the id is "stable across a run's pause/resume passes" (the package's own
    // `ToolExecuteContext` doc). Same turn, same arguments, same canonical key.
    const executionId = `exec_${crypto.randomUUID()}`;
    const first = await linear.executeTool("createIssue", issue, { executionId });
    const second = await linear.executeTool("createIssue", issue, { executionId });

    // The whole point. A second vendor call here is a duplicate customer-facing
    // artifact with nothing thrown anywhere.
    expect(filed).toHaveLength(1);
    // ...and the replay hands back the RECORDED result, not a fresh one, so a
    // resumed script reads the same issue url it read on the first pass.
    expect(second).toEqual(first);

    const rows = await env.DB.prepare(
      `SELECT effect_key, state FROM codemode_effects
        WHERE run_id = ? AND turn_id = ? AND namespace = 'linear' AND method = 'createIssue'`,
    )
      .bind(scope.runId, scope.turnId)
      .all<{ effect_key: string; state: string }>();

    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.state).toBe("completed");
    // The ledger and the vendor agree on what "the same effect" MEANS: the row's
    // key is the token the create was filed under. Without this the two could
    // each be internally consistent and still be counting different things.
    expect(filed[0]).toBe(rows.results[0]?.effect_key);
  });
});
