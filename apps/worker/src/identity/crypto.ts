/**
 * Envelope encryption for the per-user tokens Phase 12 stores at rest.
 *
 * A user's OAuth token is a live credential belonging to a HUMAN, not to this
 * service: anyone holding the row holds their Slack or Linear identity. So the
 * database never sees one in the clear -- every token goes in sealed under an
 * AES-GCM key that lives only in the worker's secret store, and a dump of the
 * table is inert without it.
 *
 * GCM rather than plain CBC/CTR because the guarantee we need is not just
 * secrecy but INTEGRITY: a row an attacker can edit is a row they can use to
 * swap one user's token for another's. The auth tag makes any edit -- to the
 * ciphertext or the IV -- fail to open, which is why `open`'s only failure is
 * `tampered`.
 *
 * As in `access/jwt.ts`, thrown messages name the code and a generic reason
 * and NOTHING else. A caller that logs one of these must not be able to leak
 * the token, the ciphertext, or the key by doing so.
 */

/**
 * The closed set of ways sealing can fail. Two, and only two: either the
 * configured secret is unusable as a key, or a sealed value would not open.
 * Callers branch on `code`, so an unlisted mode is a silent contract change.
 */
export type SealErrorCode = "bad_key" | "tampered";

export class SealError extends Error {
  readonly code: SealErrorCode;

  constructor(code: SealErrorCode, reason: string) {
    super(`${code}: ${reason}`);
    this.name = "SealError";
    this.code = code;
  }
}

/** AES-256-GCM. The secret must decode to exactly this many bytes. */
const KEY_BYTES = 32;

/** 96 bits, the size GCM is specified for and the only one worth using. */
const IV_BYTES = 12;

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

/**
 * Imports the identity secret as a non-extractable AES-GCM key.
 *
 * Non-extractable on purpose: nothing downstream ever needs the raw bytes
 * back, and a key that cannot be exported cannot be accidentally logged or
 * serialised by code that gets hold of the `CryptoKey`.
 */
export async function importIdentityKey(base64Secret: string): Promise<CryptoKey> {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(base64Secret);
  } catch {
    throw new SealError("bad_key", "the identity secret is not valid base64");
  }
  if (bytes.length !== KEY_BYTES) {
    // Length only -- never the decoded bytes, and never the secret itself.
    throw new SealError("bad_key", `the identity secret must decode to ${KEY_BYTES} bytes`);
  }
  try {
    return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  } catch {
    throw new SealError("bad_key", "the identity secret could not be imported as an AES-GCM key");
  }
}

/**
 * Seals `plaintext`, returning `b64(iv).b64(ciphertext)`.
 *
 * The IV is fresh per call, which is what makes two seals of the same token
 * differ -- and, more importantly, what keeps GCM safe: reusing an IV under
 * one key breaks the mode outright.
 */
export async function seal(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return `${toBase64(iv)}.${toBase64(new Uint8Array(ct))}`;
}

/**
 * Opens a value produced by `seal`.
 *
 * Every way this can go wrong -- a value that is not two base64 segments, a
 * wrong-sized IV, an edited ciphertext, the wrong key -- collapses to the same
 * `tampered` error with the same message. Deliberately: distinguishing
 * "malformed" from "authentication failed" tells whoever is feeding us values
 * how far their guess got, and there is nothing a caller could usefully do
 * differently with the distinction anyway.
 */
export async function open(key: CryptoKey, sealed: string): Promise<string> {
  const parts = sealed.split(".");
  if (parts.length !== 2) {
    throw new SealError("tampered", "sealed token failed to open");
  }
  try {
    const iv = fromBase64(parts[0]);
    const ct = fromBase64(parts[1]);
    if (iv.length !== IV_BYTES) {
      throw new SealError("tampered", "sealed token failed to open");
    }
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new TextDecoder().decode(plaintext);
  } catch {
    // Includes the SealError thrown just above; rethrowing an identical one
    // keeps the single message and costs nothing.
    throw new SealError("tampered", "sealed token failed to open");
  }
}
