"use client";

import { SendHorizontal } from "lucide-react";
import { useState } from "react";

import { Button } from "@workspace/ui/components/button";
import { Textarea } from "@workspace/ui/components/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/ui/components/tooltip";

/**
 * The composer, disabled and saying why.
 *
 * A box that accepts text and drops it would be worse than no box: it teaches
 * the reader that the feature works. The control is inert, it looks inert, and
 * the tooltip names the reason.
 */
export function Composer({ disabled }: { disabled: boolean }) {
  const [draft, setDraft] = useState("");

  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex items-end gap-2">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={disabled}
          rows={2}
          aria-label="Message the agent"
          placeholder={
            disabled ? "Sending is off until chat has a backend route" : "Ask anything, or hand it work…"
          }
          className="resize-none text-sm"
        />
        {disabled ? (
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Button disabled aria-label="Send">
                <SendHorizontal />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              There is no chat endpoint on the Worker yet. See BACKEND-GAPS.md §2.
            </TooltipContent>
          </Tooltip>
        ) : (
          <Button aria-label="Send">
            <SendHorizontal />
          </Button>
        )}
      </div>
      <p className="text-xs text-pretty text-muted-foreground">
        The agent can act from here. A customer-facing Slack reply still waits for approval on the
        dashboard, and the speaker still gets a nudge.
      </p>
    </div>
  );
}
