/**
 * The dashboard's only door to the network. Components never call `fetch`
 * themselves: every request goes through `getJson`, so there is exactly one
 * place that decides how a failure is classified and exactly one place that
 * can leak. Paths are relative — the SPA and the API share an origin, so no
 * backend URL and no token ever reaches the bundle.
 */

/** How a failure should be explained to a human, independent of the status number. */
export type ApiErrorKind = "unauthorized" | "forbidden" | "unavailable";

export class ApiError extends Error {
  readonly status: number;
  readonly kind: ApiErrorKind;

  constructor(status: number, kind: ApiErrorKind, path: string) {
    // The message carries the path and nothing else. Response bodies can hold
    // stack traces, hostnames and tokens; they never make it into an Error
    // that might end up in a log, a toast, or a screenshot.
    super(`${path} failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.kind = kind;
  }
}

function kindFor(status: number): ApiErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  return "unavailable";
}

/**
 * GET a relative JSON endpoint. Throws `ApiError` for anything that is not a
 * parsed 2xx body — a transport failure and an unreadable body are both
 * "unavailable", because from the panel's point of view they are the same.
 */
export async function getJson<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { accept: "application/json" },
      credentials: "same-origin",
    });
  } catch {
    // Status 0: there was no HTTP response at all.
    throw new ApiError(0, "unavailable", path);
  }

  if (!response.ok) {
    throw new ApiError(response.status, kindFor(response.status), path);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(response.status, "unavailable", path);
  }
}

export type Role = "firefighter" | "viewer";

export type Identity = {
  email: string;
  role: Role;
};

export type Shift = {
  email: string;
  index: number;
  shiftStartMs: number;
  shiftEndMs: number;
  nextEmail: string;
};

export type ConnectStatus = {
  email: string;
  role: Role;
  slack: boolean;
  github: boolean;
};

export type Roster = {
  onDuty: Shift;
  rotation: string[];
  engineers: ConnectStatus[];
};

export type Counters = {
  counters: {
    seen: number;
    triaged: number;
    woken: number;
    escalated: number;
  };
  since: number;
};

export const getIdentity = () => getJson<Identity>("/api/identity");
export const getRoster = () => getJson<Roster>("/api/roster");
export const getCounters = () => getJson<Counters>("/api/counters");
