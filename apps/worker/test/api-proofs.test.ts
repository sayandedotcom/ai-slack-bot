import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { isProofKey } from "../src/api/proofs";
import { MAX_RECORDING_BYTES } from "../src/sandbox/record";
import { INTERNAL_KEY_PREFIX } from "../src/sandbox/diff";

/**
 * THE ONE UNAUTHENTICATED SURFACE IN THIS WORKER.
 *
 * Every other route in `src/index.ts` sits behind the Cloudflare Access
 * application that fronts the dashboard. This one cannot: a recording URL is
 * pasted into a Slack thread, and Slack's unfurler carries no Access token — a
 * gated URL would 302 the whole team's proof link to a login page. So the route
 * is mounted at the top level and an Access bypass policy is expected on it,
 * and the KEY is the secret: 64 hex characters of SHA-256 over a v4 UUID.
 *
 * That inverts every posture the artifacts route takes, which is exactly why it
 * is a separate route rather than a loosened one. `inline` instead of
 * `attachment` (it has to PLAY), `public` instead of `private` caching (the key
 * is the secret, and Slack's CDN should keep it). What does NOT change: the key
 * is validated before any bucket call, `_internal/` is refused positively and
 * first, the content type is re-derived rather than echoed, and every failure
 * is one indistinguishable 404.
 */

const ORIGIN = "https://firefighter.example";
const hex = (seed: string) => seed.repeat(64).slice(0, 64);

const fetchProof = (key: string, init?: RequestInit) =>
  SELF.fetch(`${ORIGIN}/proofs/${key}`, init);

/** Put an object where the route will look for it, without going near a container. */
async function seed(
  key: string,
  options?: { bytes?: Uint8Array; label?: string; contentType?: string },
): Promise<string> {
  await env.ARTIFACTS.put(`proofs/${key}`, (options?.bytes ?? new Uint8Array([1, 2, 3, 4])) as BufferSource, {
    httpMetadata: { contentType: options?.contentType ?? "video/mp4" },
    ...(options?.label === undefined ? {} : { customMetadata: { label: options.label } }),
  });
  return key;
}

describe("the key shape is decided before R2 is touched", () => {
  it("accepts exactly what the publisher writes and nothing else", () => {
    expect(isProofKey(`${hex("a")}.mp4`)).toBe(true);

    // Every rejection below is a probe somebody actually sends:
    expect(isProofKey(`${hex("a")}.png`)).toBe(false); // an ARTIFACTS-shaped key
    expect(isProofKey(`${hex("a")}.webm`)).toBe(false); // a plausible sibling format
    expect(isProofKey(`${hex("a")}.mp4.html`)).toBe(false); // double extension
    expect(isProofKey(hex("a"))).toBe(false); // no extension
    expect(isProofKey(`${hex("A")}.mp4`)).toBe(false); // not our hex casing
    expect(isProofKey(`${hex("a").slice(1)}.mp4`)).toBe(false); // wrong length
    expect(isProofKey(`proofs/${hex("a")}.mp4`)).toBe(false); // the STORED key, not the URL one
    expect(isProofKey("../../secrets.mp4")).toBe(false); // traversal
    expect(isProofKey("/etc/passwd")).toBe(false); // absolute path
    expect(isProofKey(`${hex("a")}.mp4?x=1`)).toBe(false); // query smuggling
    expect(isProofKey(`${INTERNAL_KEY_PREFIX}${hex("a")}.mp4`)).toBe(false);
    expect(isProofKey("")).toBe(false);
  });

  it("refuses the internal namespace positively, whatever shape it arrives in", async () => {
    // A raw `_internal/diff/…` path has too many segments to match `:key`, so
    // the reachable probe is the percent-encoded one — the same lesson the
    // artifacts route learned in Phase 18.
    for (const key of [
      `${INTERNAL_KEY_PREFIX}diff/${hex("a")}.patch`,
      `${INTERNAL_KEY_PREFIX}${hex("a")}.mp4`,
      INTERNAL_KEY_PREFIX,
    ]) {
      const response = await fetchProof(encodeURIComponent(key));
      expect(response.status).toBe(404);
    }
  });

  it("never serves an artifacts-shaped key, even one that really exists", async () => {
    // The two key spaces share a bucket. A `.png` under the artifacts root is
    // real and readable — through the AUTHENTICATED route only.
    await env.ARTIFACTS.put(`${hex("d")}.png`, new Uint8Array([9, 9]) as BufferSource);

    const response = await fetchProof(`${hex("d")}.png`);
    expect(response.status).toBe(404);
  });
});

describe("a published recording plays", () => {
  it("serves the bytes as inline video/mp4", async () => {
    const key = await seed(`${hex("b")}.mp4`, { bytes: new Uint8Array([1, 2, 3, 4]), label: "checkout" });
    const response = await fetchProof(key);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    // `inline`, not `attachment`: the whole point is that it plays in a browser
    // tab and unfurls in Slack. This is the one place this Worker deliberately
    // does the opposite of `src/api/artifacts.ts`.
    expect(response.headers.get("content-disposition")).toBe('inline; filename="checkout.mp4"');
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("etag")).toBeTruthy();
  });

  it("re-derives the content type instead of echoing stored metadata", async () => {
    // A future writer that stored a hostile contentType must not be able to
    // make this route repeat it.
    const key = await seed(`${hex("c")}.mp4`, { contentType: "text/html" });
    const response = await fetchProof(key);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
  });

  it("caches publicly and immutably, because the key is the secret", async () => {
    const key = await seed(`${hex("e")}.mp4`);
    const response = await fetchProof(key);

    // The opposite of the artifacts route on purpose. Slack's unfurler and the
    // team's browsers should all be able to keep this; what protects it is that
    // nobody can name it.
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("falls back to a safe filename when the stored label is missing or hostile", async () => {
    const plain = await seed(`${hex("f")}.mp4`);
    expect((await fetchProof(plain)).headers.get("content-disposition")).toBe(
      'inline; filename="proof.mp4"',
    );

    // A `"` in the label would break out of the quoted disposition parameter.
    const hostile = await seed(`${hex("1")}.mp4`, { label: 'x" ; attachment' });
    expect((await fetchProof(hostile)).headers.get("content-disposition")).toBe(
      'inline; filename="proof.mp4"',
    );
  });

  it("answers HEAD with the same headers and an empty body", async () => {
    const key = await seed(`${hex("2")}.mp4`, { label: "checkout" });

    const [head, body] = await Promise.all([
      fetchProof(key, { method: "HEAD" }),
      fetchProof(key),
    ]);

    // Registering GET alone would leave HEAD falling through to the asset
    // catch-all, which answers index.html with a 200 — a route whose HEAD and
    // GET disagree is one somebody will probe for exactly that.
    expect(head.status).toBe(body.status);
    expect(head.headers.get("content-type")).toBe(body.headers.get("content-type"));
    expect(head.headers.get("content-length")).toBe(body.headers.get("content-length"));
    expect(head.headers.get("content-disposition")).toBe(body.headers.get("content-disposition"));
    expect(await head.text()).toBe("");
  });

  it("404s a HEAD for a missing recording rather than serving the dashboard", async () => {
    const response = await fetchProof(`${hex("3")}.mp4`, { method: "HEAD" });
    expect(response.status).toBe(404);
  });
});

describe("every failure is the same 404", () => {
  it.each([
    ["an encoded absolute path", encodeURIComponent("/etc/passwd")],
    ["a wrong-length key", `${hex("a").slice(4)}.mp4`],
    ["an artifacts extension", `${hex("a")}.png`],
    ["an unknown but well-formed key", `${hex("9")}.mp4`],
    ["a bare word", "nonsense"],
  ])("404s %s", async (_label, key) => {
    expect((await fetchProof(key)).status).toBe(404);
  });

  it("never lets a dot-segment name a recording", async () => {
    // `..` never reaches the handler at all: the URL parser resolves dot
    // segments — including the percent-encoded `%2e%2e` form — before any router
    // sees the path, so `/proofs/..` IS `/`, a request for the dashboard root.
    // The property that matters is not the status code (the SPA legitimately
    // answers `/` with 200) but that no traversal shape can ever produce a
    // recording, which `isProofKey` above pins from the other side.
    for (const path of ["..", "%2e%2e", "%2e%2e/%2e%2e"]) {
      const response = await fetchProof(path);
      expect(response.headers.get("content-type")).not.toContain("video/");
      expect(response.headers.get("content-disposition")).toBeNull();
    }
  });

  it("answers an unknown key byte-for-byte like a malformed one", async () => {
    const unknown = await fetchProof(`${hex("8")}.mp4`);
    const malformed = await fetchProof("nonsense");

    // Distinguishing them turns the route into an oracle that confirms which
    // 64-character strings name a real recording — and the key is the ONLY
    // thing protecting a recording on a bypassed route.
    expect(unknown.status).toBe(malformed.status);
    expect(await unknown.text()).toBe(await malformed.text());
  });

  it("names no bucket, prefix or account in its refusal", async () => {
    const body = await (await fetchProof("nonsense")).text();
    expect(body).not.toContain("firefighter-artifacts");
    expect(body).not.toContain("proofs/");
    expect(body).not.toContain("R2");
  });

  it("does not fall through to the SPA for a multi-segment path", async () => {
    // `not_found_handling: "single-page-application"` makes the asset worker
    // answer ANY unmatched path with index.html and a 200. A proof URL that
    // returned markup with a success status would be worse than a 404.
    for (const path of ["a/b", ""]) {
      const response = await fetchProof(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).not.toContain("text/html");
    }
  });

  it("refuses an object above the ceiling independently of the publisher", { timeout: 60_000 }, async () => {
    const key = `${hex("7")}.mp4`;
    const size = MAX_RECORDING_BYTES + 1;
    // A FixedLengthStream, because `R2Bucket.put` refuses a stream whose length
    // it does not know — the same constraint that makes the publisher use a
    // multipart upload. Written concurrently with the read so nothing has to
    // hold 50MB.
    const fixed = new FixedLengthStream(size);
    const writer = fixed.writable.getWriter();
    const chunk = new Uint8Array(1024 * 1024).fill(3);
    const pumped = (async () => {
      let sent = 0;
      while (sent < size) {
        const take = Math.min(chunk.byteLength, size - sent);
        await writer.write(chunk.subarray(0, take));
        sent += take;
      }
      await writer.close();
    })();

    await env.ARTIFACTS.put(`proofs/${key}`, fixed.readable);
    await pumped;
    expect((await env.ARTIFACTS.head(`proofs/${key}`))!.size).toBeGreaterThan(MAX_RECORDING_BYTES);

    // Nothing this Worker writes can be this big, so an object that is could
    // only have been written by some other path — and serving it would make
    // this URL space an unbounded egress.
    const response = await fetchProof(key);
    expect(response.status).toBe(404);
  });
});
