import type { Provider } from "../db/identities";

/**
 * The `state` parameter that carries WHO is connecting across an OAuth round
 * trip.
 *
 * The provider hands the callback back a `code` and whatever `state` it was
 * given, over a plain browser redirect. Nothing in that redirect is
 * trustworthy: the callback runs with no Access JWT of its own (the user is
 * arriving from slack.com, not from the dashboard), so if `state` were a bare
 * email anybody could complete a connect AS anybody -- park their own Slack
 * token under a fire-fighter's row and act as them forever.
 *
 * So `state` is a signed, expiring bearer of exactly one fact: the VERIFIED
 * Access email that started the flow. The start route mints it only after
 * checking the JWT and the roster; the callback trusts it and nothing else.
 * HMAC-SHA256 over the payload makes it unforgeable, a 10-minute TTL keeps a
 * leaked one from being useful, and binding the provider into the payload
 * stops a state minted for one provider being replayed at another's callback.
 *
 * As in `access/jwt.ts` and `identity/crypto.ts`, failures are silent by
 * design: `verifyState` returns `null` rather than throwing or explaining. A
 * caller cannot leak how close a guess got, and there is nothing useful to do
 * with the distinction between "tampered" and "expired" anyway -- both mean
 * start over.
 */

/** Ten minutes. Long enough for a human to click through a consent screen. */
const STATE_TTL_MS = 10 * 60 * 1000;

/** Replay padding, so two states minted in the same millisecond still differ. */
const NONCE_BYTES = 16;

type StatePayload = {
  /** The verified Access email. */
  e: string;
  /** The provider this state is valid at, and only this one. */
  p: Provider;
  /** Absolute expiry, epoch ms. */
  x: number;
  /** Nonce. */
  n: string;
};

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  return fromBase64(padded.replace(/-/g, "+").replace(/_/g, "/"));
}

/**
 * Imports the SAME `IDENTITY_KEY` base64 secret that seals tokens, as a
 * signing key.
 *
 * One secret, two uses -- but never the same `CryptoKey`: this one is imported
 * with `{name:"HMAC"}` and the usages `sign`/`verify`, so WebCrypto itself
 * refuses to let a state key encrypt a token or a token key sign a state. Like
 * `importIdentityKey`, it is non-extractable, so nothing downstream can log or
 * serialise the raw bytes.
 */
export async function importStateKey(base64Secret: string): Promise<CryptoKey> {
  const bytes = fromBase64(base64Secret);
  return crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/** `payload.signature`, both base64url. */
export async function mintState(
  key: CryptoKey,
  email: string,
  provider: Provider,
  nowMs: number
): Promise<string> {
  const payload: StatePayload = {
    e: email,
    p: provider,
    x: nowMs + STATE_TTL_MS,
    n: toBase64(crypto.getRandomValues(new Uint8Array(NONCE_BYTES))),
  };
  const encoded = toBase64Url(
    new TextEncoder().encode(JSON.stringify(payload))
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(encoded)
  );
  return `${encoded}.${toBase64Url(new Uint8Array(sig))}`;
}

/**
 * Returns the email a valid, unexpired, provider-matching state carries, or
 * `null`.
 *
 * Never throws -- garbage in from a query string is the NORMAL case here, not
 * an exceptional one, and a route that had to wrap this in try/catch would
 * eventually forget to.
 *
 * Order matters: `subtle.verify` runs before the payload is even parsed as
 * JSON, so nothing an unsigned payload claims -- an expiry in the year 3000, a
 * provider, an email -- is ever read by this process.
 */
export async function verifyState(
  key: CryptoKey,
  state: string,
  provider: Provider,
  nowMs: number
): Promise<{ email: string } | null> {
  try {
    const parts = state.split(".");
    if (parts.length !== 2) return null;
    const [encoded, sigSegment] = parts;

    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(sigSegment),
      new TextEncoder().encode(encoded)
    );
    if (!valid) return null;

    const payload = JSON.parse(
      new TextDecoder().decode(fromBase64Url(encoded))
    ) as StatePayload;
    if (typeof payload.e !== "string" || payload.e.length === 0) return null;
    if (payload.p !== provider) return null;
    if (typeof payload.x !== "number" || nowMs >= payload.x) return null;

    return { email: payload.e };
  } catch {
    return null;
  }
}
