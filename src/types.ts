export type Decision = "include" | "exclude" | "mixed";

export type DecisionSource =
  | "model"
  | "low-confidence"
  | "missing"
  | "invalid"
  | "too-large"
  | "provider-error"
  | "manual"
  | "no-provider";

export type FileKind = "modified" | "added" | "deleted" | "mode-only";

export interface Hunk {
  id: string;
  path: string;
  ordinal: number;
  header: string;
  bytes: Buffer;
  text: string;
  added: number;
  removed: number;
}

export interface DiffFile {
  path: string;
  kind: FileKind;
  headerBytes: Buffer;
  hunks: Hunk[];
}

export interface Snapshot {
  workTree: string;
  gitDir: string;
  indexPath: string;
  gitEnv: Record<string, string>;
  headOid: string;
  indexHash: string;
  diffHash: string;
  diffBytes: Buffer;
  files: DiffFile[];
  skipped: Array<{ path: string; reason: "mode-only" | "empty-file" }>;
}

export interface HunkDecision {
  hunkId: string;
  decision: Decision;
  source: DecisionSource;
  confidence?: number;
  probabilities?: Record<Decision, number>;
}

export interface Plan {
  intent: string;
  exclude?: string;
  threshold: number;
  snapshot: Snapshot;
  decisions: Map<string, HunkDecision>;
  usage: { requests: number; inputTokens: number; outputTokens: number };
}

export interface StageResult {
  stagedHunkIds: string[];
  skippedMixedIds: string[];
  patchBytes: Buffer;
}
