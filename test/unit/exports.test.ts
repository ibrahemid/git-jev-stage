import { describe, expect, it } from "vitest";
import * as library from "../../src/index.js";
import {
  applyPatchToIndex,
  applySelection,
  buildWindows,
  CHARS_PER_TOKEN,
  captureSnapshot,
  classifyHunks,
  cleanupOwnedPaths,
  composePatch,
  createGitRunner,
  createProviderFromEnv,
  DEFAULT_CONCURRENCY,
  DEFAULT_PER_QUESTION_TOKENS,
  DEFAULT_THRESHOLD,
  DEFAULT_TOKEN_CEILING,
  DIFF_ARGS,
  DiffParseError,
  decide,
  estimateJsonTokens,
  estimateTokens,
  FakeProvider,
  GitCommandError,
  IndexLockedError,
  JevCoreError,
  JevStageError,
  MissingApiKeyError,
  NotARepositoryError,
  PatchApplyError,
  ProviderConfigError,
  ProviderError,
  parseUnifiedDiff,
  planSelection,
  RequestTooLargeError,
  runWindows,
  StaleSnapshotError,
  stageHunks,
  summarizeSelection,
  TypeSafeJevProvider,
  UnbornRepositoryError,
  UnknownHunkError,
  UnmergedEntriesError,
  UnsupportedEntryError,
  UnsupportedGitVersionError,
  UsageError,
  validateChoiceAnswer,
} from "../../src/index.js";

const FUNCTIONS: Record<string, unknown> = {
  applyPatchToIndex,
  applySelection,
  buildWindows,
  captureSnapshot,
  classifyHunks,
  cleanupOwnedPaths,
  composePatch,
  createGitRunner,
  createProviderFromEnv,
  decide,
  estimateJsonTokens,
  estimateTokens,
  FakeProvider,
  parseUnifiedDiff,
  planSelection,
  runWindows,
  stageHunks,
  summarizeSelection,
  TypeSafeJevProvider,
  validateChoiceAnswer,
};

const ERRORS: Record<string, unknown> = {
  DiffParseError,
  GitCommandError,
  IndexLockedError,
  JevCoreError,
  JevStageError,
  MissingApiKeyError,
  NotARepositoryError,
  PatchApplyError,
  ProviderConfigError,
  ProviderError,
  RequestTooLargeError,
  StaleSnapshotError,
  UnbornRepositoryError,
  UnknownHunkError,
  UnmergedEntriesError,
  UnsupportedEntryError,
  UnsupportedGitVersionError,
  UsageError,
};

const CONSTANTS: Record<string, unknown> = {
  CHARS_PER_TOKEN,
  DEFAULT_CONCURRENCY,
  DEFAULT_PER_QUESTION_TOKENS,
  DEFAULT_THRESHOLD,
  DEFAULT_TOKEN_CEILING,
  DIFF_ARGS,
};

describe("src/index.ts", () => {
  it("exports these names and nothing else", () => {
    const listed = [
      ...Object.keys(FUNCTIONS),
      ...Object.keys(ERRORS),
      ...Object.keys(CONSTANTS),
    ].sort();

    expect(Object.keys(library).sort()).toEqual(listed);
  });

  it("exports every public function", () => {
    for (const [name, value] of Object.entries(FUNCTIONS)) {
      expect(typeof value, name).toBe("function");
    }
  });

  it("exports every error class", () => {
    for (const [name, value] of Object.entries(ERRORS)) {
      expect(typeof value, name).toBe("function");
    }
  });

  it("exports the public constants", () => {
    expect(DEFAULT_THRESHOLD).toBe(0.6);
    expect(DEFAULT_CONCURRENCY).toBe(4);
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(DEFAULT_TOKEN_CEILING).toBe(25_000);
    expect(DEFAULT_PER_QUESTION_TOKENS).toBe(40);
    expect(DIFF_ARGS).toContain("--unified=6");
  });
});
