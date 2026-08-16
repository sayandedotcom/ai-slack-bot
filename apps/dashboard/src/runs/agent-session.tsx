/**
 * The run session on the Think chassis — ONE component for both doors.
 *
 * Requirement 2 of the brief is "one session shape": a run triage woke in Slack
 * and a chat a human started from the dashboard are the same object, so they
 * must be the same view. This is that view. The dashboard drawer and the chat
 * page both mount it; the only differences they are allowed are a placeholder,
 * a content renderer, and what they hang under the transcript.
 *
 * It talks to `RunAgent` over the Agents SDK's own transport — `useAgent` opens
 * the WebSocket, `useAgentChat` (Think's flavour) owns the transcript, the
 * stream resumption and the durable turn. There is no bespoke frame protocol
 * here and no reducer: the session tree in the Durable Object is authoritative
 * and this file only draws it.
 *
 * Three things about the wiring are load-bearing rather than stylistic:
 *
 *  - **`useAgentChat` suspends.** It reads the transcript with React's `use()`,
 *    so the body must be inside a `<Suspense>` — and inside an `ErrorBoundary`,
 *    because a rejected promise thrown out of render blanks the whole page.
 *    Both live in the exported wrapper at the bottom.
 *  - **The composer has two verbs.** Text typed while the agent is mid-turn goes
 *    to the `steer` callable, which splices into the very next model call
 *    (invariants 12-13). Text typed while it is idle goes to `sendMessage`,
 *    which starts a turn. Sending a steer at an idle run would queue text that
 *    nothing drains; starting a turn mid-turn is refused by Think.
 *  - **The room is `runs.id`, not the run key.** The worker resolves one to the
 *    other through D1 before naming the Durable Object (see the `/agents/*`
 *    mount in `apps/worker/src/index.ts`), which is what keeps invariant 10
 *    intact with the Agents SDK's name-in-the-URL routing.
 */

import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { useAgentChat, getToolCallId, getToolInput, getToolOutput, getToolPartState } from "@cloudflare/think/react";
import { useAgent } from "agents/react";

import { Button } from "@workspace/ui/components/button";

import { ErrorBoundary } from "../components/error-boundary";

/**
 * `camelCaseToKebabCase("RUN_AGENTS")`. partyserver derives the namespace path
 * segment from the BINDING name in wrangler.jsonc, not from the class name, so
 * this string is pinned to `RUN_AGENTS` and nothing else.
 */
const AGENT_NAMESPACE = "run-agents";

/**
 * The message and part types, derived from the hook rather than imported from
 * `ai`. Same types, one less direct dependency in this package, and they cannot
 * drift from whatever version of the SDK the hook was actually built against.
 */
type ChatApi = ReturnType<typeof useAgentChat>;
export type ChatMessage = ChatApi["messages"][number];
export type ChatMessagePart = ChatMessage["parts"][number];

export function isToolPart(part: ChatMessagePart): boolean {
  return part.type.startsWith("tool-") || part.type === "dynamic-tool";
}

/** `tool-run_code` → `run_code`; a dynamic part carries its own name. */
function toolNameOf(part: ChatMessagePart): string {
  if (part.type === "dynamic-tool") {
    const named = part as { toolName?: unknown };
    return typeof named.toolName === "string" ? named.toolName : "tool";
  }
  return part.type.slice("tool-".length);
}

const JSON_LIMIT = 5_000;

/**
 * Payloads are unbounded (a scraped page, a whole log file) and this pane is not
 * a JSON viewer — clip hard and say that we clipped, so nobody reads a truncated
 * tool output as the complete one. Same rule as the legacy `SessionView`.
 */
function preview(value: unknown): { text: string; truncated: boolean } {
  let full: string;
  try {
    full = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
  } catch {
    full = String(value);
  }
  return { text: full.slice(0, JSON_LIMIT), truncated: full.length > JSON_LIMIT };
}

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

/** The dot is the only at-a-glance signal of what a tool call is doing. */
const STATE_DOT: Record<string, string> = {
  loading: "bg-amber-500 animate-pulse",
  streaming: "bg-amber-500 animate-pulse",
  "waiting-approval": "bg-sky-500 animate-pulse",
  approved: "bg-emerald-500",
  complete: "bg-emerald-500",
  error: "bg-destructive",
  denied: "bg-destructive",
};

function ToolPartRow({ part }: { part: ChatMessagePart }): ReactNode {
  // Collapsed by default: on this chassis every capability call the agent makes
  // is inside one `run_code` payload, so an expanded tool row is most of the
  // transcript's bytes and almost never the thing the reader came for.
  const [open, setOpen] = useState(false);
  const state = getToolPartState(part);
  const input = getToolInput(part);
  const output = getToolOutput(part);
  const name = toolNameOf(part);

  // `run_code`'s input is `{ code }`, and the code is the interesting half.
  const code =
    typeof (input as { code?: unknown } | undefined)?.code === "string"
      ? ((input as { code: string }).code)
      : undefined;

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
        <span
          aria-hidden="true"
          className={`h-2 w-2 shrink-0 rounded-full ${STATE_DOT[state] ?? "bg-muted-foreground"}`}
        />
        <span className="font-medium">{name}</span>
        <span className="sr-only">{state}</span>
        <span className="ml-auto text-xs text-muted-foreground">{state}</span>
      </button>
      {open ? (
        <div className="space-y-2 border-t px-3 py-2">
          {code === undefined ? (
            input === undefined ? null : (
              <Payload label="input" value={input} />
            )
          ) : (
            <Payload label="code" value={code} />
          )}
          {output === undefined ? null : <Payload label="output" value={output} />}
          {code === undefined && input === undefined && output === undefined ? (
            <p className="text-xs text-muted-foreground">No payload recorded yet.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ReasoningRow({ text }: { text: string }): ReactNode {
  const [open, setOpen] = useState(false);
  if (text.trim() === "") return null;
  return (
    <div className="rounded-lg border border-dashed bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground"
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span>thinking</span>
      </button>
      {open ? (
        <p className="border-t px-3 py-2 text-xs whitespace-pre-wrap break-words text-muted-foreground">
          {text}
        </p>
      ) : null}
    </div>
  );
}

/** Roles carry the visual weight — a user turn should never read as the agent. */
const ROLE_CLASS: Record<string, string> = {
  user: "border-primary/40 bg-primary/5",
  assistant: "border-border bg-card",
  system: "border-dashed border-border bg-muted/40",
};

function MessageRow({
  message,
  renderContent,
}: {
  message: ChatMessage;
  renderContent?: (content: string) => ReactNode;
}): ReactNode {
  const rows: ReactNode[] = [];
  let index = 0;

  for (const part of message.parts) {
    const key = `${message.id}:${index++}`;
    if (part.type === "text") {
      const text = (part as { text?: unknown }).text;
      if (typeof text !== "string" || text === "") continue;
      rows.push(
        <div key={key} className={`rounded-lg border px-3 py-2 ${ROLE_CLASS[message.role] ?? ROLE_CLASS.system}`}>
          <Caption>{message.role}</Caption>
          <p className="mt-1 text-sm whitespace-pre-wrap break-words">
            {renderContent === undefined ? text : renderContent(text)}
          </p>
        </div>,
      );
      continue;
    }
    if (part.type === "reasoning") {
      const text = (part as { text?: unknown }).text;
      rows.push(<ReasoningRow key={key} text={typeof text === "string" ? text : ""} />);
      continue;
    }
    if (isToolPart(part)) {
      rows.push(<ToolPartRow key={`${message.id}:${getToolCallId(part)}`} part={part} />);
      continue;
    }
    // `step-start`, `file`, `source-*` and `data-*` parts carry nothing this
    // view has a job for. Dropped silently rather than rendered as debris.
  }

  return <>{rows}</>;
}

export type AgentSessionProps = {
  /** The PUBLIC run id. Never the run key — see the header comment. */
  runId: string;
  composerPlaceholder?: string;
  renderContent?: (content: string) => ReactNode;
  /** What an operator should read when there is nothing in the transcript yet. */
  emptyHint?: string;
  /** Rendered under the transcript; the chat page hangs its sources rail here. */
  renderFooter?: (messages: ChatMessage[]) => ReactNode;
  /**
   * Sent once, as the first turn, as soon as the session is up. The chat page
   * uses it: under this chassis a new chat is an empty run plus a first message
   * through the agent, never a turn appended behind its back.
   */
  firstMessage?: string | null;
  onFirstMessageSent?: () => void;
};

function AgentSessionBody({
  runId,
  composerPlaceholder,
  renderContent,
  emptyHint,
  renderFooter,
  firstMessage,
  onFirstMessageSent,
}: AgentSessionProps): ReactNode {
  const [connected, setConnected] = useState(false);
  /** Set once the socket has closed at least once, so "connecting" and
   *  "reconnecting" can say different, honest things. */
  const droppedRef = useRef(false);
  const [dropped, setDropped] = useState(false);

  const agent = useAgent({
    agent: AGENT_NAMESPACE,
    name: runId,
    onOpen: () => setConnected(true),
    onClose: () => {
      droppedRef.current = true;
      setDropped(true);
      setConnected(false);
    },
  });

  const chat = useAgentChat({ agent, credentials: "same-origin" });

  const { messages, status, sendMessage, error, clearError } = chat;
  const busy = chat.isStreaming || chat.isRecovering || status === "submitted";

  const [draft, setDraft] = useState("");
  /** Steers the model has not consumed yet. Optimistic and local: a steer is
   *  spliced at the next step, so it has no transcript entry until it lands. */
  const [steers, setSteers] = useState<{ id: string; text: string }[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Whether the reader is parked at the tail. Starts true so a freshly opened
  // run lands on the newest turn rather than the oldest.
  const stuckRef = useRef(true);

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
  }, [messages, steers]);

  // A finished turn has consumed every steer that was queued against it.
  const wasBusy = useRef(busy);
  if (wasBusy.current && !busy && steers.length > 0) setSteers([]);
  wasBusy.current = busy;

  const submit = useCallback(
    (text: string) => {
      setSendError(null);
      if (busy) {
        const id = crypto.randomUUID();
        setSteers((current) => [...current, { id, text }]);
        // The `steer` callable, over the Agents SDK's own RPC. It queues the
        // text in the agent's SQLite and `beforeStep` splices it into the very
        // next model call — the point being that a human correcting a run does
        // not wait for the current answer to finish.
        void agent.call<{ queued: number }>("steer", [text]).catch(() => {
          setSteers((current) => current.filter((steer) => steer.id !== id));
          setSendError("Could not send that steer. Try again.");
        });
        return;
      }
      void sendMessage({ text }).catch(() => {
        setSendError("Could not send that message. Try again.");
      });
    },
    [agent, busy, sendMessage],
  );

  /**
   * The chat page's opening message: sent once, by run id, never on a
   * re-render. In an effect rather than in render for two reasons that both
   * bite — `onFirstMessageSent` sets state on the PARENT, which React refuses
   * mid-render, and StrictMode renders twice.
   */
  const sentFirstFor = useRef<string | null>(null);
  useEffect(() => {
    const text = firstMessage?.trim();
    if (text === undefined || text === "") return;
    if (sentFirstFor.current === runId) return;
    sentFirstFor.current = runId;
    void sendMessage({ text }).catch(() => {
      setSendError("Could not send that message. Try again.");
    });
    onFirstMessageSent?.();
  }, [firstMessage, runId, sendMessage, onFirstMessageSent]);

  const send = useCallback(() => {
    const text = draft.trim();
    if (text === "") return;
    submit(text);
    setDraft("");
    // Sending is an explicit "I want to watch what happens next".
    stuckRef.current = true;
  }, [draft, submit]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const footer = useMemo(() => renderFooter?.(messages), [renderFooter, messages]);
  const connectionError = chat.connectionError;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* A socket that drops and keeps showing the last transcript is actively
          lying to whoever is steering an incident, so anything but a healthy
          connection says so above the fold. */}
      {connected ? null : (
        <div role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          {dropped || droppedRef.current
            ? "Reconnecting — you may be seeing a stale view"
            : "Connecting to the run…"}
        </div>
      )}

      {connectionError === null || connectionError === undefined ? null : (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          The run socket was refused. Reload the page — if it keeps happening you are probably
          signed out of Access.
        </div>
      )}

      {error === undefined ? null : (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
        >
          <span>The agent stopped with an error.</span>
          <Button variant="outline" size="sm" onClick={clearError}>
            Dismiss
          </Button>
        </div>
      )}

      {sendError === null ? null : (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          {sendError}
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto rounded-lg border bg-background p-3"
      >
        {messages.length === 0 && steers.length === 0 && !busy ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {emptyHint ?? "Nothing yet — the transcript fills in as the agent works."}
          </p>
        ) : (
          messages.map((message) => (
            <MessageRow key={message.id} message={message} renderContent={renderContent} />
          ))
        )}

        {/* Optimistic tail: the operator's own words appear the moment they hit
            send. A steer has no transcript entry until the model consumes it. */}
        {steers.map((steer) => (
          <div
            key={`steer:${steer.id}`}
            className="rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 opacity-60"
          >
            <div className="flex items-baseline gap-2">
              <Caption>steer</Caption>
              <span className="text-[11px] text-muted-foreground">queued for the next step…</span>
            </div>
            <p className="mt-1 text-sm whitespace-pre-wrap break-words">{steer.text}</p>
          </div>
        ))}

        {busy && steers.length === 0 ? (
          <p className="text-center text-xs text-muted-foreground" role="status">
            {chat.isRecovering ? "Recovering the turn…" : "Working…"}
          </p>
        ) : null}
      </div>

      {footer}

      <div className="flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder={
            busy
              ? "Steer the agent mid-answer — Enter to send"
              : (composerPlaceholder ?? "Message the agent — Enter to send, Shift+Enter for a newline")
          }
          aria-label="Message the agent"
          className="min-h-0 flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
        />
        <Button type="button" onClick={send} disabled={draft.trim() === ""}>
          {busy ? "Steer" : "Send"}
        </Button>
      </div>
    </div>
  );
}

/** The loading state: `useAgentChat` suspends while it reads the transcript. */
function TranscriptSkeleton(): ReactNode {
  return (
    <div role="status" aria-label="Loading the run transcript" className="space-y-2 p-3">
      <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
      <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
      <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
      <p className="pt-2 text-sm text-muted-foreground">Loading the run transcript…</p>
    </div>
  );
}

export function AgentSession(props: AgentSessionProps): ReactNode {
  return (
    <ErrorBoundary
      resetKey={props.runId}
      message="This run's transcript could not be loaded. The agent may be mid-deploy, or you may have been signed out of Access."
    >
      <Suspense fallback={<TranscriptSkeleton />}>
        <AgentSessionBody {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
