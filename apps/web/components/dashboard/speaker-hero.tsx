"use client";

import { Card, CardContent } from "@workspace/ui/components/card";
import { Skeleton } from "@workspace/ui/components/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";
import {
  AlertTriangle,
  GitPullRequest,
  MessageCircle,
  TriangleAlert,
} from "lucide-react";

import type { Roster } from "@/lib/api/roster";
import { initialOf, nameOf } from "@/lib/format";
import type { PanelState } from "@/lib/panel-state";

/**
 * Whose name goes on what the agent says in public.
 *
 * There is NO shift and no countdown — rotation was removed on 2026-08-17.
 * Every fire-fighter who has connected Slack is eligible, and this card shows
 * the one who speaks by default: a direct reply, and the nudge DM. An approved
 * reply goes out as whoever clicked approve instead, when they have connected;
 * that is a property of the click, so it is not shown here.
 *
 * The card is the only place on the page that carries the ember edge, because
 * it answers the question a stranger asks first: whose voice is this?
 */
export function SpeakerHero({ state }: { state: PanelState<Roster> }) {
  if (state.kind !== "ready") {
    return (
      <Card className="justify-center">
        <CardContent className="space-y-2">
          {state.kind === "error" ? (
            <p className="text-muted-foreground text-sm" role="alert">
              Can&apos;t tell who the agent speaks as right now.
            </p>
          ) : (
            <>
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-4 w-64" />
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  const { speaker, githubSpeaker, engineers } = state.data;

  /**
   * Nobody connected is not an empty state — it is an outage with a cause and
   * a fix, and it is the single most consequential thing this page can say.
   */
  if (speaker === null) {
    return (
      <Card className="border-destructive/50 bg-destructive/5">
        <CardContent className="flex items-start gap-3">
          <TriangleAlert
            className="mt-0.5 size-5 shrink-0 text-destructive"
            aria-hidden="true"
          />
          <div className="space-y-1">
            <p className="font-medium">Nobody can speak</p>
            <p className="text-pretty text-muted-foreground text-sm">
              No fire-fighter has connected Slack, so every customer-facing
              reply is refused. Connect an account in the team table below to
              unblock it.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const self = engineers.find((engineer) => engineer.email === speaker.email);
  const prAuthorDiffers =
    githubSpeaker !== null && githubSpeaker.email !== speaker.email;

  return (
    <Card className="relative overflow-hidden border-l-2 border-l-primary">
      <CardContent className="flex items-start gap-4">
        <span
          aria-hidden="true"
          className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary font-semibold text-lg text-primary-foreground"
        >
          {initialOf(speaker.email)}
        </span>

        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold text-lg tracking-tight">
              {nameOf(speaker.email)}
            </span>
            <span className="text-muted-foreground text-sm">
              speaks by default
            </span>
          </div>

          <p className="text-pretty text-muted-foreground text-sm">
            Direct replies and the nudge DM go out under this account. An
            approved reply goes out as whoever approved it, when they&apos;ve
            connected.
          </p>

          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <ConnectChip
              label="Slack"
              connected={self?.slack ?? false}
              icon={MessageCircle}
            />
            <ConnectChip
              label="GitHub"
              connected={self?.github ?? false}
              icon={GitPullRequest}
            />

            {prAuthorDiffers ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="inline-flex cursor-default items-center gap-1.5 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground" />
                  }
                >
                  <GitPullRequest className="size-3" aria-hidden="true" />
                  PRs open as {nameOf(githubSpeaker.email)}
                </TooltipTrigger>
                <TooltipContent>
                  Slack and GitHub are picked separately — each is the first
                  fire-fighter in roster order who has connected that provider.
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ConnectChip({
  label,
  connected,
  icon: Icon,
}: {
  label: string;
  connected: boolean;
  icon: typeof MessageCircle;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]",
        connected
          ? "border-success/40 bg-success/10 text-success"
          : "border-warning/40 bg-warning/10 text-warning"
      )}
    >
      {connected ? (
        <Icon className="size-3" aria-hidden="true" />
      ) : (
        <AlertTriangle className="size-3" aria-hidden="true" />
      )}
      {label} {connected ? "connected" : "not connected"}
    </span>
  );
}
