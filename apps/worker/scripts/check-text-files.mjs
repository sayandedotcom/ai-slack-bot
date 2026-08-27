/**
 * Fail on a control byte in a source file.
 *
 * WHY THIS EXISTS. Twice in this phase a raw NUL byte reached a TypeScript
 * test fixture. Git classifies any file containing a NUL as binary, so both
 * times the diff said "Binary files a/... and b/... differ" and roughly 19KB
 * of security tests went to review as a single unreadable line. Both times a
 * human caught it.
 *
 * On its first run this script found a third case nobody had caught —
 * src/files/r2.ts, whose filename-validation regex had been unreviewable since
 * it landed — and then, once it was itself tracked, a fourth: this very file's
 * doc comment. Four occurrences in one phase is why the guard exists rather
 * than a rule that people are asked to remember.
 *
 * `.gitattributes` marks these extensions `text diff` so git renders a diff
 * anyway — `diff` is the load-bearing half there, since `text` alone only
 * normalizes line endings and does not override git's binary auto-detection.
 * This script is the half that actually fails. Escapes are fine —
 * `"\x00"` in source is six harmless ASCII characters. Only the raw byte is
 * rejected.
 *
 * Node script, not a vitest test, because the worker test pool runs in
 * workerd and has no filesystem.
 *
 * WHERE IT RUNS. Four places now: the root `check:text` script, the lefthook
 * pre-commit hook, the `gate-fast` job in .github/workflows/ci.yml, and
 * `pnpm test` / `pnpm capabilities:dts:check` in this package.
 *
 * It was once reachable only from `capabilities:dts:check`, which nothing ran
 * automatically — so a guard against a mistake that recurred four times
 * depended on somebody remembering the one command that invoked it.
 *
 * The root-level invocation is NOT redundant with the one inside this
 * package's `test` script. This script enumerates `git ls-files` across the
 * WHOLE repository, but turbo hashes only this package and its dependencies,
 * so a control byte introduced in README.md or docs/*.md rides a cache hit and
 * is never scanned. It takes ~50 ms over the whole tracked tree, so running it
 * everywhere costs nothing measurable.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const CHECKED_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "mjs",
  "cjs",
  "json",
  "jsonc",
  "md",
  "sql",
  "yml",
  "yaml",
  "css",
  "html",
  "sh",
]);

/**
 * C0 control bytes that never legitimately appear in source. Tab (0x09),
 * newline (0x0a) and carriage return (0x0d) are excluded; so is 0x7f, which is
 * not a C0 code and shows up harmlessly inside some encoded fixtures.
 *
 * Written as an explicit exclusion set rather than as range arithmetic because
 * the range version said `byte < 0x09 || (byte > 0x0d && byte < 0x20)`, which
 * quietly PERMITTED vertical tab (0x0b) and form feed (0x0c) — the two C0 bytes
 * that sit inside the 0x09-0x0d span but are not in the sentence above it. The
 * guard exists precisely because a comment was trusted four times in this
 * phase, so its own comment and its own code must agree by construction.
 *
 * Neither byte triggers git's binary detection (that keys on NUL), so this was
 * not a hole in the review-hiding failure mode this script was written for. It
 * was a hole in what the script CLAIMS to check.
 */
const ALLOWED_CONTROL_BYTES = new Set([0x09, 0x0a, 0x0d]);

function isForbiddenByte(byte) {
  return byte < 0x20 && !ALLOWED_CONTROL_BYTES.has(byte);
}

function trackedFiles() {
  const output = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z"], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0);
}

const failures = [];

for (const relativePath of trackedFiles()) {
  const extension = relativePath.split(".").pop()?.toLowerCase();
  if (!extension || !CHECKED_EXTENSIONS.has(extension)) continue;

  let contents;
  try {
    contents = readFileSync(resolve(REPO_ROOT, relativePath));
  } catch {
    // Tracked but absent from this worktree. Not this script's problem.
    continue;
  }

  for (let offset = 0; offset < contents.length; offset += 1) {
    if (!isForbiddenByte(contents[offset])) continue;
    // Report the location, never the surrounding content: this runs over every
    // file in the repo and its output goes to CI logs.
    const line = contents
      .subarray(0, offset)
      .toString("utf8")
      .split("\n").length;
    const byte = `0x${contents[offset].toString(16).padStart(2, "0")}`;
    failures.push(`${relativePath}:${line}: control byte ${byte}`);
    break;
  }
}

if (failures.length > 0) {
  console.error(
    `Control bytes found in ${failures.length} source file(s). Git renders these as binary,\n` +
      "which hides the whole file from code review. Use an escape sequence instead.\n"
  );
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`check-text-files: no control bytes in tracked source.`);
