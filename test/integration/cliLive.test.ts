import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadDotEnv } from "../../src/cli/loadEnv.js";
import { captureSnapshot } from "../../src/git/snapshot.js";
import { demoHunks } from "../helpers/demo.js";
import {
  createDemoRepo,
  createTestGitRunner,
  gitText,
  HERMETIC_GIT_ENV,
  removeDir,
} from "../helpers/repo.js";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BINARY = join(PROJECT_ROOT, "dist", "git-jev-stage.js");
const INTENT = "only the auth fix and its tests";
const BUILD_TIMEOUT_MS = 180_000;
const RUN_TIMEOUT_MS = 120_000;

if (process.env.JEV_LIVE === "1") {
  loadDotEnv(PROJECT_ROOT);
}

const apiKey = process.env.TYPESAFE_API_KEY ?? "";
const live = process.env.JEV_LIVE === "1" && apiKey.length > 0;

function withoutKey(text: string): string {
  return apiKey.length === 0 ? text : text.split(apiKey).join("<redacted>");
}

describe.skipIf(!live)("git-jev-stage live", () => {
  const dirs: string[] = [];

  beforeAll(() => {
    if (!existsSync(BINARY)) {
      execFileSync("npm", ["run", "build"], { cwd: PROJECT_ROOT, stdio: "ignore" });
    }
  }, BUILD_TIMEOUT_MS);

  afterAll(() => {
    for (const dir of dirs.splice(0)) {
      removeDir(dir);
    }
  });

  it(
    "stages the auth fix and its tests and nothing else",
    async () => {
      const dir = createDemoRepo();
      dirs.push(dir);
      const snapshot = await captureSnapshot({ cwd: dir, git: createTestGitRunner() });
      const ids = demoHunks(snapshot);

      const result = spawnSync(process.execPath, [BINARY, INTENT, "--json", "--yes"], {
        cwd: dir,
        env: { ...process.env, ...HERMETIC_GIT_ENV, TYPESAFE_API_KEY: apiKey },
        encoding: "utf8",
      });

      expect(result.status, withoutKey(result.stderr)).toBe(0);
      const document = JSON.parse(result.stdout);
      const decisions = new Map<string, string>();
      for (const file of document.files) {
        for (const hunk of file.hunks) {
          decisions.set(hunk.id, `${hunk.decision}/${hunk.source}`);
        }
      }
      const report = JSON.stringify({
        auth: decisions.get(ids.auth.id),
        log: decisions.get(ids.log.id),
        css: decisions.get(ids.css.id),
        test: decisions.get(ids.test.id),
      });

      expect(document.applied).toBe(true);
      expect([...document.stagedHunkIds].sort(), report).toEqual([ids.auth.id, ids.test.id].sort());
      expect(document.stagedHunkIds, report).not.toContain(ids.css.id);
      expect(document.stagedHunkIds, report).not.toContain(ids.log.id);
      expect(gitText(dir, ["diff", "--cached", "--name-only"])).toBe(
        "src/auth/login.ts\ntest/auth.test.ts",
      );
      expect(document.usage.requests).toBeGreaterThan(0);
    },
    RUN_TIMEOUT_MS,
  );
});
