import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AccessIdentity,
  AccessJwtError,
  type AccessVerifier,
} from "../src/access/jwt";
import {
  installIdentityApiPorts,
  resetIdentityApiPorts,
} from "../src/api/identity";
import { slackOAuth } from "../src/oauth/slack";
import { importStateKey, mintState, verifyState } from "../src/oauth/state";

/**
 * The router is driven directly rather than through `src/index.ts`: mounting
 * it under `/api` is a later task's job, and these cases are about the routes'
 * own behaviour. `env` is the real workerd pool env (so `DB` is real D1) plus
 * the secrets this flow needs, which the pool does not carry.
 */

const IDENTITY_KEY = btoa(
  String.fromCharCode(...new Uint8Array(32).map((_, i) => (i * 11 + 5) & 0xff))
);
const ORIGIN = "https://firefighter.test";
const CALLBACK_URI = `${ORIGIN}/api/oauth/slack/callback`;

const FIREFIGHTER = "ronit@zellify.app";
const VIEWER = "marcus@zellify.app";

const TOKEN = "xoxp-super-secret-user-token";

function testEnv(overrides: Record<string, unknown> = {}) {
  return {
    ...env,
    IDENTITY_KEY,
    SLACK_CLIENT_ID: "cid",
    SLACK_CLIENT_SECRET: "csecret",
    ...overrides,
  } as unknown as typeof env;
}

/** Same fake-verifier trick as `test/approval-api.test.ts`: header IS identity. */
function fakeVerifier(): AccessVerifier {
  return {
    async verify(jwt: string): Promise<AccessIdentity> {
      if (!jwt) throw new AccessJwtError("missing", "no token was supplied");
      if (!jwt.includes("@"))
        throw new AccessJwtError("malformed", "not an email-shaped fake token");
      return { email: jwt };
    },
  };
}

type SlackCall = { url: string; body: URLSearchParams };
let calls: SlackCall[] = [];

function stubSlack(payload: unknown, status = 200) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      body: new URLSearchParams(String(init.body)),
    });
    return new Response(JSON.stringify(payload), { status });
  });
}

const okPayload = {
  ok: true,
  authed_user: { id: "U123", access_token: TOKEN, scope: "chat:write" },
};

function get(
  path: string,
  headers: Record<string, string> = {},
  envOverrides = {}
) {
  return slackOAuth.request(
    `${ORIGIN}${path}`,
    { headers },
    testEnv(envOverrides)
  );
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM identities").run();
  resetIdentityApiPorts();
  installIdentityApiPorts({ verifier: fakeVerifier() });
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------- start --- */

describe("GET /oauth/slack/start", () => {
  it("401s with no Access JWT", async () => {
    const res = await get("/oauth/slack/start");
    expect(res.status).toBe(401);
    expect((await res.json<{ code: string }>()).code).toBe(
      "access_jwt_invalid"
    );
  });

  it("403s a viewer", async () => {
    const res = await get("/oauth/slack/start", {
      "Cf-Access-Jwt-Assertion": VIEWER,
    });
    expect(res.status).toBe(403);
    expect((await res.json<{ code: string }>()).code).toBe("not_a_firefighter");
  });

  it("503s by VARIABLE NAME when IDENTITY_KEY is unset, never a value", async () => {
    const res = await get(
      "/oauth/slack/start",
      { "Cf-Access-Jwt-Assertion": FIREFIGHTER },
      { IDENTITY_KEY: undefined }
    );
    expect(res.status).toBe(503);
    const body = await res.json<{ message: string }>();
    expect(body.message).toBe("missing configuration: IDENTITY_KEY");
    expect(body.message).not.toContain(IDENTITY_KEY);
  });

  it("redirects a fire-fighter to Slack with the user scope, derived redirect_uri, and a verifiable state", async () => {
    const res = await get("/oauth/slack/start", {
      "Cf-Access-Jwt-Assertion": FIREFIGHTER,
    });
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://slack.com/oauth/v2/authorize"
    );
    expect(location.searchParams.get("user_scope")).toBe("chat:write");
    expect(location.searchParams.get("client_id")).toBe("cid");
    expect(location.searchParams.get("redirect_uri")).toBe(CALLBACK_URI);

    const state = location.searchParams.get("state")!;
    const key = await importStateKey(IDENTITY_KEY);
    expect(await verifyState(key, state, "slack", Date.now())).toEqual({
      email: FIREFIGHTER,
    });
  });
});

/* ----------------------------------------------------------- callback --- */

async function goodState(email = FIREFIGHTER): Promise<string> {
  return mintState(
    await importStateKey(IDENTITY_KEY),
    email,
    "slack",
    Date.now()
  );
}

async function storedRow(email: string) {
  return env.DB.prepare(
    "SELECT email, external_id, scopes, token_ciphertext FROM identities WHERE email = ? AND provider = 'slack'"
  )
    .bind(email)
    .first<{
      email: string;
      external_id: string;
      scopes: string;
      token_ciphertext: string;
    }>();
}

describe("GET /oauth/slack/callback", () => {
  it("403s a forged state and makes NO exchange call", async () => {
    stubSlack(okPayload);
    const res = await get(
      "/oauth/slack/callback?code=abc&state=forged.nonsense"
    );
    expect(res.status).toBe(403);
    expect((await res.json<{ code: string }>()).code).toBe("invalid_state");
    expect(calls).toEqual([]);
  });

  it("403s a state minted for github, and makes NO exchange call", async () => {
    stubSlack(okPayload);
    const foreign = await mintState(
      await importStateKey(IDENTITY_KEY),
      FIREFIGHTER,
      "github",
      Date.now()
    );
    const res = await get(
      `/oauth/slack/callback?code=abc&state=${encodeURIComponent(foreign)}`
    );
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("403s an expired state, and makes NO exchange call", async () => {
    stubSlack(okPayload);
    const stale = await mintState(
      await importStateKey(IDENTITY_KEY),
      FIREFIGHTER,
      "slack",
      Date.now() - 11 * 60_000
    );
    const res = await get(
      `/oauth/slack/callback?code=abc&state=${encodeURIComponent(stale)}`
    );
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("exchanges the code form-encoded and stores sealed ciphertext, then 302s home", async () => {
    stubSlack(okPayload);
    const state = await goodState();
    const res = await get(
      `/oauth/slack/callback?code=thecode&state=${encodeURIComponent(state)}`
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://slack.com/api/oauth.v2.access");
    expect(Object.fromEntries(calls[0].body)).toEqual({
      code: "thecode",
      client_id: "cid",
      client_secret: "csecret",
      redirect_uri: CALLBACK_URI,
    });

    const row = await storedRow(FIREFIGHTER);
    expect(row?.external_id).toBe("U123");
    expect(row?.scopes).toBe("chat:write");
    expect(row?.token_ciphertext).not.toContain(TOKEN);
    expect(row?.token_ciphertext.length).toBeGreaterThan(0);
  });

  it("stores under the STATE's email even when the query string claims another", async () => {
    stubSlack(okPayload);
    const state = await goodState(FIREFIGHTER);
    const res = await get(
      `/oauth/slack/callback?code=thecode&email=${encodeURIComponent(VIEWER)}&state=${encodeURIComponent(state)}`
    );
    expect(res.status).toBe(302);
    expect(await storedRow(FIREFIGHTER)).not.toBeNull();
    expect(await storedRow(VIEWER)).toBeNull();
  });

  it("502s a Slack {ok:false} without echoing its body", async () => {
    stubSlack({ ok: false, error: "invalid_code for thecode with client cid" });
    const state = await goodState();
    const res = await get(
      `/oauth/slack/callback?code=thecode&state=${encodeURIComponent(state)}`
    );
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("invalid_code");
    expect(text).not.toContain("thecode");
    expect(await storedRow(FIREFIGHTER)).toBeNull();
  });

  it("503s on a missing client secret before touching Slack", async () => {
    stubSlack(okPayload);
    const state = await goodState();
    const res = await get(
      `/oauth/slack/callback?code=thecode&state=${encodeURIComponent(state)}`,
      {},
      { SLACK_CLIENT_SECRET: undefined }
    );
    expect(res.status).toBe(503);
    expect((await res.json<{ message: string }>()).message).toBe(
      "missing configuration: SLACK_CLIENT_SECRET"
    );
    expect(calls).toEqual([]);
  });
});
