import { describe, expect, it } from "vitest";

import { runListQuery } from "@/lib/api/runs";

describe("runListQuery", () => {
  it("is empty for no params and omits undefined ones", () => {
    expect(runListQuery({})).toBe("");
    expect(runListQuery({ status: undefined, q: "" })).toBe("");
  });
  it("encodes every param and booleans as words", () => {
    expect(
      runListQuery({
        status: "live",
        shadow: false,
        q: "a b",
        cursor: "1_x",
        limit: 20,
      })
    ).toBe("?status=live&shadow=false&q=a+b&cursor=1_x&limit=20");
  });
});
