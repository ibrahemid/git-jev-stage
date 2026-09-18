import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  NotARepositoryError,
  UnbornRepositoryError,
  UnmergedEntriesError,
  UnsupportedGitVersionError,
} from "../errors.js";
import type { FileKind, Snapshot } from "../types.js";
import { hashBytes } from "./hash.js";
import { buildUnsupportedEntryError, parseUnifiedDiffDetailed } from "./parseDiff.js";
import { type GitRunner, runGitOrThrow } from "./runGit.js";

export const DIFF_ARGS: readonly string[] = Object.freeze([
  "-c",
  "core.quotePath=true",
  "-c",
  "diff.suppressBlankEmpty=false",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "diff",
  "--no-color",
  "--binary",
  "--full-index",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
  "--unified=6",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--no-relative",
]);

const MIN_GIT_MAJOR = 2;
const MIN_GIT_MINOR = 30;
const MIN_GIT_VERSION = `${MIN_GIT_MAJOR}.${MIN_GIT_MINOR}`;
const GIT_VERSION_LINE = /^git version (\d+)\.(\d+)/;

export interface CaptureSnapshotOptions {
  cwd: string;
  git: GitRunner;
}

interface RepositoryLocations {
  workTree: string;
  gitDir: string;
  indexPath: string;
}

export async function captureSnapshot({ cwd, git }: CaptureSnapshotOptions): Promise<Snapshot> {
  const gitEnv = resolveGitEnv();
  await assertSupportedGitVersion(git, cwd, gitEnv);
  const locations = await resolveLocations(git, cwd, gitEnv);
  const headOid = await resolveHeadOid(git, locations.workTree, gitEnv);
  await assertNoUnmergedEntries(git, locations.workTree, gitEnv);

  const diff = await runGitOrThrow(git, [...DIFF_ARGS], { cwd: locations.workTree, env: gitEnv });
  const diffBytes = diff.stdout;
  const parsed = parseUnifiedDiffDetailed(diffBytes);

  const unsupported = buildUnsupportedEntryError(parsed.unsupported);
  if (unsupported !== undefined) {
    throw unsupported;
  }

  return {
    workTree: locations.workTree,
    gitDir: locations.gitDir,
    indexPath: locations.indexPath,
    gitEnv,
    headOid,
    indexHash: hashBytes(readIndexBytes(locations.indexPath)),
    diffHash: hashBytes(diffBytes),
    diffBytes,
    files: parsed.files.filter((file) => file.hunks.length > 0),
    skipped: parsed.files
      .filter((file) => file.hunks.length === 0)
      .map((file) => ({ path: file.path, reason: skippedReason(file.kind) })),
  };
}

function skippedReason(kind: FileKind): "mode-only" | "empty-file" {
  return kind === "mode-only" ? "mode-only" : "empty-file";
}

function resolveGitEnv(): Record<string, string> {
  const envIndex = process.env.GIT_INDEX_FILE;
  if (envIndex === undefined || envIndex.length === 0) {
    return {};
  }
  return { GIT_INDEX_FILE: resolve(process.cwd(), envIndex) };
}

async function assertSupportedGitVersion(
  git: GitRunner,
  cwd: string,
  env: Record<string, string>,
): Promise<void> {
  const result = await runGitOrThrow(git, ["--version"], { cwd, env });
  const line = firstLine(result.stdout.toString("utf8"));
  const match = GIT_VERSION_LINE.exec(line);
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);

  if (!Number.isInteger(major) || !Number.isInteger(minor)) {
    throw new UnsupportedGitVersionError(line, MIN_GIT_VERSION);
  }
  if (major < MIN_GIT_MAJOR || (major === MIN_GIT_MAJOR && minor < MIN_GIT_MINOR)) {
    throw new UnsupportedGitVersionError(`${major}.${minor}`, MIN_GIT_VERSION);
  }
}

async function resolveLocations(
  git: GitRunner,
  cwd: string,
  env: Record<string, string>,
): Promise<RepositoryLocations> {
  const result = await git.run(
    ["rev-parse", "--show-toplevel", "--git-dir", "--git-path", "index"],
    {
      cwd,
      env,
    },
  );
  if (result.exitCode !== 0) {
    throw new NotARepositoryError();
  }

  const lines = splitOutputLines(result.stdout.toString("utf8"));
  const workTree = lines[0];
  const gitDir = lines[1];
  const indexFile = lines[2];
  if (workTree === undefined || gitDir === undefined || indexFile === undefined) {
    throw new NotARepositoryError();
  }

  return {
    workTree: resolve(cwd, workTree),
    gitDir: resolve(cwd, gitDir),
    indexPath: env.GIT_INDEX_FILE ?? resolve(cwd, indexFile),
  };
}

async function resolveHeadOid(
  git: GitRunner,
  cwd: string,
  env: Record<string, string>,
): Promise<string> {
  const result = await git.run(["rev-parse", "--verify", "HEAD"], { cwd, env });
  const oid = result.stdout.toString("utf8").trim();
  if (result.exitCode !== 0 || oid.length === 0) {
    throw new UnbornRepositoryError();
  }
  return oid;
}

async function assertNoUnmergedEntries(
  git: GitRunner,
  cwd: string,
  env: Record<string, string>,
): Promise<void> {
  const result = await runGitOrThrow(git, ["ls-files", "-u", "-z"], { cwd, env });
  if (result.stdout.length === 0) {
    return;
  }

  const paths: string[] = [];
  for (const record of result.stdout.toString("utf8").split("\0")) {
    if (record.length === 0) {
      continue;
    }
    const tab = record.indexOf("\t");
    const path = tab === -1 ? record : record.slice(tab + 1);
    if (!paths.includes(path)) {
      paths.push(path);
    }
  }

  if (paths.length > 0) {
    throw new UnmergedEntriesError(paths);
  }
}

export function readIndexBytes(indexPath: string): Buffer {
  try {
    return readFileSync(indexPath);
  } catch (error) {
    if (isMissingFile(error)) {
      return Buffer.alloc(0);
    }
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  return error.code === "ENOENT" || error.code === "EISDIR";
}

function firstLine(output: string): string {
  return stripCarriageReturn(output.split("\n")[0] ?? "").trim();
}

function splitOutputLines(output: string): string[] {
  return output
    .split("\n")
    .map(stripCarriageReturn)
    .filter((line) => line.length > 0);
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
