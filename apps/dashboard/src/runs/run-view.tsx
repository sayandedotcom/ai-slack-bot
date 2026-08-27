/**
 * One run, live.
 *
 * Split in two on purpose. `RunView` is pure — it takes everything it draws as
 * props and opens no socket — so this package's DOM-less test harness
 * (`renderToStaticMarkup`; there is no jsdom here) can pin every state it can
 * be in. `RunSession` is the four lines that wire it to `useRunAgent`.
 *
 * The composer has ONE verb, and that is the whole difference from the view
 * this replaces. Every send is a steer: the worker drops `chat-request` from
 * every connection, so a "send a message" path would fail silently. A steer is
 * spliced into the very next model step, which is what lets a human correct a
 * run without waiting for the current answer to finish.
 *
 * Approvals are NOT decided here. The card renders inside the transcript —
 * a run parks mid-answer and the reader is looking at the transcript, so making
 * them find the queue behind this view is how a customer waits ten minutes for
 * a reply that was already written — but the decision goes out over
 * `PATCH /api/approvals/:id`, which takes the roster check and the D1 CAS.
 */

import { useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { Button } from "@workspace/ui/components/button";

import {
  useRunAgent,
  type ChatMessage,
  type ChatMessagePart,
  type ConnectionState,
  type RunAgentState,
} from "./use-run-agent";

/** How much of a tool payload this pane will show. It is not a JSON viewer. */
export const PAYLOAD_MAX_CHARS = 5_000;

/** What the status pill says, in the operator's words rather than the enum's. */
const STATUS_LABEL: Record<RunAgentState["status"], string> = {
  idle: "Idle",
  live: "Working",
  awaiting_approval: "Waiting on a human",
  done: "Closed",
  failed: "Failed",
};

const STATUS_CLASS: Record<RunAgentState["status"], string> = {
  idle: "border-border text-muted-foreground",
  live: "border-amber-500/50 text-amber-600",
  awaiting_approval: "border-sky-500/50 text-sky-600",
  done: "border-border text-muted-foreground",
  failed: "border-destructive/50 text-destructive",
};

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

/**
 * Clip hard and say so. A tool payload is unbounded — a scraped page, a whole
 * log file — and nobody must read a truncated output as the complete one.
 */
function preview(value: unknown): { text: string; truncated: boolean } {
  let full: string;
  try {
    full =
      typeof value === "string"
        ? value
        : (JSON.stringify(value, null, 2) ?? String(value));
  } catch {
    full = String(value);
  }
  return {
    text: full.slice(0, PAYLOAD_MAX_CHARS),
    truncated: full.length > PAYLOAD_MAX_CHARS,
  };
}

function Caption({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

function Payload({
  label,
  value,
}: {
  label: string;
  value: unknown;
}): ReactNode {
  const { text, truncated } = preview(value);
  return (
    <div className="space-y-1">
      <Caption>{label}</Caption>
      <pre className="overflow-x-auto rounded bg-muted/60 p-2 text-xs leading-snug break-words whitespace-pre-wrap">
        {text}
      </pre>
      {truncated ? (
        <p className="text-[11px] text-muted-foreground">
          … truncated at {PAYLOAD_MAX_CHARS} characters
        </p>
      ) : null}
    </div>
  );
}

/**
 * One `run_code` call.
 *
 * Collapsed by default: every capability call the agent makes is inside one
 * `run_code` payload, so an expanded row is most of the transcript's bytes and
 * almost never what the reader came for. The code, not the raw input object, is
 * what gets shown — that is the interesting half.
 */
function ToolRow({ part }: { part: ChatMessagePart }): ReactNode {
  const [open, setOpen] = useState(false);
  const record = part as { input?: unknown; output?: unknown; state?: unknown };
  const code = (record.input as { code?: unknown } | undefined)?.code;
  const state = typeof record.state === "string" ? record.state : "";

  return (
    <div data-slot="tool-row" className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
      >
        <span aria-hidden="true" className="text-muted-foreground">
          {open ? "▾" : "▸"}
        </span>
        <span className="font-medium">{toolNameOf(part)}</span>
        <span className="ml-auto text-xs text-muted-foreground">{state}</span>
      </button>
      {open ? (
        <div className="space-y-2 border-t px-3 py-2">
          {typeof code === "string" ? (
            <Payload label="code" value={code} />
          ) : record.input === undefined ? null : (
            <Payload label="input" value={record.input} />
          )}
          {record.output === undefined ? null : (
            <Payload label="output" value={record.output} />
          )}
        </div>
      ) : null}
    </div>
  );
}

const ROLE_CLASS: Record<string, string> = {
  user: "border-primary/40 bg-primary/5",
  assistant: "border-border bg-card",
  system: "border-dashed border-border bg-muted/40",
};

function MessageRow({ message }: { message: ChatMessage }): ReactNode {
  const rows: ReactNode[] = [];
  let index = 0;

  for (const part of message.parts) {
    const key = `${message.id}:${index++}`;
    if (part.type === "text") {
      const text = (part as { text?: unknown }).text;
      if (typeof text !== "string" || text === "") continue;
      rows.push(
        <div
          key={key}
          className={`rounded-lg border px-3 py-2 ${ROLE_CLASS[message.role] ?? ROLE_CLASS.system}`}
        >
          <Caption>{message.role}</Caption>
          <p className="mt-1 text-sm break-words whitespace-pre-wrap">{text}</p>
        </div>
      );
      continue;
    }
    if (isToolPart(part)) {
      rows.push(<ToolRow key={key} part={part} />);
      continue;
    }
    // `reasoning` is deliberately not rendered: the provider returns thinking
    // with an empty text field (invariant 17), so there is nothing to show and
    // a row would only advertise a blank. `step-start`, `file` and `source-*`
    // carry nothing this view has a job for; dropped rather than shown as
    // debris.
  }

  return <>{rows}</>;
}

export type RunViewProps = {
  connection: ConnectionState;
  /** The socket was refused outright — usually a signed-out Access session. */
  connectionError: boolean;
  messages: readonly ChatMessage[];
  status: RunAgentState["status"] | null;
  busy: boolean;
  turnError: boolean;
  sendError: string | null;
  onSend: (text: string) => void;
  onDismissError: () => void;
  /** The run's own approval card, rendered inside the transcript. */
  approvals?: ReactNode;
};

export function RunView({
  connection,
  connectionError,
  messages,
  status,
  busy,
  turnError,
  sendError,
  onSend,
  onDismissError,
  approvals,
}: RunViewProps): ReactNode {
  const [draft, setDraft] = useState("");

  const send = () => {
    const text = draft.trim();
    if (text === "") return;
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
    <div data-slot="run-view" className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        {status === null ? null : (
          <span
            data-slot="status-pill"
            className={`rounded-full border px-2 py-0.5 text-[11px] ${STATUS_CLASS[status]}`}
          >
            {STATUS_LABEL[status]}
          </span>
        )}
      </div>

      {/* A socket that has dropped and keeps showing the last transcript is
          lying to whoever is steering an incident, so anything but a healthy
          connection says so above the fold. */}
      {connection === "live" ? null : (
        <div
          role="status"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
        >
          {connection === "reconnecting"
            ? "Reconnecting — you may be seeing a stale view"
            : "Connecting to the run…"}
        </div>
      )}

      {connectionError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
        >
          The run socket was refused. Reload the page — if it keeps happening
          you are probably signed out of Access.
        </div>
      ) : null}

      {turnError ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
        >
          <span>The agent stopped with an error.</span>
          <Button variant="outline" size="sm" onClick={onDismissError}>
            Dismiss
          </Button>
        </div>
      ) : null}

      {sendError === null ? null : (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
        >
          {sendError}
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto rounded-lg border bg-background p-3">
        {messages.length === 0 && !busy ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Nothing yet — the transcript fills in as the agent works.
          </p>
        ) : (
          messages.map((message) => (
            <MessageRow key={message.id} message={message} />
          ))
        )}

        {approvals}

        {busy ? (
          <p
            className="text-center text-xs text-muted-foreground"
            role="status"
          >
            Working…
          </p>
        ) : null}
      </div>

      <div className="flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder="Steer the agent — Enter to send, Shift+Enter for a newline"
          aria-label="Steer the agent"
          className="min-h-0 flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm"
        />
        <Button type="button" onClick={send} disabled={draft.trim() === ""}>
          Steer
        </Button>
      </div>
    </div>
  );
}

/** The wired version. Everything it knows comes from the socket. */
export function RunSession({
  runId,
  approvals,
}: {
  runId: string;
  approvals?: ReactNode;
}): ReactNode {
  const run = useRunAgent(runId);
  return (
    <RunView
      connection={run.connection}
      connectionError={run.connectionError}
      messages={run.messages}
      status={run.status}
      busy={run.busy}
      turnError={run.turnError}
      sendError={run.sendError}
      onSend={run.send}
      onDismissError={run.dismissError}
      approvals={approvals}
    />
  );
}
