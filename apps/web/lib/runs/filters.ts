import type { RunListParams, RunStatus } from "../api/runs";

/**
 * The runs list's filter state, and the pure URL bridge for it.
 *
 * `q` is kept out of `activeFilterCount` deliberately: the search box already
 * shows its own contents, so counting it too would double the same fact.
 * `run-filters.tsx` uses the count (checked against zero, ORed with `q`
 * itself) only to decide whether to show a "Clear" control — there is no chip
 * badge that renders the number.
 */
export type RunFilters = {
  q: string;
  status: RunStatus | null;
  origin: "slack" | "chat" | null;
  channelId: string | null;
  shadow: boolean | null;
};

export const EMPTY_FILTERS: RunFilters = {
  q: "",
  status: null,
  origin: null,
  channelId: null,
  shadow: null,
};

const STATUSES: readonly RunStatus[] = [
  "live",
  "awaiting_approval",
  "idle",
  "done",
  "failed",
];

export function parseRunFilters(search: URLSearchParams): RunFilters {
  const status = search.get("status");
  const origin = search.get("origin");
  const shadow = search.get("shadow");
  return {
    q: search.get("q") ?? "",
    status: STATUSES.includes(status as RunStatus)
      ? (status as RunStatus)
      : null,
    origin: origin === "slack" || origin === "chat" ? origin : null,
    channelId: search.get("channelId") || null,
    shadow: shadow === "true" ? true : shadow === "false" ? false : null,
  };
}

export function filtersToSearch(f: RunFilters): URLSearchParams {
  const s = new URLSearchParams();
  if (f.q) s.set("q", f.q);
  if (f.status) s.set("status", f.status);
  if (f.origin) s.set("origin", f.origin);
  if (f.channelId) s.set("channelId", f.channelId);
  if (f.shadow !== null) s.set("shadow", String(f.shadow));
  return s;
}

export function toListParams(
  f: RunFilters
): Omit<RunListParams, "cursor" | "limit"> {
  const p: Omit<RunListParams, "cursor" | "limit"> = {};
  if (f.q) p.q = f.q;
  if (f.status) p.status = f.status;
  if (f.origin) p.origin = f.origin;
  if (f.channelId) p.channelId = f.channelId;
  if (f.shadow !== null) p.shadow = f.shadow;
  return p;
}

export function withFilter<K extends keyof RunFilters>(
  f: RunFilters,
  key: K,
  value: RunFilters[K]
): RunFilters {
  return { ...f, [key]: value };
}

export function activeFilterCount(f: RunFilters): number {
  return [f.status, f.origin, f.channelId, f.shadow].filter((v) => v !== null)
    .length;
}
