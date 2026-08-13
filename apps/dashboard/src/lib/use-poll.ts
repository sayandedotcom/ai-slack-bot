import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "./api";
import type { PanelState } from "../components/panel";

type Snapshot<T> =
  | { kind: "loading" }
  | { kind: "error"; error: ApiError }
  | { kind: "ready"; data: T };

/**
 * Fetch now, then again every `intervalMs`, and hold the last good data across
 * background refreshes. A panel that already has data never falls back to a
 * spinner or an error banner because one poll failed — it keeps showing what it
 * has. Only a cold visitor, with nothing to show yet, sees `loading`/`error`.
 */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  intervalMs: number
): PanelState<T> & { refresh: () => void } {
  const [snapshot, setSnapshot] = useState<Snapshot<T>>({ kind: "loading" });

  // The fetcher is usually an inline arrow; keeping it in a ref means a new
  // identity each render does not restart the interval.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const aliveRef = useRef(true);
  // Ignore an in-flight response once a newer request has been started.
  const requestRef = useRef(0);

  const run = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const data = await fetcherRef.current();
      if (!aliveRef.current || request !== requestRef.current) return;
      setSnapshot({ kind: "ready", data });
    } catch (cause) {
      if (!aliveRef.current || request !== requestRef.current) return;
      const error =
        cause instanceof ApiError
          ? cause
          : new ApiError(0, "unavailable", "request");
      // Downgrade to `error` only when there is nothing better to show.
      setSnapshot((current) =>
        current.kind === "ready" ? current : { kind: "error", error }
      );
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void run();
    const timer = setInterval(() => void run(), intervalMs);
    return () => {
      aliveRef.current = false;
      clearInterval(timer);
    };
  }, [run, intervalMs]);

  const refresh = useCallback(() => {
    void run();
  }, [run]);

  if (snapshot.kind === "ready") {
    return { kind: "ready", data: snapshot.data, refresh };
  }
  if (snapshot.kind === "error") {
    return { kind: "error", error: snapshot.error, retry: refresh, refresh };
  }
  return { kind: "loading", refresh };
}
