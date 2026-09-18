import type { JevProvider } from "./core/index.js";
import { UnknownHunkError } from "./errors.js";
import { stageHunks } from "./git/applySelection.js";
import { createGitRunner, type GitRunner } from "./git/runGit.js";
import { captureSnapshot } from "./git/snapshot.js";
import { classifyHunks } from "./selection/classify.js";
import { DEFAULT_THRESHOLD, validateThreshold } from "./selection/policy.js";
import type { HunkDecision, Plan, Snapshot, StageResult } from "./types.js";

export interface PlanSelectionOptions {
  cwd: string;
  intent: string;
  exclude?: string | undefined;
  threshold?: number | undefined;
  provider?: JevProvider | undefined;
  git?: GitRunner | undefined;
}

export interface ApplySelectionOptions {
  includeIds: readonly string[];
  git?: GitRunner | undefined;
}

export async function planSelection(options: PlanSelectionOptions): Promise<Plan> {
  const threshold = validateThreshold(options.threshold ?? DEFAULT_THRESHOLD);
  const git = options.git ?? createGitRunner();
  const snapshot = await captureSnapshot({ cwd: options.cwd, git });
  const { intent, exclude, provider } = options;
  const excludeField = exclude === undefined ? {} : { exclude };

  if (provider === undefined) {
    return {
      intent,
      ...excludeField,
      threshold,
      snapshot,
      decisions: withoutProvider(snapshot),
      usage: { requests: 0, inputTokens: 0, outputTokens: 0 },
    };
  }

  const { decisions, usage } = await classifyHunks({
    snapshot,
    intent,
    ...excludeField,
    threshold,
    provider,
  });

  return { intent, ...excludeField, threshold, snapshot, decisions, usage };
}

export async function applySelection(
  plan: Plan,
  options: ApplySelectionOptions,
): Promise<StageResult> {
  const hunkIds = collectHunkIds(plan.snapshot);
  const known = new Set(hunkIds);
  const unknown = [...new Set(options.includeIds)].filter((id) => !known.has(id)).sort();
  if (unknown.length > 0) {
    throw new UnknownHunkError(unknown);
  }

  const included = new Set(options.includeIds);
  const stagedHunkIds = hunkIds.filter((id) => included.has(id));
  const skippedMixedIds = hunkIds.filter(
    (id) => plan.decisions.get(id)?.decision === "mixed" && !included.has(id),
  );

  const git = options.git ?? createGitRunner();
  const patchBytes = await stageHunks(plan.snapshot, included, git);

  return { stagedHunkIds, skippedMixedIds, patchBytes };
}

function collectHunkIds(snapshot: Snapshot): string[] {
  const ids: string[] = [];
  for (const file of snapshot.files) {
    for (const hunk of file.hunks) {
      ids.push(hunk.id);
    }
  }
  return ids;
}

function withoutProvider(snapshot: Snapshot): Map<string, HunkDecision> {
  const decisions = new Map<string, HunkDecision>();
  for (const hunkId of collectHunkIds(snapshot)) {
    decisions.set(hunkId, { hunkId, decision: "mixed", source: "no-provider" });
  }
  return decisions;
}
