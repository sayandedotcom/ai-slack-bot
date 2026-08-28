"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { useRunsPage } from "@/lib/hooks/use-runs-page";
import { parseRunFilters, toListParams } from "@/lib/runs/filters";

/**
 * `/runs` with nothing selected auto-navigates to the newest run once the
 * first page loads, preserving whatever filters are already in the URL. Below
 * `lg`, where the list and detail panels stack instead of splitting, this is
 * what a reader sees only for the instant before that redirect lands.
 */
export default function RunsIndexPage() {
  const router = useRouter();
  const search = useSearchParams();
  const { state } = useRunsPage(toListParams(parseRunFilters(search)));

  useEffect(() => {
    if (state.kind !== "ready") return;
    const first = state.data[0];
    if (first)
      router.replace(
        `/runs/${encodeURIComponent(first.id)}${search.size ? `?${search}` : ""}`
      );
  }, [state, router, search]);

  return (
    <div className="hidden h-full items-center justify-center p-6 text-muted-foreground text-sm lg:flex">
      {state.kind === "empty" ? "No runs match these filters." : "Pick a run."}
    </div>
  );
}
