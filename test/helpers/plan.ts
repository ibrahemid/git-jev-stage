import { parseUnifiedDiff } from "../../src/git/parseDiff.js";
import type { Hunk, HunkDecision, Plan, Snapshot } from "../../src/types.js";

export const SAMPLE_DIFF = [
  "diff --git a/src/auth/login.ts b/src/auth/login.ts",
  "index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644",
  "--- a/src/auth/login.ts",
  "+++ b/src/auth/login.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "+const b = 2;",
  " const c = 3;",
  "@@ -10,3 +11,3 @@ function tail() {",
  '-  log("old");',
  '+  log("new");',
  "   return 1;",
  "diff --git a/src/styles/app.css b/src/styles/app.css",
  "index 3333333333333333333333333333333333333333..4444444444444444444444444444444444444444 100644",
  "--- a/src/styles/app.css",
  "+++ b/src/styles/app.css",
  "@@ -1,2 +1,2 @@",
  "-.btn { padding: 4px; }",
  "+.btn { padding: 6px; }",
  " .card { margin: 8px; }",
  "",
].join("\n");

export function snapshotFromDiff(diff: string): Snapshot {
  const diffBytes = Buffer.from(diff, "utf8");
  return {
    workTree: "/work",
    gitDir: "/work/.git",
    indexPath: "/work/.git/index",
    gitEnv: {},
    headOid: "a".repeat(40),
    indexHash: "b".repeat(64),
    diffHash: "c".repeat(64),
    diffBytes,
    files: parseUnifiedDiff(diffBytes),
    skipped: [],
  };
}

export function hunksOf(snapshot: Snapshot): Hunk[] {
  return snapshot.files.flatMap((file) => file.hunks);
}

export function hunkAt(snapshot: Snapshot, index: number): Hunk {
  const hunk = hunksOf(snapshot)[index];
  if (hunk === undefined) {
    throw new Error(`the snapshot has no hunk at index ${index}`);
  }
  return hunk;
}

export function decisionsOf(decisions: readonly HunkDecision[]): Map<string, HunkDecision> {
  return new Map(decisions.map((decision) => [decision.hunkId, decision]));
}

export function makePlan(
  snapshot: Snapshot,
  decisions: Map<string, HunkDecision>,
  overrides: Partial<Pick<Plan, "intent" | "exclude" | "threshold" | "usage">> = {},
): Plan {
  const exclude = overrides.exclude;
  return {
    intent: overrides.intent ?? "the auth fix",
    ...(exclude === undefined ? {} : { exclude }),
    threshold: overrides.threshold ?? 0.6,
    snapshot,
    decisions,
    usage: overrides.usage ?? { requests: 1, inputTokens: 10, outputTokens: 5 },
  };
}
