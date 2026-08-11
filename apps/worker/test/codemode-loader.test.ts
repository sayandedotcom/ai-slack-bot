import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("LOADER binding", () => {
  it("is present and exposes both Worker Loader methods", () => {
    expect(env.LOADER).toBeDefined();
    expect(typeof env.LOADER.load).toBe("function");
    expect(typeof env.LOADER.get).toBe("function");
  });

  // The de-risk. If this fails, stop and re-plan the phase's test strategy
  // before writing any executor code.
  it("loads and runs a trivial Dynamic Worker in the vitest runtime", async () => {
    const stub = env.LOADER.load({
      compatibilityDate: "2026-08-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "main.js",
      modules: {
        "main.js": `
          import { WorkerEntrypoint } from "cloudflare:workers";
          export default class extends WorkerEntrypoint {
            async ping(value) { return "pong:" + value; }
          }
        `,
      },
      globalOutbound: null,
    });

    const entrypoint = stub.getEntrypoint() as unknown as {
      ping(value: string): Promise<string>;
    };
    await expect(entrypoint.ping("hi")).resolves.toBe("pong:hi");
  });

  // Proves globalOutbound: null is causal in THIS runtime, not just deployed.
  // Task 14 repeats this against the production path and in staging.
  it("refuses outbound fetch when globalOutbound is null", async () => {
    const stub = env.LOADER.load({
      compatibilityDate: "2026-08-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "main.js",
      modules: {
        "main.js": `
          import { WorkerEntrypoint } from "cloudflare:workers";
          export default class extends WorkerEntrypoint {
            async probe() {
              // Assert refusal on INVOCATION. fetch remains defined.
              if (typeof fetch !== "function") return "fetch-missing";
              try { await fetch("https://example.com"); return "reached"; }
              catch (err) { return "refused:" + err.message; }
            }
          }
        `,
      },
      globalOutbound: null,
    });

    const entrypoint = stub.getEntrypoint() as unknown as {
      probe(): Promise<string>;
    };
    const result = await entrypoint.probe();
    expect(result).toMatch(/^refused:/);
    expect(result).not.toBe("fetch-missing"); // absence is the wrong claim
  });
});
