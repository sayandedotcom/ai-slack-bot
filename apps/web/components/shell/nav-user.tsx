"use client";

import { ChevronsUpDown, Monitor, Moon, ShieldCheck, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@workspace/ui/components/sidebar";
import { Skeleton } from "@workspace/ui/components/skeleton";

import { initialOf, nameOf } from "@/lib/format";
import { useIdentityQuery } from "@/lib/hooks/use-dashboard-data";

const ROLE_MEANING = {
  firefighter: "You can decide approvals and connect your own Slack and GitHub.",
  viewer: "You can read everything and use chat. Fire-fighters decide approvals.",
} as const;

/**
 * The signed-in account, and the only two preferences this app has.
 *
 * There is no sign-out: Access owns the session at the origin, so a button here
 * could only pretend. What the menu does carry is the role, spelled out — the
 * difference between a fire-fighter and a viewer is the difference between
 * seeing the queue and being able to act on it.
 */
export function NavUser() {
  const { isMobile } = useSidebar();
  const { identity } = useIdentityQuery();
  const { theme, setTheme } = useTheme();

  if (!identity) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <div className="flex items-center gap-2 p-2">
            <Skeleton className="size-8 shrink-0 rounded-lg" />
            <Skeleton className="h-4 w-24 group-data-[collapsible=icon]:hidden" />
          </div>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  const isFirefighter = identity.role === "firefighter";

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton size="lg" tooltip={`${identity.email} · ${identity.role}`} />
            }
          >
            <span className="flex aspect-square size-8 items-center justify-center rounded-lg bg-muted text-xs font-medium">
              {initialOf(identity.email)}
            </span>
            <span className="grid flex-1 text-left leading-tight">
              <span className="truncate text-sm font-medium">{nameOf(identity.email)}</span>
              <span className="eyebrow truncate">{identity.role}</span>
            </span>
            <ChevronsUpDown className="ml-auto size-4" />
          </DropdownMenuTrigger>

          <DropdownMenuContent
            className="w-64"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={8}
          >
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col gap-1">
                <span className="machine truncate text-xs text-muted-foreground">
                  {identity.email}
                </span>
                <span className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <ShieldCheck
                    className={`mt-px size-3.5 shrink-0 ${isFirefighter ? "text-success" : ""}`}
                    aria-hidden="true"
                  />
                  {ROLE_MEANING[identity.role]}
                </span>
              </div>
            </DropdownMenuLabel>

            <DropdownMenuSeparator />

            <DropdownMenuLabel className="eyebrow">Appearance</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
              <DropdownMenuRadioItem value="dark">
                <Moon />
                Dark
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light">
                <Sun />
                Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <Monitor />
                Match system
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>

            <DropdownMenuSeparator />

            {/* Not a button: Access holds the session for the whole origin, so
                nothing in this bundle can end it. Saying so beats a control
                that would have to lie. */}
            <DropdownMenuItem disabled className="text-xs">
              Signed in through Cloudflare Access
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
