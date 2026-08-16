import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toJsonSchema } from "../src/codemode/schema";

describe("toJsonSchema", () => {
  it("produces a JSON Schema object with properties, not the Zod instance", () => {
    const zod = z.object({ channel: z.string(), text: z.string() });
    const json = toJsonSchema(zod);

    expect(json).not.toBe(zod);
    expect(json.type).toBe("object");
    // The whole point: a raw Zod schema also has `.type === "object"` but no
    // `.properties`, which is what silently degrades generated types to
    // `unknown` inside @cloudflare/codemode's toolInputSchema().
    expect(Object.keys(json.properties ?? {})).toEqual(["channel", "text"]);
    expect(json.required).toEqual(["channel", "text"]);
  });
});
