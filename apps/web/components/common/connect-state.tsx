"use client";

import { Check, Link2 } from "lucide-react";
import type { ReactNode } from "react";

import { buttonVariants } from "@workspace/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";

import { OAUTH_START, type ConnectStatus, type Provider } from "@/lib/api/roster";

const PROVIDER_LABEL: Record<Provider, string> = { slack: "Slack", github: "GitHub" };

/**
 * Whether one engineer has linked one provider, and — on their own row only —
 * the way to do it.
 *
 * The handshake is started by a plain anchor, never a fetch: the browser
 * already carries the Access cookie, and a top-level navigation is the only
 * thing an OAuth redirect can follow. Someone else's row is deliberately inert;
 * a token minted from your click would be bound to your identity, not theirs.
 */
export function ConnectState({
  provider,
  engineer,
  isSelf,
}: {
  provider: Provider;
  engineer: ConnectStatus;
  isSelf: boolean;
}): ReactNode {
  // Viewers never act on an incident, so there is nothing for them to connect.
  if (engineer.role === "viewer") {
    return <span className="text-muted-foreground">—</span>;
  }

  if (engineer[provider]) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-success">
        <Check className="size-3" aria-hidden="true" />
        connected
      </span>
    );
  }

  const classes = buttonVariants({ variant: isSelf ? "default" : "outline", size: "xs" });

  if (!isSelf) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={cn(classes, "cursor-not-allowed opacity-50")}
              aria-disabled="true"
              role="button"
            />
          }
        >
          <Link2 data-icon="inline-start" />
          Connect
        </TooltipTrigger>
        <TooltipContent>Each engineer connects their own account.</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <a className={classes} href={OAUTH_START[provider]}>
      <Link2 data-icon="inline-start" />
      Connect {PROVIDER_LABEL[provider]}
    </a>
  );
}
