import { afterEach, describe, expect, it, vi } from "vitest";
import { getJson, patchJson, postJson } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";

/** A `Response` stand-in with only the four members the client reads. */
function reply(status: number, body: unknown, unparseable = false): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: unparseable
      ? () => Promise.reject(new SyntaxError("not json"))
      : () => Promise.resolve(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("getJson", () => {
  it("returns the parsed body of a 2xx", async () => {
    stubFetch(() => Promise.resolve(reply(200, { ok: true })));
    await expect(getJson<{ ok: boolean }>("/api/health")).resolves.toEqual({
      ok: true,
    });
  });

  it("classifies 401 as unauthorized and 403 as forbidden", async () => {
    stubFetch(() => Promise.resolve(reply(401, null)));
    await expect(getJson("/api/identity")).rejects.toMatchObject({
      kind: "unauthorized",
      status: 401,
    });

    stubFetch(() => Promise.resolve(reply(403, null)));
    await expect(getJson("/api/identity")).rejects.toMatchObject({
      kind: "forbidden",
      status: 403,
    });
  });

  it("classifies a 500 and a transport failure alike, as unavailable", async () => {
    stubFetch(() => Promise.resolve(reply(500, null)));
    await expect(getJson("/api/runs")).rejects.toMatchObject({
      kind: "unavailable",
      status: 500,
    });

    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    // Status 0: there was no HTTP response at all.
    await expect(getJson("/api/runs")).rejects.toMatchObject({
      kind: "unavailable",
      status: 0,
    });
  });

  it("treats an unparseable 200 as unavailable, not as data", async () => {
    // This is the SPA-fallthrough bug the worker guards against: a misspelled
    // path answered with index.html and a 200.
    stubFetch(() => Promise.resolve(reply(200, null, true)));
    await expect(getJson("/api/typo")).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("names the path in the message and nothing from the body", async () => {
    stubFetch(() =>
      Promise.resolve(
        reply(500, { stack: "at Worker (secret-host:1:1)", token: "xoxb-leak" })
      )
    );
    const error = await getJson("/api/counters").catch(
      (cause: unknown) => cause
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toContain("/api/counters");
    expect((error as ApiError).message).not.toContain("xoxb-leak");
    expect((error as ApiError).message).not.toContain("secret-host");
  });

  it("sends the Access cookie by asking for same-origin credentials", async () => {
    const spy = stubFetch(() => Promise.resolve(reply(200, {})));
    await getJson("/api/roster");
    expect(spy).toHaveBeenCalledWith(
      "/api/roster",
      expect.objectContaining({ credentials: "same-origin" })
    );
  });
});

describe("postJson", () => {
  it("accepts a 201, because creating a turn does not answer 200", async () => {
    stubFetch(() => Promise.resolve(reply(201, { id: "run-1" })));
    await expect(postJson<{ id: string }>("/api/chat", {})).resolves.toEqual({
      id: "run-1",
    });
  });
});

describe("patchJson", () => {
  it("returns the status alongside the body so a 409 can be read as data", async () => {
    stubFetch(() => Promise.resolve(reply(409, { decision: "approved" })));
    await expect(
      patchJson("/api/approvals/apr-1", { action: "approve" })
    ).resolves.toEqual({
      status: 409,
      body: { decision: "approved" },
    });
  });
});
