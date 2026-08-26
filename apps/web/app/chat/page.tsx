"use client";

import { useQuery } from "@tanstack/react-query";
import { PlugZap } from "lucide-react";

import { Card, CardContent } from "@workspace/ui/components/card";
import { Skeleton } from "@workspace/ui/components/skeleton";

import { ChatAside } from "@/components/chat/chat-aside";
import { Composer } from "@/components/chat/composer";
import { Transcript } from "@/components/chat/transcript";
import { ErrorBoundary } from "@/components/common/error-boundary";
import { PageHeader } from "@/components/shell/page-header";
import { chatIsDemoOnly, getChatThread } from "@/lib/api/chat";
import { queryKeys } from "@/lib/query/keys";

/**
 * The second door: Slack wakes the agent for customers, and anyone on the team
 * — viewers included — can reach the same brain from here.
 *
 * It is transcript-only today, and the page says so rather than implying
 * otherwise. The agent layer was removed from the Worker to be rebuilt, so
 * there is no route to send a turn to.
 */
export default function ChatPage() {
  const disabled = chatIsDemoOnly();
  const query = useQuery({ queryKey: queryKeys.chat, queryFn: getChatThread });

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 pb-16 sm:p-6">
      <PageHeader eyebrow="Second surface" title="Same agent, second door">
        Slack wakes the agent for customers. This page is the other way in — ask what Slack knows,
        or hand it work directly.
      </PageHeader>

      {disabled ? <NoBackendNotice /> : null}

      <div className="grid items-start gap-4 lg:grid-cols-12">
        <Card className="lg:col-span-7">
          <CardContent className="flex flex-col gap-4">
            {query.data === undefined ? (
              <div className="space-y-3">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-4 w-1/4" />
              </div>
            ) : (
              <ErrorBoundary message="This transcript could not be rendered.">
                <Transcript messages={query.data.messages} />
              </ErrorBoundary>
            )}
            <Composer disabled={disabled} />
          </CardContent>
        </Card>

        <div className="lg:col-span-5">
          <ChatAside suggestions={query.data?.suggestions ?? []} disabled={disabled} />
        </div>
      </div>
    </div>
  );
}

/**
 * Named plainly, with the commit that caused it. A banner that said "coming
 * soon" would be a guess; this is a fact somebody can go and check.
 */
function NoBackendNotice() {
  return (
    <Card className="border-warning/40 bg-warning/5">
      <CardContent className="flex items-start gap-3">
        <PlugZap className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <div className="space-y-1">
          <p className="text-sm font-medium">This transcript is a fixture</p>
          <p className="text-sm text-pretty text-muted-foreground">
            The Worker exposes no chat route. The agent layer was removed in{" "}
            <code className="machine text-xs">2698e88</code> to be rebuilt on the Agents SDK, and
            with it went <code className="machine text-xs">/agents/*</code> and{" "}
            <code className="machine text-xs">/ws/run/:id</code>. Sending is off until one of them
            comes back — the contract it needs is in BACKEND-GAPS.md.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
