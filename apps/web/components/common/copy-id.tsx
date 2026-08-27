"use client";

import { Button } from "@workspace/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";
import { Check, Copy } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";

/**
 * An identifier, and a way to get it into a Slack message. The id itself stays
 * selectable text, so a browser without a clipboard (any insecure origin) costs
 * the reader nothing worth reporting.
 */
export function CopyId({
  value,
  label,
  truncate = false,
  className,
}: {
  value: string;
  /** What is being copied, for the screen reader and the tooltip. */
  label: string;
  truncate?: boolean;
  className?: string;
}): ReactNode {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(value).then(
      () => setCopied(true),
      () => undefined
    );
  }, [value]);

  return (
    <span
      className={cn("inline-flex max-w-full items-center gap-1", className)}
    >
      <code
        className={cn(
          "machine rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground",
          truncate && "truncate"
        )}
      >
        {value}
      </code>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={copy}
              aria-label={copied ? `${label} copied` : `Copy ${label}`}
            />
          }
        >
          {copied ? <Check className="text-success" /> : <Copy />}
        </TooltipTrigger>
        <TooltipContent>{copied ? "Copied" : `Copy ${label}`}</TooltipContent>
      </Tooltip>
    </span>
  );
}
