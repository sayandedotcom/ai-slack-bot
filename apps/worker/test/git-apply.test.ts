import { describe, expect, it } from "vitest";
import { applyUnifiedDiff, basePaths } from "../src/git/apply";
import { CapabilityError } from "../src/codemode/errors";

/**
 * BYTE-EXACT OR REFUSED.
 *
 * Phase 20 turns this module's output straight into git blobs on a real
 * pull request against a real monorepo — there is no human between what
 * `applyUnifiedDiff` returns and what gets committed. So every fixture here
 * is a REAL `git diff` (captured with `git add -A -N && git diff`, the exact
 * command the sandbox runs) rather than hand-typed patch text, and every
 * assertion is on real output content, never on a mock.
 */

const MOD_BASE = "line1\nline2\nline3\nline4\nline5\n";
const MOD_PATCH = `diff --git a/mod.txt b/mod.txt
index b3c5a95..73abd21 100644
--- a/mod.txt
+++ b/mod.txt
@@ -1,5 +1,5 @@
 line1
-line2
+CHANGED2
 line3
 line4
-line5
+CHANGED5
`;

const TOML_BASE = "toml content\n+++ front\n--- also\nend\n";
// Content lines that themselves begin with `+++`/`---` — the parseStats trap
// from src/sandbox/diff.ts. A parser that guesses file-header-vs-content by
// prefix alone instead of hunk state will misparse this file.
const TOML_PATCH = `diff --git a/front.toml b/front.toml
index ff6799e..a0802a2 100644
--- a/front.toml
+++ b/front.toml
@@ -1,4 +1,5 @@
 toml content
 +++ front
 --- also
+NEW LINE
 end
`;

const EXEC_BASE = "exec content\n";
const EXEC_MODIFY_PATCH = `diff --git a/exec.sh b/exec.sh
index 077fa32..dbb734f 100755
--- a/exec.sh
+++ b/exec.sh
@@ -1 +1,2 @@
 exec content
+more
`;

const NEW_PATCH = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..d5a09df
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+brand new
`;

const NEWEXEC_PATCH = `diff --git a/newexec.sh b/newexec.sh
new file mode 100755
index 0000000..3d6a571
--- /dev/null
+++ b/newexec.sh
@@ -0,0 +1 @@
+exec new
`;

const DEL_BASE = "to delete\nsecond\n";
const DEL_PATCH = `diff --git a/del.txt b/del.txt
deleted file mode 100644
index 0e01078..0000000
--- a/del.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-to delete
-second
`;

const NONEWLINE_BASE = "no newline at end";
const NONEWLINE_PATCH = `diff --git a/nonewline.txt b/nonewline.txt
index 2802503..a27014a 100644
--- a/nonewline.txt
+++ b/nonewline.txt
@@ -1 +1 @@
-no newline at end
\\ No newline at end of file
+no newline at end CHANGED
\\ No newline at end of file
`;

const CRLF_BASE = "crlf\r\nsecond\r\n";
// Git preserves `\r` as ordinary line content (it only splits on `\n`), so the
// context and changed lines below carry a trailing `\r` exactly as `git diff`
// emits it — this is not a JS-string escaping convenience, it is the byte a
// real CRLF-file diff contains.
const CRLF_PATCH =
  "diff --git a/crlf.txt b/crlf.txt\n" +
  "index 49c4224..25f8c55 100644\n" +
  "--- a/crlf.txt\n" +
  "+++ b/crlf.txt\n" +
  "@@ -1,2 +1,2 @@\n" +
  " crlf\r\n" +
  "-second\r\n" +
  "+second CHANGED\r\n";

const MULTI_HUNK_BASE = `${Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n")}\n`;
// Two separate `@@` hunks, far enough apart that git does not merge their
// context — the case where the applier must copy the UNCHANGED lines between
// hunks from the base rather than only walking hunk-covered lines, and must
// use each hunk's own declared offset rather than a running cursor.
const MULTI_HUNK_PATCH = `diff --git a/multi.txt b/multi.txt
index f696b4b..244d95e 100644
--- a/multi.txt
+++ b/multi.txt
@@ -1,5 +1,5 @@
 line1
-line2
+CHANGED2
 line3
 line4
 line5
@@ -16,5 +16,5 @@ line15
 line16
 line17
 line18
-line19
+CHANGED19
 line20
`;

describe("applyUnifiedDiff — happy paths", () => {
  it("modifies a file across multiple hunks, shifting line numbers correctly", () => {
    const base = new Map([["mod.txt", MOD_BASE]]);
    const result = applyUnifiedDiff(MOD_PATCH, base);
    expect(result).toEqual([
      {
        kind: "modify",
        path: "mod.txt",
        content: "line1\nCHANGED2\nline3\nline4\nCHANGED5\n",
        mode: "100644",
      },
    ]);
  });

  it("modifies a file across two separate @@ hunks, preserving the untouched lines between them", () => {
    const base = new Map([["multi.txt", MULTI_HUNK_BASE]]);
    const result = applyUnifiedDiff(MULTI_HUNK_PATCH, base);
    const expectedLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    expectedLines[1] = "CHANGED2";
    expectedLines[18] = "CHANGED19";
    expect(result).toEqual([
      {
        kind: "modify",
        path: "multi.txt",
        content: `${expectedLines.join("\n")}\n`,
        mode: "100644",
      },
    ]);
  });

  it("creates a file with no base entry", () => {
    const base = new Map<string, string>();
    const result = applyUnifiedDiff(NEW_PATCH, base);
    expect(result).toEqual([
      { kind: "create", path: "new.txt", content: "brand new\n", mode: "100644" },
    ]);
  });

  it("deletes a file", () => {
    const base = new Map([["del.txt", DEL_BASE]]);
    const result = applyUnifiedDiff(DEL_PATCH, base);
    expect(result).toEqual([{ kind: "delete", path: "del.txt" }]);
  });

  it("preserves the executable bit on create", () => {
    const base = new Map<string, string>();
    const result = applyUnifiedDiff(NEWEXEC_PATCH, base);
    expect(result).toEqual([
      { kind: "create", path: "newexec.sh", content: "exec new\n", mode: "100755" },
    ]);
  });

  it("preserves the executable bit on modify", () => {
    const base = new Map([["exec.sh", EXEC_BASE]]);
    const result = applyUnifiedDiff(EXEC_MODIFY_PATCH, base);
    expect(result).toEqual([
      {
        kind: "modify",
        path: "exec.sh",
        content: "exec content\nmore\n",
        mode: "100755",
      },
    ]);
  });

  it("applies a hunk whose content lines start with '++'/'--' without mistaking them for headers", () => {
    const base = new Map([["front.toml", TOML_BASE]]);
    const result = applyUnifiedDiff(TOML_PATCH, base);
    expect(result).toEqual([
      {
        kind: "modify",
        path: "front.toml",
        content: "toml content\n+++ front\n--- also\nNEW LINE\nend\n",
        mode: "100644",
      },
    ]);
  });

  it("does not add a trailing newline the file never had, on both sides of the change", () => {
    const base = new Map([["nonewline.txt", NONEWLINE_BASE]]);
    const result = applyUnifiedDiff(NONEWLINE_PATCH, base);
    expect(result).toEqual([
      {
        kind: "modify",
        path: "nonewline.txt",
        content: "no newline at end CHANGED",
        mode: "100644",
      },
    ]);
    const change = result[0];
    if (change.kind !== "delete") {
      expect(change.content.endsWith("\n")).toBe(false);
    }
  });

  it("passes CRLF content through byte-exact", () => {
    const base = new Map([["crlf.txt", CRLF_BASE]]);
    const result = applyUnifiedDiff(CRLF_PATCH, base);
    expect(result).toEqual([
      {
        kind: "modify",
        path: "crlf.txt",
        content: "crlf\r\nsecond CHANGED\r\n",
        mode: "100644",
      },
    ]);
  });

  it("applies a multi-file patch in order", () => {
    const patch = [MOD_PATCH, NEW_PATCH, DEL_PATCH].join("");
    const base = new Map([
      ["mod.txt", MOD_BASE],
      ["del.txt", DEL_BASE],
    ]);
    const result = applyUnifiedDiff(patch, base);
    expect(result.map((r) => r.path)).toEqual(["mod.txt", "new.txt", "del.txt"]);
    expect(result[0]).toMatchObject({ kind: "modify", path: "mod.txt" });
    expect(result[1]).toMatchObject({ kind: "create", path: "new.txt" });
    expect(result[2]).toEqual({ kind: "delete", path: "del.txt" });
  });

  it("basePaths returns modify and delete paths, but not create paths", () => {
    const patch = [MOD_PATCH, NEW_PATCH, DEL_PATCH].join("");
    expect(basePaths(patch)).toEqual(["mod.txt", "del.txt"]);
  });
});

describe("applyUnifiedDiff — refusals", () => {
  it("refuses a GIT binary patch, naming the file", () => {
    const patch = `diff --git a/image.png b/image.png
index 1111111..2222222 100644
GIT binary patch
literal 10
xcmZ?wbhEHb

`;
    expect(() => applyUnifiedDiff(patch, new Map())).toThrow(CapabilityError);
    try {
      applyUnifiedDiff(patch, new Map());
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityError);
      const capErr = err as CapabilityError;
      expect(capErr.code).toBe("invalid_input");
      expect(capErr.message).toContain("image.png");
      expect(capErr.message.toLowerCase()).toContain("binary");
      expect(capErr.message.toLowerCase()).toContain("human");
    }
  });

  it("refuses a 'Binary files ... differ' patch, naming the file", () => {
    const patch = `diff --git a/blob.bin b/blob.bin
index 1111111..2222222 100644
Binary files a/blob.bin and b/blob.bin differ
`;
    try {
      applyUnifiedDiff(patch, new Map());
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityError);
      const capErr = err as CapabilityError;
      expect(capErr.code).toBe("invalid_input");
      expect(capErr.message).toContain("blob.bin");
      expect(capErr.message.toLowerCase()).toContain("binary");
    }
  });

  it("refuses a rename patch, naming the file", () => {
    const patch = `diff --git a/old-name.ts b/new-name.ts
similarity index 100%
rename from old-name.ts
rename to new-name.ts
`;
    try {
      applyUnifiedDiff(patch, new Map([["old-name.ts", "content\n"]]));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityError);
      const capErr = err as CapabilityError;
      expect(capErr.code).toBe("invalid_input");
      expect(capErr.message).toMatch(/old-name\.ts|new-name\.ts/);
    }
  });

  it("refuses a copy patch, naming the file", () => {
    const patch = `diff --git a/original.ts b/copy.ts
similarity index 100%
copy from original.ts
copy to copy.ts
`;
    try {
      applyUnifiedDiff(patch, new Map([["original.ts", "content\n"]]));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityError);
      const capErr = err as CapabilityError;
      expect(capErr.code).toBe("invalid_input");
      expect(capErr.message).toMatch(/original\.ts|copy\.ts/);
    }
  });

  it("refuses a hunk whose context does not match the base byte-for-byte, naming file and hunk, telling the model to re-run diff", () => {
    const staleBase = "line1\nDIFFERENT\nline3\nline4\nline5\n";
    const base = new Map([["mod.txt", staleBase]]);
    try {
      applyUnifiedDiff(MOD_PATCH, base);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityError);
      const capErr = err as CapabilityError;
      expect(capErr.code).toBe("invalid_input");
      expect(capErr.message).toContain("mod.txt");
      expect(capErr.message.toLowerCase()).toContain("stale");
      expect(capErr.message.toLowerCase()).toContain("re-run diff");
    }
  });

  it("refuses a patch touching a path the base map lacks, for modify", () => {
    try {
      applyUnifiedDiff(MOD_PATCH, new Map());
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityError);
      const capErr = err as CapabilityError;
      expect(capErr.code).toBe("invalid_input");
      expect(capErr.message).toContain("mod.txt");
      expect(capErr.message.toLowerCase()).toContain("stale");
    }
  });

  it("refuses a patch touching a path the base map lacks, for delete", () => {
    try {
      applyUnifiedDiff(DEL_PATCH, new Map());
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityError);
      const capErr = err as CapabilityError;
      expect(capErr.code).toBe("invalid_input");
      expect(capErr.message).toContain("del.txt");
      expect(capErr.message.toLowerCase()).toContain("stale");
    }
  });

  it("refuses an empty patch", () => {
    try {
      applyUnifiedDiff("", new Map());
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityError);
      expect((err as CapabilityError).code).toBe("invalid_input");
    }
  });

  it("refuses a garbage patch", () => {
    try {
      applyUnifiedDiff("this is not a diff at all\njust some text\n", new Map());
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityError);
      expect((err as CapabilityError).code).toBe("invalid_input");
    }
  });
});

/* --------------------------------------------------- file modes (Phase 20) -- */

/**
 * MODES THE APPLIER DOES NOT MODEL ARE REFUSED, NOT DOWNGRADED.
 *
 * Every fixture below is real `git diff` output, captured with the same
 * `git add -A -N && git diff` the sandbox runs (git 2.34.1), because the whole
 * failure this covers lives in header shapes a hand-typed patch would get
 * wrong: a modified symlink carries its `120000` on the `index` line and
 * NOWHERE else, and a `chmod +x` alongside a content change carries its mode
 * on an `old mode`/`new mode` pair with an `index` line that has no mode at
 * all. Guessing either one wrong turns a symlink into a regular file holding
 * its own link target, on a real repository, with no human in between.
 */

/** `ln -s t.txt link` committed, then re-pointed at `other/target`. */
const SYMLINK_MODIFY_PATCH = `diff --git a/link b/link
index 3eddab3..c9fc5aa 120000
--- a/link
+++ b/link
@@ -1 +1 @@
-t.txt
\\ No newline at end of file
+other/target
\\ No newline at end of file
`;

/** `ln -s /etc/passwd newlink` on a fresh path. */
const SYMLINK_CREATE_PATCH = `diff --git a/newlink b/newlink
new file mode 120000
index 0000000..3594e94
--- /dev/null
+++ b/newlink
@@ -0,0 +1 @@
+/etc/passwd
\\ No newline at end of file
`;

/** The delete half of a symlink→regular-file typechange. */
const SYMLINK_DELETE_PATCH = `diff --git a/link b/link
deleted file mode 120000
index 3eddab3..0000000
--- a/link
+++ /dev/null
@@ -1 +0,0 @@
-t.txt
\\ No newline at end of file
`;

/** `git submodule add` — a gitlink, castable straight through a `new file mode` header. */
const SUBMODULE_PATCH = `diff --git a/vendor/sub b/vendor/sub
new file mode 160000
index 0000000..b5a00a0
--- /dev/null
+++ b/vendor/sub
@@ -0,0 +1 @@
+Subproject commit b5a00a01ef30d3691317a2cc1089561dc4a9d21a
`;

/** `chmod +x f.sh` together with a content edit: mode lives on the pair, and the `index` line carries none. */
const CHMOD_WITH_CONTENT_PATCH = `diff --git a/f.sh b/f.sh
old mode 100644
new mode 100755
index de98044..7be73ce
--- a/f.sh
+++ b/f.sh
@@ -1,3 +1,3 @@
 a
-b
+B
 c
`;

/** `chmod +x only.sh` and nothing else: no `index` line, no hunks at all. */
const CHMOD_ONLY_PATCH = `diff --git a/only.sh b/only.sh
old mode 100644
new mode 100755
`;

/** `chmod -x` — the same shape in the other direction. */
const UNCHMOD_ONLY_PATCH = `diff --git a/only.sh b/only.sh
old mode 100755
new mode 100644
`;

describe("applyUnifiedDiff — file modes", () => {
  it("refuses a modified symlink, naming the file and the mode, rather than writing the link target as a regular file", () => {
    try {
      applyUnifiedDiff(SYMLINK_MODIFY_PATCH, new Map([["link", "t.txt"]]));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityError);
      const capErr = err as CapabilityError;
      expect(capErr.code).toBe("invalid_input");
      expect(capErr.message).toContain("link");
      expect(capErr.message).toContain("120000");
    }
  });

  it("refuses a created symlink", () => {
    try {
      applyUnifiedDiff(SYMLINK_CREATE_PATCH, new Map());
      throw new Error("expected throw");
    } catch (err) {
      expect((err as CapabilityError).code).toBe("invalid_input");
      expect((err as CapabilityError).message).toContain("newlink");
      expect((err as CapabilityError).message).toContain("120000");
    }
  });

  it("refuses a deleted symlink", () => {
    try {
      applyUnifiedDiff(SYMLINK_DELETE_PATCH, new Map([["link", "t.txt"]]));
      throw new Error("expected throw");
    } catch (err) {
      expect((err as CapabilityError).code).toBe("invalid_input");
      expect((err as CapabilityError).message).toContain("link");
      expect((err as CapabilityError).message).toContain("120000");
    }
  });

  it("refuses a submodule/gitlink entry", () => {
    try {
      applyUnifiedDiff(SUBMODULE_PATCH, new Map());
      throw new Error("expected throw");
    } catch (err) {
      expect((err as CapabilityError).code).toBe("invalid_input");
      expect((err as CapabilityError).message).toContain("vendor/sub");
      expect((err as CapabilityError).message).toContain("160000");
    }
  });

  it("refuses a symlink even when basePaths is the only thing asked for", () => {
    expect(() => basePaths(SYMLINK_MODIFY_PATCH)).toThrow(CapabilityError);
  });

  it("carries a chmod +x that accompanies a content change onto the resulting change", () => {
    const changes = applyUnifiedDiff(CHMOD_WITH_CONTENT_PATCH, new Map([["f.sh", "a\nb\nc\n"]]));
    expect(changes).toEqual([
      { kind: "modify", path: "f.sh", content: "a\nB\nc\n", mode: "100755" },
    ]);
  });

  it("carries a chmod-only change (no hunks) with the content left byte-identical", () => {
    const changes = applyUnifiedDiff(CHMOD_ONLY_PATCH, new Map([["only.sh", "a\nb\n"]]));
    expect(changes).toEqual([
      { kind: "modify", path: "only.sh", content: "a\nb\n", mode: "100755" },
    ]);
    // The base file has to be FETCHED for a chmod-only change, or the blob
    // written alongside the new mode would be empty.
    expect(basePaths(CHMOD_ONLY_PATCH)).toEqual(["only.sh"]);
  });

  it("carries a chmod -x the same way, in the other direction", () => {
    const changes = applyUnifiedDiff(UNCHMOD_ONLY_PATCH, new Map([["only.sh", "a\nb\n"]]));
    expect(changes).toEqual([
      { kind: "modify", path: "only.sh", content: "a\nb\n", mode: "100644" },
    ]);
  });

  it("refuses an old/new mode pair naming a mode outside the whitelist", () => {
    const patch = `diff --git a/link b/link
old mode 120000
new mode 100644
index 3eddab3..2a79fdf
--- a/link
+++ b/link
@@ -1 +1 @@
-t.txt
+now a real file
`;
    try {
      applyUnifiedDiff(patch, new Map([["link", "t.txt"]]));
      throw new Error("expected throw");
    } catch (err) {
      expect((err as CapabilityError).code).toBe("invalid_input");
      expect((err as CapabilityError).message).toContain("120000");
    }
  });
});
