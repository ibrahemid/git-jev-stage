import { chmodSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/main.js";
import { createTestIo } from "../helpers/cli.js";
import { writeFakeScript } from "../helpers/demo.js";
import { commitAll, gitOrThrow, mkRepo, mkTempDir, removeDir, writeFile } from "../helpers/repo.js";

const INTENT = "make the entry script executable";
const SCRIPT_PATH = "scripts/run.sh";
const SKIPPED_LINE = `skipped: ${SCRIPT_PATH} (mode-only)`;
const INSTRUCTION = "these changes cannot be staged by hunk; stage them with git add";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      removeDir(dir);
    }
  }
});

function createModeOnlyRepo(): string {
  const dir = mkRepo("git-jev-stage-mode-only-");
  dirs.push(dir);
  gitOrThrow(dir, ["config", "core.fileMode", "true"]);
  writeFile(dir, SCRIPT_PATH, "#!/bin/sh\necho hi\n");
  commitAll(dir, "init");
  chmodSync(join(dir, SCRIPT_PATH), 0o755);
  return dir;
}

describe("skipped-only changes", () => {
  it("names the path and how to stage it when nothing can be staged by hunk", async () => {
    const dir = createModeOnlyRepo();
    const io = createTestIo({ cwd: dir, env: {}, isStdinTty: true });

    await expect(run([INTENT], io.io)).resolves.toBe(0);

    expect(io.stdout()).toBe(`${SKIPPED_LINE}\n${INSTRUCTION}\nnothing to stage\n`);
  });

  it("names the path and how to stage it with --dry-run", async () => {
    const dir = createModeOnlyRepo();
    const io = createTestIo({ cwd: dir, env: {} });

    await expect(run([INTENT, "--dry-run"], io.io)).resolves.toBe(0);

    expect(io.stdout()).toContain(SKIPPED_LINE);
    expect(io.stdout()).toContain(INSTRUCTION);
    expect(io.bytes()).toHaveLength(0);
  });

  it("lists the skipped path in the document and on stderr with --json", async () => {
    const dir = createModeOnlyRepo();
    const scriptDir = mkTempDir("git-jev-stage-script-");
    dirs.push(scriptDir);
    const io = createTestIo({
      cwd: dir,
      env: { GIT_JEV_STAGE_FAKE_PROVIDER: writeFakeScript(scriptDir, {}) },
    });

    await expect(run([INTENT, "--json"], io.io)).resolves.toBe(0);

    const document = JSON.parse(io.stdout());
    expect(document.files).toEqual([]);
    expect(document.skipped).toEqual([{ path: SCRIPT_PATH, reason: "mode-only" }]);
    expect(io.stderr()).toBe(`${SKIPPED_LINE}\n${INSTRUCTION}\n`);
  });
});
