import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AccessIdentity,
  AccessJwtError,
  type AccessVerifier,
} from "../src/access/jwt";
import { FIREFIGHTERS } from "../src/access/roster";
import {
  identityApi,
  installIdentityApiPorts,
  resetIdentityApiPorts,
} from "../src/api/identity";
import { type ConnectStatus, upsertIdentity } from "../src/db/identities";
import { importIdentityKey, SealError, seal } from "../src/identity/crypto";
import { SPEAKER_POOL } from "../src/identity/speaker";
import { getDecryptedToken } from "../src/identity/tokens";
import type { Env } from "../src/index";

/**
 * The router is driven DIRECTLY (`identityApi.request(...)`) rather than
 * through `src/index.ts`: mounting it under `/api` is a later task's job, so
 * the paths here are the router's own (`/identity`, `/roster`).
 *
 * `DB` is the real pool D1 — the env passed to each request is `cloudflare:test`'s
 * spread plus a genuine 32-byte `IDENTITY_KEY`, so the crypto in these cases is
 * real. What is faked is only the Access verifier, injected through the port
 * seam; real JWT/JWKS verification is `test/access-jwt.test.ts`'s subject.
 */

function randomKeyB64(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const IDENTITY_KEY = randomKeyB64();

/** The env every request and every `getDecryptedToken` call in this file sees. */
const testEnv = { ...env, IDENTITY_KEY } as unknown as Env;

/**
 * Leave the shared D1 as we found it — in an `afterEach`, not only a
 * `beforeEach`.
 *
 * This pool has no `isolatedStorage`, so an `identities` row seeded here
 * outlives the file, and a row for the on-duty engineer is one of the two
 * things `sweepNudges` feeds on (see `test/notify-nudge.test.ts`'s note). Left
 * behind, it is one stale pending approval in some other suite away from
 * `worker.scheduled()` opening a REAL DM against slack.com with the pool's fake
 * bot token. Cleaning up on the way out is what keeps that unreachable.
 */
async function cleanIdentities(): Promise<void> {
  await env.DB.prepare("DELETE FROM identities").run();
}

beforeEach(async () => {
  await cleanIdentities();
  resetIdentityApiPorts();
});
afterEach(cleanIdentities);

/**
 * A verifier that treats the raw header value AS the identity: no signing, no
 * JWKS, no network. `""` fails as `missing` and a non-email-shaped value as
 * `malformed`, which covers both halves of `401 access_jwt_invalid`.
 */
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

const FIREFIGHTER = "ronit@zellify.app";
const VIEWER = "marcus@zellify.app";
const OUTSIDER = "nobody@example.com";

async function req(path: string, token?: string): Promise<Response> {
  const headers = new Headers();
  if (token !== undefined) headers.set("Cf-Access-Jwt-Assertion", token);
  return await identityApi.request(path, { headers }, testEnv);
}

/* ---------------------------------------------------------- GET /identity */

describe("GET /identity", () => {
  it("401s with no token", async () => {
    installIdentityApiPorts({ verifier: fakeVerifier() });
    const res = await req("/identity");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe(
      "access_jwt_invalid"
    );
  });

  it("401s a garbage token", async () => {
    installIdentityApiPorts({ verifier: fakeVerifier() });
    const res = await req("/identity", "garbage");
    expect(res.status).toBe(401);
  });

  it("403s an email the roster does not know, despite a valid token", async () => {
    installIdentityApiPorts({ verifier: fakeVerifier() });
    const res = await req("/identity", OUTSIDER);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      "not_a_firefighter"
    );
  });

  it("returns role viewer for a viewer", async () => {
    installIdentityApiPorts({ verifier: fakeVerifier() });
    const res = await req("/identity", VIEWER);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: VIEWER, role: "viewer" });
  });

  it("returns role firefighter for a fire-fighter", async () => {
    installIdentityApiPorts({ verifier: fakeVerifier() });
    const res = await req("/identity", FIREFIGHTER);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      email: FIREFIGHTER,
      role: "firefighter",
    });
  });
});

/* ------------------------------------------------------------ GET /roster */

describe("GET /roster", () => {
  it("401s with no token and 403s an outsider", async () => {
    installIdentityApiPorts({ verifier: fakeVerifier() });
    expect((await req("/roster")).status).toBe(401);
    expect((await req("/roster", OUTSIDER)).status).toBe(403);
  });

  it("returns the speaker, the pool and every roster member's connect state", async () => {
    installIdentityApiPorts({ verifier: fakeVerifier() });
    const key = await importIdentityKey(IDENTITY_KEY);
    await upsertIdentity(
      env.DB,
      {
        email: FIREFIGHTER,
        provider: "slack",
        externalId: "U123",
        scopes: "chat:write",
        tokenCiphertext: await seal(key, "xoxp-super-secret"),
        connectedAt: Date.now(),
      },
      Date.now()
    );

    const res = await req("/roster", VIEWER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      speaker: { email: string } | null;
      githubSpeaker: { email: string } | null;
      pool: string[];
      engineers: ConnectStatus[];
    };

    // No shift, no clock: the pool is the roster and the speaker is whoever has
    // connected — here the one seeded row. GitHub has nobody.
    expect(body.pool).toEqual([...SPEAKER_POOL]);
    expect(body.pool).toEqual([...FIREFIGHTERS]);
    expect(body.speaker).toEqual({ email: FIREFIGHTER });
    expect(body.githubSpeaker).toBeNull();
    // Nothing shift-shaped survives on the wire.
    expect(body).not.toHaveProperty("onDuty");
    expect(body).not.toHaveProperty("rotation");

    expect(body.engineers).toContainEqual({
      email: FIREFIGHTER,
      role: "firefighter",
      slack: true,
      github: false,
    });
    expect(body.engineers).toContainEqual({
      email: VIEWER,
      role: "viewer",
      slack: false,
      github: false,
    });
  });

  it("carries no token or ciphertext anywhere in the body", async () => {
    installIdentityApiPorts({ verifier: fakeVerifier() });
    const key = await importIdentityKey(IDENTITY_KEY);
    const sealed = await seal(key, "xoxp-super-secret");
    await upsertIdentity(
      env.DB,
      {
        email: FIREFIGHTER,
        provider: "slack",
        externalId: "U123",
        scopes: "chat:write",
        tokenCiphertext: sealed,
        connectedAt: Date.now(),
      },
      Date.now()
    );

    const res = await req("/roster", FIREFIGHTER);
    const serialized = JSON.stringify(await res.json());
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("ciphertext");
    expect(serialized).not.toContain(sealed);
    expect(serialized).not.toContain("xoxp-super-secret");
  });
});

/* -------------------------------------------------------- getDecryptedToken */

describe("getDecryptedToken", () => {
  it("is null when the person has not connected that provider", async () => {
    expect(await getDecryptedToken(testEnv, FIREFIGHTER, "slack")).toBeNull();
  });

  it("round-trips a token sealed by the crypto module", async () => {
    const key = await importIdentityKey(IDENTITY_KEY);
    await upsertIdentity(
      env.DB,
      {
        email: FIREFIGHTER,
        provider: "github",
        externalId: "gh-1",
        scopes: "repo",
        tokenCiphertext: await seal(key, "ghu_live_token"),
        connectedAt: Date.now(),
      },
      Date.now()
    );

    expect(await getDecryptedToken(testEnv, FIREFIGHTER, "github")).toBe(
      "ghu_live_token"
    );
    // Provider-scoped: the same person's unconnected provider is still null.
    expect(await getDecryptedToken(testEnv, FIREFIGHTER, "slack")).toBeNull();
  });

  it("REJECTS with SealError on a corrupted ciphertext — loud, never null", async () => {
    await upsertIdentity(
      env.DB,
      {
        email: FIREFIGHTER,
        provider: "slack",
        externalId: "U123",
        scopes: "chat:write",
        tokenCiphertext: "not-a-sealed-value",
        connectedAt: Date.now(),
      },
      Date.now()
    );

    await expect(
      getDecryptedToken(testEnv, FIREFIGHTER, "slack")
    ).rejects.toThrow(SealError);
  });

  it("names the VARIABLE, not a value, when IDENTITY_KEY is missing", async () => {
    const key = await importIdentityKey(IDENTITY_KEY);
    await upsertIdentity(
      env.DB,
      {
        email: FIREFIGHTER,
        provider: "slack",
        externalId: "U123",
        scopes: "chat:write",
        tokenCiphertext: await seal(key, "xoxp-super-secret"),
        connectedAt: Date.now(),
      },
      Date.now()
    );

    const keyless = { ...env, IDENTITY_KEY: undefined } as unknown as Env;
    await expect(
      getDecryptedToken(keyless, FIREFIGHTER, "slack")
    ).rejects.toThrow(/missing configuration: IDENTITY_KEY/);
  });
});
