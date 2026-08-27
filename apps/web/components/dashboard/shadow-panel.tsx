"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import { ExternalLink, FlaskConical } from "lucide-react";

import { Panel } from "@/components/common/panel";
import { type AiTell, type ShadowPair, TELL_MEANING } from "@/lib/api/shadow";
import { ago, shortThread } from "@/lib/format";
import { useShadowPairs } from "@/lib/hooks/use-dashboard-data";
import { useNow } from "@/lib/hooks/use-now";

/**
 * What the agent would have said, beside what a person actually said.
 *
 * Below the fold on purpose: this is a corpus for reviewing after the fact, not
 * something waiting on a human the way the approvals queue is. The two columns
 * sit side by side because the whole value is the comparison — a draft alone
 * says nothing about whether it sounds like the team.
 */
export function ShadowPanel() {
  const state = useShadowPairs();
  const now = useNow();

  return (
    <Panel
      title="Shadow eval"
      icon={FlaskConical}
      state={state}
      description="Drafts the agent produced without sending, next to the reply a fire-fighter wrote instead."
    >
      {(pairs) => (
        <ul className="space-y-4">
          {pairs.map((pair) => (
            <Pair key={pair.approvalId} pair={pair} now={now} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Pair({ pair, now }: { pair: ShadowPair; now: number }) {
  return (
    <li className="space-y-2 border-t pt-4 first:border-t-0 first:pt-0">
      <div className="machine flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="rounded border border-border bg-muted px-1.5 py-0.5">
          #{pair.channelId}
        </span>
        <span>thread {shortThread(pair.threadTs)}</span>
        <span className="ml-auto">{ago(pair.createdAt, now)}</span>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <p className="eyebrow">Agent draft</p>
          <p className="whitespace-pre-wrap rounded-md border border-shadow-run/30 bg-shadow-run/5 px-3 py-2 text-sm">
            {pair.draft}
          </p>
          {pair.tells.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {pair.tells.map((tell) => (
                <TellBadge key={tell} tell={tell} />
              ))}
            </div>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <p className="eyebrow">What a human sent</p>
          {pair.humanReply === null ? (
            <p className="rounded-md border border-dashed px-3 py-2 text-muted-foreground text-sm">
              Nobody replied in the thread, so there is nothing to compare
              against.
            </p>
          ) : (
            <>
              <p className="whitespace-pre-wrap rounded-md border bg-muted/40 px-3 py-2 text-sm">
                {pair.humanReply.text}
              </p>
              {pair.humanReply.permalink ? (
                <a
                  href={pair.humanReply.permalink}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-muted-foreground text-xs underline-offset-4 hover:text-foreground hover:underline"
                >
                  Open thread
                  <ExternalLink className="size-3" aria-hidden="true" />
                </a>
              ) : null}
            </>
          )}
        </div>
      </div>
    </li>
  );
}

/** A detected tell, with what it means — the label alone is jargon. */
function TellBadge({ tell }: { tell: AiTell }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="machine cursor-default rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning" />
        }
      >
        {tell.replace(/_/g, " ")}
      </TooltipTrigger>
      <TooltipContent>{TELL_MEANING[tell]}</TooltipContent>
    </Tooltip>
  );
}
