import { describe, expect, it } from "vitest";
import { ZepError } from "@getzep/zep-cloud";
import { ZepMemory, isGraphNotFound } from "../src/memory/zep";

// The private `client` is compile-time privacy only; tests swap it to keep the
// real search() code path — including its catch — under test without network.
type GraphClient = {
  graph: { search: (req: unknown) => Promise<{ edges?: unknown[] }> };
};

function withFakeClient(memory: ZepMemory, graph: GraphClient["graph"]): ZepMemory {
  (memory as unknown as { client: GraphClient }).client = { graph };
  return memory;
}

describe("isGraphNotFound", () => {
  it("recognises the SDK's 404", () => {
    expect(isGraphNotFound(new ZepError({ message: "not found", statusCode: 404 }))).toBe(true);
  });

  it("does not treat other Zep failures as absence", () => {
    expect(isGraphNotFound(new ZepError({ message: "rate limited", statusCode: 429 }))).toBe(false);
    expect(isGraphNotFound(new ZepError({ message: "server error", statusCode: 500 }))).toBe(false);
    expect(isGraphNotFound(new Error("socket hang up"))).toBe(false);
    expect(isGraphNotFound("not an error")).toBe(false);
  });

  it("trusts a plain Error only when it names the condition", () => {
    expect(isGraphNotFound(new Error("Status code: 404. Body: not found"))).toBe(true);
    expect(isGraphNotFound(new Error("404"))).toBe(false);
  });
});

describe("ZepMemory.search on a graph nobody has written to", () => {
  // Regression: the org graph does not exist until the first internal write
  // creates it. The live Phase 10 smoke burned 6 capability calls retrying
  // `upstream_unavailable` for what was actually "nothing learned yet".
  it("returns empty facts instead of throwing", async () => {
    const memory = withFakeClient(new ZepMemory("z_test"), {
      search: async () => {
        throw new ZepError({ message: "not found", statusCode: 404 });
      },
    });
    await expect(memory.search("org", "anything")).resolves.toEqual([]);
  });

  it("still surfaces real upstream failures", async () => {
    const memory = withFakeClient(new ZepMemory("z_test"), {
      search: async () => {
        throw new ZepError({ message: "server error", statusCode: 500 });
      },
    });
    await expect(memory.search("org", "anything")).rejects.toThrow(/server error/);
  });
});
