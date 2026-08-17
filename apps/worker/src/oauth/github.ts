import type { Context } from "hono";
import { Hono } from "hono";
import type { Env } from "../index";
import { requireTeamMember } from "../api/identity";
import { importIdentityKey, seal } from "../identity/crypto";
import { upsertIdentity } from "../db/identities";
import { importStateKey, mintState, verifyState } from "./state";

/**
 * Connecting a fire-fighter's own GitHub account, so the agent can open pull
 * requests and comment AS them rather than as a shared machine user.
 *
 * The security sentence is the same one as `./slack.ts`'s, and deliberately so:
 * the identity being connected comes from the VERIFIED Access JWT at `start`,
 * rides the round trip inside a signed `state` (see `./state.ts`), and is read
 * back out of that state at `callback`. GitHub's responses and the callback's
 * query string are never allowed to name whose row is written.
 *
 * GitHub differs from Slack in one structural way: its token exchange does not
 * say WHO the token belongs to, so `external_id` costs a second call to
 * `/user`. That call is the only place GitHub gets asked "which account is
 * this", and its answer is used for nothing else -- never for the row's email.
 *
 * Nothing here logs a token, a ciphertext, a client secret or an OAuth code,
 * and both 502 paths discard GitHub's own error body rather than forwarding it:
 * GitHub's `error_description` quotes back what you sent it.
 */

/** Fixed origins: no argument or env var moves them. */
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

/**
 * The only scope asked for. `repo` is coarse -- GitHub has no narrower classic
 * scope that can both read a repository and push a branch -- and it is also
 * what gets recorded on the row.
 */
const GITHUB_SCOPE = "repo";

/** GitHub's REST API 403s a request with no User-Agent. Ours names the app. */
const USER_AGENT = "firefighter-worker";

export const githubOAuth = new Hono<{ Bindings: Env }>();

/* ------------------------------------------------------------- authz ---- */

function fail(code: string, message: string) {
  return { code, message };
}

/**
 * The roster half of the gate, on top of `requireTeamMember`'s JWT half.
 *
 * Connecting an account is FIRE-FIGHTERS ONLY: a viewer is never the speaker
 * and has nothing to post as, so a token stored for one would be a credential with
 * no purpose and a blast radius anyway.
 *
 * The verification itself is deliberately not reimplemented here. It lives in
 * `src/api/identity.ts` alongside the port registry that decides which
 * `AccessVerifier` is in play, so this file has no second authorization
 * dialect and no second way to install a fake -- a test that wants one calls
 * `installIdentityApiPorts`, whatever route it is exercising.
 */
async function requireFirefighter(
  c: Context<{ Bindings: Env }>,
): Promise<{ email: string } | Response> {
  const member = await requireTeamMember(c);
  if (member instanceof Response) return member;
  if (member.role !== "firefighter") {
    return c.json(fail("not_a_firefighter", "connecting an account is fire-fighters only"), 403);
  }
  return { email: member.email };
}

/* ------------------------------------------------------------ config ---- */

/**
 * Reports the FIRST missing secret by VARIABLE NAME. The name is the whole
 * point -- an operator needs to know which binding to set -- and a value never
 * appears, here or in the 503 body this feeds.
 */
function missingConfig(env: Env, names: readonly (keyof Env)[]): string | null {
  for (const name of names) {
    const value = env[name];
    if (typeof value !== "string" || value.length === 0) return String(name);
  }
  return null;
}

function unconfigured(c: Context<{ Bindings: Env }>, variable: string): Response {
  return c.json(fail("not_configured", `missing configuration: ${variable}`), 503);
}

/** Derived from the request, not from a config knob, so it is right per env. */
function redirectUri(c: Context<{ Bindings: Env }>): string {
  return `${new URL(c.req.url).origin}/api/oauth/github/callback`;
}

/* ------------------------------------------------------------ routes ---- */

/**
 * Sends a fire-fighter to GitHub's consent screen.
 *
 * Everything unforgeable about the flow is decided HERE, while there is still
 * a verified Access JWT to decide it from: the state minted below is the only
 * statement of identity the callback will ever get.
 */
githubOAuth.get("/oauth/github/start", async (c) => {
  const identity = await requireFirefighter(c);
  if (identity instanceof Response) return identity;

  const missing = missingConfig(c.env, ["IDENTITY_KEY", "GITHUB_CLIENT_ID"]);
  if (missing) return unconfigured(c, missing);

  const state = await mintState(
    await importStateKey(c.env.IDENTITY_KEY!),
    identity.email,
    "github",
    Date.now(),
  );

  const authorize = new URL(GITHUB_AUTHORIZE_URL);
  authorize.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID!);
  authorize.searchParams.set("scope", GITHUB_SCOPE);
  authorize.searchParams.set("redirect_uri", redirectUri(c));
  authorize.searchParams.set("state", state);
  return c.redirect(authorize.toString(), 302);
});

/**
 * GitHub's return leg. There is no Access JWT on this request -- the browser is
 * arriving from github.com -- so the signed `state` is the entire basis for
 * deciding whose row gets written, and it is checked BEFORE the code is
 * exchanged: an unforgeable state is worth nothing if a forged one still gets
 * to spend a `code` first.
 */
githubOAuth.get("/oauth/github/callback", async (c) => {
  const missing = missingConfig(c.env, ["IDENTITY_KEY", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]);
  if (missing) return unconfigured(c, missing);

  const verified = await verifyState(
    await importStateKey(c.env.IDENTITY_KEY!),
    c.req.query("state") ?? "",
    "github",
    Date.now(),
  );
  if (!verified) {
    // One message for forged, expired, foreign-provider and absent alike --
    // same discipline as `verifyState`'s single `null`.
    return c.json(fail("invalid_state", "the connect link is invalid or has expired"), 403);
  }

  const code = c.req.query("code") ?? "";
  if (!code) return c.json(fail("invalid_state", "the connect link is invalid or has expired"), 403);

  const exchangeFailed = () =>
    c.json(fail("github_exchange_failed", "GitHub could not complete the connection"), 502);

  let payload: { access_token?: string; scope?: string; token_type?: string; error?: string };
  try {
    const response = await fetch(GITHUB_ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        // Without this GitHub answers form-encoded, whatever the body is.
        Accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({
        code,
        client_id: c.env.GITHUB_CLIENT_ID!,
        client_secret: c.env.GITHUB_CLIENT_SECRET!,
        redirect_uri: redirectUri(c),
      }).toString(),
    });
    payload = (await response.json()) as typeof payload;
  } catch {
    return exchangeFailed();
  }

  const token = payload.access_token;
  if (!token) {
    // GitHub answers a bad code with 200 and `{"error":"..."}`. That string is
    // dropped rather than forwarded: it quotes back what we sent them.
    return exchangeFailed();
  }

  // GitHub's exchange never says who the token is for, so ask -- and ask only
  // this, using the answer for `external_id` and nothing else.
  let login: string | undefined;
  try {
    const response = await fetch(GITHUB_USER_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        // GitHub's REST API 403s a request without one.
        "User-Agent": USER_AGENT,
      },
    });
    if (!response.ok) return exchangeFailed();
    login = ((await response.json()) as { login?: string }).login;
  } catch {
    return exchangeFailed();
  }
  if (!login) return exchangeFailed();

  const now = Date.now();
  await upsertIdentity(
    c.env.DB,
    {
      // The STATE's email. Never `/user`'s answer, never the query string.
      email: verified.email,
      provider: "github",
      externalId: login,
      scopes: payload.scope ?? GITHUB_SCOPE,
      tokenCiphertext: await seal(await importIdentityKey(c.env.IDENTITY_KEY!), token),
      connectedAt: now,
    },
    now,
  );

  return c.redirect("/", 302);
});
