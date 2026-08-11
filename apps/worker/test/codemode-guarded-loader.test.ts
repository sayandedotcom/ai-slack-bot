import { describe, expect, it, vi } from "vitest";
import { guardLoader } from "../src/codemode/guarded-loader";
import { TEST_LIMITS } from "./helpers/codemode";

/** Captures whatever the adapter hands the real binding. */
function fakeLoader() {
  const calls: WorkerLoaderWorkerCode[] = [];
  const loader = {
    load: vi.fn((code: WorkerLoaderWorkerCode) => { calls.push(code); return {} as WorkerStub; }),
    get: vi.fn(() => { throw new Error("get() must never be reached"); }),
  };
  return { loader: loader as unknown as WorkerLoader, calls, spies: loader };
}

const bundle = (patch: Partial<WorkerLoaderWorkerCode> = {}): WorkerLoaderWorkerCode => ({
  compatibilityDate: "2025-06-01",           // what the package sends
  compatibilityFlags: ["nodejs_compat"],
  mainModule: "executor.js",
  modules: { "executor.js": "export default class {}" },
  ...patch,
});

describe("guardLoader", () => {
  it("calls load() exactly once and never get()", () => {
    const { loader, spies } = fakeLoader();
    guardLoader(loader, TEST_LIMITS).load(bundle());
    expect(spies.load).toHaveBeenCalledTimes(1);
    expect(spies.get).not.toHaveBeenCalled();
  });

  // If a future SDK silently switches to cached execution we must fail loudly,
  // not run stale model code. get() is required by the interface; ours refuses.
  it("throws an invariant error if anything calls get()", () => {
    const { loader } = fakeLoader();
    expect(() => guardLoader(loader, TEST_LIMITS).get("name", () => bundle()))
      .toThrow(/never uses get\(\)/i);
  });

  it("forces globalOutbound to null when the caller omitted it", () => {
    const { loader, calls } = fakeLoader();
    guardLoader(loader, TEST_LIMITS).load(bundle());
    expect(calls[0].globalOutbound).toBeNull();
  });

  // The causal control in Task 14 proves omitting the field reaches the
  // internet. Production must make that configuration unreachable.
  it.each([
    ["a Fetcher", {} as Fetcher],
    ["undefined", undefined],
  ])("refuses a caller-supplied globalOutbound of %s", (_label, value) => {
    const { loader, calls } = fakeLoader();
    guardLoader(loader, TEST_LIMITS).load(bundle({ globalOutbound: value as never }));
    expect(calls[0].globalOutbound).toBeNull();      // forced, never inherited
  });

  it("rejects a non-empty loaded-Worker env", () => {
    const { loader } = fakeLoader();
    expect(() => guardLoader(loader, TEST_LIMITS).load(bundle({ env: { DB: {} } })))
      .toThrow(/env must be empty/i);
  });

  it("injects the reviewed limits", () => {
    const { loader, calls } = fakeLoader();
    guardLoader(loader, TEST_LIMITS).load(bundle());
    expect(calls[0].limits).toEqual({
      cpuMs: TEST_LIMITS.cpuMs,
      subRequests: TEST_LIMITS.subRequests,
    });
  });

  it("clamps a call site asking for larger limits", () => {
    const { loader, calls } = fakeLoader();
    guardLoader(loader, TEST_LIMITS).load(
      bundle({ limits: { cpuMs: 999_999, subRequests: 999_999 } }),
    );
    expect(calls[0].limits!.cpuMs).toBe(TEST_LIMITS.cpuMs);
    expect(calls[0].limits!.subRequests).toBe(TEST_LIMITS.subRequests);
  });

  // The package hardcodes 2025-06-01; the global constraint is 2026-08-01.
  it("pins the bundle's compatibility date to the project's", () => {
    const { loader, calls } = fakeLoader();
    guardLoader(loader, TEST_LIMITS).load(bundle());
    expect(calls[0].compatibilityDate).toBe("2026-08-01");
    expect(calls[0].compatibilityFlags).toContain("nodejs_compat");
  });

  it("accepts only the expected executor module", () => {
    const { loader } = fakeLoader();
    expect(() => guardLoader(loader, TEST_LIMITS).load(
      bundle({ modules: { "executor.js": "x", "evil.js": "fetch('https://x')" } }),
    )).toThrow(/unexpected module/i);
  });

  it("rejects a bundle whose mainModule is not among its modules", () => {
    const { loader } = fakeLoader();
    expect(() => guardLoader(loader, TEST_LIMITS).load(
      bundle({ mainModule: "other.js" }),
    )).toThrow(/unexpected module/i);
  });

  // tails would stream every console line, including capability arguments, to
  // another Worker. Nothing in this phase asks for that.
  it("refuses a bundle that attaches tail consumers", () => {
    const { loader } = fakeLoader();
    expect(() => guardLoader(loader, TEST_LIMITS).load(
      bundle({ tails: [{} as Fetcher] }),
    )).toThrow(/tail/i);
  });

  it("does not mutate the caller's object", () => {
    const { loader } = fakeLoader();
    const original = bundle();
    guardLoader(loader, TEST_LIMITS).load(original);
    expect(original.globalOutbound).toBeUndefined();
    expect(original.compatibilityDate).toBe("2025-06-01");
  });

  it("never lets a binding or secret into the bundle", () => {
    const { loader, calls } = fakeLoader();
    guardLoader(loader, TEST_LIMITS).load(bundle());
    const serialized = JSON.stringify(calls[0]);
    for (const forbidden of ["DB", "RUNS", "LOADER", "ARTIFACTS", "QUEUE",
                             "SLACK_BOT_TOKEN", "ANTHROPIC_API_KEY", "ZEP_API_KEY"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
