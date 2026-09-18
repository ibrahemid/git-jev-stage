import { UsageError } from "../errors.js";
import type { Hunk } from "../types.js";

export const NO_TTY_MESSAGE = "no TTY; use --yes, --dry-run or --json";

const AFFIRMATIVE = new Set(["y", "yes"]);

export interface PromptIo {
  stdout: (text: string) => void;
  isStdinTty: boolean;
  readLine: () => Promise<string | undefined>;
}

export async function confirm(question: string, io: PromptIo): Promise<boolean> {
  if (!io.isStdinTty) {
    throw new UsageError(NO_TTY_MESSAGE);
  }
  io.stdout(`${question} [y/N] `);
  const answer = await io.readLine();
  return answer !== undefined && AFFIRMATIVE.has(answer.trim().toLowerCase());
}

export async function askHunk(hunk: Hunk, io: PromptIo): Promise<boolean> {
  if (!io.isStdinTty) {
    throw new UsageError(NO_TTY_MESSAGE);
  }
  const body = hunk.text.endsWith("\n") ? hunk.text : `${hunk.text}\n`;
  io.stdout(`\n${hunk.path}\n${body}`);
  return confirm("stage this hunk?", io);
}
