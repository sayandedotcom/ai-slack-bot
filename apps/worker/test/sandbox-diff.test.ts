import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/index";
import {
  captureDiff,
  DIFF_PREVIEW_CHARS,
  INTERNAL_KEY_PREFIX,
  internalDiffKey,
  isInternalKey,
  MAX_DIFF_BYTES,
  readDiff,
  readDiffWithBase,
} from "../src/sandbox/diff";
import { isArtifactKey } from "../src/api/artifacts";
import { makeArtifactPublisher } from "../src/files/r2";

/**
 * THE DIFF TRAVELS WORKER→WORKER, NEVER THROUGH THE MODEL.
 *
 * Phase 20 turns these bytes into a git commit, so they have to be byte-exact:
 * anything that round-trips through the model's context can come back subtly
 * altered, and `maxResultChars: 24_000` would truncate a real fix's diff into a
 * patch that fails to apply — at PR time, where the failure is expensive and
 * confusing. So `diff()` hands the model a bounded preview plus an opaque ref,
 * and these cases hold both halves of that bargain honest.
 */

const worker = env as unknown as Env;

const run = () => `run_${crypto.randomUUID()}`;

/** A stand-in `git rev-parse HEAD` value — 40 lowercase hex characters. */
const BASE_SHA = "abc123def456abc123def456abc123def456abc";
const OTHER_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

/** How many objects currently sit under the internal namespace. */
async function internalObjectCount(): Promise<number> {
  const listed = await env.ARTIFACTS.list({ prefix: INTERNAL_KEY_PREFIX, limit: 1000 });
  return listed.objects.length;
}

/**
 * Four files, one of each kind Phase 20 has to survive: modified, added,
 * deleted, and — the case a naive parser gets wrong — a TOML file whose own
 * content lines begin with `+++` and `---`.
 *
 * Counting by prefix alone (`startsWith("+++")` means "file header") silently
 * loses those three insertions and three deletions, and the model would be told
 * it changed less than it did.
 */
const REALISTIC_DIFF = `diff --git a/apps/web/src/lib/retry.ts b/apps/web/src/lib/retry.ts
index 1a2b3c4..5d6e7f8 100644
--- a/apps/web/src/lib/retry.ts
+++ b/apps/web/src/lib/retry.ts
@@ -12,7 +12,9 @@ export async function retry(fn) {
   for (let i = 0; i < 3; i++) {
     try {
       return await fn();
-    } catch (err) {
+    } catch (err) {
+      if (i === 2) throw err;
+      await sleep(100);
     }
   }
 }
diff --git a/apps/web/src/lib/sleep.ts b/apps/web/src/lib/sleep.ts
new file mode 100644
index 0000000..9abcdef
--- /dev/null
+++ b/apps/web/src/lib/sleep.ts
@@ -0,0 +1,3 @@
+export function sleep(ms: number): Promise<void> {
+  return new Promise((resolve) => setTimeout(resolve, ms));
+}
diff --git a/apps/web/src/lib/legacy-retry.ts b/apps/web/src/lib/legacy-retry.ts
deleted file mode 100644
index abc1234..0000000
--- a/apps/web/src/lib/legacy-retry.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const legacyRetry = () => {};
-
diff --git a/docs/config.toml b/docs/config.toml
index 1111111..2222222 100644
--- a/docs/config.toml
+++ b/docs/config.toml
@@ -1,3 +1,3 @@
-+++
-title = "old"
----
++++
+title = "new"
+---
`;

const longDiff = (lines: number): string => {
  const body = Array.from({ length: lines }, (_, i) => `+  const line${i} = ${i};`).join("\n");
  return `diff --git a/apps/web/src/big.ts b/apps/web/src/big.ts
index 1111111..2222222 100644
--- a/apps/web/src/big.ts
+++ b/apps/web/src/big.ts
@@ -1,0 +1,${lines} @@
${body}
`;
};

describe("captureDiff stores the full text and previews it", () => {
  it("writes the whole diff to R2 and hands back a ref, not the bytes", async () => {
    const result = await captureDiff(worker, run(), REALISTIC_DIFF, BASE_SHA);

    expect(result.diffRef).not.toBeNull();
    expect(await readDiff(worker, result.diffRef!)).toBe(REALISTIC_DIFF);
    // A short diff needs no marker and must say so.
    expect(result.truncated).toBe(false);
    expect(result.preview).toBe(REALISTIC_DIFF);
  });

  it("bounds the preview well inside maxResultChars and says it truncated", async () => {
    const raw = longDiff(4000);
    expect(raw.length).toBeGreaterThan(24_000);

    const result = await captureDiff(worker, run(), raw, BASE_SHA);

    expect(result.truncated).toBe(true);
    // Well inside `PRODUCTION_LIMITS.maxResultChars`, because the preview is
    // only one field of a result that also carries the ref and the stats.
    expect(result.preview.length).toBeLessThan(24_000);
    expect(result.preview.length).toBeLessThan(DIFF_PREVIEW_CHARS + 500);
    // Visible, not silent: a reader must be able to tell this is not the whole
    // patch, and the model must know the full text still exists.
    expect(result.preview).toMatch(/truncated/i);
    expect(result.preview).toContain(String(raw.length));
    // The bytes are whole even though the preview is not.
    expect(await readDiff(worker, result.diffRef!)).toBe(raw);
  });

  it("keys by content, so re-capturing the same diff writes one object", async () => {
    const first = await captureDiff(worker, run(), REALISTIC_DIFF, BASE_SHA);
    const before = await internalObjectCount();
    const second = await captureDiff(worker, run(), REALISTIC_DIFF, BASE_SHA);

    expect(second.diffRef).toBe(first.diffRef);
    expect(await internalObjectCount()).toBe(before);
  });
});

describe("the stats are parsed from the diff itself", () => {
  it("counts files, insertions and deletions across added, modified and deleted files", async () => {
    const result = await captureDiff(worker, run(), REALISTIC_DIFF, BASE_SHA);

    expect(result.filesChanged).toBe(4);
    // 3 (modified) + 3 (added) + 0 (deleted) + 3 (toml, incl. the `++++` line)
    expect(result.insertions).toBe(9);
    // 1 (modified) + 0 (added) + 2 (deleted, incl. a blank line) + 3 (toml)
    expect(result.deletions).toBe(6);
  });

  it("never counts a `---`/`+++` file header as a changed line", async () => {
    const oneLine = `diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
+new
`;
    const result = await captureDiff(worker, run(), oneLine, BASE_SHA);
    expect(result).toMatchObject({ filesChanged: 1, insertions: 1, deletions: 1 });
  });
});

describe("an empty diff is a fact, not an error", () => {
  it("returns no ref, says plainly that nothing changed, and writes nothing", async () => {
    const before = await internalObjectCount();
    const result = await captureDiff(worker, run(), "", BASE_SHA);

    expect(result.diffRef).toBeNull();
    expect(result.truncated).toBe(false);
    expect(result).toMatchObject({ filesChanged: 0, insertions: 0, deletions: 0 });
    // The model has to be able to act on "I changed nothing" without parsing
    // an empty string or catching an exception.
    expect(result.preview.toLowerCase()).toContain("no changes");
    expect(await internalObjectCount()).toBe(before);
  });

  it("treats a whitespace-only diff the same way", async () => {
    const result = await captureDiff(worker, run(), "\n \n", BASE_SHA);
    expect(result.diffRef).toBeNull();
    expect(result.preview.toLowerCase()).toContain("no changes");
  });
});

describe("an oversized diff is refused, never truncated", () => {
  const huge = () => `diff --git a/a b/a\n@@ -0,0 +1 @@\n${"+xxxxxxxxxxxxxxxxxxxx\n".repeat(60_000)}`;

  it("refuses with a reason that names the size, the cap and a way forward", async () => {
    const raw = huge();
    expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(MAX_DIFF_BYTES);

    await expect(captureDiff(worker, run(), raw, BASE_SHA)).rejects.toThrow(
      new RegExp(`${MAX_DIFF_BYTES}`),
    );
    await expect(captureDiff(worker, run(), raw, BASE_SHA)).rejects.toThrow(/output_too_large/);
  });

  it("stores nothing rather than half a patch", async () => {
    const before = await internalObjectCount();
    await expect(captureDiff(worker, run(), huge(), BASE_SHA)).rejects.toThrow();
    // A truncated patch is a broken patch. Silently keeping the first megabyte
    // would fail at PR time in Phase 20, where the failure is expensive and
    // confusing.
    expect(await internalObjectCount()).toBe(before);
  });
});

describe("readDiff round-trips exactly what was captured", () => {
  it("preserves trailing newlines and non-ASCII bytes", async () => {
    const raw = `diff --git a/i18n/ja.ts b/i18n/ja.ts
index 1111111..2222222 100644
--- a/i18n/ja.ts
+++ b/i18n/ja.ts
@@ -1,2 +1,2 @@
-export const greeting = "こんにちは";
+export const greeting = "こんにちは、世界 — ok? ✅";
\\ No newline at end of file


`;
    const result = await captureDiff(worker, run(), raw, BASE_SHA);
    const readBack = await readDiff(worker, result.diffRef!);

    expect(readBack).toBe(raw);
    expect(readBack?.endsWith("\n\n\n")).toBe(true);
  });

  it("returns null for a ref that was never captured, and for a forged one", async () => {
    expect(await readDiff(worker, `diff_${"a".repeat(64)}`)).toBeNull();
    // A ref is model-visible, so it is validated rather than pasted into a key:
    // otherwise a model could name a published artifact, or walk out of the
    // prefix entirely.
    expect(await readDiff(worker, "../../etc/passwd")).toBeNull();
    expect(await readDiff(worker, `${"a".repeat(64)}.csv`)).toBeNull();
    expect(await readDiff(worker, `${INTERNAL_KEY_PREFIX}diff/x.patch`)).toBeNull();
    expect(await readDiff(worker, "")).toBeNull();
  });
});

describe("the internal namespace is not reachable from the public artifacts route", () => {
  const fetchKey = (path: string) => SELF.fetch(`https://firefighter.example/api/artifacts/${path}`);

  it("404s the key that actually holds a captured diff", async () => {
    const result = await captureDiff(worker, run(), REALISTIC_DIFF, BASE_SHA);
    const key = internalDiffKey(result.diffRef!);
    expect(key).not.toBeNull();

    // The realistic probe: the key contains `/`, so a raw path would not even
    // match `:key` — percent-encoding is how it reaches the handler at all.
    const encoded = await fetchKey(encodeURIComponent(key!));
    expect(encoded.status).toBe(404);
    expect(await encoded.text()).not.toContain("legacyRetry");

    // And the raw multi-segment form must not yield the bytes either, whichever
    // route ends up answering it.
    const raw = await fetchKey(key!);
    expect(await raw.text()).not.toContain("legacyRetry");
  });

  it("refuses every shape under the internal prefix, including one that looks like an artifact", async () => {
    const hex = "a".repeat(64);
    for (const key of [
      `${INTERNAL_KEY_PREFIX}diff/${hex}.patch`,
      // The dangerous one: a key that WOULD pass the artifact pattern if the
      // prefix were stripped or the pattern were ever loosened.
      `${INTERNAL_KEY_PREFIX}${hex}.csv`,
      `${INTERNAL_KEY_PREFIX}`,
    ]) {
      const response = await fetchKey(encodeURIComponent(key));
      expect(response.status).toBe(404);
    }
  });

  it("still serves a normally published artifact", async () => {
    // The guard has to be narrow. A 404 for everything would also pass the case
    // above, and would silently break `files.publish`.
    const published = await makeArtifactPublisher({
      bucket: env.ARTIFACTS,
      baseUrl: "https://firefighter.example/api/artifacts",
    }).publish({
      bytes: new TextEncoder().encode("id,name\n1,acme\n"),
      contentType: "text/csv",
      filename: "report.csv",
      idempotencyKey: crypto.randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64),
    });

    const response = await fetchKey(published.url.split("/artifacts/")[1]!);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("id,name\n1,acme\n");
  });

  it("keeps the two key spaces provably disjoint", () => {
    const hex = "a".repeat(64);
    expect(isInternalKey(`${INTERNAL_KEY_PREFIX}diff/${hex}.patch`)).toBe(true);
    expect(isInternalKey(`${hex}.csv`)).toBe(false);
    // A published key can never begin with the prefix: it is 64 lowercase hex
    // characters and a dot, so `_` cannot be its first character.
    expect(isArtifactKey(`${INTERNAL_KEY_PREFIX}diff/${hex}.patch`)).toBe(false);
    expect(INTERNAL_KEY_PREFIX.startsWith("_")).toBe(true);
  });
});

/**
 * THE BASE SHA TRAVELS WITH THE DIFF.
 *
 * Phase 20 fetches each touched file from GitHub at the base commit, applies
 * the patch, and parents the resulting git commit on that same sha. If the sha
 * and the patch could drift apart, a stale patch would apply cleanly against
 * the wrong tree — or fail in a way that looks like corruption rather than
 * staleness. Keeping them in one write is what makes a context mismatch always
 * mean "this patch is stale" rather than "something is broken."
 */
describe("the base sha travels with the diff", () => {
  it("keeps the model-visible DiffResult shape unchanged", async () => {
    const result = await captureDiff(worker, run(), REALISTIC_DIFF, BASE_SHA);

    // Exact key set: a new field here would be `.d.ts` churn for Phase 20's
    // model-facing schema, which the brief says must not happen.
    expect(Object.keys(result).sort()).toEqual(
      ["deletions", "diffRef", "filesChanged", "insertions", "preview", "truncated"].sort(),
    );
  });

  it("readDiffWithBase returns the patch and the base sha it was cut against", async () => {
    const result = await captureDiff(worker, run(), REALISTIC_DIFF, BASE_SHA);

    expect(await readDiffWithBase(worker, result.diffRef!)).toEqual({
      patch: REALISTIC_DIFF,
      baseSha: BASE_SHA,
    });
  });

  it("readDiff still returns text only, for a caller that wants no metadata", async () => {
    const result = await captureDiff(worker, run(), REALISTIC_DIFF, BASE_SHA);

    expect(await readDiff(worker, result.diffRef!)).toBe(REALISTIC_DIFF);
  });

  it("returns null from readDiffWithBase for an unknown or malformed ref, same as readDiff", async () => {
    expect(await readDiffWithBase(worker, `diff_${"a".repeat(64)}`)).toBeNull();
    expect(await readDiffWithBase(worker, "../../etc/passwd")).toBeNull();
    expect(await readDiffWithBase(worker, `${"a".repeat(64)}.csv`)).toBeNull();
    expect(await readDiffWithBase(worker, "")).toBeNull();
  });

  it("is content-addressed by patch bytes alone: identical bytes from a different base share one object, and the later write's metadata wins", async () => {
    const first = await captureDiff(worker, run(), REALISTIC_DIFF, BASE_SHA);
    const second = await captureDiff(worker, run(), REALISTIC_DIFF, OTHER_SHA);

    // Same bytes, so the same content-addressed key.
    expect(second.diffRef).toBe(first.diffRef);
    // The second write's customMetadata replaced the first's; this is
    // documented behavior, not a bug — identical bytes applying cleanly at
    // either base sha is exactly what the applier's byte-exact context check
    // verifies at apply time in Phase 20.
    expect(await readDiffWithBase(worker, second.diffRef!)).toEqual({
      patch: REALISTIC_DIFF,
      baseSha: OTHER_SHA,
    });
  });
});
