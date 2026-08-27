import { CapabilityError } from "../gateways/errors";
import { sha256Bytes } from "../gateways/hash";
import type { Env } from "../index";

/**
 * The seam between the sandbox and Phase 20's pull request.
 *
 * WHY A REFERENCE AND NOT THE TEXT. Phase 20 builds a git commit from these
 * bytes, so they have to be byte-exact. Two things make "hand the model the
 * diff" unworkable rather than merely wasteful:
 *
 *  - `toSafeJson` caps a capability result at `maxResultChars` (24_000), and a
 *    real fix's diff plus context routinely exceeds that. A patch cut at 24k
 *    characters is not a smaller patch, it is a broken one — `git apply` fails
 *    on it at PR time, several agent turns after the mistake was made.
 *  - Anything that passes through the model's context can come back subtly
 *    altered: a re-indented hunk, a normalised line ending, a dropped trailing
 *    newline. Each of those is invisible in a preview and fatal to a patch.
 *
 * So the full text goes to R2 and the model gets a bounded preview plus an
 * opaque ref. `github.openPR({ diffRef })` reads it back here, Worker-side; the
 * bytes never enter a model-visible value.
 */

export type DiffResult = {
  preview: string;
  truncated: boolean;
  filesChanged: number;
  insertions: number;
  deletions: number;
  diffRef: string | null;
};

/**
 * The one namespace in the ARTIFACTS bucket the public route refuses to serve.
 *
 * It CANNOT collide with a published artifact: `makeArtifactPublisher` writes
 * `<64 lowercase hex>.<allowlisted extension>` at the bucket root, and
 * `ARTIFACT_KEY` in src/api/artifacts.ts accepts exactly that shape — anchored,
 * one dot, no slash, first character in `[0-9a-f]`. A leading `_` is outside
 * that alphabet, so no publish can ever land in here and no key in here can
 * ever match the public pattern. Reserving the whole `_internal/` space rather
 * than `_internal/diff/` alone means Phase 19 and 20 get somewhere private to
 * write without touching the route's guard again.
 */
export const INTERNAL_KEY_PREFIX = "_internal/";

const DIFF_KEY_PREFIX = `${INTERNAL_KEY_PREFIX}diff/`;

/**
 * A ref is MODEL-VISIBLE — it comes back in `DiffResult` and the model hands it
 * to Phase 20 — so it is validated on the way in rather than pasted into a key.
 * Without this, `readDiff("../<hex>.csv")` would read a published artifact, and
 * a model that guessed a hash could read another run's work.
 */
const DIFF_REF = /^diff_([0-9a-f]{64})$/;

/**
 * One mebibyte, on the encoded bytes.
 *
 * WHY REFUSE RATHER THAN TRUNCATE. A patch missing its tail does not apply; it
 * fails in Phase 20 when the PR is opened, which is far from the run that
 * produced it and expensive to diagnose. Refusing here is a fact the model can
 * still act on ("I changed too much — revert the generated files and diff
 * again").
 *
 * WHY THIS NUMBER. A reviewable fix is kilobytes. A diff past a megabyte is not
 * a large fix, it is a mistake with a signature: a lockfile regenerated, a build
 * directory that escaped .gitignore, `node_modules` staged by `git add -A`. No
 * human would review the resulting PR, so accepting it buys nothing. It is also
 * comfortably under R2's limits, so the ceiling is a product decision rather
 * than a platform one.
 */
export const MAX_DIFF_BYTES = 1_048_576;

/**
 * A third of `maxResultChars`, because the preview is one FIELD of a result
 * that also carries the ref, the stats, and whatever else the model's own code
 * puts in the same return value. Sizing it at the cap would mean a diff that is
 * technically previewable still blows the result budget.
 */
export const DIFF_PREVIEW_CHARS = 8_000;

/** Said plainly, because "I changed nothing" is a fact the model must act on. */
const EMPTY_PREVIEW =
  "No changes: the working tree is identical to HEAD. Nothing was captured, so there is nothing to open a pull request from.";

export function isInternalKey(key: string): boolean {
  return key.startsWith(INTERNAL_KEY_PREFIX);
}

/** The object key a ref names, or null when the ref is not one of ours. */
export function internalDiffKey(diffRef: string): string | null {
  const match = DIFF_REF.exec(diffRef);
  return match === null ? null : `${DIFF_KEY_PREFIX}${match[1]}.patch`;
}

type DiffStats = {
  filesChanged: number;
  insertions: number;
  deletions: number;
};

/**
 * Counted from the diff itself rather than from `--numstat`, so one command
 * (`git add -A -N && git diff`) produces both the text and its summary and the
 * two cannot disagree.
 *
 * The `@@` state matters. Counting by prefix alone — "a line starting with
 * `+++` is a file header" — undercounts every added line whose CONTENT starts
 * with `++`, which is not exotic: TOML front matter delimiters, Markdown rules,
 * and diffs-of-diffs all produce them. File headers only ever appear before the
 * first hunk of a file, so position separates them exactly.
 */
function parseStats(raw: string): DiffStats {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  let inHunk = false;

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      filesChanged += 1;
      inHunk = false;
    } else if (line.startsWith("@@")) {
      inHunk = true;
    } else if (inHunk) {
      if (line.startsWith("+")) insertions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
  }

  return { filesChanged, insertions, deletions };
}

/**
 * Cut on a line boundary and say so.
 *
 * The marker names the full length and the ref's existence because the model's
 * next decision depends on both: a preview that merely stops looks like a diff
 * that ended, and the model would report a partial change as the whole one.
 */
function buildPreview(raw: string): { preview: string; truncated: boolean } {
  if (raw.length <= DIFF_PREVIEW_CHARS)
    return { preview: raw, truncated: false };

  const head = raw.slice(0, DIFF_PREVIEW_CHARS);
  // Half a hunk line reads as corruption; back up to the last newline unless
  // that would throw away most of the preview.
  const lastNewline = head.lastIndexOf("\n");
  const body =
    lastNewline > DIFF_PREVIEW_CHARS / 2 ? head.slice(0, lastNewline) : head;

  return {
    truncated: true,
    preview: `${body}\n… preview truncated at ${body.length} of ${raw.length} characters. The full diff is stored intact and is what the pull request will use; do not reconstruct it from this preview.`,
  };
}

/**
 * Store the full diff and return what is safe to show.
 *
 * Content-addressed, like every other object in this bucket: capturing the same
 * diff twice writes the same object and returns the same ref, so a retried
 * `diff()` cannot scatter near-identical patches for Phase 20 to choose between.
 *
 * `baseSha` is `git rev-parse HEAD` at the moment the diff was cut. Phase 20
 * fetches each touched file from GitHub at that commit, applies the patch, and
 * parents the new git commit on it — so the sha has to identify the exact tree
 * the diff assumes, not merely accompany it loosely.
 *
 * CAVEAT: because the object is keyed by the patch bytes alone, two runs that
 * produce byte-identical diffs from two different base shas collide on one
 * object, and whichever `put` lands second overwrites the first one's
 * `customMetadata` — the earlier run's ref now reads back the later run's
 * `baseSha`. This is acceptable rather than a bug: identical bytes applying
 * cleanly at either base is exactly what Phase 20's byte-exact context check
 * verifies at apply time, so there is no base sha for which those bytes would
 * silently mis-apply.
 */
export async function captureDiff(
  env: Env,
  runId: string,
  raw: string,
  baseSha: string
): Promise<DiffResult> {
  if (raw.trim().length === 0) {
    // Not an error, and deliberately not a ref to an empty object: Phase 20 must
    // be unable to open a pull request that changes nothing.
    return {
      preview: EMPTY_PREVIEW,
      truncated: false,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      diffRef: null,
    };
  }

  const bytes = new TextEncoder().encode(raw);
  if (bytes.byteLength > MAX_DIFF_BYTES) {
    throw new CapabilityError(
      "output_too_large",
      `the diff is ${bytes.byteLength} bytes; the cap is ${MAX_DIFF_BYTES}. It was not stored, because a truncated patch cannot be applied. Revert generated or vendored files and diff again.`
    );
  }

  const hash = await sha256Bytes(bytes);
  await env.ARTIFACTS.put(
    `${DIFF_KEY_PREFIX}${hash}.patch`,
    bytes as BufferSource,
    {
      httpMetadata: { contentType: "text/x-diff" },
      // The run and the base sha are metadata, not part of the key: the key is
      // the content, and two runs producing identical bytes are the same object
      // (see the CAVEAT on `captureDiff` above for what that means for
      // `baseSha` specifically). `runId` is here for the sweeper and for
      // after-the-fact attribution; neither field is ever served directly.
      customMetadata: { runId, baseSha, capturedAt: new Date().toISOString() },
    }
  );

  const { preview, truncated } = buildPreview(raw);
  return { preview, truncated, ...parseStats(raw), diffRef: `diff_${hash}` };
}

/**
 * Phase 20's reader, and the only one. Not reachable from any model-facing
 * capability: nothing in `src/codemode/` calls it, and the ref it takes is
 * validated into a key rather than used as one.
 *
 * `text()` decodes the stored UTF-8 back to the exact string that was captured,
 * which is the whole point — trailing newlines, CRLFs and non-ASCII included.
 */
export async function readDiff(
  env: Env,
  diffRef: string
): Promise<string | null> {
  const key = internalDiffKey(diffRef);
  if (key === null) return null;

  const object = await env.ARTIFACTS.get(key);
  return object === null ? null : await object.text();
}

/**
 * Phase 20's other reader: the patch text alongside the base sha it was cut
 * against, so the commit it builds can be parented on the exact tree the diff
 * assumes. Validated through the same `internalDiffKey` path as `readDiff` —
 * a ref is model-visible, so it stays validated-into-a-key here too, never
 * pasted into one.
 */
export async function readDiffWithBase(
  env: Env,
  diffRef: string
): Promise<{ patch: string; baseSha: string } | null> {
  const key = internalDiffKey(diffRef);
  if (key === null) return null;

  const object = await env.ARTIFACTS.get(key);
  if (object === null) return null;

  const baseSha = object.customMetadata?.baseSha;
  if (baseSha === undefined) return null;

  return { patch: await object.text(), baseSha };
}
