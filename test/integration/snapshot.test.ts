import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NotARepositoryError,
  UnbornRepositoryError,
  UnmergedEntriesError,
  UnsupportedEntryError,
  type UnsupportedEntryKind,
} from "../../src/errors.js";
import { captureSnapshot, DIFF_ARGS } from "../../src/git/snapshot.js";
import type { DiffFile, Snapshot } from "../../src/types.js";
import {
  commitAll,
  createTestGitRunner,
  git,
  gitOrThrow,
  mkRepo,
  mkTempDir,
  removeDir,
  writeFile,
} from "../helpers/repo.js";

const dirs: string[] = [];
let savedIndexFile: string | undefined;

beforeEach(() => {
  savedIndexFile = process.env.GIT_INDEX_FILE;
});

afterEach(() => {
  if (savedIndexFile === undefined) {
    delete process.env.GIT_INDEX_FILE;
  } else {
    process.env.GIT_INDEX_FILE = savedIndexFile;
  }
  for (const dir of dirs.splice(0)) {
    removeDir(dir);
  }
});

function newRepo(): string {
  const dir = mkRepo();
  dirs.push(dir);
  return dir;
}

function newDir(): string {
  const dir = mkTempDir();
  dirs.push(dir);
  return dir;
}

function capture(cwd: string): Promise<Snapshot> {
  return captureSnapshot({ cwd, git: createTestGitRunner() });
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

function rejection(cwd: string): Promise<unknown> {
  return capture(cwd).then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

async function expectUnsupported(
  cwd: string,
  kind: UnsupportedEntryKind,
  expected: string[],
): Promise<void> {
  const error = await rejection(cwd);
  expect(error).toBeInstanceOf(UnsupportedEntryError);
  if (error instanceof UnsupportedEntryError) {
    expect(error.kind).toBe(kind);
    expect(error.paths).toEqual(expected);
  }
}

function paths(snapshot: Snapshot): string[] {
  return snapshot.files.map((file) => file.path.normalize("NFC")).sort();
}

function fileByPath(snapshot: Snapshot, path: string): DiffFile {
  const file = snapshot.files.find((candidate) => candidate.path.normalize("NFC") === path);
  if (file === undefined) {
    throw new Error(`no file for ${path} in ${paths(snapshot).join(", ")}`);
  }
  return file;
}

const UNICODE_PATH = "docs/my wéärd file.md";

describe("captureSnapshot", () => {
  it("captures modified, added, deleted, CRLF and unusual paths", async () => {
    const repo = newRepo();
    writeFile(repo, "src/keep.ts", "a\nb\nc\nd\ne\nf\ng\nh\n");
    writeFile(repo, "src/gone.ts", "p\n");
    writeFile(repo, "src/crlf.ts", "c1\r\nc2\r\nc3\r\n");
    writeFile(repo, UNICODE_PATH, "# title\nbody\n");
    commitAll(repo, "init");

    writeFile(repo, "src/keep.ts", "a\nB\nc\nd\ne\nf\ng\nH\n");
    rmSync(join(repo, "src/gone.ts"));
    writeFile(repo, "src/crlf.ts", "c1\r\nc2X\r\nc3\r\n");
    writeFile(repo, UNICODE_PATH, "# title\nbody two\n");
    writeFile(repo, "src/added.ts", "new\n");
    gitOrThrow(repo, ["add", "-N", "src/added.ts"]);

    const snapshot = await capture(repo);
    const fresh = git(repo, [...DIFF_ARGS]);
    expect(fresh.status).toBe(0);
    expect(snapshot.diffBytes.equals(fresh.stdout)).toBe(true);
    expect(reassemble(snapshot.files).equals(fresh.stdout)).toBe(true);

    expect(paths(snapshot)).toEqual([
      UNICODE_PATH,
      "src/added.ts",
      "src/crlf.ts",
      "src/gone.ts",
      "src/keep.ts",
    ]);
    expect(fileByPath(snapshot, "src/added.ts").kind).toBe("added");
    expect(fileByPath(snapshot, "src/gone.ts").kind).toBe("deleted");
    expect(fileByPath(snapshot, "src/keep.ts").kind).toBe("modified");
    expect(snapshot.skipped).toEqual([]);

    const keep = fileByPath(snapshot, "src/keep.ts").hunks[0];
    expect(keep?.added).toBe(2);
    expect(keep?.removed).toBe(2);
    expect(keep?.header).toBe("@@ -1,8 +1,8 @@");

    const crlf = fileByPath(snapshot, "src/crlf.ts").hunks[0];
    expect(crlf?.bytes.includes(Buffer.from("+c2X\r\n"))).toBe(true);

    expect(snapshot.workTree).toBe(repo);
    expect(snapshot.gitDir).toBe(join(repo, ".git"));
    expect(snapshot.indexPath).toBe(join(repo, ".git", "index"));
    expect(snapshot.headOid).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.diffHash).toBe(createHash("sha256").update(snapshot.diffBytes).digest("hex"));
    expect(snapshot.indexHash).toBe(
      createHash("sha256").update(readFileSync(snapshot.indexPath)).digest("hex"),
    );
  });

  it("returns no files for a clean work tree", async () => {
    const repo = newRepo();
    writeFile(repo, "a.txt", "a\n");
    commitAll(repo, "init");

    const snapshot = await capture(repo);
    expect(snapshot.files).toEqual([]);
    expect(snapshot.skipped).toEqual([]);
    expect(snapshot.diffBytes).toHaveLength(0);
    expect(snapshot.diffHash).toBe(createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
  });

  it("reports mode-only changes as skipped", async () => {
    const repo = newRepo();
    writeFile(repo, "scripts/run.sh", "#!/bin/sh\necho hi\n");
    commitAll(repo, "init");
    chmodSync(join(repo, "scripts/run.sh"), 0o755);

    const snapshot = await capture(repo);
    expect(snapshot.skipped).toEqual([{ path: "scripts/run.sh", reason: "mode-only" }]);
    expect(snapshot.files).toEqual([]);
    expect(snapshot.diffBytes.toString("utf8")).toContain("new mode 100755");
  });

  it("reports zero-byte added and deleted files as skipped", async () => {
    const repo = newRepo();
    writeFile(repo, "keep.txt", "x\n");
    writeFile(repo, "already-empty.txt", "");
    commitAll(repo, "init");
    writeFile(repo, "keep.txt", "y\n");
    rmSync(join(repo, "already-empty.txt"));
    writeFile(repo, "brand-new.txt", "");
    gitOrThrow(repo, ["add", "-N", "brand-new.txt"]);

    const snapshot = await capture(repo);
    const fresh = git(repo, [...DIFF_ARGS]);
    expect(snapshot.diffBytes.equals(fresh.stdout)).toBe(true);
    expect(paths(snapshot)).toEqual(["keep.txt"]);
    expect(snapshot.skipped).toEqual([
      { path: "already-empty.txt", reason: "empty-file" },
      { path: "brand-new.txt", reason: "empty-file" },
    ]);
    expect(snapshot.files.every((file) => file.hunks.length > 0)).toBe(true);
  });

  it("parses a text file that quotes Subproject commit lines", async () => {
    const repo = newRepo();
    const before = [
      "git submodule status prints:",
      "Subproject commit 6666666666666666666666666666666666666666",
      "end of example",
      "",
    ].join("\n");
    writeFile(repo, "README.md", before);
    commitAll(repo, "init");
    writeFile(
      repo,
      "README.md",
      before.replace(
        "6666666666666666666666666666666666666666",
        "7777777777777777777777777777777777777777",
      ),
    );

    const snapshot = await capture(repo);
    expect(paths(snapshot)).toEqual(["README.md"]);
    expect(snapshot.skipped).toEqual([]);

    const file = fileByPath(snapshot, "README.md");
    expect(file.kind).toBe("modified");
    expect(file.hunks[0]?.added).toBe(1);
    expect(file.hunks[0]?.removed).toBe(1);
  });

  it("round-trips a CRLF work file under .gitattributes text=auto", async () => {
    const repo = newRepo();
    writeFile(repo, ".gitattributes", "* text=auto\n");
    writeFile(repo, "src/norm.ts", "l1\nl2\nl3\n");
    commitAll(repo, "init");
    writeFile(repo, "src/norm.ts", "l1\r\nl2 changed\r\nl3\r\n");

    const snapshot = await capture(repo);
    const fresh = git(repo, [...DIFF_ARGS]);
    expect(snapshot.diffBytes.equals(fresh.stdout)).toBe(true);
    expect(reassemble(snapshot.files).equals(fresh.stdout)).toBe(true);
    expect(paths(snapshot)).toEqual(["src/norm.ts"]);

    const hunk = fileByPath(snapshot, "src/norm.ts").hunks[0];
    expect(hunk?.added).toBe(1);
    expect(hunk?.removed).toBe(1);
  });

  it("uses GIT_INDEX_FILE for the index path", async () => {
    const repo = newRepo();
    writeFile(repo, "a.txt", "a\n");
    commitAll(repo, "init");
    writeFile(repo, "a.txt", "b\n");

    const alternate = join(newDir(), "alternate-index");
    copyFileSync(join(repo, ".git", "index"), alternate);
    process.env.GIT_INDEX_FILE = alternate;

    const snapshot = await capture(repo);
    expect(snapshot.indexPath).toBe(alternate);
    expect(snapshot.gitEnv).toEqual({ GIT_INDEX_FILE: alternate });
    expect(snapshot.indexHash).toBe(
      createHash("sha256").update(readFileSync(alternate)).digest("hex"),
    );
    expect(paths(snapshot)).toEqual(["a.txt"]);
  });

  it("resolves a relative GIT_INDEX_FILE against the process cwd", async () => {
    const repo = newRepo();
    writeFile(repo, "a.txt", "a\n");
    commitAll(repo, "init");
    writeFile(repo, "a.txt", "b\n");
    // deeper than process.cwd(), so a "../"-prefixed value cannot resolve alike from both bases
    const segments = Array.from({ length: process.cwd().split(sep).length }, (_, i) => `d${i}`);
    const nested = join(repo, ...segments);
    mkdirSync(nested, { recursive: true });

    const alternate = join(newDir(), "alternate-index");
    copyFileSync(join(repo, ".git", "index"), alternate);
    process.env.GIT_INDEX_FILE = alternate;
    writeFile(repo, "staged.txt", "s\n");
    gitOrThrow(repo, ["add", "staged.txt"]);
    const expectedHash = createHash("sha256").update(readFileSync(alternate)).digest("hex");
    const absolute = await capture(nested);

    process.env.GIT_INDEX_FILE = relative(process.cwd(), alternate);
    const snapshot = await capture(nested);

    expect(snapshot.indexPath).toBe(alternate);
    expect(snapshot.gitEnv).toEqual({ GIT_INDEX_FILE: alternate });
    expect(snapshot.indexHash).toBe(expectedHash);
    expect(snapshot.indexHash).toBe(absolute.indexHash);
    expect(snapshot.indexHash).not.toBe(createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
    expect(snapshot.diffHash).toBe(absolute.diffHash);
  });

  it("rejects an unborn repository", async () => {
    await expect(capture(newRepo())).rejects.toBeInstanceOf(UnbornRepositoryError);
  });

  it("rejects a directory outside a repository", async () => {
    await expect(capture(newDir())).rejects.toBeInstanceOf(NotARepositoryError);
  });

  it("rejects a bare repository", async () => {
    const dir = newDir();
    gitOrThrow(dir, ["init", "-q", "--bare", "."]);
    await expect(capture(dir)).rejects.toBeInstanceOf(NotARepositoryError);
  });

  it("rejects unmerged entries", async () => {
    const repo = newRepo();
    writeFile(repo, "f.txt", "one\n");
    commitAll(repo, "init");
    gitOrThrow(repo, ["checkout", "-q", "-b", "other"]);
    writeFile(repo, "f.txt", "two\n");
    commitAll(repo, "two");
    gitOrThrow(repo, ["checkout", "-q", "main"]);
    writeFile(repo, "f.txt", "three\n");
    commitAll(repo, "three");
    expect(git(repo, ["merge", "other"]).status).not.toBe(0);

    const error = await rejection(repo);
    expect(error).toBeInstanceOf(UnmergedEntriesError);
    if (error instanceof UnmergedEntriesError) {
      expect(error.paths).toEqual(["f.txt"]);
    }
  });

  it("rejects binary changes", async () => {
    const repo = newRepo();
    writeFile(repo, "assets/logo.png", Buffer.from([0, 1, 2, 3, 0, 4, 5, 6]));
    commitAll(repo, "init");
    writeFile(repo, "assets/logo.png", Buffer.from([0, 9, 9, 9, 0, 4, 5, 6, 7]));

    await expectUnsupported(repo, "binary", ["assets/logo.png"]);
  });

  it.skipIf(process.platform === "win32")("rejects symlink changes", async () => {
    const repo = newRepo();
    writeFile(repo, "target-one.txt", "one\n");
    writeFile(repo, "target-two.txt", "two\n");
    symlinkSync("target-one.txt", join(repo, "link"));
    commitAll(repo, "init");
    rmSync(join(repo, "link"));
    symlinkSync("target-two.txt", join(repo, "link"));

    await expectUnsupported(repo, "symlink", ["link"]);
  });

  it("rejects submodule changes", async () => {
    const upstream = newRepo();
    writeFile(upstream, "s.txt", "s1\n");
    commitAll(upstream, "s1");

    const repo = newRepo();
    writeFile(repo, "top.txt", "top\n");
    commitAll(repo, "top");
    gitOrThrow(repo, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      upstream,
      "vendor/sub",
    ]);
    commitAll(repo, "add submodule");
    writeFile(join(repo, "vendor", "sub"), "s.txt", "s2\n");
    commitAll(join(repo, "vendor", "sub"), "s2");

    await expectUnsupported(repo, "submodule", ["vendor/sub"]);
  });
});
