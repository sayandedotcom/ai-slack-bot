import type { UseQueryResult } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/errors";
import { toPanelState } from "@/lib/query/to-panel-state";

/** Only the four members `toPanelState` reads. */
function query<T>(partial: {
  data?: T;
  isError?: boolean;
  error?: unknown;
}): UseQueryResult<T, unknown> {
  return {
    data: partial.data,
    isError: partial.isError ?? false,
    error: partial.error ?? null,
    refetch: vi.fn(),
  } as unknown as UseQueryResult<T, unknown>;
}

describe("toPanelState", () => {
  it("is loading before anything has arrived", () => {
    expect(toPanelState(query<string[]>({})).kind).toBe("loading");
  });

  it("is ready once there is data", () => {
    const state = toPanelState(query({ data: ["a"] }));
    expect(state).toEqual({ kind: "ready", data: ["a"] });
  });

  it("keeps showing data when a background refetch has failed", () => {
    // TanStack sets status/isError on a failed refetch but RETAINS the previous
    // data. A panel that already has something to show must not blink to an
    // error banner because one poll in the background failed.
    const state = toPanelState(
      query({ data: ["a"], isError: true, error: new ApiError(503, "unavailable", "/api/runs") }),
    );
    expect(state).toEqual({ kind: "ready", data: ["a"] });
  });

  it("is an error only for a cold visitor with nothing better to render", () => {
    const state = toPanelState(
      query<string[]>({ isError: true, error: new ApiError(403, "forbidden", "/api/runs") }),
    );
    expect(state.kind).toBe("error");
    expect(state.kind === "error" && state.error.kind).toBe("forbidden");
  });

  it("wraps a non-ApiError rejection rather than letting it reach a panel untyped", () => {
    const state = toPanelState<string[]>(query({ isError: true, error: new Error("boom") }));
    expect(state.kind === "error" && state.error).toBeInstanceOf(ApiError);
    expect(state.kind === "error" && state.error.kind).toBe("unavailable");
  });

  it("reports emptiness only when the caller says what empty means", () => {
    const withoutRule = toPanelState(query({ data: [] as string[] }));
    expect(withoutRule.kind).toBe("ready");

    const withRule = toPanelState(query({ data: [] as string[] }), {
      emptyHint: "Nothing yet.",
      isEmpty: (rows) => rows.length === 0,
    });
    expect(withRule).toEqual({ kind: "empty", hint: "Nothing yet." });
  });
});
