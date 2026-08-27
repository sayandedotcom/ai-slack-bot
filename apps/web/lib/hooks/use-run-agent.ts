"use client";

import { useAgentChat } from "@cloudflare/think/react";
import { useAgent } from "agents/react";
import { useCallback, useMemo, useState } from "react";

import { socketHost } from "../api/socket-host";

/**
 * The run socket, and the one thing a human may say down it.
 *
 * `useAgent` opens the WebSocket and `useAgentChat` owns the transcript, the
 * stream resumption and the recovery flags. There is no bespoke frame protocol
 * here and no reducer: the session tree in the Durable Object is authoritative
 * and this file only reads it.
 *
 * THE ONLY WRITE IS `steer`. The Worker drops `cf_agent_use_chat_request`,
 * `cf_agent_chat_clear`, `cf_agent_chat_request_cancel`, `cf_agent_tool_result`
 * and `cf_agent_tool_approval` from every connection
 * (`apps/worker/src/run/transport.ts`), so `sendMessage` — which sends a chat
 * request — would fail silently. That is deliberate: human input enters a run
 * through one audited method that stamps an input revision, and approvals are
 * decided over `PATCH /api/approvals/:id`, which takes the roster check and the
 * D1 CAS first.
 *
 * Ported from the Vite dashboard's `src/runs/use-run-agent.ts`, with one
 * addition: `host`. The dashboard is served by the Worker, so its socket
 * resolves against its own origin; this app may not be, and a Next rewrite
 * cannot carry a WebSocket upgrade. See `lib/api/socket-host.ts`.
 */

/**
 * `RunAgent`'s durable state, as the socket broadcasts it.
 *
 * Declared here rather than imported: the Worker is a separate package, and a
 * shared type would make this app depend on it. This is the wire shape.
 */
export type RunAgentState = {
  runId: string | null;
  turnId: string | null;
  status: "idle" | "live" | "awaiting_approval" | "done" | "failed";
  openApprovalId: string | null;
  lastApprovalId: string | null;
  channel: "slack" | "web";
  inputRevision: number;
};

/**
 * Where the socket connects.
 *
 * `runs.id`, never the run key: the Worker resolves one to the other through D1
 * before it names the Durable Object, which is what keeps invariant 10 intact.
 * Relative, with no leading slash — partysocket builds `${host}/${basePath}`.
 * Under `/api` so it inherits the Worker's own Access application; a top-level
 * path would be a second surface to remember to gate.
 */
export function agentBasePath(runId: string): string {
  return `api/runs/${encodeURIComponent(runId)}/agent`;
}

/** What the reader is told about the socket, as one word. */
export type ConnectionState = "connecting" | "live" | "reconnecting";

export type SteerSender = {
  /** Send one steer. Resolves when the agent has taken it. */
  submit(text: string): Promise<void>;
};

/**
 * One steer per submission, and one submission per distinct text in flight.
 *
 * A double-click, an Enter held down, a re-render that fires the handler twice
 * — all of them are one thing the human meant, so the second call joins the
 * first promise instead of minting a second request id. Two DIFFERENT texts
 * typed quickly are two steers, because they are.
 *
 * A retry AFTER a visible failure gets a fresh id on purpose: the human has
 * seen it fail and is asserting it again, and reusing the id would have the
 * agent refuse the second attempt as a duplicate of one that may never have
 * arrived.
 *
 * Pure, and takes its id source as an argument, so the dedupe is testable
 * without a socket or a clock.
 */
export function makeSteerSender(
  send: (text: string, requestId: string) => Promise<unknown>,
  mintId: () => string = () => crypto.randomUUID()
): SteerSender {
  const inFlight = new Map<string, Promise<void>>();

  return {
    async submit(text: string): Promise<void> {
      const body = text.trim();
      if (body === "") return;

      const existing = inFlight.get(body);
      if (existing !== undefined) return existing;

      const attempt = send(body, mintId())
        .then(() => undefined)
        .finally(() => {
          inFlight.delete(body);
        });
      inFlight.set(body, attempt);
      return attempt;
    },
  };
}

/**
 * The message type, derived from the hook rather than imported: same type, one
 * less direct dependency, and it cannot drift from the SDK version the hook was
 * built against.
 */
type ChatApi = ReturnType<typeof useAgentChat<RunAgentState>>;
export type AgentMessage = ChatApi["messages"][number];

export type RunAgentView = {
  connection: ConnectionState;
  /** The socket was refused outright — usually a signed-out Access session. */
  connectionError: boolean;
  messages: readonly AgentMessage[];
  /** The run's own status, from the state frame. Null until the first one. */
  status: RunAgentState["status"] | null;
  busy: boolean;
  turnError: boolean;
  sendError: string | null;
  send: (text: string) => void;
  dismissError: () => void;
};

export function useRunAgent(runId: string): RunAgentView {
  const [connected, setConnected] = useState(false);
  // Set once the socket has closed at least once, so "connecting" and
  // "reconnecting" can say different, honest things. STATE, not a ref: it is
  // read to decide what the banner says, and a ref read during render is the
  // shape that leaves a component showing "Connecting…" after it reconnected.
  const [dropped, setDropped] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const agent = useAgent<RunAgentState>({
    agent: "run-agent",
    basePath: agentBasePath(runId),
    host: socketHost(),
    onOpen: () => setConnected(true),
    onClose: () => {
      setDropped(true);
      setConnected(false);
    },
  });

  const chat = useAgentChat<RunAgentState>({
    agent,
    // NULL, NOT OMITTED. The default fetches `/get-messages` with React's
    // `use()`, which SUSPENDS — a rejected promise thrown out of render blanks
    // the page and needs a Suspense boundary and an error boundary to contain.
    // The transcript arrives as the `cf_agent_chat_messages` connect frame
    // anyway, so the fetch buys a second copy of what the socket already sends.
    getInitialMessages: null,
    // `include`, not `same-origin`: on Vercel the socket's sibling reads cross
    // an origin. It changes nothing when the two origins are the same.
    credentials: "include",
  });

  // `agent.call`, not `agent.stub.steer`. An untyped stub is
  // `Record<string, Method>` (`agents/dist/client.d.ts`), so under
  // `noUncheckedIndexedAccess` every method on it is possibly undefined and
  // reaching one costs a non-null assertion — which would turn "the method was
  // renamed" into a runtime crash instead of a compile error. `call` names the
  // method as data and is the same RPC over the same socket.
  const steer = useMemo(
    () =>
      makeSteerSender((text, requestId) =>
        agent.call("steer", [text, requestId])
      ),
    [agent]
  );

  const send = useCallback(
    (text: string) => {
      setSendError(null);
      void steer.submit(text).catch(() => {
        setSendError("Could not send that. Try again.");
      });
    },
    [steer]
  );

  const clearError = chat.clearError;
  const dismissError = useCallback(() => {
    setSendError(null);
    clearError();
  }, [clearError]);

  return {
    connection: connected ? "live" : dropped ? "reconnecting" : "connecting",
    connectionError:
      chat.connectionError !== null && chat.connectionError !== undefined,
    messages: chat.messages,
    status: agent.state?.status ?? null,
    busy: chat.isStreaming || chat.isRecovering || chat.status === "submitted",
    turnError: chat.error !== undefined,
    sendError,
    send,
    dismissError,
  };
}
