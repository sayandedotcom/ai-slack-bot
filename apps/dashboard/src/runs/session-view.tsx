import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { Button } from "@workspace/ui/components/button";

import type { RunStatus, SessionItem, SessionState, ToolCallView } from "./session-reducer";

/**
 * The one session component: transcript + composer for a live run. It is pure
 * presentation — every byte it draws arrives as props, and every byte it sends
 * leaves through `onSteer` — which is what lets the operator dashboard and the
 * customer chat page (phase 17) mount the same component over different sockets.
 *
 * Two properties here are load-bearing rather than cosmetic:
 *   - The disconnect banner. A socket that drops and keeps showing the last
 *     transcript is actively lying to whoever is steering an incident, so
 *     anything but a healthy connection says so above the fold.
 *   - Sticky-bottom that yields to the human. Auto-scroll is right while you are
 *     watching the tail and wrong the instant you scroll up to read something.
 */

/**
 * Declared locally rather than imported from `./socket` on purpose: this module
 * has no reason to depend on the transport, and the union is the contract.
 */
export type Connection = "connecting" | "open" | "reconnecting" | "closed";

/** Statuses that end a run — no further steering is possible, so say why. */
const CLOSED_REASON: Partial<Record<RunStatus, string>> = {
  done: "This run is finished.",
  failed: "This run failed.",
};

/** Sources are protocol strings; these are the human words for them. */
const SOURCE_LABEL: Record<string, string> = {
  customer: "customer",
  human_steer: "steer",
  steer: "steer",
  approval: "approval",
  triage: "triage",
  agent: "agent",
  system: "system",
};

/** Roles carry the visual weight — a user turn should never read as the agent. */
const ROLE_CLASS: Record<string, string> = {
  user: "border-primary/40 bg-primary/5",
  assistant: "border-border bg-card",
  system: "border-dashed border-border bg-muted/40",
};

const JSON_LIMIT = 5_000;

/**
 * Payloads are unbounded (a scraped page, a whole log file) and this pane is not
 * a JSON viewer — clip hard and say that we clipped, so nobody reads a truncated
 * tool output as the complete one.
 */
function preview(value: unknown): { text: string; truncated: boolean } {
  let full: string;
  try {
    full = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    full = String(value);
  }
  return { text: full.slice(0, JSON_LIMIT), truncated: full.length > JSON_LIMIT };
}

function duration(call: ToolCallView): string {
  if (call.endedAt === null) return "running";
  const ms = call.endedAt - call.startedAt;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const STATE_DOT: Record<ToolCallView["state"], string> = {
  running: "bg-amber-500 animate-pulse",
  completed: "bg-emerald-500",
  failed: "bg-destructive",
};

function Caption({ children }: { children: ReactNode }): ReactNode {
  return <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{children}</div>;
}

function Payload({ label, value }: { label: string; value: unknown }): ReactNode {
  const { text, truncated } = preview(value);
  return (
    <div className="space-y-1">
      <Caption>{label}</Caption>
      <pre className="overflow-x-auto rounded bg-muted/60 p-2 text-xs leading-snug whitespace-pre-wrap break-words">
        {text}
      </pre>
      {truncated ? (
        <p className="text-[11px] text-muted-foreground">… truncated at {JSON_LIMIT} characters</p>
      ) : null}
    </div>
  );
}

function ToolCallRow({ call }: { call: ToolCallView }): ReactNode {
  // Collapsed by default: tool traffic is the bulk of a run's volume and almost
  // never the thing the reader came for.
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
      >
        <span aria-hidden="true" className="text-muted-foreground">
          {open ? "▾" : "▸"}
        </span>
        <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${STATE_DOT[call.state]}`} />
        <span className="font-medium">{call.name}</span>
        <span className="sr-only">{call.state}</span>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">{duration(call)}</span>
      </button>
      {open ? (
        <div className="space-y-2 border-t px-3 py-2">
          {call.input === undefined ? null : <Payload label="input" value={call.input} />}
          {call.output === undefined ? null : <Payload label="output" value={call.output} />}
          {call.error === undefined ? null : (
            <p className="text-xs text-destructive">{call.error}</p>
          )}
          {call.input === undefined && call.output === undefined && call.error === undefined ? (
            <p className="text-xs text-muted-foreground">No payload recorded.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TurnRow({
  turn,
}: {
  turn: { role: string; source: string; content: string; createdAt: number };
}): ReactNode {
  return (
    <div className={`rounded-lg border px-3 py-2 ${ROLE_CLASS[turn.role] ?? ROLE_CLASS.system}`}>
      <div className="flex items-baseline gap-2">
        <Caption>{SOURCE_LABEL[turn.source] ?? turn.source}</Caption>
        <span className="text-[11px] text-muted-foreground">
          {new Date(turn.createdAt).toLocaleTimeString()}
        </span>
      </div>
      <p className="mt-1 text-sm whitespace-pre-wrap break-words">{turn.content}</p>
    </div>
  );
}

function ItemRow({ item }: { item: SessionItem }): ReactNode {
  switch (item.kind) {
    case "turn":
      return <TurnRow turn={item.turn} />;
    case "tool_call":
      return <ToolCallRow call={item.call} />;
    case "status":
      return (
        <p className="text-center text-xs text-muted-foreground">
          {item.previousStatus} → {item.status}
        </p>
      );
    case "draft":
      return (
        <div className="rounded-lg border border-border bg-card px-3 py-2">
          <Caption>agent</Caption>
          <p className="mt-1 text-sm whitespace-pre-wrap break-words">
            {item.text}
            {/* The cursor is the only signal that this text is still arriving. */}
            <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-foreground align-middle" />
          </p>
        </div>
      );
  }
}

function itemKey(item: SessionItem, index: number): string {
  switch (item.kind) {
    case "turn":
      return `turn:${item.turn.id}`;
    case "tool_call":
      return `tool:${item.call.callId}`;
    case "draft":
      return `draft:${item.generationId}`;
    case "status":
      return `status:${index}:${item.createdAt}`;
  }
}

const DISCONNECT_NOTE = "Reconnecting — you may be seeing a stale view";

export function SessionView({
  session,
  connection,
  onSteer,
  composerPlaceholder,
}: {
  session: SessionState;
  connection: Connection;
  onSteer: (content: string) => void;
  composerPlaceholder?: string;
}): ReactNode {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Whether the reader is parked at the tail. Starts true so a freshly opened
  // run lands on the newest turn rather than the oldest.
  const stuckRef = useRef(true);
  const [draft, setDraft] = useState("");

  const onScroll = useCallback(() => {
    const node = scrollRef.current;
    if (node === null) return;
    // A few pixels of slack: sub-pixel layout and momentum scrolling rarely land
    // exactly on zero, and one stray pixel should not unstick the view.
    stuckRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
  }, []);

  // Layout effect, not effect: scroll before paint so the tail never visibly
  // jumps after a new item renders.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node === null || !stuckRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [session.items, session.pendingSteers]);

  const closedReason = session.status === null ? undefined : CLOSED_REASON[session.status];
  const disabled = closedReason !== undefined;

  const send = useCallback(() => {
    const content = draft.trim();
    if (content === "" || disabled) return;
    onSteer(content);
    setDraft("");
    // Sending is an explicit "I want to watch what happens next".
    stuckRef.current = true;
  }, [draft, disabled, onSteer]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  useEffect(() => {
    if (disabled) setDraft("");
  }, [disabled]);

  const pending = [...session.pendingSteers.entries()];

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {connection === "open" ? null : (
        <div
          role="status"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
        >
          {connection === "connecting" ? "Connecting…" : DISCONNECT_NOTE}
        </div>
      )}

      {session.lastError === null ? null : (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
        >
          {session.lastError.message}
          <span className="ml-2 text-xs text-muted-foreground">({session.lastError.code})</span>
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto rounded-lg border bg-background p-3"
      >
        {session.items.length === 0 && pending.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Nothing yet — the transcript fills in as the agent works.
          </p>
        ) : (
          session.items.map((item, index) => (
            <ItemRow key={itemKey(item, index)} item={item} />
          ))
        )}

        {/* Optimistic tail: the user's own words appear the moment they hit send.
            The ack replaces these with the server's real turn. */}
        {pending.map(([requestId, content]) => (
          <div key={`pending:${requestId}`} className="rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 opacity-60">
            <div className="flex items-baseline gap-2">
              <Caption>steer</Caption>
              <span className="text-[11px] text-muted-foreground">sending…</span>
            </div>
            <p className="mt-1 text-sm whitespace-pre-wrap break-words">{content}</p>
          </div>
        ))}
      </div>

      <div className="flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={2}
          placeholder={closedReason ?? composerPlaceholder ?? "Steer the agent — Enter to send, Shift+Enter for a newline"}
          aria-label="Message the agent"
          className="min-h-0 flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
        />
        <Button type="button" onClick={send} disabled={disabled || draft.trim() === ""}>
          Send
        </Button>
      </div>
    </div>
  );
}
