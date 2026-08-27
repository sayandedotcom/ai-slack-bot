/**
 * Ask the agent something that is not a Slack thread.
 *
 * A chat run is the SAME object a triage wake produces — one `RunAgent`, one
 * transcript, one steer path — so this page is a create form and nothing more:
 * once the run exists it hands off to the run view. Building a second session
 * shape here is how the two drift.
 *
 * Split the same way as the run view. `ChatPage` is pure and opens no network;
 * `makeChatStarter` in `./api` holds the idempotency, so both are assertable in
 * a package with no DOM.
 */

import { useMemo, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { Button } from "@workspace/ui/components/button";

import { makeChatStarter, startChatRun } from "./api";

export type ChatPageProps = {
  /** True while a create is in flight. The composer locks. */
  starting: boolean;
  /** What to tell the human when the create did not land. */
  error: string | null;
  onStart: (text: string) => void;
};

export function ChatPage({
  starting,
  error,
  onStart,
}: ChatPageProps): ReactNode {
  const [draft, setDraft] = useState("");

  const start = () => {
    const text = draft.trim();
    if (text === "" || starting) return;
    onStart(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      start();
    }
  };

  return (
    <section
      data-slot="chat-page"
      aria-label="Ask the agent"
      className="space-y-3"
    >
      <p className="text-sm text-muted-foreground">
        Ask about a customer, a deploy, a trace or a table. This opens a run —
        the same kind of run a Slack thread opens — and everything committal
        still needs a human.
      </p>

      {error === null ? null : (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
        >
          {error}
        </div>
      )}

      <div className="flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          disabled={starting}
          placeholder="What do you want to know? Enter to send, Shift+Enter for a newline"
          aria-label="Ask the agent"
          className="min-h-0 flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60"
        />
        <Button
          type="button"
          onClick={start}
          disabled={starting || draft.trim() === ""}
        >
          {starting ? "Starting…" : "Ask"}
        </Button>
      </div>
    </section>
  );
}

/** The wired version: creates the run, then hands the id to the caller. */
export function ChatStarter({
  onStarted,
}: {
  onStarted: (runId: string) => void;
}): ReactNode {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const starter = useMemo(() => makeChatStarter(startChatRun), []);

  return (
    <ChatPage
      starting={starting}
      error={error}
      onStart={(text) => {
        setError(null);
        setStarting(true);
        void starter
          .start(text)
          .then((run) => {
            if (run !== null) onStarted(run.id);
          })
          .catch(() => {
            setError("Could not start that run. Try again.");
          })
          .finally(() => setStarting(false));
      }}
    />
  );
}
