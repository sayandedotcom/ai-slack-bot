"use client";

import { StatusBadge } from "@workspace/ui/components/status-badge";
import { cn } from "@workspace/ui/lib/utils";
import { ChevronRight, Code2, Flame, User } from "lucide-react";
import { useState } from "react";

/**
 * One run's transcript.
 *
 * The parts arrive as `unknown` on purpose. Two callers feed this: the live
 * socket, whose part union comes from the AI SDK and changes with it, and the
 * demo fixture. Narrowing here — rather than typing the prop as the SDK's union
 * — keeps the SDK out of a component the test harness renders, and makes an
 * unrecognised part a thing that is DROPPED rather than a thing that crashes a
 * transcript somebody is reading during an incident.
 *
 * Type carries provenance, as everywhere else in this app: the agent's prose is
 * set in sans because the product's claim is that it reads as though a person
 * wrote it, and the mechanical half of a turn — the code it ran, what came back
 * — is mono.
 */

export type TranscriptMessage = {
  id: string;
  role: string;
  parts: readonly unknown[];
  metadata?: unknown;
};

/** How much of a tool payload this pane will show. It is not a JSON viewer. */
export const PAYLOAD_MAX_CHARS = 5_000;

/**
 * The turn a message belongs to, as the Worker stamps it: `metadata: {
 * inputRevision, turnId: messageId }` on the user message that opened the
 * turn. A message with no metadata (the demo fixture, an older message shape)
 * has no turn id — callers fall back to the message's own id, which is enough
 * to key a chip strip even when it can never match the effect ledger's ids.
 */
export function turnIdOf(message: TranscriptMessage): string | null {
  const meta = message.metadata;
  if (typeof meta !== "object" || meta === null) return null;
  const id = (meta as { turnId?: unknown }).turnId;
  return typeof id === "string" && id !== "" ? id : null;
}

function partType(part: unknown): string {
  if (typeof part !== "object" || part === null) return "";
  const type = (part as { type?: unknown }).type;
  return typeof type === "string" ? type : "";
}

export function isToolPart(part: unknown): boolean {
  const type = partType(part);
  return type.startsWith("tool-") || type === "dynamic-tool";
}

/** `tool-run_code` → `run_code`; a dynamic part carries its own name. */
function toolNameOf(part: unknown): string {
  const type = partType(part);
  if (type === "dynamic-tool") {
    const named = part as { toolName?: unknown };
    return typeof named.toolName === "string" ? named.toolName : "tool";
  }
  return type.slice("tool-".length);
}

function textOf(part: unknown): string | null {
  if (partType(part) !== "text") return null;
  const text = (part as { text?: unknown }).text;
  return typeof text === "string" && text !== "" ? text : null;
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

export function Transcript({
  messages,
  chips,
  origin,
}: {
  messages: readonly TranscriptMessage[];
  /** This turn's capability chips, keyed by `turnIdOf`. From `chipsByTurn`. */
  chips?: ReadonlyMap<string, readonly string[]>;
  /** Decides whether a `user` message is the customer or the operator — see `speakerOf`. */
  origin?: string;
}) {
  // The turn a row belongs to is whichever user message came before it — so a
  // tool row is walked in order, tracking the last user turn seen, rather than
  // looked up independently per row.
  let currentTurn: string | null = null;
  return (
    <ol className="space-y-5">
      {messages.map((message) => {
        if (message.role === "user") {
          currentTurn = turnIdOf(message) ?? message.id;
        }
        const turnChips =
          currentTurn === null ? null : (chips?.get(currentTurn) ?? null);
        return (
          <li key={message.id}>
            <MessageRow message={message} chips={turnChips} origin={origin} />
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Who said this, in the reader's own vocabulary.
 *
 * A `user` message is NOT always the operator. On a Slack-woken run the
 * opening message — and every later message the thread absorbs — is the
 * CUSTOMER's, and labelling their words "You" tells the reader they wrote
 * something they never did. On a chat run the same role really is the
 * operator. A steer is always the operator, whichever origin it lands in,
 * and it is distinguishable because the Worker mints its message id as
 * `steer:{requestId}` (`apps/worker/src/run/agent.ts`).
 *
 * The agent stays "Fire-Fighter" and never becomes "You": in this transcript
 * a customer-facing reply is still a DRAFT awaiting approval. It goes out
 * under a person's own account only after they approve it, so claiming their
 * authorship here would be a lie about who committed to what.
 */
export function speakerOf(
  message: TranscriptMessage,
  origin: string | undefined
): string {
  if (message.role !== "user") return "Fire-Fighter";
  if (message.id.startsWith("steer:")) return "You";
  return origin === "slack" ? "Customer" : "You";
}

function MessageRow({
  message,
  chips,
  origin,
}: {
  message: TranscriptMessage;
  chips: readonly string[] | null;
  origin: string | undefined;
}) {
  const isAgent = message.role !== "user";
  const speaker = speakerOf(message, origin);
  const rows: React.ReactNode[] = [];
  let index = 0;

  for (const part of message.parts) {
    const key = `${message.id}:${index++}`;
    const text = textOf(part);
    if (text !== null) {
      rows.push(
        <p
          key={key}
          className={cn(
            "whitespace-pre-wrap text-pretty text-sm",
            !isAgent && "rounded-lg rounded-tl-sm bg-muted/60 px-3 py-2"
          )}
        >
          {text}
        </p>
      );
      continue;
    }
    if (isToolPart(part)) {
      rows.push(<ToolRow key={key} part={part} chips={chips} />);
    }
    // `reasoning` is deliberately not rendered: the provider returns thinking
    // with an empty text field (invariant 17), so there is nothing to show and
    // a row would only advertise a blank. `step-start`, `file` and `source-*`
    // carry nothing this view has a job for; dropped rather than shown as
    // debris.
  }

  if (rows.length === 0) return null;

  return (
    <div className="flex gap-3">
      <span
        aria-hidden="true"
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-lg font-medium text-[11px]",
          isAgent
            ? "bg-primary/15 text-primary"
            : "bg-muted text-muted-foreground"
        )}
      >
        {isAgent ? (
          <Flame className="size-3.5" />
        ) : (
          <User className="size-3.5" />
        )}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <span className="eyebrow">{speaker}</span>
        {rows}
      </div>
    </div>
  );
}

/**
 * One `run_code` call.
 *
 * Collapsed by default: every capability call the agent makes is inside one
 * `run_code` payload, so an expanded row is most of the transcript's bytes and
 * almost never what the reader came for. The CODE, not the raw input object, is
 * what gets shown — that is the interesting half.
 *
 * A plain button rather than the Collapsible primitive, because the row has to
 * survive being rendered with no client JS in the test harness and the open
 * state is a single boolean.
 */
function ToolRow({
  part,
  chips,
}: {
  part: unknown;
  chips: readonly string[] | null;
}) {
  const [open, setOpen] = useState(false);
  const record = part as { input?: unknown; output?: unknown; state?: unknown };
  const code = (record.input as { code?: unknown } | undefined)?.code;
  const state = typeof record.state === "string" ? record.state : "";

  return (
    <div
      data-slot="tool-row"
      className="overflow-hidden rounded-lg border bg-card"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
        <Code2
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        {chips && chips.length > 0 ? (
          <span className="flex min-w-0 flex-wrap gap-1">
            {chips.map((c) => (
              <StatusBadge
                key={c}
                tone="neutral"
                variant="outline"
                size="sm"
                mono
              >
                {c}
              </StatusBadge>
            ))}
          </span>
        ) : (
          <span className="machine text-xs">
            {toolNameOf(part)}
            {typeof code === "string" ? ` · ${code.length} chars` : ""}
          </span>
        )}
        {state === "" ? null : <span className="eyebrow ml-auto">{state}</span>}
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

function Payload({ label, value }: { label: string; value: unknown }) {
  const { text, truncated } = preview(value);
  return (
    <div className="space-y-1">
      <span className="eyebrow">{label}</span>
      <pre className="machine overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 text-[11px] leading-relaxed">
        {text}
      </pre>
      {truncated ? (
        <p className="text-[11px] text-muted-foreground">
          … truncated at {PAYLOAD_MAX_CHARS.toLocaleString("en-US")} characters
        </p>
      ) : null}
    </div>
  );
}
