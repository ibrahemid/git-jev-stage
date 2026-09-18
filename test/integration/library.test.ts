import { afterEach, describe, expect, it } from "vitest";
import { FakeProvider } from "../../src/core/index.js";
import { StaleSnapshotError, UnknownHunkError } from "../../src/errors.js";
import type { GitRunner } from "../../src/git/runGit.js";
import { captureSnapshot } from "../../src/git/snapshot.js";
import { applySelection, planSelection } from "../../src/library.js";
import type { Plan } from "../../src/types.js";
import { answer, type DemoHunks, demoHunks } from "../helpers/demo.js";
import {
  createDemoRepo,
  createTestGitRunner,
  gitText,
  removeDir,
  writeFile,
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

function newDemoRepo(): string {
  const dir = createDemoRepo();
  dirs.push(dir);
  return dir;
}

async function planDemo(dir: string): Promise<{ plan: Plan; ids: DemoHunks; git: GitRunner }> {
  const git = createTestGitRunner();
  const ids = demoHunks(await captureSnapshot({ cwd: dir, git }));
  const provider = new FakeProvider({
    answers: {
      [ids.auth.id]: answer("include", 0.94),
      [ids.log.id]: answer("exclude", 0.91),
      [ids.css.id]: answer("mixed", 0.52),
      [ids.test.id]: answer("include", 0.83),
    },
  });
  const plan = await planSelection({ cwd: dir, intent: INTENT, provider, git });
  return { plan, ids, git };
}

function staged(dir: string): string {
  return gitText(dir, ["diff", "--cached", "--name-only"]);
}

describe("planSelection", () => {
  it("decides every demo hunk and stages nothing", async () => {
    const dir = newDemoRepo();

    const { plan, ids } = await planDemo(dir);

    expect(plan.intent).toBe(INTENT);
    expect(plan.threshold).toBe(0.6);
    expect(plan.decisions.size).toBe(4);
    expect(plan.decisions.get(ids.auth.id)).toMatchObject({
      decision: "include",
      source: "model",
      confidence: 0.94,
    });
    expect(plan.decisions.get(ids.log.id)).toMatchObject({ decision: "exclude", source: "model" });
    expect(plan.decisions.get(ids.css.id)).toMatchObject({ decision: "mixed", source: "model" });
    expect(plan.decisions.get(ids.test.id)).toMatchObject({ decision: "include" });
    expect(plan.usage.requests).toBe(1);
    expect(staged(dir)).toBe("");
  });

  it("marks every hunk mixed when no provider is configured", async () => {
    const dir = newDemoRepo();

    const plan = await planSelection({ cwd: dir, intent: INTENT, git: createTestGitRunner() });

    for (const decision of plan.decisions.values()) {
      expect(decision).toMatchObject({ decision: "mixed", source: "no-provider" });
    }
    expect(plan.usage).toEqual({ requests: 0, inputTokens: 0, outputTokens: 0 });
    expect(staged(dir)).toBe("");
  });
});

describe("applySelection", () => {
  it("stages only the hunks that were included", async () => {
    const dir = newDemoRepo();
    const { plan, ids, git } = await planDemo(dir);

    const result = await applySelection(plan, {
      includeIds: [ids.test.id, ids.auth.id],
      git,
    });

    expect(result.stagedHunkIds).toEqual([ids.auth.id, ids.test.id]);
    expect(result.skippedMixedIds).toEqual([ids.css.id]);
    expect(staged(dir)).toBe("src/auth/login.ts\ntest/auth.test.ts");

    const cached = gitText(dir, ["diff", "--cached"]);
    expect(cached).toContain("!user.active");
    expect(cached).toContain("rejects inactive users");
    expect(cached).not.toContain("console.log");
    expect(gitText(dir, ["diff", "--name-only"])).toBe("src/auth/login.ts\nsrc/styles/app.css");
    expect(gitText(dir, ["diff"])).toContain("console.log");
  });

  it("reports a mixed hunk as skipped only when it stays out", async () => {
    const dir = newDemoRepo();
    const { plan, ids, git } = await planDemo(dir);

    const result = await applySelection(plan, {
      includeIds: [ids.auth.id, ids.css.id],
      git,
    });

    expect(result.skippedMixedIds).toEqual([]);
    expect(staged(dir)).toBe("src/auth/login.ts\nsrc/styles/app.css");
  });

  it("refuses an id that is not in the plan", async () => {
    const dir = newDemoRepo();
    const { plan, ids, git } = await planDemo(dir);

    await expect(
      applySelection(plan, { includeIds: [ids.auth.id, "deadbeefdeadbeef"], git }),
    ).rejects.toThrow(UnknownHunkError);
    expect(staged(dir)).toBe("");
  });

  it("refuses to stage against a working tree that moved on", async () => {
    const dir = newDemoRepo();
    const { plan, ids, git } = await planDemo(dir);
    writeFile(dir, "src/styles/app.css", ".btn { padding: 8px; }\n.card { margin: 8px; }\n");

    await expect(applySelection(plan, { includeIds: [ids.auth.id], git })).rejects.toThrow(
      StaleSnapshotError,
    );
    expect(staged(dir)).toBe("");
  });
});
