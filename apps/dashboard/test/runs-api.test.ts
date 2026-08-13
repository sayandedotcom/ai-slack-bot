import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/lib/api";
import { fetchRunSnapshot, fetchRunUsageTotal, fetchRuns, postSteer } from "../src/runs/api";

/** The secret we never want to see leak out of a thrown error. */
const BODY = "stack trace with s3cret-token and internal hostnames";

function stubFetch(impl: (input: string, init?: RequestInit) => Promise<Response> | Response) {
  const spy = vi.fn((input: unknown, init?: RequestInit) => impl(String(input), init));
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

describe("fetchRunSnapshot", () => {
  const RUN = {
    id: "run_1",
    origin: "slack",
    status: "awaiting_approval" as const,
    shadow: false,
    summary: null,
    channelId: "C1",
    threadTs: "1712.0001",
    createdAt: 1,
    updatedAt: 2,
  };

  it("returns the run plus a sync message built from events and cursor", async () => {
    stubFetch(() =>
      jsonResponse(200, {
        run: RUN,
        driver: "claude",
        model: "opus",
        events: [{ seq: 1 }, { seq: 2 }],
        cursor: 2,
        complete: false,
      }),
    );

    const { run, sync } = await fetchRunSnapshot("run_1");
    expect(run).toEqual(RUN);
    expect(sync).toEqual({
      type: "sync",
      events: [{ seq: 1 }, { seq: 2 }],
      cursor: 2,
      complete: false,
      status: "awaiting_approval",
    });
  });

  it("sends `since` only when given", async () => {
    const fetchSpy = stubFetch(() =>
      jsonResponse(200, { run: RUN, events: [], cursor: 7, complete: true }),
    );

    await fetchRunSnapshot("run_1");
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("/api/runs/run_1");

    await fetchRunSnapshot("run_1", 7);
    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe("/api/runs/run_1?since=7");
  });

  it("throws ApiError on 404 without leaking the body", async () => {
    stubFetch(() => new Response(BODY, { status: 404 }));

    const error = (await fetchRunSnapshot("gone").catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
    expect(error.kind).toBe("unavailable");
    expect(error.message).toContain("/api/runs/gone");
    expect(error.message).not.toContain(BODY);
  });
});

describe("postSteer", () => {
  it("POSTs exactly requestId and content, and accepts a 201", async () => {
    const fetchSpy = stubFetch(() => jsonResponse(201, { seq: 4, appended: true }));

    await expect(postSteer("run_1", "req_9", "try the canary")).resolves.toEqual({
      seq: 4,
      appended: true,
    });

    const [url, init] = fetchSpy.mock.calls[0] as [unknown, RequestInit];
    expect(String(url)).toBe("/api/runs/run_1/turns");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");

    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    // The exact key set: an extra field on a write is an unaudited field.
    expect(Object.keys(sent).sort()).toEqual(["content", "requestId"]);
    expect(sent).toEqual({ requestId: "req_9", content: "try the canary" });
  });

  it("throws ApiError on 404 without leaking the body", async () => {
    stubFetch(() => new Response(BODY, { status: 404 }));

    const error = (await postSteer("gone", "req_9", "hi").catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
    expect(error.kind).toBe("unavailable");
    expect(error.message).toContain("/api/runs/gone/turns");
    expect(error.message).not.toContain("s3cret-token");
  });

  it("maps a network throw to unavailable with status 0", async () => {
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });

    const error = (await postSteer("run_1", "req_9", "hi").catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(0);
    expect(error.kind).toBe("unavailable");
  });
});

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
