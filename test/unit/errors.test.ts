import { describe, expect, it } from "vitest";
import * as errorModule from "../../src/errors.js";
import {
  DiffParseError,
  GitCommandError,
  IndexLockedError,
  JevStageError,
  MissingApiKeyError,
  NotARepositoryError,
  PatchApplyError,
  StaleSnapshotError,
  UnbornRepositoryError,
  UnknownHunkError,
  UnmergedEntriesError,
  UnsupportedEntryError,
  UnsupportedGitVersionError,
  UsageError,
} from "../../src/errors.js";

interface ErrorCase {
  name: string;
  code: string;
  exitCode: number;
  create: (options?: ErrorOptions) => JevStageError;
}

const CASES: ErrorCase[] = [
  {
    name: "UsageError",
    code: "usage",
    exitCode: 2,
    create: (options) => new UsageError("no TTY; use --yes, --dry-run or --json", options),
  },
  {
    name: "NotARepositoryError",
    code: "not-a-repository",
    exitCode: 1,
    create: (options) => new NotARepositoryError(undefined, options),
  },
  {
    name: "UnbornRepositoryError",
    code: "unborn-repository",
    exitCode: 1,
    create: (options) => new UnbornRepositoryError(undefined, options),
  },
  {
    name: "UnsupportedGitVersionError",
    code: "unsupported-git-version",
    exitCode: 1,
    create: (options) => new UnsupportedGitVersionError("2.19.1", "2.30", options),
  },
  {
    name: "UnmergedEntriesError",
    code: "unmerged-entries",
    exitCode: 1,
    create: (options) => new UnmergedEntriesError(["src/a.ts", "src/b.ts"], options),
  },
  {
    name: "UnsupportedEntryError",
    code: "unsupported-entry",
    exitCode: 1,
    create: (options) => new UnsupportedEntryError("binary", ["assets/logo.png"], options),
  },
  {
    name: "DiffParseError",
    code: "diff-parse",
    exitCode: 1,
    create: (options) =>
      new DiffParseError("the diff does not start with a diff --git line", options),
  },
  {
    name: "UnknownHunkError",
    code: "unknown-hunk",
    exitCode: 1,
    create: (options) => new UnknownHunkError(["0123456789abcdef"], options),
  },
  {
    name: "PatchApplyError",
    code: "patch-apply",
    exitCode: 1,
    create: (options) => new PatchApplyError("error: src/a.ts: does not match index\n", options),
  },
  {
    name: "StaleSnapshotError",
    code: "stale-snapshot",
    exitCode: 3,
    create: (options) => new StaleSnapshotError("index", options),
  },
  {
    name: "IndexLockedError",
    code: "index-locked",
    exitCode: 3,
    create: (options) => new IndexLockedError("/repo/.git/index.lock", options),
  },
  {
    name: "MissingApiKeyError",
    code: "missing-api-key",
    exitCode: 1,
    create: (options) => new MissingApiKeyError(undefined, options),
  },
  {
    name: "GitCommandError",
    code: "git-command",
    exitCode: 1,
    create: (options) =>
      new GitCommandError(["rev-parse", "HEAD"], 128, "fatal: bad object\n", options),
  },
];

describe("JevStageError subclasses", () => {
  it.each(CASES)("$name carries its code, exit code and name", (testCase) => {
    const error = testCase.create();

    expect(error.code).toBe(testCase.code);
    expect(error.exitCode).toBe(testCase.exitCode);
    expect(error.name).toBe(testCase.name);
    expect(error.constructor.name).toBe(testCase.name);
  });

  it.each(CASES)("$name is a JevStageError and an Error", (testCase) => {
    const error = testCase.create();

    expect(error).toBeInstanceOf(JevStageError);
    expect(error).toBeInstanceOf(Error);
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.stack).toContain(testCase.name);
  });

  it.each(CASES)("$name keeps the cause it was given", (testCase) => {
    const cause = new Error("underlying");

    expect(testCase.create({ cause }).cause).toBe(cause);
    expect(testCase.create().cause).toBeUndefined();
  });

  it("covers every exported error class", () => {
    const exported = Object.entries(errorModule)
      .filter(
        ([, value]) => typeof value === "function" && value.prototype instanceof JevStageError,
      )
      .map(([name]) => name)
      .sort();

    expect(exported).toHaveLength(13);
    expect(CASES.map((testCase) => testCase.name).sort()).toEqual(exported);
  });
});

describe("error messages", () => {
  it("keeps the message a caller passed", () => {
    expect(new UsageError("--threshold must be a number in (0, 1]").message).toBe(
      "--threshold must be a number in (0, 1]",
    );
    expect(new DiffParseError("hunk header without a file section").message).toBe(
      "hunk header without a file section",
    );
  });

  it("defaults the messages that have no caller text", () => {
    expect(new NotARepositoryError().message).toBe("not a git repository");
    expect(new UnbornRepositoryError().message).toBe("the repository has no commits yet");
    expect(new MissingApiKeyError().message).toBe(
      "TYPESAFE_API_KEY is not set. Set an early-access key from typesafe.ai, or rerun in an interactive terminal without --json or --yes to select hunks by hand.",
    );
  });

  it("names the found and required git versions", () => {
    const error = new UnsupportedGitVersionError("2.19.1", "2.30");

    expect(error.message).toBe("git 2.19.1 is too old; 2.30 or newer is required");
    expect(error.found).toBe("2.19.1");
    expect(error.minimum).toBe("2.30");
  });

  it("lists every unmerged path", () => {
    const paths = ["src/a.ts", 'docs/say "hi".md', "src/b.ts"];
    const error = new UnmergedEntriesError(paths);

    for (const path of paths) {
      expect(error.message).toContain(path);
    }
    expect(error.message).toBe(
      'resolve the unmerged paths first: src/a.ts, docs/say "hi".md, src/b.ts',
    );
    expect(error.paths).toEqual(paths);
  });

  it("lists every unsupported path with its kind", () => {
    const paths = ["assets/logo.png", "assets/tone.wav"];

    for (const kind of ["binary", "symlink", "submodule"] as const) {
      const error = new UnsupportedEntryError(kind, paths);
      expect(error.kind).toBe(kind);
      expect(error.message).toBe(
        `${kind} entries cannot be staged by hunk: assets/logo.png, assets/tone.wav`,
      );
      expect(error.paths).toEqual(paths);
    }
  });

  it("lists every unknown hunk id", () => {
    const error = new UnknownHunkError(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]);

    expect(error.message).toBe(
      "no hunk matches the selected ids: aaaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbb",
    );
    expect(error.ids).toEqual(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]);
  });

  it("reports git apply stderr without the patch bytes", () => {
    const stderr =
      "error: patch failed: src/auth/login.ts:12\nerror: src/auth/login.ts: patch does not apply\n";
    const error = new PatchApplyError(stderr);

    expect(error.stderr).toBe(stderr.trim());
    expect(error.message).toBe(`git apply failed: ${stderr.trim()}`);
    expect(error.message).not.toContain("@@");
    expect(error.message).not.toContain("\n+");
    expect(error.message).not.toContain("\n-");
  });

  it("reports git apply without stderr", () => {
    const error = new PatchApplyError("   \n  ");

    expect(error.message).toBe("git apply failed");
    expect(error.stderr).toBe("");
  });

  it("explains which part of the snapshot went stale", () => {
    const messages = {
      head: "HEAD moved while the plan was being reviewed; nothing was staged",
      index: "the index changed while the plan was being reviewed; nothing was staged",
      diff: "the working tree changed while the plan was being reviewed; nothing was staged",
    } as const;

    for (const [which, message] of Object.entries(messages)) {
      const error = new StaleSnapshotError(which as keyof typeof messages);
      expect(error.which).toBe(which);
      expect(error.message).toBe(message);
      expect(error.exitCode).toBe(3);
    }
  });

  it("names the lock file that is held", () => {
    const error = new IndexLockedError("/repo/.git/index.lock");

    expect(error.message).toBe("another git process holds /repo/.git/index.lock");
    expect(error.lockPath).toBe("/repo/.git/index.lock");
  });

  it("names the git command, its exit code and its stderr", () => {
    const error = new GitCommandError(["apply", "--cached"], 128, "fatal: bad object\n");

    expect(error.message).toBe("git apply --cached exited 128: fatal: bad object");
    expect(error.argv).toEqual(["apply", "--cached"]);
    expect(error.gitExitCode).toBe(128);
    expect(error.stderr).toBe("fatal: bad object");
  });

  it("names a git command that failed without stderr", () => {
    const error = new GitCommandError(["rev-parse", "HEAD"], 1, "");

    expect(error.message).toBe("git rev-parse HEAD exited 1");
    expect(error.stderr).toBe("");
  });
});

describe("error fields", () => {
  it("copies the arrays it was given", () => {
    const paths = ["src/a.ts"];
    const ids = ["0123456789abcdef"];
    const argv = ["status"];
    const unmerged = new UnmergedEntriesError(paths);
    const unsupported = new UnsupportedEntryError("symlink", paths);
    const unknown = new UnknownHunkError(ids);
    const command = new GitCommandError(argv, 1, "");

    paths.push("src/late.ts");
    ids.push("fedcba9876543210");
    argv.push("--porcelain");

    expect(unmerged.paths).toEqual(["src/a.ts"]);
    expect(unsupported.paths).toEqual(["src/a.ts"]);
    expect(unknown.ids).toEqual(["0123456789abcdef"]);
    expect(command.argv).toEqual(["status"]);
  });
});
