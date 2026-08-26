"use client";

import { ExternalLink, Flame, Quote } from "lucide-react";

import { cn } from "@workspace/ui/lib/utils";

import { initialOf } from "@/lib/format";
import type { ChatMessage, Citation, ToolCall } from "@/lib/api/chat";

/**
 * The conversation. Both sides are set in sans — this is people talking, and
 * the agent's half of it is meant to read as writing rather than as output.
 * The MACHINE parts of a turn are the parts that are genuinely mechanical: the
 * citations back to Slack threads, and the capability calls it made.
 */
export function Transcript({ messages }: { messages: ChatMessage[] }) {
  return (
    <ol className="space-y-6">
      {messages.map((message) => (
        <li key={message.id}>
          <Message message={message} />
        </li>
      ))}
    </ol>
  );
}

function Message({ message }: { message: ChatMessage }) {
  const isAgent = message.author === "agent";

  return (
    <div className="flex gap-3">
      <span
        aria-hidden="true"
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-medium",
          isAgent ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
        )}
      >
        {isAgent ? <Flame className="size-3.5" /> : initialOf(message.name)}
      </span>

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium">{message.name}</span>
          {message.role === "viewer" ? (
            <span className="eyebrow rounded border px-1 py-px">viewer</span>
          ) : null}
          <span className="machine text-[11px] text-muted-foreground">{message.at}</span>
        </div>

        {/* Tool calls come BEFORE the prose, because that is the order they
            happened in: the agent acted, then reported. */}
        {message.toolCalls?.length ? (
          <div className="flex flex-wrap gap-1.5">
            {message.toolCalls.map((call) => (
              <ToolChip key={call.name} call={call} />
            ))}
          </div>
        ) : null}

        <p
          className={cn(
            "text-sm text-pretty",
            !isAgent && "rounded-lg rounded-tl-sm bg-muted/60 px-3 py-2",
          )}
        >
          {message.text}
        </p>

        {message.citations?.length ? (
          <div className="space-y-1.5 pt-0.5">
            {message.citations.map((citation) => (
              <CitationCard key={`${citation.channelName}-${citation.day}`} citation={citation} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A claim about the past, with the thread it came from. Memory is recall, not
 * record — an answer about what happened in July is only worth anything if you
 * can open the thread and check it.
 */
function CitationCard({ citation }: { citation: Citation }) {
  return (
    <div className="flex items-start gap-2.5 rounded-md border-l-2 border-l-primary/50 bg-muted/40 px-3 py-2">
      <Quote className="mt-0.5 size-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="machine text-[11px] text-muted-foreground">
          #{citation.channelName} · {citation.day}
        </p>
        <p className="truncate text-xs">“{citation.quote}”</p>
        <p className="text-[11px] text-muted-foreground">{citation.outcome}</p>
      </div>
      {citation.permalink ? (
        <a
          href={citation.permalink}
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Open
          <ExternalLink className="size-3" aria-hidden="true" />
        </a>
      ) : null}
    </div>
  );
}

function ToolChip({ call }: { call: ToolCall }) {
  return (
    <span className="machine inline-flex items-center gap-1.5 rounded border border-border bg-muted px-1.5 py-0.5 text-[11px]">
      <span className="text-muted-foreground">{call.name}</span>
      <span className="text-muted-foreground/50">→</span>
      <span>{call.detail}</span>
    </span>
  );
}
