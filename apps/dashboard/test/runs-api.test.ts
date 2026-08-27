import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/lib/api";
import { fetchRunUsageTotal, fetchRuns } from "../src/runs/api";

/** The secret we never want to see leak out of a thrown error. */
const BODY = "stack trace with s3cret-token and internal hostnames";

function stubFetch(
  impl: (input: string, init?: RequestInit) => Promise<Response> | Response
) {
  const spy = vi.fn((input: unknown, init?: RequestInit) =>
    impl(String(input), init)
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

const ROW = {
  id: "run_1",
  origin: "slack",
  status: "live" as const,
  shadow: false,
  summary: "checkout 500s",
  channelId: "C1",
  channelName: "#incidents",
  customerSlug: "acme",
  createdAt: 1,
  updatedAt: 2,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchRuns", () => {
  it("unwraps the runs array and defaults the limit to 50", async () => {
    const fetchSpy = stubFetch(() => jsonResponse(200, { runs: [ROW] }));

    await expect(fetchRuns()).resolves.toEqual([ROW]);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("/api/runs?limit=50");
  });

  it("passes an explicit limit through", async () => {
    const fetchSpy = stubFetch(() => jsonResponse(200, { runs: [] }));

    await fetchRuns(5);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("/api/runs?limit=5");
  });

  it("throws ApiError when the run list is missing", async () => {
    stubFetch(() => new Response(BODY, { status: 404 }));

    const error = (await fetchRuns().catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
    expect(error.message).not.toContain("s3cret-token");
  });
});

// The `fetchRunSnapshot` and `postSteer` cases lived here. Both called the
// legacy run transport, removed with the agent layer on 2026-08-23. What they
// pinned is worth re-pinning against whatever the new session speaks: a
// snapshot folds into the same shape a live update does, and a steer carries
// exactly the idempotency key the server dedupes on and nothing else.

describe("fetchRunUsageTotal", () => {
  it("returns the decimal string untouched", async () => {
    stubFetch(() => jsonResponse(200, { usage: [], totalCostUsd: "0.5081" }));

    const total = await fetchRunUsageTotal("run_1");
    expect(total).toBe("0.5081");
    expect(typeof total).toBe("string");
  });

  it("keeps trailing zeros that Number() would eat", async () => {
    stubFetch(() => jsonResponse(200, { usage: [], totalCostUsd: "1.100" }));

    await expect(fetchRunUsageTotal("run_1")).resolves.toBe("1.100");
  });
});
