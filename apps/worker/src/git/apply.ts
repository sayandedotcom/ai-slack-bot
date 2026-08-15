import { CapabilityError } from "../codemode/errors";

/**
 * The seam between a stored diff and a real commit.
 *
 * A later Phase 20 task reads a `git diff` out of R2, fetches each touched
 * file's content from GitHub at the base commit, and calls `applyUnifiedDiff`
 * to compute the new file contents — which become git blobs pushed to a
 * customer's monorepo with no human in between. So this module never
 * guesses: a hunk whose context does not match the fetched content byte-for-
 * byte is refused, not fuzzy-matched. Git cut the diff from the exact tree we
 * fetch, so any mismatch means the tree moved between diff and apply — the
 * fix is to re-run diff, never to search nearby lines for something close
 * enough.
 */

export type FileChange =
  | { kind: "modify" | "create"; path: string; content: string; mode: "100644" | "100755" }
  | { kind: "delete"; path: string };

type Mode = "100644" | "100755";

type HunkLine = { marker: " " | "+" | "-"; text: string; noNewlineAfter: boolean };

type Hunk = { oldStart: number; oldCount: number; lines: HunkLine[] };

type ParsedFile = {
  kind: "modify" | "create" | "delete";
  /** Path on the base side. Equal to `path` except for create, where there is no base side. */
  oldPath: string;
  /** Path on the result side. Equal to `path` except for delete, where there is no result side. */
  newPath: string;
  mode: Mode;
  hunks: Hunk[];
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/** `a/X b/Y` — no rename support, so X and Y are always the same path, but we
 * still parse both sides rather than assume it, so a rename is caught as an
 * unsupported header rather than silently producing the wrong path. */
const DIFF_GIT_HEADER = /^diff --git a\/(.+) b\/(.+)$/;

function invalidInput(reason: string): never {
  throw new CapabilityError("invalid_input", reason);
}

/**
 * The only two git file modes this applier can write, checked EVERY time a
 * mode is read rather than once at the end.
 *
 * A mode is not decoration — it is the tree entry's type. `120000` is a
 * symlink whose "content" is its target path, `160000` is a gitlink holding
 * another repository's commit sha, and both are cast-shaped enough to slide
 * through a `Mode` annotation and come out the other side as a regular file
 * on a real monorepo: a modified symlink would be committed as a text file
 * containing its own link target, silently, with no human in between. Same
 * rule as the rename and binary refusals above — this applier does the narrow
 * thing it can do byte-exactly, and names the file when it will not.
 */
function assertSupportedMode(raw: string, displayPath: string): Mode {
  if (raw === "100644" || raw === "100755") return raw;
  invalidInput(
    `"${displayPath}" has git file mode ${raw}; this applier only writes regular files (100644 and 100755). A symlink (120000), a submodule/gitlink (160000) or any other special entry needs a human PR.`,
  );
}

function staleContext(path: string, detail: string): never {
  invalidInput(
    `the diff for "${path}" ${detail} — the base file has moved since the diff was taken. The diff is stale; re-run diff and try again.`,
  );
}

/** Splits the whole patch into one line-array per `diff --git` block. */
function splitFileBlocks(patch: string): string[][] {
  const lines = patch.split("\n");
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      current = [line];
      blocks.push(current);
    } else if (current !== null) {
      current.push(line);
    }
  }
  return blocks;
}

function parseHunkHeader(line: string): { oldStart: number; oldCount: number } | null {
  const match = HUNK_HEADER.exec(line);
  if (match === null) return null;
  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  return { oldStart, oldCount };
}

/** Parses one `diff --git` block into a `ParsedFile`, refusing anything this applier does not support. */
function parseFileBlock(block: string[]): ParsedFile {
  const headerMatch = DIFF_GIT_HEADER.exec(block[0]);
  if (headerMatch === null) invalidInput(`unrecognized diff header: "${block[0]}"`);
  const oldPath = headerMatch[1];
  const newPath = headerMatch[2];
  // Named for error messages before we know which side is real: the delete
  // path is the old one, everything else is the new one.
  const displayPath = newPath;

  let kind: "modify" | "create" | "delete" = "modify";
  let mode: Mode = "100644";
  let modeSeen = false;
  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;

  let i = 1;
  while (i < block.length) {
    const line = block[i];

    if (line.startsWith("new file mode ")) {
      kind = "create";
      mode = assertSupportedMode(line.slice("new file mode ".length).trim(), displayPath);
      modeSeen = true;
      i += 1;
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      kind = "delete";
      mode = assertSupportedMode(line.slice("deleted file mode ".length).trim(), oldPath);
      modeSeen = true;
      i += 1;
      continue;
    }
    // `old mode` / `new mode`, git's shape for a chmod. It appears WITH a
    // content change (in which case the `index` line below carries no mode at
    // all) and alone (in which case there is no `index` line and no hunk
    // either). The new mode is carried onto the change rather than dropped:
    // the tree entry this produces states the file's mode outright, so
    // ignoring the pair does not leave the mode alone — it posts the applier's
    // 100644 default over whatever the file really is, quietly un-executing a
    // script. Whitelisted on both sides, so a typechange (`old mode 120000`)
    // is refused rather than flattened.
    if (line.startsWith("old mode ")) {
      assertSupportedMode(line.slice("old mode ".length).trim(), displayPath);
      i += 1;
      continue;
    }
    if (line.startsWith("new mode ")) {
      mode = assertSupportedMode(line.slice("new mode ".length).trim(), displayPath);
      modeSeen = true;
      i += 1;
      continue;
    }
    if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
      invalidInput(
        `the diff renames or copies "${oldPath}" to "${newPath}"; this applier only handles create, modify and delete — open a human PR for renames.`,
      );
    }
    if (line.startsWith("GIT binary patch")) {
      invalidInput(
        `"${displayPath}" is a binary patch; binary changes need a human PR, not an automated apply.`,
      );
    }
    if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
      invalidInput(
        `"${displayPath}" has binary content ("${line}"); binary changes need a human PR, not an automated apply.`,
      );
    }
    if (line.startsWith("index ") && !modeSeen) {
      // "index <old>..<new> <mode>" — mode is present for every non-mode-only
      // change in this dialect (default `git diff`, never `--unified=0`), and
      // it is the ONLY place a modified symlink's `120000` appears: there is
      // no `new file mode` line on a modify. So an unrecognised value here is
      // refused, never quietly left at the 100644 default.
      const parts = line.split(" ");
      if (parts.length >= 3 && parts[2].length > 0) {
        mode = assertSupportedMode(parts[2], displayPath);
      }
      i += 1;
      continue;
    }
    if (line.startsWith("@@ ")) {
      const header = parseHunkHeader(line);
      if (header === null) invalidInput(`"${displayPath}" has an unparseable hunk header: "${line}"`);
      currentHunk = { oldStart: header.oldStart, oldCount: header.oldCount, lines: [] };
      hunks.push(currentHunk);
      i += 1;
      continue;
    }
    if (line.startsWith("\\ No newline at end of file")) {
      if (currentHunk !== null && currentHunk.lines.length > 0) {
        currentHunk.lines[currentHunk.lines.length - 1].noNewlineAfter = true;
      }
      i += 1;
      continue;
    }
    if (currentHunk !== null && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))) {
      currentHunk.lines.push({
        marker: line[0] as " " | "+" | "-",
        text: line.slice(1),
        noNewlineAfter: false,
      });
      i += 1;
      continue;
    }
    // "---", "+++", "similarity index" and blank trailer lines carry nothing
    // this applier needs. (`old mode`/`new mode` DO — they are handled above.)
    i += 1;
  }

  return { kind, oldPath, newPath, mode, hunks };
}

function parsePatch(patch: string): ParsedFile[] {
  if (patch.trim().length === 0) {
    invalidInput("the diff is empty; there is nothing to apply.");
  }
  const blocks = splitFileBlocks(patch);
  if (blocks.length === 0) {
    invalidInput("the diff does not contain any recognizable \"diff --git\" file headers.");
  }
  return blocks.map(parseFileBlock);
}

/** A file's text as lines with no trailing-newline characters, plus whether the text ended in one. */
function splitLines(content: string): { lines: string[]; finalNewline: boolean } {
  if (content === "") return { lines: [], finalNewline: true };
  const parts = content.split("\n");
  if (parts[parts.length - 1] === "") {
    parts.pop();
    return { lines: parts, finalNewline: true };
  }
  return { lines: parts, finalNewline: false };
}

function joinLines(lines: string[], finalNewline: boolean): string {
  if (lines.length === 0) return "";
  return lines.join("\n") + (finalNewline ? "\n" : "");
}

/**
 * Walks the base lines by each hunk's declared offsets, verifying every
 * context and deletion line matches the base byte-for-byte before emitting
 * anything. Used for create, modify, and delete alike — a delete's hunks
 * are still verified even though the resulting content is never used, so a
 * stale delete is refused exactly like a stale modify.
 */
function applyHunks(file: ParsedFile, baseContent: string, displayPath: string): string {
  const base = splitLines(baseContent);
  const result: string[] = [];
  let cursor = 0;
  let finalNewline = base.finalNewline;

  for (const hunk of file.hunks) {
    const startIdx = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (startIdx < cursor) {
      staleContext(displayPath, `has out-of-order or overlapping hunks (hunk starting at old line ${hunk.oldStart})`);
    }
    for (let i = cursor; i < startIdx; i += 1) {
      if (i >= base.lines.length) {
        staleContext(displayPath, `references line ${hunk.oldStart}, past the end of the fetched file`);
      }
      result.push(base.lines[i]);
    }
    cursor = startIdx;

    for (const hunkLine of hunk.lines) {
      if (hunkLine.marker === " " || hunkLine.marker === "-") {
        if (cursor >= base.lines.length || base.lines[cursor] !== hunkLine.text) {
          staleContext(
            displayPath,
            `has a hunk (starting at old line ${hunk.oldStart}) whose context does not match the fetched file`,
          );
        }
        cursor += 1;
      }
      if (hunkLine.marker === " " || hunkLine.marker === "+") {
        result.push(hunkLine.text);
        finalNewline = !hunkLine.noNewlineAfter;
      }
    }
  }

  if (cursor < base.lines.length) {
    for (let i = cursor; i < base.lines.length; i += 1) result.push(base.lines[i]);
    finalNewline = base.finalNewline;
  }

  return joinLines(result, finalNewline);
}

/**
 * Parse a git unified diff and apply it to base contents. `base` maps path →
 * file text for every path the patch touches (absent key ⇒ created file).
 */
export function applyUnifiedDiff(patch: string, base: Map<string, string>): FileChange[] {
  const files = parsePatch(patch);
  const changes: FileChange[] = [];

  for (const file of files) {
    if (file.kind === "delete") {
      const baseContent = base.get(file.oldPath);
      if (baseContent === undefined) {
        staleContext(file.oldPath, "deletes a file the fetched base tree does not have");
      }
      applyHunks(file, baseContent, file.oldPath);
      changes.push({ kind: "delete", path: file.oldPath });
    } else if (file.kind === "create") {
      const baseContent = base.get(file.newPath) ?? "";
      const content = applyHunks(file, baseContent, file.newPath);
      changes.push({ kind: "create", path: file.newPath, content, mode: file.mode });
    } else {
      const baseContent = base.get(file.newPath);
      if (baseContent === undefined) {
        staleContext(file.newPath, "modifies a file the fetched base tree does not have");
      }
      const content = applyHunks(file, baseContent, file.newPath);
      changes.push({ kind: "modify", path: file.newPath, content, mode: file.mode });
    }
  }

  return changes;
}

/** The paths the patch reads from the base tree (modify+delete; not creates). */
export function basePaths(patch: string): string[] {
  const files = parsePatch(patch);
  return files.filter((f) => f.kind !== "create").map((f) => (f.kind === "delete" ? f.oldPath : f.newPath));
}
