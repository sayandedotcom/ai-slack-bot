import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("health", () => {
  it("responds ok", async () => {
    const res = await SELF.fetch("https://firefighter.test/api/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean };
    // A key-set pin fails the moment the payload grows anything at all, which
    // makes adding a field a decision somebody has to make on purpose.
    expect(Object.keys(body).sort()).toEqual(["ok"]);
    // Pure liveness, and exactly `true` — an existing monitor keeps its
    // meaning. The model-composition report that used to ride alongside it
    // belonged to the agent layer; a new one should be a SIBLING key, never a
    // change to what `ok` means.
    expect(body.ok).toBe(true);
  });

  it("has the migrated schema", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all<{ name: string }>();
    const names = results.map((r) => r.name);
    expect(names).toContain("channels");
    expect(names).toContain("events_seen");
    expect(names).toContain("messages");
  });
});
