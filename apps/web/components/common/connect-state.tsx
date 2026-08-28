"use client";

import { buttonVariants } from "@workspace/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";
import { Link2 } from "lucide-react";
import type { ReactNode } from "react";

import { SpecBadge } from "@/components/common/badge";
import {
  type ConnectStatus,
  OAUTH_START,
  type Provider,
} from "@/lib/api/roster";
import { connectBadge } from "@/lib/status";

const PROVIDER_LABEL: Record<Provider, string> = {
  slack: "Slack",
  github: "GitHub",
};

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
    return <SpecBadge spec={connectBadge(true, provider)} />;
  }

  const classes = buttonVariants({
    variant: isSelf ? "default" : "outline",
    size: "xs",
  });

  if (!isSelf) {
    return (
      // A REAL disabled button inside a plain-span trigger, rather than a span
      // wearing `role="button"`. A disabled button emits no pointer events, so
      // it cannot be the tooltip's own trigger — the span is, which is the same
      // shape the approval card uses for its disabled Send.
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <button
            type="button"
            disabled
            className={cn(classes, "cursor-not-allowed")}
          >
            <Link2 data-icon="inline-start" />
            Connect
          </button>
        </TooltipTrigger>
        <TooltipContent>
          Each engineer connects their own account.
        </TooltipContent>
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
