import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/index";
import type { RunAgent } from "../src/run/agent";

/**
 * A FRESH key per case. Pool storage is shared across tests and files (no
 * `isolatedStorage`), so a reused key would carry another case's session.
 */
function agentFor() {
  return getAgentByName<Env, RunAgent>(env.RUN_AGENTS, `chat:${crypto.randomUUID()}`);
}

describe("RunAgent core", () => {
  it("exposes exactly one model-facing tool, run_code", async () => {
    const agent = await agentFor();
    // Invariant 5. Think merges workspace bash, fetch and MCP tools into the
    // same map by default, and none of them would pass the write guard.
    expect(await agent.toolNames()).toEqual(["run_code"]);
  });

  it("ships neither a state filesystem nor a cdp browser to the sandbox", async () => {
    const agent = await agentFor();
    const names = await agent.connectorNames();

    // Verified fact 3a. `createExecuteRuntime` merges `optionsFromAgent(agent)`
    // UNDER the overrides, and that derives `state` from `this.workspace` --
    // which Think defaults to a real DO-SQLite Workspace -- and `browser` from
    // env.BROWSER. Only `state: undefined, browser: undefined` in the overrides
    // keeps them out; `workspaceBash = false` does not. This asserts on the
    // connector set the runtime was actually built from, so it fails if either
    // override is ever dropped.
    expect(names).not.toContain("state");
    expect(names).not.toContain("cdp");
    // ...and the eleven real namespaces are all still there.
    expect(names).toContain("slack");
    expect(names).toContain("github");
    expect(names).toHaveLength(11);
  });

  it("runs model-authored code and returns its value", async () => {
    const agent = await agentFor();
    // A REAL execution, not a keys-only check: `facets.get` is lazy, so tool
    // construction succeeds against a broken facet class and only this proves
    // the codemode runtime actually boots (verified fact 4b).
    const out = await agent.executeForTest("return 2 + 3");
    expect(out.status).toBe("completed");
    expect(out).toMatchObject({ result: 5 });
  });
});
