"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

/**
 * Which run the dashboard has selected, kept in the URL rather than in React
 * state alone. A run is the thing an operator pastes into Slack and reloads
 * into at 3am, so a selection that evaporates on refresh would make it
 * unshareable.
 *
 * The Vite dashboard used `location.hash`; a search param is shareable in the
 * same way, and unlike a hash it survives being handed to a server. Back and
 * forward are the router's problem, not ours.
 */
export function useSelectedRun(): [
  string | null,
  (runId: string | null) => void,
] {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selected = params.get("run");

  const select = useCallback(
    (runId: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (runId === null) next.delete("run");
      else next.set("run", runId);
      const query = next.toString();
      // `scroll: false` — opening the detail sheet must not throw the reader
      // back to the top of a dashboard they had scrolled through.
      router.replace(query.length > 0 ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [params, pathname, router]
  );

  return [selected, select];
}
