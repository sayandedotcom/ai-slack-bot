"use client";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@workspace/ui/components/resizable";
import { useParams } from "next/navigation";
import { Suspense } from "react";

import { RunList } from "@/components/runs/run-list";

/**
 * The workbench. The list is the layout so it survives navigating between
 * runs; the run itself is the page.
 *
 * Below `lg` the two panels stack instead of splitting: the list is `/runs`
 * and a run's detail is `/runs/[id]`, with a back link in the header. Above
 * `lg` both are visible at once, resizable — but see the comment on
 * `ResizablePanelGroup` below: there is no `autoSaveId`, so the split does
 * NOT survive a reload, only navigating between runs while this layout stays
 * mounted.
 */
export default function RunsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams<{ id?: string }>();
  const selectedId = typeof params.id === "string" ? params.id : null;
  return (
    <div className="h-[calc(100svh-3.5rem)]">
      {/*
        `orientation`, not `direction`, and sizes as PERCENT STRINGS, not bare
        numbers — this is `react-resizable-panels` 4.x's own API (`Group` /
        `Panel` / `Separator`, re-exported here under the old shadcn names). A
        bare number is pixels in this version; `defaultSize={26}` would have
        made the list 26px wide. There is also no `autoSaveId`: the split
        persisting between runs comes from this layout staying mounted across
        `/runs/[id]` navigations, not from a storage key this version does not
        have.
      */}
      <ResizablePanelGroup orientation="horizontal" className="h-full">
        <ResizablePanel
          defaultSize="26"
          minSize="18"
          maxSize="40"
          className={selectedId ? "hidden lg:block" : ""}
        >
          <Suspense fallback={null}>
            <RunList selectedId={selectedId} />
          </Suspense>
        </ResizablePanel>
        <ResizableHandle withHandle className="hidden lg:flex" />
        <ResizablePanel className={selectedId ? "" : "hidden lg:block"}>
          {children}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
