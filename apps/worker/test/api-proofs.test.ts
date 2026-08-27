import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { isProofKey } from "../src/api/proofs";
import { INTERNAL_KEY_PREFIX, isInternalKey } from "../src/sandbox/diff";
import { MAX_RECORDING_BYTES } from "../src/sandbox/record";

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
  options?: { bytes?: Uint8Array; label?: string; contentType?: string }
): Promise<string> {
  await env.ARTIFACTS.put(
    `proofs/${key}`,
    (options?.bytes ?? new Uint8Array([1, 2, 3, 4])) as BufferSource,
    {
      httpMetadata: { contentType: options?.contentType ?? "video/mp4" },
      ...(options?.label === undefined
        ? {}
        : { customMetadata: { label: options.label } }),
    }
  );
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
    //
    // THE TWO REFUSALS ARE PINNED SEPARATELY, on purpose. Every probe below is
    // ALSO rejected by `isProofKey` (a leading `_` is not hex), so asserting
    // only the 404 would leave this case green with the `isInternalKey` guard
    // deleted — vacuous with respect to the property it claims to protect. The
    // positive refusal still earns its place: it is what keeps the private
    // namespace unreachable if the key pattern is ever loosened, which is
    // exactly the change a future format (webm, a thumbnail) would make.
    for (const key of [
      `${INTERNAL_KEY_PREFIX}diff/${hex("a")}.patch`,
      `${INTERNAL_KEY_PREFIX}${hex("a")}.mp4`,
      INTERNAL_KEY_PREFIX,
    ]) {
      const probe = encodeURIComponent(key);
      // What the handler receives is the DECODED param, and it is genuinely
      // internal-shaped — so the first guard is the one that fires.
      expect(isInternalKey(decodeURIComponent(probe))).toBe(true);
      expect(isProofKey(decodeURIComponent(probe))).toBe(false);
      expect((await fetchProof(probe)).status).toBe(404);
    }
  });

  it("never serves an artifacts-shaped key, even one that really exists", async () => {
    // The two key spaces share a bucket. A `.png` under the artifacts root is
    // real and readable — through the AUTHENTICATED route only.
    await env.ARTIFACTS.put(
      `${hex("d")}.png`,
      new Uint8Array([9, 9]) as BufferSource
    );

    const response = await fetchProof(`${hex("d")}.png`);
    expect(response.status).toBe(404);
  });
});

describe("a published recording plays", () => {
  it("serves the bytes as inline video/mp4", async () => {
    const key = await seed(`${hex("b")}.mp4`, {
      bytes: new Uint8Array([1, 2, 3, 4]),
      label: "checkout",
    });
    const response = await fetchProof(key);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4])
    );
    // `inline`, not `attachment`: the whole point is that it plays in a browser
    // tab and unfurls in Slack. This is the one place this Worker deliberately
    // does the opposite of `src/api/artifacts.ts`.
    expect(response.headers.get("content-disposition")).toBe(
      'inline; filename="checkout.mp4"'
    );
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
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable"
    );
  });

  it("falls back to a safe filename when the stored label is missing or hostile", async () => {
    const plain = await seed(`${hex("f")}.mp4`);
    expect((await fetchProof(plain)).headers.get("content-disposition")).toBe(
      'inline; filename="proof.mp4"'
    );

    // A `"` in the label would break out of the quoted disposition parameter.
    const hostile = await seed(`${hex("1")}.mp4`, { label: 'x" ; attachment' });
    expect((await fetchProof(hostile)).headers.get("content-disposition")).toBe(
      'inline; filename="proof.mp4"'
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
    expect(head.headers.get("content-type")).toBe(
      body.headers.get("content-type")
    );
    expect(head.headers.get("content-length")).toBe(
      body.headers.get("content-length")
    );
    expect(head.headers.get("content-disposition")).toBe(
      body.headers.get("content-disposition")
    );
    expect(await head.text()).toBe("");
  });

  it("404s a HEAD for a missing recording rather than serving the dashboard", async () => {
    const response = await fetchProof(`${hex("3")}.mp4`, { method: "HEAD" });
    expect(response.status).toBe(404);
  });
});

describe("Range, because Safari and iOS will not start an mp4 without it", () => {
  /**
   * The original handler argued that ranges were only for scrubbing and could
   * wait. True of Chrome and Firefox; false of the audience this URL actually
   * has. WebKit's media stack probes with a range request and treats a
   * 200-only origin as unplayable, so an engineer opening the Slack thread on a
   * Mac or a phone gets a dead player instead of the proof — and Slack's own
   * inline player is the same family. What must NOT change on the way in is any
   * refusal: shape first, `_internal/` first of all, one indistinguishable 404,
   * the ceiling, `inline`, `nosniff`.
   */
  const BYTES = new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

  it("advertises accept-ranges on the plain 200, which is where WebKit looks", async () => {
    const key = await seed(`${hex("ab")}.mp4`, { bytes: BYTES });
    const response = await fetchProof(key);

    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBeNull();
  });

  it("answers a range with 206, the right bytes, and a content-range naming the full size", async () => {
    const key = await seed(`${hex("ac")}.mp4`, {
      bytes: BYTES,
      label: "checkout",
    });
    const response = await fetchProof(key, { headers: { range: "bytes=2-5" } });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response.headers.get("content-length")).toBe("4");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      BYTES.slice(2, 6)
    );
    // Every refusal-side property survives a partial response.
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-disposition")).toBe(
      'inline; filename="checkout.mp4"'
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves an open-ended range to the end of the object", async () => {
    const key = await seed(`${hex("ad")}.mp4`, { bytes: BYTES });
    const response = await fetchProof(key, { headers: { range: "bytes=7-" } });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      BYTES.slice(7)
    );
  });

  it("serves a suffix range, which is how a player reads an mp4's trailing atoms", async () => {
    const key = await seed(`${hex("ae")}.mp4`, { bytes: BYTES });
    const response = await fetchProof(key, { headers: { range: "bytes=-3" } });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      BYTES.slice(7)
    );
  });

  it("clamps an end past the last byte instead of refusing it", async () => {
    const key = await seed(`${hex("af")}.mp4`, { bytes: BYTES });
    const response = await fetchProof(key, {
      headers: { range: "bytes=8-9999" },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 8-9/10");
  });

  it("answers HEAD with a range the same way, and with no body", async () => {
    const key = await seed(`${hex("ba")}.mp4`, { bytes: BYTES });
    const response = await fetchProof(key, {
      method: "HEAD",
      headers: { range: "bytes=2-5" },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await response.text()).toBe("");
  });

  it("answers an unsatisfiable range with the SAME 404, not a 416", async () => {
    const key = await seed(`${hex("bc")}.mp4`, { bytes: BYTES });

    for (const range of ["bytes=10-20", "bytes=99-", "bytes=-0"]) {
      const response = await fetchProof(key, { headers: { range } });
      // 416 carries the object's true size and can only be produced by a REAL
      // key, which would turn this route back into the oracle that the single
      // 404 exists to prevent.
      expect(response.status).toBe(404);
      expect(response.headers.get("content-range")).toBeNull();
      expect(await response.text()).toBe(
        await (await fetchProof("nonsense")).text()
      );
    }
  });

  it("ignores a range it cannot parse and serves the whole object", async () => {
    const key = await seed(`${hex("bd")}.mp4`, { bytes: BYTES });

    // RFC 9110: an unparseable Range is ignored, not refused. Multi-range and
    // non-`bytes` units land here too.
    for (const range of [
      "bytes=5-3",
      "items=0-1",
      "bytes=0-1,4-5",
      "garbage",
    ]) {
      const response = await fetchProof(key, { headers: { range } });
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    }
  });

  it("still refuses a bad key, the internal namespace and an unknown object under a Range", async () => {
    // A Range header must not become a way around the checks that run first.
    for (const key of [
      "nonsense",
      encodeURIComponent(`${INTERNAL_KEY_PREFIX}${hex("a")}.mp4`),
      `${hex("f")}.png`,
      `${hex("9")}.mp4`,
    ]) {
      const response = await fetchProof(key, {
        headers: { range: "bytes=0-1" },
      });
      expect(response.status).toBe(404);
    }
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

  it("404s a traversal that actually reaches the handler", async () => {
    // ENCODED SLASHES, because those are the traversal shapes that survive.
    // A bare `/proofs/..` is resolved to `/` by the URL parser before any
    // router sees it — it is a request for the dashboard root, and asserting
    // anything about its response would be asserting properties of the SPA. An
    // encoded slash is NOT a path separator, so the segment stays one segment,
    // matches `:key`, and Hono hands the handler the decoded `../../secrets.mp4`
    // — which is exactly the string the key pattern has to reject.
    for (const probe of [
      "..%2F..%2Fsecrets.mp4",
      `..%2F${hex("a")}.mp4`,
      `%2E%2E%2F${INTERNAL_KEY_PREFIX}${hex("a")}.mp4`,
    ]) {
      expect(isProofKey(decodeURIComponent(probe))).toBe(false);
      expect((await fetchProof(probe)).status).toBe(404);
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

  it("names no bucket, prefix or account in its refusal, and states its own type", async () => {
    const response = await fetchProof("nonsense");
    const body = await response.text();
    expect(body).not.toContain("firefighter-artifacts");
    expect(body).not.toContain("proofs/");
    expect(body).not.toContain("R2");
    // The refusal is as inert as the success path — this is the one surface
    // here that no Access application stands in front of.
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
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

  it("refuses an object above the ceiling independently of the publisher", {
    timeout: 60_000,
  }, async () => {
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
    expect((await env.ARTIFACTS.head(`proofs/${key}`))!.size).toBeGreaterThan(
      MAX_RECORDING_BYTES
    );

    // Nothing this Worker writes can be this big, so an object that is could
    // only have been written by some other path — and serving it would make
    // this URL space an unbounded egress.
    const response = await fetchProof(key);
    expect(response.status).toBe(404);
  });
});
