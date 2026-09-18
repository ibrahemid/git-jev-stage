import { afterEach, describe, expect, it } from "vitest";
import { GitCommandError } from "../../src/errors.js";
import { createGitRunner, runGitOrThrow } from "../../src/git/runGit.js";
import { HERMETIC_GIT_ENV, mkTempDir, removeDir } from "../helpers/repo.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    removeDir(dir);
  }
});

function newDir(): string {
  const dir = mkTempDir();
  dirs.push(dir);
  return dir;
}

describe("createGitRunner", () => {
  it("returns stdout as a Buffer and stderr as a string", async () => {
    const result = await createGitRunner().run(["--version"]);
    expect(Buffer.isBuffer(result.stdout)).toBe(true);
    expect(result.stdout.toString("utf8")).toMatch(/^git version /);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("returns a non-zero exit instead of throwing", async () => {
    const result = await createGitRunner().run(["rev-parse", "--verify", "HEAD"], {
      cwd: newDir(),
      env: HERMETIC_GIT_ENV,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("fatal:");
    expect(result.stdout).toHaveLength(0);
  });

  it("merges env over process.env", async () => {
    const result = await createGitRunner().run(["var", "GIT_AUTHOR_IDENT"], {
      env: {
        GIT_AUTHOR_NAME: "probe",
        GIT_AUTHOR_EMAIL: "p@p",
        GIT_AUTHOR_DATE: "@1700000000 +0000",
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString("utf8").trim()).toBe("probe <p@p> 1700000000 +0000");
  });

  it("writes stdin to the process", async () => {
    const result = await createGitRunner().run(["hash-object", "--stdin", "-t", "blob"], {
      stdin: Buffer.from("hello", "utf8"),
    });
    expect(result.stdout.toString("utf8").trim()).toBe("b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0");
  });

  it("fails when stdout exceeds maxBuffer", async () => {
    await expect(createGitRunner().run(["--version"], { maxBuffer: 1 })).rejects.toBeInstanceOf(
      GitCommandError,
    );
  });

  it("fails when the binary cannot be spawned", async () => {
    const error = await createGitRunner("git-jev-stage-missing-binary")
      .run(["--version"])
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );
    expect(error).toBeInstanceOf(GitCommandError);
    if (error instanceof GitCommandError) {
      expect(error.gitExitCode).toBe(-1);
      expect(error.exitCode).toBe(1);
    }
  });
});

describe("runGitOrThrow", () => {
  it("passes a successful run through", async () => {
    const result = await runGitOrThrow(createGitRunner(), ["--version"]);
    expect(result.exitCode).toBe(0);
  });

  it("throws GitCommandError carrying argv, exit code and trimmed stderr", async () => {
    const git = createGitRunner();
    const args = ["rev-parse", "--verify", "HEAD"];
    const error = await runGitOrThrow(git, args, {
      cwd: newDir(),
      env: HERMETIC_GIT_ENV,
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(GitCommandError);
    if (error instanceof GitCommandError) {
      expect(error.argv).toEqual(args);
      expect(error.gitExitCode).toBe(128);
      expect(error.stderr).toBe(error.stderr.trim());
      expect(error.message).toContain("git rev-parse --verify HEAD exited 128");
    }
  });
});
