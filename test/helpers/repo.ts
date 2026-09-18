import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGitRunner, type GitRunner } from "../../src/git/runGit.js";

export const HERMETIC_GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CEILING_DIRECTORIES: realpathSync(tmpdir()),
};

const IDENTITY_ARGS = [
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@t",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "init.defaultBranch=main",
];

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  status: number;
}

export function git(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", [...IDENTITY_ARGS, ...args], {
    cwd,
    env: { ...process.env, ...HERMETIC_GIT_ENV },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr.toString("utf8"),
    status: result.status ?? -1,
  };
}

export function gitOrThrow(cwd: string, args: string[]): GitResult {
  const result = git(cwd, args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`);
  }
  return result;
}

export function gitText(cwd: string, args: string[]): string {
  return gitOrThrow(cwd, args).stdout.toString("utf8").trim();
}

export function mkTempDir(prefix = "git-jev-stage-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function mkRepo(prefix = "git-jev-stage-repo-"): string {
  const dir = mkTempDir(prefix);
  gitOrThrow(dir, ["init", "-q", "-b", "main", "."]);
  return dir;
}

export function writeFile(dir: string, relativePath: string, contents: string | Buffer): void {
  const target = join(dir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

export function commitAll(dir: string, message: string): void {
  gitOrThrow(dir, ["add", "-A"]);
  gitOrThrow(dir, ["commit", "-q", "-m", message]);
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function createTestGitRunner(): GitRunner {
  const runner = createGitRunner();
  return {
    run(args, options) {
      return runner.run(args, { ...options, env: { ...HERMETIC_GIT_ENV, ...options?.env } });
    },
  };
}
