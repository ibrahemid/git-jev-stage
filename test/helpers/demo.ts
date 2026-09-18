import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChoiceAnswer } from "../../src/core/index.js";
import type { Decision, Hunk, Snapshot } from "../../src/types.js";

export const DEMO_LOGIN_PATH = "src/auth/login.ts";
export const DEMO_CSS_PATH = "src/styles/app.css";
export const DEMO_TEST_PATH = "test/auth.test.ts";

export interface DemoHunks {
  auth: Hunk;
  log: Hunk;
  css: Hunk;
  test: Hunk;
}

export function demoHunks(snapshot: Snapshot): DemoHunks {
  return {
    auth: pick(snapshot, DEMO_LOGIN_PATH, 0),
    log: pick(snapshot, DEMO_LOGIN_PATH, 1),
    css: pick(snapshot, DEMO_CSS_PATH, 0),
    test: pick(snapshot, DEMO_TEST_PATH, 0),
  };
}

export function answer(choice: Decision, confidence: number): ChoiceAnswer<Decision> {
  const rest = (1 - confidence) / 2;
  const probabilities: Record<Decision, number> = {
    include: rest,
    exclude: rest,
    mixed: rest,
  };
  probabilities[choice] = confidence;
  return { choice, confidence, probabilities };
}

export function writeFakeScript(
  dir: string,
  answers: Record<string, ChoiceAnswer<Decision>>,
  name = "fake-provider.json",
): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ answers }));
  return path;
}

function pick(snapshot: Snapshot, path: string, ordinal: number): Hunk {
  const file = snapshot.files.find((candidate) => candidate.path === path);
  const hunk = file?.hunks[ordinal];
  if (hunk === undefined) {
    throw new Error(`the demo snapshot has no hunk ${ordinal} in ${path}`);
  }
  return hunk;
}
