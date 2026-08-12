import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRegistry } from "../src/codemode/registry";
import { makeSupabaseReader } from "../src/supabase/reader";
import { PRODUCTION_ALLOWLIST, type SupabaseAllowlist } from "../src/supabase/allowlist";
import type { CodeModeScope } from "../src/codemode/contracts";
import { fakeAuditSink, fakeDeps, slackScope, TEST_LIMITS, testExecution } from "./helpers/codemode";

/** A fixture schema. The production allowlist is empty; see its comment. */
const ALLOWLIST: SupabaseAllowlist = [
  {
    resource: "invoices",
    columns: [
      { name: "id", type: "uuid" },
      { name: "amount_cents", type: "integer" },
      { name: "status", type: "text" },
      { name: "created_at", type: "timestamptz" },
      { name: "metadata", type: "jsonb" },
      { name: "customer_slug", type: "text" },
    ],
    tenantColumn: "customer_slug",
  },
  {
    resource: "regions",
    columns: [
      { name: "code", type: "text" },
      { name: "name", type: "text" },
    ],
    tenantColumn: null,
  },
];

const config = { url: "https://proj.supabase.co", key: "sb_publishable_test", allowlist: ALLOWLIST };

let requests: string[] = [];
function mockRows(rows: unknown[], status = 200) {
  requests = [];
  vi.stubGlobal("fetch", async (url: string) => {
    requests.push(String(url));
    return new Response(JSON.stringify(rows), { status });
  });
}
afterEach(() => { vi.unstubAllGlobals(); });

function supabaseTools(scope: CodeModeScope = slackScope, allowlist = ALLOWLIST) {
  const reader = makeSupabaseReader({ ...config, allowlist }, scope);
  const deps = { ...fakeDeps(), db: env.DB, supabase: reader };
  return buildRegistry(scope, deps, TEST_LIMITS, testExecution({ audit: fakeAuditSink() }))
    .find((p) => p.name === "supabase")!.tools;
}

const call = (tools: ReturnType<typeof supabaseTools>, method: string, args: unknown) =>
  (tools[method] as { execute: (a: unknown) => Promise<unknown> }).execute(args);

describe("supabase.schema", () => {
  it("returns only allowlisted resources and columns", async () => {
    const out = await call(supabaseTools(), "schema", {}) as Array<{ resource: string }>;
    expect(out.map((r) => r.resource)).toEqual(["invoices", "regions"]);
  });

  it("never publishes the tenant column as a filterable field", async () => {
    const out = await call(supabaseTools(), "schema", { resource: "invoices" });
    expect(JSON.stringify(out)).not.toContain("tenantColumn");
  });

  it("never returns connection details or credentials", async () => {
    const out = JSON.stringify(await call(supabaseTools(), "schema", {}));
    expect(out).not.toContain("supabase.co");
    expect(out).not.toContain("sb_publishable_test");
    expect(out).not.toMatch(/apikey|authorization/i);
  });

  it("gives a readable error for an unknown resource", async () => {
    await expect(call(supabaseTools(), "schema", { resource: "secrets" }))
      .rejects.toThrow(/invalid_input.*not readable/s);
  });

  it("says plainly when nothing is configured", async () => {
    await expect(call(supabaseTools(slackScope, PRODUCTION_ALLOWLIST), "schema", { resource: "invoices" }))
      .rejects.toThrow(/No product resources are configured/);
  });
});

describe("supabase.select builds a bounded request", () => {
  it("projects only the requested allowlisted columns", async () => {
    mockRows([{ id: "1", status: "paid" }]);
    await call(supabaseTools(), "select", { resource: "invoices", columns: ["id", "status"] });
    expect(requests[0]).toContain("select=id%2Cstatus");
  });

  it("encodes filters as query values rather than interpolating them", async () => {
    mockRows([]);
    await call(supabaseTools(), "select", {
      resource: "invoices",
      filters: [{ column: "status", op: "eq", value: "failed & pending" }],
    });
    expect(requests[0]).toContain("status=eq.failed+%26+pending");
    expect(requests[0]).not.toContain("failed & pending");
  });

  it.each([
    ["an unknown resource", { resource: "users" }],
    ["an unknown column", { resource: "invoices", columns: ["password_hash"] }],
    ["an unknown filter column", { resource: "invoices", filters: [{ column: "secret", op: "eq", value: 1 }] }],
    ["an unknown order column", { resource: "invoices", order: { column: "nope", direction: "asc" } }],
  ])("rejects %s", async (_label, args) => {
    mockRows([]);
    await expect(call(supabaseTools(), "select", args)).rejects.toThrow(/invalid_input/);
    expect(requests).toEqual([]);       // nothing left the Worker
  });

  it.each([
    ["raw sql", { resource: "invoices", sql: "DROP TABLE users" }],
    ["a select fragment", { resource: "invoices", select: "*" }],
    ["an offset", { resource: "invoices", offset: 100 }],
    ["an rpc call", { resource: "invoices", rpc: "do_thing" }],
    ["an origin", { resource: "invoices", url: "https://evil.example" }],
    ["an unsupported operator", { resource: "invoices", filters: [{ column: "status", op: "regex", value: "x" }] }],
    ["an unbounded limit", { resource: "invoices", limit: 100000 }],
    ["a zero limit", { resource: "invoices", limit: 0 }],
  ])("rejects %s at the schema", async (_label, args) => {
    await expect(call(supabaseTools(), "select", args)).rejects.toThrow(/invalid_input/);
  });

  it("clamps the limit it does accept", async () => {
    mockRows([]);
    await call(supabaseTools(), "select", { resource: "invoices", limit: 200 });
    expect(requests[0]).toContain("limit=200");
  });

  it("rejects a list value for a single-value operator", async () => {
    mockRows([]);
    await expect(call(supabaseTools(), "select", {
      resource: "invoices",
      filters: [{ column: "status", op: "eq", value: ["a", "b"] }],
    })).rejects.toThrow(/invalid_input/);
  });

  it("accepts a list for the in operator", async () => {
    mockRows([]);
    await call(supabaseTools(), "select", {
      resource: "invoices",
      filters: [{ column: "status", op: "in", value: ["paid", "failed"] }],
    });
    expect(requests[0]).toContain("status=in.%28paid%2Cfailed%29");
  });

  it("allows only logical constants for the is operator", async () => {
    mockRows([]);
    await expect(call(supabaseTools(), "select", {
      resource: "invoices",
      filters: [{ column: "status", op: "is", value: "sneaky" }],
    })).rejects.toThrow(/invalid_input/);
  });
});

describe("supabase tenant scope is enforced server-side", () => {
  it("injects the trusted customer predicate on every read", async () => {
    mockRows([]);
    await call(supabaseTools({ ...slackScope, customerSlug: "acme" }), "select", { resource: "invoices" });
    expect(requests[0]).toContain("customer_slug=eq.acme");
  });

  it("refuses a model filter on the tenant column rather than honouring it", async () => {
    mockRows([]);
    await expect(call(supabaseTools({ ...slackScope, customerSlug: "acme" }), "select", {
      resource: "invoices",
      filters: [{ column: "customer_slug", op: "eq", value: "globex" }],
    })).rejects.toThrow(/scoped automatically/);
    expect(requests).toEqual([]);
  });

  it("refuses a per-customer read on a run with no customer", async () => {
    mockRows([]);
    await expect(call(supabaseTools({ ...slackScope, customerSlug: null }), "select", { resource: "invoices" }))
      .rejects.toThrow(/customer_scope_required/);
    expect(requests).toEqual([]);      // never ran unscoped
  });

  it("allows a genuinely global resource without a customer", async () => {
    mockRows([{ code: "eu", name: "Europe" }]);
    const out = await call(supabaseTools({ ...slackScope, customerSlug: null }), "select", { resource: "regions" });
    expect(out).toEqual([{ code: "eu", name: "Europe" }]);
    expect(requests[0]).not.toContain("customer_slug");
  });
});

describe("supabase results are normalized and bounded", () => {
  it("flattens json columns rather than nesting past the protocol depth", async () => {
    mockRows([{ id: "1", metadata: { a: { b: { c: 1 } } } }]);
    const out = await call(supabaseTools(), "select", { resource: "invoices", columns: ["id", "metadata"] }) as Array<Record<string, unknown>>;
    expect(typeof out[0].metadata).toBe("string");
  });

  it("returns null for a missing column rather than undefined", async () => {
    mockRows([{ id: "1" }]);
    const out = await call(supabaseTools(), "select", { resource: "invoices", columns: ["id", "status"] }) as Array<Record<string, unknown>>;
    expect(out[0].status).toBeNull();
  });

  // Defense in depth: the query already asked for a projection, but a policy
  // change upstream must not be able to widen what reaches model context.
  it("drops columns the upstream returned but the allowlist did not request", async () => {
    mockRows([{ id: "1", status: "paid", password_hash: "$2b$leaked" }]);
    const out = await call(supabaseTools(), "select", { resource: "invoices", columns: ["id"] });
    expect(JSON.stringify(out)).not.toContain("password_hash");
    expect(JSON.stringify(out)).not.toContain("$2b$leaked");
  });

  it("never returns the origin, the key, or request headers", async () => {
    mockRows([{ id: "1" }]);
    const out = JSON.stringify(await call(supabaseTools(), "select", { resource: "invoices", columns: ["id"] }));
    expect(out).not.toContain("sb_publishable_test");
    expect(out).not.toContain("supabase.co");
    expect(out).not.toMatch(/apikey|bearer/i);
  });
});

describe("supabase has no write surface", () => {
  it("declares schema and select and nothing else", () => {
    expect(Object.keys(supabaseTools()).sort()).toEqual(["schema", "select"]);
  });

  it("only ever issues GET requests", async () => {
    const methods: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return new Response("[]", { status: 200 });
    });
    await call(supabaseTools(), "select", { resource: "regions" });
    expect(methods).toEqual(["GET"]);
  });
});

describe("supabase upstream failures stay safe", () => {
  it.each([401, 403, 429, 500])("maps HTTP %i without leaking the body", async (status) => {
    requests = [];
    vi.stubGlobal("fetch", async () => new Response("secret: sb_publishable_test", { status }));
    const err = await call(supabaseTools(), "select", { resource: "regions" })
      .then(() => { throw new Error("should have failed"); }, (e: Error) => e);
    expect(err.message).toMatch(/upstream_unavailable/);
    expect(err.message).not.toContain("sb_publishable_test");
  });

  it("survives an unreadable body", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html/>", { status: 200 }));
    await expect(call(supabaseTools(), "select", { resource: "regions" }))
      .rejects.toThrow(/upstream_unavailable/);
  });

  it("survives an unexpected shape", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"message":"nope"}', { status: 200 }));
    await expect(call(supabaseTools(), "select", { resource: "regions" }))
      .rejects.toThrow(/upstream_unavailable/);
  });
});
