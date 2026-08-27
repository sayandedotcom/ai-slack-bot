"use client";

import { useSyncExternalStore } from "react";

/**
 * A clock components can render against.
 *
 * `Date.now()` inside render is impure twice over: it differs between the
 * server pass and the hydration render, and it makes a component's output
 * depend on when React happened to run it. Every relative timestamp on the page
 * reads from here instead.
 *
 * One interval for the whole page rather than one per list, and a snapshot that
 * is stable within a render pass. The tick is coarse because `ago()` is coarse
 * — anything faster would re-render the feed to change nothing.
 */
const TICK_MS = 30_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let now = 0;

function notify(): void {
  now = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (timer === undefined) {
    timer = setInterval(notify, TICK_MS);
    // The server snapshot is 0, so the first client paint would otherwise sit
    // on it for a whole tick. One immediate correction, through the normal
    // notify path so React learns about it.
    queueMicrotask(notify);
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/**
 * `getServerSnapshot` returns 0 so the server pass and the hydration render
 * agree. Callers pass it straight to `ago()`, which clamps a "future"
 * timestamp to "just now" — so the pre-hydration frame reads as fresh rather
 * than as a negative age, and corrects a microtask later.
 */
/**
 * The client snapshot. `useSyncExternalStore` calls this during render and
 * demands a value that does not change between calls, so the first one seeds
 * the module-scope clock and every later one reads it — the tick in
 * `subscribe` is the only thing that moves it.
 */
function getSnapshot(): number {
  if (now === 0) now = Date.now();
  return now;
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}
