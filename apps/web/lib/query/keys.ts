/**
 * Every cache key in the app, in one file. A key typed inline at a call site is
 * a key that silently disagrees with the one another component typed, and two
 * spellings of the same key are two requests and two answers on one screen.
 */
export const queryKeys = {
  identity: ["identity"] as const,
  roster: ["roster"] as const,
  counters: (window: "24h" | "7d") => ["counters", window] as const,
  runsPage: (params: Record<string, unknown>) =>
    ["runs", "page", params] as const,
  run: (id: string) => ["runs", id, "detail"] as const,
  runUsage: (id: string) => ["runs", id, "usage"] as const,
  runApprovals: (id: string) => ["runs", id, "approvals"] as const,
  runEffects: (id: string) => ["runs", id, "effects"] as const,
  openApprovals: ["approvals", "open"] as const,
  approval: (id: string) => ["approvals", id] as const,
  decidedApprovals: (since: number) => ["approvals", "decided", since] as const,
  channels: ["channels"] as const,
  shadow: ["eval", "shadow"] as const,
  triage: (days: number) => ["eval", "triage", days] as const,
};

/**
 * Poll intervals, by how fast the thing underneath actually changes. A run
 * moves in seconds; the roster changes when somebody completes an OAuth
 * handshake, which is a thing that happens once a quarter.
 */
export const POLL_MS = {
  approvals: 3_000,
  runs: 5_000,
  effects: 5_000,
  counters: 10_000,
  shadow: 60_000,
  roster: 60_000,
  channels: 60_000,
} as const;
