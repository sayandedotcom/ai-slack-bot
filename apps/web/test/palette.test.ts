import { describe, expect, it } from "vitest";

import { paletteItems } from "@/lib/palette";

describe("paletteItems", () => {
  it("lists pages, then runs, then approvals, each with an href and search text", () => {
    const items = paletteItems({
      runs: [
        {
          id: "abc-123",
          summary: "checkout broken",
          channelName: "zellify-pulsefit",
          status: "live",
        },
      ],
      approvals: [{ id: "apr:1", runId: "abc-123", draft: "We are on it" }],
    });
    expect(items[0]?.group).toBe("Pages");
    expect(items.find((i) => i.href === "/runs/abc-123")?.keywords).toContain(
      "zellify-pulsefit"
    );
    expect(
      items.find((i) => i.href === "/approvals?approval=apr:1")?.label
    ).toMatch(/We are on it/);
  });
});
