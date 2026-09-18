import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/main.js";
import { composePatch } from "../../src/git/composePatch.js";
import { captureSnapshot } from "../../src/git/snapshot.js";
import type { Snapshot } from "../../src/types.js";
import { createTestIo } from "../helpers/cli.js";
import { answer, type DemoHunks, demoHunks, writeFakeScript } from "../helpers/demo.js";
import {
  commitAll,
  createDemoRepo,
  createTestGitRunner,
  gitText,
  mkTempDir,
  removeDir,
} from "../helpers/repo.js";

const INTENT = "reject inactive and locked users at login";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      removeDir(dir);
    }
  }
});

interface DemoCli {
  dir: string;
  ids: DemoHunks;
  snapshot: Snapshot;
  env: Record<string, string | undefined>;
}

async function setupDemo(): Promise<DemoCli> {
  const dir = createDemoRepo();
  dirs.push(dir);
  const scriptDir = mkTempDir("git-jev-stage-script-");
  dirs.push(scriptDir);

  const snapshot = await captureSnapshot({ cwd: dir, git: createTestGitRunner() });
  const ids = demoHunks(snapshot);
  const script = writeFakeScript(scriptDir, {
    [ids.auth.id]: answer("include", 0.94),
    [ids.log.id]: answer("exclude", 0.91),
    [ids.css.id]: answer("mixed", 0.52),
    [ids.test.id]: answer("include", 0.83),
  });

  return { dir, ids, snapshot, env: { GIT_JEV_STAGE_FAKE_PROVIDER: script } };
}

function staged(dir: string): string {
  return gitText(dir, ["diff", "--cached", "--name-only"]);
}

describe("run --json", () => {
  it("prints the document, keeps the plan on stderr and stages nothing", async () => {
    const { dir, ids, env } = await setupDemo();
    const io = createTestIo({ cwd: dir, env });

    await expect(run([INTENT, "--json"], io.io)).resolves.toBe(0);

    const document = JSON.parse(io.stdout());
    expect(document.applied).toBe(false);
    expect(document.stagedHunkIds).toEqual([]);
    expect(document.mixedHunkIds).toEqual([ids.css.id]);
    expect(document.intent).toBe(INTENT);
    expect(document.files).toHaveLength(3);
    expect(document.files[0].hunks[0]).toMatchObject({
      id: ids.auth.id,
      decision: "include",
      source: "model",
      confidence: 0.94,
    });
    expect(io.stderr()).toContain(`  + ${ids.auth.id.slice(0, 8)} @@`);
    expect(io.stderr()).not.toContain("[");
    expect(staged(dir)).toBe("");
  });

  it("stages with --yes and reports what was left out", async () => {
    const { dir, ids, env } = await setupDemo();
    const io = createTestIo({ cwd: dir, env });

    await expect(run([INTENT, "--json", "--yes"], io.io)).resolves.toBe(0);

    const document = JSON.parse(io.stdout());
    expect(document.applied).toBe(true);
    expect(document.stagedHunkIds).toEqual([ids.auth.id, ids.test.id]);
    expect(document.mixedHunkIds).toEqual([ids.css.id]);
    expect(staged(dir)).toBe("src/auth/login.ts\ntest/auth.test.ts");
    expect(io.stderr()).toContain("staged 2 hunks in 2 files\n");
    expect(io.stderr()).toContain("left unstaged: 1 mixed hunk\n");
  });
});

describe("run --dry-run", () => {
  it("writes the patch it would apply and stages nothing", async () => {
    const { dir, ids, snapshot, env } = await setupDemo();
    const io = createTestIo({ cwd: dir, env });

    await expect(run([INTENT, "--dry-run"], io.io)).resolves.toBe(0);

    const expected = composePatch(snapshot.files, new Set([ids.auth.id, ids.test.id]));
    expect(io.bytes().equals(expected)).toBe(true);
    expect(io.stdout()).toContain("will stage: 2 hunks, 2 files (+6 -1)");
    expect(staged(dir)).toBe("");
  });

  it("prints the document instead of the patch when --json is also given", async () => {
    const { dir, ids, env } = await setupDemo();
    const io = createTestIo({ cwd: dir, env });

    await expect(run([INTENT, "--dry-run", "--json"], io.io)).resolves.toBe(0);

    const document = JSON.parse(io.stdout());
    expect(document.applied).toBe(false);
    expect(document.mixedHunkIds).toEqual([ids.css.id]);
    expect(io.bytes()).toHaveLength(0);
    expect(staged(dir)).toBe("");
  });
});

describe("run --yes", () => {
  it("stages the included hunks and leaves the mixed one", async () => {
    const { dir, env } = await setupDemo();
    const io = createTestIo({ cwd: dir, env });

    await expect(run([INTENT, "--yes"], io.io)).resolves.toBe(0);

    expect(staged(dir)).toBe("src/auth/login.ts\ntest/auth.test.ts");
    expect(io.stdout()).toContain("staged 2 hunks in 2 files\n");
    expect(io.stdout()).toContain("left unstaged: 1 mixed hunk\n");
    expect(io.stderr()).toBe("");
  });

  it("says there is nothing to stage on a clean tree", async () => {
    const { dir, env } = await setupDemo();
    commitAll(dir, "everything");
    const io = createTestIo({ cwd: dir, env });

    await expect(run([INTENT, "--yes"], io.io)).resolves.toBe(0);

    expect(io.stdout()).toBe("nothing to stage\n");
  });
});

describe("run refusals", () => {
  it("needs a flag when stdin is not a tty", async () => {
    const { dir, env } = await setupDemo();
    const io = createTestIo({ cwd: dir, env });

    await expect(run([INTENT], io.io)).resolves.toBe(2);

    expect(io.stderr()).toBe("git-jev-stage: usage: no TTY; use --yes, --dry-run or --json\n");
    expect(staged(dir)).toBe("");
  });

  it("reports a provider failure without staging", async () => {
    const { dir } = await setupDemo();
    const scriptDir = mkTempDir("git-jev-stage-script-");
    dirs.push(scriptDir);
    writeFileSync(
      join(scriptDir, "broken.json"),
      JSON.stringify({ errorMessage: "TypeSafe request failed (503)" }),
    );
    const io = createTestIo({
      cwd: dir,
      env: { GIT_JEV_STAGE_FAKE_PROVIDER: join(scriptDir, "broken.json") },
    });

    await expect(run([INTENT, "--yes"], io.io)).resolves.toBe(1);

    expect(io.stderr()).toBe("git-jev-stage: provider: TypeSafe request failed (503)\n");
    expect(staged(dir)).toBe("");
  });

  it("gives up with exit 3 when the index is locked", async () => {
    const { dir, env } = await setupDemo();
    const lockPath = join(dir, ".git", "index.lock");
    writeFileSync(lockPath, "");
    const io = createTestIo({ cwd: dir, env });

    await expect(run([INTENT, "--yes"], io.io)).resolves.toBe(3);

    expect(io.stderr()).toContain("git-jev-stage: index-locked: another git process holds ");
    expect(existsSync(lockPath)).toBe(true);
    expect(staged(dir)).toBe("");
  });

  it("needs a key for --yes", async () => {
    const { dir } = await setupDemo();
    const io = createTestIo({ cwd: dir, env: {} });

    await expect(run([INTENT, "--yes"], io.io)).resolves.toBe(1);

    expect(io.stderr()).toContain("git-jev-stage: missing-api-key: TYPESAFE_API_KEY is not set.");
    expect(io.stderr()).toContain("rerun in an interactive terminal without --json or --yes");
    expect(staged(dir)).toBe("");
  });
});
