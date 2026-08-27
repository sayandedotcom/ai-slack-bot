import type { Context } from "hono";
import { Hono } from "hono";
import type { Env } from "../index";
import { requireTeamMember } from "../api/identity";
import { importIdentityKey, seal } from "../identity/crypto";
import { upsertIdentity } from "../db/identities";
import { importStateKey, mintState, verifyState } from "./state";

/**
 * Connecting a fire-fighter's own Slack account, so the agent can post AS
 * them rather than as a bot.
 *
 * The whole security of this file is one sentence: the identity being
 * connected comes from the VERIFIED Access JWT at `start`, is carried across
 * the round trip inside a signed `state` (see `./state.ts`), and is read back
 * out of that state at `callback`. Slack's response and the callback's query
 * string are never allowed to name whose row is written -- Slack is asked only
 * "which Slack account is this token for", never "who is this person here".
 *
 * The token itself is sealed the moment it exists and only the ciphertext ever
 * leaves this function's stack (`identity/crypto.ts`). Nothing in this file
 * logs a token, a ciphertext, a client secret, or an OAuth code, and the 502
 * path deliberately discards Slack's own error body rather than echoing it --
 * Slack's errors quote back what you sent them.
 */

/** The two Slack endpoints. Fixed origins: no argument or env var moves them. */
const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const SLACK_ACCESS_URL = "https://slack.com/api/oauth.v2.access";

/**
 * The only scope asked for, and it is a USER scope, not a bot scope: the point
 * of this flow is posting as the human. Kept as a constant because it is also
 * what gets recorded on the row.
 */
const SLACK_USER_SCOPE = "chat:write";

export const slackOAuth = new Hono<{ Bindings: Env }>();

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
  c: Context<{ Bindings: Env }>
): Promise<{ email: string } | Response> {
  const member = await requireTeamMember(c);
  if (member instanceof Response) return member;
  if (member.role !== "firefighter") {
    return c.json(
      fail("not_a_firefighter", "connecting an account is fire-fighters only"),
      403
    );
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

function unconfigured(
  c: Context<{ Bindings: Env }>,
  variable: string
): Response {
  return c.json(
    fail("not_configured", `missing configuration: ${variable}`),
    503
  );
}

/** Derived from the request, not from a config knob, so it is right per env. */
function redirectUri(c: Context<{ Bindings: Env }>): string {
  return `${new URL(c.req.url).origin}/api/oauth/slack/callback`;
}

/* ------------------------------------------------------------ routes ---- */

/**
 * Sends a fire-fighter to Slack's consent screen.
 *
 * Everything unforgeable about the flow is decided HERE, while there is still
 * a verified Access JWT to decide it from: the state minted below is the only
 * statement of identity the callback will ever get.
 */
slackOAuth.get("/oauth/slack/start", async (c) => {
  const identity = await requireFirefighter(c);
  if (identity instanceof Response) return identity;

  const missing = missingConfig(c.env, ["IDENTITY_KEY", "SLACK_CLIENT_ID"]);
  if (missing) return unconfigured(c, missing);

  const state = await mintState(
    await importStateKey(c.env.IDENTITY_KEY!),
    identity.email,
    "slack",
    Date.now()
  );

  const authorize = new URL(SLACK_AUTHORIZE_URL);
  authorize.searchParams.set("client_id", c.env.SLACK_CLIENT_ID!);
  authorize.searchParams.set("user_scope", SLACK_USER_SCOPE);
  authorize.searchParams.set("redirect_uri", redirectUri(c));
  authorize.searchParams.set("state", state);
  return c.redirect(authorize.toString(), 302);
});

/**
 * Slack's return leg. There is no Access JWT on this request -- the browser is
 * arriving from slack.com -- so the signed `state` is the entire basis for
 * deciding whose row gets written, and it is checked BEFORE the code is
 * exchanged: an unforgeable state is worth nothing if a forged one still gets
 * to spend a `code` first.
 */
slackOAuth.get("/oauth/slack/callback", async (c) => {
  const missing = missingConfig(c.env, [
    "IDENTITY_KEY",
    "SLACK_CLIENT_ID",
    "SLACK_CLIENT_SECRET",
  ]);
  if (missing) return unconfigured(c, missing);

  const verified = await verifyState(
    await importStateKey(c.env.IDENTITY_KEY!),
    c.req.query("state") ?? "",
    "slack",
    Date.now()
  );
  if (!verified) {
    // One message for forged, expired, foreign-provider and absent alike --
    // same discipline as `open`'s single `tampered`.
    return c.json(
      fail("invalid_state", "the connect link is invalid or has expired"),
      403
    );
  }

  const code = c.req.query("code") ?? "";
  if (!code)
    return c.json(
      fail("invalid_state", "the connect link is invalid or has expired"),
      403
    );

  let payload: {
    ok?: boolean;
    authed_user?: { id?: string; access_token?: string; scope?: string };
  };
  try {
    const response = await fetch(SLACK_ACCESS_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: c.env.SLACK_CLIENT_ID!,
        client_secret: c.env.SLACK_CLIENT_SECRET!,
        redirect_uri: redirectUri(c),
      }).toString(),
    });
    payload = (await response.json()) as typeof payload;
  } catch {
    return c.json(
      fail("slack_exchange_failed", "Slack could not complete the connection"),
      502
    );
  }

  const token = payload.authed_user?.access_token;
  const externalId = payload.authed_user?.id;
  if (payload.ok !== true || !token || !externalId) {
    // Slack's own `error` string is dropped rather than forwarded: it quotes
    // back what we sent, which includes the code and can include the client id.
    return c.json(
      fail("slack_exchange_failed", "Slack could not complete the connection"),
      502
    );
  }

  const now = Date.now();
  await upsertIdentity(
    c.env.DB,
    {
      // The STATE's email. Never `payload`, never the query string.
      email: verified.email,
      provider: "slack",
      externalId,
      scopes: payload.authed_user?.scope ?? SLACK_USER_SCOPE,
      tokenCiphertext: await seal(
        await importIdentityKey(c.env.IDENTITY_KEY!),
        token
      ),
      connectedAt: now,
    },
    now
  );

  return c.redirect("/", 302);
});
