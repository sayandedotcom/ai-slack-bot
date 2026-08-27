import type { Env } from "../index";
import { getIdentity, type Provider } from "../db/identities";
import { SealError, importIdentityKey, open } from "../identity/crypto";

/**
 * The one composition that turns a stored identity row back into a usable
 * credential: storage (`db/identities.ts`) plus key material (`identity/crypto.ts`).
 *
 * It lives in its own module rather than inside either half on purpose. The
 * storage layer stays crypto-free — it never sees a key, so it cannot leak one
 * — and the crypto layer stays storage-free, so the plaintext of a token exists
 * in exactly one function's reach. Everything downstream (the Slack and Linear
 * capabilities in Phase 13/20) imports THIS, and therefore cannot get a token
 * without going through both checks.
 */

/**
 * The user's decrypted token for `provider`, or `null` if they have not
 * connected it.
 *
 * The two failure shapes are deliberately different:
 *
 * - NO ROW is an ordinary, expected state — a fire-fighter who simply has not
 *   clicked "connect Slack" yet — so it is `null`, and callers branch on it.
 * - A row that will NOT OPEN is not ordinary. It means the stored ciphertext was
 *   edited, or the configured `IDENTITY_KEY` is not the key it was sealed under.
 *   Both are situations where silently behaving as "not connected" would hide a
 *   tampered database or a mis-rotated secret behind a benign-looking UI state,
 *   so the `SealError` PROPAGATES, loudly.
 *
 * A missing `IDENTITY_KEY` when a row does exist is the same class of problem:
 * it names the VARIABLE and never a value, matching the 503 wording the HTTP
 * layer uses for the same misconfiguration.
 */
export async function getDecryptedToken(
  env: Env,
  email: string,
  provider: Provider
): Promise<string | null> {
  const row = await getIdentity(env.DB, email, provider);
  if (!row) return null;

  const secret = env.IDENTITY_KEY;
  if (!secret) {
    throw new SealError("bad_key", "missing configuration: IDENTITY_KEY");
  }

  const key = await importIdentityKey(secret);
  return await open(key, row.tokenCiphertext);
}
