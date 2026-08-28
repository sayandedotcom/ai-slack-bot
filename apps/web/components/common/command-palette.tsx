"use client";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@workspace/ui/components/command";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useApprovals } from "@/lib/hooks/use-approvals";
import { useRunsPage } from "@/lib/hooks/use-runs-page";
import { type PaletteItem, paletteItems } from "@/lib/palette";

const GROUPS: readonly PaletteItem["group"][] = ["Pages", "Runs", "Approvals"];

/**
 * ⌘K, from anywhere in the shell. Sources its `Runs` and `Approvals` rows
 * from caches this app is already polling — `useRunsPage`'s first page and
 * `useApprovals`'s open cards — rather than a query of its own, so opening
 * the palette costs nothing extra against the Worker.
 *
 * Mounted once, in `AppShell`, alongside the header button that opens it —
 * both need one shared `open` boolean, and lifting it to the shell is
 * simpler than a store for a value nothing else reads.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { state: runsState } = useRunsPage({});
  const { state: approvalsState } = useApprovals();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  const runs = runsState.kind === "ready" ? runsState.data : [];
  const approvals =
    approvalsState.kind === "ready"
      ? approvalsState.data
          .filter((card) => card.kind === "open")
          .map((card) => ({
            id: card.card.id,
            runId: card.card.runId,
            draft: card.card.draft,
          }))
      : [];

  const items = paletteItems({ runs, approvals });

  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      {/*
        The `Command` root is REQUIRED here and is not supplied by
        `CommandDialog`. This registry's `CommandDialog` renders only
        `Dialog > DialogContent > {children}` — unlike upstream shadcn's, which
        wraps the children itself — so without this every `cmdk` child reads an
        undefined context and `CommandPrimitive.Input` dies on `.subscribe` the
        moment the palette opens. Fixed here rather than in the vendored
        primitive so a future `shadcn add command` cannot silently revert it.
      */}
      <Command>
        <CommandInput placeholder="Jump to a page, run or approval…" />
        <CommandList>
          <CommandEmpty>No matches.</CommandEmpty>
          {GROUPS.map((group) => {
            const groupItems = items.filter((item) => item.group === group);
            if (groupItems.length === 0) return null;
            return (
              <CommandGroup key={group} heading={group}>
                {groupItems.map((item) => (
                  <CommandItem
                    key={`${item.group}:${item.href}`}
                    value={[item.label, ...item.keywords].join(" ")}
                    onSelect={() => go(item.href)}
                  >
                    {item.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            );
          })}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
