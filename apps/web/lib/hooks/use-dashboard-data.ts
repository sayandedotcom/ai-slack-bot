"use client";

import { useQuery } from "@tanstack/react-query";

import { type Counters, getCounters } from "../api/counters";
import { getIdentity, type Identity } from "../api/identity";
import { getRoster, type Roster } from "../api/roster";
import { getRuns, getRunUsageTotal, type RunSummary } from "../api/runs";
import { getShadowPairs, type ShadowPair } from "../api/shadow";
import type { PanelState } from "../panel-state";
import { POLL_MS, queryKeys } from "../query/keys";
import { toPanelState } from "../query/to-panel-state";

/**
 * One hook per endpoint, each a thin `useQuery` returning the four-state
 * contract panels render through.
 *
 * These are deliberately callable from anywhere. Two components asking for the
 * roster get one request and one answer, which is the whole reason the cache is
 * here — the Vite dashboard has to lift its roster poll to the shell and pass
 * it down precisely because it has no cache to dedupe with.
 */

export function useIdentityQuery(): {
  identity?: Identity;
  state: PanelState<Identity>;
} {
  const query = useQuery({
    queryKey: queryKeys.identity,
    queryFn: getIdentity,
    // Who you are cannot change while the tab is open: Access decides it before
    // the bundle is served. Polling it would ask a question with no new answer.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  return { identity: query.data, state: toPanelState(query) };
}

export function useRoster(): PanelState<Roster> {
  return toPanelState(
    useQuery({
      queryKey: queryKeys.roster,
      queryFn: getRoster,
      refetchInterval: POLL_MS.roster,
    })
  );
}

export function useCounters(): PanelState<Counters> {
  return toPanelState(
    useQuery({
      queryKey: queryKeys.counters,
      queryFn: getCounters,
      refetchInterval: POLL_MS.counters,
    })
  );
}

const NO_RUNS_HINT =
  "No runs yet — the agent wakes when a customer thread needs it.";

export function useRuns(limit = 50): PanelState<RunSummary[]> {
  return toPanelState(
    useQuery({
      queryKey: queryKeys.runs(limit),
      queryFn: () => getRuns(limit),
      refetchInterval: POLL_MS.runs,
    }),
    { emptyHint: NO_RUNS_HINT, isEmpty: (runs) => runs.length === 0 }
  );
}

/**
 * A run's spend, read only when its detail sheet is open. `enabled` is what
 * keeps a closed sheet from costing a request per run in the list.
 */
export function useRunUsage(id: string | null): PanelState<string> {
  return toPanelState(
    useQuery({
      queryKey: queryKeys.runUsage(id ?? ""),
      queryFn: () => getRunUsageTotal(id as string),
      enabled: id !== null,
      staleTime: 30_000,
    })
  );
}

const NO_SHADOW_HINT =
  "No shadow pairs yet — they appear once the agent has drafted against a thread a human also answered.";

export function useShadowPairs(): PanelState<ShadowPair[]> {
  return toPanelState(
    useQuery({
      queryKey: queryKeys.shadow,
      queryFn: getShadowPairs,
      refetchInterval: POLL_MS.shadow,
    }),
    { emptyHint: NO_SHADOW_HINT, isEmpty: (pairs) => pairs.length === 0 }
  );
}
