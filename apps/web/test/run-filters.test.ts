import { describe, expect, it } from "vitest";

import {
  activeFilterCount,
  EMPTY_FILTERS,
  filtersToSearch,
  parseRunFilters,
  toListParams,
  withFilter,
} from "@/lib/runs/filters";

describe("run filters", () => {
  it("round-trips through the URL and drops garbage", () => {
    const f = parseRunFilters(
      new URLSearchParams(
        "q=android&status=live&origin=chat&shadow=true&channelId=C1"
      )
    );
    expect(f).toEqual({
      q: "android",
      status: "live",
      origin: "chat",
      channelId: "C1",
      shadow: true,
    });
    expect(filtersToSearch(f).toString()).toBe(
      "q=android&status=live&origin=chat&channelId=C1&shadow=true"
    );
    expect(
      parseRunFilters(
        new URLSearchParams("status=bogus&origin=email&shadow=maybe")
      )
    ).toEqual(EMPTY_FILTERS);
  });
  it("maps to list params without nulls", () => {
    expect(toListParams(EMPTY_FILTERS)).toEqual({});
    expect(toListParams(withFilter(EMPTY_FILTERS, "shadow", false))).toEqual({
      shadow: false,
    });
  });
  it("counts active chips, not the search box", () => {
    expect(
      activeFilterCount(
        withFilter(withFilter(EMPTY_FILTERS, "q", "x"), "status", "done")
      )
    ).toBe(1);
  });
});
