import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildRegistry } from "../src/codemode/registry";
import { makeArtifactPublisher, MAX_ARTIFACT_BYTES } from "../src/files/r2";
import { guardLoader } from "../src/codemode/guarded-loader";
import { makeGuardedExecutor } from "../src/codemode/executor";
import type { CodeModeScope } from "../src/codemode/contracts";
import { fakeAuditSink, fakeDeps, seedPermittedScope, TEST_LIMITS, testExecution } from "./helpers/codemode";

const BASE = "https://firefighter.example/api/artifacts";

/**
 * Fresh run/turn per call: publish reserves through the effect ledger.
 *
 * Also a WRITE-PERMITTED scope. `files.publish` is classified `external_write`,
 * so the shared host guard now re-reads this run's channel policy and `runs`
 * row before every publish — the same matrix that has always gated
 * `slack.reply`. A hand-built scope denies with `channel_read_only`, which is
 * correct and is asserted in codemode-write-guard.test.ts; this file is about
 * what a permitted publish DOES, so it seeds the rows that let it happen.
 */
async function freshScope(): Promise<CodeModeScope> {
  return seedPermittedScope(env.DB);
}

async function filesTools(scope?: CodeModeScope) {
  const resolved = scope ?? (await freshScope());
  const publisher = makeArtifactPublisher({ bucket: env.ARTIFACTS, baseUrl: BASE });
  const deps = { ...fakeDeps(), db: env.DB, files: publisher };
  return buildRegistry(resolved, deps, TEST_LIMITS, testExecution({ audit: fakeAuditSink() }))
    .find((p) => p.name === "files")!.tools;
}

const call = (tools: Awaited<ReturnType<typeof filesTools>>, args: unknown) =>
  (tools.publish as { execute: (a: unknown) => Promise<unknown> }).execute(args);

const bytes = (text: string) => new TextEncoder().encode(text);

const valid = () => ({
  bytes: bytes("id,name\n1,acme\n"),
  contentType: "text/csv",
  filename: "report.csv",
});

describe("files.publish input validation", () => {
  it("accepts a small allowlisted artifact", async () => {
    const out = await call(await filesTools(), valid()) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(["sha256", "size", "url"]);
    expect(out.size).toBe(15);
  });

  it.each([
    ["a disallowed content type", { contentType: "text/html" }],
    ["an executable content type", { contentType: "application/x-msdownload" }],
    ["svg, which is a script container", { contentType: "image/svg+xml" }],
    ["empty bytes", { bytes: new Uint8Array() }],
    ["a path in the filename", { filename: "../../etc/passwd" }],
    ["a backslash path", { filename: "dir\\file.csv" }],
    ["a control character", { filename: "re\0port.csv" }],
    ["a leading dot", { filename: ".hidden" }],
  ])("rejects %s", async (_label, patch) => {
    await expect(call(await filesTools(), { ...valid(), ...patch })).rejects.toThrow(/invalid_input/);
  });

  it.each([
    ["a Windows executable", [0x4d, 0x5a, 0x90, 0x00]],
    ["an ELF binary", [0x7f, 0x45, 0x4c, 0x46]],
    ["a shebang script", [0x23, 0x21, 0x2f, 0x62]],
  ])("rejects %s by its magic bytes", async (_label, magic) => {
    await expect(call(await filesTools(), {
      ...valid(), bytes: new Uint8Array([...magic, 1, 2, 3]), contentType: "application/pdf", filename: "x.pdf",
    })).rejects.toThrow(/invalid_input/);
  });

  it.each([
    ["a bucket", { bucket: "other" }],
    ["an object key", { key: "secret/path" }],
    ["an acl", { acl: "public-read" }],
    ["cache headers", { cacheControl: "public, max-age=999" }],
    ["a public origin", { publicUrl: "https://evil.example" }],
    ["an expiry", { expiresIn: 999 }],
  ])("rejects %s argument", async (_label, patch) => {
    await expect(call(await filesTools(), { ...valid(), ...patch })).rejects.toThrow(/invalid_input/);
  });

  it("rejects one byte over the cap", async () => {
    await expect(call(await filesTools(), {
      ...valid(), bytes: new Uint8Array(MAX_ARTIFACT_BYTES + 1).fill(65), contentType: "text/plain", filename: "big.txt",
    })).rejects.toThrow(/invalid_input/);
  });

  it("accepts exactly the cap", async () => {
    const out = await call(await filesTools(), {
      ...valid(), bytes: new Uint8Array(MAX_ARTIFACT_BYTES).fill(65), contentType: "text/plain", filename: "atcap.txt",
    }) as { size: number };
    expect(out.size).toBe(MAX_ARTIFACT_BYTES);
  });
});

describe("files.publish is deterministic and retry-safe", () => {
  it("returns the same url and hash for a retry within one turn", async () => {
    const scope = await freshScope();
    const first = await call(await filesTools(scope), valid()) as { url: string; sha256: string };
    const second = await call(await filesTools(scope), valid()) as { url: string; sha256: string };
    expect(second).toEqual(first);
  });

  it("writes one object, not two, for that retry", async () => {
    const scope = await freshScope();
    await call(await filesTools(scope), valid());
    await call(await filesTools(scope), valid());
    const listed = await env.ARTIFACTS.list({ limit: 1000 });
    const first = await call(await filesTools(scope), valid()) as { url: string };
    const key = first.url.slice(BASE.length + 1);
    expect(listed.objects.filter((o) => o.key === key)).toHaveLength(1);
  });

  it("stores the declared content type and forces attachment download", async () => {
    const out = await call(await filesTools(), valid()) as { url: string };
    const object = await env.ARTIFACTS.get(out.url.slice(BASE.length + 1));
    expect(object?.httpMetadata?.contentType).toBe("text/csv");
    // Never inline: an artifact served from the app's own origin that renders
    // in the browser is stored XSS.
    expect(object?.httpMetadata?.contentDisposition).toMatch(/^attachment;/);
  });

  it("records a verifiable hash", async () => {
    const out = await call(await filesTools(), valid()) as { url: string; sha256: string };
    const object = await env.ARTIFACTS.get(out.url.slice(BASE.length + 1));
    expect(object?.customMetadata?.sha256).toBe(out.sha256);
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives different content a different object", async () => {
    const a = await call(await filesTools(), valid()) as { url: string };
    const b = await call(await filesTools(), { ...valid(), bytes: bytes("different") }) as { url: string };
    expect(a.url).not.toBe(b.url);
  });

  /**
   * Phase 10 Task 1 Step 7. The canonical effect args used to be
   * `{ contentType, filename, size }` — no content. Two different files with
   * the same name, type and length therefore shared one effect key, and within
   * a turn the ledger answered the second publish with the FIRST file's URL:
   * an agent asked for two proof screenshots got one of them twice, with no
   * error anywhere and a `sha256` in the result that belonged to the other
   * file. Same scope on purpose — a fresh run/turn would hide the collision.
   */
  it("does not alias two different files of the same name, type and size", async () => {
    const scope = await freshScope();
    const shared = { contentType: "text/csv", filename: "proof.csv" };
    const a = await call(await filesTools(scope), { ...shared, bytes: bytes("aaaaaaaa") }) as
      { url: string; size: number; sha256: string };
    const b = await call(await filesTools(scope), { ...shared, bytes: bytes("bbbbbbbb") }) as
      { url: string; size: number; sha256: string };

    expect(a.size).toBe(b.size);            // the old tuple matched on all three
    expect(b.sha256).not.toBe(a.sha256);
    expect(b.url).not.toBe(a.url);

    // Both files are really in the bucket, each with its own bytes.
    const storedA = await env.ARTIFACTS.get(a.url.slice(BASE.length + 1));
    const storedB = await env.ARTIFACTS.get(b.url.slice(BASE.length + 1));
    expect(await storedA?.text()).toBe("aaaaaaaa");
    expect(await storedB?.text()).toBe("bbbbbbbb");
  });

  // The other half of the claim: identical CONTENT must still deduplicate, or
  // adding the hash would have traded one bug for a retry sending twice.
  it("still replays identical content within one turn", async () => {
    const scope = await freshScope();
    const a = await call(await filesTools(scope), valid()) as { url: string };
    const b = await call(await filesTools(scope), valid()) as { url: string };
    expect(b.url).toBe(a.url);
  });
});

describe("files.publish leaks nothing about storage", () => {
  it("returns only url, size and hash", async () => {
    const out = await call(await filesTools(), valid()) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(["sha256", "size", "url"]);
  });

  it("names no bucket, account, or credential", async () => {
    const out = JSON.stringify(await call(await filesTools(), valid()));
    for (const forbidden of ["firefighter-artifacts", "ARTIFACTS", "r2.cloudflarestorage", "accountId", "accessKey"]) {
      expect(out).not.toContain(forbidden);
    }
  });

  it("serves from the app's own origin, not a public bucket", async () => {
    const out = await call(await filesTools(), valid()) as { url: string };
    expect(out.url.startsWith(BASE)).toBe(true);
    expect(out.url).not.toContain("r2.dev");
  });
});

// Task 12 Step 6: the codec has to move real bytes through a real isolate, not
// just through a direct provider call.
describe("binary survives a real Dynamic Worker round trip", () => {
  const executor = () =>
    makeGuardedExecutor(guardLoader(env.LOADER, TEST_LIMITS), TEST_LIMITS, () => Date.now());

  it("passes a Uint8Array from sandbox code to the host intact", async () => {
    let received: Uint8Array | null = null;
    const out = await executor().execute(
      "async () => { const b = new Uint8Array([1,2,3,250,255]); return await files.publish({ bytes: b }); }",
      [{
        name: "files",
        fns: {
          publish: async (args: unknown) => {
            received = (args as { bytes: Uint8Array }).bytes;
            return { ok: true, length: received.byteLength };
          },
        },
      }],
    );
    expect(out.error).toBeUndefined();
    expect(received).toBeInstanceOf(Uint8Array);
    expect(Array.from(received!)).toEqual([1, 2, 3, 250, 255]);
  });

  it("moves a realistic artifact through the codec and reports the cost", async () => {
    const size = 256 * 1024;
    const started = Date.now();
    let receivedLength = 0;
    const out = await executor().execute(
      `async () => { const b = new Uint8Array(${size}); b.fill(7); return await files.publish({ bytes: b }); }`,
      [{
        name: "files",
        fns: {
          publish: async (args: unknown) => {
            receivedLength = (args as { bytes: Uint8Array }).bytes.byteLength;
            return { length: receivedLength };
          },
        },
      }],
    );
    const elapsed = Date.now() - started;
    expect(out.error).toBeUndefined();
    expect(receivedLength).toBe(size);
    // Recorded rather than asserted tightly: the point is to notice if the
    // codec ever becomes the bottleneck. See phase-09-notes.md Task 12.
    expect(elapsed).toBeLessThan(TEST_LIMITS.wallTimeMs * 20);
  });
});
