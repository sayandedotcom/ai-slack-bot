import { describe, expect, it } from "vitest";
import { AccessJwtError, makeAccessVerifier } from "../src/access/jwt";
import { FIREFIGHTERS, VIEWERS, isFirefighter, isTeamMember } from "../src/access/roster";

const TEAM_DOMAIN = "zellify-firefighter.cloudflareaccess.com";
const AUD = "test-aud";
const ISS = `https://${TEAM_DOMAIN}`;

// Real crypto throughout: keys are minted with WebCrypto, JWTs are signed
// in-test, and verification runs the actual RS256 path. Nothing here mocks
// `crypto.subtle` -- only the network fetch of the JWKS document is faked,
// via the `fetchJwks` seam `makeAccessVerifier` exposes for exactly this.

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function generateKeyPair(kid: string) {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, publicJwk: { ...publicJwk, kid, alg: "RS256", use: "sig" } };
}

async function sign(privateKey: CryptoKey, kid: string, payload: Record<string, unknown>): Promise<string> {
  const headerSeg = base64urlJson({ alg: "RS256", kid, typ: "JWT" });
  const payloadSeg = base64urlJson(payload);
  const signingInput = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, signingInput);
  return `${headerSeg}.${payloadSeg}.${base64url(new Uint8Array(sig))}`;
}

function validClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: ISS,
    aud: AUD,
    email: "ronit@zellify.app",
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000) - 60,
    ...overrides,
  };
}

/** A fake `fetchJwks` that serves a fixed JWKS body and counts calls. */
function fakeJwksFetcher(...jwks: JsonWebKey[]) {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return new Response(JSON.stringify({ keys: jwks }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, calls: () => calls };
}

describe("makeAccessVerifier", () => {
  it("returns the email from a validly signed token", async () => {
    const key = await generateKeyPair("kid-1");
    const { fetcher } = fakeJwksFetcher(key.publicJwk);
    const verifier = makeAccessVerifier({ teamDomain: TEAM_DOMAIN, aud: AUD }, fetcher);
    const token = await sign(key.privateKey, key.kid, validClaims());

    await expect(verifier.verify(token)).resolves.toEqual({ email: "ronit@zellify.app" });
  });

  it("rejects a token with the wrong audience", async () => {
    const key = await generateKeyPair("kid-1");
    const { fetcher } = fakeJwksFetcher(key.publicJwk);
    const verifier = makeAccessVerifier({ teamDomain: TEAM_DOMAIN, aud: AUD }, fetcher);
    const token = await sign(key.privateKey, key.kid, validClaims({ aud: "someone-elses-app" }));

    const err = await verifier.verify(token).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccessJwtError);
    expect((err as AccessJwtError).code).toBe("wrong_audience");
  });

  it("rejects a token with the wrong issuer", async () => {
    const key = await generateKeyPair("kid-1");
    const { fetcher } = fakeJwksFetcher(key.publicJwk);
    const verifier = makeAccessVerifier({ teamDomain: TEAM_DOMAIN, aud: AUD }, fetcher);
    const token = await sign(key.privateKey, key.kid, validClaims({ iss: "https://someone-else.cloudflareaccess.com" }));

    const err = await verifier.verify(token).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccessJwtError);
    expect((err as AccessJwtError).code).toBe("wrong_issuer");
  });

  it("rejects an expired token", async () => {
    const key = await generateKeyPair("kid-1");
    const { fetcher } = fakeJwksFetcher(key.publicJwk);
    const verifier = makeAccessVerifier({ teamDomain: TEAM_DOMAIN, aud: AUD }, fetcher);
    const token = await sign(key.privateKey, key.kid, validClaims({ exp: Math.floor(Date.now() / 1000) - 60 }));

    const err = await verifier.verify(token).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccessJwtError);
    expect((err as AccessJwtError).code).toBe("expired");
  });

  it("rejects garbage input", async () => {
    const { fetcher } = fakeJwksFetcher();
    const verifier = makeAccessVerifier({ teamDomain: TEAM_DOMAIN, aud: AUD }, fetcher);

    const err = await verifier.verify("not-a-jwt-at-all").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccessJwtError);
    expect((err as AccessJwtError).code).toBe("malformed");
  });

  it("rejects an empty token as missing", async () => {
    const { fetcher } = fakeJwksFetcher();
    const verifier = makeAccessVerifier({ teamDomain: TEAM_DOMAIN, aud: AUD }, fetcher);

    const err = await verifier.verify("").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccessJwtError);
    expect((err as AccessJwtError).code).toBe("missing");
  });

  it("rejects a token signed by a different key than the one its kid names", async () => {
    const published = await generateKeyPair("kid-1");
    const attacker = await generateKeyPair("kid-1"); // same kid, different keypair
    const { fetcher } = fakeJwksFetcher(published.publicJwk);
    const verifier = makeAccessVerifier({ teamDomain: TEAM_DOMAIN, aud: AUD }, fetcher);
    // Signed with the attacker's private key, but the header claims the
    // published kid -- verification must use the JWKS key for that kid, not
    // trust whatever key actually produced the signature.
    const token = await sign(attacker.privateKey, published.kid, validClaims());

    const err = await verifier.verify(token).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccessJwtError);
    expect((err as AccessJwtError).code).toBe("bad_signature");
  });

  it("fetches the JWKS once and reuses it across two verifications", async () => {
    const key = await generateKeyPair("kid-1");
    const { fetcher, calls } = fakeJwksFetcher(key.publicJwk);
    const verifier = makeAccessVerifier({ teamDomain: TEAM_DOMAIN, aud: AUD }, fetcher);
    const token = await sign(key.privateKey, key.kid, validClaims());

    await verifier.verify(token);
    await verifier.verify(token);

    expect(calls()).toBe(1);
  });

  it("refetches exactly once when a token's kid is not in the cached JWKS", async () => {
    const keyA = await generateKeyPair("kid-a");
    const keyB = await generateKeyPair("kid-b");
    let served = [keyA.publicJwk];
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return new Response(JSON.stringify({ keys: served }), { status: 200 });
    }) as unknown as typeof fetch;
    const verifier = makeAccessVerifier({ teamDomain: TEAM_DOMAIN, aud: AUD }, fetcher);

    const tokenA = await sign(keyA.privateKey, keyA.kid, validClaims());
    await verifier.verify(tokenA);
    expect(calls).toBe(1);

    // Simulate Access rotating in a new key server-side.
    served = [keyA.publicJwk, keyB.publicJwk];
    const tokenB = await sign(keyB.privateKey, keyB.kid, validClaims());
    await expect(verifier.verify(tokenB)).resolves.toEqual({ email: "ronit@zellify.app" });
    expect(calls).toBe(2);

    // A second unknown kid, still not in the JWKS, must fail closed rather
    // than loop: exactly one more refetch, then bad_signature.
    const err = await verifier.verify(await sign(keyA.privateKey, "kid-never-published", validClaims())).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AccessJwtError);
    expect((err as AccessJwtError).code).toBe("bad_signature");
    expect(calls).toBe(3);
  });
});

describe("roster", () => {
  it("treats the four confirmed fire-fighters and the documented override as fire-fighters", () => {
    for (const email of ["ronit@zellify.app", "luka@zellify.app", "mikheil@zellify.app", "zurab@zellify.app", "sayandeten@gmail.com"]) {
      expect(isFirefighter(email)).toBe(true);
    }
  });

  it("does not treat viewers as fire-fighters", () => {
    for (const email of VIEWERS) {
      expect(isFirefighter(email)).toBe(false);
    }
  });

  it("treats all seven roster emails plus the override as team members", () => {
    for (const email of [...FIREFIGHTERS, ...VIEWERS]) {
      expect(isTeamMember(email)).toBe(true);
    }
  });

  it("does not treat an arbitrary email as a team member", () => {
    expect(isTeamMember("nobody@example.com")).toBe(false);
  });
});
