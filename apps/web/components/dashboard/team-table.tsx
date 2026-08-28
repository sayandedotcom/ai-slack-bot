"use client";

import { Badge } from "@workspace/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table";
import { cn } from "@workspace/ui/lib/utils";
import { Users2 } from "lucide-react";

import { SpecBadge } from "@/components/common/badge";
import { ConnectState } from "@/components/common/connect-state";
import { Panel } from "@/components/common/panel";
import type { Identity } from "@/lib/api/identity";
import type { ConnectStatus, Provider, Roster } from "@/lib/api/roster";
import { initialOf, nameOf } from "@/lib/format";
import type { PanelState } from "@/lib/panel-state";
import { connectBadge } from "@/lib/status";

/**
 * Everyone with access, and what each of them has connected.
 *
 * A real table, because this is tabular: seven people against three attributes,
 * and a reader scans a column ("who hasn't connected Slack?") more often than a
 * row. Fire-fighters come first — they are the ones whose connect state changes
 * whether the agent can speak at all.
 *
 * The prototype's "agent may act as me" toggle is not here. There is no
 * endpoint behind it; connecting Slack IS the consent, and revoking it in Slack
 * is how it is withdrawn. A switch that wrote nowhere would be a lie about who
 * is in control.
 */
export function TeamTable({
  state,
  identity,
  speaker,
}: {
  state: PanelState<Roster>;
  identity?: Identity;
  speaker: string | null;
}) {
  return (
    <Panel
      title="Team"
      icon={Users2}
      state={state}
      aside={<span className="eyebrow">seven accounts, hardcoded</span>}
    >
      {(roster) => {
        const firefighters = roster.engineers.filter(
          (e) => e.role === "firefighter"
        );
        const viewers = roster.engineers.filter((e) => e.role === "viewer");

        return (
          <div className="-mx-4">
            <Table>
              <caption className="eyebrow pb-2 text-left">
                Tie-break: the approver if they connected Slack, else the first
                connected fire-fighter in roster order.
              </caption>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="eyebrow pl-4">Person</TableHead>
                  <TableHead className="eyebrow">Role</TableHead>
                  <TableHead className="eyebrow">Slack</TableHead>
                  <TableHead className="eyebrow pr-4">GitHub</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {firefighters.map((engineer) => (
                  <PersonRow
                    key={engineer.email}
                    engineer={engineer}
                    speaks={engineer.email === speaker}
                    isSelf={engineer.email === identity?.email}
                  />
                ))}

                {viewers.length > 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={4} className="pt-5 pb-1 pl-4">
                      <span className="eyebrow">
                        Viewers · read-only and chat
                      </span>
                    </TableCell>
                  </TableRow>
                ) : null}

                {viewers.map((engineer) => (
                  <PersonRow
                    key={engineer.email}
                    engineer={engineer}
                    speaks={false}
                    isSelf={engineer.email === identity?.email}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        );
      }}
    </Panel>
  );
}

function PersonRow({
  engineer,
  speaks,
  isSelf,
}: {
  engineer: ConnectStatus;
  speaks: boolean;
  isSelf: boolean;
}) {
  return (
    <TableRow className={cn(isSelf && "bg-accent/30")}>
      <TableCell className="pl-4">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-md font-medium text-[11px]",
              speaks
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground"
            )}
          >
            {initialOf(engineer.email)}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium text-sm">
                {nameOf(engineer.email)}
              </span>
              {isSelf ? <span className="eyebrow">you</span> : null}
            </div>
            <span className="machine truncate text-[11px] text-muted-foreground">
              {engineer.email}
            </span>
            {speaks ? (
              <div className="pt-1">
                <SpecBadge
                  spec={{
                    tone: "attention",
                    label: "speaks by default",
                    meaning:
                      "Direct replies and the nudge DM go out under this account.",
                  }}
                  size="sm"
                />
              </div>
            ) : null}
          </div>
        </div>
      </TableCell>

      <TableCell>
        {speaks ? (
          <Badge>speaks</Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            {engineer.role === "firefighter" ? "fire-fighter" : "viewer"}
          </Badge>
        )}
      </TableCell>

      <TableCell>
        <ProviderCell provider="slack" engineer={engineer} isSelf={isSelf} />
      </TableCell>

      <TableCell className="pr-4">
        <ProviderCell provider="github" engineer={engineer} isSelf={isSelf} />
      </TableCell>
    </TableRow>
  );
}

/**
 * The Slack/GitHub cells: a `SpecBadge` that says the actual state (connected
 * or not — `connectBadge` already carries the right tone for both), plus, on
 * a self row that has not connected yet, the OAuth `<a>` next to it —
 * `ConnectState` already knows how to render exactly that anchor, so it is
 * reused rather than duplicated. A non-self, unconnected row now reads as a
 * fact ("GitHub not connected") instead of a disabled button nobody but that
 * person could ever click.
 */
function ProviderCell({
  provider,
  engineer,
  isSelf,
}: {
  provider: Provider;
  engineer: ConnectStatus;
  isSelf: boolean;
}) {
  if (engineer.role === "viewer") {
    return (
      <ConnectState provider={provider} engineer={engineer} isSelf={isSelf} />
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <SpecBadge spec={connectBadge(engineer[provider], provider)} />
      {isSelf && !engineer[provider] ? (
        <ConnectState provider={provider} engineer={engineer} isSelf={isSelf} />
      ) : null}
    </div>
  );
}
