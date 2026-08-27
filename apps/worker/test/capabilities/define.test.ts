import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  assertClassified,
  CAPABILITY_EFFECTS,
  capabilityEffectOf,
  defineCapability,
  isCapabilityEffect,
} from "../../src/capabilities/define";
import { CapabilityError } from "../../src/gateways/errors";

const echo = defineCapability({
  description: "Echo a string back.",
  effect: "read",
  input: z.strictObject({ text: z.string() }),
  output: z.strictObject({ text: z.string() }),
  run: async (input) => ({ text: input.text }),
});

describe("defineCapability", () => {
  it("brands the tool with its effect", () => {
    expect(capabilityEffectOf(echo)).toBe("read");
  });

  it("parses its input at runtime, not just at the type level", async () => {
    await expect(echo.run({ text: 42 })).rejects.toThrow();
    await expect(echo.run({ text: "hi" })).resolves.toEqual({ text: "hi" });
  });

  it("refuses a descriptor with no effect", () => {
    expect(() =>
      defineCapability({
        description: "unclassified",
        // The cast is the point: this is what a JS caller or a bad cast does.
        effect: undefined as unknown as "read",
        input: z.strictObject({}),
        output: z.strictObject({}),
        run: async () => ({}),
      })
    ).toThrow(CapabilityError);
  });

  it("refuses a descriptor with an unknown effect", () => {
    expect(() =>
      defineCapability({
        description: "made up",
        effect: "database_write" as unknown as "read",
        input: z.strictObject({}),
        output: z.strictObject({}),
        run: async () => ({}),
      })
    ).toThrow(CapabilityError);
  });
});

describe("the audited brand", () => {
  it("cannot be forged by a hand-built object that merely has an effect field", () => {
    // The brand is a module-private symbol, so a look-alike carrying the right
    // field still reports null — which is what makes assertClassified a check
    // rather than a naming convention.
    const lookalike = {
      description: "d",
      effect: "read",
      run: async () => null,
    };
    expect(capabilityEffectOf(lookalike)).toBeNull();
  });

  it("reports null for non-objects", () => {
    expect(capabilityEffectOf(null)).toBeNull();
    expect(capabilityEffectOf("read")).toBeNull();
  });
});

describe("assertClassified", () => {
  it("accepts a namespace whose tools all came from defineCapability", () => {
    expect(() => assertClassified("demo", { echo })).not.toThrow();
  });

  it("names the offending method when one did not", () => {
    // A binding that hand-rolled a tool skipped the audit wrapper AND the write
    // guard, so this must fail at construction, not at the first call.
    expect(() =>
      assertClassified("demo", {
        echo,
        sneaky: { effect: "read", run: async () => null },
      })
    ).toThrow(/demo\.sneaky/);
  });
});

describe("the effect set", () => {
  it("is exactly the four the write guard knows about", () => {
    // Adding a fifth is a policy change: write-guard.ts branches on this union
    // and everything not `external_write` is ungated.
    expect([...CAPABILITY_EFFECTS]).toEqual([
      "read",
      "external_write",
      "control_write",
      "sandbox_write",
    ]);
  });

  it("guards against unknown strings", () => {
    expect(isCapabilityEffect("read")).toBe(true);
    expect(isCapabilityEffect("write")).toBe(false);
  });
});
