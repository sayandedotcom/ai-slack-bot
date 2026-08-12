import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRegistry } from "../src/codemode/registry";
import { makeLangSmithReader } from "../src/langsmith/client";
import { fakeAuditSink, fakeDeps, slackScope, TEST_LIMITS, testExecution } from "./helpers/codemode";

const PROJECT = "647f1d2e-bb76-48b3-adad-1d196ca0debe";
const NOW = Date.parse("2026-08-12T00:00:00Z");
// Real LangSmith trace ids are UUIDs; the reader validates that shape.
const TRACE = "9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f";

const config = {
  endpoint: "https://api.smith.langchain.com",
  apiKey: "lsv2_pt_test",
  projectId: PROJECT,
  projectName: "tweakleaf",
};

type Sent = { url: string; body: Record<string, unknown>; headers: Headers };
let sent: Sent[] = [];

function mockRuns(runs: unknown[], status = 200) {
  sent = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({
      url: String(url),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      headers: new Headers(init.headers),
    });
    return new Response(JSON.stringify({ runs }), { status });
  });
}
afterEach(() => { vi.unstubAllGlobals(); });

const run = (patch: Record<string, unknown> = {}) => ({
  id: "r1", trace_id: TRACE, parent_run_id: null, name: "agent", run_type: "chain",
  status: "success", start_time: "2026-08-11T10:00:00Z", end_time: "2026-08-11T10:00:02Z",
  error: null, inputs: { q: "hi" }, outputs: { a: "there" }, ...patch,
});

function langsmithTools() {
  const reader = makeLangSmithReader(config, () => NOW);
  const deps = { ...fakeDeps(), db: env.DB, langsmith: reader };
  return buildRegistry(slackScope, deps, TEST_LIMITS, testExecution({ audit: fakeAuditSink() }))
    .find((p) => p.name === "langsmith")!.tools;
}

const call = (tools: ReturnType<typeof langsmithTools>, method: string, args: unknown) =>
  (tools[method] as { execute: (a: unknown) => Promise<unknown> }).execute(args);

describe("langsmith pins its boundary", () => {
  it("sends x-api-key, not an Authorization bearer", async () => {
    mockRuns([run()]);
    await call(langsmithTools(), "trace", { traceId: TRACE });
    expect(sent[0].headers.get("x-api-key")).toBe("lsv2_pt_test");
    expect(sent[0].headers.get("authorization")).toBeNull();
  });

  it("injects the configured project on every request", async () => {
    mockRuns([run()]);
    await call(langsmithTools(), "searchTraces", {});
    expect(sent[0].body.session).toEqual([PROJECT]);
  });

  it("uses the fixed origin whatever the arguments say", async () => {
    mockRuns([run()]);
    await call(langsmithTools(), "searchTraces", { query: "https://evil.example" });
    expect(sent[0].url.startsWith("https://api.smith.langchain.com/")).toBe(true);
  });

  it.each([
    ["a project", { projectId: "other" }],
    ["a workspace", { workspaceId: "other" }],
    ["an origin", { baseUrl: "https://evil.example" }],
    ["a tenant", { tenantId: "t" }],
    ["a key", { apiKey: "lsv2_pt_leak" }],
  ])("rejects %s argument", async (_label, patch) => {
    await expect(call(langsmithTools(), "searchTraces", patch))
      .rejects.toThrow(/invalid_input/);
  });
});

describe("langsmith.trace normalization", () => {
  it("returns a flat node list with parent links, not a nested tree", async () => {
    mockRuns([
      run(),
      run({ id: "r2", parent_run_id: "r1", name: "llm", run_type: "llm" }),
      run({ id: "r3", parent_run_id: "r2", name: "tool", run_type: "tool" }),
    ]);
    const out = await call(langsmithTools(), "trace", { traceId: TRACE }) as {
      nodes: Array<{ id: string; parentId: string | null }>;
    };
    expect(out.nodes.map((n) => [n.id, n.parentId])).toEqual([
      ["r1", null], ["r2", "r1"], ["r3", "r2"],
    ]);
    // Depth-2 at most, so it survives RunDO.appendToolCallUpdate.
    expect(JSON.stringify(out)).not.toContain("children");
  });

  it("computes duration from the start and end times", async () => {
    mockRuns([run()]);
    const out = await call(langsmithTools(), "trace", { traceId: TRACE }) as { nodes: Array<{ durationMs: number }> };
    expect(out.nodes[0].durationMs).toBe(2000);
  });

  it("tolerates a partial run with no end time", async () => {
    mockRuns([run({ end_time: null, status: "pending" })]);
    const out = await call(langsmithTools(), "trace", { traceId: TRACE }) as { nodes: Array<{ durationMs: number }> };
    expect(out.nodes[0].durationMs).toBe(0);
  });

  it("bounds an enormous prompt with a visible marker", async () => {
    mockRuns([run({ inputs: { q: "x".repeat(50_000) } })]);
    const out = await call(langsmithTools(), "trace", { traceId: TRACE }) as { nodes: Array<{ inputPreview: string }> };
    expect(out.nodes[0].inputPreview).toContain("TRUNCATED");
    expect(out.nodes[0].inputPreview.length).toBeLessThan(600);
  });

  it("caps node count and says so", async () => {
    mockRuns(Array.from({ length: 200 }, (_, i) => run({ id: `r${i}`, parent_run_id: i === 0 ? null : "r0" })));
    const out = await call(langsmithTools(), "trace", { traceId: TRACE }) as { nodes: unknown[]; truncated: boolean };
    expect(out.nodes).toHaveLength(80);
    expect(out.truncated).toBe(true);
  });

  it("does not claim truncation when everything fit", async () => {
    mockRuns([run()]);
    const out = await call(langsmithTools(), "trace", { traceId: TRACE }) as { truncated: boolean };
    expect(out.truncated).toBe(false);
  });

  it("surfaces an error on a failed node", async () => {
    mockRuns([run({ status: "error", error: "rate limited upstream" })]);
    const out = await call(langsmithTools(), "trace", { traceId: TRACE }) as { nodes: Array<{ error: string | null }> };
    expect(out.nodes[0].error).toBe("rate limited upstream");
  });

  it("reports a missing trace as a readable validation error", async () => {
    mockRuns([]);
    await expect(call(langsmithTools(), "trace", { traceId: "deadbeef-0000-0000-0000-000000000000" }))
      .rejects.toThrow(/invalid_input.*no trace/s);
  });

  it("rejects a malformed identifier before calling upstream", async () => {
    mockRuns([]);
    await expect(call(langsmithTools(), "trace", { traceId: "not a trace id!" }))
      .rejects.toThrow(/invalid_input/);
    expect(sent).toEqual([]);
  });

  it("returns no SDK internals, headers, or credentials", async () => {
    mockRuns([run({ extra: { runtime: { sdk: "langsmith-py" } }, session_id: PROJECT })]);
    const out = JSON.stringify(await call(langsmithTools(), "trace", { traceId: TRACE }));
    expect(out).not.toContain("lsv2_pt_test");
    expect(out).not.toContain("langsmith-py");
    expect(out).not.toContain("session_id");
  });
});

describe("langsmith.searchTraces", () => {
  it("asks for root runs only", async () => {
    mockRuns([run()]);
    await call(langsmithTools(), "searchTraces", {});
    expect(sent[0].body.is_root).toBe(true);
  });

  it("passes a model query as a value, never as a URL", async () => {
    mockRuns([run()]);
    await call(langsmithTools(), "searchTraces", { query: "timeout" });
    expect(sent[0].body.query).toBe("timeout");
    expect(sent[0].url).not.toContain("timeout");
  });

  it("clamps the limit", async () => {
    mockRuns([run()]);
    await call(langsmithTools(), "searchTraces", { limit: 100 });
    expect(sent[0].body.limit).toBe(100);
  });

  it("clamps the lookback to the reviewed window", async () => {
    mockRuns([run()]);
    await call(langsmithTools(), "searchTraces", { since: "2020-01-01T00:00:00Z" });
    const since = Date.parse(String(sent[0].body.start_time));
    expect(NOW - since).toBeLessThanOrEqual(30 * 86_400_000);
  });

  it("rejects a non-ISO timestamp", async () => {
    mockRuns([]);
    await expect(call(langsmithTools(), "searchTraces", { since: "last tuesday" }))
      .rejects.toThrow(/invalid_input.*ISO-8601/s);
  });

  it("rejects a future timestamp", async () => {
    mockRuns([]);
    await expect(call(langsmithTools(), "searchTraces", { since: "2030-01-01T00:00:00Z" }))
      .rejects.toThrow(/invalid_input.*future/s);
  });

  it("normalizes to compact refs", async () => {
    mockRuns([run()]);
    const out = await call(langsmithTools(), "searchTraces", {}) as Array<Record<string, unknown>>;
    expect(Object.keys(out[0]).sort()).toEqual(["name", "startedAt", "status", "traceId"]);
  });

  it("works as a bare call", async () => {
    mockRuns([run()]);
    await expect((langsmithTools().searchTraces as { execute: (a?: unknown) => Promise<unknown> })
      .execute(undefined)).resolves.toBeInstanceOf(Array);
  });
});

describe("langsmith upstream failures stay safe", () => {
  it.each([
    [401, /capability_unavailable/],
    [403, /capability_unavailable/],
    [429, /upstream_unavailable/],
    [500, /upstream_unavailable/],
  ])("maps HTTP %i safely", async (status, pattern) => {
    vi.stubGlobal("fetch", async () => new Response("body has lsv2_pt_test", { status }));
    await expect(call(langsmithTools(), "searchTraces", {})).rejects.toThrow(pattern);
  });

  it("never leaks the key in an error", async () => {
    vi.stubGlobal("fetch", async () => new Response("body has lsv2_pt_test", { status: 500 }));
    const err = await call(langsmithTools(), "searchTraces", {})
      .then(() => { throw new Error("should have failed"); }, (e: Error) => e);
    expect(err.message).not.toContain("lsv2_pt_test");
  });

  it("survives an unreadable body", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html/>", { status: 200 }));
    await expect(call(langsmithTools(), "searchTraces", {}))
      .rejects.toThrow(/upstream_unavailable/);
  });

  it("treats a missing runs array as no results", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    await expect(call(langsmithTools(), "searchTraces", {})).resolves.toEqual([]);
  });
});
