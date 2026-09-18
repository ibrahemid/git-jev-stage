import { spawn } from "node:child_process";
import { GitCommandError } from "../errors.js";

export const DEFAULT_MAX_BUFFER = 512 * 1024 * 1024;

const NO_EXIT_CODE = -1;

export interface GitRunOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: Buffer;
  maxBuffer?: number;
}

export interface GitRunResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

export interface GitRunner {
  run(args: string[], options?: GitRunOptions): Promise<GitRunResult>;
}

export function createGitRunner(gitBinary = "git"): GitRunner {
  return {
    run(args: string[], options?: GitRunOptions): Promise<GitRunResult> {
      return spawnGit(gitBinary, [...args], options);
    },
  };
}

export async function runGitOrThrow(
  git: GitRunner,
  args: string[],
  options?: GitRunOptions,
): Promise<GitRunResult> {
  const result = await git.run(args, options);
  if (result.exitCode !== 0) {
    throw new GitCommandError(args, result.exitCode, result.stderr);
  }
  return result;
}

function spawnGit(
  gitBinary: string,
  args: string[],
  options: GitRunOptions | undefined,
): Promise<GitRunResult> {
  const maxBuffer = options?.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const extraEnv = options?.env;
  const input = options?.stdin;

  return new Promise<GitRunResult>((resolve, reject) => {
    const child = spawn(gitBinary, args, {
      cwd: options?.cwd ?? process.cwd(),
      env: extraEnv === undefined ? process.env : { ...process.env, ...extraEnv },
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLength = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(error);
    };

    child.on("error", (error: Error) => {
      fail(new GitCommandError(args, NO_EXIT_CODE, error.message, { cause: error }));
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutLength += chunk.length;
      if (stdoutLength > maxBuffer) {
        fail(new GitCommandError(args, NO_EXIT_CODE, `stdout exceeded ${maxBuffer} bytes`));
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // git can exit before reading all of stdin (for example `git apply --check` on a bad patch)
      if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") {
        return;
      }
      fail(new GitCommandError(args, NO_EXIT_CODE, error.message, { cause: error }));
    });

    if (input === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(input);
    }

    child.on("close", (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        stdout: Buffer.concat(stdoutChunks, stdoutLength),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: code ?? NO_EXIT_CODE,
      });
    });
  });
}
