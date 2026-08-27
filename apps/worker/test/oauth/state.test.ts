import { describe, expect, it } from "vitest";
import { importStateKey, mintState, verifyState } from "../../src/oauth/state";

/**
 * The state parameter is the ONLY thing standing between the OAuth callback
 * and anyone who can hit a URL, so these cases are all adversarial: every one
 * of them is a way somebody could try to complete a connect as somebody else.
 * `verifyState` must answer `null` to all of them, and must never throw --
 * the routes deliberately have no try/catch around it.
 */

const NOW = Date.parse("2026-08-13T12:00:00Z");

/** 32 bytes, the same shape `IDENTITY_KEY` carries in production. */
const SECRET = btoa(
  String.fromCharCode(...new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff))
);

const key = () => importStateKey(SECRET);

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("mintState / verifyState round trip", () => {
  it("returns the email it was minted with", async () => {
    const k = await key();
    const state = await mintState(k, "ronit@zellify.app", "slack", NOW);
    expect(await verifyState(k, state, "slack", NOW + 1000)).toEqual({
      email: "ronit@zellify.app",
    });
  });

  it("mints a different state every time, for the same input", async () => {
    const k = await key();
    const a = await mintState(k, "ronit@zellify.app", "slack", NOW);
    const b = await mintState(k, "ronit@zellify.app", "slack", NOW);
    expect(a).not.toBe(b);
  });

  it("carries no readable secret and is two base64url segments", async () => {
    const k = await key();
    const state = await mintState(k, "ronit@zellify.app", "slack", NOW);
    expect(state.split(".")).toHaveLength(2);
    expect(state).not.toContain(SECRET);
  });
});

describe("verifyState refuses everything else", () => {
  it("expires ten minutes out — good at 9, null at 11", async () => {
    const k = await key();
    const state = await mintState(k, "ronit@zellify.app", "slack", NOW);
    expect(
      await verifyState(k, state, "slack", NOW + 9 * 60_000)
    ).not.toBeNull();
    expect(await verifyState(k, state, "slack", NOW + 11 * 60_000)).toBeNull();
  });

  it("rejects a payload swapped for another identity's, signature kept", async () => {
    const k = await key();
    const mine = await mintState(k, "ronit@zellify.app", "slack", NOW);
    const forged = base64UrlEncode(
      JSON.stringify({
        e: "attacker@example.com",
        p: "slack",
        x: NOW + 600_000,
        n: "AAAA",
      })
    );
    expect(
      await verifyState(k, `${forged}.${mine.split(".")[1]}`, "slack", NOW)
    ).toBeNull();
  });

  it("rejects a signature borrowed from a different state", async () => {
    const k = await key();
    const mine = await mintState(k, "ronit@zellify.app", "slack", NOW);
    const other = await mintState(k, "luka@zellify.app", "slack", NOW);
    expect(
      await verifyState(
        k,
        `${mine.split(".")[0]}.${other.split(".")[1]}`,
        "slack",
        NOW
      )
    ).toBeNull();
  });

  it("rejects a state signed with a different key", async () => {
    const foreign = await importStateKey(
      btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
    );
    const state = await mintState(foreign, "ronit@zellify.app", "slack", NOW);
    expect(await verifyState(await key(), state, "slack", NOW)).toBeNull();
  });

  it("rejects a slack state replayed at the github callback", async () => {
    const k = await key();
    const state = await mintState(k, "ronit@zellify.app", "slack", NOW);
    expect(await verifyState(k, state, "github", NOW)).toBeNull();
    expect(await verifyState(k, state, "slack", NOW)).toEqual({
      email: "ronit@zellify.app",
    });
  });

  it.each([
    ["empty", ""],
    ["one segment", "ronit@zellify.app"],
    ["three segments", "a.b.c"],
    ["non-base64 segments", "!!!.???"],
    ["empty segments", "."],
    ["a signed-looking but random pair", "eyJlIjoiYSJ9.AAAA"],
  ])("returns null (not a throw) for %s input", async (_label, garbage) => {
    const k = await key();
    await expect(verifyState(k, garbage, "slack", NOW)).resolves.toBeNull();
  });
});
