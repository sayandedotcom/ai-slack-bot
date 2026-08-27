import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/lib/api";
import {
  decide,
  fetchApproval,
  fetchOpenApprovals,
} from "../src/approvals/api";

/** The secret we never want to see leak out of a thrown or returned error. */
const BODY = "stack trace with s3cret-token and internal hostnames";

function stubFetch(
  impl: (input: string, init?: RequestInit) => Promise<Response> | Response
) {
  const spy = vi.fn((input: unknown, init?: unknown) =>
    impl(String(input), init as RequestInit)
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SUMMARY = {
  id: "ap_1",
  runId: "run_1",
  draft: "restart the pod",
  why: "customer reported 500s",
  channelId: "C1",
  threadTs: "1700000000.0001",
  createdAt: 1_700_000_000_000,
};

const CARD = {
  ...SUMMARY,
  updatedAt: 1_700_000_001_000,
  decision: "approved" as const,
  decidedBy: "sam@example.com",
  decidedAt: 1_700_000_001_000,
  editedText: null,
  rejectReason: null,
  delivery: "delivered",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchOpenApprovals", () => {
  it("parses a 200 list and unwraps `approvals`", async () => {
    const fetchSpy = stubFetch(() =>
      jsonResponse(200, { approvals: [SUMMARY] })
    );

    await expect(fetchOpenApprovals()).resolves.toEqual([SUMMARY]);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "/api/approvals?state=open"
    );
  });

  it("throws an ApiError naming only the path on a failure", async () => {
    stubFetch(() => new Response(BODY, { status: 500 }));

    const error = (await fetchOpenApprovals().catch(
      (e: unknown) => e
    )) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("/api/approvals");
    expect(error.message).not.toContain("s3cret-token");
  });
});

describe("fetchApproval", () => {
  it("unwraps the `approval` key", async () => {
    const fetchSpy = stubFetch(() => jsonResponse(200, { approval: CARD }));

    await expect(fetchApproval("ap_1")).resolves.toEqual(CARD);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("/api/approvals/ap_1");
  });
});

describe("decide", () => {
  it("PATCHes the action body and reports `decided` from the returned card", async () => {
    const fetchSpy = stubFetch(() =>
      jsonResponse(200, {
        approval: { ...CARD, decision: "edited" },
        resolutionDelivered: true,
      })
    );

    await expect(
      decide("ap_1", { action: "edit", text: "restart it gently" })
    ).resolves.toEqual({
      result: "decided",
      decision: "edited",
    });

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({
      action: "edit",
      text: "restart it gently",
    });
  });

  it("reads a 409 as `already_decided` carrying the winning decision", async () => {
    stubFetch(() =>
      jsonResponse(409, {
        code: "already_decided",
        message: "already decided",
        decision: "rejected",
      })
    );

    // The whole phase's contract: a conflict is an outcome, never a throw, and
    // the winner's decision must survive into the result.
    await expect(decide("ap_1", { action: "approve" })).resolves.toEqual({
      result: "already_decided",
      decision: "rejected",
      // The worker's conflict body has no `decidedBy`; the shape stays stable.
      decidedBy: null,
    });
  });

  it("returns an ApiError result on a 422 instead of throwing", async () => {
    stubFetch(() =>
      jsonResponse(422, { code: "invalid_action", message: BODY })
    );

    const result = await decide("ap_1", { action: "reject", reason: "" });
    expect(result.result).toBe("error");
    const error = (result as { error: ApiError }).error;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(422);
    expect(error.kind).toBe("unavailable");
    expect(error.message).toContain("/api/approvals/ap_1");
    expect(error.message).not.toContain("s3cret-token");
  });

  it("maps 401 to unauthorized and 403 to forbidden", async () => {
    stubFetch(() => new Response(BODY, { status: 401 }));
    const unauth = await decide("ap_1", { action: "approve" });
    expect((unauth as { error: ApiError }).error.kind).toBe("unauthorized");

    stubFetch(() => new Response(BODY, { status: 403 }));
    const forbidden = await decide("ap_1", { action: "approve" });
    expect((forbidden as { error: ApiError }).error.kind).toBe("forbidden");
  });

  it("maps a 404 and a network throw to error results with no body text", async () => {
    stubFetch(() =>
      jsonResponse(404, { code: "unknown_approval", message: BODY })
    );
    const missing = await decide("nope", { action: "approve" });
    const missingError = (missing as { error: ApiError }).error;
    expect(missingError.status).toBe(404);
    expect(missingError.message).not.toContain("s3cret-token");

    stubFetch(() => {
      throw new TypeError(BODY);
    });
    const offline = await decide("ap_1", { action: "approve" });
    const offlineError = (offline as { error: ApiError }).error;
    expect(offlineError.status).toBe(0);
    expect(offlineError.kind).toBe("unavailable");
    expect(offlineError.message).not.toContain("s3cret-token");
  });

  it("never throws, even when a 200 body is unparseable", async () => {
    stubFetch(() => new Response("<html>not json</html>", { status: 200 }));

    const result = await decide("ap_1", { action: "approve" });
    expect(result.result).toBe("error");
  });
});
