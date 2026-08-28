"use client";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@workspace/ui/components/sidebar";
import {
  Activity,
  Flame,
  FlaskConical,
  Hash,
  Inbox,
  LayoutDashboard,
  type LucideIcon,
  MessageSquare,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { useApprovals } from "@/lib/hooks/use-approvals";
import { useRunsPage } from "@/lib/hooks/use-runs-page";
import { NavUser } from "./nav-user";

type NavEntry = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** What this surface is for, shown as the collapsed-rail tooltip. */
  tooltip: string;
};

/**
 * Six entries, one per job: what needs a human right now, the run history,
 * the decision queue, who the agent speaks as, which channels it listens to,
 * and how well triage and the drafts are doing.
 */
const NAV: NavEntry[] = [
  {
    href: "/",
    label: "Overview",
    icon: LayoutDashboard,
    tooltip: "What needs you right now",
  },
  {
    href: "/chat",
    label: "Chat",
    icon: MessageSquare,
    tooltip: "Ask the same agent Slack wakes, or hand it work",
  },
  {
    href: "/runs",
    label: "Runs",
    icon: Activity,
    tooltip: "Every run, with its transcript",
  },
  {
    href: "/approvals",
    label: "Approvals",
    icon: Inbox,
    tooltip: "Decide what the agent may send",
  },
  {
    href: "/team",
    label: "Team",
    icon: Users,
    tooltip: "Who the agent speaks as",
  },
  {
    href: "/channels",
    label: "Channels",
    icon: Hash,
    tooltip: "Which channels it listens to, and how",
  },
  {
    href: "/eval",
    label: "Eval",
    icon: FlaskConical,
    tooltip: "How well triage and the drafts are doing",
  },
];

export function AppSidebar() {
  const pathname = usePathname();
  const { openCount } = useApprovals();
  // Shares the cache with the Runs page's own unfiltered list — no second
  // query for a badge.
  const { state: runsState } = useRunsPage({});
  const activeRunCount =
    runsState.kind === "ready"
      ? runsState.data.filter(
          (r) => r.status === "live" || r.status === "awaiting_approval"
        ).length
      : 0;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              render={<Link href="/" />}
              tooltip="Fire-Fighter · Zellify internal"
            >
              <span className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <Flame className="size-4" />
              </span>
              <span className="grid flex-1 text-left leading-tight">
                <span className="truncate font-semibold text-sm tracking-tight">
                  Fire-Fighter
                </span>
                <span className="eyebrow truncate">Zellify internal</span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map((entry) => {
                const active =
                  pathname === entry.href ||
                  (entry.href !== "/" && pathname.startsWith(entry.href));
                return (
                  <SidebarMenuItem key={entry.href}>
                    <SidebarMenuButton
                      isActive={active}
                      tooltip={entry.tooltip}
                      render={<Link href={entry.href} />}
                    >
                      <entry.icon />
                      <span>{entry.label}</span>
                    </SidebarMenuButton>
                    {/* The badge counts what is still waiting, so the rail says
                        "someone needs you" even when this page is not open. */}
                    {entry.href === "/approvals" && openCount > 0 ? (
                      <SidebarMenuBadge className="machine text-attention">
                        {openCount}
                      </SidebarMenuBadge>
                    ) : null}
                    {entry.href === "/runs" && activeRunCount > 0 ? (
                      <SidebarMenuBadge className="machine">
                        {activeRunCount}
                      </SidebarMenuBadge>
                    ) : null}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
