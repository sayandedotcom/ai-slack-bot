import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRegistry } from "../src/codemode/registry";
import { makeBetterStackReader, MONITOR_FIELDS } from "../src/betterstack/client";
import { fakeAuditSink, fakeDeps, slackScope, TEST_LIMITS, testExecution } from "./helpers/codemode";

const COLLECTION = "t582255_firefighter_worker_logs";
const NOW = Date.parse("2026-08-12T00:00:00Z");

const config = {
  sqlEndpoint: "https://eu-central-1a-connect.betterstackdata.com",
  sqlUsername: "sqluser",
  sqlPassword: "sqlpass",
  logCollections: [COLLECTION],
  uptimeToken: "uptime-token",
  uptimeEndpoint: "https://uptime.betterstack.com/api/v2",
};

// ClickHouse splits one request across two places: `param_*` substitutions
// live in the URL, the SQL itself in the body. Recorded separately here on
// purpose — a helper that merged them would let a placement bug pass, which is
// exactly the bug that reached production and only surfaced against the live
// endpoint.
type Sent = { url: string; params: URLSearchParams; sql: string | null; headers: Headers };
let sent: Sent[] = [];

function mockResponse(payload: unknown, status = 200) {
  sent = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    sent.push({
      url: String(url),
      params: new URL(String(url)).searchParams,
      sql: init?.body === undefined ? null : String(init.body),
      headers: new Headers(init?.headers),
    });
    return new Response(JSON.stringify(payload), { status });
  });
}
afterEach(() => { vi.unstubAllGlobals(); });

function bsTools(logCollections = config.logCollections) {
  const reader = makeBetterStackReader({ ...config, logCollections }, () => NOW);
  const deps = { ...fakeDeps(), db: env.DB, betterstack: reader };
  return buildRegistry(slackScope, deps, TEST_LIMITS, testExecution({ audit: fakeAuditSink() }))
    .find((p) => p.name === "betterstack")!.tools;
}

const call = (tools: ReturnType<typeof bsTools>, method: string, args?: unknown) =>
  (tools[method] as { execute: (a?: unknown) => Promise<unknown> }).execute(args);

const logsArgs = (patch: Record<string, unknown> = {}) => ({
  query: "timeout", since: "2026-08-11T00:00:00Z", ...patch,
});

describe("betterstack.logs time window", () => {
  it("requires since", async () => {
    await expect(call(bsTools(), "logs", { query: "x" })).rejects.toThrow(/invalid_input/);
  });

  it("defaults until to now", async () => {
    mockResponse({ data: [] });
    await call(bsTools(), "logs", logsArgs());
    expect(sent[0].params.get("param_until")).toBe("2026-08-12 00:00:00.000");
  });

  it.each([
    ["an inverted window", { since: "2026-08-11T10:00:00Z", until: "2026-08-11T09:00:00Z" }],
    ["a future start", { since: "2030-01-01T00:00:00Z" }],
    ["a window that is too wide", { since: "2026-01-01T00:00:00Z", until: "2026-08-11T00:00:00Z" }],
    ["a non-ISO instant", { since: "yesterday" }],
  ])("rejects %s", async (_label, patch) => {
    mockResponse({ data: [] });
    await expect(call(bsTools(), "logs", logsArgs(patch))).rejects.toThrow(/invalid_input/);
    expect(sent).toEqual([]);
  });

  it("normalizes both bounds to UTC", async () => {
    mockResponse({ data: [] });
    await call(bsTools(), "logs", logsArgs({ since: "2026-08-11T05:00:00+02:00" }));
    expect(sent[0].params.get("param_since")).toBe("2026-08-11 03:00:00.000");
  });
});

describe("betterstack.logs query handling", () => {
  it("binds the query as a parameter rather than interpolating it", async () => {
    mockResponse({ data: [] });
    await call(bsTools(), "logs", logsArgs({ query: "'; DROP TABLE logs; --" }));
    const sql = String(sent[0].sql);
    expect(sql).toContain("{q:String}");
    expect(sql).not.toContain("DROP TABLE");
    expect(sent[0].params.get("param_q")).toBe("'; DROP TABLE logs; --");
  });

  // Regression: every param_* used to ride in a form-encoded body next to the
  // query. ClickHouse accepted the request and answered "Substitution `since`
  // is not set", so betterstack.logs() could never return a line. The mocks
  // could not see it — they only replayed the shape we sent.
  it("puts substitutions in the URL and the SQL in the body", async () => {
    mockResponse({ data: [] });
    await call(bsTools(), "logs", logsArgs());
    expect(sent[0].sql).toContain("SELECT dt, raw FROM remote(");
    expect(sent[0].sql).not.toContain("param_since");
    for (const name of ["param_since", "param_until", "param_q"]) {
      expect(sent[0].params.get(name), `${name} belongs in the URL`).toBeTruthy();
    }
    expect(sent[0].params.get("query"), "the SQL must not also ride in the URL").toBeNull();
  });

  it("names only the allowlisted collection", async () => {
    mockResponse({ data: [] });
    await call(bsTools(), "logs", logsArgs());
    expect(String(sent[0].sql)).toContain(`remote(${COLLECTION})`);
  });

  it.each([
    ["a source selector", { source: "other_source" }],
    ["a collection", { collection: "other" }],
    ["an endpoint", { url: "https://evil.example" }],
    ["a token", { token: "leak" }],
  ])("rejects %s argument", async (_label, patch) => {
    await expect(call(bsTools(), "logs", logsArgs(patch))).rejects.toThrow(/invalid_input/);
  });

  it("rejects a wildcard-only query", async () => {
    mockResponse({ data: [] });
    await expect(call(bsTools(), "logs", logsArgs({ query: "%%" }))).rejects.toThrow(/invalid_input/);
  });

  it("rejects an oversized query", async () => {
    await expect(call(bsTools(), "logs", logsArgs({ query: "x".repeat(1200) })))
      .rejects.toThrow(/invalid_input/);
  });

  it("clamps the line count", async () => {
    mockResponse({ data: [] });
    await call(bsTools(), "logs", logsArgs({ limit: 200 }));
    expect(String(sent[0].sql)).toContain("LIMIT 200");
  });

  it("sends basic auth, not a bearer token", async () => {
    mockResponse({ data: [] });
    await call(bsTools(), "logs", logsArgs());
    expect(sent[0].headers.get("authorization")).toBe(`Basic ${btoa("sqluser:sqlpass")}`);
  });

  it("refuses when no source is configured", async () => {
    mockResponse({ data: [] });
    await expect(call(bsTools([]), "logs", logsArgs()))
      .rejects.toThrow(/capability_unavailable/);
  });
});

describe("betterstack.logs normalization", () => {
  it("extracts the level from a structured line", async () => {
    mockResponse({ data: [{ dt: "2026-08-11 10:00:00.000", raw: '{"level":"ERROR","msg":"boom"}' }] });
    const out = await call(bsTools(), "logs", logsArgs()) as Array<{ level: string; at: string }>;
    expect(out[0].level).toBe("error");
    expect(out[0].at).toBe("2026-08-11T10:00:00.000Z");
  });

  it("falls back to scanning an unstructured line", async () => {
    mockResponse({ data: [{ dt: "2026-08-11 10:00:00.000", raw: "WARN disk nearly full" }] });
    const out = await call(bsTools(), "logs", logsArgs()) as Array<{ level: string }>;
    expect(out[0].level).toBe("warn");
  });

  it("says unknown rather than guessing", async () => {
    mockResponse({ data: [{ dt: "2026-08-11 10:00:00.000", raw: "something happened" }] });
    const out = await call(bsTools(), "logs", logsArgs()) as Array<{ level: string }>;
    expect(out[0].level).toBe("unknown");
  });

  // Defense in depth: another system writes these lines and we do not control
  // what goes into them.
  it.each([
    ["a bearer token", "call failed Authorization: Bearer abc123def456", /Bearer \[redacted\]|authorization: \[redacted\]/i],
    ["a slack token", "using xoxb-8454-secret-value", /redacted-slack-token/],
    ["an api key", "key=lin_api_abcdefgh12345", /redacted-key/],
    ["an email", "user alice@example.com failed", /redacted-email/],
  ])("redacts %s from a returned line", async (_label, raw, pattern) => {
    mockResponse({ data: [{ dt: "2026-08-11 10:00:00.000", raw }] });
    const out = await call(bsTools(), "logs", logsArgs()) as Array<{ message: string }>;
    expect(out[0].message).toMatch(pattern);
    expect(out[0].message).not.toContain("secret-value");
    expect(out[0].message).not.toContain("alice@example.com");
  });

  it("returns only timestamp, level and message", async () => {
    mockResponse({ data: [{ dt: "2026-08-11 10:00:00.000", raw: "hello", host: "srv-1" }] });
    const out = await call(bsTools(), "logs", logsArgs()) as Array<Record<string, unknown>>;
    expect(Object.keys(out[0]).sort()).toEqual(["at", "level", "message"]);
  });
});

describe("betterstack.monitors", () => {
  const monitorPayload = {
    data: [{
      id: "123",
      attributes: {
        pronounceable_name: "Checkout API", status: "up", last_checked_at: "2026-08-11T23:00:00Z",
        // Everything below is really returned by the live API.
        auth_username: "admin", auth_password: "hunter2",
        request_headers: [{ name: "X-Api-Key", value: "super-secret" }],
        environment_variables: { STRIPE_KEY: "sk_live_leak" },
        playwright_script: "await page.fill('#pw', 'hunter2')",
        request_body: "{\"token\":\"abc\"}",
      },
    }],
  };

  it("works as a bare call with no arguments", async () => {
    mockResponse(monitorPayload);
    await expect(call(bsTools(), "monitors")).resolves.toBeInstanceOf(Array);
  });

  it("works when called with an empty object", async () => {
    mockResponse(monitorPayload);
    await expect(call(bsTools(), "monitors", {})).resolves.toBeInstanceOf(Array);
  });

  it("returns exactly the allowlisted fields", async () => {
    mockResponse(monitorPayload);
    const out = await call(bsTools(), "monitors") as Array<Record<string, unknown>>;
    expect(Object.keys(out[0]).sort()).toEqual([...MONITOR_FIELDS].sort());
    expect(out[0]).toEqual({
      id: "123", name: "Checkout API", status: "up", lastCheckedAt: "2026-08-11T23:00:00Z",
    });
  });

  // The reason the projection is an allowlist. Verified live: the real monitor
  // record carries every one of these.
  it.each([
    "hunter2", "super-secret", "sk_live_leak", "X-Api-Key",
    "playwright_script", "environment_variables", "auth_password",
  ])("never leaks %s", async (needle) => {
    mockResponse(monitorPayload);
    const out = JSON.stringify(await call(bsTools(), "monitors"));
    expect(out).not.toContain(needle);
  });

  it("rejects any argument at all", async () => {
    await expect(call(bsTools(), "monitors", { group: "all" })).rejects.toThrow(/invalid_input/);
  });

  it("sends a bearer token to the uptime API", async () => {
    mockResponse(monitorPayload);
    await call(bsTools(), "monitors");
    expect(sent[0].headers.get("authorization")).toBe("Bearer uptime-token");
    expect(sent[0].url).toContain("/api/v2/monitors");
  });
});

describe("betterstack upstream failures stay safe", () => {
  it.each([
    [401, /capability_unavailable/],
    [403, /capability_unavailable/],
    [429, /upstream_unavailable/],
    [500, /upstream_unavailable/],
  ])("maps HTTP %i safely on logs", async (status, pattern) => {
    vi.stubGlobal("fetch", async () => new Response("body mentions sqlpass", { status }));
    await expect(call(bsTools(), "logs", logsArgs())).rejects.toThrow(pattern);
  });

  it("never leaks the sql credential in an error", async () => {
    vi.stubGlobal("fetch", async () => new Response("body mentions sqlpass", { status: 500 }));
    const err = await call(bsTools(), "logs", logsArgs())
      .then(() => { throw new Error("should have failed"); }, (e: Error) => e);
    expect(err.message).not.toContain("sqlpass");
    expect(err.message).not.toContain("sqluser");
  });

  // The real failure shape when a connection cannot see its source: a 200
  // carrying an exception that names internal collections and the sql user.
  it("hides a ClickHouse exception body from the model", async () => {
    mockResponse({
      exception: "Code: 701. DB::Exception: Requested cluster 't582255_firefighter_worker_logs' not found.",
    });
    const err = await call(bsTools(), "logs", logsArgs())
      .then(() => { throw new Error("should have failed"); }, (e: Error) => e);
    expect(err.message).toMatch(/upstream_unavailable/);
    expect(err.message).not.toContain("t582255");
    expect(err.message).not.toContain("DB::Exception");
  });

  it("survives an unreadable body", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html/>", { status: 200 }));
    await expect(call(bsTools(), "logs", logsArgs())).rejects.toThrow(/upstream_unavailable/);
  });

  it("treats a missing data array as no results", async () => {
    mockResponse({});
    await expect(call(bsTools(), "logs", logsArgs())).resolves.toEqual([]);
  });
});
