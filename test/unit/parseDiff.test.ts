import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DiffParseError, UnsupportedEntryError } from "../../src/errors.js";
import { parseUnifiedDiff, parseUnifiedDiffDetailed } from "../../src/git/parseDiff.js";
import type { DiffFile } from "../../src/types.js";

const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures");

const FIXTURES = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".diff"))
  .sort();

function readFixture(name: string): Buffer {
  return readFileSync(join(FIXTURE_DIR, name));
}

function reassemble(files: readonly DiffFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    parts.push(file.headerBytes);
    for (const hunk of file.hunks) {
      parts.push(hunk.bytes);
    }
  }
  return Buffer.concat(parts);
}

function fileByPath(files: readonly DiffFile[], path: string): DiffFile {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new Error(`no parsed file for ${path}`);
  }
  return file;
}

function hunkAt(file: DiffFile, ordinal: number) {
  const hunk = file.hunks[ordinal];
  if (hunk === undefined) {
    throw new Error(`no hunk ${ordinal} in ${file.path}`);
  }
  return hunk;
}

describe("parseUnifiedDiffDetailed", () => {
  it("finds every fixture", () => {
    expect(FIXTURES).toHaveLength(18);
  });

  it.each(FIXTURES)("partitions %s byte for byte", (name) => {
    const diff = readFixture(name);
    const parsed = parseUnifiedDiffDetailed(diff);
    expect(reassemble(parsed.files).equals(diff)).toBe(true);
  });

  it("returns no files for empty input", () => {
    const parsed = parseUnifiedDiffDetailed(Buffer.alloc(0));
    expect(parsed.files).toEqual([]);
    expect(parsed.unsupported).toEqual([]);
  });

  it("rejects input that is not a git diff", () => {
    expect(() => parseUnifiedDiffDetailed(Buffer.from("@@ -1 +1 @@\n-a\n+b\n"))).toThrow(
      DiffParseError,
    );
  });

  it("rejects a conflicted combined diff", () => {
    expect(() => parseUnifiedDiffDetailed(Buffer.from("diff --cc f.txt\n"))).toThrow(
      DiffParseError,
    );
  });
});

describe("hunks", () => {
  it("splits a file into ordered hunks with counts", () => {
    const files = parseUnifiedDiff(readFixture("modified-multi-hunk.diff"));
    expect(files).toHaveLength(1);

    const file = fileByPath(files, "src/app.ts");
    expect(file.kind).toBe("modified");
    expect(file.hunks).toHaveLength(2);
    expect(file.headerBytes.toString("utf8")).toMatch(/^diff --git a\/src\/app\.ts/);
    expect(file.headerBytes.toString("utf8").endsWith("+++ b/src/app.ts\n")).toBe(true);

    const first = hunkAt(file, 0);
    expect(first.ordinal).toBe(0);
    expect(first.header).toBe("@@ -1,6 +1,7 @@");
    expect(first.added).toBe(2);
    expect(first.removed).toBe(1);
    expect(first.text.startsWith("@@ -1,6 +1,7 @@\n")).toBe(true);
    expect(first.path).toBe("src/app.ts");

    const second = hunkAt(file, 1);
    expect(second.ordinal).toBe(1);
    expect(second.header).toBe("@@ -20,5 +21,5 @@ export function app() {");
    expect(second.added).toBe(1);
    expect(second.removed).toBe(1);
  });

  it("keeps CRLF bytes untouched", () => {
    const files = parseUnifiedDiff(readFixture("crlf.diff"));
    const hunk = hunkAt(fileByPath(files, "src/crlf.ts"), 0);
    expect(hunk.bytes.includes(Buffer.from("-const b = 2;\r\n"))).toBe(true);
    expect(hunk.header).toBe("@@ -1,3 +1,3 @@");
    expect(hunk.added).toBe(1);
    expect(hunk.removed).toBe(1);
  });

  it("keeps a wanted and an unwanted change in one hunk", () => {
    const files = parseUnifiedDiff(readFixture("interleaved-hunk.diff"));
    const file = fileByPath(files, "src/session.ts");

    expect(file.kind).toBe("modified");
    expect(file.hunks).toHaveLength(1);

    const hunk = hunkAt(file, 0);
    expect(hunk.header).toBe("@@ -1,7 +1,8 @@");
    expect(hunk.added).toBe(2);
    expect(hunk.removed).toBe(1);
    expect(hunk.text).toContain("+  if (!user || !user.active) return res.status(401).end();");
    expect(hunk.text).toContain('+  console.log("open", req.body.email);');
  });

  it("keeps the no-newline marker inside the hunk and out of the counts", () => {
    const diff = readFixture("no-newline-eof.diff");
    const files = parseUnifiedDiff(diff);
    const hunk = hunkAt(fileByPath(files, "src/tail.ts"), 0);

    expect(hunk.added).toBe(1);
    expect(hunk.removed).toBe(1);
    expect(hunk.text.split("\\ No newline at end of file")).toHaveLength(3);
    expect(hunk.bytes.at(-1)).not.toBe(0x0a);
    expect(hunk.bytes.equals(diff.subarray(diff.indexOf("@@ -1,2")))).toBe(true);
  });
});

describe("hunk ids", () => {
  it("is stable across parses", () => {
    const diff = readFixture("modified-multi-hunk.diff");
    const first = parseUnifiedDiff(diff).flatMap((file) => file.hunks.map((hunk) => hunk.id));
    const second = parseUnifiedDiff(diff).flatMap((file) => file.hunks.map((hunk) => hunk.id));
    expect(first).toEqual(second);
    expect(first.every((id) => /^[0-9a-f]{16}$/.test(id))).toBe(true);
  });

  it("differs between files with identical hunk bytes", () => {
    const files = parseUnifiedDiff(readFixture("twin-hunks.diff"));
    const one = hunkAt(fileByPath(files, "src/one.ts"), 0);
    const two = hunkAt(fileByPath(files, "src/two.ts"), 0);
    expect(one.bytes.equals(two.bytes)).toBe(true);
    expect(one.id).not.toBe(two.id);
  });
});

describe("paths", () => {
  it("unquotes C-style quoted paths", () => {
    const files = parseUnifiedDiff(readFixture("quoted-names.diff"));
    expect(files.map((file) => file.path)).toEqual([
      "src/weärd name\twith\ttab.ts",
      "docs/my file.md",
      'src/say "hi".ts',
    ]);
    expect(files.every((file) => file.hunks.every((hunk) => hunk.path === file.path))).toBe(true);
  });

  it("reads the path from the diff --git line when there are no file lines", () => {
    const parsed = parseUnifiedDiffDetailed(readFixture("mode-only.diff"));
    expect(parsed.files.map((file) => file.path)).toEqual([
      "scripts/run deploy.sh",
      "scripts/wörk.sh",
    ]);
    expect(parsed.files.every((file) => file.kind === "mode-only")).toBe(true);
    expect(parsed.files.every((file) => file.hunks.length === 0)).toBe(true);
    expect(parsed.unsupported).toEqual([]);
  });

  it("takes the old path for deletions", () => {
    const files = parseUnifiedDiff(readFixture("deleted-file.diff"));
    const file = fileByPath(files, "src/old.ts");
    expect(file.kind).toBe("deleted");
    expect(hunkAt(file, 0).removed).toBe(2);
    expect(hunkAt(file, 0).added).toBe(0);
  });

  it("takes the new path for additions", () => {
    const files = parseUnifiedDiff(readFixture("added-file.diff"));
    const file = fileByPath(files, "src/new.ts");
    expect(file.kind).toBe("added");
    expect(hunkAt(file, 0).added).toBe(3);
    expect(hunkAt(file, 0).removed).toBe(0);
  });
});

describe("renames", () => {
  it("reads a rename as a deletion and an addition", () => {
    const files = parseUnifiedDiff(readFixture("renamed-split.diff"));

    expect(files.map((file) => ({ path: file.path, kind: file.kind }))).toEqual([
      { path: "src/deliver.ts", kind: "added" },
      { path: "src/ship.ts", kind: "deleted" },
    ]);

    const added = hunkAt(fileByPath(files, "src/deliver.ts"), 0);
    const deleted = hunkAt(fileByPath(files, "src/ship.ts"), 0);
    expect(added.header).toBe("@@ -0,0 +1,3 @@");
    expect([added.added, added.removed]).toEqual([3, 0]);
    expect(deleted.header).toBe("@@ -1,3 +0,0 @@");
    expect([deleted.added, deleted.removed]).toEqual([0, 3]);
    expect(added.id).not.toBe(deleted.id);
  });

  it("reads a rename that changed content", () => {
    const files = parseUnifiedDiff(readFixture("renamed-edited.diff"));

    expect(files.map((file) => file.path)).toEqual(["src/jobs.ts", "src/queue.ts"]);

    const added = hunkAt(fileByPath(files, "src/jobs.ts"), 0);
    const deleted = hunkAt(fileByPath(files, "src/queue.ts"), 0);
    expect([added.added, added.removed]).toEqual([4, 0]);
    expect([deleted.added, deleted.removed]).toEqual([0, 4]);
    expect(added.text).toContain("+  jobs.push({ ...job, at: Date.now() });");
    expect(deleted.text).toContain("-  jobs.push(job);");
  });
});

describe("zero-hunk sections", () => {
  it("keeps zero-byte added and deleted files as byte-exact sections", () => {
    const diff = readFixture("empty-files.diff");
    const parsed = parseUnifiedDiffDetailed(diff);

    expect(parsed.unsupported).toEqual([]);
    expect(parsed.files.map((file) => [file.path, file.kind, file.hunks.length])).toEqual([
      ["already-empty.txt", "deleted", 0],
      ["brand-new.txt", "added", 0],
      ["keep.txt", "modified", 1],
    ]);
    expect(fileByPath(parsed.files, "brand-new.txt").headerBytes.toString("utf8")).toBe(
      "diff --git a/brand-new.txt b/brand-new.txt\nnew file mode 100644\n" +
        "index 0000000000000000000000000000000000000000..e69de29bb2d1d6434b8b29ae775ad8c2e48c5391\n",
    );
    expect(reassemble(parsed.files).equals(diff)).toBe(true);
  });
});

describe("unsupported entries", () => {
  it("reports binary files from both markers", () => {
    const parsed = parseUnifiedDiffDetailed(readFixture("binary.diff"));
    expect(parsed.unsupported).toEqual([
      { path: "assets/logo.png", kind: "binary" },
      { path: "assets/icône.bin", kind: "binary" },
    ]);
    expect(parsed.files.every((file) => file.hunks.length === 0)).toBe(true);
  });

  it("reports symlinks from the index mode and the new file mode", () => {
    const parsed = parseUnifiedDiffDetailed(readFixture("symlink.diff"));
    expect(parsed.unsupported).toEqual([
      { path: "docs/link", kind: "symlink" },
      { path: "docs/newlink", kind: "symlink" },
    ]);
  });

  it("reports submodules", () => {
    const parsed = parseUnifiedDiffDetailed(readFixture("submodule.diff"));
    expect(parsed.unsupported).toEqual([{ path: "vendor/sub", kind: "submodule" }]);
  });

  it("parses a text file that quotes Subproject commit lines as a normal hunk", () => {
    const parsed = parseUnifiedDiffDetailed(readFixture("subproject-text.diff"));

    expect(parsed.unsupported).toEqual([]);
    const file = fileByPath(parsed.files, "docs/notes.md");
    expect(file.kind).toBe("modified");

    const hunk = hunkAt(file, 0);
    expect(hunk.added).toBe(2);
    expect(hunk.removed).toBe(1);
    expect(hunk.text).toContain("+Subproject commit 8888888888888888888888888888888888888888");
  });

  it("ignores mode lines that appear in hunk content", () => {
    const parsed = parseUnifiedDiffDetailed(readFixture("mode-text-in-content.diff"));

    expect(parsed.unsupported).toEqual([]);
    const file = fileByPath(parsed.files, "docs/modes.md");
    expect(file.kind).toBe("modified");
    expect(hunkAt(file, 0).added).toBe(2);
  });

  it("throws one error per kind, binary first", () => {
    const diff = readFixture("mixed-unsupported.diff");
    const parsed = parseUnifiedDiffDetailed(diff);
    expect(parsed.unsupported.map((entry) => entry.kind)).toEqual([
      "submodule",
      "symlink",
      "binary",
    ]);

    try {
      parseUnifiedDiff(diff);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedEntryError);
      if (error instanceof UnsupportedEntryError) {
        expect(error.kind).toBe("binary");
        expect(error.paths).toEqual(["assets/logo.png"]);
        expect(error.message).not.toContain("Subproject");
      }
    }
  });

  it("lists every path of the reported kind", () => {
    try {
      parseUnifiedDiff(readFixture("symlink.diff"));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedEntryError);
      if (error instanceof UnsupportedEntryError) {
        expect(error.kind).toBe("symlink");
        expect(error.paths).toEqual(["docs/link", "docs/newlink"]);
      }
    }
  });
});
