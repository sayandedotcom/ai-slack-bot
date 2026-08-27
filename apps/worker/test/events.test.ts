import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const SECRET = "test-signing-secret"; // matches vitest.config.ts

async function post(
  body: unknown,
  opts: { sign?: boolean; timestamp?: number } = {}
) {
  const raw = JSON.stringify(body);
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (opts.sign !== false) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`v0:${ts}:${raw}`)
    );
    const hex = [...new Uint8Array(mac)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    headers["x-slack-signature"] = `v0=${hex}`;
  } else {
    headers["x-slack-signature"] = "v0=deadbeef";
  }
  headers["x-slack-request-timestamp"] = ts;

  return SELF.fetch("https://example.com/slack/events", {
    method: "POST",
    headers,
    body: raw,
  });
}

const messageEnvelope = {
  type: "event_callback",
  event_id: "Ev0001",
  team_id: "T1",
  event: {
    type: "message",
    channel: "C1",
    channel_type: "channel",
    user: "U1",
    text: "hi",
    ts: "1.1",
  },
};

describe("POST /slack/events", () => {
  it("answers a url_verification challenge", async () => {
    const res = await post({ type: "url_verification", challenge: "abc123" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "abc123" });
  });

  it("rejects an unsigned request with 401", async () => {
    const res = await post(messageEnvelope, { sign: false });
    expect(res.status).toBe(401);
  });

  it("accepts a signed message event with 200", async () => {
    const res = await post(messageEnvelope);
    expect(res.status).toBe(200);
  });

  it("writes nothing to D1 in the request path", async () => {
    await post(messageEnvelope);
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM events_seen"
    ).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("returns 200 for an unknown envelope type rather than erroring", async () => {
    const res = await post({
      type: "something_new",
      event_id: "Ev9",
      event: {},
    });
    expect(res.status).toBe(200);
  });
});
