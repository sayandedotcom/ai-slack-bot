import { describe, expect, it } from "vitest";
import {
  importIdentityKey,
  open,
  SealError,
  seal,
} from "../src/identity/crypto";

// Real WebCrypto throughout -- the workerd pool gives us the same `crypto`
// production runs on, so nothing here is mocked. A test that stubbed
// `subtle.encrypt` would prove only that the wrapper calls it, not that a
// sealed token actually survives a round trip or that a tampered one fails.

/** A syntactically valid 32-byte secret, base64-encoded. */
function secret(fill: number): string {
  const bytes = new Uint8Array(32).fill(fill);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const PLAINTEXT = "xoxb-super-secret-slack-bot-token";

/**
 * The constraint, asserted as a helper because it applies to EVERY throw:
 * no plaintext and no key material may appear in a message a caller might log.
 */
function expectNoLeak(err: unknown, ...forbidden: string[]): void {
  const message = String((err as Error).message);
  for (const needle of forbidden) {
    expect(message).not.toContain(needle);
  }
}

describe("identity token crypto", () => {
  it("round-trips a sealed token back to its plaintext", async () => {
    const key = await importIdentityKey(secret(1));
    const sealed = await seal(key, PLAINTEXT);
    expect(sealed).not.toContain(PLAINTEXT);
    expect(await open(key, sealed)).toBe(PLAINTEXT);
  });

  it("emits a different ciphertext each time, because the IV is random", async () => {
    const key = await importIdentityKey(secret(1));
    const a = await seal(key, PLAINTEXT);
    const b = await seal(key, PLAINTEXT);
    expect(a).not.toBe(b);
    // Both still open -- differing output is randomness, not corruption.
    expect(await open(key, a)).toBe(PLAINTEXT);
    expect(await open(key, b)).toBe(PLAINTEXT);
  });

  it("emits the iv and ciphertext as two base64 segments", async () => {
    const key = await importIdentityKey(secret(1));
    const parts = (await seal(key, PLAINTEXT)).split(".");
    expect(parts).toHaveLength(2);
    // 12 IV bytes -> 16 base64 characters, padding included.
    expect(atob(parts[0]).length).toBe(12);
  });

  it("refuses a sealed token whose ciphertext was flipped", async () => {
    const key = await importIdentityKey(secret(1));
    const [iv, ct] = (await seal(key, PLAINTEXT)).split(".");
    const bytes = Uint8Array.from(atob(ct), (c) => c.charCodeAt(0));
    bytes[0] ^= 0x01;
    let flipped = "";
    for (const byte of bytes) flipped += String.fromCharCode(byte);
    const tampered = `${iv}.${btoa(flipped)}`;

    const err = await open(key, tampered).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SealError);
    expect((err as SealError).code).toBe("tampered");
    expectNoLeak(err, PLAINTEXT, tampered, secret(1));
  });

  it("refuses a sealed token opened with a different key", async () => {
    const sealed = await seal(await importIdentityKey(secret(1)), PLAINTEXT);
    const other = await importIdentityKey(secret(2));

    const err = await open(other, sealed).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SealError);
    expect((err as SealError).code).toBe("tampered");
    expectNoLeak(err, PLAINTEXT, sealed, secret(1), secret(2));
  });

  it("refuses malformed sealed input rather than throwing something raw", async () => {
    const key = await importIdentityKey(secret(1));
    for (const bad of ["", "no-dot", "!!!.!!!", "a.b.c"]) {
      const err = await open(key, bad).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SealError);
      expect((err as SealError).code).toBe("tampered");
      expectNoLeak(err, PLAINTEXT, secret(1));
    }
  });

  it("refuses a secret that is not base64, or is the wrong length", async () => {
    for (const bad of ["not base64!!", btoa("short"), btoa("x".repeat(64))]) {
      const err = await importIdentityKey(bad).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SealError);
      expect((err as SealError).code).toBe("bad_key");
      expectNoLeak(err, bad);
    }
  });
});
