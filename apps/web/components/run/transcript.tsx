"use client";

import { ChevronRight, Code2, Flame, User } from "lucide-react";
import { useState } from "react";

import { cn } from "@workspace/ui/lib/utils";

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
};

/** How much of a tool payload this pane will show. It is not a JSON viewer. */
export const PAYLOAD_MAX_CHARS = 5_000;

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
    full = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
  } catch {
    full = String(value);
  }
  return { text: full.slice(0, PAYLOAD_MAX_CHARS), truncated: full.length > PAYLOAD_MAX_CHARS };
}

export function Transcript({ messages }: { messages: readonly TranscriptMessage[] }) {
  return (
    <ol className="space-y-5">
      {messages.map((message) => (
        <li key={message.id}>
          <MessageRow message={message} />
        </li>
      ))}
    </ol>
  );
}

function MessageRow({ message }: { message: TranscriptMessage }) {
  const isAgent = message.role !== "user";
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
            "text-sm text-pretty whitespace-pre-wrap",
            !isAgent && "rounded-lg rounded-tl-sm bg-muted/60 px-3 py-2",
          )}
        >
          {text}
        </p>,
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

  if (rows.length === 0) return null;

  return (
    <div className="flex gap-3">
      <span
        aria-hidden="true"
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-medium",
          isAgent ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
        )}
      >
        {isAgent ? <Flame className="size-3.5" /> : <User className="size-3.5" />}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <span className="eyebrow">{isAgent ? "Firefighter" : "You"}</span>
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
function ToolRow({ part }: { part: unknown }) {
  const [open, setOpen] = useState(false);
  const record = part as { input?: unknown; output?: unknown; state?: unknown };
  const code = (record.input as { code?: unknown } | undefined)?.code;
  const state = typeof record.state === "string" ? record.state : "";

  return (
    <div data-slot="tool-row" className="overflow-hidden rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <Code2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="machine text-xs">{toolNameOf(part)}</span>
        {state === "" ? null : <span className="eyebrow ml-auto">{state}</span>}
      </button>
      {open ? (
        <div className="space-y-2 border-t px-3 py-2">
          {typeof code === "string" ? (
            <Payload label="code" value={code} />
          ) : record.input === undefined ? null : (
            <Payload label="input" value={record.input} />
          )}
          {record.output === undefined ? null : <Payload label="output" value={record.output} />}
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
      <pre className="machine overflow-x-auto rounded bg-muted/60 p-2 text-[11px] leading-relaxed break-words whitespace-pre-wrap">
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
