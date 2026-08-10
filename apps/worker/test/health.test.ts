import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("health", () => {
  it("responds ok", async () => {
    const res = await SELF.fetch("https://example.com/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("has the migrated schema", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all<{ name: string }>();
    const names = results.map((r) => r.name);
    expect(names).toContain("channels");
    expect(names).toContain("events_seen");
    expect(names).toContain("messages");
  });
});
