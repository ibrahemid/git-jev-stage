import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/main.js";
import { captureSnapshot } from "../../src/git/snapshot.js";
import type { Snapshot } from "../../src/types.js";
import { createTestIo } from "../helpers/cli.js";
import { answer, type DemoHunks, demoHunks, writeFakeScript } from "../helpers/demo.js";
import {
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

async function setupDemo(): Promise<{ dir: string; ids: DemoHunks; snapshot: Snapshot }> {
  const dir = createDemoRepo();
  dirs.push(dir);
  const snapshot = await captureSnapshot({ cwd: dir, git: createTestGitRunner() });
  return { dir, ids: demoHunks(snapshot), snapshot };
}

function staged(dir: string): string {
  return gitText(dir, ["diff", "--cached", "--name-only"]);
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("manual fallback", () => {
  it("asks for every hunk and stages what was picked", async () => {
    const { dir, ids } = await setupDemo();
    const io = createTestIo({
      cwd: dir,
      env: {},
      isStdinTty: true,
      answers: ["y", "n", "n", "y", "y"],
    });

    await expect(run([INTENT], io.io)).resolves.toBe(0);

    const output = io.stdout();
    expect(output.startsWith("no TYPESAFE_API_KEY, deciding by hand\n")).toBe(true);
    expect(occurrences(output, "stage this hunk? [y/N] ")).toBe(4);
    expect(output).toContain(`\nsrc/styles/app.css\n${ids.css.text}`);
    expect(output).toContain(`  + ${ids.auth.id.slice(0, 8)} @@ -1,12 +1,13 @@  manual`);
    expect(output).toContain(`  - ${ids.log.id.slice(0, 8)} @@ -16,9 +17,10 @@`);
    expect(output).toContain("stage 2 hunks in 2 files? [y/N] ");
    expect(output).toContain("staged 2 hunks in 2 files\n");
    expect(output).not.toContain("left unstaged");
    expect(staged(dir)).toBe("src/auth/login.ts\ntest/auth.test.ts");
  });

  it("stages nothing when the last question is declined", async () => {
    const { dir } = await setupDemo();
    const io = createTestIo({
      cwd: dir,
      env: {},
      isStdinTty: true,
      answers: ["y", "n", "n", "y", "n"],
    });

    await expect(run([INTENT], io.io)).resolves.toBe(0);

    expect(io.stdout()).toContain("nothing staged\n");
    expect(staged(dir)).toBe("");
  });

  it("plans every hunk as mixed and writes no patch for --dry-run without a key", async () => {
    const { dir, ids } = await setupDemo();
    const io = createTestIo({ cwd: dir, env: {} });

    await expect(run([INTENT, "--dry-run"], io.io)).resolves.toBe(0);

    expect(io.stdout()).toContain(`  ? ${ids.auth.id.slice(0, 8)} @@ -1,12 +1,13 @@  no-provider`);
    expect(io.stdout()).toContain("will stage: 0 hunks, 0 files (+0 -0)");
    expect(io.bytes()).toHaveLength(0);
    expect(staged(dir)).toBe("");
  });

  it("needs a key for --json", async () => {
    const { dir } = await setupDemo();
    const io = createTestIo({ cwd: dir, env: {} });

    await expect(run([INTENT, "--json"], io.io)).resolves.toBe(1);

    expect(io.stderr()).toContain("git-jev-stage: missing-api-key: TYPESAFE_API_KEY is not set.");
    expect(io.stderr()).toContain("rerun in an interactive terminal without --json or --yes");
  });
});

describe("--exclude", () => {
  it("reaches the plan and the JSON document", async () => {
    const { dir, ids } = await setupDemo();
    const scriptDir = mkTempDir("git-jev-stage-script-");
    dirs.push(scriptDir);
    const script = writeFakeScript(scriptDir, {
      [ids.auth.id]: answer("include", 0.94),
      [ids.log.id]: answer("exclude", 0.91),
      [ids.css.id]: answer("exclude", 0.88),
      [ids.test.id]: answer("include", 0.83),
    });
    const io = createTestIo({ cwd: dir, env: { GIT_JEV_STAGE_FAKE_PROVIDER: script } });

    await expect(
      run([INTENT, "--exclude", "the logging cleanup", "--json", "--yes"], io.io),
    ).resolves.toBe(0);

    const document = JSON.parse(io.stdout());
    expect(document.exclude).toBe("the logging cleanup");
    expect(document.stagedHunkIds).toEqual([ids.auth.id, ids.test.id]);
    expect(document.mixedHunkIds).toEqual([]);
    expect(staged(dir)).toBe("src/auth/login.ts\ntest/auth.test.ts");
  });
});
