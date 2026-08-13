/**
 * Cloudflare Access JWT verification.
 *
 * The dashboard sits behind Cloudflare Access (see README.md, "Access and the
 * temporary override"). Access puts a signed `Cf-Access-Jwt-Assertion` header
 * on every request that reaches the origin, but a header being PRESENT is not
 * the same as it being VALID -- anyone can send an arbitrary header value to
 * an origin that forgets to check. This module is the check: JWKS signature,
 * issuer, audience and expiry, all four, every time. There is deliberately no
 * flag that skips any of them -- see `makeAccessVerifier` below.
 *
 * Phase 12 extends this directory with OAuth, token rotation, and more
 * crypto. Kept narrow here on purpose so that extension doesn't have to
 * unpick shortcuts.
 */

/** What a validated token proves. Nothing more -- not role, not session. */
export interface AccessIdentity {
  email: string;
}

export interface AccessVerifier {
  /** Throws `AccessJwtError` on any failure to validate. */
  verify(jwt: string): Promise<AccessIdentity>;
}

/**
 * The closed set of ways a token can fail to validate. Closed on purpose,
 * same reasoning as `CapabilityErrorCode` in codemode/errors.ts: callers (and
 * tests) branch on `code`, so an unlisted failure mode is a silent contract
 * change.
 */
export type AccessJwtErrorCode =
  | "missing"
  | "malformed"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "expired";

/**
 * `message` says why by CODE only -- never the token, a claim value, or any
 * JWKS material. A caller that logs `err.message` on a verification failure
 * must not be able to leak a bearer credential by doing so (constraint: no
 * secret, JWT, or JWKS material in logs, errors, or thrown messages).
 */
export class AccessJwtError extends Error {
  readonly code: AccessJwtErrorCode;

  constructor(code: AccessJwtErrorCode, reason: string) {
    super(`${code}: ${reason}`);
    this.name = "AccessJwtError";
    this.code = code;
  }
}

export interface AccessVerifierConfig {
  /** e.g. "zellify-firefighter.cloudflareaccess.com" -- no scheme, no path. */
  teamDomain: string;
  /** The Access application's AUD tag. */
  aud: string;
}

type Jwk = JsonWebKey & { kid?: string };

type JwksCache = {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
};

/** Cache floor. Below this age, a key-miss is the only thing that refetches. */
const JWKS_CACHE_FLOOR_MS = 60 * 60 * 1000;

/**
 * How long a `kid` that survived a refetch and was still not found stays
 * negatively cached before this verifier is willing to try the network for
 * it again.
 *
 * Short and deliberately so: a real Access key rotation publishes a new
 * `kid`, and if this verifier caches "unknown" for that `kid` for anywhere
 * near as long as `JWKS_CACHE_FLOOR_MS`, every valid token signed with the
 * newly-rotated key is rejected for that whole window -- a self-inflicted
 * outage disguised as a security control. Sixty seconds bounds the
 * amplification (see `resolveKey`'s doc comment) to one real JWKS fetch per
 * unknown `kid` per minute, while keeping rotation's blind spot small enough
 * that nobody would notice it operationally.
 */
const UNKNOWN_KID_NEGATIVE_TTL_MS = 60 * 1000;

/**
 * The hard ceiling on `unknownKids`'s size, in EVERY isolate, for the whole
 * isolate's lifetime -- not just within one TTL window.
 *
 * The TTL alone does not bound memory: an entry is only ever removed when
 * that SAME `kid` is looked up again after expiring (`resolveKey`'s
 * TTL-elapsed branch), which never happens for the amplification attack
 * shape this cache exists to throttle -- a caller cycling through DISTINCT,
 * never-repeated `kid`s. Every such `kid` adds one permanent entry, so
 * without a cap the map grows without limit for as long as the isolate
 * lives. `MAX_UNKNOWN_KIDS` is the fix: `rememberUnknownKid` evicts the
 * OLDEST entry (a `Map` preserves insertion order, so this is a plain FIFO,
 * no LRU bookkeeping needed) before inserting past this size, so
 * `unknownKids.size` never exceeds it. Worst case, this isolate's negative
 * cache costs at most `MAX_UNKNOWN_KIDS` string keys plus a number each --
 * a few tens of KB even at this size, not a resource-exhaustion vector.
 *
 * Evicting the oldest entry is safe for the property this cache protects: if
 * an attacker is cycling through more than `MAX_UNKNOWN_KIDS` distinct `kid`s
 * faster than they expire, the evicted `kid` was not going to be looked up
 * again anyway (that IS the attack shape -- never-repeated `kid`s), so
 * losing its entry early costs nothing. The only way eviction could reopen
 * amplification is if the SAME `kid` were hammered repeatedly while more
 * than `MAX_UNKNOWN_KIDS` OTHER distinct `kid`s were also in flight between
 * two of its requests -- a scenario requiring the attacker to sustain a
 * working set larger than this cap simultaneously, at which point the cap
 * has already done its job of bounding memory, and the worst case reverts to
 * (at most) one extra fetch for that one `kid`, not the original unbounded
 * per-request amplification.
 */
const MAX_UNKNOWN_KIDS = 1000;

function base64UrlToBytes(segment: string): Uint8Array {
  const padded = segment + "=".repeat((4 - (segment.length % 4)) % 4);
  const std = padded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(std);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlToText(segment: string): string {
  return new TextDecoder().decode(base64UrlToBytes(segment));
}

/**
 * Builds the verifier. `fetchJwks` is the test seam: it defaults to the
 * global `fetch`, so the ONLY way to get an `AccessVerifier` in production is
 * through the real network call -- there is no dev-bypass parameter, and no
 * env-conditional anywhere in this function that turns off a check. Tests
 * inject a fake fetcher; they never get a verifier that skips verification.
 *
 * `now` is a second, independent test seam -- it defaults to the real clock
 * -- so a test can move time past `UNKNOWN_KID_NEGATIVE_TTL_MS` without a
 * real 60-second sleep, to prove the negative cache actually expires and
 * rotation self-heals. Production never passes it.
 */
export function makeAccessVerifier(
  cfg: AccessVerifierConfig,
  fetchJwks: typeof fetch = fetch,
  now: () => number = () => Date.now(),
): AccessVerifier {
  const jwksUrl = `https://${cfg.teamDomain}/cdn-cgi/access/certs`;

  let cache: JwksCache | null = null;
  // Dedupes concurrent loads within one isolate; unrelated to the 1-hour
  // floor, which governs how OLD a settled cache may be before it counts as
  // due for a routine refresh.
  let inflight: Promise<JwksCache> | null = null;

  /**
   * `kid` -> the timestamp its negative entry expires at. Populated only by
   * `resolveKey` below, on a `kid` that survived a full refetch and was
   * still missing. See `UNKNOWN_KID_NEGATIVE_TTL_MS`'s doc comment for why
   * the TTL is short.
   */
  const unknownKids = new Map<string, number>();

  /**
   * Inserts (or refreshes) `kid`'s negative entry, evicting the oldest entry
   * first if the map is already at `MAX_UNKNOWN_KIDS` -- see that constant's
   * doc comment for the full bound and why FIFO eviction is safe here.
   */
  function rememberUnknownKid(kid: string, nowMs: number): void {
    if (unknownKids.size >= MAX_UNKNOWN_KIDS) {
      const oldest = unknownKids.keys().next().value;
      if (oldest !== undefined) unknownKids.delete(oldest);
    }
    unknownKids.set(kid, nowMs + UNKNOWN_KID_NEGATIVE_TTL_MS);
  }

  async function loadJwks(): Promise<JwksCache> {
    if (inflight) return inflight;
    inflight = (async () => {
      let response: Response;
      try {
        response = await fetchJwks(jwksUrl);
      } catch {
        throw new AccessJwtError("bad_signature", "could not reach the Access JWKS endpoint");
      }
      if (!response.ok) {
        throw new AccessJwtError("bad_signature", "the Access JWKS endpoint returned an error");
      }
      let body: { keys?: Jwk[] };
      try {
        body = (await response.json()) as { keys?: Jwk[] };
      } catch {
        throw new AccessJwtError("bad_signature", "the Access JWKS endpoint returned something unreadable");
      }
      const keys = new Map<string, CryptoKey>();
      for (const jwk of body.keys ?? []) {
        if (!jwk.kid) continue;
        // ONE UNIMPORTABLE KEY MUST NOT TAKE THE DOCUMENT DOWN WITH IT.
        //
        // `importKey` rejects with a raw `DOMException`/`TypeError` for a JWK
        // that is malformed, or simply of an algorithm this verifier does not
        // do (Access has served EC keys alongside RSA ones before now). Left
        // unwrapped, that escaped `verify` as a non-`AccessJwtError` and broke
        // the closed error contract every caller branches on — the route in
        // `api/approvals.ts` maps an `AccessJwtError` to `401` by CODE, and
        // anything else becomes a 500. Skipping the key instead keeps the
        // GOOD keys in the document usable, and a token that actually needs
        // the skipped one still fails closed: its `kid` is simply absent, so
        // `resolveKey` refetches once and then throws `bad_signature`.
        let key: CryptoKey;
        try {
          key = await crypto.subtle.importKey(
            "jwk",
            jwk,
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
          );
        } catch {
          // No key material, no `kid`, no exception text in the log line: a
          // JWKS document is public, but this module's rule is that nothing
          // about it reaches a log or an error (invariant 12).
          continue;
        }
        keys.set(jwk.kid, key);
      }
      const next: JwksCache = { keys, fetchedAt: now() };
      cache = next;
      return next;
    })();
    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  }

  /**
   * Resolves the verification key for `kid`. A key-miss triggers exactly one
   * refetch -- Access rotates keys, so a `kid` this isolate has never seen is
   * expected, not an attack. A miss that survives the refetch is real: it
   * does NOT retry again FOR THIS CALL, so a single request hammering an
   * unknown `kid` cannot turn into an unbounded refetch loop within itself.
   *
   * That guarantee was per-call, not global: a stream of DIFFERENT unknown
   * `kid`s, one per request, each got its own full refetch, because nothing
   * remembered a `kid` had already been tried and failed. A caller reaching
   * this route without going through Cloudflare Access first (see
   * `phase-11-notes.md`'s "Task 6" entry) could use that to force one real
   * JWKS fetch per request, before the signature is even checked -- and a
   * throttled JWKS endpoint breaks authentication for everyone, not just the
   * attacker. `unknownKids` is the fix: once a `kid` has survived a full
   * refetch and is still missing, it is remembered as unknown for
   * `UNKNOWN_KID_NEGATIVE_TTL_MS`, and every further request for that same
   * `kid` fails immediately with no network call, until the entry expires.
   *
   * The TTL is short -- see its own doc comment -- specifically so a `kid`
   * that becomes real (Access rotates it in) is only ever blind for at most
   * one TTL window, not held negative forever by a cache with no natural
   * expiry.
   */
  async function resolveKey(kid: string): Promise<CryptoKey> {
    const nowMs = now();
    const negativeUntil = unknownKids.get(kid);
    if (negativeUntil !== undefined) {
      if (nowMs < negativeUntil) {
        throw new AccessJwtError("bad_signature", "no JWKS key matches the token's kid");
      }
      // TTL elapsed -- give this kid a genuine fresh look, exactly like a
      // `kid` this isolate has never seen before.
      unknownKids.delete(kid);
    }

    const isFresh = cache !== null && nowMs - cache.fetchedAt < JWKS_CACHE_FLOOR_MS;
    let { keys } = isFresh ? cache! : await loadJwks();
    let key = keys.get(kid);
    if (!key) {
      ({ keys } = await loadJwks());
      key = keys.get(kid);
    }
    if (!key) {
      rememberUnknownKid(kid, nowMs);
      throw new AccessJwtError("bad_signature", "no JWKS key matches the token's kid");
    }
    return key;
  }

  return {
    async verify(jwt: string): Promise<AccessIdentity> {
      if (!jwt) {
        throw new AccessJwtError("missing", "no token was supplied");
      }

      const parts = jwt.split(".");
      if (parts.length !== 3) {
        throw new AccessJwtError("malformed", "token is not a three-segment JWS");
      }
      const [headerSeg, payloadSeg, sigSeg] = parts;

      let header: { alg?: string; kid?: string };
      let payload: { iss?: string; aud?: string | string[]; exp?: number; email?: string };
      try {
        header = JSON.parse(base64UrlToText(headerSeg)) as typeof header;
        payload = JSON.parse(base64UrlToText(payloadSeg)) as typeof payload;
      } catch {
        throw new AccessJwtError("malformed", "token header or payload is not valid JSON");
      }
      if (header.alg !== "RS256" || !header.kid) {
        throw new AccessJwtError("malformed", "token header is missing alg or kid");
      }

      let signature: Uint8Array;
      try {
        signature = base64UrlToBytes(sigSeg);
      } catch {
        throw new AccessJwtError("malformed", "token signature segment is not valid base64url");
      }

      // Signature first, always -- nothing below this line is trusted until
      // the JOSE signing input is proven to come from a key the configured
      // Access team actually publishes.
      const key = await resolveKey(header.kid);
      const signingInput = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
      let valid: boolean;
      try {
        valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signingInput);
      } catch {
        throw new AccessJwtError("bad_signature", "signature verification failed");
      }
      if (!valid) {
        throw new AccessJwtError("bad_signature", "token signature does not match");
      }

      if (payload.iss !== `https://${cfg.teamDomain}`) {
        throw new AccessJwtError("wrong_issuer", "token issuer does not match the configured team domain");
      }

      const auds = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
      if (!auds.includes(cfg.aud)) {
        throw new AccessJwtError("wrong_audience", "token audience does not match the configured application");
      }

      if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) {
        throw new AccessJwtError("expired", "token has expired");
      }

      if (typeof payload.email !== "string" || payload.email.length === 0) {
        throw new AccessJwtError("malformed", "token has no email claim");
      }

      return { email: payload.email };
    },
  };
}
