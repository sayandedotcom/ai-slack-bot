"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";
import { Users } from "lucide-react";

import { Panel } from "@/components/common/panel";
import type { Roster } from "@/lib/api/roster";
import { initialOf, nameOf } from "@/lib/format";
import type { PanelState } from "@/lib/panel-state";

/**
 * The eligible pool, in the order that decides who speaks.
 *
 * This is what replaces the rotation schedule the old prototype drew: there is
 * no schedule to draw. Order is roster order, and the first connected account
 * wins — so showing the list in that order, with connect state on each row, IS
 * the selection rule rather than a description of it.
 */
export function RosterCard({ state }: { state: PanelState<Roster> }) {
  return (
    <Panel
      title="Eligible pool"
      icon={Users}
      state={state}
      aside={
        <Tooltip>
          <TooltipTrigger render={<span className="eyebrow cursor-help" />}>
            tie-break order
          </TooltipTrigger>
          <TooltipContent>
            The agent speaks as the first account in this order that has
            connected Slack. No shift, no rotation — connecting or disconnecting
            is the only thing that changes it.
          </TooltipContent>
        </Tooltip>
      }
    >
      {({ pool, engineers, speaker }) => {
        const byEmail = new Map(
          engineers.map((engineer) => [engineer.email, engineer])
        );

        return (
          <ol className="space-y-0.5">
            {pool.map((email, index) => {
              const engineer = byEmail.get(email);
              const connected = engineer?.slack ?? false;
              const speaks = email === speaker?.email;

              return (
                <li
                  key={email}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-1.5 py-1.5",
                    speaks && "bg-primary/8"
                  )}
                >
                  <span className="machine w-4 shrink-0 text-[11px] text-muted-foreground/70">
                    {index + 1}
                  </span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-md font-medium text-[11px]",
                      speaks
                        ? "bg-primary text-primary-foreground"
                        : connected
                          ? "bg-muted text-foreground"
                          : "bg-muted text-muted-foreground/60"
                    )}
                  >
                    {initialOf(email)}
                  </span>
                  <span
                    className={cn(
                      "truncate text-sm",
                      !connected && "text-muted-foreground"
                    )}
                  >
                    {nameOf(email)}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px]">
                    {speaks ? (
                      <span className="text-primary">speaks</span>
                    ) : connected ? (
                      <span className="text-muted-foreground">connected</span>
                    ) : (
                      <span className="text-warning">not connected</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        );
      }}
    </Panel>
  );
}
