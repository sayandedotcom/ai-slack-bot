import { useCallback, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { Button } from "@workspace/ui/components/button";

import { getToolOutput } from "@cloudflare/think/react";

import { CopyId } from "../components/copy-id";
import { AgentSession, isToolPart, type ChatMessage } from "../runs/agent-session";
import { SessionView } from "../runs/session-view";
import { useRunSession } from "../runs/use-run-session";
import type { Chassis } from "../lib/chassis";
import { createChat, createEmptyChat } from "./api";
import { extractSources, linkifySlackUrls, sourcesFromToolOutput, type SourceChip } from "./citations";
import { SessionList } from "./session-list";
import { SourcesRail } from "./sources-rail";

/**
 * The second door into the one agent: a human types first. Left, past chat
 * runs; right, either the new-chat composer or an open session.
 *
 * Which session component that is depends on the chassis, and that is the whole
 * of the difference: on `legacy` it is phase 15's `SessionView` over the `/ws`
 * socket, on `think` it is `AgentSession` over `useAgentChat` — the SAME
 * component the dashboard drawer mounts for a triage-woken run, which is
 * requirement 2's "one session shape" made literal. Both stay mounted until the
 * cutover deletes the legacy chassis.
 */

const SUGGESTIONS = [
  "what shipped for customers this week?",
  "which customer is angriest right now and why?",
  "did PulseFit complain about checkout before, and what did we do?",
  "summarize Driftwear's big ask for Monday's standup",
];

/** Verbatim permalinks in assistant text become in-place links. */
function renderLinkedContent(content: string): ReactNode {
  const segments = linkifySlackUrls(content);
  if (segments.length === 1 && segments[0]?.kind === "text") return content;
  return segments.map((segment, index) =>
    segment.kind === "text" ? (
      <span key={index}>{segment.text}</span>
    ) : (
      <a
        key={index}
        href={segment.url}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-primary underline underline-offset-2"
      >
        {segment.url}
      </a>
    ),
  );
}

function NewChat({
  chassis,
  onCreated,
}: {
  chassis: Chassis;
  /** `firstMessage` is non-null only on the Think chassis — see `createEmptyChat`. */
  onCreated: (id: string, firstMessage: string | null) => void;
}): ReactNode {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One requestId per submission attempt, held across retries. This does NOT
  // dedupe runs — the worker mints a new run on every POST regardless; it
  // only stabilizes the first turn's id inside whichever run gets created.
  // Kept anyway because that turn-id stability is still correct and useful.
  // The actual guard against a double-submit is the `sending` in-flight flag
  // below, which blocks a second submit while the first is still outstanding.
  const requestIdRef = useRef<string | null>(null);

  // Shared by the textarea and the suggestion buttons so both paths reset
  // requestIdRef the same way — new text always means a new question.
  const setText = useCallback((value: string) => {
    setDraft(value);
    requestIdRef.current = null;
  }, []);

  const submit = useCallback(async () => {
    const firstMessage = draft.trim();
    if (firstMessage === "" || sending) return;
    const requestId = (requestIdRef.current ??= crypto.randomUUID());
    setSending(true);
    setError(null);
    try {
      // On `think` the run is minted empty and the opening message is handed to
      // the agent socket instead; on `legacy` the coordinator appends it, as it
      // always has. Same button, and the difference never reaches this UI
      // beyond which of the two calls it makes.
      const run = chassis === "think" ? await createEmptyChat() : await createChat(firstMessage, requestId);
      requestIdRef.current = null;
      onCreated(run.id, chassis === "think" ? firstMessage : null);
    } catch {
      setError("Couldn't start the chat — check the connection and try again.");
    } finally {
      setSending(false);
    }
  }, [chassis, draft, sending, onCreated]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
      <div className="w-full max-w-xl space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Ask the agent</h2>
        <p className="text-sm text-muted-foreground">
          Same brain that answers Slack — ask what memory knows, or hand it work.
        </p>
        {error === null ? null : (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
            {error}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            rows={3}
            disabled={sending}
            placeholder="Ask anything, or hand it work…"
            aria-label="Start a new chat"
            className="min-h-0 flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
          />
          <Button type="button" onClick={() => void submit()} disabled={sending || draft.trim() === ""}>
            {sending ? "Starting…" : "Ask"}
          </Button>
        </div>
        <div className="space-y-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Try asking</p>
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => setText(suggestion)}
              className="block w-full rounded-md border bg-card px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              “{suggestion}”
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The Think-chassis session's receipts.
 *
 * On this chassis the model has exactly ONE tool, so there is no `memory.cite`
 * tool part to read the way `extractSources` does — the cited facts come back
 * nested inside a `run_code` result. `sourcesFromToolOutput` finds them by
 * shape; this only walks the parts and dedupes across them.
 */
function agentSources(messages: ChatMessage[]): SourceChip[] {
  const seen = new Set<string>();
  const chips: SourceChip[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolPart(part)) continue;
      const output = getToolOutput(part);
      if (output === undefined) continue;
      for (const chip of sourcesFromToolOutput(output)) {
        if (seen.has(chip.permalink)) continue;
        seen.add(chip.permalink);
        chips.push(chip);
      }
    }
  }
  return chips;
}

/** The Think chassis's chat session — the drawer's component, chat's chrome. */
function AgentChatSession({
  runId,
  firstMessage,
  onFirstMessageSent,
}: {
  runId: string;
  firstMessage: string | null;
  onFirstMessageSent: () => void;
}): ReactNode {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <CopyId runId={runId} />
      </div>
      <div className="min-h-0 flex-1">
        <AgentSession
          runId={runId}
          firstMessage={firstMessage}
          onFirstMessageSent={onFirstMessageSent}
          composerPlaceholder="Reply — Enter to send, Shift+Enter for a newline"
          renderContent={renderLinkedContent}
          emptyHint="Nothing yet — ask anything, and the answer will cite the Slack messages it came from."
          renderFooter={(messages) => <SourcesRail sources={agentSources(messages)} />}
        />
      </div>
    </div>
  );
}

/** Own component so the socket hook mounts/unmounts with the selected run. */
function ChatSession({ runId }: { runId: string }): ReactNode {
  const { session, connection, steer } = useRunSession(runId);
  const sources = useMemo(() => extractSources(session.items), [session.items]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <CopyId runId={runId} />
      </div>
      <div className="min-h-0 flex-1">
        <SessionView
          session={session}
          connection={connection}
          onSteer={steer}
          composerPlaceholder="Reply — Enter to send, Shift+Enter for a newline"
          renderContent={renderLinkedContent}
        />
      </div>
      <SourcesRail sources={sources} />
    </div>
  );
}

export function ChatPage({
  runId,
  chassis,
  onSelectRun,
}: {
  runId: string | null;
  chassis: Chassis;
  onSelectRun: (id: string | null) => void;
}): ReactNode {
  /**
   * The opening message on the Think chassis, held here for exactly one hop:
   * `NewChat` mints the run, this navigates to it, and the agent session sends
   * the text as its first turn. Cleared the moment it has been handed over so a
   * later reload of the same run cannot re-ask the question.
   */
  const [pendingFirst, setPendingFirst] = useState<string | null>(null);

  return (
    <main className="mx-auto grid h-[calc(100svh-57px)] max-w-6xl grid-cols-1 gap-4 p-6 md:grid-cols-[minmax(220px,1fr)_2fr]">
      <div className="min-h-0 overflow-y-auto">
        <SessionList activeId={runId} onSelect={onSelectRun} />
        {runId === null ? null : (
          <Button variant="outline" size="sm" className="mt-3" onClick={() => onSelectRun(null)}>
            New chat
          </Button>
        )}
      </div>
      <div className="min-h-0 rounded-lg border bg-background">
        {runId === null ? (
          <NewChat
            chassis={chassis}
            onCreated={(id, firstMessage) => {
              setPendingFirst(firstMessage);
              onSelectRun(id);
            }}
          />
        ) : (
          // Keyed so switching sessions remounts the socket hook, exactly as
          // app.tsx does for the drawer.
          <div className="h-full p-3">
            {chassis === "think" ? (
              <AgentChatSession
                key={runId}
                runId={runId}
                firstMessage={pendingFirst}
                onFirstMessageSent={() => setPendingFirst(null)}
              />
            ) : (
              <ChatSession key={runId} runId={runId} />
            )}
          </div>
        )}
      </div>
    </main>
  );
}
