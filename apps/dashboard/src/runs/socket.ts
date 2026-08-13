/**
 * The run WebSocket client: one long-lived connection per run, resumed from a
 * cursor the caller owns. Deliberately framework-free — no React, no state
 * library — so the reconnect behaviour is a plain object the hook drives.
 */

import type { RunClientMessage, RunServerMessage } from "./session-reducer";

export type Connection = "connecting" | "open" | "reconnecting" | "closed";

/** 1s → 2s → 4s → 8s → 15s. Bounded so a long outage never parks the UI. */
const FIRST_DELAY_MS = 1_000;
const MAX_DELAY_MS = 15_000;

export type RunSocket = {
  /** False when the socket is not open, which is the caller's cue to fall back to HTTP. */
  send: (message: RunClientMessage) => boolean;
  close: () => void;
};

export function openRunSocket(
  runId: string,
  opts: {
    /**
     * Read at every (re)connect rather than captured once: after a drop we must
     * resume from the newest applied seq, not from the cursor we had when the
     * socket was first opened, or the replay would re-send the whole transcript.
     */
    since: () => number;
    onMessage: (message: RunServerMessage) => void;
    onConnection: (connection: Connection) => void;
  },
): RunSocket {
  // Derived from the page's own origin: the socket is same-origin by
  // construction, so there is no host to misconfigure and no cookie to leak.
  const scheme = location.protocol === "https:" ? "wss" : "ws";

  let socket: WebSocket | null = null;
  let delay = FIRST_DELAY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by `close()`. The close handler consults it so a deliberate teardown
   * (unmount, run change) is never mistaken for a dropped connection. */
  let closed = false;

  function connect(): void {
    if (closed) return;
    const url = `${scheme}://${location.host}/ws/run/${encodeURIComponent(runId)}?since=${opts.since()}`;
    const next = new WebSocket(url);
    socket = next;

    next.onopen = () => {
      if (closed) return;
      // A connection that survived to `open` is healthy: forget the previous
      // backoff so a later, unrelated drop reconnects fast again.
      delay = FIRST_DELAY_MS;
      opts.onConnection("open");
    };

    next.onmessage = (event) => {
      if (closed) return;
      let parsed: RunServerMessage;
      try {
        parsed = JSON.parse(String(event.data)) as RunServerMessage;
      } catch {
        // Never throw out of the handler: a single bad frame must not kill the
        // socket, so it is surfaced as a protocol error the reducer can render.
        opts.onMessage({
          type: "error",
          code: "bad_frame",
          message: "The server sent a frame the dashboard could not parse.",
        });
        return;
      }
      opts.onMessage(parsed);
    };

    // `onerror` is followed by `onclose`, so all retry scheduling lives there.
    next.onclose = () => {
      if (closed) return;
      socket = null;
      opts.onConnection("reconnecting");
      retryTimer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    };
  }

  opts.onConnection("connecting");
  connect();

  return {
    send(message) {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    },
    close() {
      closed = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      const open = socket;
      socket = null;
      open?.close();
      opts.onConnection("closed");
    },
  };
}
