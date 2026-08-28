"use client";

import { Button } from "@workspace/ui/components/button";
import { ScrollArea } from "@workspace/ui/components/scroll-area";
import { Plus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Panel } from "@/components/common/panel";
import { useChannels } from "@/lib/hooks/use-channels";
import { useNow } from "@/lib/hooks/use-now";
import { useRunsPage } from "@/lib/hooks/use-runs-page";
import {
  filtersToSearch,
  parseRunFilters,
  type RunFilters,
  toListParams,
} from "@/lib/runs/filters";
import { NewRunDialog } from "./new-run-dialog";
import { RunFilterBar } from "./run-filters";
import { RunRow } from "./run-row";

export function RunList({ selectedId }: { selectedId: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const filters = useMemo(() => parseRunFilters(search), [search]);
  const setFilters = useCallback(
    (next: RunFilters) => {
      const s = filtersToSearch(next).toString();
      router.replace(`${pathname}${s ? `?${s}` : ""}`);
    },
    [router, pathname]
  );

  const now = useNow();
  const { state, fetchNext, hasNext, loadingNext } = useRunsPage(
    toListParams(filters)
  );
  const channels = useChannels();
  const channelOptions =
    channels.state.kind === "ready"
      ? channels.state.data.map((c) => ({
          channelId: c.channelId,
          name: c.name,
        }))
      : [];

  // Every row keeps the current filters in its href, so selection never drops them.
  const hrefFor = (id: string) => {
    const s = filtersToSearch(filters).toString();
    return `/runs/${encodeURIComponent(id)}${s ? `?${s}` : ""}`;
  };

  // j / k move the selection; ignored while typing.
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (state.kind !== "ready") return;
    const ids = state.data.map((r) => r.id);
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      )
        return;
      if (event.key !== "j" && event.key !== "k") return;
      const at = selectedId === null ? -1 : ids.indexOf(selectedId);
      const next =
        event.key === "j"
          ? Math.min(ids.length - 1, at + 1)
          : Math.max(0, at - 1);
      const id = ids[next];
      if (id !== undefined && id !== selectedId) router.push(hrefFor(id));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Infinite scroll: a sentinel row after "Load more" triggers the same fetch
  // an IntersectionObserver would — the button stays as the floor for a
  // browser or a test environment with no observer.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!hasNext) return;
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const [entry] = entries;
      if (entry?.isIntersecting && hasNext && !loadingNext) fetchNext();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNext, loadingNext, fetchNext]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b p-3">
        <h2 className="eyebrow flex-1">Runs</h2>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus /> New run
        </Button>
      </div>
      <div className="border-b p-3">
        <RunFilterBar
          filters={filters}
          onChange={setFilters}
          channels={channelOptions}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <Panel title="Runs" state={state} bare>
          {(runs) => (
            <ul className="space-y-0.5 p-2">
              {runs.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  selected={run.id === selectedId}
                  now={now}
                  href={hrefFor(run.id)}
                />
              ))}
              {hasNext ? (
                <li className="p-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    onClick={fetchNext}
                    disabled={loadingNext}
                  >
                    {loadingNext ? "Loading…" : "Load more"}
                  </Button>
                  <div ref={sentinelRef} aria-hidden="true" />
                </li>
              ) : null}
            </ul>
          )}
        </Panel>
      </ScrollArea>
      <NewRunDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
