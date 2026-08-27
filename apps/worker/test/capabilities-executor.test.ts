import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { PRODUCTION_LIMITS } from "../src/capabilities/execution";
import {
  makeGuardedExecutor,
  TRUNCATION_MARK,
} from "../src/capabilities/executor";
import { guardLoader } from "../src/capabilities/guarded-loader";
import { MAX_JSON_DEPTH, toSafeJson } from "../src/capabilities/result";

function executor(overrides: Partial<typeof PRODUCTION_LIMITS> = {}) {
  const limits = { ...PRODUCTION_LIMITS, ...overrides };
  return makeGuardedExecutor(guardLoader(env.LOADER, limits), limits, () =>
    Date.now()
  );
}

describe("guarded executor", () => {
  it("runs model-authored code and returns its value", async () => {
    const out = await executor().execute(
      "export default async function () { return 1 + 1; }",
      {}
    );
    expect(out.result).toBe(2);
    expect(out.error).toBeUndefined();
  });

  it("captures console output", async () => {
    const out = await executor().execute(
      'export default async function () { console.log("hello"); return null; }',
      {}
    );
    expect(out.logs?.join("\n")).toContain("hello");
  });

  it("REFUSES outbound fetch at invocation — the global exists, calling it throws", async () => {
    // globalOutbound: null leaves fetch DEFINED. Never assert absence; assert
    // the throw, which is what the sandbox actually does.
    const out = await executor().execute(
      "export default async function () { return typeof fetch; }",
      {}
    );
    expect(out.result).toBe("function");

    const blocked = await executor().execute(
      'export default async function () { await fetch("https://example.com"); return "sent"; }',
      {}
    );
    expect(blocked.error).toBeTruthy();
    expect(blocked.result).not.toBe("sent");
  });

  it("refuses code over the character ceiling without loading an isolate", async () => {
    const out = await executor({ maxCodeChars: 100 }).execute(
      "x".repeat(101),
      {}
    );
    expect(out.error).toMatch(/invalid_input/);
  });

  it("rejects get() on the guarded loader", () => {
    // get() is cached by name and would silently run stale code. Model-authored
    // code always goes through load().
    expect(() =>
      guardLoader(env.LOADER, PRODUCTION_LIMITS).get(
        "x",
        async () => ({}) as never
      )
    ).toThrow();
  });

  it("bounds an oversized result rather than returning it", async () => {
    const out = await executor({ maxResultChars: 200 }).execute(
      'export default async function () { return "x".repeat(5000); }',
      {}
    );
    expect(JSON.stringify(out)).toContain(TRUNCATION_MARK);
  });
});

describe("toSafeJson", () => {
  it("passes plain JSON data through", () => {
    expect(toSafeJson({ a: 1, b: ["x"] }, PRODUCTION_LIMITS)).toEqual({
      a: 1,
      b: ["x"],
    });
  });

  it("refuses a class instance rather than coercing it to {}", () => {
    // Quietly turning an Error into {} produces a result the model reasons
    // about incorrectly.
    expect(() => toSafeJson(new Error("boom"), PRODUCTION_LIMITS)).toThrow(
      /not plain JSON data/
    );
  });

  it("refuses binary rather than expanding it", () => {
    expect(() => toSafeJson(new Uint8Array([1, 2]), PRODUCTION_LIMITS)).toThrow(
      /not plain JSON data/
    );
  });

  it("never invokes a hostile toJSON()", () => {
    let called = false;
    const hostile = {
      toJSON: () => {
        called = true;
        return "safe";
      },
    };
    expect(() => toSafeJson(hostile, PRODUCTION_LIMITS)).toThrow();
    expect(called).toBe(false);
  });

  it("drops __proto__ instead of assigning it", () => {
    // JSON.parse creates __proto__ as a real own property, so an upstream
    // payload can carry one; `out[key] = …` would set the prototype.
    const parsed = JSON.parse(
      '{"__proto__": {"polluted": true}, "ok": 1}'
    ) as unknown;
    const safe = toSafeJson(parsed, PRODUCTION_LIMITS) as Record<
      string,
      unknown
    >;
    expect(safe).toEqual({ ok: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("refuses a circular reference", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => toSafeJson(cyclic, PRODUCTION_LIMITS)).toThrow(/circular/);
  });

  it("refuses nesting deeper than the run protocol can store", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i <= MAX_JSON_DEPTH; i += 1) deep = { next: deep };
    expect(() => toSafeJson(deep, PRODUCTION_LIMITS)).toThrow(/nested deeper/);
  });

  it("refuses a non-finite number", () => {
    expect(() => toSafeJson({ n: Number.NaN }, PRODUCTION_LIMITS)).toThrow(
      /no JSON representation/
    );
  });

  it("refuses a result over the character cap", () => {
    expect(() =>
      toSafeJson(
        { s: "x".repeat(500) },
        { ...PRODUCTION_LIMITS, maxResultChars: 100 }
      )
    ).toThrow(/output_too_large|the cap is/);
  });
});
