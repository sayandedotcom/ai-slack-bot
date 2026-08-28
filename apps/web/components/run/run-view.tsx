"use client";

import { Button } from "@workspace/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover";
import { Textarea } from "@workspace/ui/components/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import {
  AlertTriangle,
  PlugZap,
  SendHorizontal,
  Square,
  WifiOff,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ConnectionState } from "@/lib/hooks/use-run-agent";
import { Transcript, type TranscriptMessage } from "./transcript";

/**
 * One run, as the reader sees it.
 *
 * Pure: it takes everything it draws as props and opens no socket, so both the
 * live view and demo mode render the same component and the test harness can
 * pin every state it can be in.
 *
 * The composer has ONE verb, and that is the whole difference from a chat box.
 * Every send is a STEER: the Worker drops chat-request frames from every
 * connection, so a "send a message" path would fail silently. A steer is
 * spliced into the very next model step, which is what lets a human correct a
 * run without waiting for the current answer to finish.
 *
 * The run's STATUS is not drawn here. The page header carries it, from D1,
 * where it renders whether or not a socket ever connected — and two status
 * chips on one screen, one of them fresher than the other, is a way to make a
 * reader distrust both.
 *
 * Approvals are NOT decided here. The card renders inside the transcript —
 * a run parks mid-answer and the reader is looking at the transcript, so making
 * them find the queue behind this view is how a customer waits ten minutes for
 * a reply that was already written — but the decision goes out over
 * `PATCH /api/approvals/:id`, which takes the roster check and the D1 CAS.
 */

export type RunViewProps = {
  connection: ConnectionState;
  /** The socket was refused outright — usually a signed-out Access session. */
  connectionError: boolean;
  messages: readonly TranscriptMessage[];
  busy: boolean;
  turnError: boolean;
  sendError: string | null;
  onSend: (text: string) => void;
  onDismissError: () => void;
  /** The run's own approval card, rendered inside the transcript. */
  approvals?: ReactNode;
  /**
   * Why the composer is off, or null when it works. A box that accepts text
   * and drops it is worse than no box: it teaches the reader that the feature
   * works.
   */
  steerDisabledReason?: string | null;
  /** This run's capability chip strip, keyed by turn id — see `chipsByTurn`. */
  chips?: ReadonlyMap<string, readonly string[]>;
  /** Whether Cancel may be offered at all — a parked run is not running. */
  canCancel: boolean;
  onCancel: () => void;
  cancelling: boolean;
};

export function RunView({
  connection,
  connectionError,
  messages,
  busy,
  turnError,
  sendError,
  onSend,
  onDismissError,
  approvals,
  steerDisabledReason = null,
  chips,
  canCancel,
  onCancel,
  cancelling,
}: RunViewProps) {
  const [draft, setDraft] = useState("");
  const disabled = steerDisabledReason !== null;

  /**
   * Follow the stream, but only from the bottom.
   *
   * A transcript that yanks itself down while somebody is reading what the
   * agent did four steps ago is worse than one that never scrolls — so the
   * jump happens only when the reader was already at the end, which is what
   * following along looks like. Keyed on `messages.length` rather than the
   * array identity: a streaming turn mutates its last message on every token,
   * and scrolling on each one fights a reader who has just scrolled up.
   */
  const streamRef = useRef<HTMLDivElement>(null);
  const count = messages.length;
  useEffect(() => {
    // Read rather than merely depended on: an empty, idle transcript has
    // nothing to scroll to, and saying so here is what makes both values
    // honest dependencies instead of a hook keyed on something it ignores.
    if (count === 0 && !busy) return;
    const node = streamRef.current;
    if (node === null) return;
    const distanceFromBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight;
    // One viewport of slack, so a short new message still counts as "at the end".
    if (distanceFromBottom > node.clientHeight) return;
    node.scrollTop = node.scrollHeight;
  }, [count, busy]);

  const send = () => {
    const text = draft.trim();
    if (text === "" || disabled) return;
    onSend(text);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  return (
    <div data-slot="run-view" className="flex min-h-0 flex-1 flex-col gap-3">
      {/* A socket that has dropped and keeps showing the last transcript is
          lying to whoever is steering an incident, so anything but a healthy
          connection says so above the fold. */}
      {connection === "live" || connectionError ? null : (
        <Notice tone="warning" icon={WifiOff} role="status">
          {connection === "reconnecting"
            ? "Reconnecting — you may be seeing a stale view."
            : "Connecting to the run…"}
        </Notice>
      )}

      {connectionError ? (
        <Notice tone="destructive" icon={PlugZap} role="alert">
          The run socket was refused. Reload the page — if it keeps happening
          you are probably signed out of Access, or this origin cannot reach the
          Worker. See BACKEND-GAPS.md §4.
        </Notice>
      ) : null}

      {turnError ? (
        <Notice tone="destructive" icon={AlertTriangle} role="alert">
          <span className="flex flex-1 items-center justify-between gap-3">
            The agent stopped with an error.
            <Button variant="outline" size="sm" onClick={onDismissError}>
              Dismiss
            </Button>
          </span>
        </Notice>
      ) : null}

      {sendError === null ? null : (
        <Notice tone="destructive" icon={AlertTriangle} role="alert">
          {sendError}
        </Notice>
      )}

      <div
        ref={streamRef}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-lg border bg-background p-4"
      >
        {messages.length === 0 && !busy ? (
          <p className="py-10 text-center text-muted-foreground text-sm">
            Nothing yet — the transcript fills in as the agent works.
          </p>
        ) : (
          <Transcript messages={messages} chips={chips} />
        )}

        {approvals}

        {busy ? (
          <p
            role="status"
            className="flex items-center justify-center gap-2 py-2 text-muted-foreground text-xs"
          >
            <span className="relative flex size-1.5" aria-hidden="true">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-70" />
              <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
            </span>
            Working…
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={disabled}
            rows={2}
            aria-label="Steer the agent"
            placeholder={
              disabled
                ? steerDisabledReason
                : "Steer the agent — Enter to send, Shift+Enter for a newline"
            }
            className="resize-none text-sm"
          />
          {disabled ? (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Button disabled aria-label="Steer">
                  <SendHorizontal />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{steerDisabledReason}</TooltipContent>
            </Tooltip>
          ) : (
            <Button
              onClick={send}
              disabled={draft.trim() === ""}
              aria-label="Steer"
            >
              <SendHorizontal />
            </Button>
          )}
        </div>
        {canCancel ? (
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={cancelling}
                  aria-label="Cancel run"
                />
              }
            >
              <Square /> Cancel run
            </PopoverTrigger>
            <PopoverContent className="w-64 space-y-2 text-sm">
              <p>
                Stops the turn in flight. The run stays where it is — a human
                stopping it is not it failing.
              </p>
              <Button
                size="sm"
                variant="destructive"
                onClick={onCancel}
                aria-label="Yes, stop it"
              >
                Yes, stop it
              </Button>
            </PopoverContent>
          </Popover>
        ) : null}

        <p className="text-pretty text-muted-foreground text-xs">
          A steer is spliced into the agent&rsquo;s next step, so you can
          correct it mid-answer. A customer-facing Slack reply still waits for
          approval, and the speaker still gets a nudge.
        </p>
      </div>
    </div>
  );
}

const TONE = {
  warning: "border-warning/40 bg-warning/10 text-warning",
  destructive: "border-destructive/40 bg-destructive/10 text-destructive",
} as const;

function Notice({
  tone,
  icon: Icon,
  role,
  children,
}: {
  tone: keyof typeof TONE;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  role: "status" | "alert";
  children: ReactNode;
}) {
  return (
    <div
      role={role}
      className={`flex items-start gap-2.5 rounded-md border px-3 py-2 text-sm ${TONE[tone]}`}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden={true} />
      <span className="min-w-0 flex-1 text-pretty">{children}</span>
    </div>
  );
}
