import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { IndexLockedError, PatchApplyError, StaleSnapshotError } from "../errors.js";
import type { Snapshot } from "../types.js";
import { composePatch } from "./composePatch.js";
import { hashBytes } from "./hash.js";
import { type GitRunner, runGitOrThrow } from "./runGit.js";
import { DIFF_ARGS, readIndexBytes } from "./snapshot.js";

const LOCK_SUFFIX = ".lock";
const LOCK_MODE = 0o644;
const TEMP_SUFFIX_BYTES = 8;

export interface ApplyPatchToIndexOptions {
  snapshot: Snapshot;
  patch: Buffer;
  git: GitRunner;
}

interface TempIndexApply {
  git: GitRunner;
  snapshot: Snapshot;
  patch: Buffer;
  tempPath: string;
}

const ownedPaths = new Set<string>();
let exitHookInstalled = false;

export async function applyPatchToIndex({
  snapshot,
  patch,
  git,
}: ApplyPatchToIndexOptions): Promise<void> {
  if (patch.length === 0) {
    return;
  }

  const tempPath = await createTempIndex(snapshot, git);
  const apply: TempIndexApply = { git, snapshot, patch, tempPath };
  try {
    await runApply(apply, ["apply", "--cached", "--check"]);
    await runApply(apply, ["apply", "--cached"]);
    await verifyTempIndex(apply);
  } catch (error) {
    discard(tempPath);
    throw error;
  }

  const lockPath = `${snapshot.indexPath}${LOCK_SUFFIX}`;
  const lockFd = openLock(lockPath, tempPath);

  let lockClosed = false;
  try {
    await assertSnapshotIsCurrent(git, snapshot);
    writeAll(lockFd, readFileSync(tempPath));
    fsyncSync(lockFd);
    closeSync(lockFd);
    lockClosed = true;
    renameSync(lockPath, snapshot.indexPath);
    untrack(lockPath);
  } catch (error) {
    if (!lockClosed) {
      closeQuietly(lockFd);
    }
    discard(lockPath);
    discard(tempPath);
    throw error;
  }

  discard(tempPath);
}

export async function stageHunks(
  snapshot: Snapshot,
  selectedIds: ReadonlySet<string>,
  git: GitRunner,
): Promise<Buffer> {
  const patch = composePatch(snapshot.files, selectedIds);
  await applyPatchToIndex({ snapshot, patch, git });
  return patch;
}

async function createTempIndex(snapshot: Snapshot, git: GitRunner): Promise<string> {
  const suffix = randomBytes(TEMP_SUFFIX_BYTES).toString("hex");
  const tempPath = `${snapshot.indexPath}.jev-stage-${process.pid}-${suffix}`;
  track(tempPath);

  try {
    copyFileSync(snapshot.indexPath, tempPath, constants.COPYFILE_EXCL);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      discard(tempPath);
      throw error;
    }
    try {
      await runGitOrThrow(git, ["read-tree", "HEAD"], {
        cwd: snapshot.workTree,
        env: { ...snapshot.gitEnv, GIT_INDEX_FILE: tempPath },
      });
    } catch (readTreeError) {
      discard(tempPath);
      throw readTreeError;
    }
  }

  return tempPath;
}

function tempIndexEnv(apply: TempIndexApply): Record<string, string> {
  return { ...apply.snapshot.gitEnv, GIT_INDEX_FILE: apply.tempPath };
}

async function runApply(apply: TempIndexApply, args: string[]): Promise<void> {
  const result = await apply.git.run(args, {
    cwd: apply.snapshot.workTree,
    env: tempIndexEnv(apply),
    stdin: apply.patch,
  });
  if (result.exitCode !== 0) {
    throw new PatchApplyError(result.stderr);
  }
}

async function verifyTempIndex(apply: TempIndexApply): Promise<void> {
  await runApply(apply, ["apply", "--cached", "--check", "-R"]);

  const listed = await apply.git.run(["ls-files", "-s"], {
    cwd: apply.snapshot.workTree,
    env: tempIndexEnv(apply),
  });
  if (listed.exitCode !== 0) {
    throw new PatchApplyError(listed.stderr);
  }
}

async function assertSnapshotIsCurrent(git: GitRunner, snapshot: Snapshot): Promise<void> {
  const head = await runGitOrThrow(git, ["rev-parse", "HEAD"], {
    cwd: snapshot.workTree,
    env: snapshot.gitEnv,
  });
  if (head.stdout.toString("utf8").trim() !== snapshot.headOid) {
    throw new StaleSnapshotError("head");
  }

  if (hashBytes(readIndexBytes(snapshot.indexPath)) !== snapshot.indexHash) {
    throw new StaleSnapshotError("index");
  }

  const diff = await runGitOrThrow(git, [...DIFF_ARGS], {
    cwd: snapshot.workTree,
    env: { ...snapshot.gitEnv, GIT_INDEX_FILE: snapshot.indexPath },
  });
  if (hashBytes(diff.stdout) !== snapshot.diffHash) {
    throw new StaleSnapshotError("diff");
  }
}

function openLock(lockPath: string, tempPath: string): number {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", LOCK_MODE);
  } catch (error) {
    discard(tempPath);
    if (hasErrnoCode(error, "EEXIST")) {
      throw new IndexLockedError(lockPath, { cause: error });
    }
    throw error;
  }
  track(lockPath);
  return fd;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(fd, bytes, offset, bytes.length - offset);
  }
}

function track(path: string): void {
  ownedPaths.add(path);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", cleanupOwnedPaths);
  }
}

function untrack(path: string): void {
  ownedPaths.delete(path);
}

function discard(path: string): void {
  untrack(path);
  removeQuietly(path);
}

export function cleanupOwnedPaths(): void {
  for (const path of [...ownedPaths]) {
    ownedPaths.delete(path);
    removeQuietly(path);
  }
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    return;
  }
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    return;
  }
}

function hasErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
