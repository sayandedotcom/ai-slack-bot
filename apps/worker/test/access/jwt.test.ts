import { describe, expect, it } from "vitest";
import { AccessJwtError, makeAccessVerifier } from "../../src/access/jwt";
import {
  FIREFIGHTERS,
  isFirefighter,
  isTeamMember,
  VIEWERS,
} from "../../src/access/roster";

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
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function generateKeyPair(kid: string) {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey
  )) as JsonWebKey;
  return {
    kid,
    privateKey: pair.privateKey,
    publicJwk: { ...publicJwk, kid, alg: "RS256", use: "sig" },
  };
}

async function sign(
  privateKey: CryptoKey,
  kid: string,
  payload: Record<string, unknown>
): Promise<string> {
  const headerSeg = base64urlJson({ alg: "RS256", kid, typ: "JWT" });
  const payloadSeg = base64urlJson(payload);
  const signingInput = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    signingInput
  );
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
    const verifier = makeAccessVerifier(
      { teamDomain: TEAM_DOMAIN, aud: AUD },
      fetcher
    );
    const token = await sign(key.privateKey, key.kid, validClaims());

    await expect(verifier.verify(token)).resolves.toEqual({
      email: "ronit@zellify.app",
    });
  });

  it("rejects a token with the wrong audience", async () => {
    const key = await generateKeyPair("kid-1");
    const { fetcher } = fakeJwksFetcher(key.publicJwk);
    const verifier = makeAccessVerifier(
      { teamDomain: TEAM_DOMAIN, aud: AUD },
      fetcher
    );
    const token = await sign(
      key.privateKey,
      key.kid,
      validClaims({ aud: "someone-elses-app" })
    );

    const err = await verifier.verify(token).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccessJwtError);
    expect((err as AccessJwtError).code).toBe("wrong_audience");
  });

  it("rejects a token with the wrong issuer", async () => {
    const key = await generateKeyPair("kid-1");
    const { fetcher } = fakeJwksFetcher(key.publicJwk);
    const verifier = makeAccessVerifier(
      { teamDomain: TEAM_DOMAIN, aud: AUD },
      fetcher
    );
    const token = await sign(
      key.privateKey,
      key.kid,
      validClaims({ iss: "https://someone-else.cloudflareaccess.com" })
    );

    const err = await verifier.verify(token).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccessJwtError);
    expect((err as AccessJwtError).code).toBe("wrong_issuer");
  });

  it("rejects an expired token", async () => {
    const key = await generateKeyPair("kid-1");
    const { fetcher } = fakeJwksFetcher(key.publicJwk);
    const verifier = makeAccessVerifier(
      { teamDomain: TEAM_DOMAIN, aud: AUD },
      fetcher
    );
    const token = await sign(
      key.privateKey,
      key.kid,
      validClaims({ exp: Math.floor(Date.now() / 1000) - 60 })
    );

    const err = await verifier.verify(token).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccessJwtError);
    expect((err as AccessJwtError).code).toBe("expired");
  });

  it("rejects garbage input", async () => {
    const { fetcher } = fakeJwksFetcher();
    const verifier = makeAccessVerifier(
      { teamDomain: TEAM_DOMAIN, aud: AUD },
      fetcher
    );

    const err = await verifier
      .verify("not-a-jwt-at-all")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccessJwtError);
    expect((err as AccessJwtError).code).toBe("malformed");
  });

  it("rejects an empty token as missing", async () => {
    const { fetcher } = fakeJwksFetcher();
    const verifier = makeAccessVerifier(
      { teamDomain: TEAM_DOMAIN, aud: AUD },
      fetcher
    );

    const err = await verifier.verify("").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccessJwtError);
    expect((err as AccessJwtError).code).toBe("missing");
  });

  it("rejects a token signed by a different key than the one its kid names", async () => {
    const published = await generateKeyPair("kid-1");
    const attacker = await generateKeyPair("kid-1"); // same kid, different keypair
    const { fetcher } = fakeJwksFetcher(published.publicJwk);
    const verifier = makeAccessVerifier(
      { teamDomain: TEAM_DOMAIN, aud: AUD },
      fetcher
    );
    // Signed with the attacker's private key, but the header claims the
    // published kid -- verification must use the JWKS key for that kid, not
    // trust whatever key actually produced the signature.
    const token = await sign(attacker.privateKey, published.kid, validClaims());

    const err = await verifier.verify(token).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccessJwtError);
    expect((err as AccessJwtError).code).toBe("bad_signature");
  });

  it("skips an unimportable JWK without breaking the error contract", async () => {
    // A JWKS document with one key this verifier cannot import — a malformed
    // RSA key, or (as Access has served in the past) a key of a different
    // algorithm entirely — beside one good key.
    //
    // Two properties, and the second is the one that makes this worth a case:
    // the GOOD key still works, and a token that needs the BAD one fails as an
    // `AccessJwtError`, not as the raw `DOMException`/`TypeError` `importKey`
    // rejects with. `api/approvals.ts` maps `AccessJwtError` to 401 by code and
    // everything else to a 500, so an unwrapped throw here would turn a bad
    // token into a server error on the route that carries a human's decision.
    const good = await generateKeyPair("kid-good");
    const bad = {
      kty: "RSA",
      kid: "kid-bad",
      alg: "RS256",
      use: "sig",
      n: "!!!not-base64url!!!",
      e: "AQAB",
    };
    const { fetcher } = fakeJwksFetcher(good.publicJwk, bad as JsonWebKey);
    const verifier = makeAccessVerifier(
      { teamDomain: TEAM_DOMAIN, aud: AUD },
      fetcher
    );

    await expect(
      verifier.verify(await sign(good.privateKey, good.kid, validClaims()))
    ).resolves.toEqual({
      email: "ronit@zellify.app",
    });

    const err = await verifier
      .verify(await sign(good.privateKey, "kid-bad", validClaims()))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccessJwtError);
    expect((err as AccessJwtError).code).toBe("bad_signature");
    // And nothing about the JWKS document rode out on the message.
    expect((err as AccessJwtError).message).not.toContain("AQAB");
  });

  it("fetches the JWKS once and reuses it across two verifications", async () => {
    const key = await generateKeyPair("kid-1");
    const { fetcher, calls } = fakeJwksFetcher(key.publicJwk);
    const verifier = makeAccessVerifier(
      { teamDomain: TEAM_DOMAIN, aud: AUD },
      fetcher
    );
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
    const verifier = makeAccessVerifier(
      { teamDomain: TEAM_DOMAIN, aud: AUD },
      fetcher
    );

    const tokenA = await sign(keyA.privateKey, keyA.kid, validClaims());
    await verifier.verify(tokenA);
    expect(calls).toBe(1);

    // Simulate Access rotating in a new key server-side.
    served = [keyA.publicJwk, keyB.publicJwk];
    const tokenB = await sign(keyB.privateKey, keyB.kid, validClaims());
    await expect(verifier.verify(tokenB)).resolves.toEqual({
      email: "ronit@zellify.app",
    });
    expect(calls).toBe(2);

    // A second unknown kid, still not in the JWKS, must fail closed rather
    // than loop: exactly one more refetch, then bad_signature.
    const err = await verifier
      .verify(await sign(keyA.privateKey, "kid-never-published", validClaims()))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccessJwtError);
    expect((err as AccessJwtError).code).toBe("bad_signature");
    expect(calls).toBe(3);
  });

  describe("unknown-kid negative cache (JWKS amplification mitigation)", () => {
    /**
     * The vulnerability this guards against: `resolveKey` runs BEFORE the
     * signature is checked, so a caller does not even need a validly signed
     * token -- only a well-formed one with a `kid` this isolate has never
     * seen -- to force a JWKS fetch. Without the negative cache, a distinct
     * `kid` on every request forces one fetch per request, forever. With it,
     * a repeated unknown `kid` is refused with no network call until its
     * negative entry's TTL elapses.
     */
    it("stops refetching for a repeated unknown kid within the TTL", async () => {
      const key = await generateKeyPair("kid-known");
      const { fetcher, calls } = fakeJwksFetcher(key.publicJwk);
      let clock = 0;
      const verifier = makeAccessVerifier(
        { teamDomain: TEAM_DOMAIN, aud: AUD },
        fetcher,
        () => clock
      );

      const unknownToken = await sign(
        key.privateKey,
        "kid-never-published",
        validClaims()
      );

      // First attempt: a genuine miss with a cold cache costs TWO fetches —
      // the unconditional load a cold cache always takes, then the one more
      // `resolveKey` always tries on any miss — exactly the existing
      // "refetches exactly once [more]" behavior this file already pins
      // elsewhere. The negative cache changes nothing about THIS call; it
      // only prevents a SECOND miss on the same kid from repeating either.
      const first = await verifier
        .verify(unknownToken)
        .catch((e: unknown) => e);
      expect((first as AccessJwtError).code).toBe("bad_signature");
      expect(calls()).toBe(2);

      // Ten more attempts for the SAME kid, well within the 60s TTL: none
      // of them may touch the network again.
      clock += 1_000;
      for (let i = 0; i < 10; i++) {
        const err = await verifier
          .verify(unknownToken)
          .catch((e: unknown) => e);
        expect((err as AccessJwtError).code).toBe("bad_signature");
      }
      expect(calls()).toBe(2);
    });

    /**
     * The rotation trap named explicitly in review: a negative cache with no
     * expiry would turn a real Access key rotation into an outage, rejecting
     * every valid token signed with the newly-published key for as long as
     * the negative entry lived. This proves the TTL actually elapses and a
     * `kid` that becomes real afterward verifies successfully.
     */
    it("re-checks a kid after its negative entry's TTL elapses, so rotation self-heals", async () => {
      const rotated = await generateKeyPair("kid-rotated-in");
      let served: JsonWebKey[] = []; // not yet published, at first
      let calls = 0;
      const fetcher = (async () => {
        calls++;
        return new Response(JSON.stringify({ keys: served }), { status: 200 });
      }) as unknown as typeof fetch;
      let clock = 0;
      const verifier = makeAccessVerifier(
        { teamDomain: TEAM_DOMAIN, aud: AUD },
        fetcher,
        () => clock
      );

      const token = await sign(rotated.privateKey, rotated.kid, validClaims());

      // Miss: the key has not been published yet. A cold cache costs two
      // fetches on a miss (same "refetches exactly once [more]" shape pinned
      // above), and this kid is now negatively cached.
      const miss = await verifier.verify(token).catch((e: unknown) => e);
      expect((miss as AccessJwtError).code).toBe("bad_signature");
      expect(calls).toBe(2);

      // Still within the TTL: refused with no network call, even though the
      // key IS published now server-side -- the negative cache has not
      // expired yet, so this isolate has not looked again.
      served = [rotated.publicJwk];
      clock += 30_000;
      const stillCached = await verifier.verify(token).catch((e: unknown) => e);
      expect((stillCached as AccessJwtError).code).toBe("bad_signature");
      expect(calls).toBe(2);

      // Past the 60s TTL: the same kid gets a genuine fresh look. The
      // one-hour freshness floor means the EXISTING (stale, still-empty)
      // cache is used first and misses again, so this takes one more fetch
      // to find the now-published key -- but it DOES find it: rotation has
      // self-healed, which is the property this test exists to prove.
      clock += 31_000;
      await expect(verifier.verify(token)).resolves.toEqual({
        email: "ronit@zellify.app",
      });
      expect(calls).toBe(3);
    });

    /**
     * The bound named explicitly in the second review round: the negative
     * cache's TTL alone does not cap MEMORY, because an entry is only ever
     * removed when that SAME `kid` is looked up again after expiring -- and
     * the actual attack shape (a caller cycling through distinct,
     * never-repeated `kid`s) never repeats a `kid`, so that cleanup branch
     * never runs for it. Without a hard cap, `unknownKids` would grow by one
     * entry per distinct unknown `kid` forever.
     *
     * This proves the cap holds by BEHAVIOR, not by reaching into the
     * verifier's private `unknownKids` map (which is not exposed, and should
     * not be): drive `MAX_UNKNOWN_KIDS + 5` distinct never-published `kid`s
     * through the verifier, then re-query the OLDEST one. If the cache were
     * unbounded, that `kid` would still be negatively cached and refused with
     * no network call. Instead it must trigger a fresh fetch -- proof it was
     * evicted, i.e. proof the map did not grow past its cap. A
     * recently-inserted `kid`, by contrast, must still be served from cache
     * with no extra call, proving eviction is FIFO (oldest-first) rather than
     * indiscriminate.
     *
     * No real RSA signing here (`generateKeyPair`/`sign` are deliberately not
     * used): `resolveKey` throws before the signature is ever checked, so a
     * syntactically-valid header+payload with a throwaway signature segment
     * is enough, and it keeps 1000+ iterations fast.
     */
    it("bounds the negative cache's size, evicting the oldest unknown kid first", async () => {
      // Mirrors `MAX_UNKNOWN_KIDS` in `src/access/jwt.ts`. Not exported —
      // deliberately: a test that imported the real constant could not tell
      // "the cap moved" apart from "the cap doesn't exist," and a value
      // hard-coded here that drifts from the real one still proves the
      // property (eviction happens at SOME bound), just not the exact
      // number. Kept in sync by convention: if this ever fails because the
      // production constant changed, update this literal to match.
      const MAX_UNKNOWN_KIDS = 1000;

      const { fetcher, calls } = fakeJwksFetcher(); // an always-empty JWKS
      const verifier = makeAccessVerifier(
        { teamDomain: TEAM_DOMAIN, aud: AUD },
        fetcher
      );

      function unsignedFakeToken(kid: string): string {
        // Never reaches `crypto.subtle.verify` -- `resolveKey` throws on the
        // unknown `kid` first -- so the signature segment can be throwaway.
        const headerSeg = base64urlJson({ alg: "RS256", kid, typ: "JWT" });
        const payloadSeg = base64urlJson({});
        return `${headerSeg}.${payloadSeg}.c2ln`;
      }

      for (let i = 0; i < MAX_UNKNOWN_KIDS + 5; i++) {
        const err = await verifier
          .verify(unsignedFakeToken(`kid-${i}`))
          .catch((e: unknown) => e);
        expect((err as AccessJwtError).code).toBe("bad_signature");
      }
      const callsAfterFill = calls();

      // The very first kid inserted must have been evicted by now (FIFO,
      // five insertions past the cap): re-querying it costs a fresh fetch.
      await verifier
        .verify(unsignedFakeToken("kid-0"))
        .catch((e: unknown) => e);
      expect(calls()).toBeGreaterThan(callsAfterFill);

      // The most recently inserted kid, still comfortably within the cap,
      // must remain negatively cached: no extra fetch.
      const callsAfterEvictedRecheck = calls();
      await verifier
        .verify(unsignedFakeToken(`kid-${MAX_UNKNOWN_KIDS + 4}`))
        .catch((e: unknown) => e);
      expect(calls()).toBe(callsAfterEvictedRecheck);
    });
  });
});

describe("roster", () => {
  it("treats the four confirmed fire-fighters and the documented override as fire-fighters", () => {
    for (const email of [
      "ronit@zellify.app",
      "luka@zellify.app",
      "mikheil@zellify.app",
      "zurab@zellify.app",
      "sayandeten@gmail.com",
    ]) {
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
