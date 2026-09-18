import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IndexLockedError, PatchApplyError, StaleSnapshotError } from "../../src/errors.js";
import { applyPatchToIndex, stageHunks } from "../../src/git/applySelection.js";
import { composePatch } from "../../src/git/composePatch.js";
import { captureSnapshot, DIFF_ARGS } from "../../src/git/snapshot.js";
import type { Hunk, Snapshot } from "../../src/types.js";
import {
  commitAll,
  createTestGitRunner,
  git,
  gitOrThrow,
  gitText,
  mkRepo,
  mkTempDir,
  removeDir,
  writeFile,
} from "../helpers/repo.js";

const LOGIN_PATH = "src/auth/login.ts";
const CSS_PATH = "styles/app.css";
const TEST_PATH = "test/login.test.ts";

const LOGIN_LINES = [
  'import { hash } from "./hash.js";',
  "",
  "export function login(user, password) {",
  "  const token = hash(password);",
  "  if (token === undefined) {",
  "    return null;",
  "  }",
  "  return { user, token };",
  "}",
  "",
  "export function logout(session) {",
  "  session.clear();",
  "}",
  "",
  "export function refresh(session) {",
  "  return session.renew();",
  "}",
  "",
  "export function audit(event) {",
  "  events.push(event);",
  "}",
  "",
  "export function report() {",
  "  return events.length;",
  "}",
  "",
  "export function reset() {",
  "  events.length = 0;",
  "}",
  "",
  "export function count() {",
  "  return events.length;",
  "}",
];

const LOGIN_AUTH_LINES = [
  "  const salt = lookupSalt(user);",
  "  const token = hash(password, salt);",
];
const LOGIN_LOG_LINE = '  console.log("count", events.length);';
const LOGIN_AUTH_INDEX = 3;
const LOGIN_LOG_INDEX = 30;

const QUOTE_PATH = 'docs/say "hi".md';
const TAB_PATH = "docs/tab\there.md";
const UNUSUAL_PATHS = [QUOTE_PATH, "docs/spaced name.md", TAB_PATH, "docs/wéärd.md"];

const CSS_BEFORE = ".button {\n  color: #111;\n  padding: 4px;\n}\n";
const CSS_AFTER = ".button {\n  color: #1a1a1a;\n  padding: 4px;\n}\n";
const TEST_BEFORE =
  'import { login } from "../src/auth/login.js";\n\ntest("login", () => {\n  expect(login("a", "b")).toBeTruthy();\n});\n';
const TEST_AFTER =
  'import { login } from "../src/auth/login.js";\n\ntest("login", () => {\n  expect(login("a", "b", "c")).toBeTruthy();\n});\n';

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

function stage(snapshot: Snapshot, ids: Iterable<string>): Promise<Buffer> {
  return stageHunks(snapshot, new Set(ids), createTestGitRunner());
}

function loginSource(options: { auth: boolean; log: boolean }): string {
  const lines = [...LOGIN_LINES];
  if (options.log) {
    lines.splice(LOGIN_LOG_INDEX, 0, LOGIN_LOG_LINE);
  }
  if (options.auth) {
    lines.splice(LOGIN_AUTH_INDEX, 1, ...LOGIN_AUTH_LINES);
  }
  return `${lines.join("\n")}\n`;
}

function demoRepo(): string {
  const repo = newRepo();
  writeFile(repo, LOGIN_PATH, loginSource({ auth: false, log: false }));
  writeFile(repo, CSS_PATH, CSS_BEFORE);
  writeFile(repo, TEST_PATH, TEST_BEFORE);
  commitAll(repo, "init");

  writeFile(repo, LOGIN_PATH, loginSource({ auth: true, log: true }));
  writeFile(repo, CSS_PATH, CSS_AFTER);
  writeFile(repo, TEST_PATH, TEST_AFTER);
  return repo;
}

async function demoSnapshot(repo: string): Promise<Snapshot> {
  const snapshot = await capture(repo);
  expect(snapshot.files.map((file) => file.path)).toEqual([LOGIN_PATH, CSS_PATH, TEST_PATH]);
  expect(allIds(snapshot)).toHaveLength(4);
  return snapshot;
}

function hunkAt(snapshot: Snapshot, path: string, ordinal: number): Hunk {
  const file = snapshot.files.find((candidate) => candidate.path.normalize("NFC") === path);
  const hunk = file?.hunks[ordinal];
  if (hunk === undefined) {
    throw new Error(`no hunk ${ordinal} for ${path}`);
  }
  return hunk;
}

function allIds(snapshot: Snapshot): string[] {
  return snapshot.files.flatMap((file) => file.hunks.map((hunk) => hunk.id));
}

function hunkBody(hunk: Hunk): Buffer {
  const newline = hunk.bytes.indexOf(0x0a);
  return hunk.bytes.subarray(newline + 1);
}

function diffBytes(repo: string, extra: string[] = []): Buffer {
  const result = git(repo, [...DIFF_ARGS, ...extra]);
  if (result.status !== 0) {
    throw new Error(`git diff exited ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function leftovers(indexPath: string): string[] {
  const base = basename(indexPath);
  return readdirSync(dirname(indexPath))
    .filter((name) => name === `${base}.lock` || name.startsWith(`${base}.jev-stage-`))
    .sort();
}

function worktreeFiles(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      if (entry.name === ".git") {
        continue;
      }
      const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(next);
      } else {
        files.set(next, fileHash(join(dir, next)));
      }
    }
  };
  walk("");
  return files;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

async function expectStale(
  snapshot: Snapshot,
  ids: Iterable<string>,
  which: "head" | "index" | "diff",
): Promise<void> {
  const before = fileHash(snapshot.indexPath);
  const error = await rejection(stage(snapshot, ids));

  expect(error).toBeInstanceOf(StaleSnapshotError);
  if (error instanceof StaleSnapshotError) {
    expect(error.which).toBe(which);
    expect(error.exitCode).toBe(3);
  }
  expect(fileHash(snapshot.indexPath)).toBe(before);
  expect(leftovers(snapshot.indexPath)).toEqual([]);
}

describe("applySelection", () => {
  it("stages the selected hunks and leaves the rest in the working tree", async () => {
    const repo = demoRepo();
    const before = worktreeFiles(repo);
    const snapshot = await demoSnapshot(repo);
    const auth = hunkAt(snapshot, LOGIN_PATH, 0);
    const log = hunkAt(snapshot, LOGIN_PATH, 1);
    const css = hunkAt(snapshot, CSS_PATH, 0);
    const testHunk = hunkAt(snapshot, TEST_PATH, 0);

    await stage(snapshot, [auth.id, testHunk.id]);

    const cached = diffBytes(repo, ["--cached"]);
    const unstaged = diffBytes(repo);

    expect(cached.includes(hunkBody(auth))).toBe(true);
    expect(cached.includes(hunkBody(testHunk))).toBe(true);
    expect(cached.includes(hunkBody(log))).toBe(false);
    expect(cached.includes(hunkBody(css))).toBe(false);

    expect(unstaged.includes(hunkBody(log))).toBe(true);
    expect(unstaged.includes(hunkBody(css))).toBe(true);
    expect(unstaged.includes(hunkBody(auth))).toBe(false);
    expect(unstaged.includes(hunkBody(testHunk))).toBe(false);

    expect(worktreeFiles(repo)).toEqual(before);
    expect(leftovers(snapshot.indexPath)).toEqual([]);
  });

  it("reassembles every original hunk from the staged and unstaged diffs", async () => {
    const repo = demoRepo();
    const snapshot = await demoSnapshot(repo);
    const auth = hunkAt(snapshot, LOGIN_PATH, 0);
    const testHunk = hunkAt(snapshot, TEST_PATH, 0);
    const selected = new Set([auth.id, testHunk.id]);

    await stage(snapshot, selected);

    const cached = diffBytes(repo, ["--cached"]);
    const unstaged = diffBytes(repo);

    for (const file of snapshot.files) {
      for (const hunk of file.hunks) {
        const staged = selected.has(hunk.id);
        const side = staged ? cached : unstaged;
        const other = staged ? unstaged : cached;
        expect(side.includes(hunkBody(hunk))).toBe(true);
        expect(other.includes(hunkBody(hunk))).toBe(false);
      }
    }

    expect(cached.includes(auth.bytes)).toBe(true);
    expect(cached.includes(testHunk.bytes)).toBe(true);
    expect(statusLines(repo)).toEqual([`MM ${LOGIN_PATH}`, ` M ${CSS_PATH}`, `M  ${TEST_PATH}`]);
  });

  it("stages a later hunk when an earlier hunk of the same file is skipped", async () => {
    const repo = demoRepo();
    const snapshot = await demoSnapshot(repo);
    const auth = hunkAt(snapshot, LOGIN_PATH, 0);
    const log = hunkAt(snapshot, LOGIN_PATH, 1);

    await stage(snapshot, [log.id]);

    expect(git(repo, ["show", `:${LOGIN_PATH}`]).stdout.toString("utf8")).toBe(
      loginSource({ auth: false, log: true }),
    );
    const cached = diffBytes(repo, ["--cached"]);
    expect(cached.includes(hunkBody(log))).toBe(true);
    expect(cached.includes(hunkBody(auth))).toBe(false);
    expect(diffBytes(repo).includes(hunkBody(auth))).toBe(true);
  });

  it("stages every hunk", async () => {
    const repo = demoRepo();
    const snapshot = await demoSnapshot(repo);

    await stage(snapshot, allIds(snapshot));

    expect(diffBytes(repo, ["--cached"]).equals(snapshot.diffBytes)).toBe(true);
    expect(diffBytes(repo)).toHaveLength(0);
    expect(leftovers(snapshot.indexPath)).toEqual([]);
  });

  it("matches a full `git add -A` staging of the same tree", async () => {
    const repo = newRepo();
    writeFile(repo, LOGIN_PATH, loginSource({ auth: false, log: false }));
    writeFile(repo, "src/old.ts", "export const removed = true;\n");
    commitAll(repo, "init");
    writeFile(repo, LOGIN_PATH, loginSource({ auth: true, log: true }));
    rmSync(join(repo, "src/old.ts"));
    writeFile(repo, "src/new.ts", "export const created = true;\n");
    gitOrThrow(repo, ["add", "-N", "src/new.ts"]);

    const oracle = join(newDir(), "oracle");
    cpSync(repo, oracle, { recursive: true });
    gitOrThrow(oracle, ["add", "-A"]);
    const expected = gitText(oracle, ["write-tree"]);

    const snapshot = await capture(repo);
    await stage(snapshot, allIds(snapshot));

    expect(gitText(repo, ["write-tree"])).toBe(expected);
  });

  it("does nothing when no hunk is selected", async () => {
    const repo = demoRepo();
    const snapshot = await demoSnapshot(repo);
    const before = fileHash(snapshot.indexPath);

    const patch = await stage(snapshot, []);

    expect(patch).toHaveLength(0);
    expect(fileHash(snapshot.indexPath)).toBe(before);
    expect(diffBytes(repo).equals(snapshot.diffBytes)).toBe(true);
    expect(diffBytes(repo, ["--cached"])).toHaveLength(0);
    expect(leftovers(snapshot.indexPath)).toEqual([]);
  });

  it("keeps pre-existing staged changes in another file", async () => {
    const repo = demoRepo();
    gitOrThrow(repo, ["add", CSS_PATH]);
    const snapshot = await capture(repo);
    const auth = hunkAt(snapshot, LOGIN_PATH, 0);

    await stage(snapshot, [auth.id]);

    const cached = diffBytes(repo, ["--cached"]);
    expect(cached.includes(Buffer.from("+  color: #1a1a1a;"))).toBe(true);
    expect(cached.includes(hunkBody(auth))).toBe(true);
    expect(statusLines(repo)).toEqual([`MM ${LOGIN_PATH}`, `M  ${CSS_PATH}`, ` M ${TEST_PATH}`]);
  });

  it("refuses to stage when the working tree changed after the snapshot", async () => {
    const repo = demoRepo();
    const snapshot = await demoSnapshot(repo);
    const auth = hunkAt(snapshot, LOGIN_PATH, 0);
    writeFile(repo, CSS_PATH, `${CSS_AFTER}.late {}\n`);

    await expectStale(snapshot, [auth.id], "diff");
  });

  it("refuses to stage when the index changed after the snapshot", async () => {
    const repo = demoRepo();
    const snapshot = await demoSnapshot(repo);
    const auth = hunkAt(snapshot, LOGIN_PATH, 0);
    writeFile(repo, "notes.txt", "later\n");
    gitOrThrow(repo, ["add", "notes.txt"]);

    await expectStale(snapshot, [auth.id], "index");
  });

  it("refuses to stage when HEAD moved after the snapshot", async () => {
    const repo = demoRepo();
    const snapshot = await demoSnapshot(repo);
    const auth = hunkAt(snapshot, LOGIN_PATH, 0);
    gitOrThrow(repo, ["commit", "-q", "--allow-empty", "-m", "later"]);

    await expectStale(snapshot, [auth.id], "head");
  });

  it("refuses to stage while another process holds the index lock", async () => {
    const repo = demoRepo();
    const snapshot = await demoSnapshot(repo);
    const auth = hunkAt(snapshot, LOGIN_PATH, 0);
    const lockPath = `${snapshot.indexPath}.lock`;
    writeFileSync(lockPath, "held by another git process\n");
    const before = fileHash(snapshot.indexPath);

    const error = await rejection(stage(snapshot, [auth.id]));

    expect(error).toBeInstanceOf(IndexLockedError);
    if (error instanceof IndexLockedError) {
      expect(error.lockPath).toBe(lockPath);
      expect(error.exitCode).toBe(3);
    }
    expect(readFileSync(lockPath).toString("utf8")).toBe("held by another git process\n");
    expect(fileHash(snapshot.indexPath)).toBe(before);
    expect(leftovers(snapshot.indexPath)).toEqual([basename(lockPath)]);
  });

  it("reports a patch that does not apply and leaves the index untouched", async () => {
    const repo = demoRepo();
    const snapshot = await demoSnapshot(repo);
    const auth = hunkAt(snapshot, LOGIN_PATH, 0);
    const patch = Buffer.from(composePatch(snapshot.files, new Set([auth.id])));
    const at = patch.indexOf(Buffer.from("import { hash }"));
    patch.write("import { HASH }", at, "utf8");
    const before = fileHash(snapshot.indexPath);

    const error = await rejection(
      applyPatchToIndex({ snapshot, patch, git: createTestGitRunner() }),
    );

    expect(error).toBeInstanceOf(PatchApplyError);
    if (error instanceof PatchApplyError) {
      expect(error.stderr).not.toContain("import { HASH }");
      expect(error.message).toContain("git apply failed");
    }
    expect(fileHash(snapshot.indexPath)).toBe(before);
    expect(leftovers(snapshot.indexPath)).toEqual([]);
  });

  it("stages a CRLF file byte for byte", async () => {
    const repo = newRepo();
    writeFile(repo, "src/crlf.ts", "c1\r\nc2\r\nc3\r\n");
    commitAll(repo, "init");
    writeFile(repo, "src/crlf.ts", "c1\r\nc2 changed\r\nc3\r\n");

    const snapshot = await capture(repo);
    await stage(snapshot, allIds(snapshot));

    expect(
      git(repo, ["show", ":src/crlf.ts"]).stdout.equals(readFileSync(join(repo, "src/crlf.ts"))),
    ).toBe(true);
    expect(diffBytes(repo)).toHaveLength(0);
    expect(diffBytes(repo, ["--cached"]).includes(Buffer.from("+c2 changed\r\n"))).toBe(true);
  });

  it("stages a CRLF working file under .gitattributes text=auto", async () => {
    const repo = newRepo();
    writeFile(repo, ".gitattributes", "* text=auto\n");
    writeFile(repo, "src/norm.ts", "l1\nl2\nl3\n");
    commitAll(repo, "init");
    writeFile(repo, "src/norm.ts", "l1\r\nl2 changed\r\nl3\r\n");

    const snapshot = await capture(repo);
    await stage(snapshot, allIds(snapshot));

    expect(git(repo, ["show", ":src/norm.ts"]).stdout.toString("utf8")).toBe(
      "l1\nl2 changed\nl3\n",
    );
    expect(readFileSync(join(repo, "src/norm.ts")).toString("utf8")).toBe(
      "l1\r\nl2 changed\r\nl3\r\n",
    );
    expect(diffBytes(repo)).toHaveLength(0);
  });

  it.skipIf(process.platform === "win32")("stages unusual file names", async () => {
    const repo = newRepo();
    for (const path of UNUSUAL_PATHS) {
      writeFile(repo, path, "before\ntail\n");
    }
    commitAll(repo, "init");
    for (const path of UNUSUAL_PATHS) {
      writeFile(repo, path, "after\ntail\n");
    }

    const snapshot = await capture(repo);
    await stage(snapshot, [hunkAt(snapshot, QUOTE_PATH, 0).id, hunkAt(snapshot, TAB_PATH, 0).id]);

    expect(stagedPaths(repo)).toEqual(sortedNfc([QUOTE_PATH, TAB_PATH]));

    const rest = await capture(repo);
    await stage(rest, allIds(rest));
    expect(stagedPaths(repo)).toEqual(sortedNfc(UNUSUAL_PATHS));
    expect(diffBytes(repo)).toHaveLength(0);
  });

  it("stages a deleted file and an added file", async () => {
    const repo = newRepo();
    writeFile(repo, "src/old.ts", "export const removed = true;\n");
    writeFile(repo, "src/keep.ts", "export const kept = 1;\n");
    commitAll(repo, "init");
    rmSync(join(repo, "src/old.ts"));
    writeFile(repo, "src/new.ts", "export const created = true;\n");
    gitOrThrow(repo, ["add", "-N", "src/new.ts"]);
    writeFile(repo, "src/keep.ts", "export const kept = 22;\n");

    const snapshot = await capture(repo);
    await stage(snapshot, [
      hunkAt(snapshot, "src/old.ts", 0).id,
      hunkAt(snapshot, "src/new.ts", 0).id,
    ]);

    expect(gitText(repo, ["diff", "--cached", "--name-status"]).split("\n").sort()).toEqual([
      "A\tsrc/new.ts",
      "D\tsrc/old.ts",
    ]);
    expect(statusLines(repo)).toEqual([" M src/keep.ts", "A  src/new.ts", "D  src/old.ts"]);
    expect(readFileSync(join(repo, "src/new.ts")).toString("utf8")).toBe(
      "export const created = true;\n",
    );
  });

  it("stages into the index named by GIT_INDEX_FILE", async () => {
    const repo = demoRepo();
    const alternate = join(newDir(), "alternate-index");
    copyFileSync(join(repo, ".git", "index"), alternate);
    process.env.GIT_INDEX_FILE = alternate;
    const realIndexBefore = fileHash(join(repo, ".git", "index"));

    const snapshot = await capture(repo);
    expect(snapshot.indexPath).toBe(alternate);
    const auth = hunkAt(snapshot, LOGIN_PATH, 0);
    await stage(snapshot, [auth.id]);

    expect(fileHash(join(repo, ".git", "index"))).toBe(realIndexBefore);
    expect(fileHash(alternate)).not.toBe(snapshot.indexHash);
    expect(diffBytes(repo, ["--cached"]).includes(hunkBody(auth))).toBe(true);
    expect(leftovers(alternate)).toEqual([]);
  });

  it("builds the temp index from HEAD when the index file is gone", async () => {
    const repo = demoRepo();
    const snapshot = await demoSnapshot(repo);
    const auth = hunkAt(snapshot, LOGIN_PATH, 0);
    rmSync(snapshot.indexPath);

    const error = await rejection(stage(snapshot, [auth.id]));

    expect(error).toBeInstanceOf(StaleSnapshotError);
    if (error instanceof StaleSnapshotError) {
      expect(error.which).toBe("index");
    }
    expect(existsSync(snapshot.indexPath)).toBe(false);
    expect(leftovers(snapshot.indexPath)).toEqual([]);
  });
});

function sortedNfc(paths: readonly string[]): string[] {
  return paths.map((path) => path.normalize("NFC")).sort();
}

function statusLines(repo: string): string[] {
  return gitOrThrow(repo, ["status", "--porcelain"])
    .stdout.toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

function stagedPaths(repo: string): string[] {
  const result = gitOrThrow(repo, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--cached",
    "--name-only",
    "-z",
  ]);
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0)
    .map((path) => path.normalize("NFC"))
    .sort();
}
