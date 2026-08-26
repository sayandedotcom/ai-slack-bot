import type { ApiError } from "./api/errors";

/**
 * Every asynchronous region of the app is in exactly one of these four states.
 * Panels do not invent their own spinners or error strings — they hand a
 * `PanelState` to `Panel` and render only the happy path.
 *
 * The type lives here rather than beside the component so that hooks can
 * produce one without importing a `"use client"` module into their graph.
 */
export type PanelState<T> =
  | { kind: "loading" }
  | { kind: "error"; error: ApiError; retry: () => void }
  | { kind: "empty"; hint: string }
  | { kind: "ready"; data: T };
