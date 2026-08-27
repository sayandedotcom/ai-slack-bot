import { describe, expect, it } from "vitest";
import type { ChannelPolicy } from "../../src/db/channels";
import { graphIdFor } from "../../src/memory/graphs";

const base: ChannelPolicy = {
  channel_id: "C1",
  name: "ext-pulsefit",
  customer_slug: "pulsefit",
  mode: "live",
  slug_source: "human",
  known: true,
};

describe("graphIdFor", () => {
  it("routes customer channels to customer:{slug}", () => {
    expect(graphIdFor(base)).toBe("customer:pulsefit");
    expect(graphIdFor({ ...base, mode: "observe" })).toBe("customer:pulsefit");
  });

  it("routes internal channels to org", () => {
    expect(graphIdFor({ ...base, customer_slug: null, mode: "internal" })).toBe(
      "org"
    );
  });

  it("routes an internal channel with a slug to org, not the customer graph", () => {
    expect(graphIdFor({ ...base, mode: "internal" })).toBe("org");
  });

  it("returns null for unknown channels", () => {
    expect(graphIdFor({ ...base, known: false })).toBeNull();
  });

  it("returns null for known channels with no slug and no internal mode", () => {
    expect(
      graphIdFor({ ...base, customer_slug: null, mode: "observe" })
    ).toBeNull();
  });
});
