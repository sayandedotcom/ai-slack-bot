/**
 * How a failure should be explained to a human, independent of the status
 * number. Ported unchanged from the Vite dashboard: the two front-ends must
 * classify the same 403 the same way, or an operator switching between them
 * gets two different explanations for one cause.
 */
export type ApiErrorKind = "unauthorized" | "forbidden" | "unavailable";

export class ApiError extends Error {
  readonly status: number;
  readonly kind: ApiErrorKind;

  constructor(status: number, kind: ApiErrorKind, path: string) {
    // The message carries the path and nothing else. Response bodies can hold
    // stack traces, hostnames and tokens; they never make it into an Error that
    // might end up in a log, a toast, or a screenshot. This is invariant 39's
    // front-end half.
    super(`${path} failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.kind = kind;
  }
}

export function kindFor(status: number): ApiErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  return "unavailable";
}

/** Narrow an unknown catch binding without losing the classification. */
export function asApiError(cause: unknown, path: string): ApiError {
  return cause instanceof ApiError
    ? cause
    : new ApiError(0, "unavailable", path);
}
