export type UnsupportedEntryKind = "symlink" | "submodule" | "binary";
export type StaleSnapshotWhich = "head" | "index" | "diff";

export interface ProviderErrorOptions extends ErrorOptions {
  status?: number;
  requestId?: string;
}

export abstract class JevStageError extends Error {
  abstract readonly code: string;
  readonly exitCode: number = 1;
}

export class UsageError extends JevStageError {
  readonly code = "usage";
  override readonly exitCode = 2;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UsageError";
  }
}

export class NotARepositoryError extends JevStageError {
  readonly code = "not-a-repository";

  constructor(message = "not a git repository", options?: ErrorOptions) {
    super(message, options);
    this.name = "NotARepositoryError";
  }
}

export class UnbornRepositoryError extends JevStageError {
  readonly code = "unborn-repository";

  constructor(message = "the repository has no commits yet", options?: ErrorOptions) {
    super(message, options);
    this.name = "UnbornRepositoryError";
  }
}

export class UnsupportedGitVersionError extends JevStageError {
  readonly code = "unsupported-git-version";
  readonly found: string;
  readonly minimum: string;

  constructor(found: string, minimum: string, options?: ErrorOptions) {
    super(`git ${found} is too old; ${minimum} or newer is required`, options);
    this.name = "UnsupportedGitVersionError";
    this.found = found;
    this.minimum = minimum;
  }
}

export class UnmergedEntriesError extends JevStageError {
  readonly code = "unmerged-entries";
  readonly paths: readonly string[];

  constructor(paths: readonly string[], options?: ErrorOptions) {
    super(`resolve the unmerged paths first: ${paths.join(", ")}`, options);
    this.name = "UnmergedEntriesError";
    this.paths = [...paths];
  }
}

export class UnsupportedEntryError extends JevStageError {
  readonly code = "unsupported-entry";
  readonly kind: UnsupportedEntryKind;
  readonly paths: readonly string[];

  constructor(kind: UnsupportedEntryKind, paths: readonly string[], options?: ErrorOptions) {
    super(`${kind} entries cannot be staged by hunk: ${paths.join(", ")}`, options);
    this.name = "UnsupportedEntryError";
    this.kind = kind;
    this.paths = [...paths];
  }
}

export class DiffParseError extends JevStageError {
  readonly code = "diff-parse";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DiffParseError";
  }
}

export class PatchApplyError extends JevStageError {
  readonly code = "patch-apply";
  readonly stderr: string;

  constructor(stderr: string, options?: ErrorOptions) {
    const detail = stderr.trim();
    super(detail.length > 0 ? `git apply failed: ${detail}` : "git apply failed", options);
    this.name = "PatchApplyError";
    this.stderr = detail;
  }
}

const STALE_SNAPSHOT_MESSAGES: Record<StaleSnapshotWhich, string> = {
  head: "HEAD moved while the plan was being reviewed",
  index: "the index changed while the plan was being reviewed",
  diff: "the working tree changed while the plan was being reviewed",
};

export class StaleSnapshotError extends JevStageError {
  readonly code = "stale-snapshot";
  override readonly exitCode = 3;
  readonly which: StaleSnapshotWhich;

  constructor(which: StaleSnapshotWhich, options?: ErrorOptions) {
    super(`${STALE_SNAPSHOT_MESSAGES[which]}; nothing was staged`, options);
    this.name = "StaleSnapshotError";
    this.which = which;
  }
}

export class IndexLockedError extends JevStageError {
  readonly code = "index-locked";
  override readonly exitCode = 3;
  readonly lockPath: string;

  constructor(lockPath: string, options?: ErrorOptions) {
    super(`another git process holds ${lockPath}`, options);
    this.name = "IndexLockedError";
    this.lockPath = lockPath;
  }
}

export class MissingApiKeyError extends JevStageError {
  readonly code = "missing-api-key";

  constructor(message = "TYPESAFE_API_KEY is not set", options?: ErrorOptions) {
    super(message, options);
    this.name = "MissingApiKeyError";
  }
}

export class ProviderError extends JevStageError {
  readonly code = "provider";
  readonly status: number | undefined;
  readonly requestId: string | undefined;

  constructor(message: string, options?: ProviderErrorOptions) {
    super(message, options);
    this.name = "ProviderError";
    this.status = options?.status;
    this.requestId = options?.requestId;
  }
}

export class GitCommandError extends JevStageError {
  readonly code = "git-command";
  readonly argv: readonly string[];
  readonly gitExitCode: number;
  readonly stderr: string;

  constructor(argv: readonly string[], exitCode: number, stderr: string, options?: ErrorOptions) {
    const detail = stderr.trim();
    const command = `git ${argv.join(" ")}`;
    super(
      detail.length > 0
        ? `${command} exited ${exitCode}: ${detail}`
        : `${command} exited ${exitCode}`,
      options,
    );
    this.name = "GitCommandError";
    this.argv = [...argv];
    this.gitExitCode = exitCode;
    this.stderr = detail;
  }
}
