import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  NotARepositoryError,
  UnbornRepositoryError,
  UnmergedEntriesError,
  UnsupportedGitVersionError,
} from "../errors.js";
import type { Snapshot } from "../types.js";
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
  await assertSupportedGitVersion(git, cwd);
  const locations = await resolveLocations(git, cwd);
  const headOid = await resolveHeadOid(git, locations.workTree);
  await assertNoUnmergedEntries(git, locations.workTree);

  const diff = await runGitOrThrow(git, [...DIFF_ARGS], { cwd: locations.workTree });
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
    headOid,
    indexHash: hashBytes(readIndexBytes(locations.indexPath)),
    diffHash: hashBytes(diffBytes),
    diffBytes,
    files: parsed.files.filter((file) => file.kind !== "mode-only"),
    skipped: parsed.files
      .filter((file) => file.kind === "mode-only")
      .map((file) => ({ path: file.path, reason: "mode-only" as const })),
  };
}

async function assertSupportedGitVersion(git: GitRunner, cwd: string): Promise<void> {
  const result = await runGitOrThrow(git, ["--version"], { cwd });
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

async function resolveLocations(git: GitRunner, cwd: string): Promise<RepositoryLocations> {
  const result = await git.run(
    ["rev-parse", "--show-toplevel", "--git-dir", "--git-path", "index"],
    {
      cwd,
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

  const envIndex = process.env.GIT_INDEX_FILE;
  const indexSource = envIndex !== undefined && envIndex.length > 0 ? envIndex : indexFile;

  return {
    workTree: resolve(cwd, workTree),
    gitDir: resolve(cwd, gitDir),
    indexPath: resolve(cwd, indexSource),
  };
}

async function resolveHeadOid(git: GitRunner, cwd: string): Promise<string> {
  const result = await git.run(["rev-parse", "--verify", "HEAD"], { cwd });
  const oid = result.stdout.toString("utf8").trim();
  if (result.exitCode !== 0 || oid.length === 0) {
    throw new UnbornRepositoryError();
  }
  return oid;
}

async function assertNoUnmergedEntries(git: GitRunner, cwd: string): Promise<void> {
  const result = await runGitOrThrow(git, ["ls-files", "-u", "-z"], { cwd });
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

function readIndexBytes(indexPath: string): Buffer {
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
