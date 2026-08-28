"use client";

import { Button } from "@workspace/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import { Textarea } from "@workspace/ui/components/textarea";
import {
  AlertTriangle,
  CornerDownLeft,
  Loader2,
  SendHorizontal,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, useMemo, useState } from "react";

import {
  FIRST_MESSAGE_MAX_CHARS,
  makeChatStarter,
  startChatRun,
} from "@/lib/api/chat";

/**
 * Openings worth typing, ported from the old chat page's aside — copy, not
 * data, so it is the same four whether the app is on fixtures or a live
 * Worker. Fills the box rather than sending: an opening is worth editing
 * before it becomes a run, and a one-click send from a chip is how somebody
 * starts a run they did not mean to.
 */
const STARTERS: string[] = [
  "what shipped for customers this week?",
  "which customer is angriest right now and why?",
  "ship the copy-funnel-ID button Priya asked for",
  "summarise Driftwear's big ask for Monday's standup",
];

/**
 * The create form for a run started from this app rather than woken from
 * Slack.
 *
 * A chat run is the SAME object a Slack wake produces — one `RunAgent`, one
 * transcript, one steer path — so this dialog does nothing but create it: on
 * success the reader lands on `/runs/:id` and the run view takes over.
 *
 * Mounted once by `RunList`, open or not, so `starter` — and the
 * one-`clientRequestId`-per-text idempotency it holds — survives a failed
 * attempt across a close and reopen of the dialog, the same way it survived a
 * page that never unmounted.
 */
export function NewRunDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        if (run === null) return;
        setDraft("");
        onOpenChange(false);
        router.push(`/runs/${encodeURIComponent(run.id)}`);
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New run</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {error === null ? null : (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-sm"
            >
              <AlertTriangle
                className="mt-0.5 size-3.5 shrink-0"
                aria-hidden="true"
              />
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
            className="min-h-40 resize-none text-sm"
          />

          <div className="flex flex-wrap gap-1.5">
            {STARTERS.map((suggestion) => (
              <Button
                key={suggestion}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDraft(suggestion)}
              >
                {suggestion}
              </Button>
            ))}
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
              {tooLong ? (
                <span className="text-destructive">
                  Too long — {FIRST_MESSAGE_MAX_CHARS.toLocaleString("en-US")}{" "}
                  characters is the opening limit.
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
