import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRegistry } from "../src/codemode/registry";
import { issueIdFromEffectKey, makeLinearGateway } from "../src/linear/client";
import type { CodeModeScope } from "../src/codemode/contracts";
import { fakeAuditSink, fakeDeps, seedPermittedScope, TEST_LIMITS, testExecution } from "./helpers/codemode";

const TEAM_ID = "3b7d3585-029d-4490-80ce-6a44c6d9f081";
const OTHER_TEAM = "4a4914d5-f940-4121-a014-171a84b8f8dc";

const config = { apiKey: "lin_api_test", teamId: TEAM_ID, teamName: "fire-fighter-testing" };

type Sent = { document: string; variables: Record<string, unknown>; headers: Headers };

/** Captures the outgoing GraphQL operation and replies with a canned body. */
function mockTransport(replies: unknown[]) {
  const sent: Sent[] = [];
  let i = 0;
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    sent.push({ document: body.query, variables: body.variables, headers: new Headers(init.headers) });
    const reply = replies[Math.min(i++, replies.length - 1)];
    return new Response(JSON.stringify(reply), { status: 200 });
  });
  return sent;
}

afterEach(() => { vi.unstubAllGlobals(); });

const created = (identifier = "FIR-1") => ({
  data: { issueCreate: { success: true, issue: { id: "iss-1", identifier, url: `https://linear.app/z/issue/${identifier}` } } },
});

/**
 * A fresh run/turn per call. createIssue reserves through the effect ledger,
 * so reusing one scope would make the second identical call REPLAY the first
 * rather than reach the mocked transport — which is the ledger working, but
 * would silently hollow out these assertions.
 *
 * Also WRITE-PERMITTED. Both Linear mutators are classified `external_write`,
 * so from Task 6 on the shared host guard re-reads this run's channel policy
 * and `runs` row before either of them acts — a shadow run cannot file an issue
 * any more than it can post to Slack. A hand-built scope denies with
 * `channel_read_only`; that refusal is asserted in codemode-write-guard.test.ts
 * and this file is about what a permitted mutation does.
 */
const freshScope = async (): Promise<CodeModeScope> => seedPermittedScope(env.DB);

async function linearTools(
  gateway = makeLinearGateway(config),
  // A shared scope is what the effect-key tests need: two calls in ONE turn are
  // the only place an aliasing key can be observed.
  scope?: CodeModeScope,
) {
  const resolved = scope ?? (await freshScope());
  const deps = { ...fakeDeps(), db: env.DB, linear: gateway };
  return buildRegistry(resolved, deps, TEST_LIMITS, testExecution({ audit: fakeAuditSink() }))
    .find((p) => p.name === "linear")!.tools;
}

const call = (tools: Awaited<ReturnType<typeof linearTools>>, method: string, args: unknown) =>
  (tools[method] as { execute: (a: unknown) => Promise<unknown> }).execute(args);

const validCreate = {
  title: "Checkout times out for enterprise carts",
  description: "Repros on carts above 200 lines.",
  assessment: {
    platformValue: "high" as const,
    blocking: "medium" as const,
    customerWeight: "high" as const,
    evidence: "Three customers in two weeks.",
  },
};

describe("linear.createIssue schema", () => {
  it("requires every assessment axis", async () => {
    const tools = await linearTools();
    for (const missing of ["platformValue", "blocking", "customerWeight", "evidence"]) {
      const assessment = { ...validCreate.assessment } as Record<string, unknown>;
      delete assessment[missing];
      await expect(call(tools, "createIssue", { ...validCreate, assessment }))
        .rejects.toThrow(/invalid_input/);
    }
  });

  it.each([
    ["a team", { teamId: OTHER_TEAM }],
    ["a workspace", { workspace: "other" }],
    ["a project", { projectId: "p1" }],
    ["a customer", { customerSlug: "globex" }],
    ["a token", { token: "lin_api_leak" }],
    ["an endpoint", { url: "https://evil.example" }],
  ])("rejects %s argument", async (_label, patch) => {
    await expect(call(await linearTools(), "createIssue", { ...validCreate, ...patch }))
      .rejects.toThrow(/invalid_input/);
  });

  it.each([
    ["an unknown assessment value", { assessment: { ...validCreate.assessment, blocking: "catastrophic" } }],
    ["empty evidence", { assessment: { ...validCreate.assessment, evidence: "" } }],
    ["an empty title", { title: "" }],
    ["an oversized title", { title: "x".repeat(300) }],
    ["an oversized description", { description: "x".repeat(21_000) }],
    ["too many labels", { labels: Array.from({ length: 11 }, (_, i) => `l${i}`) }],
  ])("rejects %s", async (_label, patch) => {
    await expect(call(await linearTools(), "createIssue", { ...validCreate, ...patch }))
      .rejects.toThrow(/invalid_input/);
  });
});

describe("linear.createIssue always uses the pinned team", () => {
  it("sends the configured team and nothing the caller chose", async () => {
    const sent = mockTransport([created()]);
    await call(await linearTools(), "createIssue", validCreate);
    expect(sent[0].variables.teamId).toBe(TEAM_ID);
  });

  it("keeps the team fixed however the arguments vary", async () => {
    for (const patch of [
      { title: "another" },
      { description: "different body" },
      { labels: ["bug"] },
      { assessment: { ...validCreate.assessment, blocking: "low" as const } },
    ]) {
      const sent = mockTransport([created()]);
      await call(await linearTools(), "createIssue", { ...validCreate, ...patch });
      expect(sent[0].variables.teamId).toBe(TEAM_ID);
      vi.unstubAllGlobals();
    }
  });

  it("sends a bare authorization header with no Bearer prefix", async () => {
    const sent = mockTransport([created()]);
    await call(await linearTools(), "createIssue", validCreate);
    expect(sent[0].headers.get("authorization")).toBe("lin_api_test");
    expect(sent[0].headers.get("authorization")).not.toMatch(/^Bearer /);
  });

  it("renders the assessment into the issue body so it cannot be omitted", async () => {
    const sent = mockTransport([created()]);
    await call(await linearTools(), "createIssue", validCreate);
    const description = String(sent[0].variables.description);
    expect(description).toContain("Platform value: high");
    expect(description).toContain("Blocking: medium");
    expect(description).toContain("Customer weight: high");
    expect(description).toContain("Three customers in two weeks.");
  });

  it("normalizes the response to identifiers only", async () => {
    mockTransport([created("FIR-7")]);
    const out = await call(await linearTools(), "createIssue", validCreate) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(["id", "identifier", "url"]);
  });
});

describe("linear.createIssue idempotency", () => {
  it("derives a well-formed uuid from the effect key", () => {
    const id = issueIdFromEffectKey("a".repeat(64));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(issueIdFromEffectKey("a".repeat(64))).toBe(id); // stable
    expect(issueIdFromEffectKey("b".repeat(64))).not.toBe(id);
  });

  it("sends that uuid as the client-supplied issue id", async () => {
    const sent = mockTransport([created()]);
    await makeLinearGateway(config).createIssue({
      title: "t", description: "d", labels: [], idempotencyKey: "c".repeat(64),
    });
    expect(sent[0].variables.id).toBe(issueIdFromEffectKey("c".repeat(64)));
  });

  // The real behaviour, verified live 2026-08-12: a duplicate id is refused
  // with `conflict on insert of Issue`. That refusal is the reconciliation
  // signal, not an error — the retry must return the existing issue.
  it("reconciles a duplicate rather than filing twice", async () => {
    const conflict = {
      errors: [{
        message: "conflict on insert of Issue",
        extensions: { code: "INPUT_ERROR", userPresentableMessage: "Entity Issue with id x already exists." },
      }],
      data: null,
    };
    const existing = { data: { issue: { id: "iss-1", identifier: "FIR-3", url: "https://linear.app/z/issue/FIR-3" } } };
    mockTransport([conflict, existing]);
    const out = await makeLinearGateway(config).createIssue({
      title: "t", description: "d", labels: [], idempotencyKey: "d".repeat(64),
    });
    expect(out.identifier).toBe("FIR-3");
  });

  it("returns effect_in_doubt when the duplicate cannot be read back", async () => {
    const conflict = {
      errors: [{ message: "conflict on insert of Issue", extensions: { code: "INPUT_ERROR" } }],
      data: null,
    };
    mockTransport([conflict, { data: { issue: null } }]);
    await expect(makeLinearGateway(config).createIssue({
      title: "t", description: "d", labels: [], idempotencyKey: "e".repeat(64),
    })).rejects.toThrow(/effect_in_doubt/);
  });
});

/**
 * Phase 10 Task 1 Step 7: every behaviour-changing argument belongs in the
 * canonical effect key, checked here rather than by reading the binding.
 */
describe("linear effect keys name everything that changes the effect", () => {
  it("does not alias two creates that differ only by label", async () => {
    const scope = await freshScope();
    const sent = mockTransport([created("FIR-1"), created("FIR-2")]);
    // `labels` was missing from the key, so the second create replayed the
    // first issue's URL: the labels were silently never applied and the model
    // was told it had succeeded.
    await call(await linearTools(makeLinearGateway(config), scope), "createIssue",
      { ...validCreate, labels: ["bug"] });
    await call(await linearTools(makeLinearGateway(config), scope), "createIssue",
      { ...validCreate, labels: ["security"] });

    expect(sent).toHaveLength(2);
    expect(sent[0].variables.labelIds).toEqual(["bug"]);
    expect(sent[1].variables.labelIds).toEqual(["security"]);
  });

  it("still replays a genuinely identical create", async () => {
    const scope = await freshScope();
    const sent = mockTransport([created("FIR-1")]);
    const args = { ...validCreate, labels: ["bug"] };
    const a = await call(await linearTools(makeLinearGateway(config), scope), "createIssue", args);
    const b = await call(await linearTools(makeLinearGateway(config), scope), "createIssue", args);
    expect(sent).toHaveLength(1);          // ONE issue filed
    expect(b).toEqual(a);
  });

  // Label ORDER is not meaning, so two spellings of one set must not file two
  // issues. `canonical()` preserves array order by design, so the binding
  // normalizes before the key is taken.
  it("treats a reordered label set as the same effect", async () => {
    const scope = await freshScope();
    const sent = mockTransport([created("FIR-1")]);
    await call(await linearTools(makeLinearGateway(config), scope), "createIssue",
      { ...validCreate, labels: ["bug", "security"] });
    await call(await linearTools(makeLinearGateway(config), scope), "createIssue",
      { ...validCreate, labels: ["security", "bug"] });
    expect(sent).toHaveLength(1);
  });
});

describe("linear.updateIssue goes through the effect ledger", () => {
  // Each update that actually runs makes two calls: an ownership check, then
  // the mutation. `rounds(n)` supplies that pair n times, in order.
  const owned = { data: { issue: { id: "i", team: { id: TEAM_ID } } } };
  const updated = { data: { issueUpdate: { success: true, issue: { id: "i", url: "https://x" } } } };
  const rounds = (n: number) => Array.from({ length: n }, () => [owned, updated]).flat();

  it("applies a repeated identical update once", async () => {
    const scope = await freshScope();
    const sent = mockTransport(rounds(1));
    const args = { issueId: "i", title: "new title" };
    const a = await call(await linearTools(makeLinearGateway(config), scope), "updateIssue", args);
    const b = await call(await linearTools(makeLinearGateway(config), scope), "updateIssue", args);

    // The replay does not even re-run the ownership check: the whole effect,
    // including its upstream reads, is answered from the ledger.
    expect(sent.filter((s) => s.document.includes("issueUpdate"))).toHaveLength(1);
    expect(b).toEqual(a);
  });

  it("does not alias two updates that set different fields", async () => {
    const scope = await freshScope();
    const sent = mockTransport(rounds(2));
    await call(await linearTools(makeLinearGateway(config), scope), "updateIssue",
      { issueId: "i", title: "one" });
    await call(await linearTools(makeLinearGateway(config), scope), "updateIssue",
      { issueId: "i", title: "two" });
    expect(sent.filter((s) => s.document.includes("issueUpdate"))).toHaveLength(2);
  });

  // "leave the description alone" and "set the description to X" are different
  // effects and must not hash alike, even when every other field matches.
  it("does not alias an omitted field with a supplied one", async () => {
    const scope = await freshScope();
    const sent = mockTransport(rounds(2));
    await call(await linearTools(makeLinearGateway(config), scope), "updateIssue",
      { issueId: "i", title: "same" });
    await call(await linearTools(makeLinearGateway(config), scope), "updateIssue",
      { issueId: "i", title: "same", description: "and a body" });
    expect(sent.filter((s) => s.document.includes("issueUpdate"))).toHaveLength(2);
  });
});

describe("linear.updateIssue authorization", () => {
  it("refuses an issue belonging to another team", async () => {
    mockTransport([{ data: { issue: { id: "iss-9", team: { id: OTHER_TEAM } } } }]);
    await expect(call(await linearTools(), "updateIssue", { issueId: "iss-9", title: "new" }))
      .rejects.toThrow(/linear_team_denied/);
  });

  it("refuses an issue that does not exist", async () => {
    mockTransport([{ data: { issue: null } }]);
    await expect(call(await linearTools(), "updateIssue", { issueId: "nope", title: "new" }))
      .rejects.toThrow(/invalid_input/);
  });

  it("checks ownership before it mutates anything", async () => {
    const sent = mockTransport([{ data: { issue: { id: "i", team: { id: OTHER_TEAM } } } }]);
    await call(await linearTools(), "updateIssue", { issueId: "i", title: "new" }).catch(() => {});
    expect(sent).toHaveLength(1);                      // the mutation never ran
    expect(sent[0].document).not.toContain("issueUpdate");
  });

  it("resolves a state name within the pinned team only", async () => {
    const sent = mockTransport([
      { data: { issue: { id: "i", team: { id: TEAM_ID } } } },
      { data: { team: { states: { nodes: [{ id: "st-1", name: "Done" }] } } } },
      { data: { issueUpdate: { success: true, issue: { id: "i", url: "https://x" } } } },
    ]);
    await call(await linearTools(), "updateIssue", { issueId: "i", state: "done" });
    expect(sent[1].variables.teamId).toBe(TEAM_ID);
    expect(sent[2].variables.stateId).toBe("st-1");
  });

  it("names the available states when one is unknown", async () => {
    mockTransport([
      { data: { issue: { id: "i", team: { id: TEAM_ID } } } },
      { data: { team: { states: { nodes: [{ id: "st-1", name: "Done" }] } } } },
    ]);
    await expect(call(await linearTools(), "updateIssue", { issueId: "i", state: "Shipped" }))
      .rejects.toThrow(/unknown state.*Done/s);
  });

  it.each([
    ["a team", { teamId: OTHER_TEAM }],
    ["an assignee", { assigneeId: "u1" }],
    ["a priority", { priority: 1 }],
  ])("rejects %s on update", async (_label, patch) => {
    await expect(call(await linearTools(), "updateIssue", { issueId: "i", ...patch }))
      .rejects.toThrow(/invalid_input/);
  });
});

describe("linear upstream failures stay safe", () => {
  const failWith = (status: number) => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status }));
  };

  // The split is by one question: could the server have processed this?
  // Rejected at the door => proven not filed, retry allowed. 5xx => unknown,
  // so the ledger holds it in doubt rather than risking a second issue.
  it.each([
    [401, /capability_unavailable/],
    [403, /capability_unavailable/],
    [429, /capability_unavailable/],
    [500, /effect_in_doubt/],
  ])("maps HTTP %i to a safe code", async (status, pattern) => {
    failWith(status);
    await expect(call(await linearTools(), "createIssue", validCreate)).rejects.toThrow(pattern);
  });

  it("resolves an in-doubt create through findIssue instead of filing twice", async () => {
    const tools = await linearTools();
    failWith(500);
    await expect(call(tools, "createIssue", validCreate)).rejects.toThrow(/effect_in_doubt/);

    // The retry finds the issue really was filed, and returns it.
    mockTransport([{ data: { issue: { id: "iss-1", identifier: "FIR-5", url: "https://x" } } }]);
    const out = await call(tools, "createIssue", validCreate) as { identifier: string };
    expect(out.identifier).toBe("FIR-5");
  });

  it("leaks neither the document nor the credential", async () => {
    vi.stubGlobal("fetch", async () => new Response("secret body: lin_api_test", { status: 500 }));
    const err = await call(await linearTools(), "createIssue", validCreate)
      .then(() => { throw new Error("should have failed"); }, (e: Error) => e);
    expect(err.message).not.toContain("lin_api_test");
    expect(err.message).not.toContain("issueCreate");
    expect(err.message).not.toContain("secret body");
  });

  // A 200 with an unreadable body means the mutation may well have run.
  it("survives an unreadable response body", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>gateway</html>", { status: 200 }));
    await expect(call(await linearTools(), "createIssue", validCreate))
      .rejects.toThrow(/effect_in_doubt/);
  });

  // Never reached the server, so nothing was filed and a retry is safe.
  it("survives the network being gone", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("network error"); });
    await expect(call(await linearTools(), "createIssue", validCreate))
      .rejects.toThrow(/capability_unavailable/);
  });
});

describe("linear carries no approval annotation", () => {
  it("declares createIssue and updateIssue with no approval flag", async () => {
    const tools = await linearTools();
    expect(Object.keys(tools).sort()).toEqual(["createIssue", "updateIssue"]);
    for (const tool of Object.values(tools)) {
      expect(tool).not.toHaveProperty("needsApproval");
    }
  });
});
