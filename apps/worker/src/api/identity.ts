import type { Context } from "hono";
import { Hono } from "hono";
import type { Env } from "../index";
import { AccessJwtError, makeAccessVerifier, type AccessVerifier } from "../access/jwt";
import { isFirefighter, isTeamMember } from "../access/roster";
import { listConnectStatus } from "../db/identities";
import { resolveSpeaker, SPEAKER_POOL } from "../identity/speaker";

/**
 * Who am I, and who is on duty — the two read-only questions the dashboard asks
 * before it can render anything.
 *
 * Both answers are PUBLIC-SAFE BY CONSTRUCTION, and that is the whole point of
 * keeping them in their own file. `GET /api/identity` returns an email and a
 * role; `GET /api/roster` returns the speaker, the pool and `listConnectStatus`, which
 * selects no token column at all (see `src/db/identities.ts`). No route here
 * touches `IDENTITY_KEY`, opens a sealed value, or has a ciphertext in reach —
 * so there is nothing on this surface for a serialisation mistake to leak.
 *
 * The router is exported unmounted. A later task mounts it under `/api`, which
 * is why the paths below are `/identity` and `/roster`.
 */

export const identityApi = new Hono<{ Bindings: Env }>();

/* ------------------------------------------------------------- ports ---- */

type IdentityApiPorts = {
  verifier: AccessVerifier;
};

/**
 * Module-scope port registry, the same shape `src/api/approvals.ts` uses: a
 * plain object a test can override before a request runs, with production
 * filling the gap lazily on first use because only a REQUEST carries `env`.
 */
let GLOBAL_PORTS: Partial<IdentityApiPorts> = {};

/** Test seam. */
export function installIdentityApiPorts(ports: Partial<IdentityApiPorts>): void {
  GLOBAL_PORTS = { ...GLOBAL_PORTS, ...ports };
}

/** Test seam: forget everything installed. */
export function resetIdentityApiPorts(): void {
  GLOBAL_PORTS = {};
}

/**
 * Fills in the production verifier IF NOTHING IS THERE YET.
 *
 * Stated as code rather than prose: there is no flag, no env check, and no code
 * path in this file that can produce an `AccessVerifier` other than
 * `makeAccessVerifier` itself. A test that wants a fake MUST call
 * `installIdentityApiPorts` first; anything else gets the real thing, built
 * from `ACCESS_TEAM_DOMAIN`/`ACCESS_APP_AUD`.
 */
function resolvePorts(env: Env): { verifier: AccessVerifier } {
  if (GLOBAL_PORTS.verifier === undefined) {
    GLOBAL_PORTS = {
      ...GLOBAL_PORTS,
      verifier: makeAccessVerifier({ teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_APP_AUD }),
    };
  }
  return GLOBAL_PORTS as { verifier: AccessVerifier };
}

/* ------------------------------------------------------------ authz ---- */

function fail(code: string, message: string) {
  // Code and a generic reason only — these cross to the browser.
  return { code, message };
}

/** What a verified, rostered caller is. The dashboard's whole identity model. */
export type TeamMember = {
  email: string;
  role: "firefighter" | "viewer";
};

/**
 * Verifies the Access JWT and resolves the caller's roster role, or returns the
 * `Response` to send back verbatim.
 *
 * Fails closed in both directions and in that order: an absent or unverifiable
 * token is 401 before the roster is consulted at all, and an email the roster
 * does not know is 403 even with a perfectly valid token. Access's own policy
 * is the outer gate; this is the inner one, and neither is skippable.
 *
 * Exported because both routes below go through it and nothing in this file
 * reads `Cf-Access-Jwt-Assertion` for itself.
 */
export async function requireTeamMember(
  c: Context<{ Bindings: Env }>,
): Promise<TeamMember | Response> {
  const { verifier } = resolvePorts(c.env);
  const jwt = c.req.header("Cf-Access-Jwt-Assertion") ?? "";

  let email: string;
  try {
    ({ email } = await verifier.verify(jwt));
  } catch (err) {
    const reason = err instanceof AccessJwtError ? err.code : "invalid";
    return c.json(fail("access_jwt_invalid", `token failed verification: ${reason}`), 401);
  }

  if (isFirefighter(email)) return { email, role: "firefighter" };
  if (isTeamMember(email)) return { email, role: "viewer" };
  return c.json(fail("not_a_firefighter", "not a recognized team member"), 403);
}

/* ------------------------------------------------------------- routes --- */

/** Who the browser is talking as. The dashboard's first call on every load. */
identityApi.get("/identity", async (c) => {
  const member = await requireTeamMember(c);
  if (member instanceof Response) return member;
  return c.json({ email: member.email, role: member.role });
});

/**
 * The fire-fighters board: who speaks right now, the pool in tie-break order,
 * and every roster member's connect state.
 *
 * No shift, no clock (`src/identity/speaker.ts`): `speaker` is the first
 * fire-fighter in roster order who has connected Slack — the name a direct
 * reply and the nudge DM go to — or null when nobody has. An approved reply
 * goes out as the approver instead when they have connected. `githubSpeaker`
 * is the same question for the PR author. D1 is consulted only for who has
 * connected what; the pool itself is code.
 */
identityApi.get("/roster", async (c) => {
  const member = await requireTeamMember(c);
  if (member instanceof Response) return member;

  const [engineers, slack, github] = await Promise.all([
    listConnectStatus(c.env.DB),
    resolveSpeaker(c.env.DB, "slack"),
    resolveSpeaker(c.env.DB, "github"),
  ]);
  return c.json({
    speaker: slack === null ? null : { email: slack.email },
    githubSpeaker: github === null ? null : { email: github.email },
    pool: [...SPEAKER_POOL],
    engineers,
  });
});
