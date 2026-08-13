/**
 * The run session hook: snapshot for an instant paint, socket for the live tail,
 * and a steer path that prefers the socket but never depends on it. All the
 * ordering logic lives in `reduceSession`; this file owns only the I/O and the
 * timers.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchRunSnapshot, postSteer } from "./api";
import {
  initialSession,
  reduceSession,
  withPendingSteer,
  type RunEvent,
  type RunServerMessage,
  type SessionState,
} from "./session-reducer";
import { openRunSocket, type Connection, type RunSocket } from "./socket";

/** How long a socket steer may go unacked before HTTP takes over. */
const ACK_TIMEOUT_MS = 3_000;

export function useRunSession(runId: string): {
  session: SessionState;
  connection: Connection;
  steer: (content: string) => void;
} {
  const [session, setSession] = useState<SessionState>(initialSession);
  const [connection, setConnection] = useState<Connection>("connecting");

  /**
   * The cursor mirrored out of state. `since()` runs inside the socket's
   * reconnect, long after the effect's closure was created, so reading React
   * state there would resume from a stale seq and replay events we already have.
   */
  const cursorRef = useRef(0);
  const socketRef = useRef<RunSocket | null>(null);
  /** requestId -> ack-timeout timer, so an ack (or unmount) can cancel it. */
  const ackTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const runIdRef = useRef(runId);
  runIdRef.current = runId;

  const apply = useCallback((message: RunServerMessage) => {
    // An ack settles the steer, so its fallback timer is dead weight; clearing
    // it here is what stops a successful socket steer from also POSTing.
    const settled =
      message.type === "ack" ? message.requestId : message.type === "error" ? message.requestId : undefined;
    if (settled !== undefined) {
      const timer = ackTimersRef.current.get(settled);
      if (timer !== undefined) {
        clearTimeout(timer);
        ackTimersRef.current.delete(settled);
      }
    }
    setSession((previous) => {
      const next = reduceSession(previous, message);
      cursorRef.current = next.cursor;
      return next;
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    cursorRef.current = 0;
    setSession(initialSession());
    setConnection("connecting");

    const socket = openRunSocket(runId, {
      since: () => cursorRef.current,
      onMessage: (message) => {
        if (disposed) return;
        apply(message);
      },
      onConnection: (next) => {
        if (disposed) return;
        setConnection(next);
      },
    });
    socketRef.current = socket;

    // Fired alongside the socket, not before it: the snapshot only needs to beat
    // the first frame to the screen, and the socket's own `sync` is authoritative
    // if it lands first — the reducer rebuilds from either without duplicating.
    void fetchRunSnapshot(runId)
      .then(({ sync }) => {
        if (disposed) return;
        // The snapshot loses to anything newer. A `sync` REBUILDS the transcript
        // from its own events (that is what makes reconnect replay
        // duplicate-proof), so applying a snapshot taken at cursor 20 after the
        // socket has already streamed 21..25 would silently delete those five
        // events — and the socket will never send them again. Racing the two is
        // fine; letting the loser overwrite the winner is not.
        if (cursorRef.current > sync.cursor) return;
        // The one cast at the seam: `RunSync.events` is `unknown[]` because
        // `api.ts` does not model the event union, and `RunEvent` here is the
        // mirror of the worker's protocol that the reducer folds.
        apply({ ...sync, events: sync.events as RunEvent[] });
      })
      .catch(() => {
        if (disposed) return;
        apply({
          type: "error",
          code: "snapshot_failed",
          message: "Could not load this run's transcript.",
        });
      });

    const timers = ackTimersRef.current;
    return () => {
      disposed = true;
      socketRef.current = null;
      socket.close();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [runId, apply]);

  const steer = useCallback(
    (content: string) => {
      const requestId = crypto.randomUUID();
      setSession((previous) => withPendingSteer(previous, requestId, content));

      const fallback = () => {
        ackTimersRef.current.delete(requestId);
        // The SAME requestId as the socket attempt. The worker keys the turn
        // `steer:{requestId}`, so if the socket message did land and we simply
        // never saw the ack, this POST dedupes onto that turn instead of
        // steering the agent twice.
        void postSteer(runIdRef.current, requestId, content)
          .then((result) => {
            // Synthesised locally: the reducer's `ack` branch is exactly the
            // "this steer is settled" transition, so the HTTP path reuses it.
            apply({ type: "ack", requestId, seq: result.seq });
          })
          .catch(() => {
            // Errors carrying a requestId release the pending steer as well as
            // surfacing the failure, so nothing is left in-flight forever.
            apply({
              type: "error",
              code: "steer_failed",
              message: "Could not send that steer. Try again.",
              requestId,
            });
          });
      };

      // The composer's entire wire format: `role`, `source`, `id`, `seq`,
      // `createdAt` and `metadata` are server-owned and the worker's
      // `parseClientMessage` rejects a frame that carries any of them.
      const sent = socketRef.current?.send({ type: "steer", requestId, content }) ?? false;
      if (!sent) {
        fallback();
        return;
      }
      ackTimersRef.current.set(requestId, setTimeout(fallback, ACK_TIMEOUT_MS));
    },
    [apply],
  );

  return { session, connection, steer };
}
