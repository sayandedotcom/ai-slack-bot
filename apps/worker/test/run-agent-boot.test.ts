import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

import { chatRunKey } from "../src/run/keys";

/**
 * The tool surface is the security boundary, so it is pinned twice.
 *
 * `toolNames()` is the MERGED map Think assembles for a turn. It can never be
 * just run_code: think.js:2628 calls createWorkspaceTools() unconditionally and
 * tools/workspace.js:72 always returns seven file tools (only `bash` is
 * conditional, on `workspaceBash`). This assertion is the TRIPWIRE — if a
 * session context block auto-wires `set_context`, or a skill, an extension or
 * an MCP server appears, this set changes and the test fails.
 *
 * `activeToolsForTest()` is the CONTROL: what beforeTurn tells the AI SDK the
 * model may actually call. That is the invariant-5 enforcement point.
 */
const EXPECTED_MERGED_TOOLS = [
  "delete",
  "edit",
  "find",
  "grep",
  "list",
  "read",
  "run_code",
  "write",
];

/** A fresh key per case: pool storage is shared across tests AND files. */
function freshKey(): string {
  return chatRunKey(crypto.randomUUID());
}

describe("RunAgent boot", () => {
  it("exposes exactly the expected merged tool set and no others", async () => {
    const stub = await getAgentByName(env.RUN_AGENTS, freshKey());
    const names = await stub.toolNames();
    expect([...names].sort()).toEqual(EXPECTED_MERGED_TOOLS);
  });

  it("lets the model call run_code and nothing else", async () => {
    const stub = await getAgentByName(env.RUN_AGENTS, freshKey());
    expect(await stub.activeToolsForTest()).toEqual(["run_code"]);
  });

  it("has a working Code Mode facet", async () => {
    // getRuntime() runs eagerly at tool construction but facets.get is LAZY, so
    // counting tool names proves nothing about the facet. Only a call into it
    // does. A missing `v5` migration entry fails HERE, with
    // "Incorrect type for the 'class' field on 'StartupOptions'".
    const stub = await getAgentByName(env.RUN_AGENTS, freshKey());
    expect(await stub.codemodeReady()).toBe(true);
  });

  it("does not send the private run key to a client on connect", async () => {
    // The DO name IS the run key. agents/dist/index.js:951-964 would otherwise
    // send it as a cf_agent_identity frame to every connecting browser.
    const stub = await getAgentByName(env.RUN_AGENTS, freshKey());
    expect(await stub.sendsIdentityOnConnect()).toBe(false);
  });
});
