import { describe, expect, it } from "vitest";
import {
  CHARS_PER_TOKEN,
  DEFAULT_PER_QUESTION_TOKENS,
  DEFAULT_TOKEN_CEILING,
  estimateJsonTokens,
  estimateTokens,
} from "../../../src/core/index.js";

describe("tokens", () => {
  it("exposes the contract constants", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(DEFAULT_TOKEN_CEILING).toBe(25_000);
    expect(DEFAULT_PER_QUESTION_TOKENS).toBe(40);
  });

  it("estimates one token per four characters, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(100_000))).toBe(25_000);
  });

  it("estimates json from its serialized form", () => {
    const value = { path: "src/a.ts", hunks: [1, 2, 3] };
    expect(estimateJsonTokens(value)).toBe(estimateTokens(JSON.stringify(value)));
    expect(estimateJsonTokens(null)).toBe(1);
    expect(estimateJsonTokens("ab")).toBe(1);
  });
});
