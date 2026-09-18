import type { JsonValue } from "./types.js";

export const CHARS_PER_TOKEN = 4;
export const DEFAULT_TOKEN_CEILING = 25_000;
export const DEFAULT_PER_QUESTION_TOKENS = 40;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateJsonTokens(value: JsonValue): number {
  return estimateTokens(JSON.stringify(value));
}
