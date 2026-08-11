import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canPost, getChannelPolicy, shouldTriage } from "../src/db/channels";

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

describe("canPost", () => {
  it("permits live channels", async () => {
    expect(canPost(await getChannelPolicy(env.DB, "C_TEST"))).toBe(true);
  });

  it("refuses reference customer channels", async () => {
    expect(canPost(await getChannelPolicy(env.DB, "C_REF"))).toBe(false);
  });

  it("refuses internal channels", async () => {
    expect(canPost(await getChannelPolicy(env.DB, "C_ENG"))).toBe(false);
  });

  it("refuses unmapped channels", async () => {
    expect(canPost(await getChannelPolicy(env.DB, "C_UNKNOWN"))).toBe(false);
  });
});

describe("shouldTriage", () => {
  it("triages customer channels, live and reference alike", async () => {
    expect(shouldTriage(await getChannelPolicy(env.DB, "C_REF"))).toBe(true);
    expect(shouldTriage(await getChannelPolicy(env.DB, "C_TEST"))).toBe(true);
  });

  it("does not triage internal channels", async () => {
    expect(shouldTriage(await getChannelPolicy(env.DB, "C_ENG"))).toBe(false);
  });

  it("does not triage unmapped channels", async () => {
    expect(shouldTriage(await getChannelPolicy(env.DB, "C_UNKNOWN"))).toBe(false);
  });
});
