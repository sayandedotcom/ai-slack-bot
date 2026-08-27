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
import { githubOAuth } from "../src/oauth/github";
import { importStateKey, mintState, verifyState } from "../src/oauth/state";

/**
 * The router is driven directly rather than through `src/index.ts`: mounting
 * it under `/api` is a later task's job, and these cases are about the routes'
 * own behaviour. `env` is the real workerd pool env (so `DB` is real D1) plus
 * the secrets this flow needs, which the pool does not carry.
 *
 * GitHub's connect is two round trips, not one -- the token exchange does not
 * say who the token belongs to -- so the fetch stub here records BOTH calls,
 * and the cases below assert on the pair.
 */

const IDENTITY_KEY = btoa(
  String.fromCharCode(...new Uint8Array(32).map((_, i) => (i * 11 + 5) & 0xff))
);
const ORIGIN = "https://firefighter.test";
const CALLBACK_URI = `${ORIGIN}/api/oauth/github/callback`;

const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

const FIREFIGHTER = "ronit@zellify.app";
const VIEWER = "marcus@zellify.app";

const TOKEN = "gho_super_secret_user_token";

function testEnv(overrides: Record<string, unknown> = {}) {
  return {
    ...env,
    IDENTITY_KEY,
    GITHUB_CLIENT_ID: "cid",
    GITHUB_CLIENT_SECRET: "csecret",
    ...overrides,
  } as unknown as typeof env;
}

/** Same fake-verifier trick as `test/oauth-slack.test.ts`: header IS identity. */
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

type GithubCall = {
  url: string;
  body: URLSearchParams;
  headers: Record<string, string>;
};
let calls: GithubCall[] = [];

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(
    (init?.headers ?? {}) as Record<string, string>
  )) {
    out[name.toLowerCase()] = value;
  }
  return out;
}

/**
 * `exchange` answers the access_token URL, `user` answers `GET /user`; either
 * may be given a status so a case can make one leg fail without the other.
 */
function stubGithub(
  exchange: { payload: unknown; status?: number },
  user: { payload: unknown; status?: number } = {
    payload: { login: "octo-ronit" },
  }
) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const target = String(url);
    calls.push({
      url: target,
      body: new URLSearchParams(init?.body ? String(init.body) : ""),
      headers: headersOf(init),
    });
    const leg = target === USER_URL ? user : exchange;
    return new Response(JSON.stringify(leg.payload), {
      status: leg.status ?? 200,
    });
  });
}

const okExchange = {
  payload: { access_token: TOKEN, scope: "repo", token_type: "bearer" },
};

function get(
  path: string,
  headers: Record<string, string> = {},
  envOverrides = {}
) {
  return githubOAuth.request(
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

describe("GET /oauth/github/start", () => {
  it("401s with no Access JWT", async () => {
    const res = await get("/oauth/github/start");
    expect(res.status).toBe(401);
    expect((await res.json<{ code: string }>()).code).toBe(
      "access_jwt_invalid"
    );
  });

  it("403s a viewer", async () => {
    const res = await get("/oauth/github/start", {
      "Cf-Access-Jwt-Assertion": VIEWER,
    });
    expect(res.status).toBe(403);
    expect((await res.json<{ code: string }>()).code).toBe("not_a_firefighter");
  });

  it("503s by VARIABLE NAME when IDENTITY_KEY is unset, never a value", async () => {
    const res = await get(
      "/oauth/github/start",
      { "Cf-Access-Jwt-Assertion": FIREFIGHTER },
      { IDENTITY_KEY: undefined }
    );
    expect(res.status).toBe(503);
    const body = await res.json<{ message: string }>();
    expect(body.message).toBe("missing configuration: IDENTITY_KEY");
    expect(body.message).not.toContain(IDENTITY_KEY);
  });

  it("redirects a fire-fighter to GitHub with repo scope, derived redirect_uri, and a verifiable state", async () => {
    const res = await get("/oauth/github/start", {
      "Cf-Access-Jwt-Assertion": FIREFIGHTER,
    });
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://github.com/login/oauth/authorize"
    );
    expect(location.searchParams.get("scope")).toBe("repo");
    expect(location.searchParams.get("client_id")).toBe("cid");
    expect(location.searchParams.get("redirect_uri")).toBe(CALLBACK_URI);

    const state = location.searchParams.get("state")!;
    const key = await importStateKey(IDENTITY_KEY);
    expect(await verifyState(key, state, "github", Date.now())).toEqual({
      email: FIREFIGHTER,
    });
  });
});

/* ----------------------------------------------------------- callback --- */

async function goodState(email = FIREFIGHTER): Promise<string> {
  return mintState(
    await importStateKey(IDENTITY_KEY),
    email,
    "github",
    Date.now()
  );
}

async function storedRow(email: string) {
  return env.DB.prepare(
    "SELECT email, external_id, scopes, token_ciphertext FROM identities WHERE email = ? AND provider = 'github'"
  )
    .bind(email)
    .first<{
      email: string;
      external_id: string;
      scopes: string;
      token_ciphertext: string;
    }>();
}

describe("GET /oauth/github/callback", () => {
  it("403s a forged state and makes NO exchange call", async () => {
    stubGithub(okExchange);
    const res = await get(
      "/oauth/github/callback?code=abc&state=forged.nonsense"
    );
    expect(res.status).toBe(403);
    expect((await res.json<{ code: string }>()).code).toBe("invalid_state");
    expect(calls).toEqual([]);
  });

  it("403s a state minted for slack, and makes NO exchange call", async () => {
    stubGithub(okExchange);
    const foreign = await mintState(
      await importStateKey(IDENTITY_KEY),
      FIREFIGHTER,
      "slack",
      Date.now()
    );
    const res = await get(
      `/oauth/github/callback?code=abc&state=${encodeURIComponent(foreign)}`
    );
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("403s an expired state, and makes NO exchange call", async () => {
    stubGithub(okExchange);
    const stale = await mintState(
      await importStateKey(IDENTITY_KEY),
      FIREFIGHTER,
      "github",
      Date.now() - 11 * 60_000
    );
    const res = await get(
      `/oauth/github/callback?code=abc&state=${encodeURIComponent(stale)}`
    );
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("403s an absent state, and makes NO exchange call", async () => {
    stubGithub(okExchange);
    const res = await get("/oauth/github/callback?code=abc");
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("exchanges as JSON, reads the login from /user, seals the token, then 302s home", async () => {
    stubGithub(okExchange);
    const state = await goodState();
    const res = await get(
      `/oauth/github/callback?code=thecode&state=${encodeURIComponent(state)}`
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");

    expect(calls).toHaveLength(2);

    expect(calls[0].url).toBe(ACCESS_TOKEN_URL);
    expect(calls[0].headers.accept).toBe("application/json");
    expect(Object.fromEntries(calls[0].body)).toEqual({
      code: "thecode",
      client_id: "cid",
      client_secret: "csecret",
      redirect_uri: CALLBACK_URI,
    });

    expect(calls[1].url).toBe(USER_URL);
    expect(calls[1].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[1].headers["user-agent"]).toBeTruthy();

    const row = await storedRow(FIREFIGHTER);
    expect(row?.external_id).toBe("octo-ronit");
    expect(row?.scopes).toBe("repo");
    expect(row?.token_ciphertext).not.toContain(TOKEN);
    expect(row?.token_ciphertext.length).toBeGreaterThan(0);
  });

  it("stores under the STATE's email even when the query string claims another", async () => {
    stubGithub(okExchange);
    const state = await goodState(FIREFIGHTER);
    const res = await get(
      `/oauth/github/callback?code=thecode&email=${encodeURIComponent(VIEWER)}&state=${encodeURIComponent(state)}`
    );
    expect(res.status).toBe(302);
    expect(await storedRow(FIREFIGHTER)).not.toBeNull();
    expect(await storedRow(VIEWER)).toBeNull();
  });

  it("502s a GitHub error body without echoing it", async () => {
    stubGithub({ payload: { error: "bad_verification_code" } });
    const state = await goodState();
    const res = await get(
      `/oauth/github/callback?code=thecode&state=${encodeURIComponent(state)}`
    );
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("bad_verification_code");
    expect(text).not.toContain("thecode");
    expect(await storedRow(FIREFIGHTER)).toBeNull();
  });

  it("502s generically when GET /user fails, and stores nothing", async () => {
    stubGithub(okExchange, {
      payload: { message: "Bad credentials" },
      status: 401,
    });
    const state = await goodState();
    const res = await get(
      `/oauth/github/callback?code=thecode&state=${encodeURIComponent(state)}`
    );
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("Bad credentials");
    expect(text).not.toContain(TOKEN);
    expect(await storedRow(FIREFIGHTER)).toBeNull();
  });

  it("503s on a missing client secret before touching GitHub", async () => {
    stubGithub(okExchange);
    const state = await goodState();
    const res = await get(
      `/oauth/github/callback?code=thecode&state=${encodeURIComponent(state)}`,
      {},
      { GITHUB_CLIENT_SECRET: undefined }
    );
    expect(res.status).toBe(503);
    expect((await res.json<{ message: string }>()).message).toBe(
      "missing configuration: GITHUB_CLIENT_SECRET"
    );
    expect(calls).toEqual([]);
  });
});
