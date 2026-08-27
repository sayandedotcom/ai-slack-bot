import { describe, expect, it } from "vitest";
import { verifySlackSignature } from "../src/slack/verify";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const BODY = "token=xyz&team_id=T1&command=/test";
const TS = "1531420618";

// Slack's documented algorithm: HMAC-SHA256 over `v0:{timestamp}:{body}`,
// hex-encoded, prefixed with "v0=".
async function sign(
  secret: string,
  timestamp: string,
  body: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`)
  );
  const hex = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `v0=${hex}`;
}

describe("verifySlackSignature", () => {
  it("accepts a correctly signed request", async () => {
    const signature = await sign(SECRET, TS, BODY);
    await expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature,
        timestamp: TS,
        rawBody: BODY,
        nowSeconds: Number(TS) + 10,
      })
    ).resolves.toBe(true);
  });

  it("rejects a tampered body", async () => {
    const signature = await sign(SECRET, TS, BODY);
    await expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature,
        timestamp: TS,
        rawBody: BODY + "&evil=1",
        nowSeconds: Number(TS) + 10,
      })
    ).resolves.toBe(false);
  });

  it("rejects a wrong secret", async () => {
    const signature = await sign("other-secret", TS, BODY);
    await expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature,
        timestamp: TS,
        rawBody: BODY,
        nowSeconds: Number(TS) + 10,
      })
    ).resolves.toBe(false);
  });

  it("rejects a replay older than 300 seconds", async () => {
    const signature = await sign(SECRET, TS, BODY);
    await expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature,
        timestamp: TS,
        rawBody: BODY,
        nowSeconds: Number(TS) + 301,
      })
    ).resolves.toBe(false);
  });

  it("rejects a timestamp too far in the future", async () => {
    const signature = await sign(SECRET, TS, BODY);
    await expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature,
        timestamp: TS,
        rawBody: BODY,
        nowSeconds: Number(TS) - 301,
      })
    ).resolves.toBe(false);
  });

  it("rejects missing headers", async () => {
    await expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature: null,
        timestamp: TS,
        rawBody: BODY,
      })
    ).resolves.toBe(false);
    await expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature: "v0=abc",
        timestamp: null,
        rawBody: BODY,
      })
    ).resolves.toBe(false);
  });

  it("rejects a non-numeric timestamp", async () => {
    await expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature: "v0=abc",
        timestamp: "not-a-number",
        rawBody: BODY,
      })
    ).resolves.toBe(false);
  });
});
