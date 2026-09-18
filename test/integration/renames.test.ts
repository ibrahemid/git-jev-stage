import { createHash } from "node:crypto";
import { cpSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stageHunks } from "../../src/git/applySelection.js";
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

const SHIP_PATH = "src/ship.ts";
const DELIVER_PATH = "src/deliver.ts";
const SHIP_SOURCE = "export function ship(payload) {\n  return send(payload);\n}\n";
const DELIVER_SOURCE =
  "export function ship(payload) {\n  return send(payload, { retry: 2 });\n}\n";

const SESSION_PATH = "src/session.ts";
const SESSION_BEFORE = [
  'import { findUser } from "./service";',
  "",
  "export function open(req, res) {",
  "  const user = findUser(req.body.email);",
  "  if (!user) return res.status(401).end();",
  "  return res.json({ id: user.id });",
  "}",
  "",
].join("\n");
const SESSION_AFTER = [
  'import { findUser } from "./service";',
  "",
  "export function open(req, res) {",
  "  const user = findUser(req.body.email);",
  "  if (!user || !user.active) return res.status(401).end();",
  '  console.log("open", req.body.email);',
  "  return res.json({ id: user.id });",
  "}",
  "",
].join("\n");

const CRLF_PATH = "src/crlf.ts";
const QUOTE_PATH = 'docs/say "hi".md';
const BACKSLASH_PATH = "docs/back\\slash.md";
const TAB_PATH = "docs/tab\there.md";
const DASH_PATH = "-dash.md";
const UNUSUAL_PATHS = [
  QUOTE_PATH,
  BACKSLASH_PATH,
  TAB_PATH,
  DASH_PATH,
  "docs/spaced name.md",
  "docs/wéärd.md",
];

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    removeDir(dir);
  }
});

function newRepo(): string {
  const dir = mkRepo();
  dirs.push(dir);
  return dir;
}

function capture(cwd: string): Promise<Snapshot> {
  return captureSnapshot({ cwd, git: createTestGitRunner() });
}

function stage(snapshot: Snapshot, ids: Iterable<string>): Promise<Buffer> {
  return stageHunks(snapshot, new Set(ids), createTestGitRunner());
}

function diffBytes(repo: string, extra: string[] = []): Buffer {
  const result = git(repo, [...DIFF_ARGS, ...extra]);
  if (result.status !== 0) {
    throw new Error(`git diff exited ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function hunkAt(snapshot: Snapshot, path: string, ordinal: number): Hunk {
  const file = snapshot.files.find((candidate) => candidate.path.normalize("NFC") === path);
  const hunk = file?.hunks[ordinal];
  if (hunk === undefined) {
    throw new Error(`no hunk ${ordinal} for ${path}`);
  }
  return hunk;
}

function hunkBody(hunk: Hunk): Buffer {
  return hunk.bytes.subarray(hunk.bytes.indexOf(0x0a) + 1);
}

function allIds(snapshot: Snapshot): string[] {
  return snapshot.files.flatMap((file) => file.hunks.map((hunk) => hunk.id));
}

function nameStatus(repo: string, extra: string[] = []): string[] {
  return gitText(repo, ["diff", "--no-renames", "--name-status", ...extra])
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.normalize("NFC"))
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
        files.set(
          next.normalize("NFC"),
          createHash("sha256")
            .update(readFileSync(join(dir, next)))
            .digest("hex"),
        );
      }
    }
  };
  walk("");
  return files;
}

function renameRepo(contents = SHIP_SOURCE): string {
  const repo = newRepo();
  writeFile(repo, SHIP_PATH, SHIP_SOURCE);
  writeFile(repo, "src/keep.ts", "export const kept = 1;\n");
  commitAll(repo, "init");
  rmSync(join(repo, SHIP_PATH));
  writeFile(repo, DELIVER_PATH, contents);
  gitOrThrow(repo, ["add", "-N", DELIVER_PATH]);
  return repo;
}

describe("renames", () => {
  it("reports a rename as a deletion and an addition", async () => {
    const repo = renameRepo();

    const snapshot = await capture(repo);

    expect(snapshot.files.map((file) => ({ path: file.path, kind: file.kind }))).toEqual([
      { path: DELIVER_PATH, kind: "added" },
      { path: SHIP_PATH, kind: "deleted" },
    ]);
    expect(hunkAt(snapshot, DELIVER_PATH, 0).added).toBe(3);
    expect(hunkAt(snapshot, DELIVER_PATH, 0).removed).toBe(0);
    expect(hunkAt(snapshot, SHIP_PATH, 0).added).toBe(0);
    expect(hunkAt(snapshot, SHIP_PATH, 0).removed).toBe(3);
  });

  it("stages only the addition and leaves the deletion unstaged", async () => {
    const repo = renameRepo();
    const snapshot = await capture(repo);
    const addition = hunkAt(snapshot, DELIVER_PATH, 0);
    const deletion = hunkAt(snapshot, SHIP_PATH, 0);

    await stage(snapshot, [addition.id]);

    expect(nameStatus(repo, ["--cached"])).toEqual([`A\t${DELIVER_PATH}`]);
    expect(nameStatus(repo)).toEqual([`D\t${SHIP_PATH}`]);
    expect(git(repo, ["show", `:${DELIVER_PATH}`]).stdout.toString("utf8")).toBe(SHIP_SOURCE);
    expect(git(repo, ["show", `:${SHIP_PATH}`]).stdout.toString("utf8")).toBe(SHIP_SOURCE);
    expect(diffBytes(repo, ["--cached"]).includes(hunkBody(addition))).toBe(true);
    expect(diffBytes(repo).includes(hunkBody(deletion))).toBe(true);
  });

  it("stages only the deletion and leaves the addition unstaged", async () => {
    const repo = renameRepo();
    const snapshot = await capture(repo);
    const addition = hunkAt(snapshot, DELIVER_PATH, 0);
    const deletion = hunkAt(snapshot, SHIP_PATH, 0);

    await stage(snapshot, [deletion.id]);

    expect(nameStatus(repo, ["--cached"])).toEqual([`D\t${SHIP_PATH}`]);
    expect(nameStatus(repo)).toEqual([`A\t${DELIVER_PATH}`]);
    expect(git(repo, ["show", `:${DELIVER_PATH}`]).stdout).toHaveLength(0);
    expect(diffBytes(repo, ["--cached"]).includes(hunkBody(deletion))).toBe(true);
    expect(diffBytes(repo).includes(hunkBody(addition))).toBe(true);
    expect(readFileSync(join(repo, DELIVER_PATH)).toString("utf8")).toBe(SHIP_SOURCE);
  });

  it("stages a rename that also changed content", async () => {
    const repo = renameRepo(DELIVER_SOURCE);
    const snapshot = await capture(repo);
    const addition = hunkAt(snapshot, DELIVER_PATH, 0);

    expect(addition.text).toContain("+  return send(payload, { retry: 2 });");
    await stage(snapshot, allIds(snapshot));

    expect(nameStatus(repo, ["--cached"])).toEqual([`A\t${DELIVER_PATH}`, `D\t${SHIP_PATH}`]);
    expect(git(repo, ["show", `:${DELIVER_PATH}`]).stdout.toString("utf8")).toBe(DELIVER_SOURCE);
    expect(diffBytes(repo)).toHaveLength(0);
    expect(git(repo, ["show", `:${SHIP_PATH}`]).status).not.toBe(0);
  });
});

function hardRepo(): string {
  const repo = newRepo();
  writeFile(repo, SESSION_PATH, SESSION_BEFORE);
  writeFile(repo, CRLF_PATH, "c1\r\nc2\r\nc3\r\n");
  writeFile(repo, SHIP_PATH, SHIP_SOURCE);
  for (const path of UNUSUAL_PATHS) {
    writeFile(repo, path, `before ${path}\ntail\n`);
  }
  commitAll(repo, "init");

  writeFile(repo, SESSION_PATH, SESSION_AFTER);
  writeFile(repo, CRLF_PATH, "c1\r\nc2 changed\r\nc3\r\n");
  rmSync(join(repo, SHIP_PATH));
  writeFile(repo, DELIVER_PATH, SHIP_SOURCE);
  gitOrThrow(repo, ["add", "-N", DELIVER_PATH]);
  for (const path of UNUSUAL_PATHS) {
    writeFile(repo, path, `after ${path}\ntail\n`);
  }
  return repo;
}

describe("round trip", () => {
  it("loses no data when a subset is staged and the rest follows", async () => {
    const repo = hardRepo();
    const oracle = join(mkTempDir(), "oracle");
    dirs.push(oracle);
    cpSync(repo, oracle, { recursive: true });
    gitOrThrow(oracle, ["add", "-A"]);
    const oracleTree = gitText(oracle, ["write-tree"]);
    const before = worktreeFiles(repo);

    const snapshot = await capture(repo);
    const selected = new Set([
      hunkAt(snapshot, SESSION_PATH, 0).id,
      hunkAt(snapshot, QUOTE_PATH, 0).id,
      hunkAt(snapshot, SHIP_PATH, 0).id,
    ]);
    await stage(snapshot, selected);

    const cached = diffBytes(repo, ["--cached"]);
    const unstaged = diffBytes(repo);
    for (const file of snapshot.files) {
      for (const hunk of file.hunks) {
        const side = selected.has(hunk.id) ? cached : unstaged;
        const other = selected.has(hunk.id) ? unstaged : cached;
        expect(side.includes(hunkBody(hunk)), `${file.path}#${hunk.ordinal}`).toBe(true);
        expect(other.includes(hunkBody(hunk)), `${file.path}#${hunk.ordinal}`).toBe(false);
      }
    }
    expect(worktreeFiles(repo)).toEqual(before);

    const rest = await capture(repo);
    await stage(rest, allIds(rest));

    expect(diffBytes(repo)).toHaveLength(0);
    expect(gitText(repo, ["write-tree"])).toBe(oracleTree);
    expect(worktreeFiles(repo)).toEqual(before);
  });

  it("keeps the interleaved hunk whole", async () => {
    const repo = hardRepo();
    const snapshot = await capture(repo);
    const session = hunkAt(snapshot, SESSION_PATH, 0);

    expect(snapshot.files.find((file) => file.path === SESSION_PATH)?.hunks).toHaveLength(1);
    expect(session.added).toBe(2);
    expect(session.removed).toBe(1);

    await stage(snapshot, [session.id]);

    expect(git(repo, ["show", `:${SESSION_PATH}`]).stdout.toString("utf8")).toBe(SESSION_AFTER);
  });
});
