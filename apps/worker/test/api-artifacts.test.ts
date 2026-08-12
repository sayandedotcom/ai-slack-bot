import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeArtifactPublisher } from "../src/files/r2";
import { isArtifactKey } from "../src/api/artifacts";
import { buildRegistry } from "../src/codemode/registry";
import {
  fakeAuditSink,
  fakeDeps,
  seedPermittedScope,
  TEST_LIMITS,
  testExecution,
} from "./helpers/codemode";

/**
 * THE ROUTE `files.publish` URLS POINT AT.
 *
 * Until this route existed, every published artifact 404'd: the capability
 * returned a URL under the Worker's own origin and nothing answered it, so the
 * model believed it had delivered evidence, said so in its answer, and a human
 * followed a dead link. Phase 10 forbids reporting a success URL the Worker
 * always fails to serve, so the choice was to serve it or to withdraw the
 * capability. These cases hold the serving side honest.
 *
 * The first case is the important one — it proves the URL the CAPABILITY
 * produces is the URL this route answers. Testing the route against a key some
 * test invented would leave the two free to drift, which is precisely the bug
 * being fixed.
 */

const BASE = "https://firefighter.example/api/artifacts";
const publisher = () => makeArtifactPublisher({ bucket: env.ARTIFACTS, baseUrl: BASE });

const bytes = (text: string) => new TextEncoder().encode(text);

async function publish(input?: { contentType?: string; filename?: string; body?: string }) {
  return publisher().publish({
    bytes: bytes(input?.body ?? "id,name\n1,acme\n"),
    contentType: input?.contentType ?? "text/csv",
    filename: input?.filename ?? "report.csv",
    idempotencyKey: crypto.randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64),
  });
}

/** The route is mounted on the Worker, so it is exercised through the Worker. */
const get = (key: string) => SELF.fetch(`https://firefighter.example/api/artifacts/${key}`);

describe("GET /api/artifacts/:key serves what files.publish wrote", () => {
  /**
   * END TO END, through the real capability.
   *
   * This is the case that actually pins the contract. The others call
   * `makeArtifactPublisher().publish()` with a self-invented idempotency key,
   * which exercises the route but leaves the two halves free to drift — and
   * drift between the URL a tool reports and the URL the Worker answers is the
   * exact bug this whole route exists to fix. Here the key comes from
   * `effectKey()` by way of `runEffect`, so if that ever stops being 64
   * lowercase hex characters, `ARTIFACT_KEY` stops matching and this fails.
   */
  it("answers the URL the files.publish CAPABILITY produced", async () => {
    const scope = await seedPermittedScope(env.DB);
    const deps = {
      ...fakeDeps(),
      db: env.DB,
      files: makeArtifactPublisher({ bucket: env.ARTIFACTS, baseUrl: BASE }),
    };
    const tools = buildRegistry(scope, deps, TEST_LIMITS, testExecution({ audit: fakeAuditSink() }))
      .find((p) => p.name === "files")!.tools;

    const result = (await (
      tools.publish as { execute: (a: unknown) => Promise<unknown> }
    ).execute({
      bytes: bytes("id,name\n1,acme\n"),
      contentType: "text/csv",
      filename: "capability.csv",
    })) as { url: string };

    expect(result.url.startsWith(`${BASE}/`)).toBe(true);
    const response = await get(result.url.slice(`${BASE}/`.length));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("id,name\n1,acme\n");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="capability.csv"',
    );
  });

  it("answers the exact URL the publisher handed back", async () => {
    const published = await publish();
    expect(published.url.startsWith(`${BASE}/`)).toBe(true);

    const key = published.url.slice(`${BASE}/`.length);
    const response = await get(key);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("id,name\n1,acme\n");
  });

  it("answers HEAD with the same headers and no body", async () => {
    const published = await publish({ filename: "head.csv" });
    const key = published.url.slice(`${BASE}/`.length);

    const [head, body] = await Promise.all([
      SELF.fetch(`https://firefighter.example/api/artifacts/${key}`, { method: "HEAD" }),
      get(key),
    ]);

    expect(head.status).toBe(body.status);
    expect(head.headers.get("content-type")).toBe(body.headers.get("content-type"));
    expect(head.headers.get("content-length")).toBe(body.headers.get("content-length"));
    expect(await head.text()).toBe("");
  });

  it("reports the stored content type and the real length", async () => {
    const published = await publish({ contentType: "application/json", filename: "trace.json", body: "{}" });
    const response = await get(published.url.slice(`${BASE}/`.length));

    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("content-length")).toBe(String(published.size));
  });

  it("serves every allowlisted content type", async () => {
    for (const [contentType, extension] of [
      ["text/plain", "txt"],
      ["text/markdown", "md"],
      ["image/png", "png"],
      ["application/pdf", "pdf"],
    ] as const) {
      const published = await publish({ contentType, filename: `x.${extension}`, body: `body-${extension}` });
      const response = await get(published.url.slice(`${BASE}/`.length));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(contentType);
    }
  });
});

describe("the response is inert", () => {
  it("forces a download rather than rendering in the app's origin", async () => {
    const published = await publish({ filename: "evidence.csv" });
    const response = await get(published.url.slice(`${BASE}/`.length));

    // Stored content rendered inline from the app's own origin IS stored XSS.
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="evidence.csv"',
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("never caches an artifact publicly", async () => {
    const published = await publish();
    const response = await get(published.url.slice(`${BASE}/`.length));
    // Content-addressed, so immutable — but behind Access, so private.
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).not.toContain("public");
  });
});

describe("the key is validated before R2 is touched", () => {
  it("accepts only sha256-plus-allowed-extension", () => {
    const hex = "a".repeat(64);
    expect(isArtifactKey(`${hex}.csv`)).toBe(true);
    expect(isArtifactKey(`${hex}.png`)).toBe(true);

    // Everything the shape rules out, and why each one matters:
    expect(isArtifactKey(`${hex}.svg`)).toBe(false); // script container
    expect(isArtifactKey(`${hex}.html`)).toBe(false); // script container
    expect(isArtifactKey(`${hex}`)).toBe(false); // no type at all
    expect(isArtifactKey(`${"A".repeat(64)}.csv`)).toBe(false); // not our hex casing
    expect(isArtifactKey(`${hex.slice(1)}.csv`)).toBe(false); // wrong length
    expect(isArtifactKey("../secrets.csv")).toBe(false); // traversal
    expect(isArtifactKey("/etc/passwd")).toBe(false); // absolute path
    expect(isArtifactKey(`${hex}.csv?x=1`)).toBe(false); // query smuggling
    expect(isArtifactKey("")).toBe(false);
  });

  it.each([
    ["a traversal attempt", ".."],
    ["a wrong-length key", `${"a".repeat(32)}.csv`],
    ["a forbidden extension", `${"a".repeat(64)}.svg`],
    ["an unknown but well-formed key", `${"b".repeat(64)}.csv`],
  ])("404s %s", async (_label, key) => {
    const response = await get(key);
    // One 404 for every failure. Distinguishing them would turn this route into
    // an oracle that confirms which 64-character strings name a real artifact.
    expect(response.status).toBe(404);
  });

  it("gives an unknown key exactly the same answer as a malformed one", async () => {
    const unknown = await get(`${"c".repeat(64)}.csv`);
    const malformed = await get("nonsense");
    expect(unknown.status).toBe(malformed.status);
    expect(await unknown.text()).toBe(await malformed.text());
  });

  it("names no bucket, key prefix, or account in its refusal", async () => {
    const body = await (await get("nonsense")).text();
    expect(body).not.toContain("firefighter-artifacts");
    expect(body).not.toContain("R2");
  });
});
