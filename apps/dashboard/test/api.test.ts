import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, getJson } from "../src/lib/api";

/** The secret we never want to see leak out of a thrown error. */
const BODY = "stack trace with s3cret-token and internal hostnames";

function stubFetch(impl: (input: string) => Promise<Response> | Response) {
  const spy = vi.fn((input: unknown) => impl(String(input)));
  vi.stubGlobal("fetch", spy);
  return spy;
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getJson", () => {
  it("parses a 200 body", async () => {
    const fetchSpy = stubFetch(() => jsonResponse(200, { email: "a@b.c", role: "viewer" }));

    await expect(getJson<{ email: string }>("/api/identity")).resolves.toEqual({
      email: "a@b.c",
      role: "viewer",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("/api/identity");
  });

  it("only ever requests the relative path it was given", async () => {
    const fetchSpy = stubFetch(() => jsonResponse(200, {}));

    await getJson("/api/roster");

    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url.startsWith("/")).toBe(true);
    expect(url).not.toMatch(/^https?:/);
  });

  it("maps 401 to unauthorized", async () => {
    stubFetch(() => new Response(BODY, { status: 401 }));

    const error = await getJson("/api/identity").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe("unauthorized");
    expect((error as ApiError).status).toBe(401);
  });

  it("maps 403 to forbidden", async () => {
    stubFetch(() => new Response(BODY, { status: 403 }));

    const error = (await getJson("/api/roster").catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.kind).toBe("forbidden");
    expect(error.status).toBe(403);
  });

  it("maps 500 to unavailable", async () => {
    stubFetch(() => new Response(BODY, { status: 500 }));

    const error = (await getJson("/api/counters").catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.kind).toBe("unavailable");
    expect(error.status).toBe(500);
  });

  it("maps any other non-2xx to unavailable", async () => {
    stubFetch(() => new Response(BODY, { status: 404 }));

    const error = (await getJson("/api/nope").catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe("unavailable");
    expect(error.status).toBe(404);
  });

  it("maps a network throw to unavailable with status 0", async () => {
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });

    const error = (await getJson("/api/roster").catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.kind).toBe("unavailable");
    expect(error.status).toBe(0);
  });

  it("maps unparseable JSON on a 200 to unavailable", async () => {
    stubFetch(() => new Response("<html>not json</html>", { status: 200 }));

    const error = (await getJson("/api/roster").catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.kind).toBe("unavailable");
  });

  it("names the path in the message and never the response body", async () => {
    stubFetch(() => new Response(BODY, { status: 500 }));

    const error = (await getJson("/api/counters").catch((e: unknown) => e)) as ApiError;
    expect(error.message).toContain("/api/counters");
    expect(error.message).not.toContain("s3cret-token");
    expect(error.message).not.toContain(BODY);
  });

  it("keeps the body out of the message on a network throw too", async () => {
    stubFetch(() => {
      throw new Error(BODY);
    });

    const error = (await getJson("/api/identity").catch((e: unknown) => e)) as ApiError;
    expect(error.message).toContain("/api/identity");
    expect(error.message).not.toContain("s3cret-token");
  });
});
