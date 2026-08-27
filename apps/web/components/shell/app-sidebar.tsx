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
import { Flame, Inbox, type LucideIcon, MessageSquare } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { useApprovals } from "@/lib/hooks/use-approvals";
import { NavUser } from "./nav-user";

type NavEntry = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** What this surface is for, shown as the collapsed-rail tooltip. */
  tooltip: string;
};

/**
 * Two entries, and that is the whole application. Slack is where customers
 * reach the agent; this dashboard is where a human approves what it says, and
 * chat is the same agent through a second door. Anything else would be a page
 * nobody opens during an incident.
 */
const NAV: NavEntry[] = [
  {
    href: "/",
    label: "Dashboard",
    icon: Inbox,
    tooltip: "Who the agent speaks as, and what's waiting on you",
  },
  {
    href: "/chat",
    label: "Chat",
    icon: MessageSquare,
    tooltip: "Ask the same agent Slack wakes, or hand it work",
  },
];

export function AppSidebar() {
  const pathname = usePathname();
  const { openCount } = useApprovals();

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
                const active = pathname === entry.href;
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
                    {entry.href === "/" && openCount > 0 ? (
                      <SidebarMenuBadge className="machine text-primary">
                        {openCount}
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
