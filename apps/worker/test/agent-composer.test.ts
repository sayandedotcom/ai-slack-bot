import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeAgentTools,
  makeCapabilityDependencies,
  makeRunCodeToolForRun,
  resolveCodeModeScope,
} from "../src/agent/dependencies";
import { PHASE_09_NAMESPACES } from "../src/codemode/registry";
import { alwaysFresh } from "../src/codemode/contracts";
import type { CodeModeOutput } from "../src/codemode/tool";
import type { Env } from "../src/index";
import type { RunState } from "../src/run/session";
import { fakeAuditSink } from "./helpers/codemode";

/**
 * THE PRODUCTION COMPOSER, not a fake.
 *
 * Every gateway in this file is the real one built from the real `Env`. That
 * distinction is the entire value of the suite: a fake Slack gateway that
 * refuses is a fake doing what it was told, while the REAL gateway refusing
 * while a working bot token sits in the environment is a decision the product
 * makes. Only the second one is evidence.
 *
 * Nothing here reaches a vendor. The Slack identity seam refuses before any
 * request is built, and `fetch` is stubbed in the cases that would otherwise
 * try — a composer test that needed network access would be untestable exactly
 * where it matters most.
 */

const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();

async function seedLiveRun(): Promise<{ state: RunState; channelId: string; runId: string }> {
  const channelId = `C${uid()}`;
  const threadTs = "1712345678.000100";
  const runId = `run_${crypto.randomUUID()}`;
  const key = `slack:${channelId}:${threadTs}`;

  await env.DB.prepare(
    "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, 'acme', 'live')",
  )
    .bind(channelId, `chan-${channelId}`)
    .run();
  await env.DB.prepare(
    `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, created_at, updated_at)
     VALUES (?, ?, 'slack', ?, ?, 'live', 0, 0, 0)`,
  )
    .bind(runId, key, channelId, threadTs)
    .run();

  return {
    channelId,
    runId,
    state: {
      runId,
      key,
      origin: "slack",
      channelId,
      threadTs,
      status: "live",
      summary: null,
      createdAt: 0,
      updatedAt: 0,
    },
  };
}

const workerEnv = () => env as unknown as Env;

const toolInput = (state: RunState) => ({
  env: workerEnv(),
  state,
  turnId: `agent:gen:${crypto.randomUUID()}`,
  auditForExecution: () => fakeAuditSink(),
  guard: alwaysFresh(),
});

const run = async (
  tool: Awaited<ReturnType<typeof makeRunCodeToolForRun>>,
  code: string,
  toolCallId = `call_${crypto.randomUUID()}`,
): Promise<CodeModeOutput> =>
  (await tool.execute!({ code }, { toolCallId, messages: [] } as never)) as CodeModeOutput;

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ---------------------------------------------------------- one tool only -- */

describe("the model is given exactly one tool", () => {
  it("exposes run_code and nothing else", async () => {
    const { state } = await seedLiveRun();
    const tools = await makeAgentTools(toolInput(state));
    expect(Object.keys(tools)).toEqual(["run_code"]);
  });

  it("does not expose any of the seven namespaces as an outer tool", async () => {
    const { state } = await seedLiveRun();
    const tools = await makeAgentTools(toolInput(state));
    for (const namespace of PHASE_09_NAMESPACES) {
      expect(tools).not.toHaveProperty(namespace);
    }
  });

  it("carries the declarations exactly once, in the tool description", async () => {
    const { state } = await seedLiveRun();
    const tool = await makeRunCodeToolForRun(toolInput(state));
    // The AI SDK types `description` as a string OR a context function. Ours is
    // always the rendered string; narrowing here rather than casting keeps a
    // future SDK change from silently turning this assertion into a no-op.
    const description = typeof tool.description === "string" ? tool.description : "";
    expect(description.length).toBeGreaterThan(0);

    // One home for the declarations (invariant 24). A second copy in a system
    // prompt is the failure this counts: it doubles the token cost of the
    // largest static block in the context and the two copies then drift.
    const declaredNamespaces = description.match(/^declare const (\w+): \{/gm) ?? [];
    expect(declaredNamespaces).toHaveLength(PHASE_09_NAMESPACES.length);
    expect(new Set(declaredNamespaces).size).toBe(PHASE_09_NAMESPACES.length);
  });

  it("names no credential, host or bucket in what the model is shown", async () => {
    const { state } = await seedLiveRun();
    const tool = await makeRunCodeToolForRun(toolInput(state));
    // The AI SDK types `description` as a string OR a context function. Ours is
    // always the rendered string; narrowing here rather than casting keeps a
    // future SDK change from silently turning this assertion into a no-op.
    const description = typeof tool.description === "string" ? tool.description : "";
    expect(description.length).toBeGreaterThan(0);

    for (const secret of [
      env.SLACK_BOT_TOKEN,
      env.ZEP_API_KEY,
      env.LINEAR_API_KEY,
      env.LANGSMITH_API_KEY,
      env.SUPABASE_KEY,
      env.BETTERSTACK_SQL_PASSWORD,
    ]) {
      if (typeof secret === "string" && secret.length > 0) {
        expect(description).not.toContain(secret);
      }
    }
    expect(description).not.toContain(env.SUPABASE_URL);
    expect(description).not.toContain(env.LINEAR_TEAM_ID);
    expect(description).not.toContain("firefighter-artifacts");
  });
});

/* -------------------------------------------------- no Env for a capability -- */

describe("a capability never receives Env", () => {
  it("hands the capability layer exactly ten narrow ports", async () => {
    const { state } = await seedLiveRun();
    const scope = await resolveCodeModeScope(env.DB, state, "agent:gen:x");
    const deps = makeCapabilityDependencies(workerEnv(), scope);

    // A binding module that wanted a credential would have to widen this type
    // in a diff somebody signs off. The assertion is on the exact key set
    // because an added key is exactly how that would happen quietly.
    expect(Object.keys(deps).sort()).toEqual([
      "approval",
      "betterstack",
      "clock",
      "db",
      "files",
      "langsmith",
      "linear",
      "memory",
      "slack",
      "supabase",
    ]);
  });

  it("reaches no credential by walking the whole dependency object graph", async () => {
    const { state } = await seedLiveRun();
    const scope = await resolveCodeModeScope(env.DB, state, "agent:gen:y");
    const deps = makeCapabilityDependencies(workerEnv(), scope) as Record<string, unknown>;

    // Every real secret this composer touches. Searching for the VALUES rather
    // than for string-typed fields is the difference between a test and a
    // ritual: the previous version walked one level and checked
    // `typeof === "string"`, so `new ZepMemory(key)` passed vacuously — its own
    // values are an object and a Set, and the key sat two levels down in
    // `client._options.apiKey`. Credentials live inside adapter closures, and
    // this is what actually holds that line.
    const secrets = [
      env.ZEP_API_KEY,
      env.LINEAR_API_KEY,
      env.LANGSMITH_API_KEY,
      env.SUPABASE_KEY,
      env.BETTERSTACK_SQL_PASSWORD,
      env.BETTERSTACK_UPTIME_TOKEN,
      env.SLACK_BOT_TOKEN,
      env.ANTHROPIC_API_KEY,
    ].filter((s): s is string => typeof s === "string" && s.length > 0);

    // NON-VACUITY, and it is not decoration. The filter above exists so an
    // unbound name cannot make `value.includes("")` match every string — but a
    // walk over an empty list also "finds no credential", perfectly, forever.
    // Before every one of these eight was bound in `vitest.config.ts`, six came
    // only from `.dev.vars`, so on a fresh clone this searched for two and
    // reported success. The count is what makes the pass mean something.
    expect(secrets).toHaveLength(8);

    const found: string[] = [];
    const seen = new WeakSet<object>();
    const walk = (value: unknown, path: string, depth: number): void => {
      if (depth > 8 || value === null || value === undefined) return;
      if (typeof value === "string") {
        if (secrets.some((s) => value.includes(s))) found.push(path);
        return;
      }
      if (typeof value !== "object") return;
      if (seen.has(value)) return;
      seen.add(value);
      // A D1Database or an R2Bucket is a host binding, not a bag of secrets,
      // and walking one reaches native internals — but they are also exactly
      // where a credential would NOT be, so skipping them costs nothing.
      if (value === env.DB) return;
      for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`, depth + 1);
    };

    for (const [name, port] of Object.entries(deps)) walk(port, name, 0);
    expect(found).toEqual([]);
  });

  /**
   * THE POOL'S ISOLATION FROM THE NON-MODEL VENDORS, AS CONFIGURATION.
   *
   * The two tests above build the REAL Linear, Supabase, LangSmith and Better
   * Stack adapters from the POOL env. That is deliberate — a fake adapter
   * proves nothing about credential containment — but it means those closures
   * hold whatever this machine's `.dev.vars` supplies unless something overrides
   * it. Nothing invokes them today, and "nothing invokes them today" is a
   * convention, not a guarantee: there is no `fetchMock` and no miniflare
   * `outboundService` in this pool, so a future test that calls one reaches the
   * real vendor, and the only thing in its way is the write-guard policy matrix
   * — an AUTHORIZATION check, which cannot help a READ.
   *
   * So the guarantee is the credential itself being wrong. Asserted as EQUALITY
   * with each fixture, exactly as the Gateway pair is asserted at
   * `agent-ports.test.ts` > "binds the pool's Gateway settings empty":
   * `toBeTruthy()` would pass on a real key, and `toBeFalsy()` would pass on a
   * binding that had vanished.
   */
  it("binds every vendor credential the composer reads to a synthetic fixture", () => {
    expect(env.LINEAR_API_KEY).toBe("not-a-real-linear-key");
    expect(env.SUPABASE_KEY).toBe("not-a-real-supabase-key");
    expect(env.LANGSMITH_API_KEY).toBe("not-a-real-langsmith-key");
    expect(env.BETTERSTACK_SQL_USERNAME).toBe("not-a-real-betterstack-username");
    expect(env.BETTERSTACK_SQL_PASSWORD).toBe("not-a-real-betterstack-password");
    expect(env.BETTERSTACK_UPTIME_TOKEN).toBe("not-a-real-betterstack-uptime-token");
    // Not read by `makeCapabilityDependencies`, bound for a neighbouring reason:
    // `makeTriageRunner` composes `createAnthropic` from it and, with the
    // Gateway URL bound empty, would go straight to the provider.
    expect(env.ANTHROPIC_API_KEY).toBe("not-a-real-anthropic-key");
    // The two that were already fixtures, restated here so this one test is the
    // whole list a reader has to check against `agent/dependencies.ts`.
    expect(env.ZEP_API_KEY).toBe("zep-test-key");
    expect(env.SLACK_BOT_TOKEN).toBe("xoxb-test");
  });
});

/* ------------------------------------------------- the Slack identity seam -- */

describe("slack.reply refuses under the PRODUCTION composer", () => {
  it("ends with identity_unavailable on a fully permitted live run", async () => {
    const { state } = await seedLiveRun();
    const tool = await makeRunCodeToolForRun(toolInput(state));

    const out = await run(
      tool,
      "async () => { try { await slack.reply({ text: 'hello' }); return 'sent'; } catch (e) { return e.message; } }",
    );

    // Not a defect. Until Phase 12 resolves the on-duty engineer's decrypted
    // user token there is no human identity to speak as, and this product never
    // speaks to a customer without one.
    expect(out.result).toMatch(/identity_unavailable/);
  });

  it("builds no chat.postMessage request and never touches the bot token", async () => {
    const { state } = await seedLiveRun();

    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push(`${url} ${JSON.stringify(init?.headers ?? {})}`);
      return new Response("{}", { status: 200 });
    });

    const tool = await makeRunCodeToolForRun(toolInput(state));
    const out = await run(
      tool,
      "async () => { try { await slack.reply({ text: 'hello' }); return 'sent'; } catch (e) { return e.message; } }",
    );

    expect(out.result).toMatch(/identity_unavailable/);
    // The bot token is present and usable in this environment, which is exactly
    // why this matters: refusing has to be a decision, not an accident of a
    // missing credential. There is no fallback path, so there is no request.
    expect(env.SLACK_BOT_TOKEN).toBeTruthy();
    expect(requests.filter((r) => r.includes("chat.postMessage"))).toEqual([]);
    expect(requests.join("\n")).not.toContain(env.SLACK_BOT_TOKEN);
    expect(JSON.stringify(out)).not.toContain(env.SLACK_BOT_TOKEN);
  });

  it("refuses before the write guard's own denial when the run is shadow", async () => {
    const { state, runId } = await seedLiveRun();
    await env.DB.prepare("UPDATE runs SET shadow = 1 WHERE id = ?").bind(runId).run();

    const tool = await makeRunCodeToolForRun(toolInput(state));
    const out = await run(
      tool,
      "async () => { try { await slack.reply({ text: 'hi' }); return 'sent'; } catch (e) { return e.message; } }",
    );
    // Guard first, identity second: a shadow run's refusal names the reason a
    // human can act on.
    expect(out.result).toMatch(/shadow_write_denied/);
  });
});

/* --------------------------------------------------------- real read paths -- */

describe("the composed read surface works against real D1", () => {
  it("reads this run's own thread and no other", async () => {
    const { state, channelId } = await seedLiveRun();
    await env.DB.prepare(
      `INSERT INTO messages
         (event_id, channel_id, ts, thread_ts, user_id, text, subtype, permalink, customer_slug, received_at)
       VALUES (?, ?, '1712345678.000100', NULL, 'U1', 'the outage started at nine', NULL, NULL, 'acme', 0)`,
    )
      .bind(`ev_${crypto.randomUUID()}`, channelId)
      .run();

    const tool = await makeRunCodeToolForRun(toolInput(state));
    const out = await run(
      tool,
      "async () => { const m = await slack.thread({}); return m.map(x => x.text).join('|'); }",
    );
    expect(out.result).toBe("the outage started at nine");
    expect(out.error).toBeUndefined();
  });

  it("refuses customer discovery from a Slack-origin production run", async () => {
    const { state } = await seedLiveRun();
    const tool = await makeRunCodeToolForRun(toolInput(state));
    const out = await run(
      tool,
      "async () => { try { await memory.findCustomers({ query: 'acme' }); return 'found'; } catch (e) { return e.message; } }",
    );
    expect(out.result).toMatch(/capability_unavailable/);
  });

  it("keeps the isolate off the network", async () => {
    const { state } = await seedLiveRun();
    const tool = await makeRunCodeToolForRun(toolInput(state));
    const out = await run(
      tool,
      "async () => { try { const r = await fetch('https://example.com'); return 'reached ' + r.status; } catch (e) { return 'refused'; } }",
    );
    // globalOutbound: null. The isolate's only reach is the RPC capabilities
    // passed as call arguments, so there is nothing for a credential to leak to.
    expect(out.result).toBe("refused");
  });
});
