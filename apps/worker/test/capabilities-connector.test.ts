import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { FirefighterConnector } from "../src/capabilities/connector";
import { defineCapability } from "../src/capabilities/define";
import { toJsonSchema } from "../src/capabilities/schema";

const namespace = {
  name: "demo",
  instructions: "A demo namespace.",
  tools: {
    echo: defineCapability({
      description: "Echo a string back.",
      effect: "read" as const,
      input: z.strictObject({ text: z.string().describe("what to echo") }),
      output: z.strictObject({ text: z.string() }),
      run: async (input) => ({ text: input.text }),
    }),
    ping: defineCapability({
      description: "Zero-argument call.",
      effect: "read" as const,
      // A zero-arg call reaches the host as execute(undefined). Without
      // .default({}) that fails validation.
      input: z.object({}).default({}),
      output: z.strictObject({ ok: z.boolean() }),
      run: async () => ({ ok: true }),
    }),
    publish: defineCapability({
      description: "Takes binary, like files.publish does.",
      effect: "external_write" as const,
      input: z.strictObject({
        bytes: z.instanceof(Uint8Array),
        filename: z.string().describe("the name to store it under"),
      }),
      output: z.strictObject({ url: z.string() }),
      run: async () => ({ url: "https://example.test/a" }),
    }),
  },
};

function connector() {
  return new FirefighterConnector(
    {} as ExecutionContext,
    env,
    {
      name: namespace.name,
      instructions: namespace.instructions,
      build: () => namespace.tools,
    },
    async () => undefined
  );
}

describe("FirefighterConnector — the raw-Zod trap", () => {
  it("renders a real JSON Schema with properties, not the Zod instance", async () => {
    // THE TRAP: codemode's toolInputSchema accepts a Zod schema silently
    // because it has .type === "object", then the model-facing type degrades
    // to `unknown` and the description is dropped, with no error anywhere.
    const described = await connector().describe();
    expect(described.descriptors.echo?.inputSchema).toHaveProperty(
      "properties.text"
    );
    expect(described.descriptors.echo?.inputSchema).not.toHaveProperty("_def");
  });

  it("keeps the field description the model reads", async () => {
    const described = await connector().describe();
    expect(JSON.stringify(described.descriptors.echo?.inputSchema)).toContain(
      "what to echo"
    );
  });

  it("degrades only the unrepresentable FIELD, never the whole capability", async () => {
    // z.instanceof(Uint8Array) has no JSON Schema. `unrepresentable: "any"`
    // emits {} for that one node. Throwing instead would abort tools(), so
    // describe() would throw, so the whole connector would fail to build and
    // run_code could not be constructed at all.
    const described = await connector().describe();
    const publish = described.descriptors.publish;
    expect(publish?.inputSchema).toHaveProperty("properties.bytes");
    // The sibling field keeps its real type and description.
    expect(JSON.stringify(publish?.inputSchema)).toContain(
      "the name to store it under"
    );
  });
});

describe("FirefighterConnector — approval flags", () => {
  it("never sets an approval flag on any tool", async () => {
    // needsApproval makes resolveProvider drop the tool with NO warning;
    // requiresApproval routes into a durable pause flow that takes only an
    // executionId and so cannot carry the text a human edited.
    const described = await connector().describe();
    for (const [method, descriptor] of Object.entries(described.descriptors)) {
      expect(
        (descriptor as { needsApproval?: unknown }).needsApproval,
        method
      ).toBeUndefined();
      expect(
        described.annotations?.[method]?.requiresApproval,
        method
      ).toBeUndefined();
    }
  });
});

describe("FirefighterConnector — execution", () => {
  it("runs a tool and returns its result", async () => {
    expect(
      await connector().executeTool(
        "echo",
        { text: "hi" },
        { executionId: "e1" }
      )
    ).toEqual({ text: "hi" });
  });

  it("accepts a zero-argument call", async () => {
    expect(
      await connector().executeTool("ping", undefined, { executionId: "e2" })
    ).toEqual({
      ok: true,
    });
  });

  it("validates arguments at runtime through the Zod schema, not the JSON Schema", async () => {
    await expect(
      connector().executeTool("echo", { text: 42 }, { executionId: "e3" })
    ).rejects.toThrow();
  });

  it("exposes the namespace name and instructions", async () => {
    expect(connector().name()).toBe("demo");
    const described = await connector().describe();
    expect(described.instructions).toBe("A demo namespace.");
  });
});

describe("toJsonSchema", () => {
  it("renders an object schema with properties", () => {
    const rendered = toJsonSchema(z.strictObject({ a: z.string() }));
    expect(rendered).toMatchObject({ type: "object" });
    expect(rendered).toHaveProperty("properties.a");
  });

  it("does not throw on an unrepresentable node", () => {
    expect(() =>
      toJsonSchema(z.strictObject({ b: z.instanceof(Uint8Array) }))
    ).not.toThrow();
  });

  it("caches by schema instance", () => {
    const schema = z.strictObject({ a: z.string() });
    expect(toJsonSchema(schema)).toBe(toJsonSchema(schema));
  });
});

describe("FirefighterConnector — per-execution isolation", () => {
  function counting() {
    const built: string[] = [];
    const connector = new FirefighterConnector(
      {} as ExecutionContext,
      env,
      { name: "demo", build: () => namespace.tools },
      async (executionId) => {
        built.push(executionId);
        return undefined;
      }
    );
    return { built, connector };
  }

  it("builds ONE context per execution, shared by every call in it", async () => {
    // Before the 2026-08-24 fix the context was rebuilt per CALL, so the
    // per-execution call budget could never trip and a customer reference
    // minted by one call was unknown to the next.
    const { built, connector } = counting();
    await connector.executeTool("echo", { text: "a" }, { executionId: "e1" });
    await connector.executeTool("echo", { text: "b" }, { executionId: "e1" });
    await connector.executeTool("ping", undefined, { executionId: "e1" });
    expect(built.filter((id) => id === "e1")).toHaveLength(1);
  });

  it("gives a different execution its own context", async () => {
    // CodemodeConnector.resolvedTools() memoises tools() per INSTANCE, so the
    // connector cannot be where per-execution state refreshes; the map keyed
    // by executionId is.
    const { built, connector } = counting();
    await connector.executeTool("echo", { text: "a" }, { executionId: "e1" });
    await connector.executeTool("echo", { text: "a" }, { executionId: "e2" });
    expect(built.filter((id) => id !== "render")).toEqual(["e1", "e2"]);
  });

  it("refuses a call that did not come through the runtime", async () => {
    // No executionId means no execution to charge a budget to. Refuse rather
    // than silently hand the call a private one.
    const { connector } = counting();
    await expect(
      connector.executeTool("echo", { text: "a" }, undefined as never)
    ).rejects.toMatchObject({ code: "invalid_context" });
  });
});
