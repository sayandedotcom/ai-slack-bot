import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canPost, getChannelPolicy, shouldTriage } from "../../src/db/channels";

// Mirrors the exact rows scripts/seed-channels.sh writes to production. If
// someone re-seeds a customer channel as `live`, this test fails before it
// can reach a customer.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM channels").run();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, ?, ?)"
    ).bind("C0B9YBENNAD", "ext-zellify-sidehop", "sidehop", "observe"),
    env.DB.prepare(
      "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, ?, ?)"
    ).bind("C0BPGUXG5RS", "test-firedrill", "firedrill", "live"),
    env.DB.prepare(
      "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, ?, ?)"
    ).bind("C0BPA2L4BBP", "ff-test", "firedrill", "live"),
  ]);
});

describe("seeded production policy", () => {
  it("refuses to post in the real customer channel", async () => {
    expect(canPost(await getChannelPolicy(env.DB, "C0B9YBENNAD"))).toBe(false);
  });

  it("still triages the customer channel — observe blocks posting, not hearing", async () => {
    expect(shouldTriage(await getChannelPolicy(env.DB, "C0B9YBENNAD"))).toBe(
      true
    );
  });

  it("permits posting only in our own test channels", async () => {
    expect(canPost(await getChannelPolicy(env.DB, "C0BPGUXG5RS"))).toBe(true);
    expect(canPost(await getChannelPolicy(env.DB, "C0BPA2L4BBP"))).toBe(true);
  });

  it("no channel named ext-* is ever postable", async () => {
    const { results } = await env.DB.prepare(
      "SELECT channel_id FROM channels WHERE name LIKE 'ext-%'"
    ).all<{ channel_id: string }>();
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(canPost(await getChannelPolicy(env.DB, r.channel_id))).toBe(false);
    }
  });
});
