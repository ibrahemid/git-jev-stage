import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureSnapshot } from "../../src/git/snapshot.js";
import { answer, demoHunks, writeFakeScript } from "../helpers/demo.js";
import {
  createDemoRepo,
  createTestGitRunner,
  HERMETIC_GIT_ENV,
  mkTempDir,
  removeDir,
} from "../helpers/repo.js";

const BUILD_TIMEOUT_MS = 180_000;
const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BINARY = join(PROJECT_ROOT, "dist", "git-jev-stage.js");

const dirs: string[] = [];

beforeAll(() => {
  execFileSync("npm", ["run", "build"], { cwd: PROJECT_ROOT, stdio: "ignore" });
}, BUILD_TIMEOUT_MS);

afterAll(() => {
  for (const dir of dirs) {
    removeDir(dir);
  }
});

describe("dist/git-jev-stage.js", () => {
  it("prints a plan document for the demo repository", async () => {
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

    const result = spawnSync(process.execPath, [BINARY, "the auth fix", "--json"], {
      cwd: dir,
      env: { ...process.env, ...HERMETIC_GIT_ENV, GIT_JEV_STAGE_FAKE_PROVIDER: script },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const document = JSON.parse(result.stdout);
    expect(document.applied).toBe(false);
    expect(document.files).toHaveLength(3);
    expect(document.stagedHunkIds).toEqual([]);
    expect(document.mixedHunkIds).toEqual([ids.css.id]);
  });
});
