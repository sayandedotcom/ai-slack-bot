/**
 * The approvals half of the dashboard's network surface. Reads go through
 * `getJson` from `../lib/api`; the decision write goes through the local
 * `patchJson` below, which repeats that module's error discipline rather than
 * widening it — `lib/api` has no reason to learn about PATCH.
 *
 * `decide` is the odd one out and deliberately so: it never throws. A 409 is
 * not a failure, it is the answer "someone else decided first, and here is
 * what they chose" — the UI has to render that winner, so it must arrive as a
 * value, not as an exception the caller has to unwrap.
 */

import { ApiError, getJson } from "../lib/api";

/** A row in the open-approvals list, exactly as the worker's summary select returns it. */
export type OpenApproval = {
  id: string;
  runId: string;
  draft: string;
  why: string;
  channelId: string;
  threadTs: string;
  createdAt: number;
};

export type Decision = "pending" | "approved" | "edited" | "rejected" | "withdrawn";

/** The full card: the summary plus everything the decision itself produced. */
export type ApprovalDetail = OpenApproval & {
  updatedAt: number;
  decision: Decision;
  decidedBy: string | null;
  decidedAt: number | null;
  editedText: string | null;
  rejectReason: string | null;
  delivery: string;
};

export type DecideAction =
  | { action: "approve" }
  | { action: "edit"; text: string }
  | { action: "reject"; reason: string };

export type DecideResult =
  | { result: "decided"; decision: Decision }
  | { result: "already_decided"; decision: Decision; decidedBy: string | null }
  | { result: "error"; error: ApiError };

/**
 * PATCH a relative JSON endpoint, returning the status alongside the parsed
 * body so the caller can treat a 409 as data. Mirrors `getJson` otherwise:
 * same-origin, and a body that fails to parse is indistinguishable from the
 * endpoint being unavailable.
 */
async function patchJson(
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "PATCH",
      headers: { accept: "application/json", "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
  } catch {
    // Status 0: there was no HTTP response at all.
    throw new ApiError(0, "unavailable", path);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ApiError(response.status, kindFor(response.status), path);
  }

  return { status: response.status, body: parsed };
}

function kindFor(status: number): ApiError["kind"] {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  return "unavailable";
}

export async function fetchOpenApprovals(): Promise<OpenApproval[]> {
  const body = await getJson<{ approvals: OpenApproval[] }>("/api/approvals?state=open");
  return body.approvals;
}

export async function fetchApproval(id: string): Promise<ApprovalDetail> {
  const body = await getJson<{ approval: ApprovalDetail }>(
    `/api/approvals/${encodeURIComponent(id)}`,
  );
  return body.approval;
}

/**
 * Decide an approval. Returns rather than throws so that the two outcomes a
 * human actually cares about — "you decided it" and "someone beat you to it" —
 * are both ordinary values; only genuinely broken responses become errors, and
 * those carry an `ApiError` that names the path and nothing from the body.
 */
export async function decide(id: string, action: DecideAction): Promise<DecideResult> {
  const path = `/api/approvals/${encodeURIComponent(id)}`;

  let response: { status: number; body: unknown };
  try {
    response = await patchJson(path, action);
  } catch (error) {
    return {
      result: "error",
      error: error instanceof ApiError ? error : new ApiError(0, "unavailable", path),
    };
  }

  if (response.status === 200) {
    const body = response.body as { approval?: ApprovalDetail } | null;
    const decision = body?.approval?.decision;
    // A 200 without a usable card is a contract break, not a decision.
    if (!decision) return { result: "error", error: new ApiError(200, "unavailable", path) };
    return { result: "decided", decision };
  }

  if (response.status === 409) {
    const body = response.body as { decision?: Decision } | null;
    // The worker's conflict body carries `decision` only — there is no
    // `decidedBy` on this path, so the winner has no name to show. Kept in the
    // shape as `null` so callers compile against one `DecideResult`.
    const decision = body?.decision;
    if (!decision) return { result: "error", error: new ApiError(409, "unavailable", path) };
    return { result: "already_decided", decision, decidedBy: null };
  }

  return {
    result: "error",
    error: new ApiError(response.status, kindFor(response.status), path),
  };
}
