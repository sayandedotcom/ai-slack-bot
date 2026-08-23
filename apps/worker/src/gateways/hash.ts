/**
 * SHA-256 of raw bytes, lowercase hex.
 *
 * Content-addressed, deliberately: an artifact's identity has to be a hash of
 * what is IN it. A name/type/size tuple aliases two different files of the same
 * length onto one key, which is how a request for one proof screenshot ends up
 * answered with a different one.
 */
export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
