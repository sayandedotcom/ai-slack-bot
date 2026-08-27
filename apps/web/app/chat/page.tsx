"use client";

import { AlertTriangle, CornerDownLeft, Loader2, SendHorizontal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, type KeyboardEvent } from "react";

import { Button } from "@workspace/ui/components/button";
import { Card, CardContent } from "@workspace/ui/components/card";
import { Textarea } from "@workspace/ui/components/textarea";

import { ChatAside } from "@/components/chat/chat-aside";
import { PageHeader } from "@/components/shell/page-header";
import { FIRST_MESSAGE_MAX_CHARS, makeChatStarter, startChatRun } from "@/lib/api/chat";

/**
 * The second door: Slack wakes the agent for customers, and anyone on the team
 * — viewers included — can reach the same brain from here.
 *
 * This page is a CREATE FORM and nothing more. A chat run is the same object a
 * triage wake produces — one `RunAgent`, one transcript, one steer path — so
 * once the run exists the reader goes to `/runs/:id` and the run view takes
 * over. Building a second session shape here is how the two drift.
 */
export default function ChatPage() {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One starter for the life of the page, because the idempotency it holds —
  // one `clientRequestId` per text, across retries — only means anything if it
  // outlives the failure the reader is retrying after.
  const starter = useMemo(() => makeChatStarter(startChatRun), []);

  const tooLong = draft.trim().length > FIRST_MESSAGE_MAX_CHARS;
  const canStart = draft.trim() !== "" && !starting && !tooLong;

  const start = () => {
    if (!canStart) return;
    setError(null);
    setStarting(true);
    void starter
      .start(draft)
      .then((run) => {
        if (run !== null) router.push(`/runs/${encodeURIComponent(run.id)}`);
      })
      .catch(() => {
        setError("Could not start that run. Try again.");
      })
      .finally(() => setStarting(false));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      start();
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 pb-16 sm:p-6">
      <PageHeader eyebrow="Second surface" title="Same agent, second door">
        Slack wakes the agent for customers. This page is the other way in — ask what Slack knows,
        or hand it work directly.
      </PageHeader>

      <div className="grid items-start gap-4 lg:grid-cols-12">
        <Card className="lg:col-span-7">
          <CardContent className="space-y-3">
            {error === null ? null : (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span className="text-pretty">{error}</span>
              </div>
            )}

            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              disabled={starting}
              aria-label="Ask the agent"
              placeholder="What do you want to know? Or hand it work — file the issue, draft the PR, run the fix."
              /* `field-sizing-content` on the primitive means `rows` does
                 nothing: the box grows with what is typed. The floor is what
                 sets how much room the page offers to think in. */
              className="min-h-48 resize-none text-sm"
            />

            <div className="flex items-center justify-between gap-3">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {tooLong ? (
                  <span className="text-destructive">
                    Too long — {FIRST_MESSAGE_MAX_CHARS.toLocaleString("en-US")} characters is the
                    opening limit.
                  </span>
                ) : (
                  <>
                    <CornerDownLeft className="size-3" aria-hidden="true" />
                    Enter to start, Shift+Enter for a newline
                  </>
                )}
              </p>
              <Button onClick={start} disabled={!canStart}>
                {starting ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <SendHorizontal aria-hidden="true" />
                )}
                {starting ? "Starting…" : "Ask"}
              </Button>
            </div>

            <p className="border-t pt-3 text-xs text-pretty text-muted-foreground">
              This opens a run — the same kind of run a Slack thread opens — and everything
              committal still needs a human. You land in the run and can steer it from there.
            </p>
          </CardContent>
        </Card>

        <div className="lg:col-span-5">
          <ChatAside onPick={setDraft} />
        </div>
      </div>
    </div>
  );
}
