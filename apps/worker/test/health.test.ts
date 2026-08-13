import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("health", () => {
  it("responds ok, and says whether model work is composable", async () => {
    const res = await SELF.fetch("https://example.com/api/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; model: { status: string } };
    // `ok` is still pure liveness and still exactly `true` — an existing uptime
    // monitor keeps its meaning. The composition report is a SIBLING, added so
    // a deployment whose model work is parked stops being invisible outside one
    // `console.warn` per isolate. Its contents are pinned in
    // run-telemetry.test.ts, including the no-leak assertions.
    expect(body.ok).toBe(true);
    expect(typeof body.model.status).toBe("string");
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
