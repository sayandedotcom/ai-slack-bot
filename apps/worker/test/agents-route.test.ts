import {
  createExecutionContext,
  env,
  evictDurableObject,
  listDurableObjectIds,
  runInDurableObject,
} from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import worker, { type Env } from "../src/index";
import type { RunAgent } from "../src/run/agent";
import { createRunFromChat } from "../src/run/chassis";
import { runStubForKey } from "../src/run/keys";
import type { RunRecord } from "../src/run/repository";

/**
 * `/agents/*` — the HTTP and socket transport in front of the Think chassis.
 *
 * This is the boundary `src/index.ts` builds by hand, and everything it does is
 * load-bearing: the chassis refusal, the `runs.id` -> run-key rewrite that keeps
 * a Durable Object name out of a browser URL (invariant 10), and the fact that
 * the path is a NEW top-level route on the same origin as the one path this
 * Worker deliberately leaves unauthenticated (`/proofs/*`).
 *
 * ## How the route is driven
 *
 * Through the Worker's own default export, not `SELF`. The whole subject is a
 * non-default `RUN_CHASSIS`, and the pool's `SELF` is bound to the pool env
 * (which sets no `RUN_CHASSIS`, i.e. legacy). `worker.fetch(request, env, ctx)`
 * is the same entry `SELF` reaches, with the env chosen per case — the pattern
 * `test/run-chassis.test.ts` uses for `runsApi`/`runsWs`, one level up so the
 * `/agents/*` handler in `src/index.ts` is actually exercised.
 *
 * A 101 crosses this boundary intact: nothing is serialized when the handler is
 * called in-process, so `response.webSocket` is the live client end.
 *
 * ## Harness rules that bite here
 *
 * Pool storage is shared across tests and files (no `isolatedStorage`), so every
 * case mints its own run — `createRunFromChat` gives a fresh `chat:{uuid}` key
 * plus the D1 row the agent's constructor needs to confirm the run at all (see
 * `test/run-agent-core.test.ts`). No assertion depends on an absolute count of
 * anything global.
 */

const ORIGIN = "https://firefighter.test";

const think: Env = { ...env, RUN_CHASSIS: "think" };
const legacy: Env = { ...env, RUN_CHASSIS: "legacy" };

/** One request through the real Worker entry, on the chassis this case wants. */
async function hit(path: string, on: Env, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), on, createExecutionContext());
}

/** A run that exists in D1, on the chassis given. Returns the whole record. */
async function freshRun(on: Env = think): Promise<RunRecord> {
  return createRunFromChat(on, {});
}

function agentFor(key: string): Promise<DurableObjectStub<RunAgent>> {
  return getAgentByName<Env, RunAgent>(env.RUN_AGENTS, key);
}

function userMessage(text: string): UIMessage {
  return { id: `msg_${crypto.randomUUID()}`, role: "user", parts: [{ type: "text", text }] };
}

/* ------------------------------------------------------------- the socket -- */

type Frame = Record<string, unknown>;
type Tab = { ws: WebSocket; raw: string[] };

/** A browser tab on this run, addressed by its PUBLIC id exactly as the SPA does. */
async function openTab(runId: string, on: Env = think): Promise<Tab> {
  const response = await hit(`/agents/run-agents/${runId}`, on, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const raw: string[] = [];
  // Listener before `accept()`, so the connect burst is captured rather than
  // raced — the same ordering `test/helpers/run-ws.ts` relies on.
  ws.addEventListener("message", (event) => {
    raw.push(String(event.data));
  });
  ws.accept();
  return { ws, raw };
}

function framesOf(tab: Tab): Frame[] {
  return tab.raw.flatMap((line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      return parsed !== null && typeof parsed === "object" ? [parsed as Frame] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Poll until `predicate` holds, or give up QUIETLY.
 *
 * Deliberately non-throwing. Several cases below are `it.fails`, and a helper
 * that threw on timeout would make them "pass" for the wrong reason — the
 * assertion that follows has to be the thing that decides.
 */
async function settle(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The last frame of the Agents SDK's connect burst; a tab is "up" once it lands. */
async function connected(tab: Tab): Promise<void> {
  await settle(() => framesOf(tab).some((frame) => frame.type === "cf_agent_mcp_servers"));
  // The connect burst is several sends across two `onConnect` wrappers (Agent's
  // and Think's); this lets the tail of it arrive before a case counts frames.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

/** Every transcript broadcast this tab has received, newest last. */
function transcriptFrames(tab: Tab): Frame[] {
  return framesOf(tab).filter((frame) => frame.type === "cf_agent_chat_messages");
}

/** The results of every RPC answer carrying `id`, in arrival order. */
function rpcAnswers(tab: Tab, id: string): Frame[] {
  return framesOf(tab).filter((frame) => frame.type === "rpc" && frame.id === id);
}

/* --------------------------------------------------------- the chassis gate -- */

describe("the agent transport is part of one chassis, not both", () => {
  /**
   * The mirror image of `src/api/runs.ts`'s `refuseIfThink`, and it has to be
   * asserted against a run that REALLY EXISTS: a bogus id would 404 either way
   * and prove nothing. `routeAgentRequest` would otherwise happily boot a
   * `RunAgent` for a run `RunDO` owns and hand the operator an empty transcript
   * for an incident that is very much alive.
   */
  it("refuses /agents/* by name on the legacy chassis rather than booting an empty session", async () => {
    const run = await freshRun(legacy);

    const response = await hit(`/agents/run-agents/${run.id}/get-messages`, legacy);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "chassis_not_active" });

    // ...and nothing was created on the other chassis on the way past. A refusal
    // that still instantiated the agent would leak an object per probe.
    const ids = await listDurableObjectIds(env.RUN_AGENTS);
    const named = env.RUN_AGENTS.idFromName(run.key);
    expect(ids.some((id) => id.equals(named))).toBe(false);
  });
});

/* ------------------------------------------------------- id -> key resolution -- */

describe("the public URL carries an id, and the Worker resolves the key", () => {
  /**
   * INVARIANT 10 at the one boundary that could break it by construction.
   *
   * `routePartykitRequest` names the Durable Object with
   * `idFromName(<third path segment>)`, verbatim and undecoded. If the browser
   * put that segment there directly, the public URL WOULD BE the DO name — so
   * `src/index.ts` looks the id up in D1 and rewrites the path before routing.
   *
   * Both halves are asserted, because only together do they say "a key is not an
   * id": the id must resolve to the session that actually holds the transcript,
   * and the key must not resolve to anything at all.
   */
  it("routes a run id to the session holding its transcript, and answers a guessed raw key with 404", async () => {
    const run = await freshRun();
    const agent = await agentFor(run.key);
    await agent.addMessages([userMessage("the exports are empty since the 04:12 deploy")]);

    const byId = await hit(`/agents/run-agents/${run.id}/get-messages`, think);
    expect(byId.status).toBe(200);
    // The RIGHT session, not merely a session: an id that resolved to a fresh
    // object would answer 200 with an empty array and look fine.
    expect(JSON.stringify(await byId.json())).toContain(
      "the exports are empty since the 04:12 deploy",
    );

    // The same string a caller would have to guess to name the object directly.
    // Raw and percent-encoded, because the route decodes the segment before it
    // asks D1 and an encoded probe must not slip past a raw-string check.
    for (const segment of [run.key, encodeURIComponent(run.key)]) {
      const byKey = await hit(`/agents/run-agents/${segment}/get-messages`, think);
      expect(byKey.status).toBe(404);
      expect(await byKey.json()).toMatchObject({ code: "not_found" });
    }
  });

  it("404s an unknown run id without instantiating an agent under that name", async () => {
    // A well-formed uuid that names no row. `getRunById` answers first, so the
    // namespace is never touched — the property that keeps an unauthenticated
    // scan from costing one Durable Object per probe.
    const unknown = crypto.randomUUID();

    const response = await hit(`/agents/run-agents/${unknown}/get-messages`, think);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });

    const ids = await listDurableObjectIds(env.RUN_AGENTS);
    // Both spellings: the id as sent, and the id treated as a name the way
    // `routePartykitRequest` would have treated it had the guard not run first.
    expect(ids.some((id) => id.equals(env.RUN_AGENTS.idFromName(unknown)))).toBe(false);
  });
});

/* ------------------------------------------------------------ the access gate -- */

describe("the agent transport is gated, and /proofs stays the only path that is not", () => {
  /**
   * The Access APPLICATION itself is Cloudflare-side configuration and no test
   * in this Worker can see it. What a test CAN pin is the half that lives in
   * this repo: `/agents/*` must not be reachable through the one prefix that is
   * bypassed, so a bypass that exists for Slack's unfurler cannot be turned into
   * an anonymous read of a customer's transcript by path confusion.
   *
   * `/proofs/:key` is a single Hono segment, and Hono hands the handler a
   * DECODED param — which is exactly why the probe that gets there is the
   * percent-encoded one (see the same argument in `src/api/proofs.ts` and
   * `test/api-proofs.test.ts`). So that is the probe used here.
   */
  it("does not serve an agent transcript through the Access-bypassed /proofs prefix", async () => {
    const run = await freshRun();
    const agent = await agentFor(run.key);
    await agent.addMessages([userMessage("only a signed-in operator may read this")]);

    // The gated path works, so the negative below is about the PREFIX rather
    // than about the transcript being empty.
    const gated = await hit(`/agents/run-agents/${run.id}/get-messages`, think);
    expect(gated.status).toBe(200);
    expect(JSON.stringify(await gated.json())).toContain("only a signed-in operator may read this");

    const smuggled = await hit(
      `/proofs/${encodeURIComponent(`agents/run-agents/${run.id}/get-messages`)}`,
      think,
    );
    expect(smuggled.status).toBe(404);
    expect(await smuggled.text()).not.toContain("only a signed-in operator may read this");
  });
});

/* ------------------------------------------------------------- POST /api/runs -- */

describe("POST /api/runs on the think chassis", () => {
  /**
   * The route used to call `createChatRun` — i.e. `RunDO` — unconditionally, so
   * under `RUN_CHASSIS=think` the opening message landed in a session the
   * dashboard was not connected to and was never answered. No error, no event.
   *
   * `test/run-chassis.test.ts` proves the response body carries no key. What is
   * NOT proven anywhere else is the negative half of "lands in the RunAgent":
   * that the legacy object for the same key was never brought to life. Both are
   * asserted here, through the real HTTP route, because the route is the thing
   * that used to be wrong.
   */
  it("puts the opening message in the RunAgent and leaves RunDO for the same key untouched", async () => {
    const requestId = crypto.randomUUID();

    const response = await hit("/api/runs", think, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstMessage: "the deploy is stuck", requestId }),
    });
    expect(response.status).toBe(201);

    const body = (await response.json()) as { run: Record<string, unknown> };
    expect(body.run.origin).toBe("chat");
    // The private key never crosses to the browser (invariant 10).
    expect(Object.keys(body.run)).not.toContain("key");

    const row = await env.DB.prepare('SELECT "key" FROM runs WHERE id = ?')
      .bind(String(body.run.id))
      .first<{ key: string }>();
    const key = String(row?.key);
    expect(key.startsWith("chat:")).toBe(true);

    // The Think session holds the opening submission, under the SAME
    // `steer:{requestId}` token the legacy path uses as its turn id. Read from
    // inside the object: `ThinkSubmissionInspection`'s optional fields do not
    // survive the Durable Object stub's RPC type mapping.
    const agent = await agentFor(key);
    const admitted = await runInDurableObject(agent, async (instance: RunAgent) =>
      (await instance.listSubmissions({ limit: 50 })).map((s) => s.idempotencyKey ?? "(none)"),
    );
    expect(admitted).toEqual([`steer:${requestId}`]);

    // ...and the legacy object for the same key was never initialized. This is
    // the assertion the silent failure would have broken: `RunDO` answers every
    // read successfully, so a turn committed there looks like a healthy run.
    expect(await runStubForKey(env.RUNS, key).state()).toBeNull();
  });

  it("rejects a blank opening message before any run exists to answer it", async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs").first<{ n: number }>();

    const response = await hit("/api/runs", think, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstMessage: "   " }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "empty_content" });

    // The load-bearing half. A route that validated AFTER creating the run would
    // leave a permanently empty incident in the dashboard for every fat-fingered
    // submit, and the 400 would still look correct.
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });
});

/* ------------------------------------------------------------ the live socket -- */

describe("the agent socket", () => {
  /**
   * KNOWN DEFECT — see TEST-FINDINGS.md.
   *
   * The legacy socket dedupes a steer on `steer:{requestId}`, so a dashboard
   * that retries an unacknowledged send does not steer twice
   * (`test/run-ws-live.test.ts` § "is idempotent on requestId"). On this chassis
   * a steer is an Agents SDK `@callable` RPC, whose only request identity is the
   * frame's `id`, and `queueSteer` (src/run/agent-steering.ts) inserts a row
   * unconditionally — no idempotency column, no read of the rpc id. So a retried
   * steer is spliced into the next model step twice, which is a human correction
   * the model is told about twice.
   *
   * `it.fails` rather than a fix: `src/` belongs to the drill terminal.
   */
  it.fails("does not double-steer when a tab retries one send", async () => {
    const run = await freshRun();
    const tab = await openTab(run.id);
    await connected(tab);

    // The SAME frame twice, id included — a retry, not a second instruction.
    const frame = JSON.stringify({
      type: "rpc",
      id: "r-steer-1",
      method: "steer",
      args: ["check the staging logs first"],
    });
    tab.ws.send(frame);
    await settle(() => rpcAnswers(tab, "r-steer-1").length >= 1);
    tab.ws.send(frame);
    await settle(() => rpcAnswers(tab, "r-steer-1").length >= 2);

    const answers = rpcAnswers(tab, "r-steer-1");
    expect(answers).toHaveLength(2);
    for (const answer of answers) expect(answer.success).toBe(true);
    // `queued` is the depth AFTER the insert, so an idempotent second delivery
    // reports the same depth as the first. Today it reports 2.
    expect(answers.map((answer) => answer.result)).toEqual([{ queued: 1 }, { queued: 1 }]);

    tab.ws.close();
  });

  /**
   * A refused call is answered to the caller and to NOBODY else, and it is
   * refused for the right reason.
   *
   * The socket carries generic RPC: `{type:"rpc", method, args}` invokes a method
   * by NAME on the agent. `steer` is the one the dashboard is meant to reach;
   * `escalate` opens an approval card — a control write with a human decision
   * behind it — and it is not `@callable`, so the transport must refuse it
   * before it is ever applied. The broadcast half matters separately: an error
   * that fanned out would put one tab's mistake into every operator's transcript.
   */
  it("refuses a non-callable method to the tab that sent it, and tells no other tab", async () => {
    const run = await freshRun();
    const typing = await openTab(run.id);
    const watching = await openTab(run.id);
    await connected(typing);
    await connected(watching);
    const quiet = watching.raw.length;

    typing.ws.send(
      JSON.stringify({
        type: "rpc",
        id: "r-escalate",
        method: "escalate",
        args: [{ draft: "We rolled the migration back.", why: "closes the thread" }],
      }),
    );
    await settle(() => rpcAnswers(typing, "r-escalate").length >= 1);

    const [answer] = rpcAnswers(typing, "r-escalate");
    expect(answer?.success).toBe(false);
    expect(String(answer?.error ?? "")).toContain("not callable");

    // Nothing reached the other tab...
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(watching.raw.length).toBe(quiet);

    // ...and the refusal is REAL, not just a frame: no approval was opened, so
    // no card and no nudge exist for a human to act on.
    const agent = await agentFor(run.key);
    expect(await agent.pendingApprovalsForRun({ includeResolved: true })).toEqual([]);

    typing.ws.close();
    watching.ws.close();
  });

  /**
   * Two operators watching one incident must see the same thing. A per-socket
   * transform — a filter, a re-serialization, a cursor injected per connection —
   * would make two people reading the same run disagree about what the agent
   * said, and neither would have any way to notice.
   *
   * Driven through `addMessages`, which is the production fan-out on this
   * chassis: Think's `_broadcastMessages()` is what every transcript change goes
   * through, from a step finishing to a steer being applied.
   */
  it("delivers one transcript update byte-identically to every tab on the run", async () => {
    const run = await freshRun();
    const tabA = await openTab(run.id);
    const tabB = await openTab(run.id);
    await connected(tabA);
    await connected(tabB);
    const seenA = transcriptFrames(tabA).length;
    const seenB = transcriptFrames(tabB).length;

    const marker = `the 04:12 deploy renamed a column ${crypto.randomUUID()}`;
    const agent = await agentFor(run.key);
    await agent.addMessages([userMessage(marker)]);

    await settle(
      () =>
        transcriptFrames(tabA).length > seenA &&
        transcriptFrames(tabB).length > seenB,
    );

    const fromA = transcriptFrames(tabA).at(-1);
    const fromB = transcriptFrames(tabB).at(-1);
    expect(JSON.stringify(fromA)).toContain(marker);
    // "byte-equivalent", not merely deep-equal: a per-socket transform that
    // reordered keys would slip past `toEqual`.
    expect(JSON.stringify(fromA)).toBe(JSON.stringify(fromB));

    tabA.ws.close();
    tabB.ws.close();
  });

  /**
   * Hibernation, which is the whole reason an incident thread can sit open for
   * an hour without costing anything.
   *
   * The legacy socket's version of this property is a per-socket CURSOR that
   * survives eviction (`test/run-ws-live.test.ts` § "keeps each socket's cursor
   * across eviction"). This transport has no cursor to keep — `_broadcastMessages`
   * sends the whole message list every time — so the property that carries over
   * is the attachment itself: the socket must still be a live member of the run
   * after the instance is destroyed, or a dashboard left open goes silently deaf
   * exactly when the run wakes up to answer.
   */
  it("keeps a tab attached across eviction, so a later transcript update still reaches it", async () => {
    const run = await freshRun();
    const tab = await openTab(run.id);
    await connected(tab);

    const agent = await agentFor(run.key);
    const before = `before the eviction ${crypto.randomUUID()}`;
    await agent.addMessages([userMessage(before)]);
    await settle(() => JSON.stringify(transcriptFrames(tab)).includes(before));
    expect(JSON.stringify(transcriptFrames(tab))).toContain(before);
    const delivered = transcriptFrames(tab).length;

    // Destroys the instance. The socket hibernates rather than closing.
    await evictDurableObject(agent, { webSockets: "hibernate" });

    // RE-ADDRESSED, not reused, and that is a property of this chassis rather
    // than test hygiene. partyserver runs `onStart` — which is where Think
    // builds `this.session` — from `#ensureInitialized()`, and only `fetch()`,
    // `webSocketMessage()` and `setName()` reach it. `getAgentByName` calls
    // `setName` on the way through; a raw retained stub calls none of them, so
    // an RPC on it after a wake lands on an instance with no session and throws
    // inside the vendor. Every production entry initialises — `wakeRun` goes
    // through `getAgentByName`, `/agents/*` goes through `routeAgentRequest` ->
    // `stub.fetch` — so this line is what the shipping paths do, not a shortcut
    // around the wake. The legacy `RunDO` has no init phase at all, which is why
    // `test/run-ws-live.test.ts` can reuse its stub straight across an eviction.
    const revived = await agentFor(run.key);

    const after = `after the eviction ${crypto.randomUUID()}`;
    await revived.addMessages([userMessage(after)]);
    await settle(() => transcriptFrames(tab).length > delivered);

    const latest = transcriptFrames(tab).at(-1);
    expect(JSON.stringify(latest)).toContain(after);
    // The history the socket was already carrying is still there, so the wake
    // rebuilt the session rather than starting a new one.
    expect(JSON.stringify(latest)).toContain(before);

    tab.ws.close();
  });

  /**
   * SKIPPED, and this is a statement about the transport rather than a TODO.
   *
   * The legacy socket answers a literal `"ping"` with `"pong"` from the Durable
   * Object's WebSocket auto-response, so a keepalive never wakes the message
   * handler (`test/run-ws-live.test.ts` § "auto response"). The Agents SDK
   * transport installs no auto-response: neither `agents` nor `partyserver`
   * calls `setWebSocketAutoResponse`, and a non-JSON frame falls through
   * `Agent.onMessage` to the user handler. There is therefore no behaviour here
   * to assert — asserting the absence would pin an accident of the vendor's
   * implementation rather than anything this repo decided.
   */
  it.skip("answers ping with pong without reaching the message handler", async () => {
    // Intentionally empty: see the comment above.
  });

  /**
   * KNOWN DEFECT — see TEST-FINDINGS.md.
   *
   * The Agents SDK's `sendIdentityOnConnect` defaults to TRUE, and `RunAgent`
   * does not opt out (`static options = { sendIdentityOnConnect: false }`), so
   * the first frame of every connect burst is
   * `{"type":"cf_agent_identity","name":"<run key>"}` — the Durable Object name,
   * sent to the browser.
   *
   * That is the exact string invariant 10 exists to keep server-side, and it is
   * the reason `/agents/*` does the id -> key rewrite at all: the URL was
   * scrubbed and the socket then hands the same value back over the wire. The
   * SDK even warns about it in `agents/dist/index.js` — but only when the name
   * is NOT visible in the URL, which here it is, so the warning never fires.
   *
   * `it.fails` rather than a fix: `src/` belongs to the drill terminal.
   */
  it.fails("never sends the private run key to the browser over the agent socket", async () => {
    const run = await freshRun();
    const tab = await openTab(run.id);
    await connected(tab);

    expect(framesOf(tab).length).toBeGreaterThan(0);
    expect(JSON.stringify(framesOf(tab))).not.toContain(run.key);

    tab.ws.close();
  });
});
