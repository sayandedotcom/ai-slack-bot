"use client";

import { Button } from "@workspace/ui/components/button";
import { Separator } from "@workspace/ui/components/separator";
import { SidebarTrigger } from "@workspace/ui/components/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import { FlaskConical, Search } from "lucide-react";
import { usePathname } from "next/navigation";

import { isDemo } from "@/lib/api/client";
import { useApprovals } from "@/lib/hooks/use-approvals";

const TITLE: Record<string, string> = {
  "/": "Overview",
  "/runs": "Runs",
  "/approvals": "Approvals",
  "/team": "Team",
  "/channels": "Channels",
  "/eval": "Eval",
};

/** `/runs/<uuid>` is one title, not one per run. */
function titleFor(pathname: string): string {
  if (pathname.startsWith("/runs/")) return "Runs";
  return TITLE[pathname] ?? "Fire-Fighter";
}

export function SiteHeader({ onOpenPalette }: { onOpenPalette: () => void }) {
  const pathname = usePathname();
  const { openCount } = useApprovals();

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur-sm">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 h-4" />
      <span className="font-medium text-sm">{titleFor(pathname)}</span>

      <div className="ml-auto flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={onOpenPalette}>
          <Search />
          <kbd className="machine">⌘K</kbd>
        </Button>

        {/*
          The count is here rather than only on the dashboard because it is the
          one fact that should reach you from any page: someone is waiting.
          `aria-live` so a screen reader hears it arrive during an incident
          instead of on the next manual sweep of the page.
        */}
        {/* The words are the first thing to go when the bar is narrow: the
            pulsing count already carries the signal, and a two-line header is
            worse than a terse one. */}
        <span
          aria-live="polite"
          className="whitespace-nowrap text-muted-foreground text-xs"
        >
          {openCount > 0 ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="relative flex size-1.5" aria-hidden="true">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-attention opacity-70" />
                <span className="relative inline-flex size-1.5 rounded-full bg-attention" />
              </span>
              <span className="machine text-attention">{openCount}</span>
              <span className="hidden sm:inline">waiting on you</span>
              <span className="sr-only sm:hidden">waiting on you</span>
            </span>
          ) : (
            <span className="hidden sm:inline">nothing waiting on you</span>
          )}
        </span>

        {isDemo() ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="eyebrow flex cursor-default items-center gap-1.5 whitespace-nowrap rounded-full border border-dashed px-2 py-1" />
              }
            >
              <FlaskConical className="size-3" aria-hidden="true" />
              <span className="hidden sm:inline">Demo data</span>
              <span className="sr-only sm:hidden">Demo data</span>
            </TooltipTrigger>
            <TooltipContent>
              Nothing on this page reached the network. Every number, run and
              draft is a fixture.
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </header>
  );
}
