"use client";

import {
  StatusBadge,
  type StatusBadgeProps,
} from "@workspace/ui/components/status-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";

import type { BadgeSpec } from "@/lib/status";

export function SpecBadge({
  spec,
  ...rest
}: { spec: BadgeSpec } & Omit<
  StatusBadgeProps,
  "tone" | "pulse" | "children"
>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <StatusBadge
            tone={spec.tone}
            pulse={spec.pulse}
            mono
            {...rest}
            className={`cursor-default ${rest.className ?? ""}`}
          />
        }
      >
        {spec.label}
      </TooltipTrigger>
      <TooltipContent>{spec.meaning}</TooltipContent>
    </Tooltip>
  );
}
