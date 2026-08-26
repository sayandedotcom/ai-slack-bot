import { fixture, getJson, isDemo, patchJson } from "./client";
import { ApiError, kindFor } from "./errors";
import { decideDemoApproval, listDemoApprovals } from "../fixtures/approvals";

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

export async function getOpenApprovals(): Promise<OpenApproval[]> {
  if (isDemo()) return fixture(listDemoApprovals());
  const body = await getJson<{ approvals: OpenApproval[] }>("/api/approvals?state=open");
  return body.approvals;
}

/**
 * Decide an approval. Returns rather than throws, because the two outcomes a
 * human actually cares about — "you decided it" and "someone beat you to it" —
 * are both ordinary values the UI has to render. Only genuinely broken
 * responses become errors, and those carry an `ApiError` naming the path and
 * nothing from the body.
 */
export async function decide(id: string, action: DecideAction): Promise<DecideResult> {
  const path = `/api/approvals/${encodeURIComponent(id)}`;

  if (isDemo()) return fixture(decideDemoApproval(id, action));

  let response: { status: number; body: unknown };
  try {
    response = await patchJson(path, action);
  } catch (cause) {
    return {
      result: "error",
      error: cause instanceof ApiError ? cause : new ApiError(0, "unavailable", path),
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
    const decision = body?.decision;
    if (!decision) return { result: "error", error: new ApiError(409, "unavailable", path) };
    // The worker's conflict body carries `decision` only — there is no
    // `decidedBy` on this path, so the winner has no name to show. Kept in the
    // shape as null so callers compile against one `DecideResult`.
    return { result: "already_decided", decision, decidedBy: null };
  }

  return {
    result: "error",
    error: new ApiError(response.status, kindFor(response.status), path),
  };
}
