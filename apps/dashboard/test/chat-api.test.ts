/**
 * The two chat creation doors and the two ways a created run is addressed.
 *
 * Phase 25 gives the chat page two mutually exclusive creation calls — the
 * legacy one that hands the opening message to the coordinator, and the Think
 * one that mints an empty run so the first turn can go through the agent
 * socket instead — and two transports that both address a run by its public
 * `runs.id`. The run key (`chat:{uuid}` / `slack:{channel}:{ts}`) is a DO name
 * and is never allowed into a URL the browser builds (invariant 10).
 *
 * Node environment: this package's vitest has no DOM (there is no `test` block
 * in `vite.config.ts`), so nothing here renders a component — every claim is
 * made against the module that actually builds the request or the URL.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { agentFetch } from "agents/client";

import { createChat, createEmptyChat } from "../src/chat/api";
import type { RunDetail } from "../src/runs/api";
import { postSteer } from "../src/runs/api";
import { openRunSocket } from "../src/runs/socket";

/**
 * `camelCaseToKebabCase("RUN_AGENTS")`, pinned to the wrangler BINDING name.
 * Kept in step with the private `AGENT_NAMESPACE` in
 * `src/runs/agent-session.tsx`, which is not exported.
 */
const AGENT_NAMESPACE = "run-agents";

/** The public id the API hands back — a bare UUID, never a run key. */
const RUN_ID = "8f1c1f1e-4c9a-4a2b-9f1e-2f0a9d3b7c55";
/** The DO name for the same run. It must never appear in a URL below. */
const RUN_KEY = `chat:${RUN_ID}`;

const RUN: RunDetail = {
  id: RUN_ID,
  origin: "chat",
  status: "live",
  shadow: false,
  summary: null,
  channelId: null,
  threadTs: null,
  createdAt: 1,
  updatedAt: 2,
};

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

function bodyOf(spy: ReturnType<typeof stubFetch>, call = 0): Record<string, unknown> {
  const init = spy.mock.calls[call]?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat creation doors", () => {
  it("createEmptyChat posts no firstMessage, so the opening turn cannot land in the legacy session", async () => {
    const fetchSpy = stubFetch(() => jsonResponse(201, { run: RUN }));

    await expect(createEmptyChat()).resolves.toEqual(RUN);

    const [url, init] = fetchSpy.mock.calls[0] as [unknown, RequestInit];
    expect(String(url)).toBe("/api/runs");
    expect(init.method).toBe("POST");
    // The exact key set, not just "no firstMessage": any field here is a field
    // the legacy coordinator would act on behind the agent's back.
    expect(Object.keys(bodyOf(fetchSpy))).toEqual([]);
  });

  it("createChat posts the firstMessage, because on the legacy chassis the coordinator is what appends it", async () => {
    const fetchSpy = stubFetch(() => jsonResponse(201, { run: RUN }));

    await expect(createChat("checkout is 500ing", "req_1")).resolves.toEqual(RUN);

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("/api/runs");
    const sent = bodyOf(fetchSpy);
    expect(Object.keys(sent).sort()).toEqual(["firstMessage", "requestId"]);
    expect(sent).toEqual({ firstMessage: "checkout is 500ing", requestId: "req_1" });
  });

  it("the same requestId is the idempotency key on both write doors — run creation and a steer", async () => {
    const fetchSpy = stubFetch((input) =>
      input === "/api/runs" ? jsonResponse(201, { run: RUN }) : jsonResponse(201, { seq: 1, appended: true }),
    );

    const requestId = "req_shared_9";
    await createChat("checkout is 500ing", requestId);
    await postSteer(RUN.id, requestId, "try the canary");

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("/api/runs");
    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(`/api/runs/${RUN_ID}/turns`);
    // Same field name, same value, on both doors: one key the worker dedupes
    // on, not two dialects.
    expect(bodyOf(fetchSpy, 0).requestId).toBe(requestId);
    expect(bodyOf(fetchSpy, 1).requestId).toBe(requestId);
  });
});

describe("addressing a created run", () => {
  it("the run socket URL is addressed by runs.id, never by the run key", async () => {
    const fetchSpy = stubFetch(() => jsonResponse(201, { run: RUN }));
    const run = await createChat("hi", "req_1");
    // The creation response carries no key at all — the browser could not
    // address by one even if it wanted to.
    expect(Object.keys(run)).not.toContain("key");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const opened: string[] = [];
    vi.stubGlobal("location", { protocol: "http:", host: "dash.local" });
    vi.stubGlobal(
      "WebSocket",
      class {
        onopen: (() => void) | null = null;
        onmessage: ((event: unknown) => void) | null = null;
        onclose: (() => void) | null = null;
        readyState = 0;
        constructor(url: string) {
          opened.push(url);
        }
        close() {}
      },
    );

    const socket = openRunSocket(run.id, {
      since: () => 0,
      onMessage: () => {},
      onConnection: () => {},
    });
    socket.close();

    expect(opened).toEqual([`ws://dash.local/ws/run/${RUN_ID}?since=0`]);
    expect(opened[0]).not.toContain(RUN_KEY);
    expect(opened[0]).not.toContain("chat%3A");
  });

  it("the agent route is addressed by runs.id, never by the run key", async () => {
    const calls: string[] = [];
    const fake = (url: unknown) => {
      calls.push(String(url));
      return Promise.resolve(jsonResponse(200, {}));
    };

    // Exactly the options `AgentSession` gives `useAgent`: the namespace derived
    // from the RUN_AGENTS binding, and the room set to the run's public id.
    await agentFetch({ agent: AGENT_NAMESPACE, name: RUN.id, host: "dash.local", fetch: fake });

    const url = new URL(calls[0] as string);
    expect(url.pathname).toBe(`/agents/${AGENT_NAMESPACE}/${RUN_ID}`);
    expect(calls[0]).not.toContain(RUN_KEY);

    // The counterfactual, and why this matters rather than being a style
    // preference: partysocket interpolates the room into the path unescaped, so
    // a key would put a raw `:` in the path segment and address a room the
    // worker never mints.
    await agentFetch({ agent: AGENT_NAMESPACE, name: RUN_KEY, host: "dash.local", fetch: fake });
    expect(new URL(calls[1] as string).pathname).toBe(`/agents/${AGENT_NAMESPACE}/${RUN_KEY}`);
  });
});
