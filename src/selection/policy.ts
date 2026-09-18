import type { AnswerOutcome } from "../core/index.js";
import { UsageError } from "../errors.js";
import type { Decision, HunkDecision } from "../types.js";

export const DEFAULT_THRESHOLD = 0.6;

export const DECISION_LABELS: readonly Decision[] = Object.freeze([
  "include",
  "exclude",
  "mixed",
] as const);

export type PolicyDecision = Omit<HunkDecision, "hunkId">;

export function decide(outcome: AnswerOutcome<Decision>, threshold: number): PolicyDecision {
  if (outcome.kind === "missing") {
    return { decision: "mixed", source: "missing" };
  }
  if (outcome.kind === "invalid") {
    return { decision: "mixed", source: "invalid" };
  }

  const { choice, confidence, probabilities } = outcome.answer;
  if (choice === "mixed") {
    return { decision: "mixed", source: "model", confidence, probabilities };
  }
  if (confidence >= threshold) {
    return { decision: choice, source: "model", confidence, probabilities };
  }
  return { decision: "mixed", source: "low-confidence", confidence, probabilities };
}

export function validateThreshold(threshold: number): number {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new UsageError(`threshold must be greater than 0 and at most 1, got ${threshold}`);
  }
  return threshold;
}
