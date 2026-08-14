import { sanitizeToolName } from "@cloudflare/codemode";
import { resolveProvider } from "@cloudflare/codemode/ai";
import { resolveProvider as bareResolveProvider } from "@cloudflare/codemode";
import { describe, expect, it } from "vitest";
import { buildRegistry } from "../src/codemode/registry";
import { renderCapabilityDeclarations } from "../src/codemode/dts";
import { fakeDeps, slackScope, TEST_LIMITS, fakeAuditSink, testExecution } from "./helpers/codemode";

const registry = () => buildRegistry(slackScope, fakeDeps(), TEST_LIMITS, testExecution({ audit: fakeAuditSink() }));
const toPascal = (s: string) =>
  s.replace(/_([a-z])/g, (_, c) => c.toUpperCase()).replace(/^[a-z]/, (c) => c.toUpperCase());

describe("capability registry", () => {
  // Later phases APPEND. The order is the committed `.d.ts`'s identity, so an
  // insertion rewrites every block after it for nothing — which is why the
  // assertion is the whole list rather than a membership check.
  it("exposes exactly the Phase 09 namespaces plus approval, sandbox and browser, in order", () => {
    expect(registry().map((p) => p.name)).toEqual([
      "slack", "memory", "linear", "supabase", "langsmith", "betterstack", "files", "approval",
      "sandbox", "browser",
    ]);
  });

  it("uses namespaces that are valid identifiers and not reserved", () => {
    // RESERVED_NAMES in the package covers __dispatchers, console, Promise, ...
    const reserved = new Set(["__dispatchers", "__connectors", "__logs", "console",
                              "Promise", "setTimeout", "Error", "WorkerEntrypoint",
                              "CodeExecutor", "codemode"]);
    for (const p of registry()) {
      expect(p.name).toMatch(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/);
      expect(reserved.has(p.name)).toBe(false);
    }
  });

  // Invariant 20. generateTypes derives `type XInput` from the METHOD name with
  // no namespace prefix, so two `search`es would emit two `type SearchInput`
  // and the joined .d.ts would not compile. Assert on the DERIVED name: both
  // `search_messages` and `searchMessages` collapse to `SearchMessages`.
  it("has globally unique method names after PascalCase derivation", () => {
    const derived = new Map<string, string>();
    for (const p of registry()) {
      for (const method of Object.keys(p.tools)) {
        const typeName = toPascal(sanitizeToolName(method));
        const existing = derived.get(typeName);
        expect(existing, `${p.name}.${method} collides with ${existing}`).toBeUndefined();
        derived.set(typeName, `${p.name}.${method}`);
      }
    }
  });

  it("gives every tool a description, a strict input and a bounded output", () => {
    for (const p of registry()) {
      for (const [method, tool] of Object.entries(p.tools) as Array<
        [string, { description?: string; inputSchema?: unknown; outputSchema?: unknown; execute?: unknown }]
      >) {
        const label = `${p.name}.${method}`;
        expect(tool.description, label).toBeTruthy();
        expect(tool.inputSchema, label).toBeDefined();
        // An absent outputSchema makes the generated return type `unknown`.
        expect(tool.outputSchema, `${label} needs an outputSchema`).toBeDefined();
        expect(typeof tool.execute, label).toBe("function");
      }
    }
  });

  // resolveProvider silently DROPS tools carrying needsApproval. Approval is a
  // model decision here (Phase 11), never a tool annotation — assert loudly
  // rather than let a future annotation vanish without a trace.
  it("carries no approval annotations", () => {
    for (const p of registry()) {
      for (const [method, tool] of Object.entries(p.tools)) {
        expect(tool, `${p.name}.${method}`).not.toHaveProperty("needsApproval");
        expect(tool, `${p.name}.${method}`).not.toHaveProperty("requiresApproval");
      }
    }
  });

  it("survives the package's own resolver without losing a tool", () => {
    for (const p of registry()) {
      const resolved = resolveProvider({ name: p.name, tools: p.tools });
      expect(Object.keys(resolved.fns).sort(), p.name)
        .toEqual(Object.keys(p.tools).sort());
    }
  });

  it("builds the same namespace set regardless of run context", () => {
    const chat = buildRegistry(
      { ...slackScope, origin: "chat", slackThread: null, customerSlug: null },
      fakeDeps(), TEST_LIMITS, testExecution({ audit: fakeAuditSink() }),
    );
    expect(chat.map((p) => p.name)).toEqual(registry().map((p) => p.name));
  });
});

describe("input validation is ours, not inherited", () => {
  const slack = () => registry().find((p) => p.name === "slack")!;

  // The trap: two exported resolveProviders, only one validates, and `runCode`
  // lives in the entry that exports the NON-validating one. Our helper must
  // make the boundary hold either way.
  it.each([
    ["the /ai resolver", resolveProvider],
    ["the non-validating resolver", bareResolveProvider],
  ])("rejects an unknown field through %s", async (_label, resolve) => {
    const fns = resolve({ name: "slack", tools: slack().tools }).fns;
    await expect(fns.reply({ text: "hi", channel: "C_OTHER" }))
      .rejects.toThrow(/invalid_input|unrecognized|unknown/i);
  });

  it.each([
    ["the /ai resolver", resolveProvider],
    ["the non-validating resolver", bareResolveProvider],
  ])("rejects a wrong-typed field through %s", async (_label, resolve) => {
    const fns = resolve({ name: "slack", tools: slack().tools }).fns;
    await expect(fns.reply({ text: 42 }))
      .rejects.toThrow(/invalid_input|invalid_type/i);
  });

  // MEASURED 2026-08-12, and it decides which resolver production uses.
  //
  // The /ai resolver validates BEFORE our execute and throws
  // JSON.stringify(zodIssues) as the message. The model therefore receives a
  // raw JSON array rather than our `code: message` wire format, and cannot
  // branch on a code. It also echoes submitted values back in some issue
  // types, bypassing the "name the path, never the value" rule that
  // formatZodIssues exists to enforce.
  //
  // The bare resolver does not validate, so defineCapability's parse is the
  // only one and every rejection is well-formed. Counter-intuitively, the
  // NON-validating resolver is the correct choice for production.
  it("produces our wire format through the bare resolver", async () => {
    const fns = bareResolveProvider({ name: "slack", tools: slack().tools }).fns;
    await expect(fns.reply({ text: 42 })).rejects.toThrow(/^invalid_input: /);
  });

  it("produces the package's raw zod dump through the /ai resolver", async () => {
    const fns = resolveProvider({ name: "slack", tools: slack().tools }).fns;
    await expect(fns.reply({ text: 42 })).rejects.toThrow(/"code": "invalid_type"/);
  });

  // A zero-arg call arrives as execute(undefined) because ToolDispatcher
  // spreads an empty args array. `.default({})` is what makes this work.
  it("accepts a zero-argument call on methods declared callable that way", async () => {
    const fns = resolveProvider({ name: "slack", tools: slack().tools }).fns;
    await expect(fns.thread()).resolves.toBeInstanceOf(Array);

    const bs = registry().find((p) => p.name === "betterstack")!;
    const bsFns = resolveProvider({ name: "betterstack", tools: bs.tools }).fns;
    await expect(bsFns.monitors()).resolves.toBeInstanceOf(Array);
  });

  it("refuses a destination argument on every write capability", async () => {
    const reg = registry();
    const linear = resolveProvider({
      name: "linear",
      tools: reg.find((p) => p.name === "linear")!.tools,
    }).fns;
    await expect(linear.createIssue({
      title: "t", description: "d",
      assessment: { platformValue: "low", blocking: "low", customerWeight: "low", evidence: "e" },
      teamId: "T_OTHER",
    })).rejects.toThrow(/invalid_input|unrecognized/i);
  });
});

describe("generated declarations", () => {
  it("renders one declaration block per namespace with no duplicate type alias", () => {
    const dts = renderCapabilityDeclarations(registry());
    for (const ns of ["slack", "memory", "linear", "supabase",
                      "langsmith", "betterstack", "files", "sandbox", "browser"]) {
      expect(dts).toContain(`declare const ${ns}: {`);
    }
    const aliases = [...dts.matchAll(/^type (\w+) =/gm)].map((m) => m[1]);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it("never advertises a target, actor or credential argument", () => {
    const dts = renderCapabilityDeclarations(registry());
    for (const banned of ["channelId", "threadTs", "actor", "token", "apiKey",
                          "teamId", "workspace", "baseUrl", "sql"]) {
      expect(dts).not.toMatch(new RegExp(`\\b${banned}\\b`, "i"));
    }
  });

  // The silent-degradation guard. An input field JSON Schema cannot express
  // makes generateTypes emit `= unknown` for the WHOLE capability, with no
  // error — the model is then told nothing about any of its arguments. Only
  // `files` is allowed to opt out, and it does so with explicit declarations.
  it("never degrades a capability's types to unknown", () => {
    for (const provider of registry()) {
      if (provider.types) continue;
      const block = renderCapabilityDeclarations([provider]);
      expect(block, `${provider.name} renders an unknown type`)
        .not.toMatch(/^type \w+ = unknown$/m);
    }
  });

  it("documents every method it declares", () => {
    const dts = renderCapabilityDeclarations(registry());
    for (const provider of registry()) {
      for (const method of Object.keys(provider.tools)) {
        expect(dts, `${provider.name}.${method}`).toContain(`${method}: (input:`);
      }
    }
  });
});
