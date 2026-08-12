import { Hono } from "hono";
import type { Env } from "../index";
import { CONTENT_TYPES, MAX_ARTIFACT_BYTES } from "../files/r2";

/**
 * The read side of `files.publish`.
 *
 * WHY THIS EXISTS AT ALL. `files.publish` returns a URL under
 * `ARTIFACTS_BASE_URL`, which is this Worker's own origin — and until this file,
 * no route answered it. Every published artifact resolved to the asset
 * catch-all and 404'd. A tool that reports a success URL the Worker always
 * fails to serve is worse than a tool that refuses: the model believes it
 * delivered evidence, says so in its answer, and a human follows a dead link.
 * Phase 10 forbids that outcome, so the choice was to serve the URL or to
 * withdraw the capability. Serving it is the smaller, more honest change: the
 * bucket, the allowlist, the size cap and the effect-keyed object naming were
 * all built in Phase 09 and were already correct.
 *
 * WHAT MAKES IT SAFE, in the order an attacker would try them:
 *
 *  - AUTHENTICATION is the same one the rest of the app has. This mounts under
 *    `/api`, behind the Cloudflare Access application that fronts the dashboard
 *    and `/api/runs`. There is deliberately no second, weaker auth path here —
 *    a signed-URL scheme would be a new way in, and the artifacts are not more
 *    public than the run they came from.
 *  - The KEY is validated, not merely used. Only `<64 lowercase hex>.<allowed
 *    extension>` is accepted, which is exactly the shape `makeArtifactPublisher`
 *    produces: a SHA-256 effect key plus the extension for an allowlisted
 *    content type. Nothing else reaches R2, so `..`, a leading `/`, a URL, a
 *    prefix listing and every other key-shaped probe are refused by pattern
 *    before a bucket call happens.
 *  - The CONTENT TYPE is re-derived from the validated extension rather than
 *    read back from object metadata. The metadata is ours and is already
 *    allowlisted, so this is belt and braces — but it means a future writer
 *    that stored a hostile `contentType` cannot make this route echo it.
 *  - The RESPONSE is inert. `attachment` disposition so nothing renders in the
 *    app's own origin, `nosniff` so a `.txt` cannot be re-interpreted as
 *    script, and a `sandbox`/`default-src 'none'` CSP for the browsers that
 *    honour it on downloads. This is why `image/svg+xml` is absent from the
 *    publisher's allowlist: an SVG is a script container.
 *  - The SIZE is bounded twice. The publisher caps writes at
 *    MAX_ARTIFACT_BYTES; this refuses to serve an object larger than that, so a
 *    bucket object written by some future path cannot become an unbounded
 *    egress through the agent's URL space.
 *
 * The body is streamed rather than buffered: a 5MB `arrayBuffer()` in a Worker
 * is a needless memory spike when `R2ObjectBody.body` is already a
 * ReadableStream.
 */
export const artifactsApi = new Hono<{ Bindings: Env }>();

/** The exact shape `makeArtifactPublisher` writes: sha256 hex + allowed extension. */
const ARTIFACT_KEY = new RegExp(
  `^[0-9a-f]{64}\\.(?:${Object.values(CONTENT_TYPES).join("|")})$`,
);

/** Extension → content type, inverted from the publisher's single allowlist. */
const TYPE_FOR_EXTENSION: ReadonlyMap<string, string> = new Map(
  Object.entries(CONTENT_TYPES).map(([type, extension]) => [extension, type]),
);

export function isArtifactKey(key: string): boolean {
  return ARTIFACT_KEY.test(key);
}

/**
 * Does this R2 result carry a stream?
 *
 * `R2ObjectBody extends R2Object`, so a bare `"body" in object` check does not
 * narrow the union — it widens `body` to `unknown`. An explicit guard keeps
 * both call sites typed.
 */
function hasBody(object: R2Object | R2ObjectBody): object is R2ObjectBody {
  return "body" in object;
}

/**
 * One 404 for every failure. A malformed key, an unknown key, an oversized
 * object and a deleted object are all indistinguishable from outside, on
 * purpose: distinguishing them turns this route into an oracle that confirms
 * which 64-character strings name a real artifact.
 */
function missing(): Response {
  return new Response(JSON.stringify({ code: "not_found", message: "no such artifact" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

// GET and HEAD together. Registering only GET would leave HEAD falling through
// to the asset catch-all in src/index.ts, which answers a different thing
// entirely — a route whose HEAD and GET disagree is a route somebody will
// eventually probe for exactly that discrepancy.
artifactsApi.on(["GET", "HEAD"], "/artifacts/:key", async (c) => {
  const key = c.req.param("key");
  if (!isArtifactKey(key)) return missing();

  // `head()` for HEAD, so there is no stream to fetch and none to release. A
  // `get()` whose body we then cancel would work, but it asks R2 for bytes we
  // have already decided not to send.
  const isHead = c.req.method === "HEAD";
  const object = isHead ? await c.env.ARTIFACTS.head(key) : await c.env.ARTIFACTS.get(key);
  if (object === null) return missing();

  /** Refuse, releasing the body we are not going to send. */
  const discard = async (): Promise<Response> => {
    // An R2ObjectBody holds a ReadableStream. Returning without cancelling it
    // leaks the stream for the lifetime of the request. A HEAD's R2Object has
    // no body to release.
    if (hasBody(object)) await object.body.cancel().catch(() => {});
    return missing();
  };

  if (object.size > MAX_ARTIFACT_BYTES) {
    // Nothing this Worker writes can be this big. Serving it anyway would make
    // the agent's URL space an unbounded egress for whatever else touches the
    // bucket later.
    return discard();
  }

  const extension = key.slice(key.lastIndexOf(".") + 1);
  const contentType = TYPE_FOR_EXTENSION.get(extension);
  if (contentType === undefined) return discard();

  // The stored filename is a display name only, and it was validated on the way
  // in. It is re-validated here because a `"` in a filename would break out of
  // the quoted disposition parameter, and the object could have been written by
  // an older, laxer version of the publisher.
  const stored = object.customMetadata?.filename;
  const filename =
    typeof stored === "string" && /^[\w][\w .()-]{0,199}$/.test(stored)
      ? stored
      : `artifact.${extension}`;

  // HEAD reports identical headers with no body.
  return new Response(hasBody(object) ? object.body : null, {
    headers: {
      "content-type": contentType,
      "content-length": String(object.size),
      "content-disposition": `attachment; filename="${filename}"`,
      // Never rendered in this origin, never sniffed, never a referrer leak.
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "referrer-policy": "no-referrer",
      // Content-addressed by SHA-256, so it is immutable — but PRIVATE, because
      // it sits behind Access and must never enter a shared cache.
      "cache-control": "private, max-age=31536000, immutable",
      etag: object.httpEtag,
    },
  });
});
