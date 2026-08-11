import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getChannelPolicy } from "../src/db/channels";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM channels").run();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels VALUES (?, ?, ?, ?)").bind("C_REF", "pulsefit-zellify", "pulsefit", "observe"),
    env.DB.prepare("INSERT INTO channels VALUES (?, ?, ?, ?)").bind("C_TEST", "test-firedrill", "firedrill", "live"),
    env.DB.prepare("INSERT INTO channels VALUES (?, ?, ?, ?)").bind("C_ENG", "eng-firefighter", null, "internal"),
  ]);
});

describe("getChannelPolicy", () => {
  it("returns the stored policy for a known channel", async () => {
    const p = await getChannelPolicy(env.DB, "C_REF");
    expect(p).toMatchObject({ mode: "observe", customer_slug: "pulsefit", known: true });
  });

  it("returns the stored policy for a live channel", async () => {
    const p = await getChannelPolicy(env.DB, "C_TEST");
    expect(p).toMatchObject({ mode: "live", customer_slug: "firedrill", known: true });
  });

  it("returns internal channels with a null customer", async () => {
    const p = await getChannelPolicy(env.DB, "C_ENG");
    expect(p).toMatchObject({ mode: "internal", customer_slug: null, known: true });
  });

  it("fails closed for an unknown channel", async () => {
    const p = await getChannelPolicy(env.DB, "C_NEVER_SEEN");
    expect(p.mode).toBe("observe");
    expect(p.known).toBe(false);
    expect(p.customer_slug).toBeNull();
  });
});
