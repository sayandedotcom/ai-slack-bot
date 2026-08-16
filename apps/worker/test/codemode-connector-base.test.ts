import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FirefighterConnector } from "../src/codemode/connectors/base";
import type { CapabilityNamespace } from "../src/codemode/connectors/base";

const ctx = { waitUntil() {} } as unknown as ExecutionContext;

function namespace(): CapabilityNamespace {
  return {
    name: "demo",
    instructions: "A demo namespace.",
    tools: {
      echo: {
        effect: "read",
        description: "Echo a word back",
        inputSchema: z.object({ word: z.string() }),
        outputSchema: z.object({ word: z.string() }),
        execute: async (raw: unknown) => raw,
      },
    },
  };
}

describe("FirefighterConnector", () => {
  /**
   * The one test this file is allowed, because it is the one failure that is
   * silent. Handing `describe()` a raw Zod schema does not throw, does not
   * fail to typecheck, and does not warn: `toolInputSchema` accepts it
   * (a Zod v4 object has `.type === "object"`), then renders
   * `type EchoInput = unknown` and drops the description. The model loses the
   * entire typed API and nothing anywhere says so. Measured 2026-08-16.
   */
  it("describes tools with real JSON Schema, not the Zod instance", async () => {
    const connector = new FirefighterConnector(ctx, env as never, namespace());

    const described = await connector.describe();
    const input = described.descriptors.echo?.inputSchema as
      | { properties?: Record<string, unknown> }
      | undefined;

    expect(Object.keys(input?.properties ?? {})).toEqual(["word"]);
    expect(described.descriptors.echo?.description).toBe("Echo a word back");
  });
});
