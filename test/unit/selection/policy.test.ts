import { describe, expect, it } from "vitest";
import type { AnswerOutcome } from "../../../src/core/index.js";
import { UsageError } from "../../../src/errors.js";
import { DEFAULT_THRESHOLD, decide, validateThreshold } from "../../../src/selection/policy.js";
import type { Decision } from "../../../src/types.js";

function answer(choice: Decision, confidence: number): AnswerOutcome<Decision> {
  return {
    kind: "answer",
    answer: {
      choice,
      confidence,
      probabilities: { include: 0.7, exclude: 0.2, mixed: 0.1 },
    },
  };
}

describe("decide", () => {
  it("keeps an include answer at or above the threshold", () => {
    expect(decide(answer("include", 0.94), DEFAULT_THRESHOLD)).toEqual({
      decision: "include",
      source: "model",
      confidence: 0.94,
      probabilities: { include: 0.7, exclude: 0.2, mixed: 0.1 },
    });
  });

  it("keeps an exclude answer at or above the threshold", () => {
    expect(decide(answer("exclude", 0.8), DEFAULT_THRESHOLD)).toMatchObject({
      decision: "exclude",
      source: "model",
    });
  });

  it("accepts an answer exactly at the threshold", () => {
    expect(decide(answer("include", DEFAULT_THRESHOLD), DEFAULT_THRESHOLD)).toMatchObject({
      decision: "include",
      source: "model",
    });
  });

  it("keeps a mixed answer whatever the confidence", () => {
    expect(decide(answer("mixed", 0.01), DEFAULT_THRESHOLD)).toMatchObject({
      decision: "mixed",
      source: "model",
      confidence: 0.01,
    });
  });

  it("falls back to mixed below the threshold", () => {
    for (const choice of ["include", "exclude"] as const) {
      expect(decide(answer(choice, 0.59), DEFAULT_THRESHOLD)).toMatchObject({
        decision: "mixed",
        source: "low-confidence",
        confidence: 0.59,
      });
    }
  });

  it("honours a threshold other than the default", () => {
    expect(decide(answer("include", 0.59), 0.5)).toMatchObject({
      decision: "include",
      source: "model",
    });
    expect(decide(answer("include", 0.94), 0.95)).toMatchObject({
      decision: "mixed",
      source: "low-confidence",
    });
  });

  it("maps a missing answer to mixed without probabilities", () => {
    expect(decide({ kind: "missing" }, DEFAULT_THRESHOLD)).toEqual({
      decision: "mixed",
      source: "missing",
    });
  });

  it("maps an invalid answer to mixed without probabilities", () => {
    expect(decide({ kind: "invalid", reason: "choice is not one of the options" }, 0.6)).toEqual({
      decision: "mixed",
      source: "invalid",
    });
  });
});

describe("validateThreshold", () => {
  it("defaults to 0.6", () => {
    expect(DEFAULT_THRESHOLD).toBe(0.6);
  });

  it("accepts values in (0, 1]", () => {
    expect(validateThreshold(0.01)).toBe(0.01);
    expect(validateThreshold(1)).toBe(1);
  });

  it("rejects values outside (0, 1]", () => {
    for (const value of [0, -0.1, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validateThreshold(value)).toThrow(UsageError);
    }
  });
});
