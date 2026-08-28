"use client";

import { Card, CardContent } from "@workspace/ui/components/card";
import { Bot, Brain, Eye, Zap } from "lucide-react";

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

/**
 * Openings worth typing, kept here rather than in `lib/fixtures` because they
 * are copy, not data: they are the same four whether the app is on fixtures or
 * on a live Worker.
 */
const SUGGESTIONS: string[] = [
  "what shipped for customers this week?",
  "which customer is angriest right now and why?",
  "ship the copy-funnel-ID button Priya asked for",
  "summarise Driftwear's big ask for Monday's standup",
];

export function ChatAside({ onPick }: { onPick: (text: string) => void }) {
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
                  <p className="font-medium text-sm">{claim.title}</p>
                  <p className="text-pretty text-muted-foreground text-xs">
                    {claim.body}
                  </p>
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
            {SUGGESTIONS.map((suggestion) => (
              <li key={suggestion}>
                {/* Fills the composer rather than sending: an opening is worth
                    editing before it becomes a run, and a one-click send from a
                    sidebar is how somebody starts a run they did not mean to. */}
                <button
                  type="button"
                  onClick={() => onPick(suggestion)}
                  className="w-full rounded-md border border-border/60 px-3 py-2 text-left text-muted-foreground text-sm transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground"
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
