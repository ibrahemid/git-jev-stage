import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/main.js";
import { captureSnapshot } from "../../src/git/snapshot.js";
import type { Snapshot } from "../../src/types.js";
import { createTestIo } from "../helpers/cli.js";
import { answer, demoHunks, writeFakeScript } from "../helpers/demo.js";
import {
  commitAll,
  createDemoRepo,
  createTestGitRunner,
  git,
  gitOrThrow,
  gitText,
  mkRepo,
  mkTempDir,
  removeDir,
  writeFile,
} from "../helpers/repo.js";

const INTENT = "reject inactive and locked users at login";
const EXTRA_PATH = "src/extra.ts";

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
const NOTES_PATH = "docs/notes.md";

const UNUSUAL_PATHS = [
  'docs/say "hi".md',
  "docs/back\\slash.md",
  "docs/tab\there.md",
  "docs/spaced name.md",
  "docs/wéärd.md",
  "-dash.md",
];

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    removeDir(dir);
  }
});

function newDir(prefix?: string): string {
  const dir = mkTempDir(prefix);
  dirs.push(dir);
  return dir;
}

function newRepo(): string {
  const dir = mkRepo();
  dirs.push(dir);
  return dir;
}

function capture(cwd: string): Promise<Snapshot> {
  return captureSnapshot({ cwd, git: createTestGitRunner() });
}

function stagedPaths(repo: string): string[] {
  return gitOrThrow(repo, ["-c", "core.quotePath=false", "diff", "--cached", "--name-only", "-z"])
    .stdout.toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0)
    .map((path) => path.normalize("NFC"))
    .sort();
}

function includeEverything(snapshot: Snapshot, dir: string): string {
  const answers: Record<string, ReturnType<typeof answer>> = {};
  for (const file of snapshot.files) {
    for (const hunk of file.hunks) {
      answers[hunk.id] = answer("include", 0.9);
    }
  }
  return writeFakeScript(dir, answers);
}

describe("malformed answers through the cli", () => {
  it("leaves every unusable answer mixed and stages the rest", async () => {
    const dir = createDemoRepo();
    dirs.push(dir);
    writeFile(dir, EXTRA_PATH, "export const extra = 1;\n");
    gitOrThrow(dir, ["add", "-N", EXTRA_PATH]);

    const snapshot = await capture(dir);
    const ids = demoHunks(snapshot);
    const extra = snapshot.files.find((file) => file.path === EXTRA_PATH)?.hunks[0];
    if (extra === undefined) {
      throw new Error(`the demo repository has no hunk for ${EXTRA_PATH}`);
    }

    const script = join(newDir("git-jev-stage-script-"), "malformed.json");
    writeFileSync(
      script,
      [
        '{"answers":{',
        `"${ids.auth.id}":${JSON.stringify(answer("include", 0.94))},`,
        `"${ids.log.id}":{"raw":{"type":"choice","choice":"maybe","confidence":0.9,"probabilities":{"include":0.9}}},`,
        `"${ids.css.id}":{"raw":{"type":"choice","choice":"include","confidence":1e999,"probabilities":{"include":0.9}}},`,
        `"${ids.test.id}":{"raw":"include"}`,
        "}}",
      ].join(""),
    );
    const io = createTestIo({ cwd: dir, env: { GIT_JEV_STAGE_FAKE_PROVIDER: script } });

    await expect(run([INTENT, "--json", "--yes"], io.io)).resolves.toBe(0);

    const document = JSON.parse(io.stdout());
    const decisions = new Map<string, { decision: string; source: string }>();
    for (const file of document.files) {
      for (const hunk of file.hunks) {
        decisions.set(hunk.id, { decision: hunk.decision, source: hunk.source });
      }
    }

    expect(decisions.get(ids.auth.id)).toEqual({ decision: "include", source: "model" });
    expect(decisions.get(ids.log.id)).toEqual({ decision: "mixed", source: "invalid" });
    expect(decisions.get(ids.css.id)).toEqual({ decision: "mixed", source: "invalid" });
    expect(decisions.get(ids.test.id)).toEqual({ decision: "mixed", source: "invalid" });
    expect(decisions.get(extra.id)).toEqual({ decision: "mixed", source: "missing" });

    expect(document.applied).toBe(true);
    expect(document.stagedHunkIds).toEqual([ids.auth.id]);
    expect([...document.mixedHunkIds].sort()).toEqual(
      [ids.log.id, ids.css.id, ids.test.id, extra.id].sort(),
    );
    expect(stagedPaths(dir)).toEqual(["src/auth/login.ts"]);
    const stagedLogin = git(dir, ["show", ":src/auth/login.ts"]).stdout.toString("utf8");
    expect(stagedLogin).toContain("if (user.lockedUntil && user.lockedUntil > Date.now())");
    expect(stagedLogin).not.toContain("console.log");
    expect(io.stderr()).toContain("left unstaged: 4 mixed hunks\n");
  });
});

describe("unusual file names through the cli", () => {
  it.skipIf(process.platform === "win32")("stages every one with --json --yes", async () => {
    const repo = newRepo();
    for (const path of UNUSUAL_PATHS) {
      writeFile(repo, path, `before ${path}\ntail\n`);
    }
    commitAll(repo, "init");
    for (const path of UNUSUAL_PATHS) {
      writeFile(repo, path, `after ${path}\ntail\n`);
    }

    const snapshot = await capture(repo);
    const script = includeEverything(snapshot, newDir("git-jev-stage-script-"));
    const io = createTestIo({ cwd: repo, env: { GIT_JEV_STAGE_FAKE_PROVIDER: script } });

    await expect(run([INTENT, "--json", "--yes"], io.io)).resolves.toBe(0);

    const document = JSON.parse(io.stdout());
    const expected = UNUSUAL_PATHS.map((path) => path.normalize("NFC")).sort();
    expect(
      document.files.map((file: { path: string }) => file.path.normalize("NFC")).sort(),
    ).toEqual(expected);
    expect(document.stagedHunkIds).toHaveLength(UNUSUAL_PATHS.length);
    expect(stagedPaths(repo)).toEqual(expected);
    expect(git(repo, ["diff"]).stdout).toHaveLength(0);
  });
});

describe("binary files through the cli", () => {
  it("names every binary path and stages nothing", async () => {
    const repo = newRepo();
    writeFile(repo, "assets/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x01]));
    writeFile(repo, "assets/tone.wav", Buffer.from([0x52, 0x49, 0x46, 0x00, 0x02]));
    writeFile(repo, "src/app.ts", "export const app = 1;\n");
    commitAll(repo, "init");
    writeFile(repo, "assets/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x09]));
    writeFile(repo, "assets/tone.wav", Buffer.from([0x52, 0x49, 0x46, 0x00, 0x08]));
    writeFile(repo, "src/app.ts", "export const app = 2;\n");

    const script = writeFakeScript(newDir("git-jev-stage-script-"), {});
    const io = createTestIo({ cwd: repo, env: { GIT_JEV_STAGE_FAKE_PROVIDER: script } });

    await expect(run([INTENT, "--json", "--yes"], io.io)).resolves.toBe(1);

    expect(io.stderr()).toBe(
      "git-jev-stage: unsupported-entry: binary entries cannot be staged by hunk: assets/logo.png, assets/tone.wav\n",
    );
    expect(io.stdout()).toBe("");
    expect(stagedPaths(repo)).toEqual([]);
  });
});

async function mixedRepo(): Promise<{ dir: string; env: Record<string, string>; mixed: string }> {
  const repo = newRepo();
  writeFile(repo, SESSION_PATH, SESSION_BEFORE);
  writeFile(repo, NOTES_PATH, "# notes\n\nold line\n");
  commitAll(repo, "init");
  writeFile(repo, SESSION_PATH, SESSION_AFTER);
  writeFile(repo, NOTES_PATH, "# notes\n\nnew line\n");

  const snapshot = await capture(repo);
  const session = snapshot.files.find((file) => file.path === SESSION_PATH);
  const notes = snapshot.files.find((file) => file.path === NOTES_PATH);
  expect(session?.hunks).toHaveLength(1);
  const mixed = session?.hunks[0];
  const included = notes?.hunks[0];
  if (mixed === undefined || included === undefined) {
    throw new Error("the mixed repository is missing a hunk");
  }
  expect(mixed.added).toBe(2);
  expect(mixed.removed).toBe(1);

  const script = writeFakeScript(newDir("git-jev-stage-script-"), {
    [mixed.id]: answer("mixed", 0.51),
    [included.id]: answer("include", 0.88),
  });
  return { dir: repo, env: { GIT_JEV_STAGE_FAKE_PROVIDER: script }, mixed: mixed.id };
}

describe("an interleaved hunk the model calls mixed", () => {
  it("stays unstaged under --yes and is reported", async () => {
    const { dir, env, mixed } = await mixedRepo();
    const io = createTestIo({ cwd: dir, env });

    await expect(run([INTENT, "--json", "--yes"], io.io)).resolves.toBe(0);

    const document = JSON.parse(io.stdout());
    expect(document.mixedHunkIds).toEqual([mixed]);
    expect(document.stagedHunkIds).not.toContain(mixed);
    expect(stagedPaths(dir)).toEqual([NOTES_PATH]);
    expect(git(dir, ["show", `:${SESSION_PATH}`]).stdout.toString("utf8")).toBe(SESSION_BEFORE);
  });

  it("is staged whole when the prompt is answered", async () => {
    const { dir, env } = await mixedRepo();
    const io = createTestIo({
      cwd: dir,
      env,
      isStdinTty: true,
      answers: ["y", "y"],
    });

    await expect(run([INTENT], io.io)).resolves.toBe(0);

    expect(io.pending()).toBe(0);
    expect(io.stdout()).toContain("stage this hunk? [y/N] ");
    expect(io.stdout()).toContain("stage 2 hunks in 2 files? [y/N] ");
    expect(io.stdout()).toContain("staged 2 hunks in 2 files\n");
    expect(io.stdout()).not.toContain("left unstaged");
    expect(git(dir, ["show", `:${SESSION_PATH}`]).stdout.toString("utf8")).toBe(SESSION_AFTER);
    expect(stagedPaths(dir)).toEqual([NOTES_PATH, SESSION_PATH]);
    expect(gitText(dir, ["diff", "--name-only"])).toBe("");
  });
});
