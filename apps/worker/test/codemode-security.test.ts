import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { runCode, resolveProvider } from "@cloudflare/codemode";
import { makeRunCodeTool, type CodeModeOutput } from "../src/codemode/tool";
import { guardLoader } from "../src/codemode/guarded-loader";
import { makeGuardedExecutor } from "../src/codemode/executor";
import type { CodeModeScope } from "../src/codemode/contracts";
import type { SlackGateway } from "../src/codemode/gateways";
import { makeSupabaseReader } from "../src/supabase/reader";
import { PRODUCTION_ALLOWLIST } from "../src/supabase/allowlist";
import { makeArtifactPublisher } from "../src/files/r2";
import { fakeAuditSink, fakeDeps, slackScope, TEST_LIMITS } from "./helpers/codemode";

const freshScope = (patch: Partial<CodeModeScope> = {}): CodeModeScope => ({
  ...slackScope,
  runId: `run_${crypto.randomUUID()}`,
  turnId: `turn_${crypto.randomUUID()}`,
  ...patch,
});

/**
 * Real readers where the policy actually lives. A fake that answers `[]` would
 * pass every adversarial case below without enforcing anything, which is the
 * quietest way for a security suite to become decorative.
 */
function realDeps(scope: CodeModeScope) {
  return {
    ...fakeDeps(),
    db: env.DB,
    supabase: makeSupabaseReader(
      { url: "https://proj.supabase.co", key: "sb_publishable_test", allowlist: PRODUCTION_ALLOWLIST },
      scope,
    ),
    files: makeArtifactPublisher({ bucket: env.ARTIFACTS, baseUrl: "https://x/api/artifacts" }),
  };
}

function tool(overrides: Partial<Parameters<typeof makeRunCodeTool>[0]> = {}) {
  const scope = overrides.scope ?? freshScope();
  return makeRunCodeTool({
    scope,
    deps: realDeps(scope),
    limits: TEST_LIMITS,
    audit: fakeAuditSink(),
    loader: env.LOADER,
    ...overrides,
  });
}

const run = async (t: ReturnType<typeof makeRunCodeTool>, code: string): Promise<CodeModeOutput> =>
  (await t.execute!({ code }, {} as never)) as CodeModeOutput;

/* ------------------------------------------------- Step 1: outbound refusal */

// The claim is REFUSAL, not absence. fetch and WebSocket remain defined inside
// a correctly isolated isolate and throw on invocation. A test written as
// `typeof fetch === "undefined"` fails against a correctly isolated isolate,
// and the README must not claim absence either.
const escape = (expr: string) => `async () => {
  const defined = { fetch: typeof fetch, ws: typeof WebSocket };
  try { await (${expr}); return { outcome: "reached", defined }; }
  catch (err) { return { outcome: "refused", message: String(err.message), defined }; }
}`;

describe("outbound access is refused, not absent", () => {
  it.each([
    ["public https", `fetch("https://example.com")`],
    ["parent origin", `fetch("https://firefighter.sayandeten.workers.dev/api/health")`],
    ["bare IP", `fetch("http://1.1.1.1/")`],
    ["plain http", `fetch("http://workers.cloudflare.com/")`],
    ["websocket", `(async () => new WebSocket("wss://example.com"))()`],
  ])("refuses outbound access via %s", async (_label, expr) => {
    const out = await run(tool(), escape(expr));
    const r = out.result as {
      outcome: string; message?: string; defined: Record<string, string>;
    };
    expect(r.outcome).toBe("refused");
    // The globals EXIST. That is the precise, defensible claim.
    expect(r.defined.fetch).toBe("function");
    expect(r.defined.ws).toBe("function");
    expect(r.message).toBeTruthy();
  });

  it("records the verbatim refusal message for the README", async () => {
    const out = await run(tool(), escape(`fetch("https://example.com")`));
    const message = (out.result as { message: string }).message;
    // Printed so phase-09-notes.md can quote the runtime rather than paraphrase.
    console.log("VERBATIM_REFUSAL:", message);
    expect(message.length).toBeGreaterThan(0);
  });
});

/* --------------------------------------------------- Step 2: causal control */

describe("CONTROL: isolation is caused by globalOutbound", () => {
  // Without this, the section above is an observation. With it, it is a causal
  // claim: remove one field and the same isolate reaches the open internet.
  // Test-only, and never reachable from the deployed application.
  it("omitting globalOutbound reaches the internet", async () => {
    const stub = env.LOADER.load({
      compatibilityDate: "2026-08-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "main.js",
      modules: {
        "main.js": `
          import { WorkerEntrypoint } from "cloudflare:workers";
          export default class extends WorkerEntrypoint {
            async probe() {
              try { const r = await fetch("https://example.com"); return "reached:" + r.status; }
              catch (err) { return "refused:" + err.message; }
            }
          }`,
      },
      // globalOutbound deliberately omitted — this is the control.
    });
    const result = await (stub.getEntrypoint() as unknown as { probe(): Promise<string> }).probe();
    console.log("CONTROL_RESULT:", result);
    expect(result).toMatch(/^reached:/);
  });

  it("the production path cannot be configured that way", async () => {
    // guardLoader forces null; there is no call site that can opt out.
    const captured: WorkerLoaderWorkerCode[] = [];
    const fake = {
      load: vi.fn((code: WorkerLoaderWorkerCode) => { captured.push(code); return {} as WorkerStub; }),
      get: vi.fn(),
    } as unknown as WorkerLoader;
    guardLoader(fake, TEST_LIMITS).load({
      compatibilityDate: "2025-06-01",
      mainModule: "executor.js",
      modules: { "executor.js": "export default class {}" },
      globalOutbound: undefined,
    });
    expect(captured[0].globalOutbound).toBeNull();
  });
});

/* ------------------------------------------- Step 3: environment enumeration */

describe("the loaded Worker sees no host environment", () => {
  it("exposes no credential, binding or host env to model code", async () => {
    const probe = `async () => {
      const names = ["DB","RUNS","LOADER","ARTIFACTS","INGEST_QUEUE","MEMORY_QUEUE",
        "TRIAGE_QUEUE","SLACK_BOT_TOKEN","SLACK_SIGNING_SECRET","ANTHROPIC_API_KEY",
        "ZEP_API_KEY","LINEAR_API_KEY","SUPABASE_URL","SUPABASE_KEY","env","ctx","props"];
      const found = [];
      for (const n of names) {
        const g = globalThis[n];
        if (g !== undefined) found.push(n + ":global");
        // INVOKE, do not merely read. \`slack\` is a Proxy whose get trap returns
        // a dispatch function for EVERY string key, so a property read is a
        // function for all 17 names and proves nothing. Calling it is what
        // reaches ToolDispatcher, which answers "Tool not found" — same shape
        // as the outbound claim: the handle exists, the call is refused.
        try { const v = await slack[n](); if (v !== undefined) found.push(n + ":rpc"); }
        catch { /* "Tool not found" — the expected answer */ }
      }
      return { found, globalKeys: Object.keys(globalThis).length };
    }`;
    const out = await run(tool(), probe);
    expect(out.error).toBeUndefined();
    expect((out.result as { found: string[] }).found).toEqual([]);
  });

  // Without this, a probe that silently checks nothing would also pass.
  // Built directly rather than via a test-only parameter on the production
  // factory: the point is that the SANDBOX would surface a leak, and adding a
  // leak hatch to shipped code to prove that would be its own hazard.
  it("CONTROL: the probe can actually detect a leak", async () => {
    const executor = makeGuardedExecutor(
      guardLoader(env.LOADER, TEST_LIMITS), TEST_LIMITS, () => Date.now(),
    );
    const leaky = resolveProvider({
      name: "leak",
      tools: { token: { execute: async () => "xoxb-secret" } },
    });
    const output = await runCode({
      code: "async () => await leak.token()",
      executor,
      providers: [leaky],
    });
    expect(output.result).toBe("xoxb-secret");
  });
});

/* ------------------------------------------- Step 4: policy and schema attacks */

describe("fixed policy cannot be argued out of", () => {
  it.each([
    ["another destination", `slack.reply({ text: "hi", channel: "C_OTHER" })`],
    ["another identity", `slack.reply({ text: "hi", actor: "U_OTHER" })`],
    ["a foreign issue team", `linear.createIssue({ title: "t", description: "d", assessment: { platformValue: "low", blocking: "low", customerWeight: "low", evidence: "e" }, teamId: "T_OTHER" })`],
    ["a redirected origin", `langsmith.searchTraces({ baseUrl: "https://evil.example" })`],
    ["a foreign project", `langsmith.searchTraces({ projectId: "other" })`],
    ["a hidden resource", `supabase.select({ resource: "auth.users" })`],
    ["raw query text", `supabase.select({ resource: "orders", sql: "DROP TABLE users" })`],
    ["another log source", `betterstack.logs({ query: "x", since: "2026-08-11T00:00:00Z", source: "other" })`],
    ["another bucket", `files.publish({ bytes: new Uint8Array([1]), contentType: "text/plain", filename: "a.txt", bucket: "other" })`],
    ["an executable artifact", `files.publish({ bytes: new Uint8Array([77,90,0,0]), contentType: "application/pdf", filename: "a.pdf" })`],
    ["an uncited fact", `memory.cite({ factIds: ["invented"] })`],
  ])("refuses %s at a host boundary", async (_label, expr) => {
    const out = await run(tool(), `async () => { try { return await ${expr}; } catch (e) { return "REFUSED:" + e.message; } }`);
    const text = out.error ?? String(out.result);
    expect(text).toMatch(/REFUSED:|invalid_input|channel_read_only|linear_team_denied|customer_scope_required/);
    expect(text).not.toMatch(/^\{"ts"/);          // no successful send
  });

  it("refuses a reply in every non-postable context", async () => {
    for (const scope of [
      freshScope(),                                            // unknown channel
      freshScope({ origin: "chat", slackThread: null }),        // no target
      freshScope({ actor: null }),                              // no identity
    ]) {
      const out = await run(tool({ scope }), `async () => await slack.reply({ text: "hi" })`);
      expect(out.error).toMatch(/channel_read_only|slack_context_required|shadow_write_denied|identity_unavailable/);
    }
  });

  it("cannot exceed the capability call budget", async () => {
    const t = tool({ limits: { ...TEST_LIMITS, maxCapabilityCalls: 3 } });
    const out = await run(t, `async () => {
      const seen = [];
      for (let i = 0; i < 10; i++) {
        try { await slack.thread({}); seen.push("ok"); }
        catch (e) { seen.push(e.message.split(":")[0]); }
      }
      return seen;
    }`);
    const seen = out.result as string[];
    expect(seen.filter((s) => s === "ok")).toHaveLength(3);
    expect(seen).toContain("capability_unavailable");
  });
});

/* --------------------------------------------- Step 5: serialization attacks */

describe("serialization fails safely", () => {
  it.each([
    ["a cycle", "async () => { const a = {}; a.self = a; return a; }"],
    ["deep nesting", "async () => { let v = 1; for (let i=0;i<200;i++) v = { v }; return v; }"],
    ["a bigint", "async () => 1n"],
    ["an Error", "async () => new Error('boom')"],
    ["a Response", "async () => new Response('x')"],
    ["a function", "async () => (function f(){})"],
    ["a throwing accessor", "async () => ({ get x() { throw new Error('nope'); } })"],
    ["a throwing toJSON", "async () => ({ toJSON() { throw new Error('nope'); } })"],
    ["a binary result", "async () => new Uint8Array([1,2,3])"],
  ])("fails safely on %s", async (_label, code) => {
    const out = await run(tool(), code);
    const text = out.error ?? JSON.stringify(out.result);
    expect(text).toMatch(/invalid_input|output_too_large|TRUNCATED/);
    expect(text.length).toBeLessThan(4000);
  });

  it("bounds a huge array rather than returning it", async () => {
    const out = await run(tool(), "async () => Array.from({length: 200000}, (_, i) => i)");
    const text = out.error ?? JSON.stringify(out.result);
    expect(text).toMatch(/TRUNCATED|output_too_large|invalid_input/);
  });

  // A lone surrogate is VALID JSON once escaped, so it round-trips rather than
  // failing. Asserted as the real behaviour rather than a hoped-for rejection.
  it("round-trips a lone surrogate without corrupting the boundary", async () => {
    const out = await run(tool(), "async () => '\\uD800'");
    expect(out.error).toBeUndefined();
    expect(typeof out.result).toBe("string");
  });

  it("leaves no effect behind when serialization fails", async () => {
    const sent: string[] = [];
    const trackingSlack: SlackGateway = {
      async thread() { return []; },
      async searchMessages() { return []; },
      async reply(text) { sent.push(text); return { ts: "1.0", permalink: null }; },
    };
    const audit = fakeAuditSink();
    await run(
      tool({ deps: { ...fakeDeps(), db: env.DB, slack: trackingSlack }, audit }),
      "async () => { const a = {}; a.self = a; return a; }",
    );
    expect(sent).toEqual([]);                                        // nothing sent
    expect(audit.events.some((e) => e.kind === "completed")).toBe(false);
  });

  it("does not let a __proto__ key pollute the host realm", async () => {
    await run(tool(), `async () => JSON.parse('{"__proto__":{"pwned":true},"ok":1}')`);
    expect(({} as Record<string, unknown>).pwned).toBeUndefined();
  });
});

/* --------------------------------------- Step 6: concurrency and retry attacks */

describe("concurrency and retry, driven through the sandbox", () => {
  it("keeps two customers' executions apart", async () => {
    const acme = tool({
      scope: freshScope({ customerSlug: "acme" }),
      deps: {
        ...fakeDeps({ slackThread: [{ ts: "1.0", userId: null, text: "acme thread", permalink: null }] }),
        db: env.DB,
      },
    });
    const globex = tool({
      scope: freshScope({ customerSlug: "globex" }),
      deps: {
        ...fakeDeps({ slackThread: [{ ts: "2.0", userId: null, text: "globex thread", permalink: null }] }),
        db: env.DB,
      },
    });
    const program = `async () => (await slack.thread({}))[0].text`;
    const [a, b] = await Promise.all([run(acme, program), run(globex, program)]);
    expect(a.result).toBe("acme thread");
    expect(b.result).toBe("globex thread");
  });

  // The ledger mechanics are covered in isolation by Task 3; what is new here
  // is the MODEL controlling call ordering inside one execution.
  it("performs a duplicated effect once when the program calls it twice", async () => {
    const sent: string[] = [];
    const trackingSlack: SlackGateway = {
      async thread() { return []; },
      async searchMessages() { return []; },
      async reply(text) { sent.push(text); return { ts: `${sent.length}.0`, permalink: null }; },
    };
    // A live channel and a real non-shadow run, so policy permits the send.
    const channelId = `C${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
    const ts = "1712345678.900100";
    await env.DB.prepare(
      "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, 'acme', 'live')",
    ).bind(channelId, `c-${channelId}`).run();
    const runId = `run_${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, created_at, updated_at)
       VALUES (?, ?, 'slack', ?, ?, 'live', 0, 0, 0)`,
    ).bind(runId, `slack:${channelId}:${ts}`, channelId, ts).run();

    const scope = freshScope({ runId, slackThread: { channelId, threadTs: ts } });
    const t = tool({ scope, deps: { ...fakeDeps(), db: env.DB, slack: trackingSlack } });

    const out = await run(t, `async () => {
      const a = await slack.reply({ text: "same text" });
      const b = await slack.reply({ text: "same text" });
      return [a.ts, b.ts];
    }`);
    expect(out.error).toBeUndefined();
    expect(sent).toEqual(["same text"]);            // ONE upstream call
    expect(out.result).toEqual(["1.0", "1.0"]);     // replayed, not re-sent
  });
});

/* ------------------------------------------------- Step 7: the timeout matrix */

describe("the timeout matrix", () => {
  it("completes a fast program", async () => {
    const out = await run(tool(), "async () => 42");
    expect(out.result).toBe(42);
  });

  it("times out a program that sleeps past the budget", async () => {
    const t = tool({ limits: { ...TEST_LIMITS, wallTimeMs: 300 } });
    const started = Date.now();
    const out = await run(t, "async () => { await new Promise(r => setTimeout(r, 5000)); return 1; }");
    expect(out.error).toMatch(/execution_timeout/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("times out when a capability never resolves", async () => {
    const stuck: SlackGateway = {
      thread: () => new Promise<never>(() => {}),
      async searchMessages() { return []; },
      async reply() { return { ts: "1.0", permalink: null }; },
    };
    const t = tool({
      limits: { ...TEST_LIMITS, wallTimeMs: 300 },
      deps: { ...fakeDeps(), db: env.DB, slack: stuck },
    });
    const out = await run(t, "async () => await slack.thread({})");
    expect(out.error).toMatch(/execution_timeout/);
  });

  // The CPU row of the matrix is DEPLOYED-ONLY. See phase-09-notes.md Task 4b:
  // the parent race returns on schedule, but limits.cpuMs is not enforced in
  // this runtime, so the isolate keeps spinning and starves everything after
  // it. Running it here wedges the suite rather than failing it.
  it.skip("CPU loop beyond cpuMs (deployed only: Task 15 smoke check)", () => {});
});
