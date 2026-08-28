"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { SpecBadge } from "@/components/common/badge";
import { Panel } from "@/components/common/panel";
import { ago, nameOf } from "@/lib/format";
import { useDecidedApprovals } from "@/lib/hooks/use-dashboard-data";
import { useNow } from "@/lib/hooks/use-now";
import { decisionBadge } from "@/lib/status";

const DAY = 86_400_000;

/**
 * What was decided in the last 24 hours — collapsed by default, since it is
 * a record rather than something waiting on anyone. Also the honest
 * replacement for the reconcile machinery this page used to carry: a card
 * that another person decided simply leaves the open queue on the next poll
 * and appears here instead, from a real read rather than an inference.
 */
function roundedSince(): number {
  // Rounded to the minute so the key (and the request) is not new on every render.
  return Math.floor((Date.now() - DAY) / 60_000) * 60_000;
}

export function DecidedList() {
  const [open, setOpen] = useState(false);
  const now = useNow();
  // Frozen at the moment the panel opens, not recomputed on every render: a
  // `since` that advances with the minute would mint a fresh query key every
  // 60s while the panel is open, and the panel would flash back to its
  // loading skeleton under the reader's eyes.
  const [since, setSince] = useState(roundedSince);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) setSince(roundedSince());
  }

  // Polling `/api/approvals?state=decided` only while the section is open —
  // a collapsed section has no reader to show a poll's result to.
  const state = useDecidedApprovals(since, { enabled: open });

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange}>
      <CollapsibleTrigger className="flex items-center gap-2 text-sm">
        <ChevronRight
          className={
            open
              ? "size-4 rotate-90 transition-transform"
              : "size-4 transition-transform"
          }
        />
        <span className="eyebrow">Decided in the last 24h</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3">
        <Panel title="Decided" state={state} bare>
          {(rows) => (
            <ul className="divide-y rounded-lg border">
              {rows.map((a) => (
                <li
                  key={a.id}
                  className="grid grid-cols-[auto_1fr_auto] items-start gap-3 p-3 text-sm"
                >
                  <SpecBadge spec={decisionBadge(a.decision)} />
                  <div className="min-w-0">
                    <p className="line-clamp-2 text-pretty">
                      {a.editedText ?? a.draft}
                    </p>
                    {a.rejectReason ? (
                      <p className="mt-1 text-muted-foreground text-xs">
                        {a.rejectReason}
                      </p>
                    ) : null}
                    <Link
                      href={`/runs/${encodeURIComponent(a.runId)}`}
                      className="machine mt-1 inline-block text-[11px] text-muted-foreground underline-offset-4 hover:underline"
                    >
                      open run
                    </Link>
                  </div>
                  <div className="machine text-right text-[11px] text-muted-foreground">
                    <div>{a.decidedBy ? nameOf(a.decidedBy) : "—"}</div>
                    <div>{ago(a.decidedAt ?? a.updatedAt, now)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </CollapsibleContent>
    </Collapsible>
  );
}
