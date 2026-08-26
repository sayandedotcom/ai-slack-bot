import { describe, expect, it } from "vitest";

import { deriveFunnel } from "@/lib/api/counters";

describe("deriveFunnel", () => {
  it("derives dropped as the gap between triaged and woken", () => {
    expect(deriveFunnel({ seen: 148, triaged: 148, woken: 17, escalated: 1 })).toEqual({
      seen: 148,
      triaged: 148,
      dropped: 131,
      woken: 17,
      escalated: 1,
    });
  });

  it("clamps at zero rather than showing a negative stage", () => {
    // `triaged` and `woken` are counted by different consumers over the same
    // window, so a message triaged just before it opened and woken just after
    // makes `woken` momentarily the larger number. "-2 dropped" is not a thing
    // anyone should read on this page.
    expect(deriveFunnel({ seen: 10, triaged: 3, woken: 5, escalated: 0 }).dropped).toBe(0);
  });

  it("survives a quiet day with every counter at zero", () => {
    expect(deriveFunnel({ seen: 0, triaged: 0, woken: 0, escalated: 0 })).toEqual({
      seen: 0,
      triaged: 0,
      dropped: 0,
      woken: 0,
      escalated: 0,
    });
  });
});
