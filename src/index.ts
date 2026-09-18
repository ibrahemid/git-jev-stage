export * from "./core/index.js";
export * from "./errors.js";
export {
  type ApplyPatchToIndexOptions,
  applyPatchToIndex,
  cleanupOwnedPaths,
  stageHunks,
} from "./git/applySelection.js";
export {
  composePatch,
  type SelectionFileSummary,
  type SelectionSummary,
  summarizeSelection,
} from "./git/composePatch.js";
export { parseUnifiedDiff } from "./git/parseDiff.js";
export type { GitRunner } from "./git/runGit.js";
export { createGitRunner } from "./git/runGit.js";
export { captureSnapshot, DIFF_ARGS } from "./git/snapshot.js";
export {
  type ApplySelectionOptions,
  applySelection,
  type PlanSelectionOptions,
  planSelection,
} from "./library.js";
export {
  type ClassifyHunksOptions,
  type ClassifyHunksResult,
  type ClassifyUsage,
  classifyHunks,
} from "./selection/classify.js";
export { DEFAULT_THRESHOLD, decide, type PolicyDecision } from "./selection/policy.js";
export type * from "./types.js";
