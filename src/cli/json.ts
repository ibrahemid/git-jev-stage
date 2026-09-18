import type { Decision, DecisionSource, FileKind, Plan } from "../types.js";
import { VERSION } from "../version.js";

const JSON_INDENT = 2;

export interface JsonDocumentOptions {
  plan: Plan;
  applied: boolean;
  stagedHunkIds: readonly string[];
  mixedHunkIds: readonly string[];
}

export interface JsonHunk {
  id: string;
  header: string;
  text: string;
  added: number;
  removed: number;
  decision: Decision;
  source: DecisionSource;
  confidence?: number;
  probabilities?: Record<Decision, number>;
}

export interface JsonFile {
  path: string;
  kind: FileKind;
  hunks: JsonHunk[];
}

export interface JsonDocument {
  version: string;
  intent: string;
  exclude?: string;
  threshold: number;
  head: string;
  indexHash: string;
  diffHash: string;
  files: JsonFile[];
  skipped: Array<{ path: string; reason: string }>;
  usage: { requests: number; inputTokens: number; outputTokens: number };
  applied: boolean;
  stagedHunkIds: string[];
  mixedHunkIds: string[];
}

export function buildJsonDocument({
  plan,
  applied,
  stagedHunkIds,
  mixedHunkIds,
}: JsonDocumentOptions): JsonDocument {
  const { snapshot } = plan;
  return {
    version: VERSION,
    intent: plan.intent,
    ...(plan.exclude === undefined ? {} : { exclude: plan.exclude }),
    threshold: plan.threshold,
    head: snapshot.headOid,
    indexHash: snapshot.indexHash,
    diffHash: snapshot.diffHash,
    files: snapshot.files.map((file) => ({
      path: file.path,
      kind: file.kind,
      hunks: file.hunks.map((hunk) => {
        const decision = plan.decisions.get(hunk.id);
        return {
          id: hunk.id,
          header: hunk.header,
          text: hunk.text,
          added: hunk.added,
          removed: hunk.removed,
          decision: decision?.decision ?? "mixed",
          source: decision?.source ?? "missing",
          ...(decision?.confidence === undefined ? {} : { confidence: decision.confidence }),
          ...(decision?.probabilities === undefined
            ? {}
            : { probabilities: decision.probabilities }),
        };
      }),
    })),
    skipped: snapshot.skipped.map((entry) => ({ path: entry.path, reason: entry.reason })),
    usage: plan.usage,
    applied,
    stagedHunkIds: [...stagedHunkIds],
    mixedHunkIds: [...mixedHunkIds],
  };
}

export function renderJsonDocument(options: JsonDocumentOptions): string {
  return `${JSON.stringify(buildJsonDocument(options), null, JSON_INDENT)}\n`;
}
