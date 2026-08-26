"use client";

import { Bot, Brain, Eye, Zap } from "lucide-react";

import { Card, CardContent } from "@workspace/ui/components/card";
import { cn } from "@workspace/ui/lib/utils";

/**
 * Why this page exists, which is not obvious: from the outside it looks like a
 * second bot. The four lines below are the four things that are actually true
 * about it, and each one is a claim someone could check.
 */
const CLAIMS = [
  {
    icon: Bot,
    title: "One agent, two doors",
    body: "The same model, prompt and capabilities that answer Slack. Not a second bot with its own memory.",
  },
  {
    icon: Brain,
    title: "Org-scoped memory",
    body: "Every message ever ingested is queryable, and every answer cites the thread it came from.",
  },
  {
    icon: Zap,
    title: "Hand it work directly",
    body: "File the issue, draft the PR, run the fix. No customer has to ask first.",
  },
  {
    icon: Eye,
    title: "Viewers welcome",
    body: "Marcus, Nils and Eric aren't engineers. This page is their whole interface.",
  },
];

export function ChatAside({
  suggestions,
  disabled,
}: {
  suggestions: string[];
  disabled: boolean;
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4">
          <h2 className="eyebrow">What this door proves</h2>
          <ul className="space-y-3.5">
            {CLAIMS.map((claim) => (
              <li key={claim.title} className="flex items-start gap-2.5">
                <claim.icon
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{claim.title}</p>
                  <p className="text-xs text-pretty text-muted-foreground">{claim.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <h2 className="eyebrow">Try asking</h2>
          <ul className="space-y-1.5">
            {suggestions.map((suggestion) => (
              <li key={suggestion}>
                <button
                  type="button"
                  disabled={disabled}
                  className={cn(
                    "w-full rounded-md border border-border/60 px-3 py-2 text-left text-sm text-muted-foreground transition-colors",
                    disabled
                      ? "cursor-not-allowed opacity-60"
                      : "hover:border-border hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  {suggestion}
                </button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
