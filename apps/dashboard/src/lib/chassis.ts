/**
 * Which run chassis this deployment is running, asked once per page load.
 *
 * Phase 25 runs two session implementations side by side (spec D1): the legacy
 * `RunDO` + `/ws` socket, and `RunAgent extends Think` behind the Agents SDK's
 * own `/agents/*` transport. The SPA ships BOTH views and picks at runtime,
 * because `RUN_CHASSIS` is a wrangler `var` — baking it into the bundle would
 * mean a chassis flip needs a dashboard rebuild rather than a deploy.
 *
 * One fetch, no poll: a chassis does not change under a live page, and a poll
 * that flipped the transcript component out from under an operator mid-incident
 * would be strictly worse than a reload.
 */

import { useEffect, useState } from "react";

import { getJson } from "./api";

export type Chassis = "think" | "legacy";

export type ChassisState =
  | { kind: "loading" }
  /** `degraded` means we never got an answer and fell back — say so on screen. */
  | { kind: "ready"; chassis: Chassis; degraded: boolean };

function isChassis(value: unknown): value is Chassis {
  return value === "think" || value === "legacy";
}

export async function fetchChassis(): Promise<Chassis> {
  const body = await getJson<{ chassis: unknown }>("/api/chassis");
  // An unrecognised value is NOT coerced. The worker refuses to resolve one and
  // so does this: guessing would render a run on the session implementation the
  // operator did not deploy, which is the exact silent-wrong-answer the whole
  // migration is trying not to ship.
  if (!isChassis(body.chassis)) throw new Error("unrecognised chassis");
  return body.chassis;
}

export function useChassis(): ChassisState {
  const [state, setState] = useState<ChassisState>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    fetchChassis().then(
      (chassis) => {
        if (alive) setState({ kind: "ready", chassis, degraded: false });
      },
      () => {
        // Legacy is the safe fallback in both directions: it is what a Worker
        // with no `RUN_CHASSIS` resolves to, and it is the view that has been
        // shipping. An unreachable probe must not blank the dashboard.
        if (alive) setState({ kind: "ready", chassis: "legacy", degraded: true });
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  return state;
}
