/**
 * The speaker decides whose Slack token sends a customer reply, whose GitHub
 * token authors a PR, and who gets the nudge DM. There is no shift and no
 * clock: every fire-fighter on the roster who has connected the provider is
 * eligible, and the choice among them is deterministic — the approver when
 * there is one and they have connected, otherwise roster order.
 *
 * Replaces test/rotation.test.ts (2026-08-17): the three-day rotation was
 * removed because its clock handed the seat to an engineer with no connected
 * identity at 00:00 UTC and every customer-facing write refused for the next
 * three days. See docs/drill.md §7.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FIREFIGHTERS, VIEWERS } from "../src/access/roster";
import { upsertIdentity } from "../src/db/identities";
import { resolveSpeaker, SPEAKER_POOL } from "../src/identity/speaker";

const [FIRST, SECOND] = FIREFIGHTERS as [string, string, ...string[]];
const LAST = FIREFIGHTERS[FIREFIGHTERS.length - 1]!;

async function clean(): Promise<void> {
  await env.DB.prepare("DELETE FROM identities").run();
}
beforeEach(clean);
afterEach(clean);

async function connect(email: string, provider: "slack" | "github", externalId: string, at = 1_000) {
  await upsertIdentity(
    env.DB,
    { email, provider, externalId, scopes: "chat:write", tokenCiphertext: "sealed", connectedAt: at },
    at,
  );
}

describe("SPEAKER_POOL", () => {
  it("is exactly the fire-fighter roster, in roster order — no shift, no epoch", () => {
    expect(SPEAKER_POOL).toEqual(FIREFIGHTERS);
  });
});

describe("resolveSpeaker", () => {
  it("is null when nobody on the roster has connected the provider", async () => {
    await connect(VIEWERS[0]!, "slack", "U-viewer"); // a viewer is not a speaker
    expect(await resolveSpeaker(env.DB, "slack")).toBeNull();
  });

  it("picks the first roster member who has connected, in roster order", async () => {
    await connect(LAST, "slack", "U-last");
    await connect(SECOND, "slack", "U-second");
    const speaker = await resolveSpeaker(env.DB, "slack");
    expect(speaker).toMatchObject({ email: SECOND, externalId: "U-second" });
  });

  it("is per provider: a Slack connect does not make a GitHub speaker", async () => {
    await connect(FIRST, "slack", "U-first");
    expect(await resolveSpeaker(env.DB, "github")).toBeNull();
    await connect(LAST, "github", "gh-last");
    expect(await resolveSpeaker(env.DB, "github")).toMatchObject({ email: LAST, externalId: "gh-last" });
  });

  it("prefers the named person when they are a connected fire-fighter", async () => {
    await connect(FIRST, "slack", "U-first");
    await connect(LAST, "slack", "U-last");
    expect(await resolveSpeaker(env.DB, "slack", LAST)).toMatchObject({ email: LAST });
  });

  it("falls back to roster order when the named person has not connected", async () => {
    await connect(SECOND, "slack", "U-second");
    expect(await resolveSpeaker(env.DB, "slack", LAST)).toMatchObject({ email: SECOND });
  });

  it("never speaks as someone off the fire-fighter roster, even if named and connected", async () => {
    await connect(VIEWERS[0]!, "slack", "U-viewer");
    await connect(FIRST, "slack", "U-first");
    expect(await resolveSpeaker(env.DB, "slack", VIEWERS[0]!)).toMatchObject({ email: FIRST });
    expect(await resolveSpeaker(env.DB, "slack", "stranger@example.com")).toMatchObject({ email: FIRST });
  });

  it("carries the connect timestamps and never the token", async () => {
    await connect(FIRST, "slack", "U-first", 4_242);
    const speaker = await resolveSpeaker(env.DB, "slack");
    expect(speaker).toEqual({ email: FIRST, externalId: "U-first", connectedAt: 4_242, updatedAt: 4_242 });
    expect(JSON.stringify(speaker)).not.toContain("sealed");
  });
});
