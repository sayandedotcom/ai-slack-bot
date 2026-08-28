import {
  decideDemoApproval,
  getDemoApproval,
  listDemoApprovals,
  listDemoApprovalsForRun,
  listDemoDecided,
} from "../fixtures/approvals";
import { fixture, getJson, isDemo, patchJson } from "./client";
import { ApiError, kindFor } from "./errors";

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

export type Decision =
  | "pending"
  | "approved"
  | "edited"
  | "rejected"
  | "withdrawn";

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
  const body = await getJson<{ approvals: OpenApproval[] }>(
    "/api/approvals?state=open"
  );
  return body.approvals;
}

/** Every approval card that belongs to one run, open or decided. */
export async function getRunApprovals(
  runId: string
): Promise<ApprovalDetail[]> {
  if (isDemo()) return fixture(listDemoApprovalsForRun(runId));
  const body = await getJson<{ approvals: ApprovalDetail[] }>(
    `/api/runs/${encodeURIComponent(runId)}/approvals`
  );
  return body.approvals;
}

/** Cards decided since `sinceMs`, across every run. */
export async function getDecidedApprovals(
  sinceMs: number
): Promise<ApprovalDetail[]> {
  if (isDemo()) return fixture(listDemoDecided());
  const body = await getJson<{ approvals: ApprovalDetail[] }>(
    `/api/approvals?state=decided&since=${sinceMs}`
  );
  return body.approvals;
}

/**
 * The full card for one approval. Kept even though the worker's 409 conflict
 * body now carries `decidedBy` alongside the winning decision (see `decide`
 * below): a card reached any other way — a deep link, the run's own approvals
 * list — still needs a direct read.
 */
export async function getApproval(id: string): Promise<ApprovalDetail> {
  if (isDemo()) return fixture(getDemoApproval(id));
  const body = await getJson<{ approval: ApprovalDetail }>(
    `/api/approvals/${encodeURIComponent(id)}`
  );
  return body.approval;
}

/**
 * Decide an approval. Returns rather than throws, because the two outcomes a
 * human actually cares about — "you decided it" and "someone beat you to it" —
 * are both ordinary values the UI has to render. Only genuinely broken
 * responses become errors, and those carry an `ApiError` naming the path and
 * nothing from the body.
 */
export async function decide(
  id: string,
  action: DecideAction
): Promise<DecideResult> {
  const path = `/api/approvals/${encodeURIComponent(id)}`;

  if (isDemo()) return fixture(decideDemoApproval(id, action));

  let response: { status: number; body: unknown };
  try {
    response = await patchJson(path, action);
  } catch (cause) {
    return {
      result: "error",
      error:
        cause instanceof ApiError
          ? cause
          : new ApiError(0, "unavailable", path),
    };
  }

  if (response.status === 200) {
    const body = response.body as { approval?: ApprovalDetail } | null;
    const decision = body?.approval?.decision;
    // A 200 without a usable card is a contract break, not a decision.
    if (!decision)
      return { result: "error", error: new ApiError(200, "unavailable", path) };
    return { result: "decided", decision };
  }

  if (response.status === 409) {
    const body = response.body as {
      decision?: Decision;
      decidedBy?: string | null;
    } | null;
    const decision = body?.decision;
    if (!decision)
      return { result: "error", error: new ApiError(409, "unavailable", path) };
    return {
      result: "already_decided",
      decision,
      decidedBy: body?.decidedBy ?? null,
    };
  }

  return {
    result: "error",
    error: new ApiError(response.status, kindFor(response.status), path),
  };
}
