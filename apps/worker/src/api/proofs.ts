import { Hono } from "hono";
import type { Env } from "../index";
import { isInternalKey } from "../sandbox/diff";
import { MAX_RECORDING_BYTES, PROOF_KEY_PREFIX, RECORDING_LABEL } from "../sandbox/record";

/**
 * The read side of a proof recording, and THE ONLY UNAUTHENTICATED SURFACE THIS
 * WORKER HAS.
 *
 * WHY IT CANNOT LIVE UNDER `/api`. Every other route in `src/index.ts` sits
 * behind the Cloudflare Access application that fronts the dashboard, and
 * `src/api/artifacts.ts` says in as many words that inheriting that gate is what
 * makes it safe. A recording cannot inherit it. The URL is pasted into a Slack
 * thread; Slack's unfurler fetches it with no Access token and no cookie jar, so
 * a gated URL answers the unfurler with a login redirect and answers the
 * customer-facing engineer with one too. A proof nobody outside the Access
 * roster can watch is not a proof. So this route is mounted at the TOP LEVEL and
 * a `/proofs/*` bypass policy is expected on the Access application, the same
 * shape `/slack/events` already has.
 *
 * WHAT REPLACES THE GATE: THE KEY IS THE SECRET. `startRecording` derives the
 * object key as SHA-256 of an id containing a v4 UUID, so a key is 256 bits of
 * hex that nobody can enumerate, guess, or derive from anything the agent
 * reports. That is the entire access-control story, and everything below exists
 * to make sure it is not undermined:
 *
 *  - the KEY SHAPE is validated before any bucket call. Only `<64 lowercase
 *    hex>.mp4` is accepted, which is exactly what the publisher writes; the
 *    stored key is `proofs/` plus that, so `..`, a leading `/`, a prefix listing
 *    and every other key-shaped probe is refused by pattern rather than by R2
 *    happening to miss.
 *  - `_internal/` is refused POSITIVELY AND FIRST. The same bucket holds Phase
 *    18's captured diffs — the working contents of a private monorepo. The shape
 *    check above already excludes them, but only as a side effect, and this
 *    route is the one place in the Worker where "behind Access" is not the
 *    backstop. A refusal that depends on a regex nobody may loosen is not a
 *    refusal; this one is stated, tested, and first.
 *  - the CONTENT TYPE is re-derived from the validated extension, never read
 *    back from metadata, so a future writer that stored `text/html` cannot make
 *    this route echo it.
 *  - the SIZE is bounded twice, here as well as at capture, so an object written
 *    by some other path cannot turn a public URL into unbounded egress.
 *  - every failure is ONE INDISTINGUISHABLE 404.
 *
 * WHERE IT DELIBERATELY INVERTS `src/api/artifacts.ts`, and why that is not a
 * weakening. `inline` instead of `attachment`, because the file has to play in a
 * tab and unfurl in Slack — and it is safe here for the reason the artifact rule
 * exists in the first place: that rule is about STORED CONTENT RENDERED IN THE
 * APP'S ORIGIN, and the only thing this route can ever return is `video/mp4`,
 * pinned as a literal, with `nosniff` on top. There is no allowlist to loosen
 * and no `.svg` case to get wrong. `public` caching instead of `private`,
 * because the object is by design fetchable by an unauthenticated Slack CDN;
 * marking it private would ask shared caches not to keep something we are
 * actively asking a shared cache to keep, and the key is what protects it.
 */
export const proofsApi = new Hono<{ Bindings: Env }>();

/**
 * The exact shape `startRecording` publishes: a SHA-256 in lowercase hex plus
 * the one extension this route can serve. Anchored, one dot, no slash.
 */
const PROOF_KEY = /^[0-9a-f]{64}\.mp4$/;

/** The one type this route can ever produce, as a literal. */
const PROOF_CONTENT_TYPE = "video/mp4";

export function isProofKey(key: string): boolean {
  return PROOF_KEY.test(key);
}

/**
 * Does this R2 result carry a stream? `R2ObjectBody extends R2Object`, so a
 * bare `"body" in object` check widens `body` to `unknown` instead of narrowing
 * the union.
 */
function hasBody(object: R2Object | R2ObjectBody): object is R2ObjectBody {
  return "body" in object;
}

/**
 * One 404 for every failure, with the same body every time.
 *
 * On an authenticated route this is good hygiene. Here it is the control
 * itself: the key is the only secret, so a response that distinguished
 * "malformed" from "no such object" would turn this route into an oracle that
 * confirms which 64-character strings name a real recording.
 */
function missing(): Response {
  return new Response(JSON.stringify({ code: "not_found", message: "no such recording" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

// GET and HEAD together. Registering only GET would leave HEAD falling through
// to the asset catch-all in src/index.ts, which — with
// `not_found_handling: "single-page-application"` — answers index.html with a
// 200. A route whose HEAD and GET disagree is a route somebody will probe for
// exactly that discrepancy, and Slack's unfurler sends HEAD.
proofsApi.on(["GET", "HEAD"], "/proofs/:key", async (c) => {
  const key = c.req.param("key");

  // THE INTERNAL NAMESPACE IS NEVER SERVED, checked first and on its own.
  //
  // Hono gives back a DECODED param, which is what makes this reachable at all:
  // a raw `_internal/diff/...` path has too many segments to match `:key`, so
  // the probe that gets here is the percent-encoded one. Same reasoning, same
  // placement, as in src/api/artifacts.ts — except that here there is no Access
  // application behind the refusal.
  if (isInternalKey(key)) return missing();

  if (!isProofKey(key)) return missing();

  // `head()` for HEAD, so there is no stream to fetch and none to release.
  const isHead = c.req.method === "HEAD";
  const storedKey = `${PROOF_KEY_PREFIX}${key}`;
  const object = isHead
    ? await c.env.ARTIFACTS.head(storedKey)
    : await c.env.ARTIFACTS.get(storedKey);
  if (object === null) return missing();

  /** Refuse, releasing the body we are not going to send. */
  const discard = async (): Promise<Response> => {
    // An R2ObjectBody holds a ReadableStream; returning without cancelling it
    // leaks the stream for the lifetime of the request.
    if (hasBody(object)) await object.body.cancel().catch(() => {});
    return missing();
  };

  // Bounded twice: the publisher's metering valve refuses to WRITE past this,
  // and this refuses to SERVE past it. Nothing this Worker writes can be bigger,
  // so an object that is could only have come from somewhere else — and this URL
  // space is public.
  if (object.size > MAX_RECORDING_BYTES) return discard();

  // The label was narrowed to `[a-z0-9-]` when it was stored, and it is
  // re-checked here rather than trusted across the gap: a `"` would break out of
  // the quoted disposition parameter, and the object could have been written by
  // an older, laxer version of the publisher.
  const stored = object.customMetadata?.label;
  const filename = typeof stored === "string" && RECORDING_LABEL.test(stored) ? stored : "proof";

  // NO `accept-ranges`, DELIBERATELY, AND THIS IS THE FOLLOW-UP IF SEEKING
  // MATTERS. `R2Bucket.get` takes a `range` option, so serving 206s is a small
  // change — but neither thing this route exists for needs one: Slack's unfurler
  // fetches the whole object, and a `<video>` element plays a 200 from the start
  // perfectly well. What ranges buy is scrubbing to the middle of a long
  // recording without downloading the front of it. Implement it when somebody
  // wants that, with an `if-range`/`etag` check, rather than shipping a partial
  // implementation now that advertises a capability the handler does not have.
  return new Response(hasBody(object) ? object.body : null, {
    headers: {
      // Re-derived from the validated extension, never echoed from metadata.
      "content-type": PROOF_CONTENT_TYPE,
      "content-length": String(object.size),
      // `inline`, not `attachment`: it must PLAY in a browser tab and unfurl in
      // Slack. Safe because the type above is a literal and cannot be anything
      // scriptable.
      "content-disposition": `inline; filename="${filename}.mp4"`,
      "x-content-type-options": "nosniff",
      // Content is fixed for the life of the key, and the key is the secret —
      // so `public`, unlike an artifact, which is private because Access is what
      // protects it.
      "cache-control": "public, max-age=31536000, immutable",
      etag: object.httpEtag,
    },
  });
});

/**
 * Anything else under `/proofs` is the SAME 404, not the dashboard.
 *
 * `not_found_handling: "single-page-application"` makes the asset worker answer
 * any unmatched path with index.html and a 200, so without these two lines
 * `/proofs/a/b` and `/proofs/` return markup with a success status — which is
 * the exact failure `src/index.ts` documents for `/api/*`. Registered after the
 * route above, so the single-segment case still wins, and answering with
 * `missing()` keeps the one-body rule intact.
 */
proofsApi.all("/proofs", () => missing());
proofsApi.all("/proofs/*", () => missing());
