import { summarizeSelection } from "../git/composePatch.js";
import type { Decision, FileKind, HunkDecision, Plan, Snapshot } from "../types.js";

const RESET = "[0m";
const GREEN = "[32m";
const RED = "[31m";
const YELLOW = "[33m";
const DIM = "[2m";

const ID_LENGTH = 8;
const PROBABILITY_DIGITS = 2;

const DECISION_MARKS: Readonly<Record<Decision, string>> = Object.freeze({
  include: "+",
  exclude: "-",
  mixed: "?",
});

const FILE_MARKS: Readonly<Record<FileKind, string>> = Object.freeze({
  modified: "M",
  added: "A",
  deleted: "D",
  "mode-only": "M",
});

const PROBABILITY_ORDER: readonly Decision[] = Object.freeze(["include", "exclude", "mixed"]);

const SKIPPED_INSTRUCTION = "these changes cannot be staged by hunk; stage them with git add";

export interface RenderPlanOptions {
  plan: Plan;
  includeIds: ReadonlySet<string>;
  color: boolean;
}

export interface ColorOptions {
  requested: boolean;
  isTty: boolean;
  noColor: string | undefined;
}

export function shouldColor({ requested, isTty, noColor }: ColorOptions): boolean {
  return requested && isTty && (noColor === undefined || noColor.length === 0);
}

export function renderPlan({ plan, includeIds, color }: RenderPlanOptions): string {
  const lines: string[] = [];

  for (const file of plan.snapshot.files) {
    lines.push(`${FILE_MARKS[file.kind]} ${file.path}`);
    for (const hunk of file.hunks) {
      lines.push(renderHunk(hunk.id, hunk.header, plan.decisions.get(hunk.id), color));
    }
  }

  lines.push(...skippedLines(plan.snapshot.skipped));

  const summary = summarizeSelection(plan.snapshot.files, includeIds);
  lines.push(
    `will stage: ${count(summary.hunks, "hunk")}, ${count(summary.files, "file")} (+${summary.added} -${summary.removed})`,
  );

  return `${lines.join("\n")}\n`;
}

export function renderSkipped(skipped: Snapshot["skipped"]): string {
  const lines = skippedLines(skipped);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function skippedLines(skipped: Snapshot["skipped"]): string[] {
  if (skipped.length === 0) {
    return [];
  }
  return [
    ...skipped.map((entry) => `skipped: ${entry.path} (${entry.reason})`),
    SKIPPED_INSTRUCTION,
  ];
}

export function renderPatch(patch: Buffer, write: (bytes: Buffer) => void): void {
  if (patch.length === 0) {
    return;
  }
  write(patch);
}

function renderHunk(
  hunkId: string,
  header: string,
  decision: HunkDecision | undefined,
  color: boolean,
): string {
  const resolved: Decision = decision?.decision ?? "mixed";
  const mark = colorize(DECISION_MARKS[resolved], resolved, color);
  const parts = [`  ${mark} ${hunkId.slice(0, ID_LENGTH)} ${header}`];

  const probabilities = decision?.probabilities;
  if (probabilities !== undefined) {
    parts.push(renderProbabilities(probabilities));
  }
  if (decision !== undefined && decision.source !== "model") {
    parts.push(decision.source);
  }

  return parts.join("  ");
}

function renderProbabilities(probabilities: Record<Decision, number>): string {
  return PROBABILITY_ORDER.map(
    (label) => `${label} ${(probabilities[label] ?? 0).toFixed(PROBABILITY_DIGITS)}`,
  ).join("  ");
}

function colorize(mark: string, decision: Decision, color: boolean): string {
  if (!color) {
    return mark;
  }
  if (decision === "include") {
    return `${GREEN}${mark}${RESET}`;
  }
  if (decision === "exclude") {
    return `${DIM}${RED}${mark}${RESET}`;
  }
  return `${YELLOW}${mark}${RESET}`;
}

export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
