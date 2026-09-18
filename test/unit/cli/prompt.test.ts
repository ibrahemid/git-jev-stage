import { describe, expect, it } from "vitest";
import { askHunk, confirm, NO_TTY_MESSAGE, type PromptIo } from "../../../src/cli/prompt.js";
import { UsageError } from "../../../src/errors.js";
import { hunkAt, SAMPLE_DIFF, snapshotFromDiff } from "../../helpers/plan.js";

function promptIo(answers: string[], isStdinTty = true): { io: PromptIo; text: () => string } {
  const written: string[] = [];
  return {
    io: {
      stdout: (text) => written.push(text),
      isStdinTty,
      readLine: () => Promise.resolve(answers.shift()),
    },
    text: () => written.join(""),
  };
}

describe("confirm", () => {
  it("asks the question with the default spelled out", async () => {
    const { io, text } = promptIo(["y"]);

    await expect(confirm("stage 2 hunks in 1 file?", io)).resolves.toBe(true);
    expect(text()).toBe("stage 2 hunks in 1 file? [y/N] ");
  });

  it("accepts y and yes in any case", async () => {
    for (const answer of ["y", "Y", "yes", " YES "]) {
      const { io } = promptIo([answer]);
      await expect(confirm("go?", io)).resolves.toBe(true);
    }
  });

  it("treats anything else, including end of input, as no", async () => {
    for (const answer of ["", "n", "no", "nope", "sure"]) {
      const { io } = promptIo([answer]);
      await expect(confirm("go?", io)).resolves.toBe(false);
    }
    const { io } = promptIo([]);
    await expect(confirm("go?", io)).resolves.toBe(false);
  });

  it("refuses to prompt without a tty", async () => {
    const { io, text } = promptIo(["y"], false);

    await expect(confirm("go?", io)).rejects.toThrow(UsageError);
    await expect(confirm("go?", io)).rejects.toThrow(NO_TTY_MESSAGE);
    expect(text()).toBe("");
  });
});

describe("askHunk", () => {
  it("shows the path and the hunk before asking", async () => {
    const snapshot = snapshotFromDiff(SAMPLE_DIFF);
    const hunk = hunkAt(snapshot, 0);
    const { io, text } = promptIo(["y"]);

    await expect(askHunk(hunk, io)).resolves.toBe(true);
    expect(text()).toBe(`\n${hunk.path}\n${hunk.text}stage this hunk? [y/N] `);
    expect(text()).toContain("@@ -1,3 +1,4 @@");
  });

  it("refuses to prompt without a tty", async () => {
    const snapshot = snapshotFromDiff(SAMPLE_DIFF);
    const { io } = promptIo(["y"], false);

    await expect(askHunk(hunkAt(snapshot, 0), io)).rejects.toThrow(NO_TTY_MESSAGE);
  });
});
