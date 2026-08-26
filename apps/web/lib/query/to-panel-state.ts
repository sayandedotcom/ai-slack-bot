import type { UseQueryResult } from "@tanstack/react-query";

import { ApiError } from "../api/errors";
import type { PanelState } from "../panel-state";

type Options<T> = {
  /** Shown instead of the data when `isEmpty` says the result is a nothing. */
  emptyHint?: string;
  /** A ready-but-empty result is not the same as no result; only the caller knows which. */
  isEmpty?: (data: T) => boolean;
};

/**
 * Bridge one query into the four-state contract every panel renders through.
 *
 * The important line is the first one. TanStack sets `status: "error"` when a
 * refetch fails even though it has kept the previous `data` — so asking about
 * `data` BEFORE asking about the error is what implements the rule the Vite
 * dashboard states in `use-poll`: a panel that already has something to show
 * never falls back to a spinner or an error banner because one background poll
 * failed. Only a cold visitor, with nothing yet, sees `loading` or `error`.
 */
export function toPanelState<T>(
  query: UseQueryResult<T, unknown>,
  options: Options<T> = {},
): PanelState<T> {
  if (query.data !== undefined) {
    const { emptyHint, isEmpty } = options;
    if (emptyHint !== undefined && isEmpty?.(query.data) === true) {
      return { kind: "empty", hint: emptyHint };
    }
    return { kind: "ready", data: query.data };
  }

  if (query.isError) {
    const error =
      query.error instanceof ApiError
        ? query.error
        : new ApiError(0, "unavailable", "request");
    return { kind: "error", error, retry: () => void query.refetch() };
  }

  return { kind: "loading" };
}
