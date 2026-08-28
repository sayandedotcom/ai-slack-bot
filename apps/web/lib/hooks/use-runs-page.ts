"use client";

import { useInfiniteQuery } from "@tanstack/react-query";

import { asApiError } from "../api/errors";
import { getRuns, type RunListParams, type RunSummary } from "../api/runs";
import type { PanelState } from "../panel-state";
import { POLL_MS, queryKeys } from "../query/keys";

export const NO_RUNS_HINT =
  "No runs match — the agent wakes only when triage says so.";

/**
 * The runs list as pages. One infinite query per distinct filter set; the
 * first page refetches on the poll and later pages are appended on demand.
 */
export function useRunsPage(params: Omit<RunListParams, "cursor">): {
  state: PanelState<RunSummary[]>;
  fetchNext: () => void;
  hasNext: boolean;
  loadingNext: boolean;
} {
  const query = useInfiniteQuery({
    queryKey: queryKeys.runsPage(params),
    queryFn: ({ pageParam }) =>
      getRuns({
        ...params,
        cursor: pageParam ?? undefined,
        limit: params.limit ?? 30,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: POLL_MS.runs,
  });

  const runs = query.data?.pages.flatMap((p) => p.runs) ?? null;
  const state: PanelState<RunSummary[]> =
    runs !== null
      ? runs.length === 0
        ? { kind: "empty", hint: NO_RUNS_HINT }
        : { kind: "ready", data: runs }
      : query.isError
        ? {
            kind: "error",
            error: asApiError(query.error, "/api/runs"),
            retry: () => void query.refetch(),
          }
        : { kind: "loading" };

  return {
    state,
    fetchNext: () => void query.fetchNextPage(),
    hasNext: query.hasNextPage,
    loadingNext: query.isFetchingNextPage,
  };
}
