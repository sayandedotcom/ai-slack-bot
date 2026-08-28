import { describe, expect, it } from "vitest";

import { chipsByTurn, effectUrl, type RunEffect } from "@/lib/api/effects";

const e = (over: Partial<RunEffect>): RunEffect => ({
  turnId: "t1",
  namespace: "slack",
  method: "post",
  state: "completed",
  safeResult: null,
  safeError: null,
  createdAt: 1,
  ...over,
});

describe("effects", () => {
  it("groups chips per turn and counts repeats", () => {
    const chips = chipsByTurn([
      e({ namespace: "supabase", method: "read" }),
      e({ namespace: "supabase", method: "read" }),
      e({ namespace: "slack", method: "post" }),
      e({ turnId: "t2", namespace: "approval", method: "escalate" }),
    ]);
    expect(chips.get("t1")).toEqual(["supabase.read ×2", "slack.post"]);
    expect(chips.get("t2")).toEqual(["approval.escalate"]);
  });

  it("finds a link only when the safe result carries an https url", () => {
    expect(
      effectUrl(e({ safeResult: { html_url: "https://github.com/x/pull/1" } }))
    ).toBe("https://github.com/x/pull/1");
    expect(
      effectUrl(e({ safeResult: { permalink: "https://slack.com/p" } }))
    ).toBe("https://slack.com/p");
    expect(
      effectUrl(e({ safeResult: { url: "javascript:alert(1)" } }))
    ).toBeNull();
    expect(effectUrl(e({ safeResult: "nope" }))).toBeNull();
  });
});
